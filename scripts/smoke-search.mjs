import assert from 'node:assert/strict';

// Run against a local app; verifies address filters and the nationwide option.
const base = process.env.ALBA_RADAR_BASE_URL || 'http://127.0.0.1:5173';
const expectedHosts = { daangn: 'jobs.daangn.com', albamon: 'www.albamon.com', alba: 'www.alba.co.kr' };
const started = Date.now();
const area = { scope: 'address', sido: '서울', sigungu: '마포구', bname: '서교동', bcode: '1144012000', sigunguCode: '11440' };

await Promise.all(Object.entries(expectedHosts).map(async ([source, host]) => {
  const response = await fetch(`${base}/api/search?${new URLSearchParams({ q: '카페', source, ...area })}`);
  assert.equal(response.status, 200, `${source}: API status`);
  const result = await response.json();
  assert.equal(result.source, source);
  assert.equal(result.status, 'ok', `${source}: ${result.message || 'Expected live results'}`);
  assert.ok(result.jobs.length > 0 && result.jobs.length <= 20);
  assert.equal(new Set(result.jobs.map((job) => job.id)).size, result.jobs.length);
  assert.equal(new URL(result.searchUrl).hostname, host);
  assert.ok(Object.values(Object.fromEntries(new URL(result.searchUrl).searchParams)).includes('카페'));
  assert.ok(Number.isFinite(Date.parse(result.checkedAt)));
  for (const job of result.jobs) {
    assert.ok(job.id && job.title.trim());
    const url = new URL(job.url);
    assert.equal(url.protocol, 'https:');
    assert.equal(url.hostname, host);
    assert.match(url.pathname, /job-posts\/|jobs\/detail\/|job\/Detail/);
  }
  assert.match(result.regionNote, /마포구/);
  const params = new URL(result.searchUrl).searchParams;
  if (source === 'daangn') { assert.equal(params.get('regionId'), '230'); assert.match(result.regionNote, /서교동/); }
  if (source === 'albamon') { assert.equal(params.get('areas'), 'I1300180'); assert.ok(result.jobs.every(job => /서교동/.test(job.location))); }
  if (source === 'alba') { assert.equal(params.get('hidArea'), '02||마포구,'); assert.ok(result.jobs.every(job => /마포구/.test(job.location))); }
  console.log(`${source}: ${result.jobs.length} verified live links (${Date.now() - started}ms)`);
}));

await Promise.all(Object.keys(expectedHosts).map(async source => {
  const response = await fetch(`${base}/api/search?${new URLSearchParams({ q: '카페', source, scope: 'nationwide' })}`);
  const result = await response.json();
  if (source === 'daangn') {
    assert.equal(result.status, 'unavailable');
    assert.equal(result.jobs.length, 0, 'Do not label a default region as nationwide');
  } else {
    assert.equal(result.status, 'ok');
    assert.equal(result.regionNote, '전국 검색');
    const params = new URL(result.searchUrl).searchParams;
    assert.ok(!params.has('areas') && !params.has('hidArea'), 'Nationwide must remove area restrictions');
  }
}));

for (const query of [
  new URLSearchParams({ source: 'daangn', q: '' }),
  new URLSearchParams({ source: '__proto__', q: '카페' }),
  new URLSearchParams({ source: 'unknown', q: '카페' }),
  new URLSearchParams({ source: 'daangn', q: 'x'.repeat(81) }),
  new URLSearchParams({ source: 'daangn', q: '카페', scope: 'address' }),
  new URLSearchParams({ source: 'daangn', q: '카페', ...area, bcode: '2641010500' }),
  new URLSearchParams({ source: 'alba', q: '카페', scope: 'invalid' })
]) {
  const response = await fetch(`${base}/api/search?${query}`);
  assert.equal(response.status, 400, 'Invalid input must not trigger an upstream lookup');
}
console.log('PASS: address-filtered three-source search, nationwide, invalid address, official detail links.');
