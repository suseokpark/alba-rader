import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { parse } from 'svelte/compiler';

// Static declaration/template contracts, not a browser cascade, OS text-scale,
// touch-target measurement or proof that a particular font glyph fits its box.
const cssSource = `<style>${readFileSync(new URL('../src/app.css', import.meta.url), 'utf8')}</style>`;
const stylesheet = parse(cssSource, { modern: true }).css;
const page = parse(readFileSync(new URL('../src/routes/+page.svelte', import.meta.url), 'utf8'), { modern: true });

function walk(node, visit, ancestors = []) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) { for (const child of node) walk(child, visit, ancestors); return; }
  visit(node, ancestors);
  for (const [key, value] of Object.entries(node)) {
    if (!['loc', 'name_loc'].includes(key)) walk(value, visit, [...ancestors, node]);
  }
}

// Merge only this exact selector's unconditional declarations in source order.
// Earlier colour/font rules remain relevant when the later size rule overrides it.
const closeStyle = {};
walk(stylesheet, (node, ancestors) => {
  if (node.type !== 'Rule' || ancestors.some((item) => item.type === 'Atrule')) return;
  if (!node.prelude.children.some((selector) => cssSource.slice(selector.start, selector.end).replace(/\s+/g, ' ').trim() === '.postcode-heading button')) return;
  for (const declaration of node.block.children) {
    if (declaration.type === 'Declaration') closeStyle[declaration.property] = declaration.value.replace(/\s*!important\s*$/i, '').trim().toLowerCase();
  }
});

function dimension(property, unit) {
  const value = closeStyle[property] || '';
  assert.match(value, new RegExp(`^\\d+(?:\\.\\d+)?${unit}$`), `${property} needs an explicit ${unit} declaration.`);
  return Number.parseFloat(value);
}

test('postcode close control declares no flex shrink and a 44px minimum in both dimensions', () => {
  assert.equal(closeStyle['flex-shrink'], '0', 'The heading flex layout must not shrink the close control.');
  assert.ok(dimension('min-width', 'px') >= 44);
  assert.ok(dimension('min-height', 'px') >= 44);
});

test('postcode close box scales with its font and declares zero-padding centred single-line content', () => {
  const width = dimension('width', 'rem');
  const height = dimension('height', 'rem');
  const font = dimension('font-size', 'rem');
  assert.ok(width >= font && height >= font, 'The declared rem box must be at least the declared rem font size.');
  assert.equal(closeStyle['line-height'], '1');
  assert.match(closeStyle.padding || '', /^0(?:px)?$/);
  assert.equal(closeStyle.display, 'grid');
  assert.equal(closeStyle['place-items'], 'center');
});

function attribute(node, name) {
  return node.attributes.find((item) => item.type === 'Attribute' && item.name === name);
}

function literalAttribute(node, name) {
  const value = attribute(node, name)?.value;
  return Array.isArray(value) && value.every((part) => part.type === 'Text') ? value.map((part) => part.data).join('') : undefined;
}

test('postcode close remains a labelled native non-submit button wired to the existing close handler', () => {
  const buttons = [];
  walk(page.fragment, (node, ancestors) => {
    if (node.type === 'RegularElement' && node.name === 'button'
      && ancestors.some((parent) => parent.type === 'RegularElement' && literalAttribute(parent, 'class')?.split(/\s+/).includes('postcode-heading'))) buttons.push(node);
  });
  assert.equal(buttons.length, 1);
  const button = buttons[0];
  assert.equal(literalAttribute(button, 'type'), 'button');
  assert.equal(literalAttribute(button, 'aria-label'), '주소 검색 닫기');
  assert.equal(attribute(button, 'onclick')?.value?.expression?.name, 'closeAddressSearch');
  assert.equal(attribute(button, 'role'), undefined);
});

function declarationsFor(selectorText) {
  const declarations = {};
  walk(stylesheet, (node, ancestors) => {
    if (node.type !== 'Rule' || ancestors.some((item) => item.type === 'Atrule')) return;
    if (!node.prelude.children.some((selector) => cssSource.slice(selector.start, selector.end).trim() === selectorText)) return;
    for (const item of node.block.children) {
      if (item.type === 'Declaration') declarations[item.property] = item.value.trim().toLowerCase();
    }
  });
  return declarations;
}

test('only an open postcode dialog declares a clipped flex column with a non-sticky nonshrinking heading', () => {
  const open = declarationsFor('.postcode-dialog[open]');
  assert.equal(open.display, 'flex');
  assert.equal(open['flex-direction'], 'column');
  assert.equal(open.overflow, 'hidden');
  // Keep native closed-dialog hiding: no base dialog display override may expose it.
  for (const selector of ['dialog', '.postcode-dialog', 'dialog.postcode-dialog', '.postcode-dialog:not([open])']) {
    const display = declarationsFor(selector).display;
    assert.ok(display === undefined || display === 'none', `${selector} must not override closed-dialog hiding.`);
  }
  const heading = declarationsFor('.postcode-heading');
  assert.equal(heading.position, 'static');
  assert.equal(heading['flex-shrink'], '0');
});

test('postcode scrolling body contains the SDK host and feedback but excludes the heading and horizontal padding', () => {
  const elements = [];
  walk(page.fragment, (node, ancestors) => {
    if (node.type === 'RegularElement') elements.push({ node, ancestors });
  });
  const hasClass = (node, name) => literalAttribute(node, 'class')?.split(/\s+/).includes(name);
  const dialog = elements.find(({ node }) => node.name === 'dialog' && hasClass(node, 'postcode-dialog'));
  assert.ok(dialog);
  const body = elements.find(({ node, ancestors }) => hasClass(node, 'postcode-body') && ancestors.includes(dialog.node));
  assert.ok(body, 'The SDK and its feedback need a separate scroll body within the native dialog.');
  const heading = elements.find(({ node, ancestors }) => hasClass(node, 'postcode-heading') && ancestors.includes(dialog.node));
  assert.ok(heading);
  assert.ok(!heading.ancestors.includes(body.node));
  for (const name of ['postcode-embed', 'postcode-status', 'postcode-recovery', 'postcode-footnote']) {
    const matches = elements.filter(({ node, ancestors }) => hasClass(node, name) && ancestors.includes(dialog.node));
    assert.ok(matches.length > 0, `Missing ${name} in the native dialog.`);
    assert.ok(matches.every(({ ancestors }) => ancestors.includes(body.node)), `${name} must scroll within the body.`);
  }
  const style = declarationsFor('.postcode-body');
  assert.match(style['min-height'] || '', /^0(?:px)?$/);
  assert.equal(style.overflow, 'auto');
  assert.equal(style['overscroll-behavior'], 'contain');
  const padding = (style.padding || '0').split(/\s+/);
  const right = padding[1] ?? padding[0];
  const left = padding[3] ?? right;
  for (const value of [right, left, ...(style['padding-inline'] || '0').split(/\s+/), ...['padding-left', 'padding-right', 'padding-inline-start', 'padding-inline-end'].map((key) => style[key] || '0')]) {
    assert.match(value, /^0(?:px)?$/, 'Horizontal padding must not reduce the embedded SDK width.');
  }
});
