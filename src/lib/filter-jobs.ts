import type { JobListing } from './search';
import { hourlyPay } from './sort-jobs.ts';
import { scheduleMatch } from './schedule-filters.ts';

export type PayType = 'all' | 'hourly' | 'daily' | 'weekly' | 'monthly' | 'annual' | 'task';
export type DayFilter = 'all' | 'weekdays' | 'weekends' | 'negotiable';
export type TimeFilter = 'all' | 'morning' | 'afternoon' | 'evening' | 'overnight' | 'negotiable';

export interface JobFilters {
  payType: PayType;
  minHourly: number;
  days: DayFilter;
  time: TimeFilter;
  include: string;
  exclude: string;
  includeUnknownSchedule: boolean;
}

export type JobFilterKey = keyof JobFilters;
export interface JobFilterChip { key: JobFilterKey; label: string }
export interface FilterResultSummary { loaded: number; visible: number; unverifiedSchedule: number }

export function defaultJobFilters(): JobFilters {
  return { payType: 'all', minHourly: 0, days: 'all', time: 'all', include: '', exclude: '', includeUnknownSchedule: false };
}

const normalize = (value: string) => value.normalize('NFKC').replace(/\s+/gu, ' ').trim().toLowerCase();
const tokens = (value: string) => [...new Set(normalize(value).split(',').map(normalize).filter(Boolean))];
const validMinimum = (value: number) => Number.isFinite(value) && value > 0;

function payType(pay?: string): Exclude<PayType, 'all'> | undefined {
  const prefix = normalize(pay || '').match(/^(시급|일급|주급|월급|연봉|건당|건별)(?=\s|\d|$)/u)?.[1];
  const labels: Record<string, Exclude<PayType, 'all'>> = {
    시급: 'hourly', 일급: 'daily', 주급: 'weekly', 월급: 'monthly', 연봉: 'annual', 건당: 'task', 건별: 'task'
  };
  return prefix ? labels[prefix] : undefined;
}

export function activeFilterCount(filters: JobFilters): number {
  return activeFilterChips(filters).length;
}

/** One removable chip per filter field; keyword groups retain their AND/OR meaning. */
export function activeFilterChips(filters: JobFilters): JobFilterChip[] {
  const chips: JobFilterChip[] = [];
  const payLabels: Record<PayType, string> = { all: '전체', hourly: '시급', daily: '일급', weekly: '주급', monthly: '월급', annual: '연봉', task: '건당' };
  const dayLabels: Record<DayFilter, string> = { all: '전체', weekdays: '평일만', weekends: '주말만', negotiable: '협의' };
  const timeLabels: Record<TimeFilter, string> = { all: '전체', morning: '오전 06–12시', afternoon: '오후 12–18시', evening: '저녁 18–24시', overnight: '새벽 00–06시', negotiable: '시간 협의' };
  if (filters.payType !== 'all') chips.push({ key: 'payType', label: `급여 ${payLabels[filters.payType]}` });
  if (validMinimum(filters.minHourly)) chips.push({ key: 'minHourly', label: `최소 시급 ${filters.minHourly.toLocaleString('ko-KR')}원` });
  if (filters.days !== 'all') chips.push({ key: 'days', label: `요일 ${dayLabels[filters.days]}` });
  if (filters.time !== 'all') chips.push({ key: 'time', label: `시작 ${timeLabels[filters.time]}` });
  for (const key of ['include', 'exclude'] as const) {
    const selected = tokens(filters[key]);
    if (selected.length) chips.push({ key, label: `${key === 'include' ? '포함' : '제외'} ${selected.join(', ')}` });
  }
  if ((filters.days !== 'all' || filters.time !== 'all') && filters.includeUnknownSchedule) {
    chips.push({ key: 'includeUnknownSchedule', label: '요일·시간 미확인 포함' });
  }
  return chips;
}

/** Normalize dependent UI choices without changing filtering semantics for existing callers. */
export function updateJobFilters(filters: JobFilters, changes: Partial<JobFilters>): JobFilters {
  const next = { ...filters, ...changes };
  if (next.payType !== 'all' && next.payType !== 'hourly') next.minHourly = 0;
  if (next.days === 'all' && next.time === 'all') next.includeUnknownSchedule = false;
  return next;
}

export function clearJobFilter(filters: JobFilters, key: JobFilterKey): JobFilters {
  return updateJobFilters(filters, { [key]: defaultJobFilters()[key] });
}

/** Filter only the already-loaded listings, without changing their source order. */
export function filterJobs(jobs: JobListing[], filters: JobFilters): Array<{ job: JobListing; unverifiedSchedule: boolean }> {
  const include = tokens(filters.include);
  const exclude = tokens(filters.exclude);
  const checkMinimum = validMinimum(filters.minHourly);
  const scheduleActive = filters.days !== 'all' || filters.time !== 'all';
  const matches: Array<{ job: JobListing; unverifiedSchedule: boolean }> = [];

  for (const job of jobs) {
    if (filters.payType !== 'all' && payType(job.pay) !== filters.payType) continue;
    if (checkMinimum) {
      const amount = hourlyPay(job.pay ? normalize(job.pay) : undefined);
      if (amount === undefined || amount < filters.minHourly) continue;
    }

    const content = normalize(`${job.title} ${job.company || ''}`);
    if (!include.every((token) => content.includes(token))) continue;
    if (exclude.some((token) => content.includes(token))) continue;

    const schedule = scheduleActive ? scheduleMatch(job.schedule, filters.days, filters.time) : 'match';
    if (schedule === 'mismatch') continue;
    if (schedule === 'unknown' && !filters.includeUnknownSchedule) continue;
    matches.push({ job, unverifiedSchedule: schedule === 'unknown' });
  }
  return matches;
}
