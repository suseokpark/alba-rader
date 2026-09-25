import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { parseClick, reportStart, trackJobClick } from '../src/lib/click-analytics.ts';
import { readClicks, saveClick } from '../src/lib/server/click-store.ts';

// Synthetic events live only in a fresh in-memory SQLite database, never the app DB.
const sample = { eventId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', source: 'albamon', url: 'https://www.albamon.com/jobs/detail/123?tracking=remove#remove', title: '검사용 공고', company: '검사용 사업장' };
const now = Date.parse('2026-09-25T14:00:00Z');
function database(t) {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(readFileSync(new URL('../drizzle/0000_equal_bushwacker.sql', import.meta.url), 'utf8'));
  t.after(() => sqlite.close());
  return { sqlite, prepare(sql) { return { sql, values: [], bind(...values) { this.values = values; return this; } }; }, async batch(statements) {
    sqlite.exec('BEGIN');
    try {
      const result = statements.map(({ sql, values }) => { const statement = sqlite.prepare(sql); return { success: true, results: /^SELECT/.test(sql) ? statement.all(...values) : (statement.run(...values), []) }; });
      sqlite.exec('COMMIT'); return result;
    } catch (error) { sqlite.exec('ROLLBACK'); throw error; }
  } };
}

test('canonical identities drop tracking and normalize UUID without changing public title', () => {
  assert.deepEqual(parseClick({ ...sample, eventId: sample.eventId.toUpperCase() }), { ...sample, jobKey: '123', url: 'https://www.albamon.com/jobs/detail/123' });
  assert.equal(parseClick({ ...sample, source: 'alba', url: 'https://www.alba.co.kr/job/Detail?adid=42&tracking=remove' }).url, 'https://www.alba.co.kr/job/Detail?adid=42');
  assert.equal(parseClick({ ...sample, source: 'daangn', url: 'https://jobs.daangn.com/job-posts/카페-abc?tracking=remove' }).jobKey, '%EC%B9%B4%ED%8E%98-abc');
});

test('reject invalid origin, credentials, listing path, source, duplicated identity and private fields', () => {
  for (const fields of [{ url: 'https://evil.example/jobs/detail/123' }, { url: 'https://secret@www.albamon.com/jobs/detail/123' }, { url: 'https://www.albamon.com/total-search?keyword=cafe' }, { url: 'http://www.albamon.com/jobs/detail/123' }, { source: 'other' }, { eventId: 'not-uuid' }, { title: '\u0000' }, { title: 'x'.repeat(501) }, { query: 'private search' }, { address: 'private address' }, { source: 'alba', url: 'https://www.alba.co.kr/job/Detail?adid=1&adid=2' }, { source: 'daangn', url: 'https://jobs.daangn.com/job-posts/a%2Fb' }]) assert.equal(parseClick({ ...sample, ...fields }), undefined, JSON.stringify(fields));
});

test('KST inclusive calendar range across UTC midnight', () => {
  assert.equal(new Date(reportStart(Date.parse('2026-09-25T15:00:00Z'), 7)).toISOString(), '2026-09-19T15:00:00.000Z');
  assert.equal(new Date(reportStart(Date.parse('2026-09-25T14:59:59Z'), 7)).toISOString(), '2026-09-18T15:00:00.000Z');
});

test('persisted events deduplicate globally but repeat clicks count; source/day filters and latest metadata', async (t) => {
  const db = database(t); const first = parseClick(sample);
  await saveClick(db, first, now - 1000);
  await saveClick(db, { ...first, title: '중복은 무시' }, now);
  await saveClick(db, { ...first, eventId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', title: '변경된 제목' }, now);
  await saveClick(db, { ...first, eventId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', source: 'alba', jobKey: '42', url: 'https://www.alba.co.kr/job/Detail?adid=42' }, now - 10 * 86400000);
  const report = await readClicks(db, 7, undefined, now);
  assert.equal(report.total, 2); assert.equal(report.jobs, 1); assert.equal(report.ranking[0].clicks, 2); assert.equal(report.ranking[0].title, '변경된 제목');
  assert.equal((await readClicks(db, 30, undefined, now)).total, 3);
  assert.equal((await readClicks(db, 30, 'alba', now)).total, 1);
  assert.equal((await readClicks(db, 7, 'daangn', now)).total, 0);
  assert.match(db.sqlite.prepare('EXPLAIN QUERY PLAN SELECT source FROM job_clicks WHERE clicked_at >= ?').all(now)[0].detail, /idx_job_clicks_clicked_at/);
});

test('rank at most 30 jobs, all jobs/totals remain accurate, old events cleaned in bounded batches', async (t) => {
  const db = database(t); const first = parseClick(sample);
  for (let i = 0; i < 35; i++) await saveClick(db, { ...first, eventId: `event-${i}`, jobKey: `${i}` }, now - i);
  const report = await readClicks(db, 7, undefined, now);
  assert.equal(report.ranking.length, 30); assert.equal(report.jobs, 35); assert.equal(report.total, 35); assert.equal(report.ranking[0].jobKey, '0');
  await saveClick(db, { ...first, eventId: 'old-event' }, now - 91 * 86400000);
  await saveClick(db, { ...first, eventId: 'new-event' }, now);
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS n FROM job_clicks WHERE event_id = ?').get('old-event').n, 0);
});

test('only primary and middle activation send; failure never cancels navigation', async (t) => {
  const sent = []; const requests = [];
  Object.defineProperty(navigator, 'sendBeacon', { configurable: true, writable: true, value: () => false });
  t.after(() => { delete navigator.sendBeacon; });
  t.mock.method(navigator, 'sendBeacon', (_url, blob) => { sent.push(blob); return true; });
  t.mock.method(globalThis, 'fetch', async (_url, options) => { requests.push(options); throw new Error('offline'); });
  const job = { id: 'unused', url: sample.url, title: sample.title, company: sample.company, location: 'NOT SENT' };
  for (const event of [{ type: 'click', button: 0 }, { type: 'auxclick', button: 1 }, { type: 'auxclick', button: 2 }, { type: 'click', button: 2 }]) trackJobClick(event, 'albamon', job);
  assert.equal(sent.length, 2); assert.equal(requests.length, 0);
  assert.deepEqual(Object.keys(JSON.parse(await sent[0].text())).sort(), ['company', 'eventId', 'source', 'title', 'url']);
  navigator.sendBeacon.mock.mockImplementation(() => false);
  assert.doesNotThrow(() => trackJobClick({ type: 'click', button: 0 }, 'albamon', job));
  assert.equal(requests.length, 1); assert.equal(requests[0].keepalive, true);
});
