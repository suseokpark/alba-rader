import assert from 'node:assert/strict';
import { test } from 'node:test';

let moduleId = 0;
async function fixture(t) {
  const scripts = [];
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const window = {};
  const document = {
    createElement() { return { remove() { this.removed = true; } }; },
    head: { append(script) { scripts.push(script); } }
  };
  Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: window });
  Object.defineProperty(globalThis, 'document', { configurable: true, writable: true, value: document });
  t.after(() => {
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow); else delete globalThis.window;
    if (previousDocument) Object.defineProperty(globalThis, 'document', previousDocument); else delete globalThis.document;
  });
  const { loadPostcode } = await import(`../src/lib/postcode.ts?loader-test=${++moduleId}`);
  return { scripts, window, document, loadPostcode };
}

test('concurrent SDK requests share one HTTPS script and resolve only with a namespace', async t => {
  const f = await fixture(t);
  const first = f.loadPostcode();
  const second = f.loadPostcode();
  assert.equal(first, second);
  assert.equal(f.scripts.length, 1);
  assert.equal(f.scripts[0].src, 'https://t1.kakaocdn.net/mapjsapi/bundle/postcode/prod/postcode.v2.js');
  f.window.kakao = { Postcode: class {} };
  f.scripts[0].onload();
  assert.equal(await first, f.window.kakao);
  assert.equal(await f.loadPostcode(), f.window.kakao);
  assert.equal(f.scripts.length, 1);
});

test('timed-out script late events cannot clear or settle a newer SDK request', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = await fixture(t);
  const firstRejected = assert.rejects(f.loadPostcode(), /주소 검색/);
  const oldError = f.scripts[0].onerror;
  const oldLoad = f.scripts[0].onload;
  t.mock.timers.tick(12000);
  await firstRejected;
  assert.equal(f.scripts[0].removed, true);
  const second = f.loadPostcode();
  oldError();
  oldLoad();
  assert.equal(f.loadPostcode(), second);
  assert.equal(f.scripts.length, 2);
  f.window.daum = { Postcode: class {} };
  f.scripts[1].onload();
  assert.equal(await second, f.window.daum);
});

test('script load without a namespace fails and permits a fresh manual retry', async t => {
  const f = await fixture(t);
  const firstRejected = assert.rejects(f.loadPostcode(), /주소 검색/);
  f.scripts[0].onload();
  await firstRejected;
  const secondRejected = assert.rejects(f.loadPostcode(), /주소 검색/);
  assert.equal(f.scripts.length, 2);
  f.scripts[1].onerror();
  await secondRejected;
});

test('synchronous script insertion failure does not cache a rejected request', async t => {
  const f = await fixture(t);
  f.document.head.append = () => { throw new Error('insertion denied'); };
  await assert.rejects(f.loadPostcode());
  f.document.head.append = script => f.scripts.push(script);
  const retry = f.loadPostcode();
  assert.equal(f.scripts.length, 1);
  f.window.kakao = { Postcode: class {} };
  f.scripts[0].onload();
  assert.equal(await retry, f.window.kakao);
});
