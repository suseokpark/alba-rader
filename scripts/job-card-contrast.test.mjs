import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { parse } from 'svelte/compiler';

// Declared opaque card colours only; browser computed styles and reflow are
// verified separately. This is not a whole-page accessibility certification.
const source = `<style>${readFileSync(new URL('../src/app.css', import.meta.url), 'utf8')}</style>`;
const stylesheet = parse(source, { modern: true }).css;
function declarationsFor(selectorText) {
  const style = {};
  function walk(node, inAtRule = false) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach((child) => walk(child, inAtRule)); return; }
    if (node.type === 'Rule' && !inAtRule && node.prelude.children.some((selector) =>
      source.slice(selector.start, selector.end).replace(/\s+/g, ' ').trim() === selectorText)) {
      for (const item of node.block.children) {
        if (item.type === 'Declaration') style[item.property] = item.value.trim().toLowerCase();
      }
    }
    for (const [key, value] of Object.entries(node)) {
      if (!['loc', 'name_loc'].includes(key)) walk(value, inAtRule || node.type === 'Atrule');
    }
  }
  walk(stylesheet);
  return style;
}
function luminance(hex) {
  const token = hex.match(/^var\((--[\w-]+)\)$/);
  if (token) hex = declarationsFor(':root')[token[1]];
  assert.match(hex, /^#[0-9a-f]{6}$/i, 'This test requires an explicit opaque hex colour.');
  const rgb = hex.slice(1).match(/../g).map((channel) => {
    const value = parseInt(channel, 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
}
function contrast(a, b) {
  const values = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (values[0] + 0.05) / (values[1] + 0.05);
}
test('contrast calculation uses unrounded relative luminance', () => {
  assert.equal(contrast('#000000', '#ffffff'), 21);
  assert.equal(contrast('#fffdf9', '#fffdf9'), 1);
  assert.ok(contrast('#837364', '#fffdf9') < 4.5, 'Do not round a failing ratio up to a pass.');
});
for (const selector of ['.location', '.schedule', '.detail-link', '.job-card .pay']) {
  test(`${selector} declared small text meets 4.5:1 against the opaque job card`, () => {
    const background = declarationsFor('.job-card').background;
    const foreground = declarationsFor(selector).color;
    const ratio = contrast(foreground, background);
    assert.ok(ratio >= 4.5, `${selector}: ${foreground} on ${background} = ${ratio}:1`);
  });
}

test('yellow search buttons use readable dark text on flat normal and hover backgrounds', () => {
  const button = declarationsFor('.search-submit');
  assert.equal(button.background, 'var(--accent)');
  assert.equal(button.color, 'var(--accent-ink)');
  assert.equal(declarationsFor('.search-submit:hover:not(:disabled)').background, 'var(--accent-hover)');
  for (const background of ['var(--accent)', 'var(--accent-hover)']) {
    assert.ok(contrast(button.color, background) >= 4.5, `Search label must remain readable on ${background}.`);
  }
  assert.ok(contrast('var(--accent)', 'var(--surface)') >= 3);
});

test('yellow provider labels and focus rings retain contrast on dark surfaces', () => {
  const provider = declarationsFor('.albamon');
  assert.equal(provider['--source-ink'], 'var(--accent)');
  assert.equal(provider['--source-tint'], 'var(--accent-soft)');
  assert.ok(contrast(provider['--source-ink'], provider['--source-tint']) >= 4.5);
  for (const surface of ['var(--background)', 'var(--surface)', 'var(--surface-soft)']) {
    assert.ok(contrast('var(--accent)', surface) >= 3);
    assert.ok(contrast('var(--muted)', surface) >= 4.5);
    assert.ok(contrast('var(--ink)', surface) >= 4.5);
    assert.ok(contrast('var(--control-line)', surface) >= 3);
  }
});

test('provider accents use yellow, grey and outlined black without obscuring labels', () => {
  assert.equal(declarationsFor('.albamon')['--source-color'], 'var(--accent)');
  assert.equal(declarationsFor(':root')['--accent'], '#ffe04b');
  assert.equal(declarationsFor('.daangn')['--source-color'], '#aeb0b7');
  assert.equal(declarationsFor('.alba')['--source-color'], '#08090b');
  for (const selector of ['.daangn', '.alba']) {
    const provider = declarationsFor(selector);
    assert.ok(contrast(provider['--source-ink'], provider['--source-tint']) >= 4.5);
  }
  assert.ok(contrast(declarationsFor('.alba')['--source-outline'], 'var(--surface)') >= 3);
});

test('page, actions and loading placeholders contain no gradients', () => {
  assert.doesNotMatch(source, /(?:linear|radial|conic)-gradient\s*\(/i);
  assert.equal(declarationsFor(':root')['color-scheme'], 'dark');
  assert.equal(declarationsFor('body').background, 'var(--background)');
  assert.equal(declarationsFor('.skeleton').background, 'var(--surface-soft)');
});

test('errors and unverified schedule badges remain readable in dark mode', () => {
  for (const selector of ['.validation', '.lane-count.failed', '.job-card .unverified-schedule']) {
    const style = declarationsFor(selector);
    assert.ok(contrast(style.color, style.background) >= 4.5, selector);
  }
});

test('filter and analytics scoped styles use shared dark surfaces', () => {
  for (const file of ['../src/lib/JobFilters.svelte', '../src/routes/analytics/+page.svelte']) {
    const component = readFileSync(new URL(file, import.meta.url), 'utf8').split('<style>')[1];
    assert.match(component, /background: var\(--surface\)/);
    assert.doesNotMatch(component, /background:\s*(?:#[0-9a-f]+|white)\b/i);
    assert.doesNotMatch(component, /(?:linear|radial|conic)-gradient\s*\(/i);
  }
});
