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
  context.addressValidation = evaluate(derivedExpression('addressValidation'), context);
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

function boundElement(name) {
  return elements.find(({ node }) => node.attributes.some((item) => item.type === 'BindDirective'
    && item.name === 'this' && item.expression?.name === name))?.node;
}

const addressTrigger = boundElement('addressTrigger');
const daangnTrigger = boundElement('daangnTrigger');
const AREA = Object.freeze({ sido: '서울', sigungu: '마포구', bname: '동교동', bcode: '1144012100', sigunguCode: '11440' });

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

test('non-query and non-address planner failures retain one general alert without marking the query invalid', () => {
  for (const [overrides, expectedField] of [
    [{ selected: [] }, 'sources'],
    [{ scope: 'unknown' }, 'scope'],
    [{ areaLevel: 'unknown' }, 'areaLevel'],
    [{ selected: ['daangn'], daangnMultiEnabled: true, daangnAreas: [] }, 'daangnAreas']
  ]) {
    const draft = draftWith(overrides);
    const plan = createSearchSnapshot(draft);
    assert.equal(plan.ok, false);
    assert.equal(plan.field, expectedField);
    const state = queryState(draft, plan.message);
    assert.equal(state.queryValidation, '');
    assert.equal(state.addressValidation, '');
    assert.equal(attributeValue(addressTrigger, 'aria-describedby', state), undefined);
    assert.equal(evaluate(expressionAttribute(queryInput, 'aria-invalid'), state), undefined);
    assert.equal(describedBy(state).includes('query-error'), false);
    const alerts = formAlerts(state);
    assert.equal(alerts.length, 1, `${expectedField} must retain its existing form-level feedback.`);
    assert.notEqual(literalAttribute(alerts[0].node, 'id'), 'query-error');
    assert.notEqual(literalAttribute(alerts[0].node, 'id'), 'address-error');
    assert.equal(textFor(alerts[0].node, state), plan.message);
  }
});

test('submitted missing-base-address feedback sits beside the address trigger and links only that trigger', () => {
  const error = elements.find(({ node }) => literalAttribute(node, 'id') === 'address-error');
  assert.ok(error, 'A missing base address needs a nearby error region, not only the alert below all region controls.');
  const row = elements.find(({ node }) => literalAttribute(node, 'class') === 'address-row')?.node;
  const level = elements.find(({ node }) => literalAttribute(node, 'class') === 'area-level-row')?.node;
  assert.ok(addressTrigger && daangnTrigger && row && level);
  assert.equal(elements.filter(({ node }) => literalAttribute(node, 'id') === 'address-error').length, 1);
  assert.equal(literalAttribute(error.node, 'role'), 'alert');
  assert.equal(attribute(error.node, 'hidden'), undefined);
  assert.ok(row.end <= error.node.start && error.node.end <= level.start,
    'Keep address feedback immediately after the address controls and before the region-unit controls.');
  assert.ok(!error.ancestors.some((node) => node.type === 'RegularElement' && node.name === 'details'));
  const draft = draftWith({ scope: 'address' });
  const plan = createSearchSnapshot(draft);
  assert.equal(plan.ok, false);
  assert.equal(plan.field, 'address');
  const state = queryState(draft, plan.message);
  const alerts = formAlerts(state);
  assert.equal(alerts.length, 1, 'The inline address error must replace, not duplicate, the general alert.');
  assert.equal(alerts[0].node, error.node);
  assert.equal(textFor(error.node, state), plan.message);
  assert.equal(attributeValue(addressTrigger, 'aria-describedby', state), 'address-error');
  assert.equal(describedBy(state).includes('address-error'), false, 'The query must not describe an address error.');
  assert.equal(attribute(daangnTrigger, 'aria-describedby'), undefined, 'Separate Daangn areas do not use the base-address error.');
  assert.equal(literalAttribute(addressTrigger, 'type'), 'button');
  for (const searching of [false, true]) {
    assert.equal(evaluate(expressionAttribute(addressTrigger, 'disabled'), { searching }), searching);
  }
  const opened = [];
  evaluate(expressionAttribute(addressTrigger, 'onclick'), { openAddressSearch: (...args) => opened.push(args) })();
  assert.deepEqual(opened, [[]], 'The base trigger keeps its existing default-purpose address-picker action.');
});

test('address feedback stays quiet before submission and when a base address is not required', () => {
  for (const draft of [
    draftWith({ scope: 'address' }),
    draftWith(),
    draftWith({ scope: 'address', address: AREA }),
    draftWith({ scope: 'address', selected: ['daangn'], daangnMultiEnabled: true, daangnAreas: [AREA] })
  ]) {
    const state = queryState(draft);
    assert.equal(state.addressValidation, '');
    assert.equal(formAlerts(state).length, 0);
    assert.equal(attributeValue(addressTrigger, 'aria-describedby', state), undefined,
      'Do not leave a reference to a non-rendered submission error.');
    const error = elements.find(({ node }) => literalAttribute(node, 'id') === 'address-error');
    assert.equal(visible(error, state), false);
    if (draft.scope === 'address' && !draft.address && !draft.daangnMultiEnabled) {
      assert.equal(state.draftSnapshot.ok, false);
      assert.equal(state.draftSnapshot.field, 'address');
    } else assert.equal(state.draftSnapshot.ok, true);
  }
});

test('real planner precedence routes query, provider and separate-neighborhood errors without claiming a base-address error', () => {
  for (const [overrides, field, errorId] of [
    [{ query: '   ', selected: [], daangnMultiEnabled: true }, 'query', 'query-error'],
    [{ selected: [], daangnMultiEnabled: true }, 'sources', undefined],
    [{ selected: ['daangn'], daangnMultiEnabled: false }, 'sources', undefined],
    [{ selected: ['daangn'], daangnMultiEnabled: true }, 'daangnAreas', undefined],
    [{ selected: ['albamon', 'daangn', 'alba'], daangnMultiEnabled: true }, 'address', 'address-error']
  ]) {
    const draft = draftWith({ scope: 'address', ...overrides });
    const before = structuredClone(draft);
    const plan = createSearchSnapshot(draft);
    assert.equal(plan.ok, false);
    assert.equal(plan.field, field);
    const state = queryState(draft, plan.message);
    const alerts = formAlerts(state);
    assert.equal(alerts.length, 1, `${field} must have one feedback location.`);
    assert.equal(literalAttribute(alerts[0].node, 'id'), errorId);
    assert.equal(textFor(alerts[0].node, state), plan.message);
    assert.equal(state.addressValidation, field === 'address' ? plan.message : '');
    assert.equal(attributeValue(addressTrigger, 'aria-describedby', state), field === 'address' ? 'address-error' : undefined);
    assert.equal(state.queryValidation, field === 'query' ? plan.message : '');
    assert.deepEqual(draft, before, 'Feedback must not change provider selection, scope or missing-address planning.');
  }
});

test('actual edit handlers clear submitted address feedback without starting a search or touching existing results', () => {
  const nationwide = elements.find(({ node }) => node.name === 'button'
    && node.fragment?.nodes.some((child) => child.type === 'Text' && child.data.trim() === '전국'))?.node;
  const level = elements.find(({ node }) => literalAttribute(node, 'id') === 'area-level')?.node;
  assert.ok(nationwide && level);
  const draft = draftWith({ scope: 'address' });
  const plan = createSearchSnapshot(draft);
  assert.equal(plan.ok, false);
  assert.equal(plan.field, 'address');
  for (const [control, event, changed] of [
    [queryInput, 'oninput', { query: '주말 카페' }],
    [level, 'onchange', { areaLevel: 'neighborhood' }],
    [nationwide, 'onclick', {}]
  ]) {
    const state = queryState(draft, plan.message);
    const snapshot = Object.freeze({ fingerprint: 'previous-search' });
    const lanes = [{ source: 'albamon', state: 'done', result: { jobs: [{ id: 'previous' }] } }];
    const filters = { include: '카페', minHourly: 12000 };
    const controller = new AbortController();
    const effects = [];
    Object.assign(state, { appliedSnapshot: snapshot, lanes, filters, generation: 9,
      search: () => effects.push('search'), fetch: () => effects.push('fetch'),
      abortRequests: () => effects.push('abort'),
      addressTrigger: { focus: () => effects.push('focus') },
      controllers: new Map([['albamon', controller]]), ...changed });
    evaluate(expressionAttribute(control, event), state)();
    assert.equal(state.validation, '');
    assert.equal(state.query, changed.query || draft.query);
    assert.equal(state.scope, control === nationwide ? 'nationwide' : draft.scope);
    assert.equal(state.address, null);
    assert.equal(state.selected, draft.selected);
    assert.equal(state.appliedSnapshot, snapshot);
    assert.equal(state.lanes, lanes);
    assert.equal(state.filters, filters);
    assert.equal(state.generation, 9);
    assert.equal(controller.signal.aborted, false);
    assert.deepEqual(effects, []);
    const updated = queryState({ ...draft, query: state.query, scope: state.scope, areaLevel: state.areaLevel }, state.validation);
    assert.equal(updated.addressValidation, '');
    assert.equal(formAlerts(updated).length, 0);
    assert.equal(attributeValue(addressTrigger, 'aria-describedby', updated), undefined);
  }
});
