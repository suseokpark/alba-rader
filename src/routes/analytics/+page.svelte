<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { sources } from '$lib/search';
  import type { ClickReport } from '$lib/click-analytics';
  let days = $state('7');
  let source = $state('all');
  let report = $state<ClickReport | null>(null);
  let loading = $state(true);
  let error = $state('');
  let controller: AbortController | undefined;
  let generation = 0;
  const date = (value: string) => new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(value));
  async function refresh() {
    const attempt = ++generation;
    controller?.abort(); const request = new AbortController(); controller = request;
    const deadline = setTimeout(() => request.abort(), 12_000);
    loading = true; error = ''; report = null;
    try {
      const response = await fetch(`/api/clicks?days=${days}&source=${source}`, { signal: request.signal, cache: 'no-store' });
      if (!response.ok) throw new Error('클릭 통계를 불러오지 못했어요. 잠시 후 다시 시도해주세요.');
      const result: ClickReport = await response.json();
      if (attempt === generation) report = result;
    } catch {
      if (attempt === generation) error = request.signal.aborted ? '통계 조회가 지연되고 있어요. 다시 시도해주세요.' : '클릭 통계를 불러오지 못했어요. 연결을 확인하고 다시 시도해주세요.';
    } finally { clearTimeout(deadline); if (attempt === generation) loading = false; }
  }
  onMount(refresh);
  onDestroy(() => { generation++; controller?.abort(); });
</script>

<svelte:head><title>클릭 통계 | 알바레이더</title><meta name="robots" content="noindex,nofollow" /></svelte:head>
<main class="analytics">
  <header><a class="brand" href="/" aria-label="알바레이더 홈"><span aria-hidden="true">◉</span> 알바레이더</a><a class="quiet-button" href="/">검색으로 돌아가기</a></header>
  <section aria-labelledby="analytics-title">
    <div class="analytics-heading"><p class="eyebrow">공고 클릭 통계</p><h1 id="analytics-title">어떤 공고를 많이 봤을까요?</h1><p>이 앱의 검색 결과에서 공고를 연 횟수예요. 반복 클릭을 포함하며, 방문자 수나 지원 수는 아닙니다.</p></div>
    <form class="analytics-controls" onsubmit={(event) => { event.preventDefault(); void refresh(); }}>
      <label>기간<select bind:value={days} onchange={refresh}><option value="7">최근 7일</option><option value="30">최근 30일</option></select></label>
      <label>업체<select bind:value={source} onchange={refresh}><option value="all">전체 업체</option>{#each sources as item}<option value={item.id}>{item.name}</option>{/each}</select></label>
      <button class="quiet-button" type="submit" disabled={loading}>{loading ? '불러오는 중…' : '새로고침'}</button>
    </form>
    <div aria-live="polite" aria-atomic="true">
      {#if loading}<p class="analytics-state" role="status">클릭 통계를 불러오고 있어요.</p>
      {:else if error}<div class="analytics-state" role="alert"><p>{error}</p><button class="quiet-button" type="button" onclick={refresh}>다시 시도</button></div>
      {:else if report}
        <p class="analytics-meta">{date(report.from)}부터 · {date(report.checkedAt)} 기준 (한국 시간)</p>
        <div class="analytics-totals"><p>수집된 클릭 <strong>{report.total.toLocaleString()}<span>회</span></strong></p><p>클릭된 공고 <strong>{report.jobs.toLocaleString()}<span>개</span></strong></p></div>
        <div class="source-counts">{#each sources as item}<p class={item.id}><span class="source-dot" aria-hidden="true"></span>{item.name}<strong>{report.bySource[item.id].toLocaleString()}회</strong></p>{/each}</div>
        {#if report.ranking.length}
          <h2>많이 클릭한 공고 <small>상위 {report.ranking.length}개 · 최대 30개</small></h2>
          <ol class="click-ranking">{#each report.ranking as job, i}<li class={job.source}><span class="click-rank" aria-label={`${i + 1}위`}>{i + 1}</span><div class="click-job"><span class="click-source">{sources.find((item) => item.id === job.source)?.name}</span><a href={job.url} target="_blank" rel="noopener noreferrer">{job.title} ↗</a>{#if job.company}<p>{job.company}</p>{/if}</div><strong class="click-count">{job.clicks.toLocaleString()}<span>회</span></strong></li>{/each}</ol>
        {:else}<div class="analytics-state"><h2>아직 수집된 클릭이 없어요</h2><p>선택한 기간·업체의 검색 결과에서 공고를 열면 집계됩니다. 도입 이전의 클릭은 소급해서 알 수 없어요.</p><a class="quiet-button" href="/">공고 검색하기</a></div>{/if}
      {/if}
    </div>
    <details class="analytics-notes"><summary>무엇을 집계하나요?</summary><ul><li>검색 결과의 ‘공고 상세 보기’를 마우스·키보드·가운데 버튼으로 연 이벤트를 집계합니다. 통계 화면의 원문 링크·지도·업체 전체 검색 링크는 제외합니다.</li><li>기간은 오늘을 포함한 한국 시간 기준 7일 또는 30일입니다. 동률이면 최근 클릭한 공고가 먼저 나옵니다.</li><li>업체·공개 공고 제목·사업장명·원문 URL·수신 시각과 일회성 이벤트 번호만 저장합니다. 이름·IP·방문자 식별자·검색어·지정 주소는 앱 집계 데이터에 저장하지 않습니다.</li><li>연결 실패·브라우저 차단·우클릭 메뉴에서 열기는 누락될 수 있습니다. 동일 이벤트 재전송은 중복 제거하지만 반복 클릭과 자동화 여부, 원문 도착·지원 완료는 구별하지 않습니다.</li><li>최근 90일을 넘긴 이벤트는 이후 클릭이 들어올 때 순차 정리합니다. 현재 비공개 사이트의 접근 권한을 가진 사람만 통계를 볼 수 있습니다.</li></ul></details>
  </section>
</main>

<style>
  .analytics { max-width: 980px; }
  .analytics section { padding-top: 30px; }
  .analytics-heading h1 { font-size: clamp(1.5rem, 4vw, 2.15rem); letter-spacing: -.04em; }
  .analytics-heading p, .analytics-meta { color: #695949; font-size: .9375rem; line-height: 1.8; }
  .analytics-controls { display: flex; flex-wrap: wrap; gap: 14px; align-items: end; margin: 24px 0 16px; }
  .analytics-controls label { display: grid; gap: 7px; font-size: .875rem; font-weight: 600; }
  .analytics-controls select { min-height: 44px; padding: 9px 32px 9px 12px; border: 1px solid #cbbbab; border-radius: 10px; background: #fffdf9; color: #39312b; font: inherit; }
  .analytics .quiet-button { display: inline-flex; align-items: center; justify-content: center; text-decoration: none; font-size: .875rem; }
  .analytics-totals { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
  .analytics-totals p { margin: 0; padding: 22px; border: 1px solid #e4d8c9; border-radius: 18px; background: #fffdf9; color: #695949; }
  .analytics-totals strong { display: block; color: #3b3028; font-size: 2rem; margin-top: 10px; }
  .analytics-totals span, .click-count span { font-size: .9375rem; margin-left: 5px; font-weight: 400; }
  .source-counts { display: flex; flex-wrap: wrap; gap: 8px 20px; margin: 8px 0 26px; }
  .source-counts p { display: flex; gap: 8px; align-items: center; font-size: .875rem; }
  .source-counts strong { font-weight: 600; }
  .analytics h2 { font-size: 1.125rem; line-height: 1.7; }
  .analytics h2 small { font-size: .875rem; font-weight: 400; color: #695949; display: inline-block; }
  .click-ranking { list-style: none; padding: 0; display: grid; gap: 10px; }
  .click-ranking li { display: grid; grid-template-columns: 26px minmax(0,1fr) auto; gap: 14px; align-items: start; padding: 20px 16px; border: 1px solid #e4d8c9; border-radius: 16px; background: #fffdf9; }
  .click-rank { color: #695949; padding-top: 5px; font-weight: 700; }
  .click-source { display: inline-block; border-radius: 6px; padding: 4px 8px; font-size: .875rem; color: var(--source-ink); background: var(--source-tint); }
  .click-job a { display: block; min-height: 44px; padding: 10px 0; font-weight: 650; color: #3b3028; font-size: 1rem; line-height: 1.65; overflow-wrap: anywhere; text-decoration-thickness: 1px; text-underline-offset: 4px; }
  .click-job p { margin: 0; color: #695949; font-size: .875rem; overflow-wrap: anywhere; }
  .click-count { padding-top: 6px; font-size: 1.3rem; }
  .analytics-state { padding: 28px 22px; background: #fffdf9; border: 1px solid #e4d8c9; border-radius: 16px; line-height: 1.8; }
  .analytics-notes { margin-top: 28px; border-top: 1px solid #e4d8c9; color: #695949; font-size: .875rem; }
  .analytics-notes summary { min-height: 44px; padding: 14px 0; cursor: pointer; }
  .analytics-notes ul { padding-left: 20px; line-height: 1.8; }
  .analytics-notes li { margin: 10px 0; }
  @media (max-width: 480px) { .analytics-totals p { padding: 16px; } .click-ranking li { gap: 9px; padding: 16px 12px; grid-template-columns: 20px minmax(0,1fr); } .click-count { grid-column: 2; padding: 0; } }
</style>
