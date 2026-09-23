<script lang="ts">
  import { onDestroy } from 'svelte';
  import { sources, type SourceId, type SearchResult } from '$lib/search';
  import { createPostcodeSearch, selectedAddress, type SelectedAddress, type PostcodeStatus } from '$lib/postcode';
  import { sortJobs, type SortOrder } from '$lib/sort-jobs';
  import JobFiltersPanel from '$lib/JobFilters.svelte';
  import { activeFilterCount, defaultJobFilters, filterJobs } from '$lib/filter-jobs';

  type Lane = { source: SourceId; state: 'loading' | 'done'; result?: SearchResult; error?: string };
  let query = $state('');
  let selected = $state<SourceId[]>(sources.map((source) => source.id));
  let submitted = $state('');
  let lanes = $state<Lane[]>([]);
  let validation = $state('');
  let scope = $state<'nationwide' | 'address'>('address');
  let address = $state<SelectedAddress | null>(null);
  let submittedArea = $state('');
  let sortOrder = $state<SortOrder>('source');
  let filters = $state(defaultJobFilters());
  let postcodeDialog: HTMLDialogElement;
  let postcodeContainer: HTMLDivElement;
  let addressTrigger: HTMLButtonElement;
  let postcodeStatus = $state<PostcodeStatus | 'idle'>('idle');
  let postcodeError = $state('');
  const postcodeSearch = createPostcodeSearch();
  const activeSources = $derived(selected.filter((id) => scope === 'address' || id !== 'daangn'));
  let controller: AbortController | undefined;
  let generation = 0;

  const searching = $derived(lanes.some((lane) => lane.state === 'loading'));
  const finished = $derived(lanes.filter((lane) => lane.state === 'done').length);
  const failed = $derived(lanes.filter((lane) => lane.error || lane.result?.status === 'unavailable').length);
  const total = $derived(lanes.reduce((sum, lane) => sum + (lane.result?.jobs.length || 0), 0));
  const filterCount = $derived(activeFilterCount(filters));
  const filteredLanes = $derived(lanes.map((lane) => ({
    ...lane, visible: filterJobs(sortJobs(lane.result?.jobs || [], sortOrder), filters)
  })));
  const visibleTotal = $derived(filteredLanes.reduce((sum, lane) => sum + lane.visible.length, 0));
  const unverifiedTotal = $derived(filteredLanes.reduce((sum, lane) => sum + lane.visible.filter((item) => item.unverifiedSchedule).length, 0));
  const suggestions = ['카페', '편의점', '서빙', '물류', '사무보조', '주말'];

  function openAddressSearch() {
    if (!postcodeDialog.open) postcodeDialog.showModal();
    postcodeError = '';
    void postcodeSearch.open(postcodeContainer, {
      status: (state, message) => { postcodeStatus = state; postcodeError = message || ''; },
      complete: (data) => {
        address = selectedAddress(data);
        scope = 'address';
        validation = '';
        closeAddressSearch();
      }
    });
  }

  function closeAddressSearch() {
    postcodeSearch.close();
    postcodeStatus = 'idle';
    postcodeDialog.close();
    addressTrigger?.focus();
  }

  function addressDialogClosed() {
    // A queued close event must not cancel a newer dialog opened in the meantime.
    if (postcodeDialog.open) return;
    postcodeSearch.close();
    postcodeStatus = 'idle';
    addressTrigger?.focus();
  }

  function clearAddress() {
    address = null;
    scope = 'address';
    validation = '';
  }

  function toggleSource(source: SourceId) {
    selected = selected.includes(source) ? selected.filter((item) => item !== source) : [...selected, source];
    validation = '';
  }

  async function search() {
    const value = query.trim();
    if (!value || value.length > 80) {
      validation = '검색어를 1~80자로 입력해주세요.';
      return;
    }
    if (scope === 'address' && !address) {
      validation = '주소 찾기로 기준 주소를 지정하거나 전국을 선택해주세요.';
      return;
    }
    if (!activeSources.length) {
      validation = '검색할 업체를 하나 이상 선택해주세요.';
      return;
    }
    controller?.abort();
    controller = new AbortController();
    const signal = controller.signal;
    const currentGeneration = ++generation;
    const requested = sources.filter((source) => activeSources.includes(source.id));
    const area = scope === 'address' && address ? {
      sido: address.sido, sigungu: address.sigungu, bname: address.bname,
      bcode: address.bcode, sigunguCode: address.sigunguCode
    } : undefined;
    const searchScope = scope;
    submitted = value;
    submittedArea = area ? `${area.sido} ${area.sigungu} ${area.bname}`.trim() : '전국';
    validation = '';
    lanes = requested.map((source) => ({ source: source.id, state: 'loading' }));

    // Dispatch all selected sources immediately; render each response as it arrives.
    await Promise.allSettled(requested.map(async ({ id }) => {
      try {
        const response = await fetch(`/api/search?${new URLSearchParams({ q: value, source: id, scope: searchScope, ...area })}`, { signal });
        if (!response.ok) throw new Error('조회에 실패했습니다. 잠시 후 다시 검색해주세요.');
        const result: SearchResult = await response.json();
        if (generation !== currentGeneration) return;
        lanes = lanes.map((lane) => lane.source === id ? { source: id, state: 'done', result } : lane);
      } catch (error) {
        if (signal.aborted || generation !== currentGeneration) return;
        lanes = lanes.map((lane) => lane.source === id ? {
          source: id, state: 'done', error: error instanceof Error ? error.message : '연결을 확인하고 다시 검색해주세요.'
        } : lane);
      }
    }));
  }

  function suggest(value: string) { query = value; void search(); }
  function time(iso: string) { return new Date(iso).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' }); }
  onDestroy(() => { controller?.abort(); postcodeSearch.close(); });
</script>

<svelte:head>
  <title>알바레이더 | 세 업체 동시 검색</title>
  <meta name="description" content="알바몬, 당근, 알바천국의 공개 공고를 동시에 검색하고 비교하세요." />
</svelte:head>

<main>
  <header>
    <a class="brand" href="/" aria-label="알바레이더 홈"><span aria-hidden="true">◉</span> 알바레이더</a>
    <span class="header-note">알바몬 · 당근 · 알바천국</span>
  </header>

  <section class="search-section" aria-labelledby="page-title">
    <div class="intro"><p class="eyebrow">THREE SOURCES. ONE SEARCH.</p><h1 id="page-title">세 곳의 알바를, <em>한 번에.</em></h1><p>검색어 하나로 세 업체의 공고를 동시에 조회해요.</p></div>
    <form class="search-panel" onsubmit={(event) => { event.preventDefault(); void search(); }}>
      <div class="area-controls">
        <div class="area-top"><span class="area-label">어디에서 일하고 싶으세요?</span><div class="scope-options" aria-label="검색 범위"><button type="button" aria-pressed={scope === 'address'} class:active={scope === 'address'} disabled={searching} onclick={() => { scope = 'address'; validation = ''; }}>주소 기준</button><button type="button" aria-pressed={scope === 'nationwide'} class:active={scope === 'nationwide'} disabled={searching} onclick={() => { scope = 'nationwide'; validation = ''; }}>전국</button></div></div>
        <div class="address-row" class:muted-address={scope === 'nationwide'}><div class="address-value">{#if address}<span class="postcode">{address.zonecode}</span><strong>{address.address}</strong><span class="address-area">{address.sido} {address.sigungu} {address.bname}</span>{:else}<span>{scope === 'address' ? '동네를 찾을 기준 주소를 지정해주세요.' : '지역 제한 없이 검색합니다.'}</span>{/if}</div><button type="button" class="address-find" bind:this={addressTrigger} disabled={searching} onclick={() => void openAddressSearch()}>{address ? '주소 변경' : '주소 찾기'}</button>{#if address}<button type="button" class="address-clear" disabled={searching} aria-label="선택한 주소 지우기" onclick={clearAddress}>×</button>{/if}</div>
        <p class="area-help">{scope === 'nationwide' ? '전국은 알바몬·알바천국에서 검색합니다. 당근은 주소 지정이 필요해요.' : '다음 우편번호 검색으로 주소를 지정합니다. 선택한 주소의 지역을 검색에 적용해요.'}</p>
      </div>
      <label for="query">어떤 알바를 찾으세요?</label>
      <div class="search-field">
        <input id="query" bind:value={query} maxlength="80" placeholder="예: 카페, 편의점, 주말" autocomplete="off" aria-describedby="query-hint" />
        <button class="search-submit" type="submit" disabled={searching}>{#if searching}<span class="spinner" aria-hidden="true"></span> {finished}/{lanes.length} 조회 중{:else}{activeSources.length}개 업체 동시 검색 <span aria-hidden="true">→</span>{/if}</button>
      </div>
      <div class="search-options"><div class="source-options" aria-label="검색할 업체">{#each sources as source}<button type="button" class={`source-toggle ${source.id}`} class:chosen={activeSources.includes(source.id)} aria-pressed={activeSources.includes(source.id)} disabled={searching || (scope === 'nationwide' && source.id === 'daangn')} onclick={() => toggleSource(source.id)}><span aria-hidden="true">{activeSources.includes(source.id) ? '✓' : '+'}</span> {source.name}{#if scope === 'nationwide' && source.id === 'daangn'} · 주소 필요{/if}</button>{/each}</div><p id="query-hint">공고 목록이 이 화면에 표시됩니다.</p></div>
      {#if validation}<p class="validation" role="alert">{validation}</p>{/if}
    </form>
    <div class="suggestions"><span>빠른 검색</span>{#each suggestions as suggestion}<button type="button" disabled={searching} onclick={() => suggest(suggestion)}>{suggestion} <span aria-hidden="true">↗</span></button>{/each}</div>
  </section>

  <section class="results" aria-labelledby="results-title" aria-busy={searching}>
    <div class="results-heading"><div><p class="eyebrow">{submitted ? 'SEARCH RESULTS' : 'READY WHEN YOU ARE'}</p><h2 id="results-title">{submitted ? `“${submitted}” 검색 결과` : '찾고 싶은 일을 검색해보세요'}</h2>{#if submitted}<p class="searched-area">적용 지역: {submittedArea}</p>{/if}</div>{#if submitted}<p class="progress" role="status">{searching ? `${finished}/${lanes.length}개 업체 응답 확인` : `${lanes.length - failed}개 업체 조회 완료`}{#if failed} · {failed}개 조회 실패{/if} · 불러온 {total}건 · <strong>표시 {visibleTotal}건</strong></p>{/if}</div>
    <JobFiltersPanel bind:filters />
    {#if submitted && filterCount}<p class="filter-result-note" role="status">{filterCount}개 필터 적용 · 불러온 {total}건 중 {visibleTotal}건 표시{#if unverifiedTotal} · 이 중 {unverifiedTotal}건은 선택한 근무조건 확인 필요{/if}. 새로 검색해도 필터는 유지됩니다.</p>{/if}
    <div class="sort-bar"><label for="sort-order">정렬 <select id="sort-order" bind:value={sortOrder}><option value="source">업체 기본순</option><option value="hourly-desc">시급 높은순</option></select></label><p>{sortOrder === 'source' ? '각 업체가 제공한 검색 순서를 유지합니다.' : '업체별로 불러온 공고에서 시급만 비교합니다. 월급·일급·협의 공고는 뒤에 표시해요.'}</p></div>
    {#if !submitted}
      <div class="ready-grid">{#each sources as source}<div class={`ready-card ${source.id}`}><span class="source-dot"></span><h3>{source.name}</h3><p>{source.hint}</p><span class="ready-label">검색 대기</span></div>{/each}</div>
    {:else}
      <div class="result-grid">
        {#each filteredLanes as lane (lane.source)}
          {@const source = sources.find((item) => item.id === lane.source)!}
          {@const result = lane.result}
          <section class={`result-lane ${lane.source}`} aria-labelledby={`title-${lane.source}`}>
            <div class="lane-heading"><h3 id={`title-${lane.source}`}><span class="source-dot"></span>{source.name}</h3><span class:failed={lane.error || result?.status === 'unavailable'} class="lane-count">{lane.state === 'loading' ? '조회 중' : lane.error || result?.status === 'unavailable' ? '조회 실패' : filterCount ? `${lane.visible.length} / ${result?.jobs.length || 0}건` : `${result?.jobs.length || 0}건`}</span></div>
            {#if lane.state === 'loading'}
              <div class="loading-state" role="status"><span class="spinner" aria-hidden="true"></span>{source.name} 공고를 불러오고 있어요.</div><div class="skeleton" aria-hidden="true"></div><div class="skeleton" aria-hidden="true"></div>
            {:else if lane.error || result?.status === 'unavailable'}
              <div class="lane-message"><strong>지금은 공고를 가져오지 못했어요.</strong><p>{lane.error || result?.message || '잠시 후 다시 검색해주세요.'}</p></div>
            {:else if result}
              <p class="checked">{time(result.checkedAt)} 조회 · 공개 검색의 일부 공고</p>
              {#if result.regionNote}<p class="region-note">{result.regionNote}</p>{/if}
              {#if lane.visible.length}
                <div class="listings">{#each lane.visible as item (item.job.id)}{@const job = item.job}<article class="job-card"><a href={job.url} target="_blank" rel="noopener noreferrer">{#if item.unverifiedSchedule}<p class="unverified-schedule">선택한 근무조건 확인 필요</p>{/if}<h4>{job.title}<span class="external-icon" aria-hidden="true">↗</span></h4>{#if job.company}<p class="company">{job.company}</p>{/if}{#if job.location}<p class="location">{job.location}</p>{/if}{#if job.pay}<p class="pay">{job.pay}</p>{/if}{#if job.schedule}<p class="schedule">{job.schedule}</p>{/if}<span class="detail-link">공고 상세 보기 ↗</span></a></article>{/each}</div>
              {:else if result.jobs.length}<div class="lane-message lane-filtered-empty"><strong>선택한 필터에 맞는 공고가 없어요.</strong><p>불러온 {result.jobs.length}건 안에서 일치하는 공고가 없습니다. 정보가 없는 공고도 제외될 수 있어요.</p><button type="button" class="filter-reset" onclick={() => { filters = defaultJobFilters(); }}>필터 초기화</button></div>
              {:else}<div class="lane-message"><strong>검색된 공고가 없어요.</strong><p>검색어를 바꿔 다시 찾아보세요.</p></div>{/if}
            {/if}
            {#if result}<a class="source-original" href={result.searchUrl} target="_blank" rel="noopener noreferrer">{source.name} 전체 검색 결과 ↗</a>{/if}
          </section>
        {/each}
      </div>
    {/if}
  </section>
  <footer class="page-footer">공개 검색 화면에서 확인한 공고입니다. 업체마다 지역·검색 기준이 다를 수 있으며, 최신 모집 상태와 지원 조건은 공고 원문에서 확인하세요.</footer>
</main>

<dialog bind:this={postcodeDialog} class="postcode-dialog" aria-labelledby="postcode-title" onclose={addressDialogClosed}>
  <div class="postcode-heading"><div><h2 id="postcode-title">기준 주소 찾기</h2><p>다음·카카오 우편번호 검색</p></div><button type="button" aria-label="주소 검색 닫기" onclick={closeAddressSearch}>×</button></div>
  {#if postcodeStatus === 'loading' || postcodeStatus === 'retrying'}<p class="postcode-status" role="status"><span class="spinner" aria-hidden="true"></span> {postcodeStatus === 'retrying' ? '연결이 지연되어 한 번 다시 연결하고 있어요…' : '주소 검색 화면을 연결하고 있어요…'}</p>{/if}
  {#if postcodeError}<div class="postcode-status" role="alert"><p>{postcodeError}</p><button type="button" onclick={() => void openAddressSearch()}>다시 시도</button></div>{/if}
  <div bind:this={postcodeContainer} class="postcode-embed" class:postcode-failed={postcodeStatus === 'error'}></div>
  <p class="postcode-footnote">선택한 도로명 주소를 확인하고 동네 검색에 사용합니다. 상세 동·호수는 필요하지 않아요.</p>
</dialog>
