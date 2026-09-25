import type { JobListing, SourceId } from './search.ts';

export interface ClickRecord {
  eventId: string; source: SourceId; jobKey: string; url: string; title: string; company: string;
}
export interface RankedJob {
  source: SourceId; jobKey: string; url: string; title: string; company: string; clicks: number;
}
export interface ClickReport {
  days: number; from: string; checkedAt: string; total: number; jobs: number;
  bySource: Record<SourceId, number>; ranking: RankedJob[];
}

const origins = { albamon: 'https://www.albamon.com', daangn: 'https://jobs.daangn.com', alba: 'https://www.alba.co.kr' };
const cleanText = (value: unknown, limit: number) => typeof value === 'string'
  && value.length <= limit && !/[\u0000-\u001f\u007f]/.test(value) ? value.trim() : undefined;

/** Canonical public listing URL doubles as the cross-search identity. Never store search URLs. */
export function parseClick(value: unknown): ClickRecord | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const data = value as Record<string, unknown>;
  if (Object.keys(data).some((key) => !['eventId', 'source', 'url', 'title', 'company'].includes(key))) return;
  const { eventId, source } = data;
  if (typeof eventId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(eventId)
    || !['albamon', 'daangn', 'alba'].includes(source as string)) return;
  const title = cleanText(data.title, 500);
  const company = cleanText(data.company ?? '', 300);
  if (!title || company === undefined || typeof data.url !== 'string' || data.url.length > 2048) return;
  try {
    const id = source as SourceId;
    const url = new URL(data.url);
    if (url.origin !== origins[id] || url.username || url.password) return;
    let jobKey: string;
    if (id === 'albamon') {
      const match = /^\/jobs\/detail\/(\d+)$/.exec(url.pathname);
      if (!match) return;
      jobKey = match[1]; url.search = '';
    } else if (id === 'alba') {
      const adids = url.searchParams.getAll('adid');
      if (url.pathname.toLowerCase() !== '/job/detail' || adids.length !== 1 || !/^\d+$/.test(adids[0])) return;
      jobKey = adids[0]; url.pathname = '/job/Detail'; url.search = `?adid=${jobKey}`;
    } else {
      const match = /^\/job-posts\/([^/]+)\/?$/.exec(url.pathname);
      if (!match || /%2f|%5c/i.test(match[1])) return;
      jobKey = match[1]; url.pathname = `/job-posts/${jobKey}/`; url.search = '';
    }
    url.hash = '';
    return { eventId: eventId.toLowerCase(), source: id, jobKey, url: url.href, title, company };
  } catch { return; }
}

/** Inclusive KST calendar days, ending now. */
export function reportStart(now: number, days: number): number {
  const day = 86_400_000;
  return Math.floor((now + 9 * 3_600_000) / day) * day - 9 * 3_600_000 - (days - 1) * day;
}

/** Best effort: analytics must never block the native link or change its destination. */
export function trackJobClick(event: MouseEvent, source: SourceId, job: JobListing): void {
  if (event.type === 'auxclick' ? event.button !== 1 : event.button !== 0) return;
  try {
    const body = JSON.stringify({ eventId: crypto.randomUUID(), source, url: job.url, title: job.title, company: job.company || '' });
    // JSON beacon is same-origin. Fallback reuses the event ID, not a visitor ID.
    if (typeof navigator.sendBeacon === 'function' && navigator.sendBeacon('/api/clicks', new Blob([body], { type: 'application/json' }))) return;
    void fetch('/api/clicks', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, keepalive: true }).catch(() => {});
  } catch { /* Navigation remains available even when storage or the browser is unavailable. */ }
}
