import assert from 'node:assert/strict';
import { test } from 'node:test';
import { activeFilterChips, activeFilterCount, clearJobFilter, defaultJobFilters, filterJobs, updateJobFilters } from '../src/lib/filter-jobs.ts';

const filters = (overrides = {}) => ({ ...defaultJobFilters(), ...overrides });

test('chips describe the same seven filter groups as the active count', () => {
  const selected = filters({ payType: 'hourly', minHourly: 12000, days: 'weekdays', time: 'morning', include: '카페, 주말, 카페', exclude: '파견', includeUnknownSchedule: true });
  const chips = activeFilterChips(selected);
  assert.equal(chips.length, activeFilterCount(selected));
  assert.deepEqual(chips.map(({ key }) => key), ['payType', 'minHourly', 'days', 'time', 'include', 'exclude', 'includeUnknownSchedule']);
  assert.equal(chips.find(({ key }) => key === 'include').label, '포함 카페, 주말');
  assert.equal(chips.find(({ key }) => key === 'minHourly').label, '최소 시급 12,000원');
  assert.deepEqual(activeFilterChips(filters({ include: ',  ,', exclude: ' ', includeUnknownSchedule: true })), []);
});

test('clearing one filter preserves all unrelated choices and does not mutate input', () => {
  const selected = Object.freeze(filters({ payType: 'hourly', minHourly: 15000, days: 'weekends', time: 'evening', include: '카페,주말', exclude: '파견', includeUnknownSchedule: true }));
  for (const { key } of activeFilterChips(selected)) {
    const next = clearJobFilter(selected, key);
    assert.notEqual(next, selected);
    assert.deepEqual(next, { ...selected, [key]: defaultJobFilters()[key] });
  }
  assert.equal(selected.include, '카페,주말');
});

test('removing the final schedule filter also removes unknown opt-in, which does not return later', () => {
  const selected = filters({ days: 'weekends', includeUnknownSchedule: true, include: '카페' });
  const cleared = clearJobFilter(selected, 'days');
  assert.equal(cleared.includeUnknownSchedule, false);
  assert.deepEqual(activeFilterChips(cleared).map(({ key }) => key), ['include']);
  assert.equal(updateJobFilters(cleared, { time: 'evening' }).includeUnknownSchedule, false);
  assert.equal(updateJobFilters(selected, { days: 'all' }).includeUnknownSchedule, false);
  assert.equal(updateJobFilters(filters({ time: 'morning', includeUnknownSchedule: true }), { time: 'all' }).includeUnknownSchedule, false);
});

test('unknown opt-in remains while another schedule filter is active and cannot activate without one', () => {
  const selected = filters({ days: 'weekdays', time: 'morning', includeUnknownSchedule: true });
  assert.equal(clearJobFilter(selected, 'days').includeUnknownSchedule, true);
  assert.equal(clearJobFilter(selected, 'time').includeUnknownSchedule, true);
  assert.equal(updateJobFilters(defaultJobFilters(), { includeUnknownSchedule: true }).includeUnknownSchedule, false);
});

test('non-hourly pay changes clear hourly threshold while clearing pay type preserves a valid threshold', () => {
  const selected = Object.freeze(filters({ payType: 'hourly', minHourly: 15000, days: 'weekends' }));
  const monthly = updateJobFilters(selected, { payType: 'monthly' });
  assert.equal(monthly.minHourly, 0);
  assert.equal(monthly.days, 'weekends');
  assert.equal(updateJobFilters(monthly, { payType: 'all' }).minHourly, 0);
  assert.equal(clearJobFilter(selected, 'payType').minHourly, 15000);
  assert.equal(selected.minHourly, 15000);
});

test('clearing a keyword group changes only that AND/OR group and reset restores every loaded listing', () => {
  const jobs = [
    { id: 'a', title: '카페 주말', url: 'https://example.invalid/a' },
    { id: 'b', title: '카페 파견', url: 'https://example.invalid/b' },
    { id: 'c', title: '편의점 주말', url: 'https://example.invalid/c' }
  ];
  const selected = filters({ include: '카페,주말', exclude: '파견' });
  const ids = (choice) => filterJobs(jobs, choice).map(({ job }) => job.id);
  assert.deepEqual(ids(selected), ['a']);
  assert.deepEqual(ids(clearJobFilter(selected, 'include')), ['a', 'c']);
  assert.deepEqual(ids(clearJobFilter(selected, 'exclude')), ['a']);
  assert.deepEqual(ids(defaultJobFilters()), ['a', 'b', 'c']);
  assert.equal(activeFilterCount(defaultJobFilters()), 0);
});
