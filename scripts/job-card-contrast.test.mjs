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
for (const selector of ['.location', '.schedule', '.detail-link']) {
  test(`${selector} declared small text meets 4.5:1 against the opaque job card`, () => {
    const background = declarationsFor('.job-card').background;
    const foreground = declarationsFor(selector).color;
    const ratio = contrast(foreground, background);
    assert.ok(ratio >= 4.5, `${selector}: ${foreground} on ${background} = ${ratio}:1`);
  });
}
