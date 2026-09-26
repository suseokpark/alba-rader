import assert from 'node:assert/strict';
import { test } from 'node:test';
import { searchAlbamon } from '../src/lib/server/providers/albamon.ts';
import { defaultJobFilters, filterJobs } from '../src/lib/filter-jobs.ts';

// Offline synthetic hydration records at the actual provider fetch boundary.
// These are not live listings, browser DOM/XSS tests or measured source frequency.
const job = (id, title, companyName = '합성 회사') => ({ recruitNo: id, recruitTitle: title, companyName });
async function searchFixture(t, collection, {
  query = '카페', returnedQuery = query, linkedIds = collection.map((item) => item.recruitNo)
} = {}) {
  const fetch = t.mock.method(globalThis, 'fetch', async (input) => {
    const url = new URL(input);
    assert.equal(url.origin, 'https://www.albamon.com');
    assert.equal(url.pathname, '/total-search');
    assert.equal(url.searchParams.get('keyword'), query);
    const data = { base: { normal: { collection }, pagination: { totalCount: collection.length } } };
    const next = { props: { pageProps: { query: { keyword: returnedQuery },
      dehydratedState: { queries: [{ queryKey: ['SEARCH_RECRUIT_LIST', 'list'], state: { data } }] } } } };
    // Preserve literal angle brackets inside parsed JSON without terminating the
    // surrounding hydration script. This is fixture transport, not a text decoder.
    const payload = JSON.stringify(next).replace(/</g, '\\u003c');
    const links = linkedIds.map((id) => `<a href="https://www.albamon.com/jobs/detail/${id}">합성 원문 링크</a>`).join('');
    return new Response(`${links}<script id="__NEXT_DATA__">${payload}</script>`, { headers: { 'Content-Type': 'text/html' } });
  });
  const result = await searchAlbamon(query, { scope: 'nationwide' });
  assert.equal(fetch.mock.callCount(), 1);
  assert.equal(result.source, 'albamon');
  assert.equal(new URL(result.searchUrl).searchParams.get('keyword'), query);
  assert.equal(result.regionNote, '전국 검색');
  return result;
}

test('Albamon titles and company names decode numeric references with either hex case and optional semicolons, then normalize spaces', async (t) => {
  const result = await searchFixture(t, [job(8101,
    '  합성 &#XC0FE &#xc0fe; &#49406; &#49406\n카페 &amp; 주말  ',
    ' 합성&nbsp;\t&#67;&#97;&#102;&#101; &amp;  회사 ')]);
  assert.equal(result.status, 'ok');
  assert.equal(result.jobs[0].title, '합성 샾 샾 샾 샾 카페 & 주말');
  assert.equal(result.jobs[0].company, '합성 Cafe & 회사');
});

test('display decoding runs once and preserves literal markup-like text instead of consuming it as elements', async (t) => {
  const result = await searchFixture(t, [job(8102,
    '합성 <주말> </textarea><script>문자만</script> &lt;카페&gt; &amp;amp; &amp;#XC0FE;',
    '합성 </textarea><script>회사문자</script> &#x26;lt;주말&#x26;gt;')]);
  assert.equal(result.status, 'ok');
  assert.equal(result.jobs[0].title, '합성 <주말> </textarea><script>문자만</script> <카페> &amp; &#XC0FE;');
  assert.equal(result.jobs[0].company, '합성 </textarea><script>회사문자</script> &lt;주말&gt;');
});

test('plain and unrecognized references remain text without modifying other listing fields', async (t) => {
  const malformed = '합성 &#xZZ; &#; &#x; &madeup; A&B 100%';
  const result = await searchFixture(t, [
    { ...job(8103, malformed, '합성 일반 회사'), workplaceAddress: '합성 &amp; 주소',
      payType: { description: '시급' }, pay: '12,000원', workingWeek: '토,일', workingTime: '09:00~13:00' },
    job(8104, '합성 일반 카페 <주말>', '&nbsp;')
  ]);
  assert.equal(result.status, 'ok');
  assert.equal(result.jobs[0].title, malformed);
  assert.equal(result.jobs[0].company, '합성 일반 회사');
  assert.equal(result.jobs[0].location, '합성 &amp; 주소', 'The change is limited to title and company display text.');
  assert.equal(result.jobs[0].pay, '시급 12,000원');
  assert.equal(result.jobs[0].schedule, '토,일 · 09:00~13:00');
  assert.equal(result.jobs[1].title, '합성 일반 카페 <주말>');
  assert.equal(result.jobs[1].company, undefined, 'A decoded whitespace-only company remains absent.');
});

test('decoded title and company words participate in the actual include and exclude filters', async (t) => {
  const result = await searchFixture(t, [
    job(8105, '합성 &#XC0FE 카페', '합성&nbsp;원두&amp;우유'),
    job(8106, '합성 일반 카페', '합성 다른 회사')
  ]);
  assert.equal(result.status, 'ok');
  assert.deepEqual(filterJobs(result.jobs, { ...defaultJobFilters(), include: '샾, 원두&우유' }).map(({ job }) => job.id), ['albamon-8105']);
  assert.deepEqual(filterJobs(result.jobs, { ...defaultJobFilters(), exclude: '샾' }).map(({ job }) => job.id), ['albamon-8106']);
  assert.deepEqual(filterJobs(result.jobs, { ...defaultJobFilters(), exclude: '원두&우유' }).map(({ job }) => job.id), ['albamon-8106']);
});

test('display decoding does not relax exact query, numeric identifier, verified link or duplicate checks', async (t) => {
  const result = await searchFixture(t, [
    job(8107, '합성 &#XC0FE 첫 공고'), job(8107, '합성 두 번째 중복'),
    job('&#56;108', '합성 encoded ID'), job(8109, '합성 링크 없음'), job('bad-id', '합성 잘못된 ID'),
    job(8111, '&nbsp; &#32;')
  ], { linkedIds: [8107, '&#56;108', 'bad-id', 8111] });
  assert.equal(result.status, 'ok');
  assert.equal(result.jobs.length, 1);
  assert.equal(result.jobs[0].id, 'albamon-8107');
  assert.equal(result.jobs[0].url, 'https://www.albamon.com/jobs/detail/8107');
  assert.match(result.jobs[0].title, /첫 공고$/);
  const mismatch = await searchFixture(t, [job(8110, '합성 query mismatch')], { query: 'A&B', returnedQuery: 'A&amp;B' });
  assert.equal(mismatch.status, 'unavailable', 'Payload query comparison must not decode a different supplied query into a match.');
  assert.deepEqual(mismatch.jobs, []);
});
