import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appHandoffUrl, copyHandoffUrl } from '../src/lib/browser-handoff.ts';

test('app handoff preserves the origin and app path but strips credentials, query and fragment', () => {
  assert.equal(
    appHandoffUrl('https://person:secret@example.com:8443/alba/search?address=private&token=secret#selected'),
    'https://example.com:8443/alba/search'
  );
});

test('invalid, relative and non-HTTP addresses are unavailable without throwing', () => {
  for (const value of ['', 'not a URL', '/alba/search', '//example.com/app', 'javascript:alert(1)', 'data:text/html,private', 'file:///private/app', 'ftp://example.com/app', 'blob:https://example.com/id', 'https://', undefined, null, {}]) {
    assert.equal(appHandoffUrl(value), '', String(value));
  }
});

test('an explicit copy action writes only the sanitized app URL and preserves the clipboard receiver', async () => {
  const clipboard = { value: '', async writeText(value) { this.value = value; } };
  assert.equal(await copyHandoffUrl('http://person:secret@127.0.0.1:5173/app/?query=private#selected', clipboard), 'copied');
  assert.equal(clipboard.value, 'http://127.0.0.1:5173/app/');
});

test('unavailable or rejected clipboard writes return manual without an automatic fallback', async () => {
  for (const clipboard of [null, {}, { writeText: null }, { writeText() { throw new Error('denied'); } }, { async writeText() { throw new Error('denied'); } }, { get writeText() { throw new Error('unavailable'); } }]) {
    assert.equal(await copyHandoffUrl('https://example.com/app', clipboard), 'manual');
  }
});

test('an invalid app URL never overwrites the clipboard or accesses its writer', async () => {
  let accessed = false;
  const clipboard = { get writeText() { accessed = true; return async () => {}; } };
  for (const url of ['', 'not a URL', 'javascript:alert(1)', 'file:///private/app']) {
    assert.equal(await copyHandoffUrl(url, clipboard), 'manual');
  }
  assert.equal(accessed, false);
});

test('HTTP loopback, IPv6, root paths and encoded subpaths remain usable without carrying URL state', () => {
  for (const [input, expected] of [
    ['http://127.0.0.1:5173/?q=%EC%A3%BC%EC%86%8C#draft', 'http://127.0.0.1:5173/'],
    ['http://[::1]:5173/app', 'http://[::1]:5173/app'],
    ['https://EXAMPLE.com:443', 'https://example.com/'],
    ['https://example.com/%ED%95%9C%EA%B8%80/%3F%23?private=yes#state', 'https://example.com/%ED%95%9C%EA%B8%80/%3F%23']
  ]) {
    assert.equal(appHandoffUrl(input), expected);
    const parsed = new URL(appHandoffUrl(input));
    assert.equal(parsed.username + parsed.password + parsed.search + parsed.hash, '');
  }
});

function replaceGlobal(t, name, descriptor) {
  const original = Object.getOwnPropertyDescriptor(globalThis, name);
  Object.defineProperty(globalThis, name, { configurable: true, ...descriptor });
  t.after(() => {
    if (original) Object.defineProperty(globalThis, name, original);
    else delete globalThis[name];
  });
}

test('module import and URL formatting do not access the clipboard; only the requested copy does', async t => {
  let reads = 0;
  const values = [];
  replaceGlobal(t, 'navigator', { get() { reads += 1; return { clipboard: { async writeText(value) { values.push(value); } } }; } });
  const api = await import('../src/lib/browser-handoff.ts?handoff-no-autorun');
  assert.equal(api.appHandoffUrl('https://example.com/app?q=private'), 'https://example.com/app');
  assert.equal(reads, 0);
  assert.deepEqual(values, []);
  assert.equal(await api.copyHandoffUrl('https://example.com/app?q=private'), 'copied');
  assert.deepEqual(values, ['https://example.com/app']);
});

test('missing or inaccessible browser clipboard falls back to manual without permissions or DOM commands', async t => {
  let forbiddenAccesses = 0;
  const unavailable = () => { forbiddenAccesses += 1; throw new Error('No automatic workaround is allowed'); };
  replaceGlobal(t, 'document', { get: unavailable });
  const browser = { get permissions() { return unavailable(); } };
  replaceGlobal(t, 'navigator', { value: browser, writable: true });
  assert.equal(await copyHandoffUrl('https://example.com/app'), 'manual');
  let attempts = 0;
  browser.clipboard = { async writeText() { attempts += 1; throw new Error('denied'); } };
  assert.equal(await copyHandoffUrl('https://example.com/app'), 'manual');
  assert.equal(attempts, 1, 'A rejected write must not trigger another write.');
  Object.defineProperty(browser, 'clipboard', { configurable: true, get() { throw new Error('clipboard getter denied'); } });
  assert.equal(await copyHandoffUrl('https://example.com/app'), 'manual');
  delete globalThis.navigator;
  assert.equal(await copyHandoffUrl('https://example.com/app'), 'manual');
  assert.equal(forbiddenAccesses, 0);
});

test('copied is returned only after the clipboard confirms the write', async () => {
  let complete;
  let settled = false;
  const copy = copyHandoffUrl('https://example.com/app', { writeText: () => new Promise(resolve => { complete = resolve; }) });
  void copy.then(() => { settled = true; });
  await Promise.resolve();
  assert.equal(settled, false);
  complete();
  assert.equal(await copy, 'copied');
});
