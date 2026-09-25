import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { parse } from 'svelte/compiler';

// Actual template expressions and CSS declaration contracts only. These tests
// do not render cards, measure column widths/overflow, or establish mobile
// geometry, keyboard behavior or screen-reader reading order in a browser.
const page = readFileSync(new URL('../src/routes/+page.svelte', import.meta.url), 'utf8');
const component = parse(page, { modern: true });
const cssSource = `<style>${readFileSync(new URL('../src/app.css', import.meta.url), 'utf8')}</style>`;
const stylesheet = parse(cssSource, { modern: true }).css;

function walk(node, visit, ancestors = []) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) { for (const item of node) walk(item, visit, ancestors); return; }
  visit(node, ancestors);
  for (const [key, value] of Object.entries(node)) {
    if (!['loc', 'name_loc'].includes(key)) walk(value, visit, [...ancestors, node]);
  }
}

function literalAttribute(node, name) {
  const value = node.attributes.find((item) => item.type === 'Attribute' && item.name === name)?.value;
  return Array.isArray(value) && value.every((item) => item.type === 'Text')
    ? value.map((item) => item.data).join('') : undefined;
}

function classElements(name) {
  const found = [];
  walk(component.fragment, (node) => {
    if (node.type === 'RegularElement' && literalAttribute(node, 'class')?.split(/\s+/).includes(name)) found.push(node);
  });
  return found;
}

function columnExpression() {
  const grids = classElements('result-grid');
  assert.equal(grids.length, 1);
  const directive = grids[0].attributes.find((item) => item.type === 'StyleDirective' && item.name === '--result-columns');
  assert.ok(directive, 'The displayed result lanes must supply their own CSS column count.');
  assert.equal(directive.value.type, 'ExpressionTag');
  return directive.value.expression;
}

test('result columns follow the displayed lane count for one, two and three providers with a one-column empty fallback', () => {
  const expression = columnExpression();
  const evaluate = (context) => runInNewContext(`(${page.slice(expression.start, expression.end)})`, context, { timeout: 1000 });
  for (const count of [0, 1, 2, 3]) {
    const lanes = ['albamon', 'daangn', 'alba'].slice(0, count).map((source) => ({ source, state: 'loading' }));
    assert.equal(evaluate({ lanes }), Math.max(1, count), 'No draft/provider-success/job-count dependency is needed.');
    for (const activeSources of [[], ['albamon'], ['albamon', 'daangn', 'alba']]) {
      assert.equal(evaluate({ lanes, activeSources, selected: activeSources, visibleTotal: 0, total: 0 }), Math.max(1, count));
    }
  }
});

test('loading, failed, cancelled, empty and filtered-empty lanes retain their columns', () => {
  const expression = columnExpression();
  const states = [
    { state: 'loading', visible: [] },
    { state: 'done', error: '합성 연결 실패', visible: [] },
    { state: 'done', cancelled: true, visible: [] },
    { state: 'done', result: { status: 'empty', jobs: [] }, visible: [] },
    { state: 'done', result: { status: 'unavailable', jobs: [] }, visible: [] },
    { state: 'done', result: { status: 'ok', jobs: [{ id: 'synthetic' }] }, visible: [] },
    { state: 'done', result: { status: 'ok', jobs: [{ id: 'synthetic' }] }, visible: [{ id: 'synthetic' }] }
  ];
  for (const count of [1, 2, 3]) {
    for (let offset = 0; offset < states.length; offset++) {
      const lanes = ['albamon', 'daangn', 'alba'].slice(0, count)
        .map((source, index) => ({ source, ...states[(offset + index) % states.length] }));
      const actual = runInNewContext(`(${page.slice(expression.start, expression.end)})`, {
        lanes, activeSources: [], visibleTotal: 0, total: 0, finished: 0, failed: count
      }, { timeout: 1000 });
      assert.equal(actual, count, 'Only mounted provider lanes determine available column space.');
    }
  }
});

test('result lanes keep the keyed displayed collection and are not conditionally removed for provider status', () => {
  const grids = classElements('result-grid');
  assert.equal(grids.length, 1);
  const loops = grids[0].fragment.nodes.filter((node) => node.type === 'EachBlock');
  assert.equal(loops.length, 1);
  const loop = loops[0];
  assert.equal(loop.expression.type, 'Identifier');
  assert.equal(loop.expression.name, 'filteredLanes');
  assert.equal(loop.context.type, 'Identifier');
  assert.equal(loop.context.name, 'lane');
  assert.equal(loop.key?.type, 'MemberExpression');
  assert.equal(loop.key.object.name, 'lane');
  assert.equal(loop.key.property.name, 'source');
  assert.equal(loop.key.computed, false);
  const sections = loop.body.nodes.filter((node) => node.type === 'RegularElement' && node.name === 'section');
  assert.equal(sections.length, 1, 'Every displayed source owns a section outside loading/error/empty branches.');

  const ready = classElements('ready-grid');
  assert.equal(ready.length, 1);
  const readyLoop = ready[0].fragment.nodes.find((node) => node.type === 'EachBlock');
  assert.equal(readyLoop?.expression.type, 'Identifier');
  assert.equal(readyLoop.expression.name, 'sources', 'The initial provider overview remains independent of result lanes.');
  assert.equal(ready[0].attributes.some((item) => item.type === 'StyleDirective' && item.name === '--result-columns'), false);
});

function columnRules(selector) {
  const rules = [];
  walk(stylesheet, (node, ancestors) => {
    if (node.type !== 'Rule' || !node.prelude.children.some((item) => cssSource.slice(item.start, item.end).trim() === selector)) return;
    const media = ancestors.findLast((item) => item.type === 'Atrule' && item.name === 'media');
    for (const declaration of node.block.children) {
      if (declaration.type === 'Declaration' && declaration.property === 'grid-template-columns') {
        rules.push({ start: declaration.start, media: media?.prelude.replace(/\s+/g, '') ?? null,
          value: declaration.value.replace(/\s+/g, '') });
      }
    }
  });
  return rules;
}

test('desktop uses the result count while the later mobile rule remains one column and ready cards stay three columns', () => {
  const resultRules = columnRules('.result-grid');
  const desktop = resultRules.filter((rule) => rule.media === null).at(-1);
  assert.ok(desktop);
  assert.equal(desktop.value, 'repeat(var(--result-columns,3),minmax(0,1fr))');
  const mobile = resultRules.filter((rule) => rule.media === '(max-width:680px)').at(-1);
  assert.ok(mobile);
  assert.equal(mobile.value, '1fr');
  assert.ok(desktop.start < mobile.start, 'The same-specificity mobile rule must follow the dynamic desktop declaration.');
  assert.ok(resultRules.every((rule) => rule.start <= mobile.start), 'A later column declaration must not silently override mobile.');
  const grid = classElements('result-grid')[0];
  assert.equal(grid.attributes.some((item) => item.type === 'Attribute' && item.name === 'style'
    || item.type === 'StyleDirective' && item.name === 'grid-template-columns'), false,
  'Use an inline custom property, not inline columns that would defeat the mobile stylesheet rule.');

  const readyRules = columnRules('.ready-grid');
  assert.equal(readyRules.filter((rule) => rule.media === null).at(-1)?.value, 'repeat(3,minmax(0,1fr))');
  assert.equal(readyRules.filter((rule) => rule.media === '(max-width:680px)').at(-1)?.value, '1fr');
});
