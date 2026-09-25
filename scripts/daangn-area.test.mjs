import assert from 'node:assert/strict';
import { test } from 'node:test';
import { searchDaangn } from '../src/lib/server/providers/daangn.ts';
import { resolveDaangnRegion } from '../src/lib/server/providers/daangn-region.ts';

const area = {
  sido: '서울', sigungu: '마포구', bname: '서교동', bcode: '1144012000', sigunguCode: '11440'
};
const node = { _id: 230, name1: '서울특별시', name2: '마포구', name3: '서교동' };
const pickerResponse = (nodes) => Response.json({ data: { searchRegions: { edges: nodes.map((node) => ({ node })) } } });
const listingResponse = (url, { title = '서울특별시 마포구 서교동', query = '카페' } = {}) => {
  const response = new Response(`<!doctype html><title>${title}에서 찾는 알바</title>
    <main><h1>"${query}"로 검색한 결과</h1><a href="/job-posts/example-cafe">
      <h3>카페 주말 근무</h3><span class="seed-text">시급 12,000원</span>
      <span class="seed-text">토,일 · 09:00 ~ 13:00</span>
      <span class="seed-tag-group-item__label">동네 카페</span>
      <span class="seed-tag-group-item__label">서교동</span>
    </a></main>`, { headers: { 'Content-Type': 'text/html' } });
  Object.defineProperty(response, 'url', { value: String(url) });
  return response;
};

test('wide administrative areas fail closed without any regional lookup or listing fetch', async (t) => {
  const fetch = t.mock.method(globalThis, 'fetch', () => { throw new Error('Unexpected network request'); });
  for (const areaLevel of ['district', 'city', 'province']) {
    const result = await searchDaangn('카페', { scope: 'address', area, areaLevel });
    assert.equal(result.status, 'unavailable', areaLevel);
    assert.deepEqual(result.jobs, []);
    assert.match(result.message, /전체 검색은 지원하지/);
    assert.match(result.regionNote, /원문 링크에도 선택한 지역 범위가 적용되지/);
    assert.equal(new URL(result.searchUrl).searchParams.has('regionId'), false);
    assert.equal(await resolveDaangnRegion(area, new AbortController().signal, areaLevel), null);
  }
  assert.equal(fetch.mock.callCount(), 0);
});

test('nationwide remains unavailable instead of silently choosing the default neighborhood', async (t) => {
  const fetch = t.mock.method(globalThis, 'fetch', () => { throw new Error('Unexpected network request'); });
  const result = await searchDaangn('카페', { scope: 'nationwide', area, areaLevel: 'province' });
  assert.equal(result.status, 'unavailable');
  assert.deepEqual(result.jobs, []);
  assert.match(result.regionNote, /전국 검색 미지원/);
  assert.equal(fetch.mock.callCount(), 0);
});

test('omitted and explicit neighborhood levels preserve exact region matching and live-card parsing', async (t) => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (input, init) => {
    const url = String(input);
    calls.push({ url, init });
    return url.endsWith('/graphql') ? pickerResponse([node]) : listingResponse(url);
  });
  for (const areaLevel of [undefined, 'neighborhood']) {
    const result = await searchDaangn('카페', {
      scope: 'address', area: { ...area, bcode: `test-neighborhood-${String(areaLevel)}` }, areaLevel
    });
    assert.equal(result.status, 'ok');
    assert.equal(result.jobs.length, 1);
    assert.equal(result.jobs[0].title, '카페 주말 근무');
    assert.equal(result.jobs[0].pay, '시급 12,000원');
    assert.equal(result.jobs[0].schedule, '토,일 · 09:00 ~ 13:00');
    assert.equal(result.regionNote, '서울특별시 마포구 서교동 및 주변 기준');
    const searchUrl = new URL(result.searchUrl);
    assert.equal(searchUrl.searchParams.get('regionId'), '230');
    assert.equal(searchUrl.searchParams.get('query'), '카페');
  }
  const lookups = calls.filter(({ url }) => url.endsWith('/graphql'));
  assert.equal(lookups.length, 2);
  for (const { init } of lookups) {
    const body = JSON.parse(init.body);
    assert.deepEqual(body.variables, { query: '서울 마포구 서교동', first: 20, regionDepth: 3 });
  }
});

test('a cached neighborhood is still never substituted for its district or province', async (t) => {
  let listingCount = 0;
  const selectedArea = { ...area, bcode: 'test-cache-scope' };
  const fetch = t.mock.method(globalThis, 'fetch', async (input) => {
    if (String(input).endsWith('/graphql')) return pickerResponse([node]);
    listingCount++;
    return listingResponse(input);
  });
  assert.equal((await searchDaangn('카페', { scope: 'address', area: selectedArea })).status, 'ok');
  const before = fetch.mock.callCount();
  for (const areaLevel of ['district', 'city', 'province']) {
    const result = await searchDaangn('카페', { scope: 'address', area: selectedArea, areaLevel });
    assert.equal(result.status, 'unavailable');
    assert.deepEqual(result.jobs, []);
  }
  assert.equal(listingCount, 1);
  assert.equal(fetch.mock.callCount(), before);
});

test('same-named neighborhoods in a different district do not fall back to any returned ID', async (t) => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => pickerResponse([{ ...node, name2: '서대문구' }]));
  const result = await searchDaangn('카페', { scope: 'address', area: { ...area, bcode: 'test-mismatch' } });
  assert.equal(result.status, 'unavailable');
  assert.deepEqual(result.jobs, []);
  assert.equal(new URL(result.searchUrl).searchParams.has('regionId'), false);
  assert.equal(fetch.mock.callCount(), 1);
});

test('neighborhood results must confirm both the selected region and query', async (t) => {
  t.mock.method(globalThis, 'fetch', async (input) => String(input).endsWith('/graphql')
    ? pickerResponse([node]) : listingResponse(input, { title: '서울특별시 중구 신당동' }));
  const result = await searchDaangn('카페', { scope: 'address', area: { ...area, bcode: 'test-page-mismatch' } });
  assert.equal(result.status, 'unavailable');
  assert.deepEqual(result.jobs, []);
  assert.match(result.message, /지역과 검색어를 확인하지/);
});
