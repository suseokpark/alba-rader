import assert from 'node:assert/strict';
import { searchDaangnAreas } from '../src/lib/daangn-multi.ts';

const base = process.env.ALBA_RADAR_BASE_URL || 'http://127.0.0.1:5173';
const areas = [
  { sido: '서울', sigungu: '마포구', bname: '서교동', bcode: '1144012000', sigunguCode: '11440' },
  { sido: '서울', sigungu: '마포구', bname: '동교동', bcode: '1144012100', sigunguCode: '11440' }
];
const responses = [];
const result = await searchDaangnAreas('카페', areas, {
  signal: AbortSignal.timeout(35_000),
  fetcher: async (url, options) => {
    const parsed = new URL(url, base);
    assert.equal(parsed.searchParams.get('scope'), 'address');
    assert.equal(parsed.searchParams.get('areaLevel'), 'neighborhood');
    assert.equal(parsed.searchParams.get('source'), 'daangn');
    const response = await fetch(parsed, options);
    responses.push({ area: parsed.searchParams.get('bname'), data: await response.clone().json() });
    return response;
  }
});
assert.equal(result.status, 'ok', JSON.stringify(result.regionResults));
assert.equal(result.partial, false, `Every selected live region must succeed: ${JSON.stringify(result.regionResults)}`);
assert.deepEqual(result.regionResults.map(item => item.label), ['서울 마포구 서교동', '서울 마포구 동교동']);
for (const region of result.regionResults) {
  assert.equal(region.status, 'ok', region.message);
  assert.ok(region.jobsCount > 0 && region.jobsCount <= 20);
  assert.ok(new URL(region.searchUrl).searchParams.get('regionId'));
}
assert.equal(new Set(result.regionResults.map(item => new URL(item.searchUrl).searchParams.get('regionId'))).size, 2);
const expected = [];
const seen = new Set();
for (const area of areas) {
  for (const job of responses.find(item => item.area === area.bname).data.jobs) {
    if (!seen.has(job.url)) { seen.add(job.url); expected.push(job.url); }
  }
}
assert.deepEqual(result.jobs.map(job => job.url), expected, 'Selection order, original order and dedup must match actual inputs');
const rawCount = result.regionResults.reduce((sum, item) => sum + item.jobsCount, 0);
assert.equal(result.duplicateCount, rawCount - result.jobs.length);
console.log(JSON.stringify({ regions: result.regionResults.map(({ label, jobsCount, searchUrl }) => ({ label, jobsCount, searchUrl })), rawCount, uniqueCount: result.jobs.length, duplicateCount: result.duplicateCount }));
console.log('PASS: live two-neighborhood fan-out, independent regions, stable merge and duplicate removal.');
