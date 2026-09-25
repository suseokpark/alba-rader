import assert from 'node:assert/strict';
import { test } from 'node:test';
import { areaLabel, areaLevelChoices, baseAreaHelp, cityName, normalizeAreaLevel, parseAreaLevel, supportsSearchArea } from '../src/lib/search-area.ts';

const seoul = { sido: '서울', sigungu: '마포구', bname: '서교동', bcode: '1144012000', sigunguCode: '11440' };
const suwon = { sido: '경기', sigungu: '수원시 영통구', bname: '이의동', bcode: '4111710300', sigunguCode: '41117' };

test('neighborhood help names the actual wider Alba coverage for Sejong without a district', () => {
  const sejong = { sido: '세종특별자치시', sigungu: '', bname: '어진동', bcode: '3611011000', sigunguCode: '36110' };
  assert.equal(baseAreaHelp('address', 'neighborhood', sejong), '알바몬은 동·읍·면, 알바천국은 세종특별자치시 전체 기준으로 검색해요.');
});

test('nationwide help ignores the inactive address and regional level', () => {
  for (const level of ['neighborhood', 'district', 'city', 'province']) {
    for (const area of [null, seoul, suwon]) {
      assert.equal(baseAreaHelp('nationwide', level, area), '전국은 알바몬·알바천국에서 검색합니다.');
    }
  }
});

test('ordinary or not-yet-selected neighborhoods retain the existing two-provider help', () => {
  for (const area of [null, seoul, suwon]) {
    assert.equal(baseAreaHelp('address', 'neighborhood', area), '알바몬은 동·읍·면, 알바천국은 시·군·구 기준으로 검색해요.');
  }
});

test('broader regional choices retain the existing expansion help', () => {
  for (const level of ['district', 'city', 'province']) {
    assert.equal(baseAreaHelp('address', level, suwon), '선택한 주소에서 지역 범위를 넓혀 알바몬·알바천국을 검색합니다.');
  }
});

test('labels drop smaller areas only at the requested level', () => {
  assert.equal(areaLabel(seoul, 'neighborhood'), '서울 마포구 서교동');
  assert.equal(areaLabel(seoul, 'district'), '서울 마포구');
  assert.equal(areaLabel(seoul, 'province'), '서울');
  assert.equal(areaLabel(suwon, 'district'), '경기 수원시 영통구');
  assert.equal(areaLabel(suwon, 'city'), '경기 수원시');
  assert.equal(areaLabel(suwon, 'province'), '경기');
  assert.equal(areaLabel(seoul, 'city'), '서울');
});

test('city option is offered only when distinct from district and province', () => {
  assert.deepEqual(areaLevelChoices(null).map(x => x.value), ['neighborhood', 'district', 'province']);
  assert.deepEqual(areaLevelChoices(seoul).map(x => x.value), ['neighborhood', 'district', 'province']);
  assert.deepEqual(areaLevelChoices(suwon).map(x => x.value), ['neighborhood', 'district', 'city', 'province']);
  const jeju = { ...suwon, sido: '제주특별자치도', sigungu: '제주시', bname: '애월읍' };
  assert.equal(cityName(jeju), '제주시');
  assert.deepEqual(areaLevelChoices(jeju).map(x => x.value), ['neighborhood', 'district', 'province']);
  assert.equal(normalizeAreaLevel('city', jeju), 'district');
  assert.equal(normalizeAreaLevel('city', seoul), 'province');
  assert.equal(normalizeAreaLevel('city', suwon), 'city');
});

test('Sejong has province scope without inventing a missing district', () => {
  const sejong = { ...seoul, sido: '세종특별자치시', sigungu: '', bname: '어진동' };
  assert.deepEqual(areaLevelChoices(sejong).map(x => x.value), ['neighborhood', 'province']);
  assert.equal(normalizeAreaLevel('district', sejong), 'province');
  assert.equal(normalizeAreaLevel('city', sejong), 'province');
  assert.equal(areaLabel(sejong, 'province'), '세종특별자치시');
});

test('invalid area levels fail instead of silently widening the search', () => {
  assert.equal(parseAreaLevel(null), 'neighborhood');
  for (const value of ['neighborhood', 'district', 'city', 'province']) assert.equal(parseAreaLevel(value), value);
  for (const value of ['', 'nationwide', 'invalid', '__proto__', 'District']) assert.equal(parseAreaLevel(value), undefined);
});

test('Daangn is selectable only for a neighborhood, other sources support broad scopes', () => {
  for (const source of ['albamon', 'alba']) {
    for (const level of ['neighborhood', 'district', 'city', 'province']) {
      assert.equal(supportsSearchArea(source, 'address', level), true);
      assert.equal(supportsSearchArea(source, 'nationwide', level), true);
    }
  }
  assert.equal(supportsSearchArea('daangn', 'address', 'neighborhood'), true);
  for (const level of ['district', 'city', 'province']) assert.equal(supportsSearchArea('daangn', 'address', level), false);
  assert.equal(supportsSearchArea('daangn', 'nationwide', 'neighborhood'), false);
  for (const scope of ['address', 'nationwide']) {
    for (const level of ['neighborhood', 'district', 'city', 'province']) {
      assert.equal(supportsSearchArea('daangn', scope, level, true), true);
    }
  }
});
