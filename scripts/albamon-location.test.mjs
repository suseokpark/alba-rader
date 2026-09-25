import assert from 'node:assert/strict';
import { test } from 'node:test';
import { searchAlbamon } from '../src/lib/server/providers/albamon.ts';

// Offline synthetic hydration records at the real provider's fetch boundary.
// The reported location strings are reproduced as inputs; the surrounding jobs
// are synthetic and are never fetched externally or injected into a browser.
const query = '카페';
const suppliedArea = '전남광주 순천시 풍덕동';
const suppliedAddress = '전남 순천시 국가정원1호길 152-55 (풍덕동) 순천만 국가정원 전체';
const job = (id, fields = {}) => ({ recruitNo: id, recruitTitle: '합성 위치 회귀 공고', ...fields });

async function searchFixture(t, collection, linkedIds = collection.map((item) => item.recruitNo)) {
  const fetch = t.mock.method(globalThis, 'fetch', async (input) => {
    const url = new URL(input);
    assert.equal(url.origin, 'https://www.albamon.com');
    assert.equal(url.pathname, '/total-search');
    assert.equal(url.searchParams.get('keyword'), query);
    const data = { base: { normal: { collection }, pagination: { totalCount: collection.length } } };
    const next = { props: { pageProps: { query: { keyword: query },
      dehydratedState: { queries: [{ queryKey: ['SEARCH_RECRUIT_LIST', 'list'], state: { data } }] } } } };
    const links = linkedIds.map((id) => `<a href="https://www.albamon.com/jobs/detail/${id}">합성 원문 링크</a>`).join('');
    return new Response(`${links}<script id="__NEXT_DATA__">${JSON.stringify(next)}</script>`, { headers: { 'Content-Type': 'text/html' } });
  });
  const result = await searchAlbamon(query, { scope: 'nationwide' });
  assert.equal(fetch.mock.callCount(), 1);
  assert.equal(result.source, 'albamon');
  assert.equal(result.status, 'ok', result.message);
  assert.equal(new URL(result.searchUrl).searchParams.get('keyword'), query);
  assert.equal(result.regionNote, '전국 검색');
  return result.jobs;
}

test('a supplied workplace address takes precedence over a broad area without geographic rewriting', async (t) => {
  const jobs = await searchFixture(t, [
    job(119355258, { workplaceArea: suppliedArea, workplaceAddress: suppliedAddress }),
    job(1002, { workplaceArea: '합성 넓은 지역', workplaceAddress: '원문이 제공한 장소 A 12-3' })
  ]);
  assert.deepEqual(jobs.map((item) => item.location), [suppliedAddress, '원문이 제공한 장소 A 12-3']);
});

test('the selected full address is whitespace-normalized without dropping its road, building or parenthetical detail', async (t) => {
  const [result] = await searchFixture(t, [job(1003, {
    workplaceArea: suppliedArea,
    workplaceAddress: '  전남  순천시\n국가정원1호길\t152-55  (풍덕동)   순천만 국가정원 전체  '
  })]);
  assert.equal(result.location, suppliedAddress);
});

for (const [name, address] of [['undefined', undefined], ['null', null], ['blank', ' \t\n '], ['non-string', { value: suppliedAddress }]]) {
  test(`a ${name} workplace address falls back to the supplied area without guessing a correction`, async (t) => {
    const [result] = await searchFixture(t, [job(1004, {
      workplaceArea: '  전남광주\n순천시\t풍덕동  ', workplaceAddress: address
    })]);
    assert.equal(result.location, suppliedArea);
  });
}

test('no usable address or area leaves location undefined rather than inferring it from other job fields', async (t) => {
  const records = [{}, { workplaceArea: null, workplaceAddress: null },
    { workplaceArea: '  ', workplaceAddress: '\t' }, { workplaceArea: 123, workplaceAddress: false }]
    .map((fields, index) => job(1100 + index, { companyName: '합성 서울 강남구 회사', recruitTitle: '합성 부산 카페 공고', ...fields }));
  const jobs = await searchFixture(t, records);
  assert.equal(jobs.length, records.length);
  assert.ok(jobs.every((item) => item.location === undefined));
});

test('location selection preserves the identifier, verified detail link and other normalized job fields', async (t) => {
  const [result] = await searchFixture(t, [job(1200, {
    recruitTitle: '  합성\n카페 공고  ', companyName: '  합성\t회사  ', workplaceAddress: suppliedAddress,
    payType: { description: '시급' }, pay: ' 12,000원 ', workingWeek: ' 토,일 ', workingTime: ' 09:00~13:00 ', workingPeriod: ' 6개월~1년 '
  })]);
  assert.deepEqual(result, {
    id: 'albamon-1200', title: '합성 카페 공고', url: 'https://www.albamon.com/jobs/detail/1200',
    company: '합성 회사', location: suppliedAddress, pay: '시급 12,000원', schedule: '토,일 · 09:00~13:00 · 6개월~1년'
  });
});

test('verified source order, first-duplicate retention and the 20-job limit survive the location change', async (t) => {
  const records = Array.from({ length: 25 }, (_, index) => job(2000 + index, {
    recruitTitle: `합성 공고 ${index}`, workplaceAddress: `합성 원문 주소 ${index}`
  }));
  const jobs = await searchFixture(t, [job(9999, { workplaceAddress: '링크 없는 합성 주소' }), records[0],
    { ...records[0], recruitTitle: '중복 두 번째 제목', workplaceAddress: '중복 두 번째 주소' }, ...records.slice(1)],
  records.map((item) => item.recruitNo));
  assert.equal(jobs.length, 20);
  assert.deepEqual(jobs.map((item) => item.id), records.slice(0, 20).map((item) => `albamon-${item.recruitNo}`));
  assert.equal(jobs[0].title, '합성 공고 0');
  assert.equal(jobs[0].location, '합성 원문 주소 0');
  assert.ok(jobs.every((item) => item.url === `https://www.albamon.com/jobs/detail/${item.id.slice('albamon-'.length)}`));
});
