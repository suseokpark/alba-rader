import assert from 'node:assert/strict';
import { test } from 'node:test';
import { searchAlbamon } from '../src/lib/server/providers/albamon.ts';

const seogyo = { sido: '서울', sigungu: '마포구', bname: '서교동', bcode: '1144012000', sigunguCode: '11440' };
const suwon = { sido: '경기', sigungu: '수원시 영통구', bname: '영통동', bcode: '4111710500', sigunguCode: '41117' };
const gapyeong = { sido: '경기', sigungu: '가평군', bname: '가평읍', bcode: '4182025000', sigunguCode: '41820' };

// These representative selectors mirror the public Albamon region-code hierarchy.
const provinces = [
  { code: 'I000', name: '서울특별시', shortName: '서울', collection: [{ code: 'I130', name: '마포구' }, { code: 'I010', name: '강남구' }] },
  { code: 'B000', name: '경기도', shortName: '경기', collection: [
    { code: 'B010', name: '가평군' }, { code: 'B180', name: '수원시 권선구' },
    { code: 'B201', name: '수원시 영통구' }, { code: 'B190', name: '수원시 장안구' },
    { code: 'B200', name: '수원시 팔달구' }, { code: 'B150', name: '성남시 분당구' }
  ] },
  { code: '1000', name: '세종특별자치시', shortName: '세종', collection: [{ code: '1010', name: '세종시' }] }
];

function fixture(t, change = () => {}) {
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (input) => {
    const url = new URL(input.toString());
    requests.push(url);
    if (url.hostname === 'api-code.albamon.com') {
      if (url.pathname.endsWith('/sigu/codes')) return Response.json(provinces);
      if (url.pathname.endsWith('/dongs/gucode') && url.searchParams.get('code') === 'I130') {
        return Response.json([{ code: 'I1300180', name: '서교동' }]);
      }
      throw new Error(`Unexpected code lookup: ${url}`);
    }
    assert.equal(url.hostname, 'www.albamon.com');
    assert.equal(url.pathname, '/total-search');
    const areas = (url.searchParams.get('areas') || '').split(',').filter(Boolean).map((code) => ({
      si: `${code[0]}000`, gu: code.endsWith('000') ? '' : code.slice(0, 4), dong: code.length > 4 ? code : ''
    }));
    const condition = { areas, disableExtensionSearch: true, similarDongJoin: false };
    const data = {
      condition: { tags: areas.map((area) => ({ searchConditionType: { key: 'AREA' }, code: `${area.si}-${area.gu}-${area.dong}` })) },
      base: { pagination: { totalCount: 1 }, normal: { collection: [{ recruitNo: 1234, recruitTitle: '지역별 카페 공고' }] } }
    };
    change({ condition, data });
    const next = { props: { pageProps: {
      query: { keyword: url.searchParams.get('keyword') }, condition: { condition },
      dehydratedState: { queries: [{ queryKey: ['SEARCH_RECRUIT_LIST', 'list'], state: { data } }] }
    } } };
    return new Response(`<a href="https://www.albamon.com/jobs/detail/1234">공고</a><script id="__NEXT_DATA__">${JSON.stringify(next)}</script>`, { headers: { 'Content-Type': 'text/html' } });
  });
  return requests;
}

function areaParam(result) {
  return new URL(result.searchUrl).searchParams.get('areas');
}

test('legacy default remains exact neighborhood and does not silently expand a missing neighborhood', async (t) => {
  fixture(t);
  const result = await searchAlbamon('카페', { scope: 'address', area: seogyo });
  assert.equal(result.status, 'ok');
  assert.equal(areaParam(result), 'I1300180');
  assert.match(result.regionNote, /서울 마포구 서교동/);
  const missing = await searchAlbamon('카페', { scope: 'address', area: { ...seogyo, bname: '' } });
  assert.equal(missing.status, 'unavailable');
  assert.deepEqual(missing.jobs, []);
});

test('district searches retain the full original city and district name', async (t) => {
  const requests = fixture(t);
  const result = await searchAlbamon('카페', { scope: 'address', area: suwon, areaLevel: 'district' });
  assert.equal(result.status, 'ok');
  assert.equal(areaParam(result), 'B201');
  assert.match(result.regionNote, /수원시 영통구 전체/);
  assert.ok(requests.every((url) => !url.pathname.includes('/dongs/')));
});

test('province searches use the official province selector without a neighborhood restriction', async (t) => {
  fixture(t);
  const result = await searchAlbamon('카페', { scope: 'address', area: suwon, areaLevel: 'province' });
  assert.equal(result.status, 'ok');
  assert.equal(areaParam(result), 'B000');
  assert.match(result.regionNote, /경기 전체/);
  const url = new URL(result.searchUrl);
  assert.equal(url.searchParams.get('keyword'), '카페');
  assert.equal(url.searchParams.get('disableExtensionSearch'), 'true');
  assert.equal(url.searchParams.get('similarDongJoin'), 'false');
});

test('city searches include every official Suwon district in one source search, excluding other cities', async (t) => {
  const requests = fixture(t);
  const result = await searchAlbamon('카페', { scope: 'address', area: suwon, areaLevel: 'city' });
  assert.equal(result.status, 'ok');
  assert.deepEqual(areaParam(result).split(','), ['B180', 'B201', 'B190', 'B200']);
  assert.match(result.regionNote, /경기 수원시 전체/);
  assert.equal(requests.filter((url) => url.pathname === '/total-search').length, 1);
});

test('metropolitan city means the whole city while a county stays within that county', async (t) => {
  fixture(t);
  const seoul = await searchAlbamon('카페', { scope: 'address', area: seogyo, areaLevel: 'city' });
  assert.equal(seoul.status, 'ok');
  assert.equal(areaParam(seoul), 'I000');
  assert.match(seoul.regionNote, /서울 전체/);
  const county = await searchAlbamon('카페', { scope: 'address', area: gapyeong, areaLevel: 'city' });
  assert.equal(county.status, 'ok');
  assert.equal(areaParam(county), 'B010');
  assert.match(county.regionNote, /가평군 전체/);
  const sejong = await searchAlbamon('카페', { scope: 'address', area: { sido: '세종특별자치시', sigungu: '', bname: '어진동', bcode: '3611011000', sigunguCode: '36110' }, areaLevel: 'city' });
  assert.equal(sejong.status, 'ok');
  assert.equal(areaParam(sejong), '1000');
});

test('unmapped areas and unsupported levels fail closed before a listing request', async (t) => {
  const requests = fixture(t);
  for (const options of [
    { scope: 'address', area: { ...suwon, sigungu: '없는시 영통구' }, areaLevel: 'city' },
    { scope: 'address', area: { ...seogyo, sigungu: '없는구' }, areaLevel: 'district' },
    { scope: 'address', area: { ...suwon, sido: '없는도' }, areaLevel: 'province' },
    { scope: 'address', area: suwon, areaLevel: 'invalid' }
  ]) {
    const result = await searchAlbamon('카페', options);
    assert.equal(result.status, 'unavailable');
    assert.deepEqual(result.jobs, []);
  }
  assert.ok(requests.every((url) => url.hostname === 'api-code.albamon.com'));
});

test('all requested areas must survive both the returned conditions and applied tags', async (t) => {
  const cases = [
    ['missing applied city district', ({ data }) => { data.condition.tags.pop(); }],
    ['extra returned province', ({ condition }) => { condition.areas.push({ si: 'B000', gu: '', dong: '' }); }],
    ['duplicate replaces another district', ({ data }) => { data.condition.tags[0] = data.condition.tags[1]; }],
    ['automatic expansion enabled', ({ condition }) => { condition.disableExtensionSearch = false; }]
  ];
  for (const [name, change] of cases) {
    await t.test(name, async (subtest) => {
      fixture(subtest, change);
      const result = await searchAlbamon('카페', { scope: 'address', area: suwon, areaLevel: 'city' });
      assert.equal(result.status, 'unavailable');
      assert.deepEqual(result.jobs, []);
    });
  }
});

test('source reordering is accepted only when every requested area still matches exactly', async (t) => {
  fixture(t, ({ condition, data }) => { condition.areas.reverse(); data.condition.tags.reverse(); });
  const result = await searchAlbamon('카페', { scope: 'address', area: suwon, areaLevel: 'city' });
  assert.equal(result.status, 'ok');
  assert.equal(result.jobs.length, 1);
});
