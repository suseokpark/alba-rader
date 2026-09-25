import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { test } from 'node:test';
import {
  createSearchSnapshot, searchFingerprint, requestSearchSource, SearchRequestError,
  SINGLE_SOURCE_TIMEOUT_MS, MULTI_SOURCE_TIMEOUT_MS
} from '../src/lib/search-request.ts';
import { aggregateDaangnResults, finalizeInterruptedDaangn } from '../src/lib/daangn-multi.ts';

const seoul = { sido: '서울', sigungu: '마포구', bname: '서교동', bcode: '1144012000', sigunguCode: '11440' };
const donggyo = { ...seoul, bname: '동교동', bcode: '1144012100' };
const suwon = { sido: '경기', sigungu: '수원시 영통구', bname: '이의동', bcode: '4111710300', sigunguCode: '41117' };
const suwonPaldal = { sido: '경기', sigungu: '수원시 팔달구', bname: '인계동', bcode: '4111514100', sigunguCode: '41115' };
const seongnam = { sido: '경기', sigungu: '성남시 분당구', bname: '정자동', bcode: '4113510300', sigunguCode: '41135' };
const draft = (overrides = {}) => ({ query: '카페', selected: ['albamon', 'daangn', 'alba'], scope: 'address',
  address: { ...seoul }, areaLevel: 'neighborhood', daangnMultiEnabled: false, daangnAreas: [], ...overrides });
const snapshot = (overrides = {}) => {
  const value = createSearchSnapshot(draft(overrides));
  assert.equal(value.ok, true, value.message);
  return value.snapshot;
};
const fixture = (source = 'albamon', status = 'ok', query = '카페', id = '123') => ({
  source, status, jobs: status === 'ok' ? [{ id, title: '합성 검사 공고',
    url: source === 'albamon' ? `https://www.albamon.com/jobs/detail/${id}`
      : source === 'alba' ? `https://www.alba.co.kr/job/Detail?adid=${id}`
        : `https://jobs.daangn.com/job-posts/${id}` }] : [],
  searchUrl: source === 'albamon' ? `https://www.albamon.com/total-search?keyword=${encodeURIComponent(query)}`
    : source === 'alba' ? `https://www.alba.co.kr/search/Search?wsSrchWord=${encodeURIComponent(query)}`
      : `https://jobs.daangn.com/s?regionId=230&query=${encodeURIComponent(query)}`,
  checkedAt: '2026-09-25T00:00:00.000Z', ...(status === 'unavailable' && { message: '합성 조회 실패' })
});
const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const tick = () => new Promise((resolve) => setImmediate(resolve));

test('snapshot uses fixed source order and copies administrative fields, not street or postcode', () => {
  const input = draft({ query: ' 카페 ', selected: ['alba', 'daangn', 'albamon', 'alba'],
    address: { ...seoul, address: '비공개 상세주소', roadAddress: '도로명', zonecode: '12345' } });
  const value = createSearchSnapshot(input).snapshot;
  assert.equal(value.query, '카페');
  assert.deepEqual(value.requests.map((request) => request.source), ['albamon', 'daangn', 'alba']);
  assert.deepEqual(value.requests[0].options.area, seoul);
  assert.doesNotMatch(JSON.stringify(value), /비공개|도로명|zonecode|roadAddress/);
  assert.match(value.requests[1].label, /서교동.*주변/);
  assert.match(value.requests[2].label, /마포구.*동 단위 미지원/);
  assert.doesNotMatch(value.requests[2].label, /서교동/);
  assert.ok(Object.isFrozen(value) && Object.isFrozen(value.requests));
  assert.ok(Object.isFrozen(value.requests[0].options.area));
  input.query = '다른 검색'; input.address.bname = '합정동'; input.selected.length = 0;
  assert.equal(value.query, '카페'); assert.equal(value.requests[0].options.area.bname, '서교동');
});

test('fingerprint ignores inactive fields, source selection order, view filters and label text', () => {
  const a = snapshot({ scope: 'nationwide', areaLevel: 'city' });
  const b = snapshot({ scope: 'nationwide', address: suwon, areaLevel: 'province', selected: ['alba', 'albamon'],
    daangnAreas: [donggyo], filters: { minHourly: 15000 }, sortOrder: 'hourly-desc' });
  assert.equal(a.fingerprint, b.fingerprint);
  assert.deepEqual(a.requests.map((request) => request.source), ['albamon', 'alba']);
  assert.ok(a.requests.every((request) => request.options.scope === 'nationwide' && !request.options.area));
  assert.equal(searchFingerprint({ ...a, label: '다른 표시 문구' }), a.fingerprint);
  assert.notEqual(snapshot({ query: '편의점' }).fingerprint, snapshot().fingerprint);
  assert.notEqual(snapshot({ address: donggyo }).fingerprint, snapshot().fingerprint);
  assert.notEqual(snapshot({ areaLevel: 'district' }).fingerprint, snapshot({ areaLevel: 'province' }).fingerprint);
});

for (const [areaLevel, beforeArea, afterArea] of [
  ['district', seoul, donggyo],
  ['city', suwon, suwonPaldal],
  ['province', suwon, seongnam]
]) {
  test(`${areaLevel} fingerprint ignores an address change within its already applied coverage`, () => {
    const before = snapshot({ selected: ['albamon', 'alba'], address: beforeArea, areaLevel });
    const after = snapshot({ selected: ['albamon', 'alba'], address: afterArea, areaLevel });
    assert.equal(before.label, after.label);
    assert.equal(before.fingerprint, after.fingerprint, 'An unchanged effective search region must not prompt a redundant search.');
  });
}

test('Alba-only neighborhood fingerprint compares its actual district coverage', () => {
  const before = snapshot({ selected: ['alba'], address: seoul, areaLevel: 'neighborhood' });
  const after = snapshot({ selected: ['alba'], address: donggyo, areaLevel: 'neighborhood' });
  assert.equal(before.label, after.label);
  assert.equal(before.fingerprint, after.fingerprint, 'Alba does not apply a dong-level condition inside the same district.');
});

test('fingerprint still distinguishes actual district, city and province changes', () => {
  for (const [areaLevel, beforeArea, afterArea] of [
    ['district', suwon, suwonPaldal],
    ['city', suwon, seongnam],
    ['province', suwon, seoul]
  ]) {
    const before = snapshot({ selected: ['albamon', 'alba'], address: beforeArea, areaLevel });
    const after = snapshot({ selected: ['albamon', 'alba'], address: afterArea, areaLevel });
    assert.notEqual(before.fingerprint, after.fingerprint, areaLevel);
  }
  assert.notEqual(
    snapshot({ selected: ['alba'], address: suwon, areaLevel: 'neighborhood' }).fingerprint,
    snapshot({ selected: ['alba'], address: suwonPaldal, areaLevel: 'neighborhood' }).fingerprint,
    'Alba neighborhood selection must still distinguish different effective districts.'
  );
});

test('neighborhood changes remain material for Albamon and Daangn, and separate Daangn order remains material', () => {
  for (const selected of [['albamon'], ['daangn'], ['albamon', 'alba'], ['daangn', 'alba']]) {
    assert.notEqual(snapshot({ selected, address: seoul }).fingerprint,
      snapshot({ selected, address: donggyo }).fingerprint, selected.join(','));
  }
  const selected = ['albamon', 'daangn', 'alba'];
  const options = { selected, address: suwon, areaLevel: 'city', daangnMultiEnabled: true };
  assert.notEqual(snapshot({ ...options, daangnAreas: [seoul, donggyo] }).fingerprint,
    snapshot({ ...options, daangnAreas: [donggyo, seoul] }).fingerprint,
    'A stable broad base region must not hide a separate-neighborhood order change.');
});

test('broad-region normalization preserves source, query and explicit area-level distinctions', () => {
  const options = { selected: ['albamon', 'alba'], address: suwon, areaLevel: 'city' };
  const before = snapshot(options);
  for (const change of [
    { query: '편의점' }, { selected: ['albamon'] }, { selected: ['alba'] },
    { areaLevel: 'district' }, { areaLevel: 'province' }, { scope: 'nationwide' }
  ]) {
    assert.notEqual(before.fingerprint, snapshot({ ...options, ...change }).fingerprint, JSON.stringify(change));
  }
  assert.notEqual(snapshot({ selected: ['alba'], areaLevel: 'neighborhood' }).fingerprint,
    snapshot({ selected: ['alba'], areaLevel: 'district' }).fingerprint,
    'This bounded fix must not silently redefine explicit level changes.');
});

test('coverage comparison leaves each raw administrative snapshot and outgoing request unchanged', async () => {
  for (const [areaLevel, areas] of [
    ['district', [seoul, donggyo]], ['city', [suwon, suwonPaldal]], ['province', [suwon, seongnam]]
  ]) {
    for (const area of areas) {
      const input = draft({ selected: ['albamon', 'alba'], areaLevel,
        address: { ...area, address: 'PRIVATE STREET', zonecode: '12345' } });
      const original = structuredClone(input);
      const submitted = createSearchSnapshot(input).snapshot;
      for (const source of ['albamon', 'alba']) {
        const request = submitted.requests.find((candidate) => candidate.source === source);
        assert.deepEqual(request.options.area, area);
        assert.equal(request.options.areaLevel, areaLevel);
        assert.ok(Object.isFrozen(request.options.area));
        await requestSearchSource(submitted, source, { fetcher: async (url) => {
          assert.deepEqual(Object.fromEntries(new URL(url, 'http://localhost').searchParams), {
            q: '카페', source, scope: 'address', areaLevel, ...area
          });
          return Response.json(fixture(source));
        } });
      }
      assert.deepEqual(input, original, 'Fingerprint normalization must not mutate the editable address.');
    }
  }
});

test('separate Daangn selection is independent of base scope, preserves unique order and has a clear label', () => {
  const first = snapshot({ selected: ['daangn'], address: null, daangnMultiEnabled: true, daangnAreas: [seoul, donggyo, { ...seoul, bcode: '1144012999' }] });
  const second = snapshot({ selected: ['daangn'], scope: 'nationwide', address: suwon, areaLevel: 'city', daangnMultiEnabled: true, daangnAreas: [seoul, donggyo] });
  assert.equal(first.fingerprint, second.fingerprint);
  assert.equal(first.requests[0].mode, 'multi');
  assert.deepEqual(first.requests[0].areas, [seoul, donggyo]);
  assert.match(first.label, /당근 별도 동네 2곳/);
  assert.match(first.requests[0].label, /서교동.*동교동.*주변/);
  assert.ok(Object.isFrozen(first.requests[0].areas[0]));
  assert.notEqual(first.fingerprint, snapshot({ selected: ['daangn'], daangnMultiEnabled: true, daangnAreas: [donggyo, seoul] }).fingerprint);
});

test('invalid drafts fail without silently widening regions or requesting unsupported Daangn scope', () => {
  const moreThanFive = Array.from({ length: 6 }, (_, index) => ({ ...seoul, bname: `동네${index}` }));
  for (const input of [null, {}, draft({ query: '' }), draft({ query: 'a'.repeat(81) }), draft({ query: 'bad\u0000query' }),
    draft({ selected: [] }), draft({ selected: ['invalid'] }), draft({ scope: 'wrong' }), draft({ areaLevel: 'wrong' }),
    draft({ address: null }), draft({ address: { ...seoul, bcode: '1234512345' } }),
    draft({ areaLevel: 'city' }), draft({ selected: ['daangn'], areaLevel: 'district' }),
    draft({ daangnMultiEnabled: true, daangnAreas: [] }), draft({ daangnMultiEnabled: true, daangnAreas: [{}] }),
    draft({ daangnMultiEnabled: true, daangnAreas: moreThanFive })]) {
    const value = createSearchSnapshot(input);
    assert.equal(value.ok, false, JSON.stringify(input));
    assert.equal(typeof value.message, 'string');
    assert.ok(value.message.length);
  }
  assert.match(snapshot({ address: suwon, areaLevel: 'city' }).label, /경기 수원시.*시·군 전체/);
});

test('only Daangn with no selected neighborhood reports its own field, not the unused base address', () => {
  assert.deepEqual(createSearchSnapshot(draft({ selected: ['daangn'], address: null, daangnMultiEnabled: true, daangnAreas: [] })), {
    ok: false, field: 'daangnAreas', message: '당근에서 검색할 동네를 하나 이상 추가해주세요.'
  });
});

test('validation field follows the actual first blocking condition without changing existing messages', () => {
  const tooManyAreas = Array.from({ length: 6 }, (_, index) => ({ ...seoul, bname: `동네${index}` }));
  const cases = [
    [draft({ address: null, daangnMultiEnabled: true, daangnAreas: [] }), 'address', '주소 찾기로 기준 주소를 지정하거나 전국을 선택해주세요.'],
    [draft({ query: 'bad\u0000query', address: null }), 'query', '검색어를 1~80자로 입력해주세요.'],
    [draft({ selected: [] }), 'sources', '검색할 업체를 하나 이상 선택해주세요.'],
    [draft({ selected: ['daangn'], areaLevel: 'district' }), 'sources', '검색할 업체를 하나 이상 선택해주세요.'],
    [draft({ selected: ['invalid'] }), 'sources', '검색할 업체를 확인해주세요.'],
    [draft({ scope: 'invalid', areaLevel: 'invalid' }), 'scope', '검색 범위와 지역 단위를 확인해주세요.'],
    [draft({ areaLevel: 'invalid' }), 'areaLevel', '검색 범위와 지역 단위를 확인해주세요.'],
    [draft({ areaLevel: 'city' }), 'areaLevel', '선택한 주소에 맞는 지역 단위를 다시 선택해주세요.'],
    [draft({ daangnMultiEnabled: 'invalid' }), 'daangnAreas', '검색 범위와 지역 단위를 확인해주세요.'],
    [draft({ daangnMultiEnabled: true, daangnAreas: null }), 'daangnAreas', '검색할 당근 동네를 확인해주세요.'],
    [draft({ daangnMultiEnabled: true, daangnAreas: [{}] }), 'daangnAreas', '올바른 당근 동네 주소를 다시 선택해주세요.'],
    [draft({ daangnMultiEnabled: true, daangnAreas: tooManyAreas }), 'daangnAreas', '당근 동네는 최대 5곳까지 선택해주세요.']
  ];
  assert.deepEqual(cases.map(([input]) => createSearchSnapshot(input)),
    cases.map(([, field, message]) => ({ ok: false, field, message })));
});

test('nationwide ignores an inactive missing or malformed base address while keeping separate Daangn areas', () => {
  const input = draft({ scope: 'nationwide', areaLevel: 'district', daangnMultiEnabled: true, daangnAreas: [seoul, donggyo] });
  const expected = createSearchSnapshot(input);
  assert.equal(expected.ok, true);
  for (const address of [null, {}, { ...seoul, bcode: 'invalid', roadAddress: 'inactive private field' }]) {
    const result = createSearchSnapshot({ ...input, address });
    assert.equal(result.ok, true);
    assert.equal(result.snapshot.fingerprint, expected.snapshot.fingerprint);
    assert.deepEqual(result.snapshot.requests.map((request) => request.source), ['albamon', 'daangn', 'alba']);
    assert.ok(result.snapshot.requests.filter((request) => request.mode === 'single').every((request) => request.options.scope === 'nationwide' && !request.options.area));
  }
});

test('single request serializes only its submitted query and effective administrative fields', async () => {
  const input = draft({ address: { ...seoul, address: 'PRIVATE', zonecode: '12345' } });
  const submitted = createSearchSnapshot(input).snapshot;
  input.query = '현재 편집 중'; input.address = suwon;
  let calls = 0;
  const value = await requestSearchSource(submitted, 'albamon', { fetcher: async (url, init) => {
    calls++;
    const parsed = new URL(url, 'http://localhost');
    assert.equal(parsed.pathname, '/api/search');
    assert.deepEqual(Object.fromEntries(parsed.searchParams), { q: '카페', source: 'albamon', scope: 'address', areaLevel: 'neighborhood', ...seoul });
    assert.ok(init.signal instanceof AbortSignal);
    return Response.json(fixture());
  } });
  assert.equal(calls, 1); assert.equal(value.source, 'albamon'); assert.equal(value.jobs[0].id, '123');
});

test('nationwide request never serializes stale address or inactive level', async () => {
  await requestSearchSource(snapshot({ scope: 'nationwide', address: seoul }), 'alba', { fetcher: async (url) => {
    assert.deepEqual(Object.fromEntries(new URL(url, 'http://localhost').searchParams), { q: '카페', source: 'alba', scope: 'nationwide' });
    return Response.json(fixture('alba'));
  } });
});

test('unavailable stays unavailable and empty stays empty, with no automatic retry', async () => {
  let count = 0;
  for (const status of ['empty', 'unavailable']) {
    const value = await requestSearchSource(snapshot(), 'albamon', { fetcher: async () => { count++; return Response.json(fixture('albamon', status)); } });
    assert.equal(value.status, status); assert.deepEqual(value.jobs, []);
    if (status === 'unavailable') assert.equal(value.message, '합성 조회 실패');
  }
  assert.equal(count, 2);
});

test('HTTP errors are typed, never parse as successful empty and never auto-retry', async () => {
  for (const status of [400, 403, 429, 502, 503, 504]) {
    let count = 0;
    await assert.rejects(requestSearchSource(snapshot(), 'albamon', { fetcher: async () => {
      count++; return new Response('not a search result', { status });
    } }), (error) => error instanceof SearchRequestError && error.kind === 'http'
      && error.status === status && error.retryable === (status >= 500));
    assert.equal(count, 1);
  }
});

test('network errors and invalid JSON have distinct typed failures', async () => {
  await assert.rejects(requestSearchSource(snapshot(), 'albamon', { fetcher: async () => { throw new TypeError('synthetic offline'); } }),
    (error) => error.kind === 'network' && error.retryable === true);
  await assert.rejects(requestSearchSource(snapshot(), 'albamon', { fetcher: async () => new Response('<html>bad</html>') }),
    (error) => error.kind === 'invalid-response' && error.retryable === false);
});

test('wrong source, query, shape or unsafe links reject rather than becoming usable results', async () => {
  const valid = fixture();
  const invalid = [null, {}, fixture('alba'), { ...valid, status: 'ok', jobs: [] },
    { ...valid, status: 'empty' }, { ...valid, checkedAt: 'invalid' }, fixture('albamon', 'ok', '다른 검색어'),
    { ...valid, searchUrl: 'https://www.albamon.com.evil.invalid/total-search?keyword=카페' },
    { ...valid, jobs: [{ ...valid.jobs[0], url: 'javascript:alert(1)' }] },
    { ...valid, jobs: [{ ...valid.jobs[0], title: '' }] }, { ...valid, jobs: [...valid.jobs, ...valid.jobs] }];
  for (const value of invalid) await assert.rejects(requestSearchSource(snapshot(), 'albamon', {
    fetcher: async () => Response.json(value)
  }), (error) => error.kind === 'invalid-response');
});

test('unselected source, already aborted signal and invalid timeout perform no fetch', async () => {
  let calls = 0;
  const fetcher = async () => { calls++; return Response.json(fixture()); };
  await assert.rejects(requestSearchSource(snapshot({ selected: ['alba'] }), 'albamon', { fetcher }), { kind: 'invalid-request' });
  for (const timeoutMs of [0, -1, Infinity, NaN, 120001]) {
    await assert.rejects(requestSearchSource(snapshot(), 'albamon', { fetcher, timeoutMs }), { kind: 'invalid-request' });
  }
  const controller = new AbortController(); controller.abort('user cancelled');
  await assert.rejects(requestSearchSource(snapshot(), 'albamon', { fetcher, signal: controller.signal }), { name: 'AbortError', kind: 'abort' });
  assert.equal(calls, 0);
});

test('cancel rejects immediately even when transport ignores its signal and late success is not returned', async () => {
  const controller = new AbortController(); const pending = deferred(); let child;
  const promise = requestSearchSource(snapshot(), 'albamon', { signal: controller.signal, fetcher: (_url, init) => { child = init.signal; return pending.promise; } });
  const rejection = assert.rejects(promise, { name: 'AbortError', kind: 'abort' });
  controller.abort(); await rejection;
  assert.equal(child.aborted, true);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  assert.equal(getEventListeners(child, 'abort').length, 0);
  pending.resolve(Response.json(fixture())); await tick();
});

test('cancel while response JSON is pending rejects without waiting for its body', async () => {
  const controller = new AbortController(); const body = deferred(); let reads = 0;
  const promise = requestSearchSource(snapshot(), 'albamon', { signal: controller.signal,
    fetcher: async () => ({ ok: true, json: () => { reads++; return body.promise; } }) });
  const rejection = assert.rejects(promise, { kind: 'abort' }); await tick();
  assert.equal(reads, 1); controller.abort(); await rejection;
  body.resolve(fixture()); await tick();
});

test('a synchronous abort inside fetch cannot become success or a generic network failure', async () => {
  const controller = new AbortController();
  await assert.rejects(requestSearchSource(snapshot(), 'albamon', { signal: controller.signal,
    fetcher: () => { controller.abort(); return Promise.resolve(Response.json(fixture())); }
  }), { kind: 'abort' });
});

test('client deadline covers ignored transport and JSON body and is distinct from cancellation', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const phase of ['transport', 'body']) {
    const pending = deferred(); let child;
    const promise = requestSearchSource(snapshot(), 'albamon', { timeoutMs: 18,
      fetcher: (_url, init) => { child = init.signal; return phase === 'transport' ? pending.promise : Promise.resolve({ ok: true, json: () => pending.promise }); } });
    const rejection = assert.rejects(promise, { name: 'TimeoutError', kind: 'timeout', retryable: true });
    await tick(); t.mock.timers.tick(18); await rejection;
    assert.equal(child.aborted, true);
    pending.resolve(phase === 'transport' ? Response.json(fixture()) : fixture()); await tick();
  }
});

test('success cleans listeners and deadline so a completed request is never later aborted', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const controller = new AbortController(); let child;
  await requestSearchSource(snapshot(), 'albamon', { signal: controller.signal, timeoutMs: 10,
    fetcher: async (_url, init) => { child = init.signal; return Response.json(fixture()); } });
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  assert.equal(getEventListeners(child, 'abort').length, 0);
  t.mock.timers.tick(100); controller.abort(); assert.equal(child.aborted, false);
});

test('manual retry reuses the immutable submitted request and does not request another source', async () => {
  const submitted = snapshot(); const urls = [];
  const fetcher = async (url) => { urls.push(url); return urls.length === 1 ? new Response('', { status: 503 }) : Response.json(fixture()); };
  await assert.rejects(requestSearchSource(submitted, 'albamon', { fetcher }), { kind: 'http' });
  const value = await requestSearchSource(submitted, 'albamon', { fetcher });
  assert.equal(value.status, 'ok'); assert.equal(urls.length, 2); assert.equal(urls[0], urls[1]);
  assert.ok(urls.every((url) => new URL(url, 'http://localhost').searchParams.get('source') === 'albamon'));
});

test('multi request uses the existing concurrency and aggregation without sending the base address', async () => {
  const submitted = snapshot({ address: suwon, areaLevel: 'city', selected: ['daangn'], daangnMultiEnabled: true, daangnAreas: [seoul, donggyo] });
  const requested = [];
  const value = await requestSearchSource(submitted, 'daangn', { fetcher: async (url) => {
    const params = new URL(url, 'http://localhost').searchParams; requested.push(params.get('bname'));
    assert.equal(params.get('areaLevel'), 'neighborhood'); assert.equal(params.get('sigungu'), '마포구');
    return Response.json(fixture('daangn'));
  } });
  assert.deepEqual(requested, ['서교동', '동교동']); assert.equal(value.jobs.length, 1); assert.equal(value.duplicateCount, 1);
  assert.equal(value.regionResults.length, 2);
});

test('multi timeout and cancellation stop queued neighborhoods rather than returning fabricated empty results', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const areas = [seoul, donggyo, suwon]; let count = 0;
  const promise = requestSearchSource(snapshot({ selected: ['daangn'], daangnMultiEnabled: true, daangnAreas: areas }), 'daangn', {
    timeoutMs: 45, fetcher: () => { count++; return new Promise(() => {}); }
  });
  const rejection = assert.rejects(promise, { kind: 'timeout' });
  assert.equal(count, 2); t.mock.timers.tick(45); await rejection; await tick(); assert.equal(count, 2);
});

test('multi partial failure remains attached to its region while successful listings stay visible', async () => {
  let count = 0;
  const value = await requestSearchSource(snapshot({ selected: ['daangn'], daangnMultiEnabled: true, daangnAreas: [seoul, donggyo] }), 'daangn', {
    fetcher: async () => ++count === 1 ? Response.json(fixture('daangn')) : new Response('', { status: 503 })
  });
  assert.equal(value.status, 'ok'); assert.equal(value.partial, true); assert.equal(value.jobs.length, 1);
  assert.deepEqual(value.regionResults.map((region) => region.status), ['ok', 'unavailable']);
  assert.match(value.regionResults[1].message, /503/); assert.equal(count, 2);
});

test('initial request progress survives typed cancellation without converting unfinished neighborhoods into failures', async () => {
  const selected = [seoul, donggyo, suwon, seongnam];
  const submitted = snapshot({ selected: ['daangn'], daangnMultiEnabled: true, daangnAreas: selected });
  const controller = new AbortController(), pending = [], updates = [];
  const promise = requestSearchSource(submitted, 'daangn', {
    signal: controller.signal, onProgress: progress => updates.push(progress),
    fetcher: () => { const item = deferred(); pending.push(item); return item.promise; }
  });
  const rejection = assert.rejects(promise, error => error instanceof SearchRequestError && error.kind === 'abort');
  try {
    pending[0].resolve(Response.json(fixture('daangn', 'ok', '카페', 'kept')));
    await tick();
    assert.equal(updates.length, 1);
    assert.equal(updates[0].total, 4);
    assert.equal(pending.length, 3, 'The next region can start after a completed response.');
    controller.abort(); await rejection;
    const value = finalizeInterruptedDaangn(submitted.query, selected, updates.at(-1), 'cancelled');
    assert.deepEqual(value.jobs.map(row => row.id), ['kept']);
    assert.deepEqual(value.interruption.remainingAreas, selected.slice(1));
    assert.equal(value.regionResults.length, 1);
    assert.equal(value.partial, false);
    for (const item of pending.slice(1)) item.resolve(Response.json(fixture('daangn')));
    await tick();
    assert.equal(updates.length, 1, 'Late replies cannot change the retained progress.');
    assert.equal(pending.length, 3, 'Cancellation stops the remaining queue.');
  } finally { controller.abort(); await rejection; }
});

test('initial multi deadlines retain completed progress but reject with timeout and suppress late transport or body replies', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const selected = [seoul, donggyo, suwon, seongnam];
  const submitted = snapshot({ selected: ['daangn'], daangnMultiEnabled: true, daangnAreas: selected });
  for (const phase of ['transport', 'body']) {
    for (const status of ['ok', 'empty', 'unavailable']) {
      const controller = new AbortController(), pending = [], updates = [];
      let requested = 0, child;
      const promise = requestSearchSource(submitted, 'daangn', {
        signal: controller.signal, timeoutMs: 45, onProgress: progress => updates.push(progress),
        fetcher: (_url, init) => {
          child = init.signal;
          if (++requested === 1) return Promise.resolve(Response.json(fixture('daangn', status)));
          const item = deferred(); pending.push(item);
          return phase === 'transport' ? item.promise : Promise.resolve({ ok: true, json: () => item.promise });
        }
      });
      const rejection = assert.rejects(promise, error => error instanceof SearchRequestError && error.kind === 'timeout');
      await tick();
      assert.equal(updates.length, 1);
      assert.equal(requested, 3);
      const before = structuredClone(updates[0]);
      t.mock.timers.tick(45); await rejection;
      const value = finalizeInterruptedDaangn('카페', selected, updates[0], 'timeout');
      assert.equal(value.status, status);
      assert.equal(value.regionResults.length, 1);
      assert.deepEqual(value.interruption, { reason: 'timeout', remainingAreas: selected.slice(1) });
      assert.equal(value.checkedAt, fixture('daangn').checkedAt);
      assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
      assert.equal(getEventListeners(child, 'abort').length, 0);
      for (const item of pending) item.resolve(phase === 'transport' ? Response.json(fixture('daangn')) : fixture('daangn'));
      await tick();
      assert.equal(updates.length, 1);
      assert.equal(requested, 3);
      assert.deepEqual(updates[0], before);
    }
  }
});

test('only initial multi requests publish progress; single sources and successful failed-only retries do not', async () => {
  let observed = 0;
  const onProgress = () => observed++;
  const single = snapshot();
  for (const source of ['albamon', 'daangn', 'alba']) {
    await requestSearchSource(single, source, { onProgress, fetcher: async () => Response.json(fixture(source)) });
  }
  const multi = snapshot({ selected: ['daangn'], daangnMultiEnabled: true, daangnAreas: [seoul, donggyo] });
  const previous = aggregateDaangnResults('카페', [
    { area: seoul, result: fixture('daangn', 'ok', '카페', 'kept') },
    { area: donggyo, result: fixture('daangn', 'unavailable') }
  ]);
  const value = await requestSearchSource(multi, 'daangn', {
    retryFailedFrom: previous, onProgress, fetcher: async () => Response.json(fixture('daangn', 'ok', '카페', 'recovered'))
  });
  assert.deepEqual(value.jobs.map(row => row.id), ['kept', 'recovered']);
  assert.equal(observed, 0);
  assert.equal(value.interruption, undefined);
});

test('failed-only multi retry reuses the submitted query and keeps successful raw results', async () => {
  const submitted = snapshot({ selected: ['daangn'], daangnMultiEnabled: true, daangnAreas: [seoul, donggyo] });
  const previous = aggregateDaangnResults('카페', [
    { area: seoul, result: fixture('daangn', 'ok', '카페', 'kept') },
    { area: donggyo, result: fixture('daangn', 'unavailable') }
  ]);
  const before = structuredClone(previous);
  const requested = [];
  const value = await requestSearchSource(submitted, 'daangn', { retryFailedFrom: previous, fetcher: async (url) => {
    const params = new URL(url, 'http://localhost').searchParams;
    requested.push(params.get('bname'));
    assert.equal(params.get('q'), submitted.query);
    return Response.json(fixture('daangn', 'ok', '카페', 'recovered'));
  } });
  assert.deepEqual(requested, ['동교동']);
  assert.deepEqual(value.jobs.map((job) => job.id), ['kept', 'recovered']);
  assert.deepEqual(value.regionEntries[0], previous.regionEntries[0]);
  assert.deepEqual(previous, before);
  assert.equal(value.partial, false);
});

test('failed-only retry rejects unsupported sources, absent raw entries and mismatched submitted conditions without fetching', async () => {
  const prior = aggregateDaangnResults('카페', [
    { area: seoul, result: fixture('daangn', 'ok') },
    { area: donggyo, result: fixture('daangn', 'unavailable') }
  ]);
  const multi = snapshot({ daangnMultiEnabled: true, daangnAreas: [seoul, donggyo] });
  const cases = [
    [multi, 'albamon', prior], [multi, 'alba', prior], [snapshot(), 'daangn', prior],
    [multi, 'daangn', { ...prior, regionEntries: undefined }], [multi, 'daangn', null],
    [snapshot({ query: '편의점', daangnMultiEnabled: true, daangnAreas: [seoul, donggyo] }), 'daangn', prior],
    [snapshot({ daangnMultiEnabled: true, daangnAreas: [donggyo, seoul] }), 'daangn', prior],
    [snapshot({ daangnMultiEnabled: true, daangnAreas: [seoul, suwon] }), 'daangn', prior]
  ];
  let requests = 0;
  for (const [submitted, source, previous] of cases) {
    await assert.rejects(requestSearchSource(submitted, source, {
      retryFailedFrom: previous, fetcher: async () => { requests++; return Response.json(fixture('daangn')); }
    }), (error) => error instanceof SearchRequestError && error.kind === 'invalid-request' && error.retryable === false);
  }
  assert.equal(requests, 0);
});

test('failed-only retry deadline and cancellation preserve prior results and stop late transport or body work', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const areas = [seoul, donggyo, suwon, suwonPaldal, seongnam];
  const submitted = snapshot({ selected: ['daangn'], daangnMultiEnabled: true, daangnAreas: areas });
  const previous = aggregateDaangnResults('카페', areas.map((area, index) => ({
    area, result: fixture('daangn', index === 0 ? 'ok' : 'unavailable')
  })));
  const before = structuredClone(previous);
  for (const reason of ['timeout', 'abort']) {
    for (const phase of ['transport', 'body']) {
      const controller = new AbortController();
      const pending = []; let count = 0, child;
      const promise = requestSearchSource(submitted, 'daangn', {
        retryFailedFrom: previous, signal: controller.signal, timeoutMs: 45,
        fetcher: (_url, init) => {
          child = init.signal; count++;
          const item = deferred(); pending.push(item);
          return phase === 'transport' ? item.promise : Promise.resolve({ ok: true, json: () => item.promise });
        }
      });
      const rejection = assert.rejects(promise, { kind: reason });
      await tick(); assert.equal(count, 2);
      if (reason === 'timeout') t.mock.timers.tick(45);
      else controller.abort();
      await rejection;
      assert.equal(child.aborted, true);
      assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
      assert.equal(getEventListeners(child, 'abort').length, 0);
      for (const item of pending) item.resolve(phase === 'transport' ? Response.json(fixture('daangn')) : fixture('daangn'));
      await tick();
      assert.equal(count, 2, 'Late responses must not start the remaining failed neighborhoods.');
      assert.deepEqual(previous, before);
    }
  }
});

test('a cancelled retry batch never commits even a recovered region completed before cancellation', async () => {
  const areas = [seoul, donggyo, suwon, seongnam];
  const submitted = snapshot({ selected: ['daangn'], daangnMultiEnabled: true, daangnAreas: areas });
  const previous = aggregateDaangnResults('카페', areas.map((area, index) => ({
    area, result: fixture('daangn', index === 0 ? 'ok' : 'unavailable')
  })));
  const before = structuredClone(previous);
  const controller = new AbortController(), pending = []; let requests = 0, observed = 0;
  const promise = requestSearchSource(submitted, 'daangn', {
    retryFailedFrom: previous, signal: controller.signal,
    onProgress: () => observed++,
    fetcher: () => {
      if (++requests === 1) return Promise.resolve(Response.json(fixture('daangn', 'ok', '카페', 'recovered')));
      const item = deferred(); pending.push(item); return item.promise;
    }
  });
  const rejection = assert.rejects(promise, { kind: 'abort' });
  await tick(); assert.equal(requests, 3);
  assert.deepEqual(previous, before);
  controller.abort(); await rejection;
  for (const item of pending) item.resolve(Response.json(fixture('daangn')));
  await tick();
  assert.deepEqual(previous, before);
  assert.equal(observed, 0, 'A failed-only retry stays atomic even with an observer supplied.');
});

test('single and multi actually apply their distinct default deadlines', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const mode of ['single', 'multi']) {
    const submitted = mode === 'single' ? snapshot() : snapshot({ selected: ['daangn'], daangnMultiEnabled: true, daangnAreas: [seoul, donggyo] });
    let settled = false;
    const promise = requestSearchSource(submitted, mode === 'single' ? 'albamon' : 'daangn', { fetcher: () => new Promise(() => {}) });
    promise.then(() => { settled = true; }, () => { settled = true; });
    const rejection = assert.rejects(promise, { kind: 'timeout' });
    const limit = mode === 'single' ? SINGLE_SOURCE_TIMEOUT_MS : MULTI_SOURCE_TIMEOUT_MS;
    t.mock.timers.tick(limit - 1); await tick(); assert.equal(settled, false);
    t.mock.timers.tick(1); await rejection; assert.equal(settled, true);
  }
});

test('default upper bounds are documented client policy, not network performance measurements', () => {
  assert.equal(SINGLE_SOURCE_TIMEOUT_MS, 18000);
  assert.equal(MULTI_SOURCE_TIMEOUT_MS, 45000);
});
