import assert from 'node:assert/strict';
import { test } from 'node:test';
import { activeFilterCount, defaultJobFilters, filterJobs } from '../src/lib/filter-jobs.ts';

const job = (id, fields = {}) => ({ id, title: '카페 직원', url: `https://example.com/jobs/${id}`, ...fields });
const filters = (overrides = {}) => ({ ...defaultJobFilters(), ...overrides });
const ids = (results) => results.map(({ job }) => job.id);

test('pay types use the actual pay prefix, not the title or a different pay unit', () => {
  const jobs = [
    job('hourly', { pay: '시급 12,000원' }),
    job('daily', { pay: '일급 120,000원', title: '시급 높은 카페' }),
    job('weekly', { pay: '주급 600,000원' }),
    job('monthly', { pay: '월급 3,000,000원' }),
    job('annual', { pay: '연봉 36,000,000원' }),
    job('task', { pay: '건당 50,000원' }),
    job('task-alt', { pay: '건별 50,000원' }),
    job('missing'), job('unknown', { pay: '급여 협의' }),
    job('not-a-prefix', { pay: '일급제 시급 12,000원' })
  ];
  for (const type of ['hourly', 'daily', 'weekly', 'monthly', 'annual']) {
    assert.deepEqual(ids(filterJobs(jobs, filters({ payType: type }))), [type]);
  }
  assert.deepEqual(ids(filterJobs(jobs, filters({ payType: 'task' }))), ['task', 'task-alt']);
});

test('a minimum hourly wage excludes other units, ranges, negotiated values, and missing pay', () => {
  const jobs = [
    job('below', { pay: '시급 11,999원' }), job('equal', { pay: '시급 12,000원' }),
    job('above', { pay: '시급 1만 3,000원' }), job('range', { pay: '시급 12,000~15,000원' }),
    job('negotiable', { pay: '시급 협의' }), job('daily', { pay: '일급 150,000원' }),
    job('monthly', { pay: '월급 5,000,000원' }), job('missing')
  ];
  assert.deepEqual(ids(filterJobs(jobs, filters({ minHourly: 12_000 }))), ['equal', 'above']);
  assert.deepEqual(ids(filterJobs(jobs, filters({ payType: 'hourly' }))), ['below', 'equal', 'above', 'range', 'negotiable']);
  assert.equal(filterJobs(jobs, filters({ minHourly: 0 })).length, jobs.length);
  assert.equal(filterJobs(jobs, filters({ minHourly: Number.NaN })).length, jobs.length);
  assert.deepEqual(filterJobs(jobs, filters({ payType: 'daily', minHourly: 12_000 })), []);
});

test('include keywords are AND, exclude keywords are OR, with normalized comma-separated tokens', () => {
  const jobs = [
    job('match', { title: 'ＰＣ   카페 모집', company: '메가 커피' }),
    job('excluded-title', { title: 'PC 카페 야간', company: '메가 커피' }),
    job('excluded-company', { title: 'pc 카페 모집', company: '메가 커피 파견' }),
    job('missing-include', { title: '일반 카페', company: '메가 커피' }),
    job('wrong-field', { title: '카페 모집', company: '메가 커피', location: 'PC', schedule: 'PC' })
  ];
  const selected = filters({ include: ' ＰＣ， ,카페, 메가   커피, ', exclude: '야간, 파견, ,' });
  assert.deepEqual(ids(filterJobs(jobs, selected)), ['match']);
  assert.equal(filterJobs(jobs, filters({ include: ', ,', exclude: ' , ' })).length, jobs.length);
});

test('filtering preserves source order, original objects, and the original jobs array', () => {
  const jobs = Object.freeze([
    Object.freeze(job('third', { pay: '시급 13,000원' })),
    Object.freeze(job('first', { pay: '시급 14,000원' })),
    Object.freeze(job('second', { pay: '시급 12,000원' }))
  ]);
  const result = filterJobs(jobs, filters({ minHourly: 12_500 }));
  assert.deepEqual(ids(result), ['third', 'first']);
  assert.equal(result[0].job, jobs[0]);
  assert.deepEqual(jobs.map(({ id }) => id), ['third', 'first', 'second']);
});

test('compound filters require pay, every include token, days, and time to match', () => {
  const valid = { pay: '시급 13,000원', company: '동네 커피', schedule: '주말(토,일) · 09:00~13:00 · 6개월~1년' };
  const jobs = [
    job('yes', valid), job('low-pay', { ...valid, pay: '시급 11,000원' }),
    job('wrong-company', { ...valid, company: '다른 회사' }),
    job('wrong-day', { ...valid, schedule: '월~금 · 09:00~13:00 · 6개월~1년' }),
    job('wrong-time', { ...valid, schedule: '주말(토,일) · 18:00~22:00 · 6개월~1년' }),
    job('excluded', { ...valid, title: '카페 파견 직원' })
  ];
  assert.deepEqual(ids(filterJobs(jobs, filters({ payType: 'hourly', minHourly: 12_000, include: '카페,동네', exclude: '파견', days: 'weekends', time: 'morning' }))), ['yes']);
});

test('unknown schedule opt-in marks only unverifiable matches and never includes known mismatches', () => {
  const jobs = [
    job('known', { schedule: '주말(토,일) · 09:00~13:00 · 6개월~1년' }),
    job('missing'), job('partial', { schedule: '주2일 · 09:00~13:00 · 6개월~1년' }),
    job('known-wrong-day', { schedule: '월~금 · 시간협의 · 6개월~1년' }),
    job('known-wrong-time', { schedule: '주2일 · 18:00~22:00 · 6개월~1년' })
  ];
  const selected = filters({ days: 'weekends', time: 'morning' });
  assert.deepEqual(ids(filterJobs(jobs, selected)), ['known']);
  const result = filterJobs(jobs, { ...selected, includeUnknownSchedule: true });
  assert.deepEqual(result.map(({ job, unverifiedSchedule }) => [job.id, unverifiedSchedule]), [['known', false], ['missing', true], ['partial', true]]);
  assert.ok(filterJobs(jobs, filters({ includeUnknownSchedule: true })).every(({ unverifiedSchedule }) => !unverifiedSchedule));
});

test('default filters reset all choices and count unknown opt-in only with a schedule filter', () => {
  const initial = defaultJobFilters();
  assert.deepEqual(initial, { payType: 'all', minHourly: 0, days: 'all', time: 'all', include: '', exclude: '', includeUnknownSchedule: false });
  assert.equal(activeFilterCount(initial), 0);
  assert.equal(activeFilterCount(filters({ includeUnknownSchedule: true })), 0);
  assert.equal(activeFilterCount(filters({ include: ' , ', exclude: ',, ' })), 0);
  assert.equal(activeFilterCount(filters({ days: 'weekends', includeUnknownSchedule: true })), 2);
  assert.equal(activeFilterCount(filters({ payType: 'hourly', minHourly: 12_000, days: 'weekends', time: 'morning', include: '카페,커피', exclude: '파견', includeUnknownSchedule: true })), 7);
  initial.payType = 'monthly';
  assert.equal(defaultJobFilters().payType, 'all');
  assert.deepEqual(ids(filterJobs([job('missing')], defaultJobFilters())), ['missing']);
});
