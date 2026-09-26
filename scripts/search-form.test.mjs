import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { createContext, runInContext } from 'node:vm';
import ts from 'typescript';
import { parse } from 'svelte/compiler';
import { createSearchSnapshot, requestSearchSource, SearchRequestError } from '../src/lib/search-request.ts';
import { appHandoffUrl } from '../src/lib/browser-handoff.ts';
import { createPostcodeSearch, selectedAddress } from '../src/lib/postcode.ts';
import { MAX_DAANGN_AREAS, addDaangnArea, aggregateDaangnResults, neighborhoodKey, toSearchArea } from '../src/lib/daangn-multi.ts';
import * as daangnMulti from '../src/lib/daangn-multi.ts';
import { areaLabel, normalizeAreaLevel, supportsSearchArea } from '../src/lib/search-area.ts';
import { sources } from '../src/lib/search.ts';
import { defaultJobFilters } from '../src/lib/filter-jobs.ts';
import { createSearchSession } from '../src/lib/search-session.ts';

// Execute the actual page handlers, not a copied policy implementation. This is a
// source-level controller regression harness, not a browser or Svelte DOM test.
const pageUrl = new URL('../src/routes/+page.svelte', import.meta.url);
const page = readFileSync(pageUrl, 'utf8');
const script = page.match(/<script\b[^>]*>([\s\S]*?)<\/script>/)?.[1];
assert.ok(script, 'The page must contain its controller script.');
const ast = ts.createSourceFile(pageUrl.pathname, script, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const declarations = ast.statements.filter(ts.isFunctionDeclaration);
const teardownRegistrations = ast.statements.filter((node) => ts.isExpressionStatement(node)
  && ts.isCallExpression(node.expression) && node.expression.expression.getText(ast) === 'onDestroy');
assert.ok(teardownRegistrations.length, 'The page must register its actual teardown callback.');
for (const name of ['clearAddress', 'search']) {
  assert.ok(declarations.some((node) => node.name?.text === name), `Page handler ${name} must exist.`);
}
const executable = ts.transpileModule([...declarations, ...teardownRegistrations].map((node) => node.getText(ast)).join('\n'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None }
}).outputText;

const AREA = Object.freeze({ sido: '서울', sigungu: '마포구', bname: '동교동', bcode: '1144012100', sigunguCode: '11440', address: '서울 마포구 양화로 지하160', zonecode: '04050' });

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function harness(overrides = {}) {
  const focus = [];
  const scroll = [];
  const teardowns = [];
  const target = (name) => ({ disabled: false, focus: () => focus.push(name),
    scrollIntoView: (options) => scroll.push({ target: name, options: { ...options }, focused: focus.at(-1) }) });
  let finishTick;
  const pendingTick = new Promise((resolve) => { finishTick = resolve; });
  const tickStarted = deferred();
  let ticks = 0;
  const state = {
    query: '카페', selected: ['albamon', 'daangn', 'alba'], scope: 'address', address: { ...AREA },
    areaLevel: 'district', daangnMultiEnabled: false, daangnAreas: [], daangnNotice: '', validation: '',
    submitted: '이전 검색', submittedArea: '이전 지역', lanes: [], generation: 0,
    controllers: new Map(), attempts: new Map(), appliedSnapshot: null, laneHeadings: {},
    AbortController, Error, SearchRequestError, sources, defaultJobFilters,
    filters: defaultJobFilters(), sortOrder: 'source', resultsTitle: target('results'), stopButton: undefined,
    onDestroy: (callback) => teardowns.push(callback),
    searchSession: { read: () => undefined, write: () => {}, clear: () => {} },
    $state: { snapshot: (value) => structuredClone(value) },
    createSearchSnapshot, MAX_DAANGN_AREAS, addDaangnArea, neighborhoodKey, toSearchArea, areaLabel,
    finalizeInterruptedDaangn: daangnMulti.finalizeInterruptedDaangn,
    queryInput: target('query'), addressTrigger: target('address'), daangnTrigger: target('daangnAreas'),
    sourceTrigger: {
      querySelector: (selector) => {
        assert.equal(selector, 'button:not(:disabled)', 'Focus should target the first enabled provider button.');
        return target('sources');
      }
    },
    areaLevelInput: target('areaLevel'), scopeTrigger: target('scope'),
    postcodeHandoffUrl: 'http://127.0.0.1:5173/', postcodeCopyState: 'idle', postcodeCopyGeneration: 0,
    postcodeHandoffInput: { focus: () => focus.push('handoff'), select: () => focus.push('handoff-select') },
    postcodeDialog: {
      open: true,
      showModal() { this.open = true; },
      close() { this.open = false; }
    },
    postcodeSearch: { open: async () => {}, close: () => {} },
    postcodeContainer: {}, postcodePurpose: 'base', postcodeStatus: 'idle', postcodeError: '',
    appHandoffUrl, window: { location: { href: 'http://127.0.0.1:5173/' } },
    copyHandoffUrl: () => { throw new Error('A copy test must inject its clipboard boundary.'); },
    tick: () => { ticks += 1; tickStarted.resolve(); return pendingTick; },
    fetch: () => { throw new Error('Form validation must never make a network request.'); },
    ...overrides
  };
  const context = createContext(state);
  runInContext(executable, context, { filename: pageUrl.pathname, timeout: 1000 });
  return {
    state, focus, scroll, finishTick, whenTick: tickStarted.promise, ticks: () => ticks,
    clearAddress: () => context.clearAddress(), search: () => context.search(),
    destroy() {
      for (const teardown of teardowns) teardown();
      // Match Svelte's bind:this cleanup after the component teardown callback.
      // This models the lifecycle boundary; it does not execute a real DOM.
      state.postcodeDialog = null;
      state.postcodeHandoffInput = null;
    }
  };
}

function postcodeFlowHarness(t, purpose) {
  const frames = [];
  const embedded = deferred();
  const requests = [];
  const sdk = { Postcode: class {
    constructor(options) { this.options = options; }
    embed() { frames.push(this.options); embedded.resolve(); }
  } };
  // Only the SDK boundary is synthetic. Both the picker generation management
  // and the page's status/completion/close callbacks are their real functions.
  const picker = createPostcodeSearch({ load: async () => sdk, timeoutMs: 10_000 });
  const f = harness({ selected: purpose === 'base' ? ['albamon'] : ['daangn'], address: null,
    daangnMultiEnabled: purpose === 'daangn', daangnAreas: [],
    postcodeSearch: picker, postcodeContainer: { replaceChildren() {} }, selectedAddress, normalizeAreaLevel,
    fetch: () => { requests.push('fetch'); throw new Error('Address editing must not fetch listings.'); },
    requestSearchSource: () => { requests.push('source'); throw new Error('Address editing must not request a source.'); } });
  f.state.postcodeDialog.open = false;
  const plan = createSearchSnapshot(f.state);
  assert.equal(plan.ok, false);
  assert.equal(plan.field, purpose === 'base' ? 'address' : 'daangnAreas');
  f.state.validation = plan.message;
  t.after(() => { picker.close(); f.finishTick(); });
  const data = { ...AREA, roadAddress: AREA.address, jibunAddress: '서울 마포구 동교동',
    userSelectedType: 'R', bname1: '' };
  return { ...f, frames, requests, data,
    async open() { f.state.openAddressSearch(purpose); await embedded.promise; } };
}

function areaLevelTemplate() {
  const component = parse(page, { modern: true });
  let select;
  function visit(node) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(visit); return; }
    if (node.type === 'RegularElement' && node.name === 'select'
      && node.attributes.some((attribute) => attribute.type === 'Attribute' && attribute.name === 'id'
        && attribute.value?.[0]?.data === 'area-level')) select = node;
    for (const [key, value] of Object.entries(node)) if (!['loc', 'name_loc'].includes(key)) visit(value);
  }
  visit(component.fragment);
  assert.ok(select, 'Use the actual area-level selector, not a copied recovery callback.');
  return { select, component };
}

function changeAreaLevel(f, value) {
  const { select } = areaLevelTemplate();
  const binding = select.attributes.find((attribute) => attribute.type === 'BindDirective' && attribute.name === 'value');
  assert.equal(binding?.expression.type, 'Identifier');
  assert.equal(binding.expression.name, 'areaLevel');
  f.state[binding.expression.name] = value;
  const handler = select.attributes.find((attribute) => attribute.type === 'Attribute' && attribute.name === 'onchange')?.value?.expression;
  // Before the fix there is no listener: model the actual binding-only behavior.
  if (handler) runInContext(`(${page.slice(handler.start, handler.end)})`, f.state, { timeout: 1000 })({ currentTarget: { value } });
}

function currentPageDerived(f) {
  const { component } = areaLevelTemplate();
  const declarations = component.instance.content.body.flatMap((node) => node.type === 'VariableDeclaration' ? node.declarations : []);
  const current = createContext({ ...f.state, supportsSearchArea });
  for (const name of ['activeSources', 'draftSnapshot', 'queryValidation', 'hasDraftChanges']) {
    const expression = declarations.find((node) => node.id?.name === name)?.init?.arguments?.[0];
    assert.ok(expression, `Evaluate the page's actual ${name} expression.`);
    current[name] = runInContext(`(${page.slice(expression.start, expression.end)})`, current, { timeout: 1000 });
  }
  return current;
}

test('restoring a supported area level clears the source error without replacing results or automatically requesting data', async () => {
  const initial = { query: ' 카페 ', selected: ['daangn'], scope: 'address', address: { ...AREA },
    areaLevel: 'neighborhood', daangnMultiEnabled: false, daangnAreas: [] };
  const saved = createSearchSnapshot(initial);
  assert.equal(saved.ok, true);
  const previousLanes = [{ source: 'daangn', state: 'done', result: { source: 'daangn', status: 'ok',
    jobs: [{ id: 'synthetic-old', title: '합성 기존 공고', url: 'https://jobs.daangn.com/job-posts/synthetic-old' }] } }];
  const filters = { ...defaultJobFilters(), minHourly: 12000, include: '카페' };
  const requested = [], signals = [];
  const f = harness({ ...initial, areaLevel: 'district', lanes: previousLanes, appliedSnapshot: saved.snapshot,
    submitted: '카페', submittedArea: saved.snapshot.label, filters, sortOrder: 'hourly-desc', generation: 7,
    requestSearchSource: (snapshot, source, options) => requestSearchSource(snapshot, source, {
      ...options, fetcher: async (url, init) => {
        requested.push(new URL(url, 'http://localhost')); signals.push(init.signal);
        return Response.json({ source: 'daangn', status: 'ok',
          jobs: [{ id: 'synthetic-new', title: '합성 새 공고', url: 'https://jobs.daangn.com/job-posts/synthetic-new' }],
          searchUrl: 'https://jobs.daangn.com/s?regionId=230&query=%EC%B9%B4%ED%8E%98', checkedAt: '2026-09-26T00:00:00.000Z' });
      }
    })
  });
  // A request boundary sentinel detects accidental abort/reset side effects.
  // It is synthetic and is not evidence of a browser request in this scenario.
  const retainedController = new AbortController();
  f.state.controllers.set('alba', retainedController);
  const preservedKeys = ['query', 'selected', 'scope', 'address', 'daangnMultiEnabled', 'daangnAreas', 'submitted',
    'submittedArea', 'lanes', 'appliedSnapshot', 'filters', 'sortOrder', 'generation', 'controllers', 'attempts'];
  const preserved = new Map(preservedKeys.map((key) => [key, f.state[key]]));
  await f.search();
  assert.equal(createSearchSnapshot(f.state).field, 'sources');
  assert.match(f.state.validation, /업체.*하나 이상/);
  assert.deepEqual(f.focus, ['sources']);
  assert.equal(requested.length, 0);
  assert.equal(retainedController.signal.aborted, false);

  changeAreaLevel(f, 'neighborhood');
  assert.equal(f.state.validation, '', 'A corrected supported-provider selection must not retain its old source error.');
  const recovered = createSearchSnapshot(f.state);
  assert.equal(recovered.ok, true);
  assert.equal(recovered.snapshot.fingerprint, saved.snapshot.fingerprint);
  const derived = currentPageDerived(f);
  assert.deepEqual(Array.from(derived.activeSources), ['daangn']);
  assert.equal(derived.draftSnapshot.ok, true);
  assert.equal(derived.queryValidation, '');
  assert.equal(derived.hasDraftChanges, false);
  assert.equal(requested.length, 0, 'Changing the draft must not automatically resubmit.');
  assert.equal(retainedController.signal.aborted, false);
  assert.equal(f.state.controllers.get('alba'), retainedController);
  assert.deepEqual(f.focus, ['sources'], 'Clearing feedback must not programmatically move focus.');
  for (const [key, value] of preserved) assert.equal(f.state[key], value, key);

  await f.search();
  assert.equal(requested.length, 1, 'Only an explicit valid resubmission requests the selected provider.');
  assert.equal(requested[0].searchParams.get('source'), 'daangn');
  assert.equal(requested[0].searchParams.get('q'), '카페');
  assert.equal(requested[0].searchParams.get('areaLevel'), 'neighborhood');
  for (const key of ['sido', 'sigungu', 'bname', 'bcode', 'sigunguCode']) assert.equal(requested[0].searchParams.get(key), AREA[key]);
  assert.equal(requested[0].searchParams.has('address'), false);
  assert.equal(requested[0].searchParams.has('zonecode'), false);
  assert.equal(retainedController.signal.aborted, true, 'Explicit search, unlike changing the draft, owns request replacement.');
  assert.equal(signals[0].aborted, false);
  assert.equal(f.state.lanes.length, 1);
  assert.equal(f.state.lanes[0].result.jobs[0].id, 'synthetic-new');
  assert.equal(f.state.appliedSnapshot.fingerprint, saved.snapshot.fingerprint);
  assert.equal(f.state.filters, filters);
  assert.equal(f.state.query, initial.query);
  assert.equal(f.state.selected, initial.selected);
});

test('area-level recovery without an address clears stale source feedback but still validates the missing address on submit', async () => {
  let requests = 0;
  const f = harness({ selected: ['daangn'], address: null, areaLevel: 'district',
    requestSearchSource: () => { requests++; throw new Error('Invalid conditions must not request data.'); } });
  const lanes = f.state.lanes, snapshot = f.state.appliedSnapshot, generation = f.state.generation;
  await f.search();
  assert.equal(createSearchSnapshot(f.state).field, 'sources');
  assert.match(f.state.validation, /업체.*하나 이상/);
  changeAreaLevel(f, 'neighborhood');
  assert.equal(f.state.validation, '');
  const derived = currentPageDerived(f);
  assert.deepEqual(Array.from(derived.activeSources), ['daangn']);
  assert.equal(derived.draftSnapshot.ok, false);
  assert.equal(derived.draftSnapshot.field, 'address');
  assert.equal(derived.queryValidation, '');
  assert.equal(requests, 0);
  assert.deepEqual(f.focus, ['sources']);
  assert.equal(f.state.lanes, lanes);
  assert.equal(f.state.appliedSnapshot, snapshot);
  assert.equal(f.state.generation, generation);

  await f.search();
  assert.equal(f.state.validation, derived.draftSnapshot.message);
  assert.deepEqual(f.focus, ['sources', 'address']);
  assert.equal(requests, 0, 'Clearing stale feedback must not bypass the remaining address requirement.');
  assert.equal(f.state.lanes, lanes);
  assert.equal(f.state.generation, generation);
});

test('area-level change only clears feedback and retains its native binding, loading lock and linked explanation', () => {
  const { select } = areaLevelTemplate();
  const attribute = (name) => select.attributes.find((item) => item.type === 'Attribute' && item.name === name);
  const expression = (name) => attribute(name)?.value?.expression;
  const evaluate = (value, state) => {
    assert.ok(value);
    return runInContext(`(${page.slice(value.start, value.end)})`, createContext(state), { timeout: 1000 });
  };
  for (const areaLevel of ['district', 'neighborhood']) {
    const state = { validation: '합성 이전 오류', areaLevel };
    evaluate(expression('onchange'), state)({ currentTarget: { value: 'neighborhood' } });
    assert.equal(state.validation, '');
    assert.equal(state.areaLevel, areaLevel, 'The listener must not overwrite or depend on native binding order.');
  }
  assert.equal(select.attributes.find((item) => item.type === 'BindDirective' && item.name === 'value')?.expression?.name, 'areaLevel');
  assert.equal(select.attributes.find((item) => item.type === 'BindDirective' && item.name === 'this')?.expression?.name, 'areaLevelInput');
  for (const [searching, scope, disabled] of [[false, 'address', false], [true, 'address', true], [false, 'nationwide', true]]) {
    assert.equal(evaluate(expression('disabled'), { searching, scope }), disabled);
  }
  assert.equal(evaluate(expression('aria-describedby'), { scope: 'address', address: AREA }), 'area-level-preview area-level-help');
  assert.equal(evaluate(expression('aria-describedby'), { scope: 'address', address: null }), 'area-level-help');
  assert.equal(evaluate(expression('aria-describedby'), { scope: 'nationwide', address: AREA }), 'area-level-help');
});

for (const source of ['albamon', 'daangn', 'alba']) {
  test(`lane filter reset focuses ${source} after cards render and preserves the search`, async () => {
    const filters = { ...defaultJobFilters(), minHourly: 20000, include: '카페' };
    const lanes = [{ source, state: 'done', result: { jobs: [] } }];
    const appliedSnapshot = { query: '이전 검색' };
    const f = harness({ filters, lanes, appliedSnapshot, sortOrder: 'hourly-desc', generation: 4 });
    const preservedKeys = ['query', 'selected', 'scope', 'address', 'areaLevel', 'daangnMultiEnabled',
      'daangnAreas', 'submitted', 'submittedArea', 'lanes', 'appliedSnapshot', 'sortOrder', 'generation',
      'controllers', 'attempts', 'validation'];
    const preserved = new Map(preservedKeys.map((key) => [key, f.state[key]]));
    const moves = [];
    f.state.laneHeadings[source] = { focus(options) {
      assert.deepEqual(f.state.filters, defaultJobFilters(), 'Focus after the restored cards change layout.');
      moves.push({ source, preventScroll: options?.preventScroll });
    } };
    const pending = f.state.resetLaneFilters(source);
    assert.deepEqual(moves, [], 'Wait for the restored layout before scrolling focus into view.');
    assert.deepEqual(f.state.filters, defaultJobFilters());
    assert.equal(f.ticks(), 1);
    f.finishTick();
    await pending;
    assert.deepEqual(moves, [{ source, preventScroll: undefined }], 'Allow the browser to reveal offscreen focus.');
    assert.deepEqual(f.focus, [], 'Do not jump to the query or global results heading.');
    for (const [key, value] of preserved) assert.equal(f.state[key], value, key);
  });
}

test('lane filter reset still clears only filters when its heading binding is unavailable', async () => {
  const f = harness({ filters: { ...defaultJobFilters(), minHourly: 20000 } });
  const pending = f.state.resetLaneFilters('albamon');
  f.finishTick();
  await pending;
  assert.deepEqual(f.state.filters, defaultJobFilters());
  assert.deepEqual(f.focus, []);
});

test('lane filter reset does not focus a heading removed while awaiting the render', async () => {
  const f = harness({ laneHeadings: { albamon: { focus() { assert.fail('The old heading was removed.'); } } } });
  const pending = f.state.resetLaneFilters('albamon');
  f.state.laneHeadings.albamon = null;
  f.finishTick();
  await pending;
  assert.deepEqual(f.focus, []);
});

test('clearing a base address preserves nationwide scope and separate neighborhoods, then focuses address after tick', async () => {
  const neighborhoods = [{ ...AREA }];
  const f = harness({ scope: 'nationwide', areaLevel: 'city', daangnMultiEnabled: true, daangnAreas: neighborhoods, validation: '이전 오류' });
  const pending = f.clearAddress();
  assert.equal(f.state.address, null);
  assert.equal(f.state.validation, '');
  assert.equal(f.state.areaLevel, 'district');
  assert.equal(f.state.daangnAreas, neighborhoods);
  assert.equal(f.state.daangnMultiEnabled, true);
  assert.equal(f.ticks(), 1);
  assert.deepEqual(f.focus, [], 'Focus must wait until the deleted address button leaves the DOM.');
  f.finishTick();
  await pending;
  assert.deepEqual(f.focus, ['address']);
  assert.equal(f.state.scope, 'nationwide', 'Deleting an inactive base address must not change the nationwide search mode.');
});

test('only-Daangn multi-neighborhood search with no selected neighborhoods focuses the add-neighborhood control, not the base address', async () => {
  const f = harness({ selected: ['daangn'], address: null, daangnMultiEnabled: true, daangnAreas: [] });
  const plan = createSearchSnapshot(f.state);
  assert.equal(plan.ok, false);
  f.finishTick();
  await f.search();
  assert.equal(f.state.validation, plan.message);
  assert.deepEqual(f.focus, ['daangnAreas']);
  assert.equal(f.state.submitted, '이전 검색', 'Invalid input must not replace previously submitted results.');
});

test('empty separate neighborhoods center their focused add button once without requesting or replacing existing results', async () => {
  // Source-level control invocation only; viewport visibility is verified by
  // the real browser separately, not inferred from this scroll spy.
  const previous = createSearchSnapshot({ query: '이전 검색', selected: ['daangn'], scope: 'address',
    address: null, areaLevel: 'district', daangnMultiEnabled: true, daangnAreas: [AREA] });
  assert.equal(previous.ok, true);
  const lanes = [{ source: 'daangn', state: 'done', result: { jobs: [{ id: 'retained-offline-fixture' }] } }];
  const filters = { ...defaultJobFilters(), days: 'weekends' };
  const controller = new AbortController();
  let fetches = 0;
  let requests = 0;
  const f = harness({ selected: ['daangn'], address: null, daangnMultiEnabled: true, daangnAreas: [],
    lanes, filters, appliedSnapshot: previous.snapshot, generation: 11,
    controllers: new Map([['daangn', controller]]),
    fetch: () => { fetches += 1; throw new Error('Invalid neighborhoods must not fetch.'); },
    requestSearchSource: () => { requests += 1; throw new Error('Invalid neighborhoods must not request a source.'); } });
  const before = createSearchSnapshot(f.state);
  assert.equal(before.ok, false);
  assert.equal(before.field, 'daangnAreas');
  await f.search();
  assert.deepEqual(f.focus, ['daangnAreas']);
  assert.deepEqual(f.scroll, [{ target: 'daangnAreas', options: { block: 'center' }, focused: 'daangnAreas' }],
    'Only after focus, center the trigger once so nearby feedback has room below it.');
  assert.equal(f.state.validation, before.message);
  assert.equal(f.state.lanes, lanes);
  assert.equal(f.state.appliedSnapshot, previous.snapshot);
  assert.equal(f.state.filters, filters);
  assert.equal(f.state.submitted, '이전 검색');
  assert.equal(f.state.query, '카페');
  assert.equal(f.state.scope, 'address');
  assert.equal(f.state.address, null);
  assert.deepEqual(f.state.selected, ['daangn']);
  assert.deepEqual(f.state.daangnAreas, []);
  assert.equal(f.state.generation, 11);
  assert.equal(controller.signal.aborted, false);
  assert.equal(fetches, 0);
  assert.equal(requests, 0);
});

test('other invalid fields keep their existing focus target without neighborhood centering or requests', async () => {
  for (const [overrides, field] of [
    [{ query: ' ', selected: [], address: null, daangnMultiEnabled: true }, 'query'],
    [{ selected: [], address: null, daangnMultiEnabled: true }, 'sources'],
    [{ selected: ['daangn'], scope: 'nationwide', daangnMultiEnabled: false }, 'sources'],
    [{ address: null, daangnMultiEnabled: true, daangnAreas: [] }, 'address'],
    [{ scope: 'unsupported' }, 'scope'],
    [{ areaLevel: 'unsupported' }, 'areaLevel']
  ]) {
    let fetches = 0;
    let requests = 0;
    const f = harness({ ...overrides,
      fetch: () => { fetches += 1; throw new Error('Invalid fields must not fetch.'); },
      requestSearchSource: () => { requests += 1; throw new Error('Invalid fields must not request a source.'); } });
    const plan = createSearchSnapshot(f.state);
    assert.equal(plan.ok, false);
    assert.equal(plan.field, field);
    const lanes = f.state.lanes;
    const filters = f.state.filters;
    await f.search();
    assert.equal(f.state.validation, plan.message);
    assert.deepEqual(f.focus, [field]);
    assert.deepEqual(f.scroll, [], `${field} must not inherit separate-neighborhood scroll behavior.`);
    assert.equal(f.state.lanes, lanes);
    assert.equal(f.state.filters, filters);
    assert.equal(f.state.submitted, '이전 검색');
    assert.equal(f.state.generation, 0);
    assert.equal(fetches, 0);
    assert.equal(requests, 0);
  }
});

test('all three sources without a base address focus address selection even if separate neighborhoods are also empty', async () => {
  const f = harness({ address: null, daangnMultiEnabled: true, daangnAreas: [] });
  const plan = createSearchSnapshot(f.state);
  assert.equal(plan.ok, false);
  f.finishTick();
  await f.search();
  assert.equal(f.state.validation, plan.message);
  assert.deepEqual(f.focus, ['address']);
});

test('empty, overlong and control-character queries focus the query input before any other invalid field', async () => {
  for (const query of ['', '   ', '가'.repeat(81), '카페\u0000']) {
    const f = harness({ query, address: null, selected: [], daangnMultiEnabled: true });
    const plan = createSearchSnapshot(f.state);
    assert.equal(plan.ok, false);
    f.finishTick();
    await f.search();
    assert.equal(f.state.validation, plan.message);
    assert.deepEqual(f.focus, ['query'], JSON.stringify(query));
  }
});

test('overlong search retains its full draft and previous results, snapshot and filters without requesting data', async () => {
  const previous = createSearchSnapshot({ query: '카페', selected: ['albamon'], scope: 'nationwide', address: null,
    areaLevel: 'district', daangnMultiEnabled: false, daangnAreas: [] });
  assert.equal(previous.ok, true);
  const lanes = [{ source: 'albamon', state: 'done', result: { source: 'albamon', status: 'ok',
    jobs: [{ id: 'retained-fixture', title: '합성 기존 결과', url: 'https://www.albamon.com/jobs/detail/retained-fixture' }],
    searchUrl: 'https://www.albamon.com/total-search?keyword=%EC%B9%B4%ED%8E%98', checkedAt: '2026-09-25T00:00:00.000Z' } }];
  const filters = { ...defaultJobFilters(), payType: 'hourly', days: 'weekends' };
  const query = ` ${'가'.repeat(81)} `;
  let fetches = 0;
  let requests = 0;
  const f = harness({ query, scope: 'nationwide', selected: ['albamon'], address: null,
    lanes, filters, appliedSnapshot: previous.snapshot, submitted: '카페', submittedArea: '전국', generation: 7,
    fetch: () => { fetches += 1; throw new Error('Overlong input must not fetch.'); },
    requestSearchSource: () => { requests += 1; throw new Error('Overlong input must not request a source.'); } });
  await f.search();
  assert.match(f.state.validation, /80/);
  assert.deepEqual(f.focus, ['query']);
  assert.equal(f.state.query, query);
  assert.equal(f.state.lanes, lanes);
  assert.equal(f.state.appliedSnapshot, previous.snapshot);
  assert.equal(f.state.filters, filters);
  assert.equal(f.state.submitted, '카페');
  assert.equal(f.state.submittedArea, '전국');
  assert.equal(f.state.generation, 7);
  assert.equal(fetches, 0);
  assert.equal(requests, 0);
});

test('no selected or supported sources focus the first source selector rather than address selection', async () => {
  for (const settings of [
    { selected: [], address: null },
    { selected: ['daangn'], address: null, scope: 'nationwide', daangnMultiEnabled: false }
  ]) {
    const f = harness(settings);
    const plan = createSearchSnapshot(f.state);
    assert.equal(plan.ok, false);
    f.finishTick();
    await f.search();
    assert.equal(f.state.validation, plan.message);
    assert.deepEqual(f.focus, ['sources']);
  }
});

test('invalid or unavailable area levels focus the area-level selector', async () => {
  for (const areaLevel of ['unsupported', 'city']) {
    const f = harness({ areaLevel });
    const plan = createSearchSnapshot(f.state);
    assert.equal(plan.ok, false);
    f.finishTick();
    await f.search();
    assert.equal(f.state.validation, plan.message);
    assert.deepEqual(f.focus, ['areaLevel']);
  }
});

test('invalid search scope focuses the scope selector', async () => {
  const f = harness({ scope: 'unsupported' });
  const plan = createSearchSnapshot(f.state);
  assert.equal(plan.ok, false);
  f.finishTick();
  await f.search();
  assert.equal(f.state.validation, plan.message);
  assert.deepEqual(f.focus, ['scope']);
});

test('the current page exposes its postcode URL-copy lifecycle handlers', () => {
  const f = harness();
  assert.equal(typeof f.state.resetPostcodeCopy, 'function');
  assert.equal(typeof f.state.copyPostcodeAppUrl, 'function');
});

for (const purpose of ['base', 'daangn']) test(`a ${purpose} completion after native close but before the queued close handler cannot apply an address`, async (t) => {
  const f = postcodeFlowHarness(t, purpose);
  await f.open();
  const before = { address: f.state.address, areas: f.state.daangnAreas, validation: f.state.validation,
    lanes: f.state.lanes, filters: f.state.filters };
  // Explicitly simulate the native-close task gap. This checks a defensive
  // ordering, not evidence that the vendor/browser produced that ordering.
  f.state.postcodeDialog.open = false;
  f.frames[0].oncomplete(f.data);
  assert.equal(f.state.address, before.address, 'A closed picker must not apply a base address.');
  assert.equal(f.state.daangnAreas, before.areas, 'A closed picker must not append a separate neighborhood.');
  assert.equal(f.state.validation, before.validation, 'Cancellation is not a valid address selection.');
  assert.equal(f.state.lanes, before.lanes);
  assert.equal(f.state.filters, before.filters);
  assert.equal(f.state.generation, 0);
  assert.deepEqual(f.requests, []);
  assert.deepEqual(f.focus, []);
  const closed = f.state.addressDialogClosed();
  f.finishTick();
  await closed;
  assert.deepEqual(f.focus, [purpose === 'base' ? 'address' : 'daangnAreas']);
});

for (const purpose of ['base', 'daangn']) test(`a current open ${purpose} picker still applies one valid selection and clears validation without searching`, async (t) => {
  const f = postcodeFlowHarness(t, purpose);
  await f.open();
  assert.equal(f.state.postcodeDialog.open, true);
  const actualClose = f.state.closeAddressSearch;
  let closing;
  // Observe the real handler's returned promise; completion intentionally does
  // not return it, and a single host microtask is not a cross-VM render barrier.
  f.state.closeAddressSearch = (...args) => { closing = actualClose(...args); return closing; };
  const before = { address: f.state.address, areas: f.state.daangnAreas, lanes: f.state.lanes,
    filters: f.state.filters, selected: f.state.selected };
  f.frames[0].oncomplete(f.data);
  await f.whenTick;
  const chosen = selectedAddress(f.data);
  if (purpose === 'base') {
    assert.deepEqual(f.state.address, chosen);
    assert.equal(f.state.daangnAreas, before.areas);
  } else {
    assert.equal(f.state.address, before.address);
    assert.deepEqual(f.state.daangnAreas, [toSearchArea(chosen)]);
  }
  assert.equal(f.state.validation, '');
  assert.equal(createSearchSnapshot(f.state).ok, true);
  assert.equal(f.state.postcodeDialog.open, false);
  assert.equal(f.state.lanes, before.lanes);
  assert.equal(f.state.filters, before.filters);
  assert.equal(f.state.selected, before.selected);
  assert.equal(f.state.appliedSnapshot, null);
  assert.equal(f.state.generation, 0);
  assert.deepEqual(f.requests, []);
  assert.deepEqual(f.focus, [], 'Return focus still waits for the real close handler render boundary.');
  const accepted = { address: f.state.address, areas: f.state.daangnAreas };
  f.frames[0].oncomplete({ ...f.data, roadAddress: 'ignored duplicate fixture' });
  assert.equal(f.state.address, accepted.address);
  assert.equal(f.state.daangnAreas, accepted.areas);
  f.finishTick();
  assert.ok(closing);
  await closing;
  assert.deepEqual(f.focus, [purpose === 'base' ? 'address' : 'daangnAreas']);
});

for (const handler of ['closeAddressSearch', 'addressDialogClosed']) test(`${handler} tolerates teardown while awaiting the close render without focusing removed controls`, async (t) => {
  const f = postcodeFlowHarness(t, 'daangn');
  await f.open();
  if (handler === 'addressDialogClosed') f.state.postcodeDialog.open = false;
  const beforeValidation = f.state.validation;
  const closing = f.state[handler]();
  await f.whenTick;
  f.destroy();
  f.state.addressTrigger = null;
  f.state.daangnTrigger = null;
  f.finishTick();
  await assert.doesNotReject(closing, 'A pending close must not dereference a cleared dialog binding.');
  assert.deepEqual(f.focus, []);
  assert.deepEqual(f.requests, []);
  assert.equal(f.state.validation, beforeValidation);
});

for (const handler of ['closeAddressSearch', 'addressDialogClosed']) test(`${handler} is safe when invoked after dialog bindings have already been destroyed`, async (t) => {
  const f = postcodeFlowHarness(t, 'daangn');
  await f.open();
  const beforeValidation = f.state.validation;
  f.destroy();
  f.state.addressTrigger = null;
  f.state.daangnTrigger = null;
  const closing = f.state[handler]();
  f.finishTick();
  await assert.doesNotReject(closing, 'A queued or explicit close must tolerate an already-cleared dialog binding.');
  f.frames[0].oncomplete(f.data);
  assert.equal(f.state.validation, beforeValidation);
  assert.equal(f.state.address, null);
  assert.equal(f.state.daangnAreas.length, 0);
  assert.deepEqual(f.focus, []);
  assert.deepEqual(f.requests, []);
});

test('postcode copying ignores an absent URL and suppresses another click while its request is pending', async () => {
  const empty = harness({ postcodeHandoffUrl: '' });
  await empty.state.copyPostcodeAppUrl();
  assert.equal(empty.state.postcodeCopyState, 'idle');
  assert.equal(empty.state.postcodeCopyGeneration, 0);

  const copy = deferred();
  const urls = [];
  const f = harness({ copyHandoffUrl: (url) => { urls.push(url); return copy.promise; } });
  const pending = f.state.copyPostcodeAppUrl();
  assert.equal(f.state.postcodeCopyState, 'copying');
  const generation = f.state.postcodeCopyGeneration;
  await f.state.copyPostcodeAppUrl();
  assert.deepEqual(urls, ['http://127.0.0.1:5173/']);
  assert.equal(f.state.postcodeCopyGeneration, generation);
  copy.resolve('copied');
  await pending;
  assert.equal(f.state.postcodeCopyState, 'copied');
  assert.deepEqual(f.focus, []);
  assert.equal(f.ticks(), 0);
});

test('manual copying waits for the rendered URL input before focusing and selecting it', async () => {
  const f = harness({ copyHandoffUrl: async () => 'manual' });
  const pending = f.state.copyPostcodeAppUrl();
  await f.whenTick;
  assert.equal(f.state.postcodeCopyState, 'manual');
  assert.equal(f.ticks(), 1);
  assert.deepEqual(f.focus, []);
  f.finishTick();
  await pending;
  assert.deepEqual(f.focus, ['handoff', 'handoff-select']);
});

test('resetting postcode copying invalidates the previous promise without changing the URL', async () => {
  const copy = deferred();
  const f = harness({ copyHandoffUrl: () => copy.promise });
  const pending = f.state.copyPostcodeAppUrl();
  const previousGeneration = f.state.postcodeCopyGeneration;
  f.state.resetPostcodeCopy();
  assert.equal(f.state.postcodeCopyGeneration, previousGeneration + 1);
  assert.equal(f.state.postcodeCopyState, 'idle');
  copy.resolve('manual');
  await pending;
  assert.equal(f.state.postcodeCopyState, 'idle');
  assert.equal(f.state.postcodeHandoffUrl, 'http://127.0.0.1:5173/');
  assert.equal(f.ticks(), 0);
  assert.deepEqual(f.focus, []);
});

test('a copy response arriving after the dialog closes cannot show success or focus the hidden input', async () => {
  for (const result of ['copied', 'manual']) {
    const copy = deferred();
    const f = harness({ copyHandoffUrl: () => copy.promise });
    const pending = f.state.copyPostcodeAppUrl();
    f.state.postcodeDialog.open = false;
    copy.resolve(result);
    await pending;
    assert.equal(f.state.postcodeCopyState, 'copying', result);
    assert.equal(f.ticks(), 0, result);
    assert.deepEqual(f.focus, [], result);
  }
});

test('a manual-copy render wait cannot focus an input after reset or dialog closure', async () => {
  for (const invalidate of ['reset', 'close']) {
    const f = harness({ copyHandoffUrl: async () => 'manual' });
    const pending = f.state.copyPostcodeAppUrl();
    await f.whenTick;
    assert.equal(f.state.postcodeCopyState, 'manual');
    assert.equal(f.ticks(), 1);
    if (invalidate === 'reset') f.state.resetPostcodeCopy();
    else f.state.postcodeDialog.open = false;
    f.finishTick();
    await pending;
    assert.deepEqual(f.focus, [], invalidate);
  }
});

test('opening, closing and native closing all invalidate a pending copy from the previous dialog session', async () => {
  for (const lifecycle of ['openAddressSearch', 'closeAddressSearch', 'addressDialogClosed']) {
    const copy = deferred();
    const f = harness({ copyHandoffUrl: () => copy.promise });
    const pending = f.state.copyPostcodeAppUrl();
    const previousGeneration = f.state.postcodeCopyGeneration;
    if (lifecycle !== 'closeAddressSearch') f.state.postcodeDialog.open = false;
    const lifecyclePending = f.state[lifecycle]();
    assert.equal(f.state.postcodeCopyState, 'idle', lifecycle);
    assert.equal(f.state.postcodeCopyGeneration, previousGeneration + 1, lifecycle);
    f.finishTick();
    await lifecyclePending;
    copy.resolve('manual');
    await pending;
    assert.equal(f.state.postcodeCopyState, 'idle', lifecycle);
    assert.equal(f.focus.includes('handoff'), false, lifecycle);
    assert.equal(f.focus.includes('handoff-select'), false, lifecycle);
  }
});

test('a delayed native close event cannot cancel a newer open dialog copy request', async () => {
  const copy = deferred();
  const f = harness({ copyHandoffUrl: () => copy.promise });
  const pending = f.state.copyPostcodeAppUrl();
  const generation = f.state.postcodeCopyGeneration;
  await f.state.addressDialogClosed();
  assert.equal(f.state.postcodeCopyState, 'copying');
  assert.equal(f.state.postcodeCopyGeneration, generation);
  assert.equal(f.ticks(), 0);
  copy.resolve('copied');
  await pending;
  assert.equal(f.state.postcodeCopyState, 'copied');
});

test('an older copy response cannot overwrite the outcome of a newer copy request', async () => {
  const copies = [deferred(), deferred()];
  let count = 0;
  const f = harness({ copyHandoffUrl: () => copies[count++].promise });
  const older = f.state.copyPostcodeAppUrl();
  f.state.resetPostcodeCopy();
  const newer = f.state.copyPostcodeAppUrl();
  copies[1].resolve('copied');
  await newer;
  assert.equal(f.state.postcodeCopyState, 'copied');
  copies[0].resolve('manual');
  await older;
  assert.equal(f.state.postcodeCopyState, 'copied');
  assert.equal(count, 2);
  assert.equal(f.ticks(), 0);
  assert.deepEqual(f.focus, []);
});

test('actual page teardown invalidates a pending copy before dialog bindings become null', async () => {
  for (const result of ['copied', 'manual']) {
    const copy = deferred();
    const f = harness({ copyHandoffUrl: () => copy.promise });
    const pending = f.state.copyPostcodeAppUrl();
    const generation = f.state.postcodeCopyGeneration;
    f.destroy();
    copy.resolve(result);
    await assert.doesNotReject(pending, 'A late clipboard completion must not read the removed dialog.');
    assert.equal(f.state.postcodeCopyGeneration, generation + 1);
    assert.equal(f.state.postcodeCopyState, 'idle');
    assert.equal(f.ticks(), 0);
    assert.deepEqual(f.focus, []);
  }
});

test('actual page teardown invalidates a manual-copy render wait before bindings become null', async () => {
  const f = harness({ copyHandoffUrl: async () => 'manual' });
  const pending = f.state.copyPostcodeAppUrl();
  await f.whenTick;
  assert.equal(f.state.postcodeCopyState, 'manual');
  const generation = f.state.postcodeCopyGeneration;
  f.destroy();
  f.finishTick();
  await assert.doesNotReject(pending, 'A delayed render must not read or focus removed dialog controls.');
  assert.equal(f.state.postcodeCopyGeneration, generation + 1);
  assert.equal(f.state.postcodeCopyState, 'idle');
  assert.deepEqual(f.focus, []);
});

for (const scope of ['address', 'nationwide']) {
  test(`adding the base neighborhood clears the previous empty-neighborhood search error in ${scope} scope`, async () => {
    const f = harness({ scope, selected: ['daangn'], daangnMultiEnabled: true });
    const before = createSearchSnapshot(f.state);
    assert.equal(before.ok, false);
    assert.equal(before.field, 'daangnAreas');
    await f.search();
    assert.equal(f.state.validation, before.message);

    const previousLanes = f.state.lanes;
    const previousAddress = f.state.address;
    f.state.addNeighborhood(f.state.address);
    assert.equal(f.state.daangnAreas.length, 1);
    assert.equal(createSearchSnapshot(f.state).ok, true);
    assert.equal(f.state.lanes, previousLanes, 'Editing a draft must not discard already displayed results.');
    assert.equal(f.state.address, previousAddress);
    assert.equal(f.state.scope, scope);
    assert.match(f.state.daangnNotice, /동네를 추가했어요/);
    assert.equal(f.state.validation, '', 'A corrected neighborhood list must not keep its previous missing-neighborhood error.');
  });
}

test('rejecting an invalid neighborhood preserves the selected list and current search state', () => {
  for (const input of [null, {}, { ...AREA, bcode: '9999912100' }]) {
    const areas = Object.freeze([Object.freeze(toSearchArea(AREA))]);
    const f = harness({ daangnMultiEnabled: true, daangnAreas: areas, validation: '기존 검색 오류' });
    const previousAddress = f.state.address;
    const previousLanes = f.state.lanes;
    f.state.addNeighborhood(input);
    assert.equal(f.state.daangnAreas, areas, 'Invalid input must not replace the selected neighborhood list.');
    assert.equal(f.state.daangnAreas.length, 1);
    assert.equal(f.state.address, previousAddress);
    assert.equal(f.state.lanes, previousLanes);
    assert.equal(f.state.validation, '기존 검색 오류');
    assert.equal(f.state.daangnNotice, '동네를 확인하지 못했어요. 다른 주소를 선택해주세요.');
  }
});

test('a full neighborhood list rejects duplicates and a sixth addition without changing its contents or current results', () => {
  const areas = Object.freeze(['동교동', '서교동', '합정동', '연남동', '망원동'].map((bname, index) => Object.freeze({
    ...toSearchArea(AREA), bname, bcode: `11440${String(100 + index).padStart(5, '0')}`
  })));
  const extra = { ...toSearchArea(AREA), bname: '상수동', bcode: '1144010500' };
  const f = harness({ daangnMultiEnabled: true, daangnAreas: areas });
  const previousAddress = f.state.address;
  const previousLanes = f.state.lanes;

  f.state.addNeighborhood(areas[0]);
  assert.deepEqual(f.state.daangnAreas, areas);
  assert.equal(f.state.daangnNotice, '이미 선택한 동네예요.');
  f.state.addNeighborhood(extra);
  assert.deepEqual(f.state.daangnAreas, areas);
  assert.equal(f.state.daangnAreas.length, 5);
  assert.equal(f.state.daangnNotice, '최대 5곳까지 선택할 수 있어요.');
  assert.equal(f.state.address, previousAddress);
  assert.equal(f.state.lanes, previousLanes);
});

function retryHarness(t, initial = 'failure') {
  const requests = [];
  const tasks = [];
  const headingFocus = [];
  const plan = createSearchSnapshot({ query: '카페', selected: ['albamon', 'alba'], scope: 'nationwide',
    areaLevel: 'district', address: null, daangnMultiEnabled: false, daangnAreas: [] });
  assert.equal(plan.ok, true);
  const successfulLane = { source: 'albamon', state: 'done', result: {
    source: 'albamon', status: 'ok', jobs: [{ id: '123', title: '합성 기존 결과', url: 'https://www.albamon.com/jobs/detail/123' }],
    searchUrl: 'https://www.albamon.com/total-search?keyword=%EC%B9%B4%ED%8E%98', checkedAt: '2026-09-25T00:00:00.000Z'
  } };
  const f = harness({ appliedSnapshot: plan.snapshot, submitted: '카페', submittedArea: plan.snapshot.label,
    query: '편의점', selected: ['albamon', 'alba'], scope: 'nationwide',
    lanes: [successfulLane, { source: 'alba', state: 'done', ...(initial === 'cancelled'
      ? { cancelled: true } : { error: '합성 연결 실패', retryable: true }) }],
    requestSearchSource: (snapshot, source, options) => {
      const task = requestSearchSource(snapshot, source, { ...options, fetcher: (url, init) => {
        const response = deferred();
        requests.push({ ...response, url, signal: init.signal });
        return response.promise;
      } });
      tasks.push(task);
      return task;
    }
  });
  f.state.laneHeadings.alba = { focus: (options) => {
    headingFocus.push({ preventScroll: options?.preventScroll, stateAtFocus: f.state.lanes[1].state });
    f.focus.push('lane-alba');
  } };
  const emptyResponse = () => Response.json({ source: 'alba', status: 'empty', jobs: [],
    searchUrl: 'https://www.alba.co.kr/search/Search?wsSrchWord=%EC%B9%B4%ED%8E%98', checkedAt: '2026-09-25T00:00:00.000Z' });
  const settle = async () => { await Promise.allSettled(tasks); await new Promise(setImmediate); };
  t.after(async () => {
    f.state.cancelSearch();
    for (const request of requests) request.resolve(emptyResponse());
    await settle();
  });
  return { ...f, headingFocus, requests, successfulLane, snapshot: plan.snapshot, emptyResponse, settle };
}

for (const initial of ['failure', 'cancelled']) {
  test(`retry from ${initial} focuses its stable heading before removing the retry button`, async (t) => {
    const f = retryHarness(t, initial);
    f.state.retrySource('alba');
    assert.deepEqual(f.headingFocus, [{ preventScroll: true, stateAtFocus: 'done' }],
      'Focus must move synchronously before the focused retry button is removed by the loading branch.');
    assert.equal(f.state.lanes[1].state, 'loading');
    assert.equal(f.state.lanes[0], f.successfulLane);
    assert.equal(f.state.appliedSnapshot, f.snapshot);
    assert.equal(f.state.query, '편의점', 'Retry must not apply or overwrite the current draft.');
    assert.equal(f.requests.length, 1);
    const params = new URL(f.requests[0].url, 'http://localhost').searchParams;
    assert.equal(params.get('source'), 'alba');
    assert.equal(params.get('q'), '카페');
    f.requests[0].resolve(f.emptyResponse());
    await f.settle();
    assert.equal(f.state.lanes[0], f.successfulLane);
    assert.equal(f.state.lanes[1].result.status, 'empty');
    assert.equal(f.headingFocus.length, 1, 'Request completion must not focus again.');
  });
}

test('retrying an already loading source neither sends another request nor moves focus again', async (t) => {
  const f = retryHarness(t);
  f.state.retrySource('alba');
  assert.equal(f.headingFocus.length, 1);
  f.state.queryInput.focus();
  f.state.retrySource('alba');
  assert.equal(f.requests.length, 1);
  assert.equal(f.headingFocus.length, 1);
  assert.deepEqual(f.focus, ['lane-alba', 'query']);
  assert.equal(f.state.lanes[0], f.successfulLane);
  f.requests[0].resolve(f.emptyResponse());
  await f.settle();
  assert.deepEqual(f.focus, ['lane-alba', 'query']);
});

test('retry completion, renewed failure and late cancelled responses never steal newer user focus', async (t) => {
  for (const outcome of ['complete', 'failure', 'cancelled']) {
    const f = retryHarness(t);
    f.state.retrySource('alba');
    assert.equal(f.headingFocus.length, 1, outcome);
    f.state.queryInput.focus();
    if (outcome === 'cancelled') f.state.cancelSearch();
    f.requests[0].resolve(outcome === 'failure' ? new Response('', { status: 503 }) : f.emptyResponse());
    await f.settle();
    assert.deepEqual(f.focus, ['lane-alba', 'query'], outcome);
    assert.equal(f.headingFocus.length, 1, outcome);
    assert.equal(f.state.lanes[0], f.successfulLane, outcome);
    assert.equal(f.state.appliedSnapshot, f.snapshot, outcome);
    const lane = f.state.lanes[1];
    assert.equal(lane.state, 'done', outcome);
    if (outcome === 'cancelled') assert.equal(lane.cancelled, true);
    else if (outcome === 'failure') { assert.match(lane.error, /503/); assert.equal(lane.retryable, true); }
    else assert.equal(lane.result.status, 'empty');
  }
});

test('the explicit cancel button focuses results before aborting and preserves successful results and conditions', async (t) => {
  const f = retryHarness(t);
  const filters = { ...defaultJobFilters(), minHourly: 12000 };
  f.state.filters = filters;
  f.state.retrySource('alba');
  const focusState = [];
  f.state.resultsTitle = { focus: () => {
    focusState.push({ aborted: f.requests[0].signal.aborted,
      laneState: f.state.lanes[1].state });
    f.focus.push('results');
  } };
  assert.equal(typeof f.state.cancelFromButton, 'function', 'The page needs a distinct user-cancel focus path.');
  f.state.cancelFromButton();
  assert.deepEqual(focusState, [{ aborted: false, laneState: 'loading' }]);
  assert.deepEqual(f.focus, ['lane-alba', 'results']);
  assert.equal(f.requests[0].signal.aborted, true);
  assert.equal(f.state.lanes[1].cancelled, true);
  assert.equal(f.state.lanes[0], f.successfulLane);
  assert.equal(f.state.appliedSnapshot, f.snapshot);
  assert.equal(f.state.query, '편의점');
  assert.equal(f.state.submitted, '카페');
  assert.equal(f.state.scope, 'nationwide');
  assert.equal(f.state.filters, filters);
  assert.equal(f.ticks(), 0, 'Focus must not wait until after the cancel button disappears.');
  await f.settle();
});

test('the explicit cancel control does nothing when no request remains loading', async (t) => {
  const f = retryHarness(t);
  const beforeGeneration = f.state.generation;
  const beforeLanes = f.state.lanes;
  f.state.cancelFromButton();
  assert.deepEqual(f.focus, []);
  assert.equal(f.requests.length, 0);
  assert.equal(f.state.generation, beforeGeneration);
  assert.equal(f.state.lanes, beforeLanes);

  f.state.retrySource('alba');
  f.state.cancelFromButton();
  const afterGeneration = f.state.generation;
  const afterLanes = f.state.lanes;
  f.state.cancelFromButton();
  assert.deepEqual(f.focus, ['lane-alba', 'results']);
  assert.equal(f.state.generation, afterGeneration);
  assert.equal(f.state.lanes, afterLanes);
  await f.settle();
});

test('state-only cancellation does not move focus and full reset focuses only the query input', async (t) => {
  const direct = retryHarness(t);
  direct.state.retrySource('alba');
  direct.state.queryInput.focus();
  direct.state.cancelSearch();
  assert.deepEqual(direct.focus, ['lane-alba', 'query']);
  assert.equal(direct.state.lanes[0], direct.successfulLane);
  assert.equal(direct.state.lanes[1].cancelled, true);
  await direct.settle();

  const reset = retryHarness(t);
  reset.state.retrySource('alba');
  reset.state.resetSearch();
  assert.deepEqual(reset.focus, ['lane-alba', 'query'], 'Reset must not briefly focus results through the shared cancel helper.');
  assert.equal(reset.state.query, '');
  assert.equal(reset.state.lanes.length, 0);
  assert.equal(reset.state.appliedSnapshot, null);
  assert.deepEqual(reset.state.filters, defaultJobFilters());
  await reset.settle();
});

test('late responses after explicit cancellation cannot restore results or steal a newer user focus', async (t) => {
  const f = retryHarness(t);
  f.state.retrySource('alba');
  f.state.cancelFromButton();
  f.state.queryInput.focus();
  f.requests[0].resolve(f.emptyResponse());
  await f.settle();
  assert.deepEqual(f.focus, ['lane-alba', 'results', 'query']);
  assert.equal(f.state.lanes[1].cancelled, true);
  assert.equal(f.state.lanes[1].result, undefined);
  assert.equal(f.state.lanes[0], f.successfulLane);
  assert.equal(f.state.appliedSnapshot, f.snapshot);
  assert.equal(f.state.controllers.size, 0);
});

function partialRetryHarness(t, { timeoutMs } = {}) {
  const areas = [toSearchArea(AREA), { ...toSearchArea(AREA), bname: '서교동', bcode: '1144012000' }];
  const regionResult = (index, status = 'ok') => ({
    source: 'daangn', status, jobs: status === 'ok' ? [{ id: `fixture-${index}`, title: '합성 동네 공고',
      url: `https://jobs.daangn.com/job-posts/fixture-${index}` }] : [],
    searchUrl: `https://jobs.daangn.com/s?query=%EC%B9%B4%ED%8E%98&regionId=${index + 1}`,
    checkedAt: '2026-09-25T00:00:00.000Z', ...(status === 'unavailable' && { message: '합성 동네 연결 실패' })
  });
  const entries = [{ area: areas[0], result: regionResult(0) }, { area: areas[1], result: regionResult(1, 'unavailable') }];
  const previous = { ...aggregateDaangnResults('카페', entries), regionEntries: entries };
  const plan = createSearchSnapshot({ query: '카페', selected: ['albamon', 'daangn', 'alba'], scope: 'nationwide',
    areaLevel: 'district', address: null, daangnMultiEnabled: true, daangnAreas: areas });
  assert.equal(plan.ok, true);
  const requests = [];
  const calls = [];
  const tasks = [];
  const mon = { source: 'albamon', state: 'done', result: { status: 'ok', jobs: [{ id: 'existing-mon' }] } };
  const alba = { source: 'alba', state: 'done', result: { status: 'empty', jobs: [] } };
  const filters = { ...defaultJobFilters(), minHourly: 12000 };
  const f = harness({ appliedSnapshot: plan.snapshot, submitted: '카페', submittedArea: plan.snapshot.label,
    query: '편의점', scope: 'nationwide', daangnMultiEnabled: true, daangnAreas: [areas[1]], filters,
    lanes: [mon, { source: 'daangn', state: 'done', result: previous }, alba],
    requestSearchSource: (snapshot, source, options) => {
      calls.push({ snapshot, source, options });
      const task = requestSearchSource(snapshot, source, { ...options, ...(timeoutMs && { timeoutMs }), fetcher: (url, init) => {
        const response = deferred();
        requests.push({ ...response, url, signal: init.signal });
        return response.promise;
      } });
      tasks.push(task);
      return task;
    }
  });
  const headingFocus = [];
  f.state.laneHeadings.daangn = { focus: (options) => {
    headingFocus.push({ preventScroll: options?.preventScroll, stateAtFocus: f.state.lanes[1]?.state });
    f.focus.push('lane-daangn');
  } };
  const settle = async () => { await Promise.allSettled(tasks); await new Promise(setImmediate); };
  t.after(async () => {
    f.state.cancelSearch();
    for (const request of requests) request.resolve(Response.json(regionResult(1)));
    await settle();
  });
  return { ...f, previous, areas, filters, mon, alba, calls, requests, headingFocus, snapshot: plan.snapshot, regionResult, settle };
}

test('failed-only Daangn retry keeps cards and other lanes, uses the submitted snapshot and ignores duplicate clicks', async (t) => {
  const f = partialRetryHarness(t);
  assert.equal(typeof f.state.retryFailedDaangn, 'function', 'Partial results need a distinct failed-neighborhood retry path.');
  f.state.retryFailedDaangn();
  assert.deepEqual(f.headingFocus, [{ preventScroll: true, stateAtFocus: 'done' }]);
  assert.equal(f.state.lanes[1].state, 'loading');
  assert.equal(f.state.lanes[1].retryingFailed, true);
  assert.equal(f.state.lanes[1].result, f.previous);
  assert.equal(f.state.lanes[0], f.mon);
  assert.equal(f.state.lanes[2], f.alba);
  assert.equal(f.state.filters, f.filters);
  assert.equal(f.state.query, '편의점');
  assert.deepEqual(f.state.daangnAreas, [f.areas[1]]);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].snapshot, f.snapshot);
  assert.equal(f.calls[0].source, 'daangn');
  assert.equal(f.calls[0].options.retryFailedFrom, f.previous);
  assert.equal(f.requests.length, 1, 'The already successful neighborhood must not be fetched again.');
  const params = new URL(f.requests[0].url, 'http://localhost').searchParams;
  assert.equal(params.get('q'), '카페');
  assert.equal(params.get('bname'), '서교동');
  f.state.retryFailedDaangn();
  assert.equal(f.calls.length, 1);
  assert.equal(f.headingFocus.length, 1);

  f.requests[0].resolve(Response.json(f.regionResult(1)));
  await f.settle();
  const lane = f.state.lanes[1];
  assert.equal(lane.state, 'done');
  assert.equal(!!lane.retryingFailed, false);
  assert.equal(lane.result.partial, false);
  assert.deepEqual(lane.result.jobs.map(({ id }) => id), ['fixture-0', 'fixture-1']);
  assert.equal(typeof lane.retryNotice, 'string');
  assert.ok(lane.retryNotice.length);
  assert.equal(f.state.lanes[0], f.mon);
  assert.equal(f.state.lanes[2], f.alba);
  assert.equal(f.state.filters, f.filters);
  assert.deepEqual(f.focus, ['lane-daangn']);
});

test('failed-only retry rejects missing context, raw region entries, partial state or an already loading lane', async (t) => {
  for (const condition of ['snapshot', 'lane', 'entries', 'partial', 'loading']) {
    const f = partialRetryHarness(t);
    if (condition === 'snapshot') f.state.appliedSnapshot = null;
    else if (condition === 'lane') f.state.lanes = [f.mon, f.alba];
    else if (condition === 'entries') f.state.lanes[1].result = { ...f.previous, regionEntries: undefined };
    else if (condition === 'partial') f.state.lanes[1].result = { ...f.previous, partial: false };
    else f.state.lanes[1].state = 'loading';
    const lanes = f.state.lanes;
    f.state.retryFailedDaangn();
    assert.equal(f.state.lanes, lanes, condition);
    assert.equal(f.calls.length, 0, condition);
    assert.deepEqual(f.focus, [], condition);
  }
});

test('failed-only retry timeout restores the previous partial result as a notice, not a failed or empty lane', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = partialRetryHarness(t, { timeoutMs: 100 });
  f.state.retryFailedDaangn();
  f.state.queryInput.focus();
  t.mock.timers.tick(100);
  await f.settle();
  const lane = f.state.lanes[1];
  assert.equal(lane.state, 'done');
  assert.equal(lane.result, f.previous);
  assert.equal(lane.error, undefined);
  assert.equal(!!lane.cancelled, false);
  assert.equal(!!lane.retryingFailed, false);
  assert.match(lane.retryNotice, /조회 시간/);
  assert.equal(f.state.lanes[0], f.mon);
  assert.equal(f.state.lanes[2], f.alba);
  assert.equal(f.state.filters, f.filters);
  assert.deepEqual(f.focus, ['lane-daangn', 'query']);
});

test('cancelling failed-only retry retains previous cards and ignores late retry results without cancelled-lane UI', async (t) => {
  const f = partialRetryHarness(t);
  f.state.retryFailedDaangn();
  f.state.queryInput.focus();
  f.state.cancelSearch();
  const cancelledLane = f.state.lanes[1];
  assert.equal(cancelledLane.state, 'done');
  assert.equal(cancelledLane.result, f.previous);
  assert.equal(!!cancelledLane.cancelled, false);
  assert.equal(!!cancelledLane.retryingFailed, false);
  assert.equal(cancelledLane.error, undefined);
  assert.match(cancelledLane.retryNotice, /중단/);
  for (const request of f.requests) request.resolve(Response.json(f.regionResult(1)));
  await f.settle();
  assert.equal(f.state.lanes[1], cancelledLane);
  assert.equal(f.state.lanes[0], f.mon);
  assert.equal(f.state.lanes[2], f.alba);
  assert.equal(f.state.filters, f.filters);
  assert.equal(f.state.appliedSnapshot, f.snapshot);
  assert.deepEqual(f.focus, ['lane-daangn', 'query']);
});

test('full reset during failed-only retry cannot resurrect its retained result after late responses', async (t) => {
  const f = partialRetryHarness(t);
  f.state.retryFailedDaangn();
  f.state.resetSearch();
  for (const request of f.requests) request.resolve(Response.json(f.regionResult(1)));
  await f.settle();
  assert.equal(f.state.lanes.length, 0);
  assert.equal(f.state.appliedSnapshot, null);
  assert.equal(f.state.submitted, '');
  assert.equal(f.state.query, '');
  assert.deepEqual(f.state.filters, defaultJobFilters());
  assert.deepEqual(f.focus, ['lane-daangn', 'query']);
});

test('a failed neighborhood that fails again keeps original successful jobs and a retry notice', async (t) => {
  const f = partialRetryHarness(t);
  f.state.retryFailedDaangn();
  for (const request of f.requests) request.resolve(new Response('', { status: 503 }));
  await f.settle();
  const lane = f.state.lanes[1];
  assert.equal(lane.state, 'done');
  assert.equal(lane.result.partial, true);
  assert.equal(lane.result.status, 'ok');
  assert.deepEqual(lane.result.jobs.map(({ id }) => id), ['fixture-0']);
  assert.equal(lane.error, undefined);
  assert.equal(!!lane.retryingFailed, false);
  assert.equal(typeof lane.retryNotice, 'string');
  assert.ok(lane.retryNotice.length);
  assert.equal(f.state.lanes[0], f.mon);
  assert.equal(f.state.lanes[2], f.alba);
  assert.deepEqual(f.focus, ['lane-daangn']);
});

function initialMultiHarness(t, { timeoutMs, areaCount = 2 } = {}) {
  const areas = [toSearchArea(AREA), { ...toSearchArea(AREA), bname: '서교동', bcode: '1144012000' },
    { ...toSearchArea(AREA), bname: '합정동', bcode: '1144012200' }].slice(0, areaCount);
  const regionResult = (index, status = 'ok', query = '카페') => ({
    source: 'daangn', status, jobs: status === 'ok' ? [{ id: `initial-${index}`, title: '합성 최초 동네 공고', pay: '시급 13,000원',
      url: `https://jobs.daangn.com/job-posts/initial-${index}` }] : [],
    searchUrl: `https://jobs.daangn.com/s?query=${encodeURIComponent(query)}&regionId=${index + 1}`,
    checkedAt: '2026-09-25T00:00:00.000Z', ...(status === 'unavailable' && { message: '합성 동네 연결 실패' })
  });
  const requests = [];
  const calls = [];
  const tasks = [];
  const filters = { ...defaultJobFilters(), minHourly: 12000 };
  const f = harness({ query: '카페', scope: 'nationwide', address: null, daangnMultiEnabled: true,
    daangnAreas: areas, filters, sortOrder: 'hourly-desc', submitted: '', submittedArea: '',
    requestSearchSource: (snapshot, source, options) => {
      calls.push({ snapshot, source, options });
      const task = requestSearchSource(snapshot, source, { ...options, ...(timeoutMs && { timeoutMs }), fetcher: (url, init) => {
        if (source !== 'daangn') return Promise.resolve(Response.json({ source, status: 'empty', jobs: [],
          searchUrl: source === 'albamon'
            ? `https://www.albamon.com/total-search?keyword=${encodeURIComponent(snapshot.query)}`
            : `https://www.alba.co.kr/search/Search?wsSrchWord=${encodeURIComponent(snapshot.query)}`,
          checkedAt: '2026-09-25T00:00:00.000Z' }));
        const response = deferred();
        requests.push({ ...response, url, signal: init.signal });
        return response.promise;
      } });
      tasks.push(task);
      return task;
    }
  });
  f.state.laneHeadings.daangn = { focus: () => f.focus.push('lane-daangn') };
  const flush = () => new Promise(setImmediate);
  const settle = async () => { await Promise.allSettled(tasks); await flush(); };
  t.after(async () => {
    f.state.cancelSearch();
    for (const request of requests) request.resolve(Response.json(regionResult(1)));
    await settle();
  });
  return { ...f, areas, filters, requests, calls, regionResult, flush, settle };
}

test('cancelling an initial multi-neighborhood search retains completed results and the submitted conditions', async (t) => {
  const f = initialMultiHarness(t);
  const search = f.search();
  assert.equal(f.requests.length, 2);
  f.requests[0].resolve(Response.json(f.regionResult(0)));
  await f.flush();
  const snapshot = f.state.appliedSnapshot;
  const mon = f.state.lanes[0];
  const alba = f.state.lanes[2];
  assert.equal(f.state.lanes[1].state, 'loading');
  assert.equal(f.state.lanes[1].result, undefined, 'Initial progress is not an already committed card collection.');
  assert.equal(f.state.lanes[1].progress.entries.length, 1);
  assert.equal(f.state.lanes[1].progress.total, 2);
  f.state.query = '편의점';
  f.state.daangnAreas = [f.areas[1]];
  f.state.cancelFromButton();
  await search;
  const lane = f.state.lanes[1];
  assert.deepEqual(lane.result?.jobs.map(({ id }) => id), ['initial-0'],
    'A completed neighborhood must not be discarded when another neighborhood is still pending.');
  assert.equal(lane.state, 'done');
  assert.equal(!!lane.cancelled, false);
  assert.equal(lane.error, undefined);
  assert.equal(lane.result.interruption.reason, 'cancelled');
  assert.deepEqual(lane.result.interruption.remainingAreas, [f.areas[1]]);
  assert.equal(f.state.lanes[0], mon);
  assert.equal(f.state.lanes[2], alba);
  assert.deepEqual(Array.from(f.state.lanes, ({ source }) => source), ['albamon', 'daangn', 'alba']);
  assert.equal(f.state.appliedSnapshot, snapshot);
  assert.equal(f.state.filters, f.filters);
  assert.equal(f.state.sortOrder, 'hourly-desc');
  assert.equal(f.state.query, '편의점');
  assert.deepEqual(f.state.daangnAreas, [f.areas[1]]);
  assert.deepEqual(f.focus, ['results']);
});

test('an initial multi-neighborhood timeout retains only completed responses without stealing focus', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = initialMultiHarness(t, { timeoutMs: 100 });
  const search = f.search();
  f.requests[0].resolve(Response.json(f.regionResult(0)));
  await f.flush();
  const snapshot = f.state.appliedSnapshot;
  const mon = f.state.lanes[0];
  const alba = f.state.lanes[2];
  f.state.query = '편의점';
  f.state.daangnAreas = [f.areas[1]];
  f.state.queryInput.focus();
  t.mock.timers.tick(100);
  await search;
  const lane = f.state.lanes[1];
  assert.equal(lane.state, 'done');
  assert.equal(lane.error, undefined);
  assert.equal(!!lane.cancelled, false);
  assert.deepEqual(lane.result.jobs.map(({ id }) => id), ['initial-0']);
  assert.equal(lane.result.interruption.reason, 'timeout');
  assert.deepEqual(lane.result.interruption.remainingAreas, [f.areas[1]]);
  assert.equal(lane.result.regionResults.length, 1, 'A pending neighborhood has no invented status or observation time.');
  assert.equal(lane.result.regionResults[0].checkedAt, f.regionResult(0).checkedAt);
  assert.equal(f.state.lanes[0], mon);
  assert.equal(f.state.lanes[2], alba);
  assert.equal(f.state.appliedSnapshot, snapshot);
  assert.equal(f.state.filters, f.filters);
  assert.equal(f.state.sortOrder, 'hourly-desc');
  assert.equal(f.state.query, '편의점');
  assert.deepEqual(f.focus, ['query']);
  f.requests[1].resolve(Response.json(f.regionResult(1)));
  await f.settle();
  assert.equal(f.state.lanes[1], lane, 'A late response must not turn an interrupted result into an apparently complete search.');
  assert.deepEqual(f.focus, ['query']);
});

test('initial interruption preserves completed empty or failed responses without classifying pending regions as failed', async (t) => {
  for (const status of ['empty', 'unavailable']) {
    const f = initialMultiHarness(t);
    const search = f.search();
    f.requests[0].resolve(Response.json(f.regionResult(0, status)));
    await f.flush();
    f.state.cancelSearch();
    await search;
    const lane = f.state.lanes[1];
    assert.equal(lane.state, 'done', status);
    assert.equal(!!lane.cancelled, false, status);
    assert.equal(lane.error, undefined, status);
    assert.equal(lane.result.status, status);
    assert.deepEqual(lane.result.jobs, []);
    assert.equal(lane.result.regionResults.length, 1);
    assert.equal(lane.result.regionResults[0].status, status);
    assert.equal(lane.result.regionResults[0].checkedAt, f.regionResult(0).checkedAt);
    assert.equal(lane.result.regionEntries.length, 1);
    assert.equal(lane.result.interruption.reason, 'cancelled');
    assert.deepEqual(lane.result.interruption.remainingAreas, [f.areas[1]]);
    assert.equal(f.state.filters, f.filters);
    assert.deepEqual(f.focus, [], 'State-only cancellation must not move focus.');
  }
});

test('interruption before any neighborhood response keeps the original cancellation or timeout state', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const reason of ['cancelled', 'timeout']) {
    const f = initialMultiHarness(t, { timeoutMs: 100 });
    const search = f.search();
    await f.flush();
    const mon = f.state.lanes[0];
    const alba = f.state.lanes[2];
    if (reason === 'cancelled') f.state.cancelSearch();
    else t.mock.timers.tick(100);
    await search;
    const lane = f.state.lanes[1];
    assert.equal(lane.state, 'done');
    assert.equal(lane.result, undefined, 'No response means there is no partial result to invent.');
    if (reason === 'cancelled') {
      assert.equal(lane.cancelled, true);
      assert.equal(lane.error, undefined);
    } else {
      assert.equal(!!lane.cancelled, false);
      assert.match(lane.error, /조회 시간/);
      assert.equal(lane.retryable, true);
    }
    assert.equal(f.state.lanes[0], mon);
    assert.equal(f.state.lanes[2], alba);
    assert.equal(f.state.filters, f.filters);
    assert.deepEqual(f.focus, []);
  }
});

test('old initial progress and responses cannot restore reset results or replace a newer search', async (t) => {
  const f = initialMultiHarness(t);
  const oldSearch = f.search();
  f.requests[0].resolve(Response.json(f.regionResult(0)));
  await f.flush();
  const onOldProgress = f.calls.find(({ source }) => source === 'daangn').options.onProgress;
  assert.equal(typeof onOldProgress, 'function');
  const lateProgress = { total: 2, entries: f.areas.map((area, index) => ({ area, result: f.regionResult(index) })) };
  f.state.resetSearch();
  // Deliberately deliver an already captured callback to verify the page guard,
  // independently of the real transport helper's own abort protection.
  onOldProgress(lateProgress);
  f.requests[1].resolve(Response.json(f.regionResult(1)));
  await oldSearch;
  await f.flush();
  assert.equal(f.state.lanes.length, 0);
  assert.equal(f.state.appliedSnapshot, null);
  assert.equal(f.state.submitted, '');
  assert.deepEqual(f.state.filters, defaultJobFilters());
  assert.deepEqual(f.focus, ['query']);

  Object.assign(f.state, { query: '편의점', scope: 'nationwide', daangnMultiEnabled: true, daangnAreas: f.areas });
  const newSearch = f.search();
  const snapshot = f.state.appliedSnapshot;
  onOldProgress(lateProgress);
  assert.equal(f.state.lanes[1].state, 'loading');
  assert.equal(f.state.lanes[1].progress, undefined);
  assert.equal(f.state.lanes[1].result, undefined);
  assert.equal(f.requests.length, 4);
  // Complete in reverse order; the public result remains in submitted area order.
  f.requests[3].resolve(Response.json(f.regionResult(1, 'ok', '편의점')));
  await f.flush();
  const currentProgress = f.state.lanes[1].progress;
  onOldProgress(lateProgress);
  assert.equal(f.state.lanes[1].progress, currentProgress);
  f.requests[2].resolve(Response.json(f.regionResult(0, 'ok', '편의점')));
  await newSearch;
  assert.equal(f.state.appliedSnapshot, snapshot);
  assert.equal(f.state.submitted, '편의점');
  assert.equal(f.state.lanes[1].result.interruption, undefined);
  assert.deepEqual(f.state.lanes[1].result.jobs.map(({ id }) => id), ['initial-0', 'initial-1']);
  assert.deepEqual(f.focus, ['query']);
});

test('an interrupted mixed result rejects failed-only retry and retries all submitted neighborhoods explicitly', async (t) => {
  const f = initialMultiHarness(t, { areaCount: 3 });
  const search = f.search();
  f.requests[0].resolve(Response.json(f.regionResult(0)));
  f.requests[1].resolve(Response.json(f.regionResult(1, 'unavailable')));
  await f.flush();
  assert.equal(f.requests.length, 3);
  f.state.cancelSearch();
  await search;
  const previous = f.state.lanes[1];
  assert.equal(previous.result.partial, true);
  assert.deepEqual(previous.result.interruption.remainingAreas, [f.areas[2]]);
  const calls = f.calls.length;
  f.state.retryFailedDaangn();
  assert.equal(f.calls.length, calls, 'An interrupted subset must not use the failed-only retry contract.');
  assert.equal(f.state.lanes[1], previous);
  assert.deepEqual(f.focus, []);

  const mon = f.state.lanes[0];
  const alba = f.state.lanes[2];
  const snapshot = f.state.appliedSnapshot;
  f.state.query = '편의점';
  f.state.daangnAreas = [f.areas[2]];
  f.state.retrySource('daangn');
  assert.equal(f.calls.length, calls + 1);
  assert.equal(f.calls.at(-1).snapshot, snapshot);
  assert.equal(f.calls.at(-1).options.retryFailedFrom, undefined);
  assert.equal(f.requests.length, 5, 'The full retry still starts at most two requests concurrently.');
  f.state.retrySource('daangn');
  assert.equal(f.calls.length, calls + 1);
  assert.deepEqual(f.focus, ['lane-daangn']);
  f.requests[3].resolve(Response.json(f.regionResult(0)));
  f.requests[4].resolve(Response.json(f.regionResult(1)));
  await f.flush();
  assert.equal(f.requests.length, 6);
  for (const [index, request] of f.requests.slice(3).entries()) {
    const params = new URL(request.url, 'http://localhost').searchParams;
    assert.equal(params.get('q'), '카페');
    assert.equal(params.get('bname'), f.areas[index].bname);
  }
  f.requests[5].resolve(Response.json(f.regionResult(2)));
  await f.settle();
  assert.equal(f.state.lanes[1].result.interruption, undefined);
  assert.deepEqual(f.state.lanes[1].result.jobs.map(({ id }) => id), ['initial-0', 'initial-1', 'initial-2']);
  assert.equal(f.state.lanes[0], mon);
  assert.equal(f.state.lanes[2], alba);
  assert.equal(f.state.filters, f.filters);
  assert.equal(f.state.sortOrder, 'hourly-desc');
  assert.equal(f.state.query, '편의점');
  assert.deepEqual(f.state.daangnAreas, [f.areas[2]]);
  assert.deepEqual(f.focus, ['lane-daangn']);
});

function watchStopFocus(f) {
  const ownerDocument = { activeElement: null };
  const stopButton = { ownerDocument };
  const moves = [];
  f.state.stopButton = stopButton;
  ownerDocument.activeElement = stopButton;
  f.state.resultsTitle = { focus: (options) => {
    moves.push({ preventScroll: options?.preventScroll,
      loadingAtFocus: f.state.lanes.filter((lane) => lane.state === 'loading').length });
    ownerDocument.activeElement = f.state.resultsTitle;
    f.focus.push('results');
  } };
  return { ownerDocument, stopButton, moves };
}

test('the last natural response moves focus off the stop button before its loading condition disappears', async (t) => {
  const f = retryHarness(t);
  f.state.retrySource('alba');
  const watched = watchStopFocus(f);
  f.requests[0].resolve(f.emptyResponse());
  await f.settle();
  assert.deepEqual(watched.moves, [{ preventScroll: true, loadingAtFocus: 1 }],
    'Focus must leave the focused stop button synchronously before the last loading lane becomes done.');
  assert.equal(watched.ownerDocument.activeElement, f.state.resultsTitle);
  assert.equal(f.state.lanes[1].state, 'done');
  assert.equal(f.state.lanes[1].result.status, 'empty');
  assert.equal(f.state.lanes[0], f.successfulLane);
  assert.equal(f.state.appliedSnapshot, f.snapshot);
  assert.equal(f.state.query, '편의점');
  assert.equal(f.ticks(), 0);
  assert.deepEqual(f.focus, ['lane-alba', 'results']);
});

test('a non-final response keeps stop focus and the final response does not steal a newer input focus', async (t) => {
  const f = retryHarness(t);
  f.state.query = '카페';
  const search = f.search();
  assert.equal(f.requests.length, 2);
  const watched = watchStopFocus(f);
  f.requests[0].resolve(Response.json({ source: 'albamon', status: 'empty', jobs: [],
    searchUrl: 'https://www.albamon.com/total-search?keyword=%EC%B9%B4%ED%8E%98', checkedAt: '2026-09-25T00:00:00.000Z' }));
  await new Promise(setImmediate);
  assert.equal(f.state.lanes[0].state, 'done');
  assert.equal(f.state.lanes[1].state, 'loading');
  assert.deepEqual(watched.moves, []);
  assert.equal(watched.ownerDocument.activeElement, watched.stopButton);
  f.state.queryInput.focus();
  watched.ownerDocument.activeElement = f.state.queryInput;
  f.requests[1].resolve(f.emptyResponse());
  await search;
  assert.equal(f.state.lanes.every((lane) => lane.state === 'done'), true);
  assert.deepEqual(watched.moves, []);
  assert.equal(watched.ownerDocument.activeElement, f.state.queryInput);
  assert.deepEqual(f.focus, ['query']);
});

test('final HTTP failure, retained timeout and failed-only retry outcomes also preserve focused stop-button continuity', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const outcome of ['http', 'initial-timeout', 'retry-success', 'retry-timeout']) {
    const f = outcome === 'http' ? retryHarness(t)
      : outcome === 'initial-timeout' ? initialMultiHarness(t, { timeoutMs: 100 })
        : partialRetryHarness(t, { timeoutMs: 100 });
    let search;
    if (outcome === 'http') f.state.retrySource('alba');
    else if (outcome === 'initial-timeout') {
      search = f.search();
      f.requests[0].resolve(Response.json(f.regionResult(0)));
      await f.flush();
    } else f.state.retryFailedDaangn();
    const watched = watchStopFocus(f);
    const snapshot = f.state.appliedSnapshot;
    const filters = f.state.filters;
    const source = outcome === 'http' ? 'alba' : 'daangn';
    const otherLanes = f.state.lanes.filter((lane) => lane.source !== source);
    if (outcome === 'http') f.requests[0].resolve(new Response('', { status: 503 }));
    else if (outcome === 'retry-success') f.requests[0].resolve(Response.json(f.regionResult(1)));
    else t.mock.timers.tick(100);
    if (search) await search;
    await f.settle();
    const lane = f.state.lanes.find((lane) => lane.source === source);
    assert.deepEqual(watched.moves, [{ preventScroll: true, loadingAtFocus: 1 }], outcome);
    assert.equal(watched.ownerDocument.activeElement, f.state.resultsTitle, outcome);
    assert.equal(lane.state, 'done', outcome);
    assert.equal(f.state.appliedSnapshot, snapshot, outcome);
    assert.equal(f.state.filters, filters, outcome);
    for (const other of otherLanes) assert.equal(f.state.lanes.find((item) => item.source === other.source), other, outcome);
    if (outcome === 'http') { assert.match(lane.error, /503/); assert.equal(lane.retryable, true); }
    else if (outcome === 'initial-timeout') {
      assert.equal(lane.result.interruption.reason, 'timeout');
      assert.deepEqual(lane.result.jobs.map(({ id }) => id), ['initial-0']);
    } else if (outcome === 'retry-timeout') {
      assert.equal(lane.result, f.previous);
      assert.match(lane.retryNotice, /조회 시간/);
      assert.equal(lane.error, undefined);
    } else {
      assert.equal(lane.result.partial, false);
      assert.deepEqual(lane.result.jobs.map(({ id }) => id), ['fixture-0', 'fixture-1']);
    }
  }
});

test('cancelled or reset attempts cannot move stop focus on late responses or settle a newer search', async (t) => {
  const cancelled = retryHarness(t);
  cancelled.state.retrySource('alba');
  const cancelledFocus = watchStopFocus(cancelled);
  cancelled.state.cancelSearch();
  const stoppedLane = cancelled.state.lanes[1];
  cancelled.requests[0].resolve(cancelled.emptyResponse());
  await cancelled.settle();
  assert.deepEqual(cancelledFocus.moves, []);
  assert.equal(cancelled.state.lanes[1], stoppedLane);
  assert.equal(stoppedLane.cancelled, true);
  assert.deepEqual(cancelled.focus, ['lane-alba']);

  const f = retryHarness(t);
  f.state.retrySource('alba');
  const watched = watchStopFocus(f);
  f.state.resetSearch();
  assert.deepEqual(watched.moves, [], 'Reset must retain its existing query-only focus path.');
  assert.deepEqual(f.focus, ['lane-alba', 'query']);
  Object.assign(f.state, { query: '카페', selected: ['alba'], scope: 'nationwide' });
  const currentSearch = f.search();
  const currentLane = f.state.lanes[0];
  const currentSnapshot = f.state.appliedSnapshot;
  // Keep the current stop button focused while the previous attempt settles.
  watched.ownerDocument.activeElement = watched.stopButton;
  f.requests[0].resolve(f.emptyResponse());
  await new Promise(setImmediate);
  assert.deepEqual(watched.moves, []);
  assert.equal(f.state.lanes[0], currentLane);
  assert.equal(currentLane.state, 'loading');
  assert.equal(f.state.appliedSnapshot, currentSnapshot);
  f.requests[1].resolve(f.emptyResponse());
  await currentSearch;
  assert.deepEqual(watched.moves, [{ preventScroll: true, loadingAtFocus: 1 }]);
  assert.equal(f.state.lanes[0].state, 'done');
  assert.equal(f.state.appliedSnapshot, currentSnapshot);
  assert.deepEqual(f.focus, ['lane-alba', 'query', 'results']);
});

// Synthetic lifecycle/controller tests: no browser navigation, storage or network.
// The teardown and capture implementation are extracted from the actual page.
const sessionFields = ['query', 'selected', 'submitted', 'lanes', 'validation', 'scope', 'address',
  'areaLevel', 'daangnMultiEnabled', 'daangnAreas', 'daangnNotice', 'submittedArea', 'sortOrder',
  'filters', 'appliedSnapshot'];
const sessionData = (state) => structuredClone(Object.fromEntries(sessionFields.map((key) => [key, state[key]])));

test('page teardown saves completed results and the unsubmitted draft separately without DOM or request objects', () => {
  const saved = [];
  const plan = createSearchSnapshot({ query: '카페', selected: ['albamon', 'alba'], scope: 'nationwide',
    address: null, areaLevel: 'district', daangnMultiEnabled: false, daangnAreas: [] });
  assert.equal(plan.ok, true);
  const f = harness({ query: '편의점', submitted: '카페', submittedArea: plan.snapshot.label,
    scope: 'nationwide', appliedSnapshot: plan.snapshot, sortOrder: 'hourly-desc',
    filters: { ...defaultJobFilters(), exclude: 'PC' },
    lanes: [{ source: 'albamon', state: 'done', result: { source: 'albamon', status: 'ok',
      jobs: [{ id: 'session-1', title: '합성 카페 공고', url: 'https://www.albamon.com/jobs/detail/123' }],
      searchUrl: 'https://www.albamon.com/total-search?keyword=%EC%B9%B4%ED%8E%98', checkedAt: '2026-09-27T00:00:00.000Z' } },
    { source: 'alba', state: 'done', error: '합성 연결 실패', retryable: true }],
    searchSession: { read: () => undefined, write: (value) => saved.push(structuredClone(value)), clear: () => {} }
  });
  const before = sessionData(f.state);
  f.destroy();
  assert.equal(saved.length, 1, 'Leaving the page must retain the current search session once.');
  assert.deepEqual(saved[0], before);
  assert.deepEqual(Object.keys(saved[0]).sort(), [...sessionFields].sort(), 'Only explicit serializable search data belongs in the session.');
  assert.deepEqual(f.focus, [], 'Navigation teardown must not focus disappearing controls.');
});

test('page teardown cancels a pending source, retains successful lanes and cannot save a late response', async (t) => {
  const f = retryHarness(t);
  const session = createSearchSession();
  f.state.searchSession = session;
  f.state.retrySource('alba');
  const focusBefore = [...f.focus];
  f.destroy();
  const saved = session.read();
  assert.equal(f.requests[0].signal.aborted, true);
  assert.equal(f.state.controllers.size, 0);
  assert.equal(saved.lanes.every((lane) => lane.state === 'done'), true);
  assert.deepEqual(saved.lanes[0], f.successfulLane);
  assert.equal(saved.lanes[1].cancelled, true);
  assert.equal(saved.query, '편의점');
  assert.equal(saved.submitted, '카페');
  assert.equal(saved.appliedSnapshot.fingerprint, f.snapshot.fingerprint);
  f.requests[0].resolve(f.emptyResponse());
  await f.settle();
  assert.deepEqual(session.read(), saved, 'An old response cannot change retained data.');
  assert.deepEqual(sessionData(f.state), saved, 'The destroyed controller also ignores its old response.');
  assert.deepEqual(f.focus, focusBefore);
});

test('page teardown retains completed Daangn progress, including empty or failed responses, without pending regions or late overwrite', async (t) => {
  for (const status of ['ok', 'empty', 'unavailable']) {
    const f = initialMultiHarness(t);
    const session = createSearchSession();
    f.state.searchSession = session;
    const pending = f.search();
    f.requests[0].resolve(Response.json(f.regionResult(0, status)));
    await f.flush();
    const oldProgress = f.calls.find(({ source }) => source === 'daangn').options.onProgress;
    f.state.query = '편의점';
    f.destroy();
    const saved = session.read();
    const lane = saved.lanes.find(({ source }) => source === 'daangn');
    assert.equal(saved.lanes.every((item) => item.state === 'done'), true, status);
    assert.equal(lane.result.status, status);
    assert.equal(lane.result.regionEntries.length, 1, 'The uncompleted region must not become a fabricated failed response.');
    assert.equal(lane.result.interruption.reason, 'cancelled');
    assert.deepEqual(lane.result.interruption.remainingAreas, [f.areas[1]]);
    assert.deepEqual(saved.filters, f.filters);
    assert.equal(saved.sortOrder, 'hourly-desc');
    assert.equal(saved.query, '편의점');
    assert.equal(saved.submitted, '카페');
    assert.deepEqual(saved.lanes.map(({ source }) => source), ['albamon', 'daangn', 'alba']);
    assert.equal(f.requests[1].signal.aborted, true);
    oldProgress({ total: 2, entries: f.areas.map((area, index) => ({ area, result: f.regionResult(index) })) });
    f.requests[1].resolve(Response.json(f.regionResult(1)));
    await pending;
    await f.settle();
    assert.deepEqual(session.read(), saved);
    assert.deepEqual(sessionData(f.state), saved);
    assert.deepEqual(f.focus, []);
  }
});

test('leaving during failed-only retry preserves the original atomic partial result rather than an unfinished retry', async (t) => {
  const f = partialRetryHarness(t);
  const session = createSearchSession();
  f.state.searchSession = session;
  f.state.retryFailedDaangn();
  f.destroy();
  const saved = session.read();
  const lane = saved.lanes.find(({ source }) => source === 'daangn');
  assert.equal(lane.state, 'done');
  assert.deepEqual(lane.result, f.previous);
  assert.equal(lane.retryingFailed, undefined);
  assert.equal(lane.cancelled, undefined);
  assert.match(lane.retryNotice, /중단/);
  assert.deepEqual(saved.lanes[0], f.mon);
  assert.deepEqual(saved.lanes[2], f.alba);
  assert.deepEqual(saved.filters, f.filters);
  assert.equal(f.requests[0].signal.aborted, true);
  f.requests[0].resolve(Response.json(f.regionResult(1)));
  await f.settle();
  assert.deepEqual(session.read(), saved);
  assert.deepEqual(sessionData(f.state), saved);
  assert.deepEqual(f.focus, ['lane-daangn']);
});

test('full reset clears the saved search and later teardown or late responses cannot revive it', async (t) => {
  const f = retryHarness(t);
  const session = createSearchSession();
  f.state.searchSession = session;
  session.write(sessionData(f.state));
  f.state.retrySource('alba');
  f.state.resetSearch();
  assert.equal(session.read() == null, true, 'Reset clears the previous continuation immediately.');
  const reset = sessionData(f.state);
  assert.equal(reset.query, '');
  assert.equal(reset.submitted, '');
  assert.equal(reset.appliedSnapshot, null);
  assert.deepEqual(reset.lanes, []);
  assert.deepEqual(reset.filters, defaultJobFilters());
  f.destroy();
  assert.deepEqual(session.read(), reset, 'Navigating after reset may save only the new empty state.');
  f.requests[0].resolve(f.emptyResponse());
  await f.settle();
  assert.deepEqual(session.read(), reset);
  assert.deepEqual(sessionData(f.state), reset);
  assert.deepEqual(f.focus, ['lane-alba', 'query']);
});
