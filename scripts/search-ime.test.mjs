import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { createContext, runInContext } from 'node:vm';
import ts from 'typescript';
import { parse } from 'svelte/compiler';

// Actual-handler and static-template boundary tests with synthetic key events.
// These do not emulate an OS IME, dispatch trusted browser input, or prove
// native composition/submit ordering. That browser check remains separate.
const source = readFileSync(new URL('../src/routes/+page.svelte', import.meta.url), 'utf8');
const page = parse(source, { modern: true });
const handler = page.instance.content.body.find((node) => node.type === 'FunctionDeclaration' && node.id?.name === 'handleQueryKeydown');

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

const elements = [];
walk(page.fragment, (node, ancestors) => {
  if (node.type === 'RegularElement') elements.push({ node, ancestors });
});
const queryInput = elements.find(({ node }) => node.name === 'input' && literalAttribute(node, 'id') === 'query');
const form = queryInput?.ancestors.findLast((node) => node.type === 'RegularElement' && node.name === 'form');

function harness() {
  assert.ok(handler, 'The real page must provide its composing-Enter keydown handler.');
  const calls = { search: 0, prevented: 0 };
  const context = createContext({ search: () => { calls.search += 1; }, query: '카페' });
  const executable = ts.transpileModule(source.slice(handler.start, handler.end), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None }
  }).outputText;
  runInContext(executable, context, { timeout: 1000 });
  return {
    calls, context,
    keydown(key, isComposing) {
      context.handleQueryKeydown({ key, isComposing, preventDefault: () => { calls.prevented += 1; } });
    }
  };
}

test('composing Enter prevents its default without searching or changing the query', () => {
  const f = harness();
  f.keydown('Enter', true);
  assert.deepEqual(f.calls, { search: 0, prevented: 1 });
  assert.equal(f.context.query, '카페');
});

test('ordinary Enter stays untouched and only the existing native form submit starts one search', () => {
  const f = harness();
  f.keydown('Enter', false);
  assert.deepEqual(f.calls, { search: 0, prevented: 0 });
  assert.ok(form);
  const submit = expressionAttribute(form, 'onsubmit');
  assert.ok(submit);
  const callback = runInContext(`(${source.slice(submit.start, submit.end)})`, f.context, { timeout: 1000 });
  callback({ preventDefault: () => { f.calls.prevented += 1; } });
  assert.deepEqual(f.calls, { search: 1, prevented: 1 });
});

test('other composing keys are not prevented and never directly search', () => {
  const f = harness();
  for (const key of ['ArrowLeft', 'ArrowRight', 'Escape', ' ', 'a', 'Process']) f.keydown(key, true);
  assert.deepEqual(f.calls, { search: 0, prevented: 0 });
  assert.equal(f.context.query, '카페');
});

test('the query input binds the composing-Enter handler while search buttons remain native submits', () => {
  assert.ok(queryInput);
  const keydown = expressionAttribute(queryInput.node, 'onkeydown');
  assert.equal(keydown?.type, 'Identifier');
  assert.equal(keydown.name, 'handleQueryKeydown');
  assert.ok(form);
  assert.ok(expressionAttribute(form, 'onsubmit'));
  const submits = elements.filter(({ node, ancestors }) => node.name === 'button'
    && ancestors.includes(form) && literalAttribute(node, 'class')?.split(/\s+/).includes('search-submit'));
  assert.ok(submits.length > 0);
  for (const { node } of submits) {
    assert.equal(literalAttribute(node, 'type'), 'submit');
    assert.equal(attribute(node, 'onclick'), undefined, 'Do not add a second search path to the submit buttons.');
  }
});
