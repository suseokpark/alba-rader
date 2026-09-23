<script lang="ts">
  import { activeFilterCount, defaultJobFilters, type JobFilters, type PayType } from './filter-jobs';

  let { filters = $bindable(defaultJobFilters()) } = $props<{ filters?: JobFilters }>();
  const count = $derived(activeFilterCount(filters));
  const hasScheduleFilter = $derived(filters.days !== 'all' || filters.time !== 'all');
  const canSetHourly = $derived(filters.payType === 'all' || filters.payType === 'hourly');

  function changePayType(value: PayType) {
    // A non-hourly pay type must not retain an incompatible hourly threshold.
    filters = { ...filters, payType: value, minHourly: value === 'all' || value === 'hourly' ? filters.minHourly : 0 };
  }
</script>

<details class="filters-panel" open>
  <summary><span>결과 필터 <span class="filter-badge">{count ? `${count}개 적용` : '조건 없음'}</span></span><span class="filter-disclosure" aria-hidden="true">⌄</span></summary>
  <div class="filters-content">
    <p class="filter-scope" id="filter-scope">각 업체에서 <strong>불러온 공고 안에서</strong> 즉시 적용합니다. 전체 공고를 다시 검색하는 조건은 아니에요.</p>
    <div class="filter-grid" aria-describedby="filter-scope">
      <label for="filter-pay">급여 형태
        <select id="filter-pay" value={filters.payType} onchange={(event) => changePayType(event.currentTarget.value as PayType)}>
          <option value="all">전체</option><option value="hourly">시급</option><option value="daily">일급</option><option value="weekly">주급</option><option value="monthly">월급</option><option value="annual">연봉</option><option value="task">건당</option>
        </select>
      </label>
      <label for="filter-hourly">최소 시급
        <select id="filter-hourly" bind:value={filters.minHourly} disabled={!canSetHourly} aria-describedby="filter-pay-help">
          <option value={0}>제한 없음</option><option value={11000}>11,000원 이상</option><option value={12000}>12,000원 이상</option><option value={15000}>15,000원 이상</option><option value={20000}>20,000원 이상</option>
        </select>
      </label>
      <label for="filter-days">근무요일
        <select id="filter-days" bind:value={filters.days} aria-describedby="filter-schedule-help">
          <option value="all">전체</option><option value="weekdays">평일만</option><option value="weekends">주말만</option><option value="negotiable">요일 협의</option>
        </select>
      </label>
      <label for="filter-time">근무 시작 시간대
        <select id="filter-time" bind:value={filters.time} aria-describedby="filter-schedule-help">
          <option value="all">전체</option><option value="morning">오전 시작 · 06–12시</option><option value="afternoon">오후 시작 · 12–18시</option><option value="evening">저녁 시작 · 18–24시</option><option value="overnight">새벽 시작 · 00–06시</option><option value="negotiable">시간 협의</option>
        </select>
      </label>
      <label for="filter-include">포함 키워드
        <input id="filter-include" bind:value={filters.include} maxlength="120" placeholder="예: 주말, 카페" aria-describedby="filter-keywords-help" />
      </label>
      <label for="filter-exclude">제외 키워드
        <input id="filter-exclude" bind:value={filters.exclude} maxlength="120" placeholder="예: 배달, 영업" aria-describedby="filter-keywords-help" />
      </label>
    </div>
    <div class="filter-help">
      <p id="filter-pay-help">최소 시급은 확정된 표시 시급만 비교해요. 월급·일급 환산이나 협의·범위 금액 추정은 하지 않습니다.</p>
      <p id="filter-schedule-help">요일·시간은 표시된 조건 기준입니다. 주5일을 평일로 추정하지 않고, 시간대는 시작 시각으로 구분해요. 알바천국은 현재 목록에 요일·시간 정보가 없습니다.</p>
      <p id="filter-keywords-help">키워드는 제목·회사명에서 찾아요. 쉼표로 구분하며, 포함은 모든 단어 · 제외는 하나라도 있으면 적용합니다.</p>
    </div>
    <div class="filter-bottom">
      <label class="unknown-schedule"><input type="checkbox" bind:checked={filters.includeUnknownSchedule} disabled={!hasScheduleFilter} /> 요일·시간 미확인 공고도 포함</label>
      <button class="filter-reset" type="button" disabled={!count && !filters.include && !filters.exclude && !filters.includeUnknownSchedule} onclick={() => { filters = defaultJobFilters(); }}>필터 초기화</button>
    </div>
    {#if hasScheduleFilter}<p class="unknown-help">{filters.includeUnknownSchedule ? '조건 일치 여부를 확인할 수 없는 공고도 보여주고, “선택한 근무조건 확인 필요”로 표시해요. 명시적으로 불일치하는 공고는 제외합니다.' : '선택한 요일·시간 조건을 확인할 수 없는 공고는 제외합니다.'}</p>{/if}
  </div>
</details>
