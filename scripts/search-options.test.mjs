import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hourlyPay, sortJobs } from '../src/lib/sort-jobs.ts';
import { selectedAddress } from '../src/lib/postcode.ts';
import { sources } from '../src/lib/search.ts';

test('source display order is Albamon, Daangn, Alba regardless of selection order', () => {
  const selection = ['alba', 'daangn', 'albamon'];
  assert.deepEqual(sources.filter(source => selection.includes(source.id)).map(source => source.id), ['albamon', 'daangn', 'alba']);
});

test('hourly sorting compares explicit wages and keeps other units in source order', () => {
  assert.equal(hourlyPay('시급 12,500원'), 12500);
  assert.equal(hourlyPay('시급 1만 3,000원'), 13000);
  assert.equal(hourlyPay('시급 2만원'), 20000);
  for (const value of ['월급 300만원', '일급 120,000원', '시급 협의', '시급 12,000~15,000원', '시급 0원']) {
    assert.equal(hourlyPay(value), undefined);
  }
  const jobs = ['월급 300만원', '시급 12,500원', '일급 120,000원', '시급 2만원', '시급 12,500원'].map((pay, id) => ({ id: String(id), pay, title: 'test', url: 'https://example.com' }));
  assert.deepEqual(sortJobs(jobs, 'hourly-desc').map(job => job.id), ['3', '1', '4', '0', '2']);
  assert.deepEqual(sortJobs(jobs, 'source').map(job => job.id), ['0', '1', '2', '3', '4']);
});

test('postcode callback uses the actual selected address and administrative fields', () => {
  const input = { address: '대표주소', roadAddress: '도로명주소', jibunAddress: '지번주소', userSelectedType: 'R', zonecode: '04040', sido: '서울', sigungu: '마포구', sigunguCode: '11440', bname: '서교동', bname1: '', bcode: '1144012000' };
  const selected = selectedAddress(input);
  assert.equal(selected.address, '도로명주소');
  assert.equal(selected.bname, '서교동');
  assert.equal(selected.bcode, '1144012000');
  assert.equal(selectedAddress({ ...input, userSelectedType: 'J' }).address, '지번주소');
  assert.equal(selectedAddress({ ...input, bname1: '애월읍', bname: '애월리' }).bname, '애월읍');
});
