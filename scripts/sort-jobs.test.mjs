import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hourlyPay, sortJobs } from '../src/lib/sort-jobs.ts';
import { defaultJobFilters, filterJobs } from '../src/lib/filter-jobs.ts';

// Synthetic pay strings exercise the real filter/sort functions. These are not
// captured job listings or evidence of how often providers use these formats.
const job = (id, pay) => ({ id, title: '합성 급여 검증', url: `https://example.invalid/jobs/${id}`, pay });

test('hourly sorting and minimum-pay filtering agree on full-width amounts', () => {
  const jobs = [job('wide-15000', '시급 １５，０００원'), job('plain-12000', '시급 12,000원')];
  const visible = filterJobs(sortJobs(jobs, 'hourly-desc'), { ...defaultJobFilters(), minHourly: 11000 });
  assert.deepEqual(visible.map(({ job }) => job.id), ['wide-15000', 'plain-12000']);
  assert.deepEqual(filterJobs(jobs, { ...defaultJobFilters(), minHourly: 13000 }).map(({ job }) => job.id), ['wide-15000']);
});

test('equivalent explicit hourly amounts accept width and whitespace variants', () => {
  for (const [pay, amount] of [
    ['시급 15,000원', 15000],
    ['시급 １５，０００원', 15000],
    ['  시급\t１５，０００원\n', 15000],
    ['\u3000시급\u3000１만\u00a0５，０００원\u3000', 15000],
    ['시급　２만원', 20000],
    ['시급  12,000', 12000]
  ]) assert.equal(hourlyPay(pay), amount, JSON.stringify(pay));
});

test('normalization does not infer hourly amounts from ranges, negotiations or other units', () => {
  const uncertain = [
    undefined, '', '　', '시급 ０원', '시급 협의', '시급 １５，０００원 협의',
    '시급 １２，０００～１５，０００원', '시급 １２，０００–１５，０００원',
    '시급 １５，０００원 이상', '시급 １．５만원',
    '일급 １５０，０００원', '주급 ６００，０００원', '월급 ３，０００，０００원',
    '연봉 ３０，０００，０００원', '건당 １５，０００원', '급여 시급 １５，０００원'
  ];
  for (const pay of uncertain) assert.equal(hourlyPay(pay), undefined, JSON.stringify(pay));
  const visible = filterJobs(uncertain.map((pay, index) => job(String(index), pay)), {
    ...defaultJobFilters(), minHourly: 1
  });
  assert.deepEqual(visible, [], 'Uncertain and non-hourly amounts cannot pass an exact minimum.');
});

test('equal and unknown wages keep source order without changing input objects or display text', () => {
  const jobs = Object.freeze([
    job('unknown-first', '월급 ３００만원'),
    job('equal-wide-first', '  시급 １５，０００원  '),
    job('high', '시급 2만원'),
    job('equal-ascii-second', '시급 15,000원'),
    job('unknown-second', '시급 협의')
  ].map(Object.freeze));
  const original = jobs.map(({ id, pay }) => ({ id, pay }));
  const sorted = sortJobs(jobs, 'hourly-desc');
  assert.deepEqual(sorted.map(({ id }) => id), ['high', 'equal-wide-first', 'equal-ascii-second', 'unknown-first', 'unknown-second']);
  assert.equal(sortJobs(jobs, 'source'), jobs);
  assert.deepEqual(jobs.map(({ id, pay }) => ({ id, pay })), original);
  for (const item of sorted) assert.equal(item, jobs.find(({ id }) => id === item.id));
});
