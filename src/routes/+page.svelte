<script lang="ts">
  import { onDestroy, tick } from 'svelte';
  import { sources, type SourceId, type SearchResult, type AreaLevel, type SearchArea, type DaangnSearchProgress } from '$lib/search';
  import { areaLabel, areaLevelChoices, areaLevelNames, baseAreaHelp, normalizeAreaLevel, supportsSearchArea } from '$lib/search-area';
  import { createPostcodeSearch, selectedAddress, type SelectedAddress, type PostcodeStatus } from '$lib/postcode';
  import { sortJobs, type SortOrder } from '$lib/sort-jobs';
  import JobFiltersPanel from '$lib/JobFilters.svelte';
  import { activeFilterCount, defaultJobFilters, filterJobs } from '$lib/filter-jobs';
  import { MAX_DAANGN_AREAS, addDaangnArea, neighborhoodKey, toSearchArea, finalizeInterruptedDaangn, hasDaangnRegion } from '$lib/daangn-multi';
  import DaangnRegionResults from '$lib/DaangnRegionResults.svelte';
  import { addressMapUrl, neighborhoodMapUrl } from '$lib/map-links';
  import { createSearchSnapshot, requestSearchSource, SearchRequestError, type SearchSnapshot } from '$lib/search-request';
  import { appHandoffUrl, copyHandoffUrl } from '$lib/browser-handoff';
  import { trackJobClick } from '$lib/click-analytics';

  type Lane = { source: SourceId; state: 'loading' | 'done'; result?: SearchResult; error?: string; cancelled?: boolean; retryable?: boolean; retryingFailed?: boolean; retryNotice?: string; progress?: DaangnSearchProgress };
  let query = $state('');
  const queryTooLong = $derived(query.trim().length > 80);
  let selected = $state<SourceId[]>(sources.map((source) => source.id));
  let submitted = $state('');
  let lanes = $state<Lane[]>([]);
  let validation = $state('');
  let scope = $state<'nationwide' | 'address'>('address');
  let address = $state<SelectedAddress | null>(null);
  let areaLevel = $state<AreaLevel>('district');
  let daangnMultiEnabled = $state(false);
  let daangnAreas = $state<SearchArea[]>([]);
  let daangnNotice = $state('');
  let submittedArea = $state('');
  let sortOrder = $state<SortOrder>('source');
  let filters = $state(defaultJobFilters());
  let appliedSnapshot = $state<SearchSnapshot | null>(null);
  let queryInput = $state<HTMLInputElement>();
  let sourceTrigger = $state<HTMLDivElement>();
  let scopeTrigger = $state<HTMLButtonElement>();
  let areaLevelInput = $state<HTMLSelectElement>();
  let laneHeadings = $state<Partial<Record<SourceId, HTMLHeadingElement>>>({});
  let resultsTitle = $state<HTMLHeadingElement>();
  let stopButton = $state<HTMLButtonElement>();
  let postcodeDialog: HTMLDialogElement;
  let postcodeContainer: HTMLDivElement;
  let addressTrigger: HTMLButtonElement;
  let daangnTrigger = $state<HTMLButtonElement>();
  let postcodePurpose = $state<'base' | 'daangn'>('base');
  let postcodeStatus = $state<PostcodeStatus | 'idle'>('idle');
  let postcodeError = $state('');
  let postcodeHandoffUrl = $state('');
  let postcodeHandoffInput = $state<HTMLInputElement>();
  let postcodeCopyState = $state<'idle' | 'copying' | 'copied' | 'manual'>('idle');
  let postcodeCopyGeneration = 0;
  const postcodeSearch = createPostcodeSearch();
  const activeSources = $derived(selected.filter((id) => supportsSearchArea(id, scope, areaLevel, daangnMultiEnabled)));
  const areaChoices = $derived(areaLevelChoices(address));
  const baseMapUrl = $derived(addressMapUrl(address));
  const controllers = new Map<SourceId, AbortController>();
  const attempts = new Map<SourceId, number>();
  let generation = 0;
  const draftSnapshot = $derived(createSearchSnapshot({ query, selected, scope, address, areaLevel, daangnMultiEnabled, daangnAreas }));
  const queryValidation = $derived(validation && !draftSnapshot.ok && draftSnapshot.field === 'query' ? validation : '');
  const addressValidation = $derived(validation && !draftSnapshot.ok && draftSnapshot.field === 'address' ? validation : '');
  const daangnAreasValidation = $derived(typeof daangnMultiEnabled === 'boolean' && daangnMultiEnabled && validation && !draftSnapshot.ok && draftSnapshot.field === 'daangnAreas' ? validation : '');
  const hasDraftChanges = $derived(!!appliedSnapshot && (!draftSnapshot.ok || draftSnapshot.snapshot.fingerprint !== appliedSnapshot.fingerprint));

  const searching = $derived(lanes.some((lane) => lane.state === 'loading'));
  const finished = $derived(lanes.filter((lane) => lane.state === 'done').length);
  const failed = $derived(lanes.filter((lane) => !lane.cancelled && !lane.result?.interruption && (lane.error || lane.result?.status === 'unavailable')).length);
  const cancelled = $derived(lanes.filter((lane) => lane.cancelled).length);
  const partial = $derived(lanes.filter((lane) => lane.result?.partial && !lane.result.interruption).length);
  const interrupted = $derived(lanes.filter((lane) => lane.result?.interruption).length);
  const total = $derived(lanes.reduce((sum, lane) => sum + (lane.result?.jobs.length || 0), 0));
  const filterCount = $derived(activeFilterCount(filters));
  const filteredLanes = $derived(lanes.map((lane) => ({
    ...lane, visible: filterJobs(sortJobs(lane.result?.jobs || [], sortOrder), filters)
  })));
  const visibleTotal = $derived(filteredLanes.reduce((sum, lane) => sum + lane.visible.length, 0));
  const unverifiedTotal = $derived(filteredLanes.reduce((sum, lane) => sum + lane.visible.filter((item) => item.unverifiedSchedule).length, 0));
  const suggestions = ['카페', '편의점', '서빙', '물류', '사무보조', '주말'];

  function handleQueryKeydown(event: KeyboardEvent) {
    // Let the IME finish composing without implicitly submitting the search form.
    if (event.key === 'Enter' && event.isComposing) event.preventDefault();
  }

  function openAddressSearch(purpose: 'base' | 'daangn' = 'base') {
    resetPostcodeCopy();
    postcodeHandoffUrl = appHandoffUrl(window.location.href);
    postcodePurpose = purpose;
    if (!postcodeDialog.open) postcodeDialog.showModal();
    postcodeError = '';
    void postcodeSearch.open(postcodeContainer, {
      status: (state, message) => { postcodeStatus = state; postcodeError = message || ''; },
      complete: (data) => {
        // Native close queues its event; ignore selection before that cleanup runs.
        if (!postcodeDialog?.open) return;
        const chosen = selectedAddress(data);
        if (postcodePurpose === 'daangn') addNeighborhood(chosen);
        else {
          address = chosen;
          areaLevel = normalizeAreaLevel(areaLevel, address);
          scope = 'address';
        }
        validation = '';
        closeAddressSearch();
      }
    });
  }

  async function closeAddressSearch() {
    resetPostcodeCopy();
    postcodeSearch.close();
    postcodeStatus = 'idle';
    postcodeDialog?.close();
    await tick();
    if (postcodeDialog && !postcodeDialog.open) focusAddressTrigger();
  }

  async function addressDialogClosed() {
    // A queued close event must not cancel a newer dialog opened in the meantime.
    if (!postcodeDialog || postcodeDialog.open) return;
    resetPostcodeCopy();
    postcodeSearch.close();
    postcodeStatus = 'idle';
    await tick();
    if (postcodeDialog && !postcodeDialog.open) focusAddressTrigger();
  }

  function focusAddressTrigger() {
    const preferred = postcodePurpose === 'daangn' ? daangnTrigger : addressTrigger;
    (preferred && !preferred.disabled ? preferred : addressTrigger)?.focus();
  }

  function resetPostcodeCopy() {
    ++postcodeCopyGeneration;
    postcodeCopyState = 'idle';
  }

  async function copyPostcodeAppUrl() {
    if (!postcodeHandoffUrl || postcodeCopyState === 'copying') return;
    const attempt = ++postcodeCopyGeneration;
    postcodeCopyState = 'copying';
    const result = await copyHandoffUrl(postcodeHandoffUrl);
    if (attempt !== postcodeCopyGeneration || !postcodeDialog?.open) return;
    postcodeCopyState = result;
    if (result === 'manual') {
      await tick();
      if (attempt !== postcodeCopyGeneration || !postcodeDialog?.open) return;
      postcodeHandoffInput?.focus();
      postcodeHandoffInput?.select();
    }
  }

  async function clearAddress() {
    address = null;
    if (areaLevel === 'city') areaLevel = 'district';
    validation = '';
    await tick();
    addressTrigger?.focus();
  }

  function toggleSource(source: SourceId) {
    selected = selected.includes(source) ? selected.filter((item) => item !== source) : [...selected, source];
    validation = '';
  }

  function addNeighborhood(input: SearchArea) {
    const area = toSearchArea(input);
    if (!area) { daangnNotice = '동네를 확인하지 못했어요. 다른 주소를 선택해주세요.'; return; }
    const added = addDaangnArea(daangnAreas, area);
    daangnAreas = added.areas;
    if (!added.reason) validation = '';
    daangnNotice = added.reason === 'duplicate' ? '이미 선택한 동네예요.' : added.reason === 'limit' ? `최대 ${MAX_DAANGN_AREAS}곳까지 선택할 수 있어요.` : `${areaLabel(area, 'neighborhood')} 동네를 추가했어요.`;
  }

  function toggleDaangnMulti(enabled: boolean) {
    daangnMultiEnabled = enabled;
    daangnNotice = '';
    validation = '';
    if (enabled) {
      if (!daangnAreas.length && address) addNeighborhood(address);
      if (!selected.includes('daangn')) selected = [...selected, 'daangn'];
    }
  }

  async function removeNeighborhood(area: SearchArea) {
    daangnAreas = daangnAreas.filter((item) => neighborhoodKey(item) !== neighborhoodKey(area));
    daangnNotice = `${areaLabel(area, 'neighborhood')} 동네를 삭제했어요. 검색 버튼을 눌러 적용해주세요.`;
    validation = '';
    await tick();
    daangnTrigger?.focus();
  }

  async function search() {
    const plan = createSearchSnapshot({ query, selected, scope, address, areaLevel, daangnMultiEnabled, daangnAreas });
    if (!plan.ok) {
      validation = plan.message;
      const target = {
        query: queryInput,
        sources: sourceTrigger?.querySelector<HTMLButtonElement>('button:not(:disabled)'),
        scope: scopeTrigger,
        areaLevel: areaLevelInput,
        address: addressTrigger,
        daangnAreas: daangnTrigger
      }[plan.field];
      target?.focus();
      if (plan.field === 'daangnAreas') target?.scrollIntoView({ block: 'center' });
      return;
    }
    abortRequests();
    const currentGeneration = ++generation;
    const snapshot = plan.snapshot;
    appliedSnapshot = snapshot;
    submitted = snapshot.query;
    submittedArea = snapshot.label;
    validation = '';
    lanes = snapshot.requests.map(({ source }) => ({ source, state: 'loading' }));
    await Promise.allSettled(snapshot.requests.map(({ source }) => loadSource(snapshot, source, currentGeneration)));
  }

  async function loadSource(snapshot: SearchSnapshot, source: SourceId, currentGeneration: number, retryFailedFrom?: SearchResult) {
    controllers.get(source)?.abort();
    const request = new AbortController();
    controllers.set(source, request);
    const attempt = (attempts.get(source) || 0) + 1;
    attempts.set(source, attempt);
    const isCurrent = () => generation === currentGeneration && attempts.get(source) === attempt && !request.signal.aborted;
    try {
      const result = await requestSearchSource(snapshot, source, { signal: request.signal, retryFailedFrom,
        onProgress: (progress) => {
          if (!isCurrent() || retryFailedFrom || source !== 'daangn') return;
          lanes = lanes.map((lane) => lane.source === source && lane.state === 'loading' ? { ...lane, progress } : lane);
        }
      });
      if (!isCurrent()) return;
      finishLane({ source, state: 'done', result,
        ...(retryFailedFrom && { retryNotice: result.partial
          ? '일부 동네는 아직 조회하지 못했어요. 먼저 확인한 결과는 유지했어요.'
          : '실패했던 동네를 다시 확인했어요. 먼저 확인한 동네는 재조회하지 않았어요.' })
      });
    } catch (error) {
      if (!isCurrent()) return;
      if (retryFailedFrom) {
        finishLane({ source, state: 'done', result: retryFailedFrom,
          retryNotice: `${error instanceof Error ? error.message : '연결을 확인하고 다시 시도해주세요.'} 먼저 확인한 결과는 그대로예요.`
        });
        return;
      }
      if (error instanceof SearchRequestError && error.kind === 'timeout') {
        const lane = lanes.find((item) => item.source === source);
        const retained = lane && interruptedLane(lane, 'timeout', snapshot);
        if (retained) {
          finishLane(retained);
          return;
        }
      }
      finishLane({
        source, state: 'done', error: error instanceof Error ? error.message : '연결을 확인하고 다시 시도해주세요.',
        retryable: error instanceof SearchRequestError ? error.retryable : true
      });
    } finally {
      if (controllers.get(source) === request) controllers.delete(source);
    }
  }

  function finishLane(nextLane: Lane) {
    const nextLanes = lanes.map((lane) => lane.source === nextLane.source ? nextLane : lane);
    // Only replace focus that would otherwise disappear with the stop button.
    // Run before the DOM update; ordinary completion must not steal newer focus.
    if (lanes.some((lane) => lane.state === 'loading') && !nextLanes.some((lane) => lane.state === 'loading')
      && stopButton && stopButton.ownerDocument.activeElement === stopButton) {
      resultsTitle?.focus({ preventScroll: true });
    }
    lanes = nextLanes;
  }

  async function resetLaneFilters(source: SourceId) {
    filters = defaultJobFilters();
    // Restored cards change page height. Reveal the surviving heading after layout
    // updates so scroll anchoring cannot leave keyboard focus offscreen.
    await tick();
    laneHeadings[source]?.focus();
  }

  function retrySource(source: SourceId) {
    const lane = lanes.find((lane) => lane.source === source);
    if (!appliedSnapshot || !lane || lane.state === 'loading') return;
    // Keep focus in the lane before the retry button is replaced by loading UI.
    laneHeadings[source]?.focus({ preventScroll: true });
    lanes = lanes.map((lane) => lane.source === source ? { source, state: 'loading' } : lane);
    void loadSource(appliedSnapshot, source, generation);
  }

  function retryFailedDaangn() {
    const lane = lanes.find((lane) => lane.source === 'daangn');
    if (!appliedSnapshot || !lane || lane.state === 'loading' || !lane.result?.partial || lane.result.interruption || !lane.result.regionEntries?.length) return;
    const previous = lane.result;
    laneHeadings.daangn?.focus({ preventScroll: true });
    lanes = lanes.map((item) => item.source === 'daangn'
      ? { source: 'daangn', state: 'loading', result: previous, retryingFailed: true } : item);
    void loadSource(appliedSnapshot, 'daangn', generation, previous);
  }

  function abortRequests() {
    controllers.forEach((controller) => controller.abort());
    controllers.clear();
  }

  function interruptedLane(lane: Lane, reason: 'cancelled' | 'timeout', snapshot: SearchSnapshot | null = appliedSnapshot): Lane | undefined {
    if (lane.source !== 'daangn' || lane.retryingFailed || !lane.progress || !snapshot) return;
    const request = snapshot.requests.find((item) => item.source === 'daangn');
    if (request?.mode !== 'multi') return;
    try {
      const result = finalizeInterruptedDaangn(snapshot.query, request.areas, lane.progress, reason);
      if (result) return { source: lane.source, state: 'done', result };
    } catch {
      // Never retain a progress snapshot that does not match this submitted search.
    }
  }

  function cancelSearch() {
    ++generation;
    abortRequests();
    lanes = lanes.map((lane) => lane.state !== 'loading' ? lane : lane.retryingFailed
      ? { source: lane.source, state: 'done', result: lane.result,
        retryNotice: '추가 조회를 중단했어요. 이번 재시도 결과는 적용하지 않고, 먼저 확인한 결과를 유지했어요.' }
      : interruptedLane(lane, 'cancelled') || { source: lane.source, state: 'done', cancelled: true });
  }

  function cancelFromButton() {
    if (!lanes.some((lane) => lane.state === 'loading')) return;
    // The stop button disappears; only this explicit action moves focus to results.
    resultsTitle?.focus();
    cancelSearch();
  }

  function resetSearch() {
    cancelSearch();
    query = ''; selected = sources.map((source) => source.id); scope = 'address'; address = null;
    areaLevel = 'district'; daangnMultiEnabled = false; daangnAreas = []; daangnNotice = '';
    filters = defaultJobFilters(); sortOrder = 'source'; validation = ''; submitted = ''; submittedArea = '';
    lanes = []; appliedSnapshot = null;
    queryInput?.focus();
  }

  function suggest(value: string) { query = value; void search(); }
  function time(iso: string) { return new Date(iso).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' }); }
  onDestroy(() => { ++generation; resetPostcodeCopy(); abortRequests(); postcodeSearch.close(); });
</script>

<svelte:head>
  <title>알바레이더 | 세 업체 동시 검색</title>
  <meta name="description" content="알바몬, 당근, 알바천국의 공개 공고를 동시에 검색하고 비교하세요." />
</svelte:head>

<main>
  <header>
    <a class="brand" href="/" aria-label="알바레이더 홈"><span aria-hidden="true">◉</span> 알바레이더</a>
    <a class="quiet-button" href="/analytics">클릭 통계</a>
  </header>

  <section class="search-section" aria-labelledby="page-title">
    <div class="intro"><p class="eyebrow">내 일상에 맞는 일을 찾아요</p><h1 id="page-title">세 곳의 알바를, <em>한 번에.</em></h1><p>알바몬 · 당근 · 알바천국, 여기서 나란히 살펴보세요.</p></div>
    <form class="search-panel" onsubmit={(event) => { event.preventDefault(); void search(); }}>
      <label for="query"><span class="step-number" aria-hidden="true">1</span> 어떤 알바를 찾으세요?</label>
      <div class="search-field">
        <input id="query" bind:this={queryInput} bind:value={query} onkeydown={handleQueryKeydown} oninput={() => { validation = ''; }} placeholder="예: 카페, 편의점, 주말" autocomplete="off" aria-invalid={queryTooLong || queryValidation ? 'true' : undefined} aria-describedby={queryValidation ? 'query-hint query-length-hint query-error' : 'query-hint query-length-hint'} />
        <button class="search-submit" type="submit" disabled={searching}>{#if searching}<span class="spinner" aria-hidden="true"></span> {finished}/{lanes.length} 조회 중{:else}{activeSources.length}개 업체 검색 <span aria-hidden="true">→</span>{/if}</button>
      </div>
      {#if queryValidation}<p id="query-error" class="validation query-validation" role="alert">{queryValidation}</p>{/if}
      <p id="query-length-hint" class="query-length-hint" class:over-limit={queryTooLong} role="status">{queryTooLong ? '검색어가 80자를 넘었어요. 입력 내용은 잘리지 않으니, 검색할 내용을 줄여주세요.' : '검색어는 앞뒤 공백을 제외해 최대 80자까지 입력할 수 있어요.'}</p>
      <div class="area-controls">
        <div class="area-top"><span class="area-label"><span class="step-number" aria-hidden="true">2</span> 어디에서 일할까요?</span><div class="scope-options" aria-label="검색 범위"><button type="button" bind:this={scopeTrigger} aria-pressed={scope === 'address'} class:active={scope === 'address'} disabled={searching} onclick={() => { scope = 'address'; validation = ''; }}>주소 기준</button><button type="button" aria-pressed={scope === 'nationwide'} class:active={scope === 'nationwide'} disabled={searching} onclick={() => { scope = 'nationwide'; validation = ''; }}>전국</button></div></div>
        <div class="address-row" class:muted-address={scope === 'nationwide'}>
          <div class="address-value">{#if address}<span class="postcode">{address.zonecode}</span><strong>{address.address}</strong><span class="address-area">{address.sido} {address.sigungu} {address.bname}</span>{:else}<span>{scope === 'address' ? '동네를 찾을 기준 주소를 지정해주세요.' : '지역 제한 없이 검색합니다.'}</span>{/if}</div>
          <div class="address-actions">
            {#if baseMapUrl && address}<a class="address-map" href={baseMapUrl} target="_blank" rel="noopener noreferrer" referrerpolicy="no-referrer" aria-label={`${address.address} 지도 보기 (카카오맵, 새 탭)`} aria-describedby="map-help">지도 보기 <span aria-hidden="true">↗</span></a>{/if}
            <button type="button" class="address-find" bind:this={addressTrigger} disabled={searching} aria-describedby={addressValidation ? 'address-error' : undefined} onclick={() => void openAddressSearch()}>{address ? '주소 변경' : '주소 찾기'}</button>
            {#if address}<button type="button" class="address-clear" disabled={searching} aria-label="선택한 주소 지우기" onclick={clearAddress}>×</button>{/if}
          </div>
        </div>
        {#if addressValidation}<p id="address-error" class="validation" role="alert">{addressValidation}</p>{/if}
        <div class="area-level-row"><label for="area-level">지역 단위 <select id="area-level" bind:this={areaLevelInput} bind:value={areaLevel} disabled={searching || scope === 'nationwide'} onchange={() => { validation = ''; }} aria-describedby={scope === 'address' && address ? 'area-level-preview area-level-help' : 'area-level-help'}>{#each areaChoices as choice}<option value={choice.value}>{areaLevelNames[choice.value]}</option>{/each}</select></label>{#if scope === 'address' && address}<p class="area-preview" id="area-level-preview">검색할 지역: <strong>{areaLabel(address, areaLevel)}</strong></p>{/if}</div>
        <p class="area-help" id="area-level-help">{baseAreaHelp(scope, areaLevel, address)} {daangnMultiEnabled ? '당근에는 아래 별도 동네 목록만 적용됩니다.' : '당근은 동·읍·면 범위에서 검색하거나, 아래에서 동네들을 별도로 선택할 수 있어요.'} 변경 후 검색 버튼을 눌러주세요.</p>
        <div class="daangn-area-picker">
          <div class="daangn-picker-heading">
            <label class="daangn-multi-toggle"><input id="daangn-multi" type="checkbox" checked={daangnMultiEnabled} disabled={searching} onchange={(event) => toggleDaangnMulti(event.currentTarget.checked)} /> 당근 여러 동네 선택</label>
            {#if daangnMultiEnabled}<span class="daangn-selection-count">{daangnAreas.length} / {MAX_DAANGN_AREAS}곳</span>{/if}
          </div>
          {#if daangnMultiEnabled}
            <p class="area-help">기준 주소와 별개로, 당근에서 검색할 동네를 최대 {MAX_DAANGN_AREAS}곳 선택해요.</p>
            <ul class="daangn-area-chips" aria-label="선택한 당근 동네">
              {#each daangnAreas as area (neighborhoodKey(area))}
                {@const mapUrl = neighborhoodMapUrl(area)}
                <li><span>{areaLabel(area, 'neighborhood')}</span>{#if mapUrl}<a class="neighborhood-map" href={mapUrl} target="_blank" rel="noopener noreferrer" referrerpolicy="no-referrer" aria-label={`${areaLabel(area, 'neighborhood')} 동네 지도 보기 (카카오맵, 새 탭)`} aria-describedby="map-help">지도 <span aria-hidden="true">↗</span></a>{/if}<button type="button" disabled={searching} aria-label={`${areaLabel(area, 'neighborhood')} 삭제`} onclick={() => removeNeighborhood(area)}>×</button></li>
              {/each}
            </ul>
            {#if !daangnAreas.length}<p class="area-help">선택한 동네가 없습니다. 최소 한 곳을 추가해주세요.</p>{/if}
            <div class="daangn-picker-actions">
              <button type="button" class="address-find" bind:this={daangnTrigger} disabled={searching || daangnAreas.length >= MAX_DAANGN_AREAS} aria-describedby={daangnAreasValidation ? 'daangn-areas-error' : undefined} onclick={() => openAddressSearch('daangn')}>+ 동네 추가</button>
              {#if address}<button type="button" class="daangn-use-base" disabled={searching || daangnAreas.length >= MAX_DAANGN_AREAS} onclick={() => { if (address) addNeighborhood(address); }}>기준 주소의 동네 추가</button>{/if}
              {#if daangnAreas.length}<button type="button" class="quiet-button" disabled={searching} onclick={async () => { daangnAreas = []; daangnNotice = '당근 동네 목록을 비웠어요. 기준 주소는 그대로예요.'; await tick(); daangnTrigger?.focus(); }}>동네 전체 비우기</button>{/if}
            </div>
            {#if daangnAreasValidation}<p id="daangn-areas-error" class="validation" role="alert">{daangnAreasValidation}</p>{/if}
            <p class="area-help">주변 동네 공고도 포함될 수 있어요. 구·시 전체 검색은 아닙니다.</p>
            <details class="neighborhood-disclosure"><summary>동네 선택·조회 방식 자세히</summary><p class="area-help">주소 찾기에서 각 동네의 주소를 하나씩 선택해주세요. 도로명 주소는 동네 목록에 저장하지 않습니다. 기준 주소·지역 단위와 별개로 동네당 최대 20건을 조회하고, 같은 공고는 한 번만 표시합니다.</p></details>
            {#if daangnNotice}<p class="daangn-notice" role="status">{daangnNotice}</p>{/if}
          {/if}
        </div>
        <details class="map-disclosure"><summary>지도 보기 안내</summary><p class="area-help map-help" id="map-help">지도 보기를 누르면 선택한 주소 또는 동네명을 카카오맵에 전달해 새 탭으로 검색합니다. 공고의 근무지나 검색 반경을 표시하는 기능은 아니에요.</p></details>
      </div>
      <div class="search-options"><div class="source-options" bind:this={sourceTrigger} aria-label="검색할 업체">{#each sources as source}<button type="button" class={`source-toggle ${source.id}`} class:chosen={activeSources.includes(source.id)} aria-pressed={activeSources.includes(source.id)} disabled={searching || !supportsSearchArea(source.id, scope, areaLevel, daangnMultiEnabled)} onclick={() => toggleSource(source.id)}><span aria-hidden="true">{activeSources.includes(source.id) ? '✓' : '+'}</span> {source.name}{#if source.id === 'daangn' && daangnMultiEnabled} · 별도 {daangnAreas.length}곳{:else if !supportsSearchArea(source.id, scope, areaLevel)} · 동네만 지원{/if}</button>{/each}</div><p id="query-hint">공고 목록이 이 화면에 표시됩니다.</p></div>
      {#if validation && !queryValidation && !addressValidation && !daangnAreasValidation}<p class="validation" role="alert">{validation}</p>{/if}
      <button class="search-submit search-submit-bottom" type="submit" disabled={searching}>{#if searching}<span class="spinner" aria-hidden="true"></span> {finished}/{lanes.length} 조회 중{:else}선택한 {activeSources.length}개 업체 검색 <span aria-hidden="true">→</span>{/if}</button>
      <div class="search-actions">
        {#if searching}<button type="button" class="quiet-button" bind:this={stopButton} onclick={cancelFromButton}>조회 중단</button><p>확인된 결과는 남겨둬요. 진행 중인 서버 조회는 종료까지 잠시 걸릴 수 있어요.</p>{/if}
        {#if submitted || address || query || daangnAreas.length}<button type="button" class="quiet-button" onclick={resetSearch}>처음부터 다시 찾기</button>{/if}
      </div>
    </form>
    <div class="suggestions"><span>빠른 검색</span>{#each suggestions as suggestion}<button type="button" disabled={searching} onclick={() => suggest(suggestion)}>{suggestion} <span aria-hidden="true">↗</span></button>{/each}</div>
  </section>

  <section class="results" aria-labelledby="results-title" aria-busy={searching}>
    <div class="results-heading"><div><p class="eyebrow">{submitted ? '함께 비교해보세요' : '준비되면 찾아볼게요'}</p><h2 id="results-title" bind:this={resultsTitle} tabindex="-1">{submitted ? `“${submitted}” 검색 결과` : '어떤 일이 기다리고 있을까요?'}</h2>{#if submitted}<p class="searched-area">적용 지역: {submittedArea}</p>{/if}</div>{#if submitted}<p class="progress" role="status">{searching ? `${finished}/${lanes.length}개 업체 응답 확인` : `${lanes.length - failed - partial - cancelled - interrupted}개 업체 조회 완료`}{#if partial} · {partial}개 업체 일부 동네 실패{/if}{#if failed} · {failed}개 조회 실패{/if}{#if cancelled} · {cancelled}개 중단{/if}{#if interrupted} · {interrupted}개 업체 일부 동네 미완료{/if} · 불러온 {total}건 · <strong>표시 {visibleTotal}건</strong></p>{/if}</div>
    {#if hasDraftChanges}<div class="draft-notice" role="status"><p>검색 조건을 바꾸셨어요. 아래는 <strong>이전에 검색한 조건</strong>의 결과입니다.</p><button type="button" class="quiet-button" disabled={searching} onclick={() => void search()}>바뀐 조건으로 검색</button></div>{/if}
    {#if submitted}
    <JobFiltersPanel bind:filters resultSummary={{ loaded: total, visible: visibleTotal, unverifiedSchedule: unverifiedTotal }} />
    {#if submitted && filterCount}<p class="filter-result-note" role="status">{filterCount}개 필터 적용 · 불러온 {total}건 중 {visibleTotal}건 표시{#if unverifiedTotal} · 이 중 {unverifiedTotal}건은 선택한 근무조건 확인 필요{/if}. 새로 검색해도 필터는 유지됩니다.</p>{/if}
    <div class="sort-bar"><label for="sort-order">정렬 <select id="sort-order" bind:value={sortOrder}><option value="source">업체 기본순</option><option value="hourly-desc">시급 높은순</option></select></label><p>{sortOrder === 'source' ? '각 업체가 제공한 검색 순서를 유지합니다.' : '업체별로 불러온 공고에서 시급만 비교합니다. 월급·일급·협의 공고는 뒤에 표시해요.'}</p></div>
    <nav class="provider-nav" aria-label="업체 결과 바로 이동">{#each filteredLanes as lane}{@const source = sources.find((item) => item.id === lane.source)!}<a class={source.id} href={`#lane-${source.id}`}><span class="source-dot" aria-hidden="true"></span>{source.name}<span>{lane.state === 'loading' ? '조회 중' : lane.cancelled ? '중단' : lane.result?.interruption ? `${lane.visible.length}건 · 미완료` : lane.error || lane.result?.status === 'unavailable' ? '실패' : `${lane.visible.length}건`}</span></a>{/each}</nav>
    {/if}
    {#if !submitted}
      <div class="ready-grid">{#each sources as source}<div class={`ready-card ${source.id}`}><span class="source-dot"></span><h3>{source.name}</h3><p>{source.hint}</p><span class="ready-label">검색 대기</span></div>{/each}</div>
    {:else}
      <div class="result-grid" style:--result-columns={Math.max(1, lanes.length)}>
        {#each filteredLanes as lane (lane.source)}
          {@const source = sources.find((item) => item.id === lane.source)!}
          {@const result = lane.result}
          <section id={`lane-${lane.source}`} class={`result-lane ${lane.source}`} aria-labelledby={`title-${lane.source}`}>
            <div class="lane-heading"><h3 id={`title-${lane.source}`} bind:this={laneHeadings[lane.source]} tabindex="-1"><span class="source-dot"></span>{source.name}</h3><span class:failed={lane.error || result?.status === 'unavailable' || result?.partial || result?.interruption} class="lane-count">{lane.state === 'loading' ? '조회 중' : lane.cancelled ? '중단' : result?.interruption ? `${lane.visible.length} / ${result.jobs.length}건 · 일부 미완료` : lane.error || result?.status === 'unavailable' ? '조회 실패' : filterCount ? `${lane.visible.length} / ${result?.jobs.length || 0}건` : `${result?.jobs.length || 0}건`}{#if result?.partial && !result.interruption} · 일부 실패{/if}</span></div>
            <p class="lane-area">요청 지역 · {appliedSnapshot?.requests.find((request) => request.source === lane.source)?.label}</p>
            {#if result?.regionResults}<DaangnRegionResults {result} />{/if}
            {#if lane.source === 'daangn' && result?.partial && !result.interruption && result.regionEntries?.length}
              <div class="partial-retry">
                <button type="button" class="quiet-button" disabled={lane.state === 'loading'} onclick={retryFailedDaangn}>실패한 동네만 다시 조회</button>
                <p role="status">{lane.retryingFailed ? '실패한 동네를 다시 확인하고 있어요. 아래 공고는 계속 볼 수 있어요.' : '기존 검색 조건으로 실패한 동네만 확인해요. 성공한 동네의 공고·필터·정렬은 유지돼요.'}</p>
              </div>
            {/if}
            {#if result?.interruption}
              <div class="partial-retry interrupted-result">
                <p role="status">{result.interruption.reason === 'timeout' ? '조회 시간이 길어 중단했어요.' : '조회를 중단했어요.'} 완료된 동네의 응답은 남겨뒀어요.</p>
                <button type="button" class="quiet-button" disabled={lane.state === 'loading'} onclick={() => retrySource(lane.source)}>같은 조건으로 전체 다시 조회</button>
                <p>선택했던 모든 동네를 다시 검색해 현재 결과를 교체해요. 필터와 정렬은 유지돼요.</p>
              </div>
            {/if}
            {#if lane.retryNotice}<p class="retry-notice" role="status">{lane.retryNotice}</p>{/if}
            {#if lane.state === 'loading' && !lane.retryingFailed}
              <div class="loading-state" role="status"><span class="spinner" aria-hidden="true"></span>{source.name} 공고를 불러오고 있어요.{#if lane.progress}<p>{lane.progress.entries.length}/{lane.progress.total}곳 응답 확인 · 중단해도 완료된 동네의 응답은 남겨둬요.</p>{/if}</div><div class="skeleton" aria-hidden="true"></div><div class="skeleton" aria-hidden="true"></div>
            {:else if lane.cancelled}
              <div class="lane-message"><strong>이 업체의 조회를 중단했어요.</strong><p>다른 업체에서 확인한 결과는 그대로 유지됩니다.</p><button type="button" class="quiet-button" onclick={() => retrySource(lane.source)}>{source.name} 다시 조회</button></div>
            {:else if lane.error || result?.status === 'unavailable' && !result.interruption}
              <div class="lane-message"><strong>지금은 공고를 가져오지 못했어요.</strong><p>{lane.error || result?.message || '잠시 후 다시 검색해주세요.'}</p>{#if lane.retryable !== false}<button type="button" class="quiet-button" onclick={() => retrySource(lane.source)}>{source.name}만 다시 시도</button><p>기존 검색 조건으로 이 업체만 다시 조회해요.</p>{/if}</div>
            {:else if result}
              <p class="checked">{time(result.checkedAt)} {result.regionResults ? '결과 묶음 갱신 · 동네별 조회 시각은 위에 표시' : '조회'} · 공개 검색의 일부 공고</p>
              {#if result.regionNote}<p class="region-note">{result.regionNote}</p>{/if}
              {#if lane.visible.length}
                <div class="listings">{#each lane.visible as item (item.job.id)}{@const job = item.job}<article class="job-card"><a href={job.url} target="_blank" rel="noopener noreferrer" onclick={(event) => trackJobClick(event, lane.source, job)} onauxclick={(event) => trackJobClick(event, lane.source, job)}>{#if item.unverifiedSchedule}<p class="unverified-schedule">선택한 근무조건 확인 필요</p>{/if}<h4>{job.title}<span class="external-icon" aria-hidden="true">↗</span></h4>{#if job.company}<p class="company">{job.company}</p>{/if}{#if job.location}<p class="location">{job.location}</p>{/if}{#if job.pay}<p class="pay">{job.pay}</p>{/if}{#if job.schedule}<p class="schedule">{job.schedule}</p>{/if}<span class="detail-link">공고 상세 보기 ↗</span></a></article>{/each}</div>
              {:else if result.jobs.length}<div class="lane-message lane-filtered-empty"><strong>선택한 필터에 맞는 공고가 없어요.</strong><p>불러온 {result.jobs.length}건 안에서 일치하는 공고가 없습니다. 정보가 없는 공고도 제외될 수 있어요.</p><button type="button" class="filter-reset" onclick={() => resetLaneFilters(lane.source)}>필터 초기화</button></div>
              {:else}<div class="lane-message"><strong>{result.interruption ? result.status === 'unavailable' ? '완료된 응답에서도 공고를 확인하지 못했어요.' : '확인된 동네에서는 공고가 없어요.' : result.partial ? '조회된 동네에서는 공고가 없어요.' : '검색된 공고가 없어요.'}</strong><p>{result.interruption ? '미완료 동네의 공고 유무는 아직 몰라요. 위에서 같은 조건으로 전체 다시 조회할 수 있어요.' : result.partial ? '조회에 실패한 동네는 공고 유무를 확인하지 못했습니다. 위에서 실패한 동네만 다시 조회할 수 있어요.' : '검색어를 바꿔 다시 찾아보세요.'}</p></div>{/if}
            {/if}
            {#if result && !result.regionResults}
              {@const missingOriginalRegion = lane.source === 'daangn' && !hasDaangnRegion(result.searchUrl)}
              {#if missingOriginalRegion}<p class="region-note" id="original-region-help-daangn">선택한 동네가 이 링크에 적용되지 않았어요. 원문에서 동네를 다시 선택해 주세요.</p>{/if}
              <a class="source-original" href={result.searchUrl} target="_blank" rel="noopener noreferrer" aria-describedby={missingOriginalRegion ? 'original-region-help-daangn' : undefined}>{missingOriginalRegion ? '당근 원문 검색 · 지역 미적용' : `${source.name} 전체 검색 결과`} ↗</a>
            {/if}
          </section>
        {/each}
      </div>
    {/if}
  </section>
  <footer class="page-footer">공개 검색 화면에서 확인한 공고입니다. 업체마다 지역·검색 기준이 다를 수 있으며, 최신 모집 상태와 지원 조건은 공고 원문에서 확인하세요.<p>어떤 공고가 많이 열리는지 확인하기 위해 공고 클릭 수를 집계합니다. 검색어·지정 주소·방문자 식별정보는 집계 데이터에 저장하지 않습니다. <a href="/analytics">클릭 통계와 집계 기준</a></p></footer>
</main>

<dialog bind:this={postcodeDialog} class="postcode-dialog" aria-labelledby="postcode-title" onclose={addressDialogClosed}>
  <div class="postcode-heading"><div><h2 id="postcode-title">{postcodePurpose === 'daangn' ? '당근 동네 추가' : '기준 주소 찾기'}</h2><p>다음·카카오 우편번호 검색</p></div><button type="button" aria-label="주소 검색 닫기" onclick={closeAddressSearch}>×</button></div>
  <div class="postcode-body">
  {#if postcodeStatus === 'loading'}<p class="postcode-status" role="status"><span class="spinner" aria-hidden="true"></span> 주소 검색 화면을 연결하고 있어요…</p>{/if}
  {#if postcodeError}<div class="postcode-status" role={postcodeStatus === 'error' ? 'alert' : 'status'}><p>{postcodeError}</p><button type="button" onclick={() => void openAddressSearch(postcodePurpose)}>다시 시도</button></div>{/if}
  {#if postcodeError && postcodeHandoffUrl}
    <div class="postcode-recovery">
      <label for="postcode-app-url">일반 브라우저에서 열려면</label>
      <div class="postcode-copy-row">
        <input id="postcode-app-url" bind:this={postcodeHandoffInput} value={postcodeHandoffUrl} readonly aria-label="현재 앱 주소" aria-describedby="postcode-handoff-help" onclick={(event) => event.currentTarget.select()} />
        <button type="button" onclick={copyPostcodeAppUrl} disabled={postcodeCopyState === 'copying'}>{postcodeCopyState === 'copying' ? '복사 중…' : '앱 주소 복사'}</button>
      </div>
      <p id="postcode-handoff-help">주소를 복사해 Chrome·Safari 주소창에 붙여넣으세요. 입력한 검색 조건은 옮겨지지 않아요.</p>
      <p class="postcode-copy-notice" role="status">{postcodeCopyState === 'copied' ? '앱 주소를 복사했어요.' : postcodeCopyState === 'manual' ? '자동 복사가 허용되지 않았어요. 선택된 앱 주소를 직접 복사해주세요.' : ''}</p>
    </div>
  {/if}
  <div bind:this={postcodeContainer} class="postcode-embed" class:postcode-failed={postcodeStatus === 'error'}></div>
  <p class="postcode-footnote">{postcodePurpose === 'daangn' ? '추가하려는 동네의 주소 하나를 선택하면 동·읍·면만 목록에 추가됩니다. 기존 기준 주소는 바뀌지 않아요.' : '선택한 도로명 주소를 확인하고 동네 검색에 사용합니다.'} 상세 동·호수는 필요하지 않아요.</p>
  </div>
</dialog>
