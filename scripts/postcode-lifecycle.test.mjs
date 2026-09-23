import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createPostcodeSearch } from '../src/lib/postcode.ts';

function fixture(load) {
  const frames = [], states = [], selections = [];
  const element = { replaceChildren() {} };
  const sdk = { Postcode: class {
    constructor(options) { this.options = options; }
    embed() { frames.push(this.options); }
  } };
  const picker = createPostcodeSearch({ load: load || (() => Promise.resolve(sdk)), timeoutMs: 100 });
  const events = { status: (state) => states.push(state), complete: data => selections.push(data) };
  return { frames, states, selections, element, sdk, picker, events };
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

test('a blank iframe retries once, then shows an error instead of remaining blank', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture();
  try {
    await f.picker.open(f.element, f.events);
    t.mock.timers.tick(100);
    assert.equal(f.frames.length, 2);
    assert.deepEqual(f.states, ['loading', 'retrying']);
    // A stale callback from the abandoned iframe must not mark the retry ready.
    f.frames[0].onresize({ width: 500, height: 400 });
    assert.equal(f.states.at(-1), 'retrying');
    t.mock.timers.tick(100);
    assert.equal(f.states.at(-1), 'error');
    t.mock.timers.tick(1000);
    assert.equal(f.frames.length, 2);
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

test('closing discards old callbacks and cancels reconnect timers', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture();
  await f.picker.open(f.element, f.events);
  f.picker.close();
  const before = [...f.states];
  f.frames[0].onresize({ width: 500, height: 400 });
  f.frames[0].oncomplete({ address: 'stale' });
  t.mock.timers.tick(1000);
  assert.deepEqual(f.states, before);
  assert.deepEqual(f.selections, []);
  assert.equal(f.frames.length, 1);
});

test('a ready retry accepts the selected address and does not keep retrying', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture();
  try {
    await f.picker.open(f.element, f.events);
    t.mock.timers.tick(100);
    f.frames[1].onresize({ width: 500, height: 400 });
    f.frames[1].oncomplete({ address: 'selected' });
    t.mock.timers.tick(1000);
    assert.equal(f.states.at(-1), 'ready');
    assert.deepEqual(f.selections, [{ address: 'selected' }]);
    assert.equal(f.frames.length, 2);
  } finally { f.picker.close(); }
});
