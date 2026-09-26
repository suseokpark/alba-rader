import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { defaultJobFilters } from '../src/lib/filter-jobs.ts';
import { sources } from '../src/lib/search.ts';
import { createSearchSnapshot } from '../src/lib/search-request.ts';

// Synthetic in-memory session contracts only: no browser, persistent storage,
// real listings or external requests. A missing module is a test assertion.
const moduleUrl = new URL('../src/lib/search-session.ts', import.meta.url);
const sessionModule = existsSync(moduleUrl) ? await import(moduleUrl.href) : {};
function createSession() {
  assert.equal(typeof sessionModule.createSearchSession, 'function', 'The actual session factory must exist.');
  return sessionModule.createSearchSession();
}
const fixture = () => ({
  query: '편의점', selected: ['albamon'], submitted: '카페',
  lanes: [{ source: 'albamon', state: 'done', result: { source: 'albamon', status: 'ok',
    jobs: [{ id: 'session-1', title: '합성 카페 공고', url: 'https://www.albamon.com/jobs/detail/123' }],
    searchUrl: 'https://www.albamon.com/total-search?keyword=%EC%B9%B4%ED%8E%98', checkedAt: '2026-09-27T00:00:00.000Z' } }],
  validation: '', scope: 'nationwide', address: null, areaLevel: 'district',
  daangnMultiEnabled: false, daangnAreas: [], daangnNotice: '', submittedArea: '전국',
  sortOrder: 'hourly-desc', filters: { ...defaultJobFilters(), exclude: 'PC' }, appliedSnapshot: null
});

test('session write and read return independent deep copies of the full current search state', () => {
  const session = createSession();
  assert.equal(session.read() == null, true);
  const input = fixture();
  const expected = structuredClone(input);
  session.write(input);
  input.query = '원본 변경';
  input.filters.exclude = '';
  input.lanes[0].result.jobs[0].title = '원본 변경';
  const first = session.read();
  assert.deepEqual(first, expected);
  first.selected.push('alba');
  first.filters.exclude = '반환값 변경';
  first.lanes[0].result.jobs.length = 0;
  assert.deepEqual(session.read(), expected);
});

test('separate session factories are isolated and clearing one cannot clear another', () => {
  const first = createSession();
  const second = createSession();
  first.write(fixture());
  assert.equal(second.read() == null, true);
  const secondState = { ...fixture(), query: '서빙' };
  second.write(secondState);
  first.clear();
  assert.equal(first.read() == null, true);
  assert.deepEqual(second.read(), secondState);
  first.write({ ...fixture(), query: '물류' });
  assert.equal(second.read().query, '서빙');
});

function componentAst(relativePath) {
  const url = new URL(relativePath, import.meta.url);
  const page = readFileSync(url, 'utf8');
  const script = page.match(/<script\b[^>]*>([\s\S]*?)<\/script>/)?.[1];
  assert.ok(script);
  return ts.createSourceFile(url.pathname, script, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

function pageInitialState(session) {
  const ast = componentAst('../src/routes/+page.svelte');
  const fields = Object.keys(fixture());
  const required = ['searchSession', 'restored', ...fields];
  const statements = ast.statements.filter((node) => ts.isVariableStatement(node)
    && node.declarationList.declarations.some((item) => ts.isIdentifier(item.name) && required.includes(item.name.text)));
  for (const name of required) assert.ok(statements.some((node) => node.declarationList.declarations
    .some((item) => ts.isIdentifier(item.name) && item.name.text === name)), `Actual page initializer ${name} must exist.`);
  const executable = ts.transpileModule(`${statements.map((node) => node.getText(ast)).join('\n')}\n({ ${fields.join(', ')} });`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None }
  }).outputText;
  return structuredClone(runInNewContext(executable, {
    SEARCH_SESSION: sessionModule.SEARCH_SESSION,
    getContext: (key) => { assert.equal(key, sessionModule.SEARCH_SESSION); return session; },
    $state: (value) => value, sources, defaultJobFilters
  }, { timeout: 1000 }));
}

test('actual page data initializers restore draft, submitted snapshot, address, separate areas, results and presentation filters', () => {
  const session = createSession();
  const area = { sido: '서울', sigungu: '마포구', bname: '동교동', bcode: '1144012100', sigunguCode: '11440' };
  const state = { ...fixture(), address: { ...area, address: '서울 마포구 양화로 지하160', zonecode: '04050' },
    selected: ['albamon', 'daangn', 'alba'], scope: 'address', areaLevel: 'neighborhood',
    daangnMultiEnabled: true, daangnAreas: [area], daangnNotice: '합성 미적용 동네 안내',
    validation: '합성 미제출 오류', submittedArea: '합성 제출 지역', filters: { ...defaultJobFilters(), minHourly: 12000, exclude: 'PC' }
  };
  const plan = createSearchSnapshot({ ...state, query: '카페' });
  assert.equal(plan.ok, true);
  state.appliedSnapshot = plan.snapshot;
  session.write(state);
  const restored = pageInitialState(session);
  assert.deepEqual(restored, state);
  restored.address.zonecode = '변경';
  restored.daangnAreas[0].bname = '변경';
  restored.appliedSnapshot.requests[0].options.area.bname = '변경';
  assert.deepEqual(pageInitialState(session), state, 'A second instance starts from an independent copy.');
  session.clear();
  const fresh = pageInitialState(session);
  assert.equal(fresh.query, '');
  assert.equal(fresh.submitted, '');
  assert.equal(fresh.address, null);
  assert.equal(fresh.appliedSnapshot, null);
  assert.equal(fresh.scope, 'address');
  assert.equal(fresh.areaLevel, 'district');
  assert.equal(fresh.sortOrder, 'source');
  assert.equal(fresh.daangnMultiEnabled, false);
  assert.deepEqual(fresh.selected, sources.map(({ id }) => id));
  assert.deepEqual(fresh.lanes, []);
  assert.deepEqual(fresh.daangnAreas, []);
  assert.deepEqual(fresh.filters, defaultJobFilters());
});

test('the actual root layout creates a new context session for each independent instance', () => {
  const ast = componentAst('../src/routes/+layout.svelte');
  const registrations = ast.statements.filter((node) => ts.isExpressionStatement(node)
    && ts.isCallExpression(node.expression) && node.expression.expression.getText(ast) === 'setContext');
  assert.ok(registrations.length, 'The layout must establish the actual page context boundary.');
  const executable = ts.transpileModule(registrations.map((node) => node.getText(ast)).join('\n'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None }
  }).outputText;
  const instantiate = () => {
    const context = new Map();
    runInNewContext(executable, { setContext: (key, value) => context.set(key, value),
      createSearchSession: sessionModule.createSearchSession, SEARCH_SESSION: sessionModule.SEARCH_SESSION }, { timeout: 1000 });
    return context.get(sessionModule.SEARCH_SESSION);
  };
  const first = instantiate();
  const second = instantiate();
  assert.notEqual(first, second, 'Separate layout/SSR instances must not share one mutable singleton.');
  first.write(fixture());
  assert.equal(second.read() == null, true);
  assert.deepEqual(pageInitialState(first), fixture());
  assert.deepEqual(pageInitialState(second).lanes, []);
});
