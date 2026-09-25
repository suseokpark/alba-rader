<script lang="ts">
  import type { SearchResult } from './search';
  import { neighborhoodMapUrl } from './map-links';
  import { hasDaangnRegion } from './daangn-multi';
  let { result }: { result: SearchResult } = $props();
  const regions = $derived(result.regionResults || []);
  const failed = $derived(regions.filter((region) => region.status === 'unavailable').length);
  const remaining = $derived(result.interruption?.remainingAreas || []);
  function checkedTime(value: string) {
    return new Date(value).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  }
</script>

<div class="daangn-region-results" aria-label="당근 동네별 조회 결과">
  <p class="daangn-region-summary" class:partial-warning={failed > 0 || remaining.length > 0} role="status">
    {regions.length - failed}/{regions.length + remaining.length}곳 조회 완료{#if failed} · {failed}곳 실패{/if}{#if remaining.length} · {remaining.length}곳 미완료{/if}
    · 중복 {result.duplicateCount || 0}건 제외
  </p>
  <ul>
    {#each regions as region}
      {@const mapUrl = neighborhoodMapUrl(region.area)}
      <li class:region-failed={region.status === 'unavailable'}>
        <div><strong>{region.label}</strong><span>{region.status === 'unavailable' ? '조회 실패' : `${region.jobsCount}건`}</span></div>
        {#if region.checkedAt}<p class="region-checked">{checkedTime(region.checkedAt)} {region.status === 'unavailable' ? '조회 시도' : '조회'}</p>{/if}
        {#if region.status === 'unavailable'}<p>{region.message || '조회하지 못했어요. 다시 검색해주세요.'}</p>{/if}
        <div class="region-actions">
          <a class="region-original" href={region.searchUrl} target="_blank" rel="noopener noreferrer">{hasDaangnRegion(region.searchUrl) ? '이 동네 원문 검색' : '당근 원문 검색 · 지역 미적용'} ↗</a>
          {#if mapUrl}<a class="region-map" href={mapUrl} target="_blank" rel="noopener noreferrer" referrerpolicy="no-referrer" aria-label={`${region.label} 조회 동네 지도 보기 (카카오맵, 새 탭)`} aria-describedby="map-help">동네 지도 ↗</a>{/if}
        </div>
      </li>
    {/each}
    {#each remaining as area}
      <li class="region-incomplete">
        <div><strong>{[area.sido, area.sigungu, area.bname].filter(Boolean).join(' ')}</strong><span>{result.interruption?.reason === 'timeout' ? '시간초과' : '중단'} · 미완료</span></div>
        <p>응답 완료 전 중단되어 공고 유무를 확인하지 못했어요.</p>
      </li>
    {/each}
  </ul>
  <p class="daangn-region-footnote">동네별 건수는 중복 제거 전입니다. 선택 순서대로 합친 뒤 필터와 정렬을 적용합니다. 부분 재시도 시 성공한 동네의 조회 시각은 유지됩니다.{#if remaining.length} 미완료 동네를 포함한 전체 결과가 아닙니다.{/if}{#if failed} 실패한 동네를 포함한 전체 결과가 아닙니다.{/if}</p>
</div>
