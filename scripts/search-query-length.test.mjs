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

function attributeValue(node, name, context) {
  return literalAttribute(node, name) ?? evaluate(expressionAttribute(node, name), context);
}

function evaluate(expression, context) {
  assert.ok(expression, 'Expected the real template/derived expression.');
  return runInNewContext(`(${source.slice(expression.start, expression.end)})`, context, { timeout: 1000 });
}

function derivedExpression(name) {
  const declaration = page.instance.content.body.flatMap((node) => node.type === 'VariableDeclaration' ? node.declarations : [])
    .find((node) => node.id?.name === name);
  assert.ok(declaration, `The page must derive ${name} from its current state.`);
  assert.equal(declaration.init?.callee?.name, '$derived');
  return declaration.init.arguments[0];
}

function draftWith(overrides = {}) {
  return { query: '카페', selected: ['albamon'], scope: 'nationwide', address: null,
    areaLevel: 'district', daangnMultiEnabled: false, daangnAreas: [], ...overrides };
}

function queryState(draft, validation = '') {
  // Exercise the real planner, then the page's real derived expressions.
  // This models state at the template boundary, not a browser's reactive cycle.
  const context = { ...draft, validation, draftSnapshot: createSearchSnapshot(draft) };
  context.queryTooLong = evaluate(derivedExpression('queryTooLong'), context);
  context.queryValidation = evaluate(derivedExpression('queryValidation'), context);
  return context;
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

function visible(entry, context) {
  return entry.ancestors.every((node, index, ancestors) => node.type !== 'IfBlock'
    || (evaluate(node.test, context) ? node.consequent : node.alternate) === ancestors[index + 1]);
}

function formAlerts(context) {
  return elements.filter((entry) => literalAttribute(entry.node, 'role') === 'alert'
    && entry.ancestors.some((node) => node.type === 'RegularElement' && node.name === 'form'
      && literalAttribute(node, 'class') === 'search-panel')
    && visible(entry, context));
}

function describedBy(context) {
  return attributeValue(queryInput, 'aria-describedby', context).trim().split(/\s+/);
}

test('query input does not truncate native input and connects a persistent length status without losing IME handling', () => {
  assert.ok(queryInput);
  assert.equal(attribute(queryInput, 'maxlength'), undefined, 'Let validation explain excess text instead of silently cutting the draft.');
  assert.equal(expressionAttribute(queryInput, 'onkeydown')?.name, 'handleQueryKeydown');
  assert.equal(queryInput.attributes.find((item) => item.type === 'BindDirective' && item.name === 'value')?.expression?.name, 'query');
  const descriptions = describedBy({ queryValidation: '' });
  assert.ok(descriptions.includes('query-hint') && descriptions.includes('query-length-hint'));
  const hint = elements.find(({ node }) => literalAttribute(node, 'id') === 'query-length-hint');
  assert.ok(hint);
  assert.equal(hint.node.name, 'p');
  assert.equal(literalAttribute(hint.node, 'role'), 'status');
  assert.ok(!hint.ancestors.some((node) => node.type === 'IfBlock'), 'The status region must also exist below the length limit.');
  assert.equal(attribute(hint.node, 'hidden'), undefined);
  const overLimit = hint.node.attributes.find((item) => item.type === 'ClassDirective' && item.name === 'over-limit');
  assert.ok(overLimit);
  for (const queryTooLong of [false, true]) {
    assert.equal(evaluate(expressionAttribute(queryInput, 'aria-invalid'), { queryTooLong, queryValidation: '' }), queryTooLong ? 'true' : undefined);
    assert.equal(evaluate(overLimit.expression, { queryTooLong }), queryTooLong);
    const text = textFor(hint.node, { queryTooLong });
    assert.match(text, /80/);
    if (queryTooLong) assert.match(text, /줄여|줄이/);
    else { assert.match(text, /앞뒤|양끝/); assert.match(text, /공백/); }
  }
});

test('the real derived length flag follows trimmed UTF-16 length rather than raw draft length or graphemes', () => {
  const expression = derivedExpression('queryTooLong');
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

test('query validation stays quiet initially and identifies submitted empty or overlong drafts using the real planner', () => {
  for (const query of ['', '   ', '가'.repeat(81)]) {
    const draft = draftWith({ query });
    const initial = queryState(draft);
    assert.equal(initial.queryValidation, '', 'An unsubmitted invalid draft must not announce a submission error.');
    assert.equal(formAlerts(initial).length, 0);
    assert.equal(describedBy(initial).includes('query-error'), false);
    assert.equal(initial.draftSnapshot.ok, false);
    assert.equal(initial.draftSnapshot.field, 'query');
    const failed = queryState(draft, initial.draftSnapshot.message);
    assert.equal(failed.queryValidation, initial.draftSnapshot.message);
    assert.equal(evaluate(expressionAttribute(queryInput, 'aria-invalid'), failed), 'true');
  }
});

test('submitted query errors have one adjacent alert linked to the input, not a duplicate below the area controls', () => {
  const queryError = elements.find(({ node }) => literalAttribute(node, 'id') === 'query-error');
  assert.ok(queryError, 'The query needs its own nearby error region.');
  assert.equal(elements.filter(({ node }) => literalAttribute(node, 'id') === 'query-error').length, 1);
  assert.equal(literalAttribute(queryError.node, 'role'), 'alert');
  assert.equal(attribute(queryError.node, 'hidden'), undefined);
  const field = elements.find(({ node }) => literalAttribute(node, 'class') === 'search-field')?.node;
  const lengthHint = elements.find(({ node }) => literalAttribute(node, 'id') === 'query-length-hint')?.node;
  const areaControls = elements.find(({ node }) => literalAttribute(node, 'class') === 'area-controls')?.node;
  assert.ok(field && lengthHint && areaControls);
  assert.ok(field.end <= queryError.node.start && queryError.node.end <= areaControls.start,
    'Keep the alert after the query controls and before the address/region section.');
  assert.ok(queryError.node.end <= lengthHint.start,
    'Show the submitted error before the persistent length hint so larger text does not push it further below the field.');
  for (const query of ['', '   ', '가'.repeat(81), '카\n페']) {
    const draft = draftWith({ query });
    const plan = createSearchSnapshot(draft);
    assert.equal(plan.ok, false);
    assert.equal(plan.field, 'query');
    const state = queryState(draft, plan.message);
    const alerts = formAlerts(state);
    assert.equal(alerts.length, 1, 'A submitted query error must not render twice.');
    assert.equal(alerts[0].node, queryError.node);
    assert.equal(textFor(alerts[0].node, state), plan.message);
    assert.equal(evaluate(expressionAttribute(queryInput, 'aria-invalid'), state), 'true');
    const descriptions = describedBy(state);
    assert.equal(descriptions.filter((id) => id === 'query-error').length, 1);
    assert.ok(descriptions.includes('query-hint') && descriptions.includes('query-length-hint'));
  }
});

test('editing or clearing the query removes a submitted error without losing live length feedback', () => {
  const rejected = draftWith({ query: '   ' });
  const failure = createSearchSnapshot(rejected);
  assert.equal(failure.ok, false);
  for (const query of ['카페', '', '   ', '가'.repeat(81)]) {
    const state = queryState(rejected, failure.message);
    state.query = query;
    const oninput = evaluate(expressionAttribute(queryInput, 'oninput'), state);
    oninput();
    assert.equal(state.validation, '', 'Execute the actual input handler that clears submission feedback.');
    assert.equal(state.query, query, 'Clearing feedback must not rewrite typed text.');
    const updated = queryState(draftWith({ query }), state.validation);
    assert.equal(updated.queryValidation, '');
    assert.equal(formAlerts(updated).length, 0);
    assert.equal(describedBy(updated).includes('query-error'), false);
    assert.equal(evaluate(expressionAttribute(queryInput, 'aria-invalid'), updated), updated.queryTooLong ? 'true' : undefined);
  }
  assert.equal(queryState(draftWith(), failure.message).queryValidation, '',
    'A now-valid planner result must not retain query-specific feedback even before a clear is observed.');
});

test('non-query planner failures retain one general alert without marking the query invalid', () => {
  for (const [overrides, expectedField] of [
    [{ selected: [] }, 'sources'],
    [{ scope: 'unknown' }, 'scope'],
    [{ areaLevel: 'unknown' }, 'areaLevel'],
    [{ scope: 'address', address: null }, 'address'],
    [{ selected: ['daangn'], daangnMultiEnabled: true, daangnAreas: [] }, 'daangnAreas']
  ]) {
    const draft = draftWith(overrides);
    const plan = createSearchSnapshot(draft);
    assert.equal(plan.ok, false);
    assert.equal(plan.field, expectedField);
    const state = queryState(draft, plan.message);
    assert.equal(state.queryValidation, '');
    assert.equal(evaluate(expressionAttribute(queryInput, 'aria-invalid'), state), undefined);
    assert.equal(describedBy(state).includes('query-error'), false);
    const alerts = formAlerts(state);
    assert.equal(alerts.length, 1, `${expectedField} must retain its existing form-level feedback.`);
    assert.notEqual(literalAttribute(alerts[0].node, 'id'), 'query-error');
    assert.equal(textFor(alerts[0].node, state), plan.message);
  }
});
