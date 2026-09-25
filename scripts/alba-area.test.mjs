import assert from 'node:assert/strict';
import { test } from 'node:test';
import { searchAlba } from '../src/lib/server/providers/alba.ts';

// A small subset of the public _AreaCode.js shape; 검증시 is synthetic for the limit case.
const areaCodes = {
  ARCD: [
    { ARCD: '02', ARNM: '서울', FUNM: '서울특별시' },
    { ARCD: '031', ARNM: '경기', FUNM: '경기도' },
    { ARCD: '044', ARNM: '세종', FUNM: '세종시' }
  ],
  ARCD_02: ['전체', '마포구', '강남구'].map(GUCD => ({ GUCD })),
  ARCD_031: [
    '전체', '가평군', '수원시 권선구', '수원시 영통구', '수원시 장안구', '수원시 팔달구',
    '성남시 분당구', '검증시 일구', '검증시 이구', '검증시 삼구', '검증시 사구', '검증시 오구', '검증시 육구'
  ].map(GUCD => ({ GUCD })),
  ARCD_044: [{ GUCD: '전체' }]
};

const seogyo = { sido: '서울', sigungu: '마포구', bname: '서교동', bcode: '1144012000', sigunguCode: '11440' };
const yeongtong = { sido: '경기', sigungu: '수원시 영통구', bname: '영통동', bcode: '4111710500', sigunguCode: '41117' };
const responseWithUrl = (body, url) => {
  const response = new Response(body, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  Object.defineProperty(response, 'url', { value: String(url) });
  return response;
};

test('Alba region levels request complete official area conditions and verify the response', async t => {
  const requests = [];
  let overrideArea;
  t.mock.method(globalThis, 'fetch', async input => {
    const url = new URL(input);
    requests.push(url);
    if (url.pathname === '/rsc/js/_AreaCode.js') {
      return responseWithUrl(`var arrAreaCodeJson = ${JSON.stringify(areaCodes)};`, url);
    }
    assert.equal(url.origin, 'https://www.alba.co.kr');
    assert.equal(url.pathname, '/search/Search');
    const selected = overrideArea ?? url.searchParams.get('hidArea') ?? '';
    return responseWithUrl(`
      <input id="hidArea" value="${selected}">
      <ul id="jobNormal"><li class="job-list__row">
        <a class="job-list__link info" href="/job/Detail?adid=123456">
          <span class="job-list__company">Fixture company<span class="job-list__area">Fixture area</span></span>
          <span class="job-list__subject">Fixture cafe job</span>
        </a>
        <div class="job-list__col pay"><span class="payIcon">시급</span><strong class="job-list__number">12,000</strong></div>
      </li></ul>`, url);
  });

  async function query(area, areaLevel) {
    const result = await searchAlba('카페', { scope: 'address', area, ...(areaLevel ? { areaLevel } : {}) });
    assert.equal(result.status, 'ok', result.message);
    return { result, hidArea: new URL(result.searchUrl).searchParams.get('hidArea') };
  }

  await t.test('legacy neighborhood is explicitly limited to the district', async () => {
    const { result, hidArea } = await query(seogyo);
    assert.equal(hidArea, '02||마포구,');
    assert.match(result.regionNote, /마포구.*동 단위 미지원/);
  });

  await t.test('district keeps the complete postal city-and-ward name', async () => {
    assert.equal((await query(seogyo, 'district')).hidArea, '02||마포구,');
    const { result, hidArea } = await query(yeongtong, 'district');
    assert.equal(hidArea, '031||수원시 영통구,');
    assert.match(result.regionNote, /수원시 영통구/);
    assert.doesNotMatch(result.regionNote, /동 단위 미지원/);
  });

  await t.test('city expands a metropolitan ward to the whole metropolitan city', async () => {
    const { result, hidArea } = await query(seogyo, 'city');
    assert.equal(hidArea, '02||전체,');
    assert.match(result.regionNote, /서울 전체.*시 기준/);
  });

  await t.test('city selects every matching ward, with no neighboring-city conditions', async () => {
    const { result, hidArea } = await query(yeongtong, 'city');
    assert.equal(hidArea, '031||수원시 권선구,031||수원시 영통구,031||수원시 장안구,031||수원시 팔달구,');
    assert.match(result.regionNote, /수원시 전체/);
    assert.doesNotMatch(hidArea, /성남시|전체/);
  });

  await t.test('a county has the same district and city coverage; province explicitly expands it', async () => {
    const county = { ...yeongtong, sigungu: '가평군' };
    assert.equal((await query(county, 'district')).hidArea, '031||가평군,');
    assert.equal((await query(county, 'city')).hidArea, '031||가평군,');
    const { result, hidArea } = await query(county, 'province');
    assert.equal(hidArea, '031||전체,');
    assert.match(result.regionNote, /경기 전체.*시·도 기준/);
  });

  await t.test('Sejong with no subordinate district uses its official whole-city option', async () => {
    const area = { ...seogyo, sido: '세종특별자치시', sigungu: '' };
    assert.equal((await query(area, 'city')).hidArea, '044||전체,');
    assert.equal((await query(area, 'province')).hidArea, '044||전체,');
  });

  await t.test('over-five or unmapped city selections never make a partial or nationwide request', async () => {
    const before = requests.length;
    const tooMany = await searchAlba('카페', { scope: 'address', area: { ...yeongtong, sigungu: '검증시 일구' }, areaLevel: 'city' });
    assert.equal(tooMany.status, 'unavailable');
    assert.match(tooMany.message, /5개/);
    assert.equal(tooMany.jobs.length, 0);
    const unknown = await searchAlba('카페', { scope: 'address', area: { ...yeongtong, sigungu: '알수없는시 알수없는구' }, areaLevel: 'city' });
    assert.equal(unknown.status, 'unavailable');
    assert.equal(requests.length, before);
  });

  await t.test('a response that drops part of the selected city conditions is unavailable', async () => {
    overrideArea = '031||수원시 영통구,';
    try {
      const result = await searchAlba('카페', { scope: 'address', area: yeongtong, areaLevel: 'city' });
      assert.equal(result.status, 'unavailable');
      assert.equal(result.jobs.length, 0);
      assert.match(result.message, /조건 적용/);
    } finally {
      overrideArea = undefined;
    }
  });

  await t.test('nationwide omits all region restrictions regardless of the area level', async () => {
    const result = await searchAlba('카페', { scope: 'nationwide', area: yeongtong, areaLevel: 'province' });
    assert.equal(result.status, 'ok');
    assert.equal(result.regionNote, '전국 검색');
    assert.equal(new URL(result.searchUrl).searchParams.has('hidArea'), false);
  });
});
