import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { parse } from 'svelte/compiler';
import { aggregateDaangnResults, finalizeInterruptedDaangn } from '../src/lib/daangn-multi.ts';
import { defaultJobFilters, filterJobs } from '../src/lib/filter-jobs.ts';

// Evaluate the actual provider-nav template expression with real aggregation
// and filtering. All areas, listings and URLs below are synthetic fixtures;
// no requests are made. This is not browser geometry or screen-reader evidence.
const page = readFileSync(new URL('../src/routes/+page.svelte', import.meta.url), 'utf8');
const component = parse(page, { modern: true });
const query = '합성';
const areas = ['합성동', '검증동', '테스트동'].map((bname, index) => ({
  sido: '서울', sigungu: '마포구', bname,
  bcode: `11440${String(index + 1).padStart(5, '0')}`, sigunguCode: '11440'
}));

function walk(node, visit) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) { for (const item of node) walk(item, visit); return; }
  visit(node);
  for (const [key, value] of Object.entries(node)) {
    if (!['loc', 'name_loc'].includes(key)) walk(value, visit);
  }
}

function literalAttribute(node, name) {
  const value = node.attributes.find((item) => item.type === 'Attribute' && item.name === name)?.value;
  return Array.isArray(value) && value.every((item) => item.type === 'Text')
    ? value.map((item) => item.data).join('') : undefined;
}

function navStatusExpression() {
  const navs = [];
  walk(component.fragment, (node) => {
    if (node.type === 'RegularElement' && node.name === 'nav'
      && literalAttribute(node, 'class')?.split(/\s+/).includes('provider-nav')) navs.push(node);
  });
  assert.equal(navs.length, 1);
  const loops = navs[0].fragment.nodes.filter((node) => node.type === 'EachBlock');
  assert.equal(loops.length, 1);
  assert.equal(loops[0].expression.type, 'Identifier');
  assert.equal(loops[0].expression.name, 'filteredLanes');
  assert.equal(loops[0].context.name, 'lane');
  const expressions = [];
  walk(loops[0].body, (node) => {
    if (node.type !== 'RegularElement' || node.name !== 'span') return;
    const content = node.fragment.nodes.filter((item) => item.type !== 'Text' || item.data.trim());
    if (content.length === 1 && content[0].type === 'ExpressionTag'
      && content[0].expression.type === 'ConditionalExpression') expressions.push(content[0].expression);
  });
  assert.equal(expressions.length, 1, 'Read the actual status span, not a copied status formatter.');
  return expressions[0];
}

const expression = navStatusExpression();
const navStatus = (lane) => runInNewContext(`(${page.slice(expression.start, expression.end)})`, { lane }, { timeout: 1000 });

function regionResult(status, index) {
  return {
    source: 'daangn', status,
    jobs: status === 'ok' ? [{
      id: `synthetic-nav-${index}`, title: '합성 카페 공고', company: '합성 사업장',
      url: `https://jobs.daangn.com/job-posts/synthetic-nav-${index}`
    }] : [],
    searchUrl: `https://jobs.daangn.com/s?${new URLSearchParams({ query, regionId: String(index + 1) })}`,
    checkedAt: '2026-09-27T00:00:00.000Z'
  };
}

function aggregate(...statuses) {
  return aggregateDaangnResults(query, statuses.map((status, index) => ({
    area: areas[index], result: regionResult(status, index)
  })));
}

function laneFor(result, filters = defaultJobFilters()) {
  return { source: 'daangn', state: 'done', result, visible: filterJobs(result.jobs, filters) };
}

test('an empty successful neighborhood plus a failed neighborhood is zero with partial failure, not confirmed overall empty', () => {
  const result = aggregate('empty', 'unavailable');
  assert.equal(result.status, 'empty');
  assert.equal(result.partial, true);
  assert.equal(result.jobs.length, 0);
  assert.equal(navStatus(laneFor(result)), '0건 · 일부 실패');
});

test('loaded listings plus a failed neighborhood retain the visible count and partial-failure qualifier', () => {
  const result = aggregate('ok', 'unavailable');
  assert.equal(result.status, 'ok');
  assert.equal(result.partial, true);
  assert.equal(result.jobs.length, 1);
  assert.equal(navStatus(laneFor(result)), '1건 · 일부 실패');
});

test('filtering all loaded listings out does not hide an existing neighborhood failure', () => {
  const result = aggregate('ok', 'unavailable');
  const lane = laneFor(result, { ...defaultJobFilters(), include: '없는조건' });
  assert.equal(lane.result.jobs.length, 1);
  assert.equal(lane.visible.length, 0);
  assert.equal(lane.result.partial, true);
  assert.equal(navStatus(lane), '0건 · 일부 실패');
});

test('complete empty and successful results retain plain visible counts for every provider', () => {
  for (const source of ['albamon', 'daangn', 'alba']) {
    const empty = aggregate('empty', 'empty');
    const success = aggregate('ok', 'empty');
    assert.equal(empty.partial, false);
    assert.equal(success.partial, false);
    assert.equal(navStatus({ ...laneFor(empty), source }), '0건');
    assert.equal(navStatus({ ...laneFor(success), source }), '1건');
    assert.equal(navStatus({ ...laneFor(success, { ...defaultJobFilters(), exclude: '카페' }), source }), '0건');
  }
});

test('whole-provider unavailable and request errors keep their failure label', () => {
  const unavailable = aggregate('unavailable', 'unavailable');
  assert.equal(unavailable.status, 'unavailable');
  assert.equal(unavailable.partial, false);
  assert.equal(navStatus(laneFor(unavailable)), '실패');
  assert.equal(navStatus({ source: 'alba', state: 'done', error: '합성 요청 실패', visible: [] }), '실패');
  assert.equal(navStatus({ ...laneFor(aggregate('ok', 'unavailable')), error: '합성 요청 실패' }), '실패');
});

test('interrupted progress outranks partial failure, while explicit cancellation retains its own label', () => {
  const completed = aggregate('ok', 'unavailable');
  const interrupted = finalizeInterruptedDaangn(query, areas, {
    total: areas.length, entries: completed.regionEntries
  }, 'cancelled');
  assert.equal(interrupted.partial, true);
  assert.equal(interrupted.interruption.remainingAreas.length, 1);
  assert.equal(navStatus(laneFor(interrupted)), '1건 · 미완료');
  assert.equal(navStatus(laneFor(interrupted, { ...defaultJobFilters(), include: '없는조건' })), '0건 · 미완료');
  assert.equal(navStatus({ source: 'albamon', state: 'done', cancelled: true, visible: [] }), '중단');
  // Deliberate overlapping flags protect the existing display precedence;
  // they do not claim that the controller produces every combination.
  assert.equal(navStatus({ ...laneFor(interrupted), cancelled: true, error: '합성 요청 실패' }), '중단');
});

test('loading and failed-only retry keep the loading label ahead of retained results and terminal flags', () => {
  assert.equal(navStatus({ source: 'daangn', state: 'loading', visible: [] }), '조회 중');
  const retained = laneFor(aggregate('ok', 'unavailable'));
  assert.equal(navStatus({ ...retained, state: 'loading' }), '조회 중');
  assert.equal(navStatus({ ...retained, state: 'loading', retryingFailed: true }), '조회 중');
  assert.equal(navStatus({ ...retained, state: 'loading', retryingFailed: true, cancelled: true, error: '합성 요청 실패' }), '조회 중');
});
