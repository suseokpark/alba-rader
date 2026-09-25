import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { createContext, runInContext } from 'node:vm';
import ts from 'typescript';
import { parse } from 'svelte/compiler';
import { activeFilterChips, clearJobFilter, defaultJobFilters } from '../src/lib/filter-jobs.ts';

// Static CSS/template contracts and an actual-handler boundary test only.
// These do not render text, measure document overflow, or exercise native focus
// or screen-reader announcements. Browser layout remains a separate check.
const source = readFileSync(new URL('../src/lib/JobFilters.svelte', import.meta.url), 'utf8');
const component = parse(source, { modern: true });

function walk(node, visit) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) { for (const child of node) walk(child, visit); return; }
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

test('filter feedback declares arbitrary-token wrapping without hiding or truncating the message', () => {
  const style = {};
  walk(component.css, (node) => {
    if (node.type !== 'Rule' || !node.prelude.children.some((selector) => source.slice(selector.start, selector.end).trim() === '.filter-feedback')) return;
    for (const item of node.block.children) {
      if (item.type === 'Declaration') style[item.property] = item.value.trim().toLowerCase();
    }
  });
  assert.equal(style['overflow-wrap'], 'anywhere', 'Feedback needs the same unbroken-token wrapping protection as filter chips.');
  for (const property of ['overflow', 'overflow-x', 'overflow-y']) assert.doesNotMatch(style[property] || '', /hidden|clip/);
  assert.notEqual(style['text-overflow'], 'ellipsis');
  assert.ok(!['nowrap', 'pre'].includes(style['white-space']));
  for (const property of ['line-clamp', '-webkit-line-clamp', 'max-height', 'height']) {
    assert.ok(style[property] === undefined || ['none', 'auto'].includes(style[property]), `${property} must not limit the complete feedback.`);
  }
  assert.notEqual(style.display, 'none');
  assert.notEqual(style.visibility, 'hidden');
});

test('filter feedback remains a visible status region bound directly to its complete message', () => {
  const feedback = [];
  walk(component.fragment, (node) => {
    if (node.type === 'RegularElement' && literalAttribute(node, 'class')?.split(/\s+/).includes('filter-feedback')) feedback.push(node);
  });
  assert.equal(feedback.length, 1);
  assert.equal(literalAttribute(feedback[0], 'role'), 'status');
  assert.equal(attribute(feedback[0], 'hidden'), undefined);
  assert.equal(attribute(feedback[0], 'aria-hidden'), undefined);
  const expression = feedback[0].fragment.nodes.find((node) => node.type === 'ExpressionTag')?.expression;
  assert.equal(expression?.type, 'Identifier');
  assert.equal(expression.name, 'feedback');
});

test('removing a 120-character include chip keeps its complete feedback and focuses the next chip after tick', async () => {
  const handler = component.instance.content.body.find((node) => node.type === 'FunctionDeclaration' && node.id?.name === 'remove');
  assert.ok(handler, 'Execute the real component removal handler, not a copied implementation.');
  const executable = ts.transpileModule(source.slice(handler.start, handler.end), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None }
  }).outputText;
  const include = 'specialtycoffeebaristaparttime'.repeat(4);
  assert.equal(include.length, 120);
  const before = { ...defaultJobFilters(), payType: 'hourly', days: 'weekends', include, exclude: '야간, 배달' };
  const focused = [];
  let finishTick;
  const tick = new Promise((resolve) => { finishTick = resolve; });
  const state = {
    filters: { ...before }, feedback: '', clearJobFilter, tick: () => tick,
    disclosure: { focus: () => focused.push('disclosure') },
    chipList: { querySelectorAll: (selector) => {
      assert.equal(selector, 'button');
      return activeFilterChips(state.filters).map(({ key }) => ({ focus: () => focused.push(key) }));
    } }
  };
  Object.defineProperty(state, 'chips', { get: () => activeFilterChips(state.filters) });
  const context = createContext(state);
  runInContext(executable, context, { timeout: 1000 });
  const pending = context.remove('include');
  assert.equal(state.feedback, `포함 ${include} 조건을 해제했어요.`);
  assert.deepEqual(state.filters, { ...before, include: '' });
  assert.deepEqual(focused, []);
  finishTick();
  await pending;
  assert.deepEqual(focused, ['exclude']);
});
