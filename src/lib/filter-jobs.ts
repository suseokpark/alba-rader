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
  const scheduleActive = filters.days !== 'all' || filters.time !== 'all';
  return [
    filters.payType !== 'all', validMinimum(filters.minHourly),
    filters.days !== 'all', filters.time !== 'all',
    tokens(filters.include).length > 0, tokens(filters.exclude).length > 0,
    scheduleActive && filters.includeUnknownSchedule
  ].filter(Boolean).length;
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
