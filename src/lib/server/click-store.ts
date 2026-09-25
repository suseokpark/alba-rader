import { reportStart, type ClickRecord, type ClickReport, type RankedJob } from '../click-analytics.ts';
import type { SourceId } from '../search.ts';

export interface ClickDatabase {
  prepare(sql: string): { bind(...values: (string | number)[]): ReturnType<ClickDatabase['prepare']> };
  batch<T = Record<string, unknown>>(statements: ReturnType<ClickDatabase['prepare']>[]): Promise<{ results: T[]; success: boolean }[]>;
}

export async function saveClick(db: ClickDatabase, record: ClickRecord, now = Date.now()): Promise<void> {
  // Retry delivery of one event never counts twice. Repeat user activations do.
  const results = await db.batch([
    db.prepare('INSERT INTO job_clicks (event_id, clicked_at, source, job_key, url, title, company) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(event_id) DO NOTHING')
      .bind(record.eventId, now, record.source, record.jobKey, record.url, record.title, record.company),
    db.prepare('DELETE FROM job_clicks WHERE event_id IN (SELECT event_id FROM job_clicks WHERE clicked_at < ? ORDER BY clicked_at LIMIT 100)').bind(now - 90 * 86_400_000)
  ]);
  if (results.some((result) => !result.success)) throw new Error('Click write unavailable');
}

export async function readClicks(db: ClickDatabase, days: number, source?: SourceId, now = Date.now()): Promise<ClickReport> {
  const start = reportStart(now, days);
  const where = 'clicked_at >= ? AND clicked_at <= ?' + (source ? ' AND source = ?' : '');
  const values = source ? [start, now, source] : [start, now];
  const results = await db.batch<Record<string, unknown>>([
    db.prepare(`SELECT source, COUNT(*) AS clicks FROM job_clicks WHERE ${where} GROUP BY source`).bind(...values),
    db.prepare(`SELECT COUNT(*) AS jobs FROM (SELECT source, job_key FROM job_clicks WHERE ${where} GROUP BY source, job_key)`).bind(...values),
    db.prepare(`SELECT source, job_key AS jobKey, url, title, company, COUNT(*) AS clicks, MAX(clicked_at) AS lastClick FROM job_clicks WHERE ${where} GROUP BY source, job_key ORDER BY clicks DESC, lastClick DESC, source ASC, job_key ASC LIMIT 30`).bind(...values)
  ]);
  if (results.some((result) => !result.success)) throw new Error('Click report unavailable');
  const bySource: Record<SourceId, number> = { albamon: 0, daangn: 0, alba: 0 };
  for (const row of results[0].results) bySource[row.source as SourceId] = Number(row.clicks);
  return { days, from: new Date(start).toISOString(), checkedAt: new Date(now).toISOString(),
    total: Object.values(bySource).reduce((sum, count) => sum + count, 0),
    jobs: Number(results[1].results[0]?.jobs || 0), bySource,
    ranking: results[2].results.map(({ lastClick: _lastClick, ...row }) => row as unknown as RankedJob) };
}
