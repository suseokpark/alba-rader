import assert from 'node:assert/strict';
import { test } from 'node:test';
import { searchAlba } from '../src/lib/server/providers/alba.ts';

// Synthetic failure conditions at the real provider's fetch boundary only.
// Every fetch is mocked; no external requests or real service outages are used.
const query = '카페 & 주말';
const secret = 'SYNTHETIC_SECRET';
const privateUrl = 'https://private.invalid/path?token=SYNTHETIC_SECRET';
const areaCodeUrl = 'https://www.alba.co.kr/rsc/js/_AreaCode.js';
const area = { sido: '서울', sigungu: '마포구', bname: '서교동', bcode: '1144012000', sigunguCode: '11440' };

function responseWithUrl(body, url, status = 200) {
  const response = new Response(body, { status, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  Object.defineProperty(response, 'url', { value: String(url) });
  return response;
}

function assertResult(result, status = 'unavailable') {
  assert.equal(result.source, 'alba');
  assert.equal(result.status, status);
  assert.deepEqual(result.jobs, []);
  const searchUrl = new URL(result.searchUrl);
  assert.equal(searchUrl.origin, 'https://www.alba.co.kr');
  assert.equal(searchUrl.pathname, '/search/Search');
  assert.equal(searchUrl.searchParams.get('wsSrchWord'), query);
  assert.doesNotMatch(JSON.stringify(result), /SYNTHETIC_SECRET|private\.invalid/);
}

for (const name of ['TimeoutError', 'AbortError']) {
  test(`Alba ${name} alone receives the confirmed delay and retry guidance`, async (t) => {
    const fetch = t.mock.method(globalThis, 'fetch', async () => {
      throw new DOMException(`${secret} ${privateUrl}`, name);
    });
    const result = await searchAlba(query);
    assertResult(result);
    assert.equal(fetch.mock.callCount(), 1);
    assert.match(result.message, /응답이 늦어/);
    assert.match(result.message, /다시 시도/);
    assert.doesNotMatch(result.message, /형식/);
  });
}

test('Alba malformed HTTP-200 region JSON reports format uncertainty and never falls back to an unrestricted search', async (t) => {
  const requested = [];
  const fetch = t.mock.method(globalThis, 'fetch', async (input) => {
    requested.push(String(input));
    return responseWithUrl(`var arrAreaCodeJson = {"marker":"${secret} ${privateUrl}","ARCD":[};`, input);
  });
  const result = await searchAlba(query, { scope: 'address', areaLevel: 'district', area });
  assertResult(result);
  assert.equal(fetch.mock.callCount(), 1);
  assert.deepEqual(requested, [areaCodeUrl], 'A failed region lookup must not issue a nationwide result request.');
  assert.match(result.regionNote, /지역/);
  assert.match(result.message, /형식/);
  assert.match(result.message, /원문/);
  assert.doesNotMatch(result.message, /지연|응답이 늦|연결되지|연결 실패/);
});

for (const stage of ['fetch', 'body']) {
  test(`Alba ${stage} TypeError keeps the cause unconfirmed and offers retry plus original search`, async (t) => {
    const fetch = t.mock.method(globalThis, 'fetch', async (input) => {
      const error = new TypeError(`${secret} ${privateUrl}`);
      if (stage === 'fetch') throw error;
      return { ok: true, status: 200, url: String(input), text: async () => { throw error; } };
    });
    const result = await searchAlba(query);
    assertResult(result);
    assert.equal(fetch.mock.callCount(), 1);
    assert.match(result.message, /검색 결과를 확인하지 못/);
    assert.match(result.message, /다시 시도/);
    assert.match(result.message, /원문/);
    assert.doesNotMatch(result.message, /지연|응답이 늦|연결되지|연결 실패|형식/);
  });
}

test('Alba HTTP 503 retains its explicit response-status message', async (t) => {
  const fetch = t.mock.method(globalThis, 'fetch', async (input) => responseWithUrl(`${secret} ${privateUrl}`, input, 503));
  const result = await searchAlba(query);
  assertResult(result);
  assert.equal(fetch.mock.callCount(), 1);
  assert.equal(result.message, '알바천국이 검색 요청에 응답하지 않았어요. (503)');
});

test('Alba explicit zero-count metadata still returns empty rather than an unavailable failure', async (t) => {
  const fetch = t.mock.method(globalThis, 'fetch', async (input) => responseWithUrl(
    '<html><head><meta name="Description" content="관련 검색결과 총 0건의 채용정보"></head><body></body></html>', input
  ));
  const result = await searchAlba(query);
  assertResult(result, 'empty');
  assert.equal(fetch.mock.callCount(), 1);
  assert.equal(result.message, '이 검색어에 해당하는 공고가 없어요.');
});

for (const finalUrl of [
  'https://unexpected.invalid/search/Search?token=SYNTHETIC_SECRET',
  'https://www.alba.co.kr/error/error_msg.asp?token=SYNTHETIC_SECRET',
  'https://www.alba.co.kr/search/Search/'
]) {
  test(`Alba rejects unexpected final URL ${new URL(finalUrl).pathname} before parsing its body`, async (t) => {
    let bodyReads = 0;
    const fetch = t.mock.method(globalThis, 'fetch', async () => ({
      ok: true, status: 200, url: finalUrl,
      text: async () => { bodyReads++; return '<meta name="Description" content="관련 검색결과 총 0건의 채용정보">'; }
    }));
    const result = await searchAlba(query);
    assertResult(result);
    assert.equal(fetch.mock.callCount(), 1);
    assert.equal(bodyReads, 0, 'An unrelated HTTP-200 page must not become empty results.');
    assert.match(result.message, /검색 페이지로 연결되지/);
    assert.doesNotMatch(JSON.stringify(result), /unexpected\.invalid|error_msg/);
  });
}

test('Alba accepts only the existing case-insensitive search path contract', async (t) => {
  t.mock.method(globalThis, 'fetch', async (input) => {
    const finalUrl = new URL(input);
    finalUrl.pathname = '/SEARCH/search';
    return responseWithUrl('<meta name="Description" content="관련 검색결과 총 0건의 채용정보">', finalUrl);
  });
  assertResult(await searchAlba(query), 'empty');
});

for (const finalUrl of ['', 'invalid-url']) {
  test(`Alba missing or malformed final URL (${finalUrl || 'empty'}) keeps its cause unconfirmed`, async (t) => {
    let bodyReads = 0;
    t.mock.method(globalThis, 'fetch', async () => ({
      ok: true, status: 200, url: finalUrl, text: async () => { bodyReads++; return secret; }
    }));
    const result = await searchAlba(query);
    assertResult(result);
    assert.equal(bodyReads, 0);
    assert.match(result.message, /검색 결과를 확인하지 못/);
    assert.doesNotMatch(result.message, /지연|연결되지|형식/);
  });
}
