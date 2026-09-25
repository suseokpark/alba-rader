import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { parse } from 'svelte/compiler';

// Static CSS contracts only. These do not emulate reduced motion, measure
// transition frames or prove rendered focus-ring clearance in a browser.
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

function rulesFor(selector) {
  const rules = [];
  walk(stylesheet, (node, ancestors) => {
    if (node.type !== 'Rule' || !node.prelude.children.some((item) => source.slice(item.start, item.end).replace(/\s+/g, ' ').trim() === selector)) return;
    rules.push({ start: node.start,
      media: ancestors.filter((item) => item.type === 'Atrule' && item.name === 'media').map((item) => item.prelude),
      declarations: node.block.children.filter((item) => item.type === 'Declaration') });
  });
  return rules;
}

const valueOf = (declaration) => declaration?.value.replace(/\s*!important\s*$/i, '').trim().toLowerCase();
const reduced = (rule) => rule.media.some((condition) => /^\(\s*prefers-reduced-motion\s*:\s*reduce\s*\)$/.test(condition));

test('reduced-motion CSS explicitly disables the filter disclosure transition after its base rule', () => {
  const rules = rulesFor('.filter-disclosure');
  const base = rules.findLast((rule) => !rule.media.length && rule.declarations.some((item) => item.property === 'transition'));
  const override = rules.findLast((rule) => reduced(rule) && rule.declarations.some((item) => item.property === 'transition'));
  assert.ok(base);
  assert.ok(override, 'The reduced-motion media rule needs a filter-disclosure transition override.');
  assert.equal(valueOf(override.declarations.findLast((item) => item.property === 'transition')), 'none');
  assert.ok(override.start > base.start, 'The same-specificity reduced-motion declaration must follow the base transition.');
});

test('normal filter disclosure motion remains 150ms and its open-state rotation cue stays available without motion', () => {
  const base = rulesFor('.filter-disclosure').findLast((rule) => !rule.media.length);
  assert.ok(base);
  assert.match(valueOf(base.declarations.findLast((item) => item.property === 'transition')), /^transform\s+(?:0?\.15s|150ms)(?:\s|$)/);
  const open = rulesFor('.filters-panel[open] .filter-disclosure').findLast((rule) => !rule.media.length);
  assert.ok(open, 'The open-state cue must not be restricted to no-preference motion mode.');
  assert.match(valueOf(open.declarations.findLast((item) => item.property === 'transform')), /^rotate\(\s*180deg\s*\)$/);
});

test('filter content padding declares at least 8px top clearance at each styled breakpoint', () => {
  const rules = rulesFor('.filters-content');
  const observed = [];
  for (const rule of rules) {
    const declaration = rule.declarations.findLast((item) => ['padding', 'padding-top'].includes(item.property));
    if (!declaration) continue;
    observed.push({ media: rule.media.join(' and ') || 'base', top: valueOf(declaration).split(/\s+/)[0] });
  }
  assert.ok(observed.length > 0);
  const insufficient = observed.filter(({ top }) => !/^\d+(?:\.\d+)?px$/.test(top) || Number.parseFloat(top) < 8);
  assert.deepEqual(insufficient, [], 'Every filter-content padding rule must leave the declared summary focus clearance.');
});
