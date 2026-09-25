import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { parse } from 'svelte/compiler';
import { createSearchSnapshot } from '../src/lib/search-request.ts';

// Source/template and pure-planner boundaries only. These tests do not paste
// into a browser, emulate OS IME input, or verify screen-reader announcements.
const source = readFileSync(new URL('../src/routes/+page.svelte', import.meta.url), 'utf8');
const page = parse(source, { modern: true });

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
  assert.ok(expression, 'Expected the real template/derived expression.');
  return runInNewContext(`(${source.slice(expression.start, expression.end)})`, context, { timeout: 1000 });
}

function textFor(node, context) {
  if (!node) return '';
  if (node.type === 'Text') return node.data;
  if (node.type === 'ExpressionTag') return String(evaluate(node.expression, context));
  if (node.type === 'IfBlock') return textFor(evaluate(node.test, context) ? node.consequent : node.alternate, context);
  return (node.nodes || node.fragment?.nodes || []).map((child) => textFor(child, context)).join('');
}

const elements = [];
walk(page.fragment, (node, ancestors) => {
  if (node.type === 'RegularElement') elements.push({ node, ancestors });
});
const queryInput = elements.find(({ node }) => node.name === 'input' && literalAttribute(node, 'id') === 'query')?.node;

test('query input does not truncate native input and connects a persistent length status without losing IME handling', () => {
  assert.ok(queryInput);
  assert.equal(attribute(queryInput, 'maxlength'), undefined, 'Let validation explain excess text instead of silently cutting the draft.');
  assert.equal(expressionAttribute(queryInput, 'onkeydown')?.name, 'handleQueryKeydown');
  assert.equal(queryInput.attributes.find((item) => item.type === 'BindDirective' && item.name === 'value')?.expression?.name, 'query');
  const describedBy = literalAttribute(queryInput, 'aria-describedby')?.split(/\s+/) || [];
  assert.ok(describedBy.includes('query-hint') && describedBy.includes('query-length-hint'));
  const hint = elements.find(({ node }) => literalAttribute(node, 'id') === 'query-length-hint');
  assert.ok(hint);
  assert.equal(hint.node.name, 'p');
  assert.equal(literalAttribute(hint.node, 'role'), 'status');
  assert.ok(!hint.ancestors.some((node) => node.type === 'IfBlock'), 'The status region must also exist below the length limit.');
  assert.equal(attribute(hint.node, 'hidden'), undefined);
  const overLimit = hint.node.attributes.find((item) => item.type === 'ClassDirective' && item.name === 'over-limit');
  assert.ok(overLimit);
  for (const queryTooLong of [false, true]) {
    assert.equal(evaluate(expressionAttribute(queryInput, 'aria-invalid'), { queryTooLong }), queryTooLong ? 'true' : undefined);
    assert.equal(evaluate(overLimit.expression, { queryTooLong }), queryTooLong);
    const text = textFor(hint.node, { queryTooLong });
    assert.match(text, /80/);
    if (queryTooLong) assert.match(text, /줄여|줄이/);
    else { assert.match(text, /앞뒤|양끝/); assert.match(text, /공백/); }
  }
});

test('the real derived length flag follows trimmed UTF-16 length rather than raw draft length or graphemes', () => {
  const declaration = page.instance.content.body.flatMap((node) => node.type === 'VariableDeclaration' ? node.declarations : [])
    .find((node) => node.id?.name === 'queryTooLong');
  assert.ok(declaration, 'The page must derive the live length flag from the draft.');
  assert.equal(declaration.init?.callee?.name, '$derived');
  const expression = declaration.init.arguments[0];
  const eighty = '카페 '.repeat(26) + '주말';
  assert.equal(eighty.length, 80);
  for (const [query, expected] of [
    ['', false], ['   ', false], [eighty, false], [` ${eighty} `, false],
    ['가'.repeat(81), true], ['😀'.repeat(40), false], ['😀'.repeat(41), true]
  ]) assert.equal(evaluate(expression, { query }), expected, JSON.stringify(query));
});

test('snapshot accepts trimmed 80 code units, rejects longer text, and never rewrites the raw draft', () => {
  const eighty = '카페 '.repeat(26) + '주말';
  for (const [query, accepted] of [[` ${eighty} `, true], ['가'.repeat(81), false], ['😀'.repeat(40), true], ['😀'.repeat(41), false]]) {
    const draft = { query, selected: ['albamon'], scope: 'nationwide', address: null,
      areaLevel: 'district', daangnMultiEnabled: false, daangnAreas: [] };
    const before = structuredClone(draft);
    const plan = createSearchSnapshot(draft);
    assert.equal(plan.ok, accepted, JSON.stringify(query));
    if (accepted) assert.equal(plan.snapshot.query, query.trim());
    else { assert.equal(plan.field, 'query'); assert.match(plan.message, /80/); }
    assert.deepEqual(draft, before);
  }
});
