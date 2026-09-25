import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { parse } from 'svelte/compiler';
import { runInNewContext } from 'node:vm';

// Template wiring checks complement search-form's actual-handler tests. These
// inspect the shipped Svelte template, not browser keyboard or layout behavior.
const page = readFileSync(new URL('../src/routes/+page.svelte', import.meta.url), 'utf8');
const template = parse(page, { modern: true }).fragment;

function walk(node, visit, ancestors = []) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const item of node) walk(item, visit, ancestors);
    return;
  }
  visit(node, ancestors);
  const next = node.type === 'RegularElement' ? [...ancestors, node] : ancestors;
  for (const [key, value] of Object.entries(node)) {
    if (!['attributes', 'loc', 'name_loc'].includes(key)) walk(value, visit, next);
  }
}

function elements(root) {
  const result = [];
  walk(root, (node, ancestors) => {
    if (node.type === 'RegularElement') result.push({ node, ancestors });
  });
  return result;
}

function attribute(node, name) {
  return node.attributes.find((item) => item.type === 'Attribute' && item.name === name);
}

function staticAttribute(node, name) {
  const value = attribute(node, name)?.value;
  return Array.isArray(value) && value.every((item) => item.type === 'Text')
    ? value.map((item) => item.data).join('') : undefined;
}

function hasClass(node, name) {
  return staticAttribute(node, 'class')?.split(/\s+/).includes(name);
}

function textOf(node) {
  const text = [];
  walk(node.fragment, (item) => { if (item.type === 'Text') text.push(item.data); });
  return text.join(' ').replace(/\s+/g, ' ').trim();
}

const all = elements(template);
const forms = all.filter(({ node }) => node.name === 'form' && hasClass(node, 'search-panel'));

test('both search buttons submit the same form once through native controls and share the loading lock', () => {
  assert.equal(forms.length, 1);
  const buttons = all.filter(({ node }) => node.name === 'button' && hasClass(node, 'search-submit'));
  assert.equal(buttons.length, 2, 'The form offers a search action above and below its conditions.');
  for (const { node, ancestors } of buttons) {
    assert.equal(staticAttribute(node, 'type'), 'submit');
    assert.equal(ancestors.findLast((item) => item.name === 'form'), forms[0].node);
    assert.equal(attribute(node, 'form'), undefined, 'Neither button may target another form.');
    assert.equal(ancestors.some((item) => item.name === 'details'), false);
    assert.equal(node.attributes.some((item) => /^(on)?(click|keydown|keyup)$/.test(item.name)), false,
      'A separate click or key handler would duplicate the form submission path.');
    const disabled = attribute(node, 'disabled')?.value?.expression;
    assert.equal(disabled?.type, 'Identifier');
    assert.equal(disabled?.name, 'searching');
  }
});

test('the shared form prevents navigation and calls the existing search handler exactly once', () => {
  assert.equal(forms.length, 1);
  const handler = attribute(forms[0].node, 'onsubmit')?.value?.expression;
  assert.ok(handler);
  const calls = [];
  walk(handler, (node) => { if (node.type === 'CallExpression') calls.push(node); });
  const search = calls.filter((node) => node.callee.type === 'Identifier' && node.callee.name === 'search');
  const prevent = calls.filter((node) => node.callee.type === 'MemberExpression' && node.callee.property.name === 'preventDefault');
  assert.equal(search.length, 1);
  assert.equal(prevent.length, 1);
  assert.ok(prevent[0].start < search[0].start);
});

test('separate-neighborhood scope and nearby-not-whole-area limits remain outside collapsed explanations', () => {
  const pickers = all.filter(({ node }) => hasClass(node, 'daangn-area-picker'));
  assert.equal(pickers.length, 1);
  const visibleHelp = elements(pickers[0].node.fragment)
    .filter(({ node, ancestors }) => node.name === 'p' && !ancestors.some((item) => item.name === 'details'))
    .map(({ node }) => textOf(node)).join(' ');
  // Protect the three coverage facts, not an exact copy or punctuation snapshot.
  assert.match(visibleHelp, /기준 주소.*별개/);
  assert.match(visibleHelp, /주변.*포함/);
  assert.match(visibleHelp, /구[·ㆍ/]시 전체.*아닙/);
});

test('the neighborhood disclosure is a native labelled summary with explanations, not hidden form actions', () => {
  const disclosures = all.filter(({ node }) => node.name === 'details' && hasClass(node, 'neighborhood-disclosure'));
  assert.equal(disclosures.length, 1);
  const details = disclosures[0].node;
  assert.equal(attribute(details, 'open'), undefined);
  const children = elements(details.fragment);
  const summaries = children.filter(({ node }) => node.name === 'summary');
  assert.equal(summaries.length, 1);
  assert.ok(textOf(summaries[0].node).length > 0);
  assert.equal(details.fragment.nodes.find((node) => node.type === 'RegularElement'), summaries[0].node);
  const hiddenActions = children.filter(({ node }) => ['button', 'input', 'select', 'textarea', 'a', 'form', 'details'].includes(node.name));
  assert.equal(hiddenActions.length, 0, 'Neighborhood selection and search actions must remain outside the disclosure.');
});

test('each lane has a stable bound heading for programmatic focus without adding a Tab stop', () => {
  const headings = all.filter(({ node, ancestors }) => node.name === 'h3'
    && ancestors.some((item) => hasClass(item, 'lane-heading')));
  assert.equal(headings.length, 1, 'One heading template must serve every result lane.');
  const { node: heading, ancestors } = headings[0];
  const binding = heading.attributes.find((item) => item.type === 'BindDirective' && item.name === 'this');
  assert.ok(binding, 'The lane heading must expose its element to the focus controller.');
  assert.equal(binding.expression.type, 'MemberExpression');
  assert.equal(binding.expression.object.type, 'Identifier');
  assert.equal(binding.expression.object.name, 'laneHeadings');
  assert.equal(binding.expression.computed, true);

  function assertLaneSource(expression) {
    assert.equal(expression?.type, 'MemberExpression');
    assert.equal(expression.object.type, 'Identifier');
    assert.equal(expression.object.name, 'lane');
    assert.equal(expression.property.type, 'Identifier');
    assert.equal(expression.property.name, 'source');
    assert.equal(expression.computed, false);
  }
  assertLaneSource(binding.expression.property);
  assert.equal(staticAttribute(heading, 'tabindex'), '-1', 'The focus target must stay out of sequential Tab navigation.');

  const lane = ancestors.findLast((item) => item.name === 'section');
  assert.ok(lane);
  for (const [element, name] of [[heading, 'id'], [lane, 'aria-labelledby']]) {
    const label = attribute(element, name)?.value?.expression;
    assert.equal(label?.type, 'TemplateLiteral');
    assert.deepEqual(label.quasis.map((item) => item.value.cooked), ['title-', '']);
    assert.equal(label.expressions.length, 1);
    assertLaneSource(label.expressions[0]);
  }

  const enclosingBranches = [];
  walk(lane.fragment, (node) => {
    if (node.type === 'IfBlock' && node.start < heading.start && heading.end < node.end) enclosingBranches.push(node);
  });
  assert.equal(enclosingBranches.length, 0,
    'The heading must survive loading, error and cancelled branches instead of being recreated inside one.');
});

test('explicit cancellation uses its focus wrapper and a stable bound results heading', () => {
  const buttons = all.filter(({ node }) => node.name === 'button' && textOf(node) === '조회 중단');
  assert.equal(buttons.length, 1);
  assert.equal(staticAttribute(buttons[0].node, 'type'), 'button');
  const click = attribute(buttons[0].node, 'onclick')?.value?.expression;
  assert.equal(click?.type, 'Identifier');
  assert.equal(click?.name, 'cancelFromButton', 'Only the explicit cancel action should invoke its focus wrapper.');

  const headings = all.filter(({ node }) => staticAttribute(node, 'id') === 'results-title');
  assert.equal(headings.length, 1);
  const { node: heading, ancestors } = headings[0];
  assert.equal(heading.name, 'h2');
  const binding = heading.attributes.find((item) => item.type === 'BindDirective' && item.name === 'this');
  assert.equal(binding?.expression.type, 'Identifier');
  assert.equal(binding?.expression.name, 'resultsTitle');
  assert.equal(staticAttribute(heading, 'tabindex'), '-1');
  const section = ancestors.findLast((item) => item.name === 'section');
  assert.ok(section);
  assert.equal(staticAttribute(section, 'aria-labelledby'), staticAttribute(heading, 'id'));
  const enclosingBranches = [];
  walk(template, (node) => {
    if (node.type === 'IfBlock' && node.start < heading.start && heading.end < node.end) enclosingBranches.push(node);
  });
  assert.equal(enclosingBranches.length, 0,
    'The focus target must remain mounted with submitted results or the initial no-results view.');
});

function evaluate(expression, context) {
  return runInNewContext(`(${page.slice(expression.start, expression.end)})`, context, { timeout: 1000 });
}

function containsNode(root, target) {
  let found = false;
  walk(root, (node) => { if (node === target) found = true; });
  return found;
}

test('the failed-neighborhood retry control calls only its dedicated handler and locks while loading', () => {
  const buttons = all.filter(({ node }) => node.name === 'button'
    && attribute(node, 'onclick')?.value?.expression?.name === 'retryFailedDaangn');
  assert.equal(buttons.length, 1);
  const button = buttons[0].node;
  assert.equal(staticAttribute(button, 'type'), 'button');
  assert.match(textOf(button), /실패.*동네/);
  const disabled = attribute(button, 'disabled')?.value?.expression;
  assert.ok(disabled);
  assert.equal(evaluate(disabled, { lane: { state: 'loading' } }), true);
  assert.equal(evaluate(disabled, { lane: { state: 'done' } }), false);
  const enclosing = [];
  walk(template, (node) => {
    if (node.type === 'IfBlock' && node.start < button.start && button.end < node.end) enclosing.push(node);
  });
  const guard = enclosing.findLast((node) => page.slice(node.test.start, node.test.end).includes('regionEntries'));
  assert.ok(guard, 'Raw per-neighborhood results must exist before exposing failed-only retry.');
  assert.equal(!!evaluate(guard.test, { lane: { source: 'daangn' }, result: { partial: true, regionEntries: [{}] } }), true);
  assert.equal(!!evaluate(guard.test, { lane: { source: 'alba' }, result: { partial: true, regionEntries: [{}] } }), false);
  assert.equal(!!evaluate(guard.test, { lane: { source: 'daangn' }, result: { partial: true } }), false);
  assert.equal(!!evaluate(guard.test, { lane: { source: 'daangn' }, result: {
    partial: true, regionEntries: [{}], interruption: { reason: 'cancelled', remainingAreas: [{}] }
  } }), false, 'An interrupted initial search must not expose failed-only retry.');
});

test('partial retry loading bypasses the full skeleton branch so retained listings remain reachable', () => {
  const loading = all.find(({ node }) => hasClass(node, 'loading-state'))?.node;
  const listings = all.find(({ node }) => hasClass(node, 'listings'))?.node;
  assert.ok(loading && listings);
  const enclosing = [];
  walk(template, (node) => {
    if (node.type === 'IfBlock' && containsNode(node.consequent, loading)) enclosing.push(node);
  });
  const branch = enclosing.findLast((node) => page.slice(node.test.start, node.test.end).includes('lane.state'));
  assert.ok(branch);
  assert.equal(evaluate(branch.test, { lane: { state: 'loading', retryingFailed: false } }), true);
  assert.equal(evaluate(branch.test, { lane: { state: 'loading', retryingFailed: true } }), false,
    'Retained results must not be replaced by the ordinary full-lane loading branch.');
  assert.ok(branch.alternate && containsNode(branch.alternate, listings));
});

test('failed-only retry outcomes have a persistent status message outside the loading-only branch', () => {
  const notices = all.filter(({ node }) => node.fragment?.nodes.some((child) => child.type === 'ExpressionTag'
    && child.expression.type === 'MemberExpression' && child.expression.object.name === 'lane'
    && child.expression.property.name === 'retryNotice'));
  assert.equal(notices.length, 1);
  const notice = notices[0].node;
  assert.equal(staticAttribute(notice, 'role'), 'status');
  const enclosing = [];
  walk(template, (node) => {
    if (node.type === 'IfBlock' && node.start < notice.start && notice.end < node.end) enclosing.push(node);
  });
  assert.equal(enclosing.some((node) => page.slice(node.test.start, node.test.end).includes('lane.state')), false,
    'Timeout, cancellation and completion notices must remain available when loading stops.');
});

test('initial multi-neighborhood loading announces completed and total regions without rendering progress as listings', () => {
  const progress = all.find(({ node }) => staticAttribute(node, 'role') === 'status'
    && page.slice(node.start, node.end).includes('lane.progress'))?.node;
  assert.ok(progress, 'Initial multi-search needs an accessible completed/total progress announcement.');
  const expressions = [];
  walk(progress.fragment, (node) => {
    if (node.type === 'ExpressionTag') expressions.push(page.slice(node.expression.start, node.expression.end));
  });
  assert.ok(expressions.some((expression) => expression.includes('lane.progress.entries.length')));
  assert.ok(expressions.some((expression) => expression.includes('lane.progress.total')));
  const branches = [];
  walk(template, (node) => {
    if (node.type === 'IfBlock' && containsNode(node.consequent, progress)) branches.push(node);
  });
  const loading = branches.findLast((node) => page.slice(node.test.start, node.test.end).includes('lane.state'));
  assert.ok(loading, 'Progress belongs to the pending initial-search branch, not a final-result notice.');
  assert.equal(!!evaluate(loading.test, { lane: { state: 'loading', retryingFailed: false } }), true);
  assert.equal(!!evaluate(loading.test, { lane: { state: 'done', retryingFailed: false } }), false);
  const listings = all.find(({ node }) => hasClass(node, 'listings'))?.node;
  assert.ok(listings && !containsNode(loading.consequent, listings));
});

test('interrupted results expose full same-condition retry and distinguish unconfirmed regions from confirmed empty results', () => {
  const block = all.find(({ node }) => hasClass(node, 'interrupted-result'))?.node;
  assert.ok(block);
  const children = elements(block.fragment);
  assert.ok(children.some(({ node }) => staticAttribute(node, 'role') === 'status'));
  const buttons = children.filter(({ node }) => node.name === 'button');
  assert.equal(buttons.length, 1);
  const button = buttons[0].node;
  assert.equal(staticAttribute(button, 'type'), 'button');
  assert.match(textOf(button), /같은 조건.*전체.*다시 조회/);
  const calls = [];
  const click = attribute(button, 'onclick')?.value?.expression;
  assert.ok(click);
  evaluate(click, { lane: { source: 'daangn' }, retrySource: (source) => calls.push(source) })();
  assert.deepEqual(calls, ['daangn']);
  const disabled = attribute(button, 'disabled')?.value?.expression;
  assert.ok(disabled);
  assert.equal(evaluate(disabled, { lane: { state: 'loading' } }), true);
  assert.equal(evaluate(disabled, { lane: { state: 'done' } }), false);

  const enclosing = [];
  walk(template, (node) => {
    if (node.type === 'IfBlock' && containsNode(node.consequent, block)) enclosing.push(node);
  });
  assert.equal(enclosing.some((node) => /lane\.state|result\??\.status/.test(page.slice(node.test.start, node.test.end))), false,
    'The interruption explanation must also be reachable when every completed response failed.');
  const guard = enclosing.findLast((node) => page.slice(node.test.start, node.test.end).includes('interruption'));
  assert.ok(guard);
  assert.equal(!!evaluate(guard.test, { result: undefined }), false);
  for (const status of ['ok', 'empty', 'unavailable']) {
    assert.equal(!!evaluate(guard.test, { result: { status, interruption: { reason: 'timeout', remainingAreas: [{}] } } }), true);
  }

  const messages = [];
  walk(template, (node) => {
    if (node.type === 'ExpressionTag' && page.slice(node.expression.start, node.expression.end).includes('미완료 동네의 공고 유무')) {
      messages.push(node.expression);
    }
  });
  assert.equal(messages.length, 1);
  for (const status of ['empty', 'unavailable']) {
    const message = evaluate(messages[0], { result: { status, partial: false, interruption: { reason: 'cancelled', remainingAreas: [{}] } } });
    assert.match(message, /미완료.*아직/);
    assert.match(message, /같은 조건.*전체.*다시 조회/);
    assert.doesNotMatch(message, /실패한 동네만/);
  }
  const emptyHeading = all.filter(({ node }) => node.name === 'strong').flatMap(({ node }) => node.fragment.nodes)
    .find((node) => node.type === 'ExpressionTag' && /result\.interruption.*result\.status/s.test(page.slice(node.expression.start, node.expression.end)));
  assert.ok(emptyHeading);
  assert.doesNotMatch(evaluate(emptyHeading.expression, { result: { status: 'unavailable', interruption: {} } }), /공고가 없/,
    'Failed responses cannot establish an empty vacancy count.');
});

test('the conditional stop button exposes its actual element for guarded natural-completion focus', () => {
  const buttons = all.filter(({ node }) => node.name === 'button' && textOf(node) === '조회 중단');
  assert.equal(buttons.length, 1);
  const button = buttons[0].node;
  const binding = button.attributes.find((item) => item.type === 'BindDirective' && item.name === 'this');
  assert.equal(binding?.expression.type, 'Identifier');
  assert.equal(binding.expression.name, 'stopButton');
  const enclosing = [];
  walk(template, (node) => {
    if (node.type === 'IfBlock' && containsNode(node.consequent, button)) enclosing.push(node);
  });
  assert.ok(enclosing.some((node) => node.test.type === 'Identifier' && node.test.name === 'searching'),
    'The controller must move focus before the pending-only control is removed, not leave an inert stop action behind.');
  assert.equal(attribute(button, 'onclick')?.value?.expression?.name, 'cancelFromButton',
    'Natural completion must not change explicit cancellation into another action.');
});

// Static declaration contracts only: computed size, cascade, focus geometry and
// actual marker rendering remain browser checks, not claims made by these tests.
const style = `<style>${readFileSync(new URL('../src/app.css', import.meta.url), 'utf8')}</style>`;
const stylesheet = parse(style, { modern: true }).css;

test('map disclosure CSS declares a 44px minimum without suppressing its native marker or fixing its height', () => {
  const issues = [];
  let minimumDeclarations = 0;
  walk(stylesheet, (node) => {
    if (node.type !== 'Rule') return;
    for (const selector of node.prelude.children) {
      let map = false;
      let summary = false;
      let marker = false;
      walk(selector, (part) => {
        if (part.type === 'ClassSelector' && part.name === 'map-disclosure') map = true;
        if (part.type === 'TypeSelector' && part.name === 'summary') summary = true;
        if (part.type === 'PseudoElementSelector' && ['marker', '-webkit-details-marker'].includes(part.name)) marker = true;
      });
      if (!map || !summary && !marker) continue;
      const label = style.slice(selector.start, selector.end);
      for (const declaration of node.block.children.filter((item) => item.type === 'Declaration')) {
        const property = declaration.property.toLowerCase();
        const value = declaration.value.replace(/\s*!important\s*$/i, '').trim().toLowerCase();
        if (summary && !marker && property === 'min-height') {
          minimumDeclarations += 1;
          if (!/^\d+(?:\.\d+)?px$/.test(value) || Number.parseFloat(value) < 44) issues.push(`${label}: min-height ${value} is below the 44px declaration contract`);
        }
        if (summary && !marker && property === 'display' && value !== 'list-item') issues.push(`${label}: display ${value} replaces native list-item rendering`);
        if (['list-style', 'list-style-type'].includes(property) && /(^|\s)none($|\s)/.test(value)) issues.push(`${label}: ${property} ${value} suppresses the native marker`);
        if (marker && (property === 'display' && value === 'none'
          || property === 'content' && ['none', '""', "''"].includes(value)
          || property === 'visibility' && ['hidden', 'collapse'].includes(value))) issues.push(`${label}: ${property} ${value} hides the marker`);
        if (summary && !marker && ['height', 'block-size'].includes(property) && value !== 'auto') issues.push(`${label}: ${property} ${value} fixes the wrapping height`);
        if (summary && !marker && ['max-height', 'max-block-size'].includes(property) && value !== 'none') issues.push(`${label}: ${property} ${value} caps the wrapping height`);
      }
    }
  });
  assert.ok(minimumDeclarations > 0, 'The map summary needs an explicit minimum-height declaration.');
  assert.deepEqual(issues, []);
});

test('map help stays in a native labelled disclosure without hiding form or map actions', () => {
  const disclosures = all.filter(({ node }) => node.name === 'details' && hasClass(node, 'map-disclosure'));
  assert.equal(disclosures.length, 1);
  const details = disclosures[0].node;
  const children = elements(details.fragment);
  const summaries = children.filter(({ node }) => node.name === 'summary');
  assert.equal(summaries.length, 1);
  const summary = summaries[0].node;
  assert.ok(textOf(summary).length > 0);
  assert.equal(details.fragment.nodes.find((node) => node.type === 'RegularElement'), summary);
  assert.equal(attribute(summary, 'role'), undefined);
  assert.equal(summary.attributes.some((item) => /^(on)?(click|keydown|keyup)$/.test(item.name)), false,
    'Native details/summary must retain its own keyboard activation.');
  assert.equal(children.filter(({ node }) => ['button', 'input', 'select', 'textarea', 'a', 'form', 'details'].includes(node.name)).length, 0,
    'The disclosure is explanatory help; search and map actions must remain outside it.');
});

test('expanded map and neighborhood help declare at least 8px top spacing for the summary focus ring', () => {
  const margins = new Map(['.neighborhood-disclosure .area-help', '.map-disclosure p'].map((selector) => [selector, []]));
  walk(stylesheet, (node) => {
    if (node.type !== 'Rule') return;
    for (const selector of node.prelude.children) {
      const values = margins.get(style.slice(selector.start, selector.end).replace(/\s+/g, ' ').trim());
      if (!values) continue;
      for (const declaration of node.block.children) {
        if (declaration.type === 'Declaration' && ['margin', 'margin-top'].includes(declaration.property)) {
          values.push(declaration.value.replace(/\s*!important\s*$/i, '').trim().split(/\s+/)[0]);
        }
      }
    }
  });
  for (const [selector, values] of margins) {
    assert.ok(values.length > 0, `${selector} needs an explicit top-margin declaration.`);
    for (const value of values) assert.ok(/^\d+(?:\.\d+)?px$/.test(value) && Number.parseFloat(value) >= 8,
      `${selector}: top margin ${value} is below the 8px declaration contract.`);
  }
});
