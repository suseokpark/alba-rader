import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as daangnMulti from '../src/lib/daangn-multi.ts';
import {
  MAX_DAANGN_AREAS, toSearchArea, neighborhoodKey, addDaangnArea,
  aggregateDaangnResults, searchDaangnAreas, retryFailedDaangnAreas
} from '../src/lib/daangn-multi.ts';

const seogyo = { sido: '서울', sigungu: '마포구', bname: '서교동', bcode: '1144012000', sigunguCode: '11440' };
const areas = ['서교동', '합정동', '망원동', '연남동', '상수동', '성산동'].map((bname, index) => ({
  ...seogyo, bname, bcode: `11440${String(index + 1).padStart(5, '0')}`
}));
const job = (id, slug = id) => ({ id, title: `공고 ${id}`, url: `https://jobs.daangn.com/job-posts/${slug}` });
const result = (status = 'ok', jobs = [job('a')], regionId = 230, message) => ({
  source: 'daangn', status, jobs, checkedAt: '2026-09-23T08:00:00.000Z',
  searchUrl: `https://jobs.daangn.com/s?query=${encodeURIComponent('카페')}&regionId=${regionId}`,
  ...(message && { message })
});
const entry = (index, value) => ({ area: areas[index], result: value });
const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const tick = () => new Promise((resolve) => setImmediate(resolve));

test('initial progress exposes copied immutable completed responses in selected order before the batch finishes', async () => {
  const pending = [], progress = [];
  const controller = new AbortController();
  const raw = { ...result('ok', [{ ...job('second'), privateField: 'PRIVATE' }]), privateField: 'PRIVATE' };
  const promise = searchDaangnAreas('카페', areas.slice(0, 3), {
    signal: controller.signal,
    onProgress: value => progress.push(value),
    fetcher: () => { const item = deferred(); pending.push(item); return item.promise; }
  });
  // Avoid an unhandled rejection if an assertion fails before the queue completes.
  promise.catch(() => {});
  try {
    pending[1].resolve({ ok: true, json: async () => raw });
    await tick();
    assert.equal(progress.length, 1);
    assert.equal(progress[0].total, 3);
    assert.deepEqual(progress[0].entries.map(row => row.area), [areas[1]]);
    assert.notEqual(progress[0].entries[0].result.jobs[0], raw.jobs[0]);
    assert.doesNotMatch(JSON.stringify(progress[0]), /PRIVATE/);
    const firstSnapshot = structuredClone(progress[0]);
    for (const object of [progress[0], progress[0].entries, progress[0].entries[0],
      progress[0].entries[0].area, progress[0].entries[0].result,
      progress[0].entries[0].result.jobs, progress[0].entries[0].result.jobs[0]]) assert.ok(Object.isFrozen(object));
    assert.throws(() => { progress[0].entries[0].result.jobs[0].title = 'observer mutation'; }, TypeError);
    pending[0].resolve(Response.json(result('ok', [job('first')])));
    await tick();
    assert.deepEqual(progress[1].entries.map(row => row.area), areas.slice(0, 2));
    assert.deepEqual(progress[0], firstSnapshot);
    pending[2].resolve(Response.json(result('empty', [])));
    const value = await promise;
    assert.deepEqual(progress[2].entries.map(row => row.area), areas.slice(0, 3));
    assert.deepEqual(value.jobs.map(row => row.id), ['first', 'second']);
    assert.equal(value.interruption, undefined);
  } finally { controller.abort(); }
});

test('interruption finalization preserves only completed raw responses and their actual timestamps', () => {
  const completed = [entry(0, result('ok', [job('same')], 230)), entry(2, {
    ...result('ok', [job('alias', 'same'), job('third')], 232), checkedAt: '2026-09-24T01:00:00.000Z'
  })];
  const progress = { total: 4, entries: completed };
  const before = structuredClone(progress);
  const value = daangnMulti.finalizeInterruptedDaangn('카페', areas.slice(0, 4), progress, 'cancelled');
  assert.equal(value.status, 'ok');
  assert.equal(value.partial, false, 'Pending regions are not service failures.');
  assert.deepEqual(value.jobs.map(row => row.id), ['same', 'third']);
  assert.equal(value.duplicateCount, 1);
  assert.deepEqual(value.regionEntries, completed);
  assert.deepEqual(value.regionResults.map(row => row.checkedAt), completed.map(row => row.result.checkedAt));
  assert.equal(value.checkedAt, completed[1].result.checkedAt);
  assert.deepEqual(value.interruption, { reason: 'cancelled', remainingAreas: [areas[1], areas[3]] });
  assert.deepEqual(Object.keys(value.interruption.remainingAreas[0]).sort(), Object.keys(areas[1]).sort());
  assert.match(value.regionNote, /2\/4/);
  assert.deepEqual(progress, before);
});

test('interruption rejects mismatched, duplicated, reordered or malformed completed subsets', () => {
  const selected = areas.slice(0, 3);
  const good = { total: 3, entries: [entry(0, result()), entry(2, result('empty', [], 232))] };
  const invalid = [null, [], {}, { ...good, total: '3' }, { ...good, total: 2 },
    { ...good, entries: null }, { ...good, entries: new Array(1) },
    { ...good, entries: [good.entries[0], good.entries[0]] },
    { ...good, entries: [...good.entries].reverse() },
    { ...good, entries: [entry(3, result())] },
    { ...good, entries: [{ ...good.entries[0], area: { ...areas[0], bcode: '1144099999' } }] },
    { ...good, entries: [{ ...good.entries[0], area: { ...areas[0], sido: '서울특별시' } }] },
    { ...good, entries: [entry(0, { ...result(), source: 'albamon' })] },
    { ...good, entries: [entry(0, { ...result(), checkedAt: 'not-a-date' })] },
    { ...good, entries: [entry(0, { ...result(), searchUrl: 'https://jobs.daangn.com/s?query=다름' })] },
    { ...good, entries: [entry(0, result('empty', [job('wrong')]))] },
    { ...good, entries: [entry(0, result('ok', [{ ...job('unsafe'), url: 'https://other.test/job' }]))] }
  ];
  for (const progress of invalid) assert.throws(() => daangnMulti.finalizeInterruptedDaangn('카페', selected, progress, 'timeout'), TypeError);
  assert.throws(() => daangnMulti.finalizeInterruptedDaangn('다름', selected, good, 'timeout'), TypeError);
  assert.throws(() => daangnMulti.finalizeInterruptedDaangn('카페', selected, good, 'network'), TypeError);
  assert.throws(() => daangnMulti.finalizeInterruptedDaangn('카페', [], good, 'timeout'), RangeError);
  assert.throws(() => daangnMulti.finalizeInterruptedDaangn('카페', areas, good, 'timeout'), RangeError);
  assert.throws(() => daangnMulti.finalizeInterruptedDaangn('bad\u0000query', selected, good, 'timeout'), RangeError);
});

test('zero completions stay absent, while completed empty and actual failure responses retain their distinct status', () => {
  const selected = areas.slice(0, 3);
  assert.equal(daangnMulti.finalizeInterruptedDaangn('카페', selected, undefined, 'cancelled'), undefined);
  assert.equal(daangnMulti.finalizeInterruptedDaangn('카페', selected, { total: 3, entries: [] }, 'timeout'), undefined);
  for (const status of ['empty', 'unavailable']) {
    const completed = entry(1, result(status, [], 231));
    const value = daangnMulti.finalizeInterruptedDaangn('카페', selected, { total: 3, entries: [completed] }, 'timeout');
    assert.equal(value.status, status);
    assert.equal(value.partial, false);
    assert.deepEqual(value.regionEntries, [completed]);
    assert.deepEqual(value.interruption, { reason: 'timeout', remainingAreas: [areas[0], areas[2]] });
    assert.equal(value.checkedAt, completed.result.checkedAt);
    assert.doesNotMatch(value.message, /모든 동네/);
  }
  const mixed = daangnMulti.finalizeInterruptedDaangn('카페', selected, {
    total: 3, entries: [entry(0, result('unavailable', [])), entry(2, result('empty', []))]
  }, 'timeout');
  assert.equal(mixed.status, 'empty');
  assert.equal(mixed.partial, true, 'Only a real completed failure contributes to partial status.');
  assert.equal(mixed.regionResults.filter(row => row.status === 'unavailable').length, 1);
  assert.deepEqual(mixed.interruption.remainingAreas, [areas[1]]);
});

test('complete snapshots at the interruption boundary remain ordinary success, partial failure or empty results', () => {
  const selected = areas.slice(0, 2);
  for (const reason of ['cancelled', 'timeout']) {
    for (const statuses of [['ok', 'ok'], ['ok', 'unavailable'], ['empty', 'empty'], ['unavailable', 'unavailable']]) {
      const progress = { total: 2, entries: selected.map((area, index) => ({ area, result: {
        ...result(statuses[index], statuses[index] === 'ok' ? [job(String(index))] : []),
        checkedAt: index === 0 ? '2026-09-24T01:00:00.000Z' : '2026-09-24T02:00:00.000Z'
      } })) };
      const value = daangnMulti.finalizeInterruptedDaangn(' 카페 ', selected, progress, reason);
      const expected = aggregateDaangnResults('카페', progress.entries);
      expected.checkedAt = progress.entries[1].result.checkedAt;
      assert.equal(value.interruption, undefined);
      assert.deepEqual(value, expected, 'A fully completed batch keeps normal status, region note and retry metadata.');
      assert.doesNotMatch(value.message ?? '', /중단/);
    }
  }
});

test('abort inside the initial progress observer stops queued work and suppresses late body completions', async () => {
  const controller = new AbortController(), pending = [], updates = [];
  const promise = searchDaangnAreas('카페', areas.slice(0, 4), {
    signal: controller.signal,
    onProgress: progress => { updates.push(progress); controller.abort(); },
    fetcher: async () => { const item = deferred(); pending.push(item); return { ok: true, json: () => item.promise }; }
  });
  const rejection = assert.rejects(promise, { name: 'AbortError' });
  await tick();
  pending[0].resolve(result());
  await rejection;
  pending[1].resolve(result('empty', []));
  await tick();
  assert.equal(updates.length, 1);
  assert.equal(pending.length, 2);
  assert.deepEqual(updates[0].entries.map(row => row.area), [areas[0]]);
});

test('a synchronous observer error cannot discard valid responses or stop other neighborhoods', async () => {
  let requested = 0, observed = 0;
  const value = await searchDaangnAreas('카페', areas.slice(0, 3), {
    fetcher: async () => Response.json(result('ok', [job(String(requested++))])),
    onProgress: () => { observed++; throw new Error('local observer failed'); }
  });
  assert.equal(requested, 3);
  assert.equal(observed, 3);
  assert.equal(value.regionEntries.length, 3);
  assert.equal(value.jobs.length, 3);
});

test('administrative area conversion normalizes and strips all street-address information', () => {
  const input = { ...seogyo, sido: ' 서울 ', sigungu: ' 마포구 ', address: '민감한 도로명 상세주소', roadAddress: '도로명', zonecode: '12345' };
  assert.deepEqual(toSearchArea(input), seogyo);
  assert.notEqual(toSearchArea(input), input);
  for (const invalid of [null, [], {}, { ...seogyo, bcode: 1144012000 }, { ...seogyo, bname: '' },
    { ...seogyo, bcode: '1234512345' }, { ...seogyo, sigunguCode: '1144' }]) assert.equal(toSearchArea(invalid), undefined);
});

test('same eup/myeon with different ri codes is one neighborhood, aliases and whitespace normalize', () => {
  const first = { ...seogyo, sido: '제주특별자치도', sigungu: '제주시', bname: '애월읍', bcode: '5011025301', sigunguCode: '50110' };
  const otherRi = { ...first, sido: '제주', bcode: '5011025302' };
  assert.equal(neighborhoodKey(first), neighborhoodKey(otherRi));
  assert.equal(neighborhoodKey(seogyo), neighborhoodKey({ ...seogyo, sido: ' 서울특별시 ' }));
  assert.notEqual(neighborhoodKey(seogyo), neighborhoodKey({ ...seogyo, sigungu: '서대문구' }));
  assert.notEqual(neighborhoodKey(seogyo), neighborhoodKey({ ...seogyo, sido: '부산' }));
  assert.equal(addDaangnArea([first], otherRi).reason, 'duplicate');
});

test('area additions are immutable, capped at five and check duplicates before limit', () => {
  assert.equal(MAX_DAANGN_AREAS, 5);
  const input = Object.freeze(areas.slice(0, 5));
  assert.equal(addDaangnArea(input, areas[0]).reason, 'duplicate');
  assert.equal(addDaangnArea(input, areas[5]).reason, 'limit');
  assert.equal(input.length, 5);
  const added = addDaangnArea([areas[0]], areas[1]);
  assert.equal(added.reason, undefined);
  assert.deepEqual(added.areas, areas.slice(0, 2));
  assert.throws(() => addDaangnArea([], {}), TypeError);
});

test('aggregation deduplicates either ID or canonical URL, preserving selection and listing order', () => {
  const a = Object.freeze(job('a'));
  const b = Object.freeze(job('b'));
  const c = Object.freeze(job('c'));
  const rows = [entry(0, result('ok', [a, b])), entry(1, result('ok', [job('a', 'alternate-a'),
    job('different-id', 'b?tracking=1#fragment'), c, job('last-id', 'alternate-a')], 231))];
  const combined = aggregateDaangnResults(' 카페 ', rows);
  assert.equal(combined.status, 'ok');
  assert.deepEqual(combined.jobs, [a, b, c]);
  assert.equal(combined.jobs[0], a);
  assert.equal(combined.duplicateCount, 3);
  assert.equal(combined.partial, false);
  assert.deepEqual(combined.regionResults.map((row) => row.jobsCount), [2, 4]);
  assert.deepEqual(combined.regionResults.map((row) => row.area.bname), ['서교동', '합정동']);
  assert.equal(combined.searchUrl, rows[0].result.searchUrl);
  assert.match(combined.regionNote, /선택 동네.*주변.*전체 검색 아님.*최대 20건/);
  assert.equal(rows[1].result.jobs.length, 4);
});

test('aggregation retains empty, partial failures, all failures and original region errors', () => {
  const empty = result('empty', []);
  const failed = result('unavailable', [], 231, '해당 동네 연결 실패');
  let value = aggregateDaangnResults('카페', [entry(0, empty), entry(1, empty)]);
  assert.equal(value.status, 'empty');
  assert.equal(value.partial, false);
  value = aggregateDaangnResults('카페', [entry(0, empty), entry(1, failed)]);
  assert.equal(value.status, 'empty');
  assert.equal(value.partial, true);
  assert.match(value.message, /1개 동네는 조회하지 못/);
  assert.equal(value.regionResults[1].message, '해당 동네 연결 실패');
  value = aggregateDaangnResults('카페', [entry(0, result()), entry(1, failed)]);
  assert.equal(value.status, 'ok');
  assert.equal(value.partial, true);
  assert.equal(value.jobs.length, 1);
  value = aggregateDaangnResults('카페', [entry(0, failed), entry(1, failed)]);
  assert.equal(value.status, 'unavailable');
  assert.equal(value.partial, false);
  assert.equal(value.jobs.length, 0);
});

test('aggregation retains validated pre-deduplication region entries and their original timestamps', () => {
  const first = result('ok', [job('a')]);
  const second = { ...result('ok', [job('alias', 'a')], 231), checkedAt: '2026-09-24T09:10:00.000Z' };
  const value = aggregateDaangnResults('카페', [entry(0, first), entry(1, second)]);
  assert.deepEqual(value.regionEntries, [entry(0, first), entry(1, second)]);
  assert.deepEqual(value.regionResults.map((row) => row.checkedAt), [first.checkedAt, second.checkedAt]);
  assert.equal(value.regionEntries[1].result.jobs[0].id, 'alias');
  assert.equal(value.jobs.length, 1);
});

test('failed-only retry preserves successful and empty raw results and their timestamps', async () => {
  const previous = aggregateDaangnResults('카페', [entry(0, result()), entry(1, result('empty', [])), entry(2, result('unavailable', []))]);
  const before = structuredClone(previous);
  const requested = [];
  const recovered = { ...result('ok', [job('recovered')], 232), checkedAt: '2026-09-25T01:02:03.000Z' };
  const value = await retryFailedDaangnAreas('카페', areas.slice(0, 3), previous, { fetcher: async (url) => {
    const params = new URL(url, 'http://localhost').searchParams;
    requested.push(params.get('bname'));
    assert.equal(params.get('q'), '카페');
    assert.equal(params.get('source'), 'daangn');
    assert.equal(params.get('areaLevel'), 'neighborhood');
    return Response.json(recovered);
  } });
  assert.deepEqual(requested, ['망원동']);
  assert.deepEqual(previous, before);
  assert.deepEqual(value.regionEntries.slice(0, 2), previous.regionEntries.slice(0, 2));
  assert.deepEqual(value.regionResults.map((row) => row.checkedAt), [result().checkedAt, result().checkedAt, recovered.checkedAt]);
  assert.deepEqual(value.jobs.map((item) => item.id), ['a', 'recovered']);
  assert.equal(value.partial, false);
});

test('failed-only retry rejects absent, malformed or differently submitted raw regions before any request', async () => {
  const previous = aggregateDaangnResults('카페', [entry(0, result()), entry(1, result('unavailable', []))]);
  let requests = 0;
  const fetcher = async () => { requests++; return Response.json(result()); };
  const cases = [
    ['다른검색어', areas.slice(0, 2), previous],
    ['카페', [areas[1], areas[0]], previous],
    ['카페', [areas[0], { ...areas[1], bcode: '1144099999' }], previous],
    ['카페', areas.slice(0, 1), previous],
    ['카페', areas.slice(0, 2), { ...previous, source: 'alba' }],
    ['카페', areas.slice(0, 2), { ...previous, regionEntries: undefined }],
    ['카페', areas.slice(0, 2), { ...previous, regionEntries: [] }],
    ['카페', areas.slice(0, 2), { ...previous, regionEntries: [null, previous.regionEntries[1]] }],
    ['카페', areas.slice(0, 2), { ...previous, regionEntries: [previous.regionEntries[0], previous.regionEntries[0]] }],
    ['카페', areas.slice(0, 2), { ...previous, regionEntries: [entry(0, { ...result(), checkedAt: 'bad' }), previous.regionEntries[1]] }],
    ['카페', areas.slice(0, 2), { ...previous, regionEntries: [entry(0, { ...result(), jobs: [{ ...job('a'), url: 'javascript:bad' }] }), previous.regionEntries[1]] }]
  ];
  for (const [query, selected, value] of cases) await assert.rejects(retryFailedDaangnAreas(query, selected, value, { fetcher }), TypeError);
  assert.equal(requests, 0);
});

test('failed-only retry recomputes transitive ID and URL duplicates from retained raw entries', async () => {
  const previous = aggregateDaangnResults('카페', [
    entry(0, result('ok', [job('one', 'shared')])),
    entry(1, result('ok', [job('alias', 'shared'), job('two', 'second')], 231)),
    entry(2, result('unavailable', [], 232))
  ]);
  assert.equal(previous.jobs.length, 2);
  assert.equal(previous.duplicateCount, 1);
  const value = await retryFailedDaangnAreas('카페', areas.slice(0, 3), previous, {
    fetcher: async () => Response.json(result('ok', [job('alias', 'third-url')], 232))
  });
  assert.deepEqual(value.jobs.map((job) => job.id), ['one', 'two']);
  assert.equal(value.duplicateCount, 2, 'An alias discarded from the visible list must still participate in deduplication.');
  assert.deepEqual(value.regionResults.map((row) => row.jobsCount), [1, 2, 1]);
  assert.equal(value.regionEntries[1].result.jobs[0].id, 'alias');
  assert.equal(previous.duplicateCount, 1);
});

test('failed-only retry requests at most two regions and restores original selection order after out-of-order recovery', async () => {
  const previous = aggregateDaangnResults('카페', areas.slice(0, 5).map((area, index) => ({
    area, result: index === 1 ? result('ok', [job('kept', 'overlap')], 231) : result('unavailable', [], 230 + index)
  })));
  const before = structuredClone(previous);
  const requested = [], pending = new Map();
  let active = 0, maxActive = 0;
  const promise = retryFailedDaangnAreas('카페', areas.slice(0, 5), previous, { fetcher: (url) => {
    const params = new URL(url, 'http://localhost').searchParams;
    const index = areas.findIndex((area) => area.bname === params.get('bname'));
    assert.deepEqual([...params.keys()].sort(), ['q', 'source', 'scope', 'areaLevel', 'sido', 'sigungu', 'bname', 'bcode', 'sigunguCode'].sort());
    requested.push(index); active++; maxActive = Math.max(maxActive, active);
    const response = deferred(); pending.set(index, response);
    return response.promise.finally(() => active--);
  } });
  assert.deepEqual(requested, [0, 2]);
  for (const index of [2, 3, 4, 0]) {
    const jobs = index === 0 ? [job('recovered-first', 'overlap')] : [job(`recovered-${index}`)];
    pending.get(index).resolve(Response.json(result('ok', jobs, 230 + index)));
    await tick();
  }
  const value = await promise;
  assert.equal(maxActive, 2);
  assert.deepEqual(requested, [0, 2, 3, 4]);
  assert.deepEqual(value.regionEntries.map((entry) => entry.area), areas.slice(0, 5));
  assert.deepEqual(value.jobs.map((job) => job.id), ['recovered-first', 'recovered-2', 'recovered-3', 'recovered-4']);
  assert.equal(value.duplicateCount, 1);
  assert.deepEqual(previous, before);
  assert.deepEqual(value.regionEntries[1], previous.regionEntries[1], 'Previously successful raw data remains intact even if its displayed duplicate loses precedence.');
});

test('failed-only retry retains a new failure, can recover to empty, and makes no request when all regions succeeded', async () => {
  const previous = aggregateDaangnResults('카페', [entry(0, result('empty', [])), entry(1, result('unavailable', [], 231))]);
  const failed = await retryFailedDaangnAreas('카페', areas.slice(0, 2), previous, {
    fetcher: async () => new Response('still unavailable', { status: 503 })
  });
  assert.equal(failed.status, 'empty');
  assert.equal(failed.partial, true);
  assert.match(failed.regionResults[1].message, /503/);
  assert.deepEqual(failed.regionEntries[0], previous.regionEntries[0]);
  const recovered = await retryFailedDaangnAreas('카페', areas.slice(0, 2), failed, {
    fetcher: async () => Response.json(result('empty', [], 231))
  });
  assert.equal(recovered.status, 'empty');
  assert.equal(recovered.partial, false);
  assert.equal(await retryFailedDaangnAreas('카페', areas.slice(0, 2), recovered, {
    fetcher: () => { throw new Error('A complete result must not request regions again.'); }
  }), recovered);
});

test('aborting failed-only retry preserves the prior aggregate, stops queued regions and discards late results', async () => {
  const previous = aggregateDaangnResults('카페', areas.slice(0, 5).map((area, index) => ({
    area, result: index === 0 ? result('ok', [job('kept')]) : result('unavailable', [], 230 + index)
  })));
  const before = structuredClone(previous);
  for (const phase of ['pre-aborted', 'transport', 'body']) {
    const controller = new AbortController();
    const pending = []; let requested = 0;
    if (phase === 'pre-aborted') controller.abort();
    const promise = retryFailedDaangnAreas('카페', areas.slice(0, 5), previous, {
      signal: controller.signal, fetcher: (_url, init) => {
        assert.equal(init.signal, controller.signal);
        requested++;
        const item = deferred(); pending.push(item);
        return phase === 'body' ? Promise.resolve({ ok: true, json: () => item.promise }) : item.promise;
      }
    });
    const rejection = assert.rejects(promise, { name: 'AbortError' });
    await tick(); controller.abort(); await rejection;
    for (const item of pending) item.resolve(phase === 'body' ? result() : Response.json(result()));
    await tick();
    assert.equal(requested, phase === 'pre-aborted' ? 0 : 2);
    assert.deepEqual(previous, before);
  }
});

test('invalid responses are unavailable, not empty, including unsafe URLs and a wrong query', () => {
  for (const invalid of [null, {}, { ...result(), source: 'alba' }, result('ok', []), result('empty', [job('a')]),
    { ...result('empty', []), status: ['empty'] },
    { ...result(), searchUrl: 'https://jobs.daangn.com/s?query=다른검색어' },
    { ...result(), jobs: [{ ...job('a'), url: 'javascript:alert(1)' }] },
    { ...result(), checkedAt: 'invalid' }]) {
    const value = aggregateDaangnResults('카페', [entry(0, invalid)]);
    assert.equal(value.status, 'unavailable');
    assert.deepEqual(value.jobs, []);
    assert.match(value.regionResults[0].message, /응답 형식/);
  }
});

test('empty, malformed and over-limit inputs reject before networking; duplicate neighborhoods are queried once', async () => {
  let count = 0;
  const fetcher = async () => { count++; return Response.json(result()); };
  for (const invalid of [[], null, [{}], areas]) {
    await assert.rejects(searchDaangnAreas('카페', invalid, { fetcher }));
    assert.throws(() => aggregateDaangnResults('카페', invalid?.map((area) => ({ area, result: result() }))));
  }
  for (const query of ['', '  ', 'a'.repeat(81), 'bad\u0000query']) await assert.rejects(searchDaangnAreas(query, [seogyo], { fetcher }));
  assert.equal(count, 0);
  const value = await searchDaangnAreas('카페', [seogyo, { ...seogyo, bcode: '1144012999' }], { fetcher });
  assert.equal(count, 1);
  assert.equal(value.regionResults.length, 1);
});

test('fetch requests only administrative fields and preserve selected order despite out-of-order completion', async () => {
  const pending = new Map();
  const requests = [];
  let active = 0;
  let maxActive = 0;
  const fetcher = (input, init) => {
    const url = new URL(input, 'http://127.0.0.1:5173');
    const index = areas.findIndex((area) => area.bname === url.searchParams.get('bname'));
    assert.equal(url.pathname, '/api/search');
    assert.equal(url.searchParams.get('source'), 'daangn');
    assert.equal(url.searchParams.get('scope'), 'address');
    assert.equal(url.searchParams.get('areaLevel'), 'neighborhood');
    assert.equal(url.searchParams.get('q'), '카페');
    assert.deepEqual([...url.searchParams.keys()].sort(), ['q', 'source', 'scope', 'areaLevel', 'sido', 'sigungu', 'bname', 'bcode', 'sigunguCode'].sort());
    requests.push(index);
    active++;
    maxActive = Math.max(active, maxActive);
    const item = deferred();
    pending.set(index, item);
    return item.promise.finally(() => active--);
  };
  const valuePromise = searchDaangnAreas(' 카페 ', areas.slice(0, 5).map((area) => ({ ...area, address: 'PRIVATE STREET', zonecode: '12345' })), { fetcher });
  assert.deepEqual(requests, [0, 1]);
  for (const index of [1, 2, 3, 4, 0]) {
    pending.get(index).resolve(Response.json(result('ok', [job(String(index))], 230 + index)));
    await tick();
  }
  const value = await valuePromise;
  assert.equal(maxActive, 2);
  assert.deepEqual(requests, [0, 1, 2, 3, 4]);
  assert.deepEqual(value.jobs.map((job) => job.id), ['0', '1', '2', '3', '4']);
  assert.deepEqual(value.regionResults.map((row) => row.area.bname), areas.slice(0, 5).map((area) => area.bname));
  assert.ok(value.regionResults.every((row) => !('address' in row.area) && !('zonecode' in row.area)));
});

test('HTTP, JSON and network failures stay attached to each region without stopping successful regions', async () => {
  let count = 0;
  const fetcher = async () => {
    const index = count++;
    if (index === 0) return Response.json(result());
    if (index === 1) return new Response('failure', { status: 503 });
    if (index === 2) return new Response('not json');
    if (index === 3) throw new Error('network');
    return Response.json(result('empty', []));
  };
  const value = await searchDaangnAreas('카페', areas.slice(0, 5), { fetcher });
  assert.equal(value.status, 'ok');
  assert.equal(value.partial, true);
  assert.deepEqual(value.regionResults.map((row) => row.status), ['ok', 'unavailable', 'unavailable', 'unavailable', 'empty']);
  assert.match(value.regionResults[1].message, /HTTP 503/);
  assert.ok(value.regionResults.slice(1, 4).every((row) => row.jobsCount === 0));
});

test('already aborted requests make no fetches', async () => {
  const controller = new AbortController();
  controller.abort();
  let count = 0;
  await assert.rejects(searchDaangnAreas('카페', areas, { signal: controller.signal, fetcher: async () => { count++; } }), { name: 'AbortError' });
  assert.equal(count, 0);
});

test('cancellation rejects immediately even if fetch ignores the signal and stops the remaining queue', async () => {
  const controller = new AbortController();
  const pending = [];
  const fetcher = (_url, init) => {
    assert.equal(init.signal, controller.signal);
    const item = deferred();
    pending.push(item);
    return item.promise;
  };
  const promise = searchDaangnAreas('카페', areas.slice(0, 5), { signal: controller.signal, fetcher });
  const rejection = assert.rejects(promise, { name: 'AbortError' });
  assert.equal(pending.length, 2);
  controller.abort();
  await rejection;
  for (const item of pending) item.resolve(Response.json(result()));
  await tick();
  assert.equal(pending.length, 2);
});

test('cancellation while response JSON is pending also stops later regions', async () => {
  const controller = new AbortController();
  const body = deferred();
  let count = 0;
  const promise = searchDaangnAreas('카페', areas.slice(0, 5), {
    signal: controller.signal,
    fetcher: async () => { count++; return { ok: true, json: () => body.promise }; }
  });
  const rejection = assert.rejects(promise, { name: 'AbortError' });
  await tick();
  controller.abort();
  await rejection;
  body.resolve(result());
  await tick();
  assert.equal(count, 2);
});

test('a synchronous abort inside fetch propagates rather than becoming a partial failure', async () => {
  const controller = new AbortController();
  let count = 0;
  await assert.rejects(searchDaangnAreas('카페', areas.slice(0, 3), {
    signal: controller.signal,
    fetcher: () => { count++; controller.abort(); return Promise.reject(controller.signal.reason); }
  }), { name: 'AbortError' });
  assert.equal(count, 1);
});
