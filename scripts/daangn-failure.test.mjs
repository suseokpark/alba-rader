import assert from 'node:assert/strict';
import { test } from 'node:test';
import { searchDaangn } from '../src/lib/server/providers/daangn.ts';

// Synthetic provider-boundary failures, not observations of a live outage.
// All fetches are mocked. Distinct synthetic bcode keys isolate the region cache;
// these are not tests of the API's postal-address validation or browser behavior.
const query = '카페 & 주말';
const regionEndpoint = 'https://jobs.kr.karrotmarket.com/graphql';
const secret = 'SYNTHETIC_SECRET https://private.invalid/path?token=secret';
const region = { _id: 230, name1: '서울특별시', name2: '마포구', name3: '서교동' };
const options = (key) => ({ scope: 'address', areaLevel: 'neighborhood',
  area: { sido: '서울', sigungu: '마포구', bname: '서교동', bcode: `failure-${key}`, sigunguCode: '11440' } });
const pickerResponse = (nodes = [region]) => Response.json({ data: { searchRegions: { edges: nodes.map((node) => ({ node })) } } });
const genericMessage = '당근 검색 결과를 확인하지 못했어요. 이 업체만 다시 시도하거나 원문 검색 결과에서 확인해 주세요.';
const formatMessage = '당근에서 받은 정보의 형식을 읽지 못했어요. 원문 검색 결과에서 확인해 주세요.';

function responseWithUrl(body, url, status = 200) {
  const response = new Response(body, { status, headers: { 'Content-Type': 'text/html' } });
  Object.defineProperty(response, 'url', { value: String(url) });
  return response;
}

function assertResult(result, { status = 'unavailable', resolved = false } = {}) {
  assert.equal(result.source, 'daangn');
  assert.equal(result.status, status);
  assert.deepEqual(result.jobs, []);
  const url = new URL(result.searchUrl);
  assert.equal(url.origin, 'https://jobs.daangn.com');
  assert.equal(url.pathname, '/s');
  assert.equal(url.searchParams.get('query'), query);
  assert.equal(url.searchParams.get('regionId'), resolved ? '230' : null);
  if (resolved) assert.equal(result.regionNote, '서울특별시 마포구 서교동 및 주변 기준');
  assert.doesNotMatch(JSON.stringify(result), /SYNTHETIC_SECRET|private\.invalid|token=secret/);
}

test('malformed HTTP-200 region JSON uses the format/original message and never requests listings', async (t) => {
  const requested = [];
  t.mock.method(globalThis, 'fetch', async (input) => {
    requested.push(String(input));
    return new Response(`{"marker":"${secret}","data":`, { status: 200, headers: { 'Content-Type': 'application/json' } });
  });
  const result = await searchDaangn(query, options('malformed-json'));
  assertResult(result);
  assert.deepEqual(requested, [regionEndpoint]);
  assert.equal(result.message, formatMessage);
  assert.doesNotMatch(result.message, /응답이 늦|연결하지 못/);
});

test('missing, null and GraphQL-error region payloads remain cause-unconfirmed rather than syntax failures', async (t) => {
  let payload;
  const requested = [];
  const messages = [];
  t.mock.method(globalThis, 'fetch', async (input) => { requested.push(String(input)); return Response.json(payload); });
  for (const [key, fixture] of [
    ['missing', {}], ['null', null], ['graphql-errors', { errors: [{ message: secret }] }]
  ]) {
    payload = fixture;
    const before = requested.length;
    const result = await searchDaangn(query, options(`schema-${key}`));
    assertResult(result);
    assert.deepEqual(requested.slice(before), [regionEndpoint]);
    messages.push({ key, message: result.message });
  }
  assert.deepEqual(messages, ['missing', 'null', 'graphql-errors'].map((key) => ({ key, message: genericMessage })));
  for (const { message } of messages) assert.doesNotMatch(message, /형식|응답이 늦|연결하지 못/);
});

test('fetch TypeError remains cause-unconfirmed without exposing the raw error or choosing a fallback region', async (t) => {
  const requested = [];
  t.mock.method(globalThis, 'fetch', async (input) => { requested.push(String(input)); throw new TypeError(secret); });
  const result = await searchDaangn(query, options('fetch-type-error'));
  assertResult(result);
  assert.deepEqual(requested, [regionEndpoint]);
  assert.equal(result.message, genericMessage);
});

test('body-read TypeError after a validated region retains that region and uses the cause-unconfirmed message', async (t) => {
  const requested = [];
  t.mock.method(globalThis, 'fetch', async (input) => {
    requested.push(String(input));
    if (String(input) === regionEndpoint) return pickerResponse();
    return { ok: true, url: String(input), text: async () => { throw new TypeError(secret); } };
  });
  const result = await searchDaangn(query, options('body-type-error'));
  assertResult(result, { resolved: true });
  assert.deepEqual(requested, [regionEndpoint, result.searchUrl]);
  assert.equal(result.message, genericMessage);
});

test('TimeoutError and AbortError retain the existing bounded-response delay message', async (t) => {
  let name;
  const requested = [];
  t.mock.method(globalThis, 'fetch', async (input) => { requested.push(String(input)); throw new DOMException(secret, name); });
  for (name of ['TimeoutError', 'AbortError']) {
    const before = requested.length;
    const result = await searchDaangn(query, options(name));
    assertResult(result);
    assert.deepEqual(requested.slice(before), [regionEndpoint]);
    assert.equal(result.message, '당근 응답이 늦어 조회를 마치지 못했어요. 다시 검색해 주세요.');
  }
});

test('HTTP 503 after region validation keeps the existing page-response failure guidance', async (t) => {
  const requested = [];
  t.mock.method(globalThis, 'fetch', async (input) => {
    requested.push(String(input));
    return String(input) === regionEndpoint ? pickerResponse() : responseWithUrl(secret, input, 503);
  });
  const result = await searchDaangn(query, options('http-503'));
  assertResult(result, { resolved: true });
  assert.deepEqual(requested, [regionEndpoint, result.searchUrl]);
  assert.equal(result.message, '당근 검색 페이지에 연결하지 못했어요. 원문 검색에서 확인해 주세요.');
});

test('explicit zero results remain empty only after the selected region and query are validated', async (t) => {
  const requested = [];
  t.mock.method(globalThis, 'fetch', async (input) => {
    requested.push(String(input));
    return String(input) === regionEndpoint ? pickerResponse() : responseWithUrl(
      '<title>서울특별시 마포구 서교동에서 찾는 알바</title><main><h1>"카페 &amp; 주말"로 검색한 결과</h1><p>검색 결과가 없어요</p></main>', input
    );
  });
  const result = await searchDaangn(query, options('explicit-empty'));
  assertResult(result, { status: 'empty', resolved: true });
  assert.deepEqual(requested, [regionEndpoint, result.searchUrl]);
  assert.equal(result.message, '이 검색어의 당근 공고가 없어요.');
});

test('unmatched or absent region candidates never reach listings or substitute another neighborhood', async (t) => {
  let nodes;
  const requested = [];
  t.mock.method(globalThis, 'fetch', async (input) => { requested.push(String(input)); return pickerResponse(nodes); });
  for (const [key, candidates] of [['absent', []], ['wrong-district', [{ ...region, name2: '서대문구' }]]]) {
    nodes = candidates;
    const before = requested.length;
    const result = await searchDaangn(query, options(`region-${key}`));
    assertResult(result);
    assert.deepEqual(requested.slice(before), [regionEndpoint]);
    assert.equal(result.message, '선택한 주소와 일치하는 당근 동네를 확인하지 못했어요. 다른 주소를 선택해 주세요.');
  }
});
