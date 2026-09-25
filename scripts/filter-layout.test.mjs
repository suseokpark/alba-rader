import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { parse } from 'svelte/compiler';

// Source contracts only. These do not emulate OS text scaling, calculate native
// select geometry, or establish that every option fits in a rendered viewport.
const component = parse(readFileSync(new URL('../src/lib/JobFilters.svelte', import.meta.url), 'utf8'), { modern: true });
const cssSource = `<style>${readFileSync(new URL('../src/app.css', import.meta.url), 'utf8')}</style>`;
const stylesheet = parse(cssSource, { modern: true }).css;

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

function textOf(node) {
  const parts = [];
  walk(node.fragment, (part) => { if (part.type === 'Text') parts.push(part.data); });
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}

const elements = [];
walk(component.fragment, (node, ancestors) => {
  if (node.type === 'RegularElement') elements.push({ node, ancestors });
});
const timeSelect = elements.find(({ node }) => node.name === 'select' && literalAttribute(node, 'id') === 'filter-time');

test('filter column breakpoints declare font-relative em widths while keeping the two-to-one-column progression', () => {
  const breakpoints = [];
  walk(stylesheet, (node, ancestors) => {
    if (node.type !== 'Rule' || !node.prelude.children.some((selector) => cssSource.slice(selector.start, selector.end).trim() === '.filter-grid')) return;
    const columns = node.block.children.find((item) => item.type === 'Declaration' && item.property === 'grid-template-columns');
    const media = ancestors.findLast((item) => item.type === 'Atrule' && item.name === 'media');
    if (!columns || !media) return;
    const condition = media.prelude.match(/^\(\s*max-width\s*:\s*(\d+(?:\.\d+)?)(em|px)\s*\)$/);
    assert.ok(condition, `Unexpected filter-grid media contract: ${media.prelude}`);
    const value = columns.value.replace(/\s+/g, '');
    breakpoints.push({ width: Number(condition[1]), unit: condition[2], columns: value === '1fr' ? 1 : Number(value.match(/^repeat\((\d+),/)?.[1]) });
  });
  assert.deepEqual(breakpoints, [{ width: 53.125, unit: 'em', columns: 2 }, { width: 30, unit: 'em', columns: 1 }]);
});

test('time options put their complete numeric ranges first without changing filter values or unrestricted choices', () => {
  assert.ok(timeSelect);
  const options = timeSelect.node.fragment.nodes.filter((node) => node.type === 'RegularElement' && node.name === 'option');
  assert.deepEqual(options.map((node) => literalAttribute(node, 'value')), ['all', 'morning', 'afternoon', 'evening', 'overnight', 'negotiable']);
  const expected = new Map([
    ['morning', ['06', '12', '오전']], ['afternoon', ['12', '18', '오후']],
    ['evening', ['18', '24', '저녁']], ['overnight', ['00', '06', '새벽']]
  ]);
  for (const option of options) {
    const value = literalAttribute(option, 'value');
    if (value === 'all') { assert.equal(textOf(option), '전체'); continue; }
    if (value === 'negotiable') { assert.equal(textOf(option), '시간 협의'); continue; }
    const range = textOf(option).match(/^(\d{2})[–-](\d{2})시\s*·\s*(오전|오후|저녁|새벽)$/);
    assert.ok(range, `${value} needs a compact numeric-first range, not a leading start-time phrase.`);
    assert.deepEqual(range.slice(1), expected.get(value));
  }
});

test('the compact time control retains its start-time label, current value binding and linked explanation', () => {
  assert.ok(timeSelect);
  const label = timeSelect.ancestors.findLast((node) => node.type === 'RegularElement' && node.name === 'label');
  assert.ok(label);
  assert.equal(literalAttribute(label, 'for'), 'filter-time');
  assert.equal(label.fragment.nodes.filter((node) => node.type === 'Text').map((node) => node.data).join('').trim(), '근무 시작 시간대');
  const binding = attribute(timeSelect.node, 'value')?.value?.expression;
  assert.equal(binding?.type, 'MemberExpression');
  assert.equal(binding.object.name, 'filters');
  assert.equal(binding.property.name, 'time');
  assert.ok(attribute(timeSelect.node, 'onchange'));
  assert.ok(literalAttribute(timeSelect.node, 'aria-describedby')?.split(/\s+/).includes('filter-schedule-help'));
  const help = elements.find(({ node }) => literalAttribute(node, 'id') === 'filter-schedule-help')?.node;
  assert.ok(help);
  assert.match(textOf(help), /시작 시각/);
});
