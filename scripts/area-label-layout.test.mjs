import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { parse } from 'svelte/compiler';

// Static template contracts only: not native select geometry, OS text scaling,
// assistive-technology announcements, or evidence from actual users.
const source = readFileSync(new URL('../src/routes/+page.svelte', import.meta.url), 'utf8');
const component = parse(source, { modern: true });

function walk(node, visit, ancestors = []) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) { for (const child of node) walk(child, visit, ancestors); return; }
  visit(node, ancestors);
  for (const [key, value] of Object.entries(node)) {
    if (!['loc', 'name_loc'].includes(key)) walk(value, visit, [...ancestors, node]);
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

function evaluate(expression, context) {
  assert.ok(expression, 'Expected an actual dynamic template expression.');
  return runInNewContext(`(${source.slice(expression.start, expression.end)})`, context, { timeout: 1000 });
}

const elements = [];
walk(component.fragment, (node, ancestors) => {
  if (node.type === 'RegularElement') elements.push({ node, ancestors });
});
const select = elements.find(({ node }) => node.name === 'select' && literalAttribute(node, 'id') === 'area-level');

test('area options use compact level names without changing choice values or the selected-level binding', () => {
  assert.ok(select);
  const options = elements.filter(({ node, ancestors }) => node.name === 'option' && ancestors.includes(select.node));
  assert.equal(options.length, 1, 'Keep the option template driven by the existing area choices.');
  const option = options[0];
  assert.ok(option.ancestors.some((node) => node.type === 'EachBlock' && node.expression?.name === 'areaChoices'));
  const label = option.node.fragment.nodes.find((node) => node.type === 'ExpressionTag')?.expression;
  assert.equal(label?.type, 'MemberExpression');
  assert.equal(label.object.name, 'areaLevelNames', 'Do not put the full regional label inside the constrained native option.');
  assert.equal(label.computed, true);
  assert.equal(label.property.object?.name, 'choice');
  assert.equal(label.property.property?.name, 'value');
  const value = expressionAttribute(option.node, 'value');
  assert.equal(value?.object?.name, 'choice');
  assert.equal(value?.property?.name, 'value');
  assert.equal(select.node.attributes.find((item) => item.type === 'BindDirective' && item.name === 'value')?.expression?.name, 'areaLevel');
  const areaImport = component.instance.content.body.find((node) => node.type === 'ImportDeclaration' && node.source.value === '$lib/search-area');
  assert.ok(areaImport?.specifiers.some((item) => item.imported?.name === 'areaLevelNames' && item.local.name === 'areaLevelNames'));
});

test('full regional preview stays visible and described only when address mode has a selected address', () => {
  assert.ok(select);
  const preview = elements.find(({ node }) => literalAttribute(node, 'class')?.split(/\s+/).includes('area-preview'));
  assert.ok(preview);
  assert.equal(literalAttribute(preview.node, 'id'), 'area-level-preview');
  assert.ok(elements.some(({ node }) => literalAttribute(node, 'id') === 'area-level-help'));
  let fullLabel;
  walk(preview.node.fragment, (node) => {
    if (node.type === 'CallExpression' && node.callee?.name === 'areaLabel') fullLabel = node;
  });
  assert.deepEqual(fullLabel?.arguments.map((node) => node.name), ['address', 'areaLevel']);
  const condition = preview.ancestors.findLast((node) => node.type === 'IfBlock')?.test;
  const description = expressionAttribute(select.node, 'aria-describedby');
  for (const scope of ['address', 'nationwide']) {
    for (const address of [null, { sido: '경기', sigungu: '수원시 팔달구', bname: '인계동' }]) {
      const visible = scope === 'address' && address !== null;
      assert.equal(Boolean(evaluate(condition, { scope, address })), visible);
      assert.equal(evaluate(description, { scope, address }), visible ? 'area-level-preview area-level-help' : 'area-level-help');
    }
  }
});
