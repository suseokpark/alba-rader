import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { parse } from 'svelte/compiler';
import * as multi from '../src/lib/daangn-multi.ts';

// Pure URL predicates and shipped Svelte-template contracts only. No browser,
// external navigation, provider requests, or screen-reader behavior is exercised.
const pageSource = readFileSync(new URL('../src/routes/+page.svelte', import.meta.url), 'utf8');
const regionSource = readFileSync(new URL('../src/lib/DaangnRegionResults.svelte', import.meta.url), 'utf8');
const page = parse(pageSource, { modern: true });
const regions = parse(regionSource, { modern: true });
const validUrl = 'https://jobs.daangn.com/s?query=%EC%B9%B4%ED%8E%98&regionId=230';
const queryOnly = 'https://jobs.daangn.com/s?query=%EC%B9%B4%ED%8E%98';

function predicate() {
  assert.equal(typeof multi.hasDaangnRegion, 'function', 'The shared real URL predicate must be exported.');
  return multi.hasDaangnRegion;
}

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

function literal(node, name) {
  const value = attribute(node, name)?.value;
  return Array.isArray(value) && value.every((part) => part.type === 'Text') ? value.map((part) => part.data).join('') : undefined;
}

function expression(node, name) {
  const value = attribute(node, name)?.value;
  return Array.isArray(value) && value.length === 1 ? value[0].expression : value?.expression;
}

function evaluate(source, node, context) {
  assert.ok(node, 'Expected the actual template expression.');
  return runInNewContext(`(${source.slice(node.start, node.end)})`, context, { timeout: 1000 });
}

function textFor(source, node, context) {
  if (node.type === 'Text') return node.data;
  if (node.type === 'ExpressionTag') return String(evaluate(source, node.expression, context));
  return (node.nodes || node.fragment?.nodes || []).map((child) => textFor(source, child, context)).join('');
}

function elements(root) {
  const found = [];
  walk(root, (node, ancestors) => { if (node.type === 'RegularElement') found.push({ node, ancestors }); });
  return found;
}

function importsPredicate(component) {
  return component.instance.content.body.some((node) => node.type === 'ImportDeclaration'
    && /(?:^|\/)daangn-multi(?:\.ts)?$/.test(node.source.value)
    && node.specifiers.some((item) => item.imported?.name === 'hasDaangnRegion' && item.local.name === 'hasDaangnRegion'));
}

const all = elements(page.fragment);
const original = all.find(({ node }) => node.name === 'a' && literal(node, 'class')?.split(/\s+/).includes('source-original'));

test('shared Daangn predicate accepts one positive safe-integer decimal region on the official search path', () => {
  const hasRegion = predicate();
  for (const id of ['1', '230', '000230', String(Number.MAX_SAFE_INTEGER)]) {
    assert.equal(hasRegion(`https://jobs.daangn.com/s?query=cafe&regionId=${id}`), true, id);
  }
});

test('shared Daangn predicate rejects absent, ambiguous, invalid or untrusted regional links', () => {
  const hasRegion = predicate();
  const invalid = [queryOnly, '', '/s?regionId=230', 'not a URL',
    ...['', '0', '000', '-1', '+1', '1.0', '1e2', 'NaN', 'Infinity', '２３０', '9007199254740992']
      .map((id) => `https://jobs.daangn.com/s?regionId=${encodeURIComponent(id)}`),
    'https://jobs.daangn.com/s?regionId=230&regionId=230',
    'https://jobs.daangn.com/s?regionId=230&regionId=231',
    'https://jobs.daangn.com/s?regionId=&regionId=230',
    'http://jobs.daangn.com/s?regionId=230',
    'https://jobs.daangn.com.evil.invalid/s?regionId=230',
    'https://evil.invalid/s?regionId=230',
    'https://jobs.daangn.com/s/?regionId=230',
    'https://jobs.daangn.com/job-posts/example?regionId=230',
    'https://user@jobs.daangn.com/s?regionId=230',
    'https://user:password@jobs.daangn.com/s?regionId=230'];
  for (const url of invalid) assert.equal(hasRegion(url), false, url);
});

test('single original links keep their supplied href and safe new-tab attributes outside multi-region results', () => {
  assert.ok(original);
  const gate = original.ancestors.findLast((node) => node.type === 'IfBlock');
  assert.ok(gate);
  for (const [result, expected] of [[undefined, false], [{ searchUrl: validUrl }, true],
    [{ searchUrl: queryOnly, status: 'unavailable' }, true], [{ searchUrl: validUrl, regionResults: [] }, false],
    [{ searchUrl: validUrl, regionResults: [{}] }, false]]) {
    assert.equal(Boolean(evaluate(pageSource, gate.test, { result })), expected);
  }
  for (const searchUrl of [validUrl, queryOnly, 'https://www.albamon.com/total-search?keyword=cafe', 'https://www.alba.co.kr/search/Search?wsSrchWord=cafe']) {
    assert.equal(evaluate(pageSource, expression(original.node, 'href'), { result: { searchUrl } }), searchUrl);
  }
  assert.equal(literal(original.node, 'target'), '_blank');
  assert.deepEqual(literal(original.node, 'rel')?.split(/\s+/).sort(), ['noopener', 'noreferrer']);
});

test('only a single Daangn link missing its region exposes the connected warning and unapplied-region label', () => {
  assert.ok(original);
  assert.ok(importsPredicate(page));
  const hasDaangnRegion = predicate();
  let missing;
  walk(page.fragment, (node) => {
    if (node.type === 'VariableDeclarator' && node.id?.name === 'missingOriginalRegion') missing = node.init;
  });
  assert.ok(missing);
  const warning = all.find(({ node }) => literal(node, 'id') === 'original-region-help-daangn');
  assert.ok(warning);
  assert.equal(warning.node.name, 'p');
  assert.ok(literal(warning.node, 'class')?.split(/\s+/).includes('region-note'));
  assert.equal(textFor(pageSource, warning.node, {}).trim(), '선택한 동네가 이 링크에 적용되지 않았어요. 원문에서 동네를 다시 선택해 주세요.');
  const warningGate = warning.ancestors.findLast((node) => node.type === 'IfBlock');
  const originalGate = original.ancestors.findLast((node) => node.type === 'IfBlock');
  assert.ok(warning.ancestors.includes(originalGate), 'Keep the warning inside the single-result gate.');
  for (const [id, name, searchUrl, expected] of [
    ['daangn', '당근', queryOnly, true], ['daangn', '당근', validUrl, false],
    ['albamon', '알바몬', 'https://www.albamon.com/total-search?keyword=cafe', false],
    ['alba', '알바천국', 'https://www.alba.co.kr/search/Search?wsSrchWord=cafe', false]
  ]) {
    const context = { lane: { source: id }, source: { name }, result: { searchUrl }, hasDaangnRegion };
    const missingOriginalRegion = evaluate(pageSource, missing, context);
    assert.equal(missingOriginalRegion, expected);
    Object.assign(context, { missingOriginalRegion });
    assert.equal(Boolean(evaluate(pageSource, warningGate.test, context)), expected);
    assert.equal(evaluate(pageSource, expression(original.node, 'aria-describedby'), context), expected ? 'original-region-help-daangn' : undefined);
    assert.equal(textFor(pageSource, original.node, context).replace(/\s*↗\s*$/, '').trim(),
      expected ? '당근 원문 검색 · 지역 미적용' : `${name} 전체 검색 결과`);
  }
});

test('multi-region original links reuse the exported predicate and retain their existing labels and destinations', () => {
  assert.ok(importsPredicate(regions));
  const hasDaangnRegion = predicate();
  const link = elements(regions.fragment).find(({ node }) => node.name === 'a' && literal(node, 'class') === 'region-original')?.node;
  assert.ok(link);
  let usesPredicate = false;
  walk(link.fragment, (node) => { if (node.type === 'CallExpression' && node.callee?.name === 'hasDaangnRegion') usesPredicate = true; });
  assert.equal(usesPredicate, true);
  for (const [searchUrl, label] of [[validUrl, '이 동네 원문 검색'], [queryOnly, '당근 원문 검색 · 지역 미적용']]) {
    const context = { region: { searchUrl }, hasDaangnRegion };
    assert.equal(evaluate(regionSource, expression(link, 'href'), context), searchUrl);
    assert.equal(textFor(regionSource, link, context).replace(/\s*↗\s*$/, '').trim(), label);
  }
  assert.equal(literal(link, 'target'), '_blank');
  assert.deepEqual(literal(link, 'rel')?.split(/\s+/).sort(), ['noopener', 'noreferrer']);
});
