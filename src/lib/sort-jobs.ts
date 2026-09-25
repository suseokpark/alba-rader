import type { JobListing } from './search';

export type SortOrder = 'source' | 'hourly-desc';

// Compare only explicit hourly KRW amounts; never divide daily/monthly wages.
export function hourlyPay(pay?: string): number | undefined {
  // Keep filtering and sorting consistent for equivalent displayed pay strings.
  const normalized = pay?.normalize('NFKC').replace(/\s+/gu, ' ').trim();
  const match = normalized?.replaceAll(',', '').match(/^시급\s*(?:(\d+)만\s*)?(\d+)?\s*원?$/);
  if (!match || (!match[1] && !match[2])) return undefined;
  const amount = Number(match[1] || 0) * 10_000 + Number(match[2] || 0);
  return amount > 0 && Number.isFinite(amount) ? amount : undefined;
}

export function sortJobs(jobs: JobListing[], order: SortOrder): JobListing[] {
  if (order === 'source') return jobs;
  return jobs.map((job, index) => ({ job, index, value: hourlyPay(job.pay) }))
    .sort((a, b) => (b.value ?? -1) - (a.value ?? -1) || a.index - b.index)
    .map(({ job }) => job);
}
