import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { json } from '@sveltejs/kit';
import { parseAreaLevel } from '../src/lib/search-area.ts';

// Execute the complete shipped route, including its private cache. Only its
// provider and clock boundaries are synthetic; json and parseAreaLevel are real.
// No external requests, browser actions, copied cache policy, or cache inspection.
const routeUrl = new URL('../src/routes/api/search/+server.ts', import.meta.url);
const executable = ts.transpileModule(readFileSync(routeUrl, 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
}).outputText;
const seogyo = { sido: '서울', sigungu: '마포구', bname: '서교동', bcode: '1144012000', sigunguCode: '11440' };
const donggyo = { ...seogyo, bname: '동교동', bcode: '1144012100' };

function harness() {
  let now = 1_000_000;
  const calls = [];
  const provider = (source) => (query, options) => {
    let resolve;
    let reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    calls.push({ source, query, options: structuredClone(options), resolve, reject, settled: false });
    return promise;
  };
  const imports = {
    '@sveltejs/kit': { json }, '$lib/search-area': { parseAreaLevel },
    '$lib/server/providers/daangn': { searchDaangn: provider('daangn') },
    '$lib/server/providers/albamon': { searchAlbamon: provider('albamon') },
    '$lib/server/providers/alba': { searchAlba: provider('alba') }
  };
  const exports = {};
  runInNewContext(executable, {
    exports, module: { exports },
    Date: class extends Date { static now() { return now; } },
    require: (name) => { assert.ok(Object.hasOwn(imports, name), `Unexpected route dependency: ${name}`); return imports[name]; },
    fetch: () => { throw new Error('External fetch is forbidden in this cache harness.'); }
  }, { filename: routeUrl.pathname, timeout: 1000 });
  assert.equal(typeof exports.GET, 'function');
  return {
    calls,
    advance(milliseconds) { now += milliseconds; },
    request({ query = '카페', source = 'albamon', scope = 'nationwide', areaLevel, area } = {}) {
      const url = new URL('http://localhost/api/search');
      url.search = new URLSearchParams({ q: query, source, scope }).toString();
      if (areaLevel !== undefined) url.searchParams.set('areaLevel', areaLevel);
      for (const [key, value] of Object.entries(area || {})) url.searchParams.set(key, value);
      return exports.GET({ url });
    },
    complete(call, status = 'ok', marker = 'fixture') {
      if (call.settled) return;
      call.settled = true;
      call.resolve({ source: call.source, status,
        jobs: status === 'ok' ? [{ id: marker, title: `합성 ${marker}`, url: 'https://example.invalid/jobs/fixture' }] : [],
        searchUrl: `https://example.invalid/search?q=${encodeURIComponent(call.query)}`,
        checkedAt: '2026-09-25T00:00:00.000Z' });
    },
    reject(call) {
      if (call.settled) return;
      call.settled = true;
      call.reject(new Error('SYNTHETIC_PROVIDER_FAILURE'));
    }
  };
}

async function outcome(task) {
  const response = await task;
  return { status: response.status, cacheControl: response.headers.get('Cache-Control'), body: await response.json() };
}

async function displaceOriginal(h, mode) {
  if (mode === 'ttl') { h.advance(60_001); return; }
  const fillers = Array.from({ length: 100 }, (_, index) => h.request({ query: `filler-${index}` }));
  for (const call of h.calls.filter((item) => item.query.startsWith('filler-'))) h.complete(call);
  await Promise.all(fillers.map(outcome));
}

for (const displacement of ['capacity', 'ttl']) {
  for (const failure of ['unavailable', 'reject']) {
    for (const replacementState of ['pending', 'resolved']) {
      test(`${displacement}: old ${failure} cannot remove a ${replacementState} replacement for the same key`, async () => {
        const h = harness();
        const oldRequest = h.request({ query: 'target' });
        const oldCall = h.calls[0];
        await displaceOriginal(h, displacement);
        const replacementRequest = h.request({ query: 'target' });
        const replacementCall = h.calls.at(-1);
        assert.notEqual(replacementCall, oldCall);
        if (replacementState === 'resolved') {
          h.complete(replacementCall, 'ok', 'replacement-B');
          assert.equal((await outcome(replacementRequest)).body.jobs[0].id, 'replacement-B');
        }
        if (failure === 'reject') h.reject(oldCall);
        else h.complete(oldCall, 'unavailable');
        const oldResult = await outcome(oldRequest);
        assert.equal(oldResult.status, failure === 'reject' ? 502 : 200);

        const subsequentRequest = h.request({ query: 'target' });
        const targetCalls = h.calls.filter((call) => call.query === 'target');
        // Settle any extra request before asserting, so RED leaves no pending work.
        if (targetCalls.length > 2) h.complete(targetCalls.at(-1), 'ok', 'unexpected-C');
        if (replacementState === 'pending') {
          h.complete(replacementCall, 'ok', 'replacement-B');
          await outcome(replacementRequest);
        }
        const subsequentResult = await outcome(subsequentRequest);
        assert.equal(targetCalls.length, 2, 'A stale failure must not cause a third provider call after replacement B.');
        assert.equal(subsequentResult.body.jobs[0].id, 'replacement-B');
        assert.equal(subsequentResult.cacheControl, 'no-store');
      });
    }
  }
}

for (const failure of ['unavailable', 'reject']) {
  test(`a current entry's own ${failure} is removed so the next request retries immediately`, async () => {
    const h = harness();
    const first = h.request();
    if (failure === 'reject') h.reject(h.calls[0]);
    else h.complete(h.calls[0], 'unavailable');
    const failed = await outcome(first);
    assert.equal(failed.status, failure === 'reject' ? 502 : 200);
    assert.doesNotMatch(JSON.stringify(failed.body), /SYNTHETIC_PROVIDER_FAILURE/);
    const retry = h.request();
    assert.equal(h.calls.length, 2);
    h.complete(h.calls[1], 'ok', 'retry');
    assert.equal((await outcome(retry)).body.jobs[0].id, 'retry');
    assert.equal((await outcome(h.request())).body.jobs[0].id, 'retry');
    assert.equal(h.calls.length, 2);
  });
}

test('concurrent requests coalesce after query trimming and return separate equivalent JSON responses', async () => {
  const h = harness();
  const requests = [h.request({ query: ' 카페 ' }), h.request({ query: '카페' }), h.request({ query: '\t카페\n' })];
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].query, '카페');
  h.complete(h.calls[0], 'ok', 'shared');
  const results = await Promise.all(requests.map(outcome));
  assert.ok(results.every((result) => result.status === 200 && result.cacheControl === 'no-store'));
  assert.deepEqual(results[0].body, results[1].body);
  assert.deepEqual(results[1].body, results[2].body);
});

test('source, query, scope, administrative region and area level remain distinct cache keys', async () => {
  const h = harness();
  const specifications = [{}, { source: 'alba' }, { query: '카페|주말' },
    { scope: 'address', area: seogyo }, { scope: 'address', area: donggyo },
    { scope: 'address', area: seogyo, areaLevel: 'district' }];
  const pending = specifications.map((specification) => h.request(specification));
  assert.equal(h.calls.length, specifications.length);
  h.calls.forEach((call, index) => h.complete(call, 'ok', `distinct-${index}`));
  const results = await Promise.all(pending.map(outcome));
  assert.deepEqual(results.map((result) => result.body.jobs[0].id), specifications.map((_, index) => `distinct-${index}`));
  for (let index = 0; index < specifications.length; index += 1) {
    assert.equal((await outcome(h.request(specifications[index]))).body.jobs[0].id, `distinct-${index}`);
  }
  assert.equal(h.calls.length, specifications.length);
});

test('trimmed administrative values and an omitted neighborhood level coalesce with their normalized equivalent', async () => {
  const h = harness();
  const padded = Object.fromEntries(Object.entries(seogyo).map(([key, value]) => [key, ` ${value} `]));
  const first = h.request({ query: ' 카페 ', scope: 'address', area: padded });
  const second = h.request({ scope: 'address', area: seogyo, areaLevel: 'neighborhood' });
  assert.equal(h.calls.length, 1);
  assert.deepEqual(h.calls[0].options, { scope: 'address', area: seogyo, areaLevel: 'neighborhood' });
  h.complete(h.calls[0]);
  assert.deepEqual((await outcome(first)).body, (await outcome(second)).body);
});

test('resolved entries retain the existing 60000ms boundary and are replaced at 60001ms', async () => {
  const h = harness();
  const first = h.request();
  h.complete(h.calls[0], 'ok', 'before-expiry');
  await outcome(first);
  h.advance(60_000);
  assert.equal((await outcome(h.request())).body.jobs[0].id, 'before-expiry');
  assert.equal(h.calls.length, 1);
  h.advance(1);
  const expired = h.request();
  assert.equal(h.calls.length, 2);
  h.complete(h.calls[1], 'ok', 'after-expiry');
  assert.equal((await outcome(expired)).body.jobs[0].id, 'after-expiry');
});

test('the 100-key capacity preserves recent entries and evicts the oldest on the next distinct insertion', async () => {
  const h = harness();
  const initial = Array.from({ length: 100 }, (_, index) => h.request({ query: `key-${index}` }));
  h.calls.forEach((call, index) => h.complete(call, 'ok', `entry-${index}`));
  await Promise.all(initial.map(outcome));
  assert.equal((await outcome(h.request({ query: 'key-0' }))).body.jobs[0].id, 'entry-0');
  assert.equal((await outcome(h.request({ query: 'key-99' }))).body.jobs[0].id, 'entry-99');
  assert.equal(h.calls.length, 100);
  const insertion = h.request({ query: 'key-100' });
  h.complete(h.calls.at(-1), 'ok', 'new-entry');
  await outcome(insertion);
  assert.equal((await outcome(h.request({ query: 'key-99' }))).body.jobs[0].id, 'entry-99');
  const oldestAgain = h.request({ query: 'key-0' });
  assert.equal(h.calls.length, 102);
  h.complete(h.calls.at(-1), 'ok', 'oldest-refetched');
  assert.equal((await outcome(oldestAgain)).body.jobs[0].id, 'oldest-refetched');
});

test('an explicitly empty provider result is cached rather than treated as an unavailable failure', async () => {
  const h = harness();
  const first = h.request();
  h.complete(h.calls[0], 'empty');
  const initial = await outcome(first);
  assert.equal(initial.body.status, 'empty');
  assert.deepEqual(initial.body.jobs, []);
  const second = await outcome(h.request());
  assert.deepEqual(second.body, initial.body);
  assert.equal(second.cacheControl, 'no-store');
  assert.equal(h.calls.length, 1);
});
