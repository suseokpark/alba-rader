import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createPostcodeSearch } from '../src/lib/postcode.ts';

function fixture(load) {
  const frames = [], states = [], selections = [];
  let clearCount = 0;
  const element = { replaceChildren() { clearCount += 1; } };
  const sdk = { Postcode: class {
    constructor(options) { this.options = options; }
    embed() { frames.push(this.options); }
  } };
  const picker = createPostcodeSearch({ load: load || (() => Promise.resolve(sdk)), timeoutMs: 100 });
  const events = { status: (state) => states.push(state), complete: data => selections.push(data) };
  return { frames, states, selections, element, sdk, picker, events, get clearCount() { return clearCount; } };
}

test('SDK script load does not mean the address iframe is ready', async () => {
  const f = fixture();
  try {
    await f.picker.open(f.element, f.events);
    assert.deepEqual(f.states, ['loading']);
    f.frames[0].onresize({ width: 500, height: 400 });
    assert.deepEqual(f.states, ['loading', 'ready']);
  } finally { f.picker.close(); }
});

test('missing readiness signals show delay without replacing or hiding the iframe', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture();
  try {
    await f.picker.open(f.element, f.events);
    const initialClears = f.clearCount;
    t.mock.timers.tick(100);
    assert.equal(f.frames.length, 1);
    assert.deepEqual(f.states, ['loading', 'delayed']);
    t.mock.timers.tick(1000);
    assert.equal(f.frames.length, 1);
    assert.equal(f.clearCount, initialClears);
    assert.deepEqual(f.states, ['loading', 'delayed']);
  } finally { f.picker.close(); }
});

test('close and reopen while the SDK loads creates only the latest iframe', async () => {
  let resolveSdk;
  const pending = new Promise(resolve => { resolveSdk = resolve; });
  const f = fixture(() => pending);
  try {
    const first = f.picker.open(f.element, f.events);
    f.picker.close();
    const second = f.picker.open(f.element, f.events);
    resolveSdk(f.sdk);
    await Promise.all([first, second]);
    assert.equal(f.frames.length, 1);
  } finally { f.picker.close(); }
});

test('closing discards old callbacks and cancels delay timers', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture();
  await f.picker.open(f.element, f.events);
  f.picker.close();
  const before = [...f.states];
  f.frames[0].onresize({ width: 500, height: 400 });
  f.frames[0].onsearch({ q: 'test', count: 1 });
  f.frames[0].oncomplete({ address: 'stale' });
  t.mock.timers.tick(1000);
  assert.deepEqual(f.states, before);
  assert.deepEqual(f.selections, []);
  assert.equal(f.frames.length, 1);
});

test('a delayed iframe can still become ready and return its selected address', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture();
  try {
    await f.picker.open(f.element, f.events);
    t.mock.timers.tick(100);
    f.frames[0].onresize({ width: 500, height: 400 });
    f.frames[0].oncomplete({ address: 'selected' });
    t.mock.timers.tick(1000);
    assert.equal(f.states.at(-1), 'ready');
    assert.deepEqual(f.selections, [{ address: 'selected' }]);
    assert.equal(f.frames.length, 1);
  } finally { f.picker.close(); }
});

test('only manual retry replaces the iframe and ignores old frame callbacks', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture();
  try {
    await f.picker.open(f.element, f.events);
    t.mock.timers.tick(100);
    await f.picker.open(f.element, f.events);
    assert.equal(f.frames.length, 2);
    f.frames[0].onresize({ width: 500, height: 400 });
    f.frames[0].onsearch({ q: 'old', count: 3 });
    f.frames[0].oncomplete({ address: 'old' });
    assert.deepEqual(f.states, ['loading', 'delayed', 'loading']);
    assert.deepEqual(f.selections, []);
    f.frames[1].onsearch({ q: 'new', count: 0 });
    f.frames[1].oncomplete({ address: 'new' });
    t.mock.timers.tick(1000);
    assert.equal(f.states.at(-1), 'ready');
    assert.deepEqual(f.selections, [{ address: 'new' }]);
  } finally { f.picker.close(); }
});

test('zero search results are a valid functional readiness signal without resize', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture();
  try {
    await f.picker.open(f.element, f.events);
    f.frames[0].onsearch({ q: 'no matching address', count: 0 });
    t.mock.timers.tick(1000);
    assert.deepEqual(f.states, ['loading', 'ready']);
  } finally { f.picker.close(); }
});

test('invalid resize values cannot mark an iframe ready', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture();
  try {
    await f.picker.open(f.element, f.events);
    for (const size of [null, undefined, {}, { width: NaN, height: NaN }, { width: Infinity, height: 400 }, { width: 500, height: 0 }, { width: -1, height: 400 }, { width: '500', height: 400 }]) {
      f.frames[0].onresize(size);
    }
    t.mock.timers.tick(100);
    assert.deepEqual(f.states, ['loading', 'delayed']);
    f.frames[0].onresize({ width: 500, height: 400 });
    assert.equal(f.states.at(-1), 'ready');
  } finally { f.picker.close(); }
});

test('invalid search callback values cannot mark an iframe ready', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture();
  try {
    await f.picker.open(f.element, f.events);
    for (const data of [null, undefined, {}, { q: 'test', count: NaN }, { q: 'test', count: -1 }, { q: 'test', count: 0.5 }, { q: 'test', count: '0' }]) {
      f.frames[0].onsearch(data);
    }
    t.mock.timers.tick(100);
    assert.deepEqual(f.states, ['loading', 'delayed']);
  } finally { f.picker.close(); }
});

test('completion before resize works once and ends all callbacks for that session', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture();
  try {
    await f.picker.open(f.element, f.events);
    f.frames[0].oncomplete({ address: 'chosen' });
    f.frames[0].oncomplete({ address: 'duplicate' });
    f.frames[0].onresize({ width: 500, height: 400 });
    f.frames[0].onsearch({ q: 'late', count: 1 });
    t.mock.timers.tick(1000);
    assert.deepEqual(f.selections, [{ address: 'chosen' }]);
    assert.deepEqual(f.states, ['loading']);
  } finally { f.picker.close(); }
});

test('SDK failure is an error, not iframe delay, and can be retried manually', async () => {
  let succeed = false;
  const f = fixture(async () => { if (!succeed) throw new Error('SDK blocked'); return f.sdk; });
  try {
    await f.picker.open(f.element, f.events);
    assert.deepEqual(f.states, ['loading', 'error']);
    assert.equal(f.frames.length, 0);
    succeed = true;
    await f.picker.open(f.element, f.events);
    f.frames[0].onresize({ width: 500, height: 400 });
    assert.equal(f.states.at(-1), 'ready');
  } finally { f.picker.close(); }
});

test('an embed exception clears the unusable frame and ignores its callbacks', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let callbacks;
  const f = fixture(async () => ({ Postcode: class {
    constructor(options) { callbacks = options; }
    embed() { throw new Error('embed failed'); }
  } }));
  try {
    await f.picker.open(f.element, f.events);
    assert.deepEqual(f.states, ['loading', 'error']);
    callbacks.onresize({ width: 500, height: 400 });
    callbacks.oncomplete({ address: 'late' });
    t.mock.timers.tick(1000);
    assert.deepEqual(f.states, ['loading', 'error']);
    assert.deepEqual(f.selections, []);
  } finally { f.picker.close(); }
});
