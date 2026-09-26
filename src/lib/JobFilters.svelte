<script lang="ts">
  import { tick } from 'svelte';
  import { activeFilterChips, clearJobFilter, defaultJobFilters, updateJobFilters, type JobFilters, type JobFilterKey, type FilterResultSummary, type PayType, type DayFilter, type TimeFilter } from './filter-jobs';

  let { filters = $bindable(defaultJobFilters()), resultSummary } = $props<{ filters?: JobFilters; resultSummary?: FilterResultSummary }>();
  const chips = $derived(activeFilterChips(filters));
  const count = $derived(chips.length);
  const hasScheduleFilter = $derived(filters.days !== 'all' || filters.time !== 'all');
  const canSetHourly = $derived(filters.payType === 'all' || filters.payType === 'hourly');
  const canReset = $derived(count > 0 || Boolean(filters.include || filters.exclude || filters.includeUnknownSchedule));
  const validSummary = $derived(resultSummary && [resultSummary.loaded, resultSummary.visible, resultSummary.unverifiedSchedule].every((value) => Number.isInteger(value) && value >= 0)
    && resultSummary.visible <= resultSummary.loaded && resultSummary.unverifiedSchedule <= resultSummary.visible ? resultSummary : undefined);
  let chipList = $state<HTMLUListElement>();
  let disclosure: HTMLElement;
  let feedback = $state('');

  function change(changes: Partial<JobFilters>) {
    filters = updateJobFilters(filters, changes);
    feedback = '';
  }

  async function remove(key: JobFilterKey) {
    const index = chips.findIndex((chip) => chip.key === key);
    const label = chips[index]?.label || '선택한 조건';
    filters = clearJobFilter(filters, key);
    feedback = `${label} 조건을 해제했어요.`;
    await tick();
    const buttons = chipList?.querySelectorAll('button');
    (buttons?.[Math.min(index, buttons.length - 1)] || disclosure)?.focus();
  }

  async function reset() {
    filters = defaultJobFilters();
    feedback = '필터를 모두 초기화했어요. 불러온 공고를 조건 없이 표시합니다.';
    await tick();
    disclosure?.focus();
  }
</script>

<section class="filter-tool" aria-label="검색 결과 필터">
  <div class="applied-filters">
    <div class="applied-heading"><p>{count ? `적용 조건 ${count}개` : '적용한 필터가 없어요'}</p><button class="filter-reset" type="button" disabled={!canReset} onclick={reset}>필터 전체 초기화</button></div>
    {#if chips.length}
      <ul class="filter-chips" aria-label="적용 중인 필터, 버튼을 누르면 해당 조건 해제" bind:this={chipList}>
        {#each chips as chip (chip.key)}<li><button type="button" class:unknown-chip={chip.key === 'includeUnknownSchedule'} aria-label={`${chip.label} 조건 해제`} onclick={() => remove(chip.key)}><span>{chip.label}</span><span aria-hidden="true">×</span></button></li>{/each}
      </ul>
    {/if}
    {#if validSummary}
      <p class="filter-matches" role="status">불러온 {validSummary.loaded}건 중 <strong>{validSummary.visible}건 표시</strong>{#if hasScheduleFilter}<span>표시된 요일·시간 일치 <strong>{validSummary.visible - validSummary.unverifiedSchedule}건</strong></span><span class="needs-confirmation">추가 확인 필요 <strong>{validSummary.unverifiedSchedule}건</strong></span>{/if}</p>
    {/if}
    {#if hasScheduleFilter}<p class="schedule-summary">{filters.includeUnknownSchedule ? '요일·시간 정보가 부족한 공고도 포함해요. 조건에 맞는다고 확정한 공고는 아닙니다.' : '선택한 요일·시간을 확인할 수 있는 공고만 표시해요.'}</p>{/if}
    <p class="filter-feedback" role="status">{feedback}</p>
  </div>
<details class="filters-panel">
  <summary bind:this={disclosure}><span>필터 조건 편집 <span class="filter-badge">{count ? `${count}개 적용` : '조건 없음'}</span></span><span class="filter-disclosure" aria-hidden="true">⌄</span></summary>
  <div class="filters-content">
    <p class="filter-scope" id="filter-scope">각 업체에서 <strong>불러온 공고 안에서</strong> 즉시 적용합니다. 전체 공고를 다시 검색하는 조건은 아니에요.</p>
    <div class="filter-grid" aria-describedby="filter-scope">
      <label for="filter-pay">급여 형태
        <select id="filter-pay" value={filters.payType} onchange={(event) => change({ payType: event.currentTarget.value as PayType })}>
          <option value="all">전체</option><option value="hourly">시급</option><option value="daily">일급</option><option value="weekly">주급</option><option value="monthly">월급</option><option value="annual">연봉</option><option value="task">건당</option>
        </select>
      </label>
      <label for="filter-hourly">최소 시급
        <select id="filter-hourly" value={filters.minHourly} onchange={(event) => change({ minHourly: Number(event.currentTarget.value) })} disabled={!canSetHourly} aria-describedby="filter-pay-help">
          <option value={0}>제한 없음</option><option value={11000}>11,000원 이상</option><option value={12000}>12,000원 이상</option><option value={15000}>15,000원 이상</option><option value={20000}>20,000원 이상</option>
        </select>
      </label>
      <label for="filter-days">근무요일
        <select id="filter-days" value={filters.days} onchange={(event) => change({ days: event.currentTarget.value as DayFilter })} aria-describedby="filter-schedule-help">
          <option value="all">전체</option><option value="weekdays">평일만</option><option value="weekends">주말만</option><option value="negotiable">요일 협의</option>
        </select>
      </label>
      <label for="filter-time">근무 시작 시간대
        <select id="filter-time" value={filters.time} onchange={(event) => change({ time: event.currentTarget.value as TimeFilter })} aria-describedby="filter-schedule-help">
          <option value="all">전체</option><option value="morning">06–12시 · 오전</option><option value="afternoon">12–18시 · 오후</option><option value="evening">18–24시 · 저녁</option><option value="overnight">00–06시 · 새벽</option><option value="negotiable">시간 협의</option>
        </select>
      </label>
      <label for="filter-include">포함 키워드
        <input id="filter-include" value={filters.include} oninput={(event) => change({ include: event.currentTarget.value })} placeholder="예: 주말, 카페" aria-describedby="filter-keywords-help" />
      </label>
      <label for="filter-exclude">제외 키워드
        <input id="filter-exclude" value={filters.exclude} oninput={(event) => change({ exclude: event.currentTarget.value })} placeholder="예: 배달, 영업" aria-describedby="filter-keywords-help" />
      </label>
    </div>
    <div class="filter-help">
      <p id="filter-pay-help">최소 시급은 확정된 표시 시급만 비교해요. 월급·일급 환산이나 협의·범위 금액 추정은 하지 않습니다.</p>
      <p id="filter-schedule-help">요일·시간은 표시된 조건 기준입니다. 주5일을 평일로 추정하지 않고, 시간대는 시작 시각으로 구분해요. 알바천국은 현재 목록에 요일·시간 정보가 없습니다.</p>
      <p id="filter-keywords-help">키워드는 제목·회사명에서 찾아요. 쉼표로 구분하며, 포함은 모든 단어 · 제외는 하나라도 있으면 적용합니다.</p>
    </div>
    <div class="filter-bottom">
      <label class="unknown-schedule"><input type="checkbox" checked={hasScheduleFilter && filters.includeUnknownSchedule} onchange={(event) => change({ includeUnknownSchedule: event.currentTarget.checked })} disabled={!hasScheduleFilter} /> 요일·시간 미확인 공고도 포함</label>
    </div>
    {#if hasScheduleFilter}<p class="unknown-help">{filters.includeUnknownSchedule ? '조건 일치 여부를 확인할 수 없는 공고도 보여주고, “선택한 근무조건 확인 필요”로 표시해요. 명시적으로 불일치하는 공고는 제외합니다.' : '선택한 요일·시간 조건을 확인할 수 없는 공고는 제외합니다.'}</p>{/if}
  </div>
</details>
</section>

<style>
  .filter-tool { margin-bottom: 20px; color: var(--ink, #302d29); }
  .applied-filters { padding: 16px 18px; background: var(--surface-soft, #f5f1e9); border: 1px solid var(--line, #ded8ce); border-radius: 12px 12px 0 0; }
  .applied-heading { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 8px 14px; }
  .applied-heading p { margin: 0; font-size: .875rem; font-weight: 600; }
  .filter-reset { min-height: 44px; padding: 10px 13px; color: var(--ink, #302d29); background: transparent; border-color: var(--line, #ded8ce); }
  .filter-chips { display: flex; flex-wrap: wrap; gap: 8px; list-style: none; padding: 0; margin: 12px 0 0; }
  .filter-chips li { max-width: 100%; min-width: 0; }
  .filter-chips button { display: flex; align-items: center; justify-content: space-between; gap: 12px; min-height: 44px; max-width: 100%; border: 1px solid var(--line, #ded8ce); border-radius: 8px; padding: 9px 12px; text-align: left; line-height: 1.5; font-size: .8125rem; color: var(--ink, #302d29); background: #fffdf8; }
  .filter-chips button > span:first-child { min-width: 0; overflow-wrap: anywhere; }
  .filter-chips button > span:last-child { font-size: 1.125rem; flex-shrink: 0; }
  .filter-chips button:hover, .filter-reset:hover:not(:disabled) { background: var(--accent-soft, #f7e6d4); }
  .filter-chips .unknown-chip { border-style: dashed; background: var(--accent-soft, #f7e6d4); }
  .filter-matches { display: flex; flex-wrap: wrap; gap: 5px 12px; font-size: .8125rem; line-height: 1.7; margin: 12px 0 0; color: var(--muted, #6d655b); }
  .filter-matches strong { color: var(--ink, #302d29); }
  .needs-confirmation { border-bottom: 1px dashed currentColor; }
  .schedule-summary, .filter-feedback { margin: 8px 0 0; color: var(--muted, #6d655b); font-size: .75rem; line-height: 1.7; }
  .filter-feedback { overflow-wrap: anywhere; }
  .filter-feedback:empty { margin: 0; }
  .filters-panel { margin-bottom: 0; border-color: var(--line, #ded8ce); border-top: 0; border-radius: 0 0 12px 12px; background: #fffdf8; }
  .filters-panel summary { min-height: 44px; color: var(--ink, #302d29); }
  .filter-badge { background: var(--surface-soft, #f5f1e9); color: var(--muted, #6d655b); }
  .filter-scope, .filter-help p, .unknown-help { color: var(--muted, #6d655b); }
  .filter-grid label, .unknown-schedule { color: var(--ink, #302d29); }
  .filter-grid select, .filter-grid input { color: var(--ink, #302d29); border-color: var(--line, #ded8ce); background: var(--surface-soft, #f5f1e9); }
  .filter-bottom { border-color: var(--line, #ded8ce); }
  .unknown-schedule { min-height: 44px; }
  .unknown-schedule input { accent-color: var(--ink, #302d29); }
  button:focus-visible, summary:focus-visible, input:focus-visible, select:focus-visible { outline: 3px solid var(--ink, #302d29); outline-offset: 3px; }
  @media (max-width: 600px) { .applied-filters { padding: 12px; } .filter-chips { gap: 7px; } }
</style>
