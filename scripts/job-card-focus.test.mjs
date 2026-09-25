import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { parse } from 'svelte/compiler';

// Static CSS declaration contracts only. They do not render focus outlines,
// reproduce clipping geometry, or establish native keyboard visibility.
const source = `<style>${readFileSync(new URL('../src/app.css', import.meta.url), 'utf8')}</style>`;
const stylesheet = parse(source, { modern: true }).css;

function walk(node, visit, ancestors = []) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) { for (const child of node) walk(child, visit, ancestors); return; }
  visit(node, ancestors);
  for (const [key, value] of Object.entries(node)) {
    if (!['loc', 'name_loc'].includes(key)) walk(value, visit, [...ancestors, node]);
  }
}

function declarationsFor(selectorText) {
  const style = {};
  walk(stylesheet, (node, ancestors) => {
    if (node.type !== 'Rule' || ancestors.some((item) => item.type === 'Atrule')) return;
    if (!node.prelude.children.some((selector) => source.slice(selector.start, selector.end).replace(/\s+/g, ' ').trim() === selectorText)) return;
    for (const item of node.block.children) {
      if (item.type === 'Declaration') style[item.property] = item.value.trim().toLowerCase();
    }
  });
  return style;
}

test('job-card links declare a scoped inward focus offset at least as deep as the global outline width', () => {
  const global = declarationsFor('a:focus-visible');
  const scoped = declarationsFor('.job-card a:focus-visible');
  const width = Number.parseFloat(global['outline-width'] || global.outline);
  assert.ok(Number.isFinite(width) && width > 0);
  assert.match(scoped['outline-offset'] || '', /^-\d+(?:\.\d+)?px$/, 'The clipped card needs an explicit inset focus offset.');
  assert.ok(Number.parseFloat(scoped['outline-offset']) <= -width);
  for (const property of ['outline', 'outline-width', 'outline-style', 'outline-color']) {
    assert.equal(scoped[property], undefined, 'The card override should retain the global focus outline, not suppress or recolour it.');
  }
});

test('global link focus keeps the existing 3px solid brown outline and outward offset for non-card links', () => {
  const global = declarationsFor('a:focus-visible');
  assert.match(global.outline || '', /^3px\s+solid\s+/);
  assert.equal(global['outline-color'], '#925121');
  assert.equal(global['outline-offset'], '4px');
});
