import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addressMapUrl, kakaoMapSearchUrl, neighborhoodMapUrl } from '../src/lib/map-links.ts';

const base = 'https://map.kakao.com/link/search/';
function decodedQuery(value) {
  const url = new URL(value);
  assert.equal(url.origin, 'https://map.kakao.com');
  assert.equal(url.protocol, 'https:');
  assert.equal(url.username, '');
  assert.equal(url.password, '');
  assert.equal(url.search, '');
  assert.equal(url.hash, '');
  assert.ok(url.pathname.startsWith('/link/search/'));
  return decodeURIComponent(url.pathname.slice('/link/search/'.length));
}

test('Korean road, underground, and lot addresses use the official encoded search route', () => {
  for (const address of ['서울 마포구 양화로 160', '서울 마포구 양화로 지하 160 (홍대입구역)', '서울 마포구 서교동 395-166']) {
    const result = addressMapUrl({ address });
    assert.equal(result, `${base}${encodeURIComponent(address)}`);
    assert.equal(decodedQuery(result), address);
  }
});

test('reserved characters and URL-like input stay entirely within the map search text', () => {
  for (const query of ['서울 A&B?x=1#입구/2층%20', 'https://other.example/a?b=c#d', '//other.example/@user', '../other/../../search?x=1', 'javascript:alert(1)', 'A\\B "입구" + = !']) {
    const result = kakaoMapSearchUrl(query);
    assert.equal(result, `${base}${encodeURIComponent(query)}`);
    assert.equal(decodedQuery(result), query);
  }
});

test('ordinary and Unicode whitespace are trimmed and collapsed', () => {
  assert.equal(decodedQuery(kakaoMapSearchUrl('  서울   마포구\u00a0\u3000서교동  ')), '서울 마포구 서교동');
  for (const value of [undefined, null, '', '   ', '\u00a0\u3000']) assert.equal(kakaoMapSearchUrl(value), undefined);
});

test('control characters, excessive length, and path-normalizing dot segments are rejected', () => {
  for (const value of ['서울\n마포구', '서울\t마포구', '\r서울', '서울\u0000', '서울\u007f', '서울\u0085', '가'.repeat(301), ' '.repeat(2_001), '.', ' .. ']) {
    assert.equal(kakaoMapSearchUrl(value), undefined);
  }
  assert.equal(decodedQuery(kakaoMapSearchUrl('가'.repeat(300))), '가'.repeat(300));
});

test('malformed Unicode is handled without throwing during UI rendering', () => {
  assert.equal(kakaoMapSearchUrl('서울\ud800'), undefined);
  assert.equal(kakaoMapSearchUrl('\udfff'), undefined);
  assert.equal(decodedQuery(kakaoMapSearchUrl('서울 🌳공원')), '서울 🌳공원');
});

test('address changes produce fresh links and clearing the selection removes the link', () => {
  const selected = { address: '서울 마포구 양화로 160' };
  const first = addressMapUrl(selected);
  selected.address = '부산 해운대구 APEC로 55';
  const second = addressMapUrl(selected);
  assert.notEqual(first, second);
  assert.equal(decodedQuery(first), '서울 마포구 양화로 160');
  assert.equal(decodedQuery(second), '부산 해운대구 APEC로 55');
  assert.equal(addressMapUrl(null), undefined);
  assert.equal(addressMapUrl({ address: ' ' }), undefined);
});

test('neighborhood links include only province, district, and neighborhood, never street or postcode', () => {
  const area = {
    sido: '서울', sigungu: '마포구', bname: '서교동', bcode: '1144012000', sigunguCode: '11440',
    get address() { throw new Error('The street address must not be accessed'); },
    get zonecode() { throw new Error('The postcode must not be accessed'); }
  };
  assert.equal(decodedQuery(neighborhoodMapUrl(area)), '서울 마포구 서교동');
});

test('Sejong supports an empty district while incomplete neighborhoods have no map link', () => {
  const area = { sido: '세종특별자치시', sigungu: '', bname: '어진동', bcode: '3611011000', sigunguCode: '36110' };
  assert.equal(decodedQuery(neighborhoodMapUrl(area)), '세종특별자치시 어진동');
  assert.equal(neighborhoodMapUrl({ ...area, bname: ' ' }), undefined);
  assert.equal(neighborhoodMapUrl({ ...area, sido: '' }), undefined);
});
