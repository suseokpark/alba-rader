import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { createContext, runInContext } from 'node:vm';
import ts from 'typescript';
import { parse } from 'svelte/compiler';
import { activeFilterChips, clearJobFilter, defaultJobFilters, filterJobs, updateJobFilters } from '../src/lib/filter-jobs.ts';

// Static input contracts plus actual component handlers and real filter helpers.
// Synthetic currentTarget values bypass native maxlength: these tests do not
// reproduce trusted typing, clipboard input, OS IME, DOM rendering or focus.
// The native-keypress regression remains a separate browser observation.
const source = readFileSync(new URL('../src/lib/JobFilters.svelte', import.meta.url), 'utf8');
const component = parse(source, { modern: true });

function walk(node, visit) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) { node.forEach((child) => walk(child, visit)); return; }
  visit(node);
  for (const [key, value] of Object.entries(node)) {
    if (!['loc', 'name_loc'].includes(key)) walk(value, visit);
  }
}

function attribute(node, name) {
  return node.attributes.find((item) => item.type === 'Attribute' && item.name === name);
}

function literalAttribute(node, name) {
  const value = attribute(node, name)?.value;
  return Array.isArray(value) && value.every((part) => part.type === 'Text')
    ? value.map((part) => part.data).join('') : undefined;
}

function expressionAttribute(node, name) {
  const value = attribute(node, name)?.value;
  return Array.isArray(value) && value.length === 1 ? value[0].expression : value?.expression;
}

const inputs = new Map();
walk(component.fragment, (node) => {
  if (node.type !== 'RegularElement' || node.name !== 'input') return;
  for (const key of ['include', 'exclude']) {
    if (literalAttribute(node, 'id') === `filter-${key}`) inputs.set(key, node);
  }
});

function harness(initial = defaultJobFilters()) {
  const handlers = ['change', 'remove', 'reset'].map((name) => {
    const node = component.instance.content.body.find((item) => item.type === 'FunctionDeclaration' && item.id?.name === name);
    assert.ok(node, `Execute the real component ${name} handler.`);
    return source.slice(node.start, node.end);
  });
  const state = {
    filters: initial, feedback: '이전 필터 안내', updateJobFilters, clearJobFilter, defaultJobFilters,
    tick: async () => {}, disclosure: { focus() {} }, chipList: undefined
  };
  Object.defineProperty(state, 'chips', { get: () => activeFilterChips(state.filters) });
  const context = createContext(state);
  runInContext(ts.transpileModule(handlers.join('\n'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None }
  }).outputText, context, { timeout: 1000 });
  return {
    state,
    input(key, value) {
      const node = inputs.get(key);
      assert.ok(node);
      const expression = expressionAttribute(node, 'oninput');
      assert.ok(expression, 'Execute the actual input callback, not a copied change call.');
      const callback = runInContext(`(${source.slice(expression.start, expression.end)})`, context, { timeout: 1000 });
      const target = { value };
      callback({ currentTarget: target });
      assert.equal(target.value, value, 'The handler must not rewrite the input target.');
      const binding = expressionAttribute(node, 'value');
      assert.ok(binding);
      return runInContext(`(${source.slice(binding.start, binding.end)})`, context, { timeout: 1000 });
    },
    remove: (key) => context.remove(key),
    reset: () => context.reset()
  };
}

const job = (id, title, company) => Object.freeze({ id, title, url: `https://example.invalid/${id}`, ...(company && { company }) });
const ids = (jobs, filters) => filterJobs(jobs, filters).map(({ job }) => job.id);
const longPrefix = '주말,'.repeat(40);

test('local include and exclude inputs do not impose silent native truncation and retain their shared explanation', () => {
  assert.equal(inputs.size, 2);
  const truncating = [...inputs].filter(([, node]) => attribute(node, 'maxlength') !== undefined).map(([key]) => key);
  assert.deepEqual(truncating, [], 'Both local keyword inputs must accept the complete condition instead of stopping at 120 code units.');
  for (const node of inputs.values()) {
    assert.ok(literalAttribute(node, 'aria-describedby')?.split(/\s+/).includes('filter-keywords-help'));
    assert.ok(expressionAttribute(node, 'value'));
    assert.ok(expressionAttribute(node, 'oninput'));
  }
});

test('actual input handlers retain 119, 120 and 121 code units, emoji and raw spacing without changing other filters', () => {
  const values = [
    ...[119, 120, 121].map((length) => '가'.repeat(length)),
    '😀'.repeat(59) + '가', '😀'.repeat(60), '😀'.repeat(60) + '가',
    '  ＰＣ，주말 😀  '
  ];
  assert.deepEqual(values.slice(0, 6).map((value) => value.length), [119, 120, 121, 119, 120, 121]);
  for (const key of ['include', 'exclude']) {
    const other = key === 'include' ? 'exclude' : 'include';
    for (const value of values) {
      const initial = Object.freeze({ ...defaultJobFilters(), payType: 'hourly', minHourly: 12000,
        days: 'weekends', time: 'evening', includeUnknownSchedule: true, [other]: '유지할 조건' });
      const before = { ...initial };
      const f = harness(initial);
      assert.equal(f.input(key, value), value, `${key}: the real value expression must reflect every input character.`);
      assert.deepEqual(f.state.filters, { ...before, [key]: value });
      assert.deepEqual(initial, before, 'The original bound object must not be mutated.');
      assert.equal(f.state.feedback, '', 'A new edit clears the previous action message.');
    }
  }
});

test('a final include token beyond 120 code units is required by the real AND filter and appears in its chip', () => {
  assert.equal(longPrefix.length, 120);
  const jobs = Object.freeze([
    job('both-title', '주말 PC 카페'), job('weekend-only', '주말 카페'),
    job('pc-only', 'PC 카페'), job('both-company', '카페', '주말 PC')
  ]);
  const f = harness();
  f.input('include', longPrefix);
  assert.deepEqual(ids(jobs, f.state.filters), ['both-title', 'weekend-only', 'both-company']);
  f.input('include', `${longPrefix}PC`);
  assert.deepEqual(ids(jobs, f.state.filters), ['both-title', 'both-company']);
  assert.equal(f.state.filters.include, `${longPrefix}PC`);
  assert.deepEqual(activeFilterChips(f.state.filters), [{ key: 'include', label: '포함 주말, pc' }]);
  assert.equal(filterJobs(jobs, f.state.filters)[0].job, jobs[0], 'Filtering retains original job objects.');
});

test('a final exclude token beyond 120 code units is honored by the real OR filter and appears in its chip', () => {
  const jobs = Object.freeze([
    job('both', '주말 PC 카페'), job('weekend-only', '주말 카페'), job('pc-only', 'PC 카페'),
    job('neither', '카페'), job('pc-company', '카페', 'PC 전문점')
  ]);
  const f = harness();
  f.input('exclude', longPrefix);
  assert.deepEqual(ids(jobs, f.state.filters), ['pc-only', 'neither', 'pc-company']);
  f.input('exclude', `${longPrefix}PC`);
  assert.deepEqual(ids(jobs, f.state.filters), ['neither']);
  assert.equal(f.state.filters.exclude, `${longPrefix}PC`);
  assert.deepEqual(activeFilterChips(f.state.filters), [{ key: 'exclude', label: '제외 주말, pc' }]);
});

test('clearing a long keyword input and removing the other chip restore the corresponding loaded listings', async () => {
  const jobs = Object.freeze([
    job('both', '주말 PC 카페'), job('weekend-only', '주말 카페'), job('night', '야간 카페')
  ]);
  const exclude = `${'없는단어,'.repeat(25)}야간`;
  assert.ok(exclude.length > 120);
  const f = harness();
  f.input('include', `${longPrefix}PC`);
  f.input('exclude', exclude);
  assert.deepEqual(ids(jobs, f.state.filters), ['both']);
  assert.equal(f.input('include', ''), '');
  assert.equal(f.state.filters.exclude, exclude, 'Clearing include does not discard the exclude group.');
  assert.deepEqual(ids(jobs, f.state.filters), ['both', 'weekend-only']);
  assert.deepEqual(activeFilterChips(f.state.filters), [{ key: 'exclude', label: '제외 없는단어, 야간' }]);
  await f.remove('exclude');
  assert.deepEqual(f.state.filters, defaultJobFilters());
  assert.deepEqual(activeFilterChips(f.state.filters), []);
  assert.deepEqual(ids(jobs, f.state.filters), ['both', 'weekend-only', 'night']);
});

test('the actual reset handler clears long keywords and other conditions without changing loaded job order', async () => {
  const jobs = Object.freeze([job('second', '주말 카페'), job('first', 'PC 카페'), job('third', '카페')]);
  const f = harness({ ...defaultJobFilters(), payType: 'hourly', minHourly: 15000,
    days: 'weekends', time: 'evening', includeUnknownSchedule: true });
  f.input('include', `${longPrefix}PC`);
  f.input('exclude', `${'없는단어,'.repeat(25)}야간`);
  assert.equal(filterJobs(jobs, f.state.filters).length, 0);
  await f.reset();
  assert.deepEqual(f.state.filters, defaultJobFilters());
  assert.deepEqual(activeFilterChips(f.state.filters), []);
  assert.deepEqual(ids(jobs, f.state.filters), ['second', 'first', 'third']);
  assert.ok(filterJobs(jobs, f.state.filters).every(({ job }, index) => job === jobs[index]));
  assert.match(f.state.feedback, /필터를 모두 초기화/);
});
