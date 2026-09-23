import { load } from 'cheerio';
import type { JobListing, SearchOptions, SearchResult } from '../../search';
import { resolveDaangnRegion } from './daangn-region.ts';

const ORIGIN = 'https://jobs.daangn.com';
const clean = (value: string) => value.replace(/\s+/g, ' ').trim();

export async function searchDaangn(query: string, options: SearchOptions = { scope: 'nationwide' }): Promise<SearchResult> {
  const searchUrl = new URL('/s', ORIGIN);
  searchUrl.searchParams.set('query', query);

  const result: SearchResult = {
    source: 'daangn',
    status: 'unavailable',
    jobs: [],
    searchUrl: searchUrl.toString(),
    checkedAt: new Date().toISOString()
  };

  if (options.scope === 'nationwide') {
    return {
      ...result,
      message: '당근 공개 검색은 동네 기준이에요. 주소를 선택하면 당근 공고도 함께 검색할 수 있어요.',
      regionNote: '전국 검색 미지원 · 당근은 동네와 주변 지역 기준으로 검색합니다.'
    };
  }
  if (!options.area) return { ...result, message: '당근 공고를 검색할 주소를 먼저 선택해 주세요.' };

  try {
    // The region lookup and listings request share one bounded deadline.
    const signal = AbortSignal.timeout(12_000);
    const selectedRegion = await resolveDaangnRegion(options.area, signal);
    if (!selectedRegion) {
      return { ...result, message: '선택한 주소와 일치하는 당근 동네를 확인하지 못했어요. 다른 주소를 선택해 주세요.' };
    }
    searchUrl.searchParams.set('regionId', String(selectedRegion.id));
    result.searchUrl = searchUrl.toString();
    result.regionNote = `${selectedRegion.label} 및 주변 기준`;
    const response = await fetch(searchUrl, {
      signal,
      headers: { Accept: 'text/html', 'Accept-Language': 'ko-KR,ko;q=0.9' }
    });
    if (!response.ok || new URL(response.url).origin !== ORIGIN) {
      return { ...result, message: '당근 검색 페이지에 연결하지 못했어요. 원문 검색에서 확인해 주세요.' };
    }

    const finalUrl = new URL(response.url);
    if (finalUrl.searchParams.get('regionId') !== String(selectedRegion.id) || finalUrl.searchParams.get('query') !== query) {
      return { ...result, message: '당근에서 선택한 지역과 검색어를 적용하지 못했어요. 원문 검색에서 확인해 주세요.' };
    }
    const $ = load(await response.text());
    const region = clean($('title').text()).match(/^(.+?)에서 찾는 알바$/)?.[1];
    if (region !== selectedRegion.label || clean($('h1').first().text()) !== clean(`"${query}"로 검색한 결과`)) {
      return { ...result, message: '당근 검색 결과의 지역과 검색어를 확인하지 못했어요. 원문 검색에서 확인해 주세요.' };
    }

    const jobs: JobListing[] = [];
    const seen = new Set<string>();
    $('main a[href^="/job-posts/"]').each((_index, element) => {
      if (jobs.length >= 20) return false;
      const card = $(element);
      const title = clean(card.find('h3').first().text());
      const href = card.attr('href');
      if (!title || !href) return;

      const url = new URL(href, ORIGIN);
      url.search = '';
      url.hash = '';
      if (url.origin !== ORIGIN || seen.has(url.toString())) return;

      const details = card.find('span.seed-text').map((_i, node) => clean($(node).text())).get();
      const pay = details.find((value) => /^(?:시급|월급|일급|주급|연봉|건당)\s/.test(value));
      const schedule = details.find((value) => value !== pay && /(?:\d{2}:\d{2}|시간 협의|총 \d+일)/.test(value));
      const tags = card.find('.seed-tag-group-item__label').map((_i, node) => clean($(node).text())).get();

      seen.add(url.toString());
      jobs.push({
        id: `daangn:${url.pathname.split('/').filter(Boolean).at(-1)}`,
        title,
        url: url.toString(),
        company: tags.length > 1 ? tags[0] : undefined,
        location: tags.at(-1) || undefined,
        pay,
        schedule
      });
    });

    if (jobs.length) {
      return { ...result, status: 'ok', jobs, checkedAt: new Date().toISOString() };
    }
    if ($('main').text().includes('검색 결과가 없어요')) {
      return { ...result, status: 'empty', checkedAt: new Date().toISOString(), message: '이 검색어의 당근 공고가 없어요.' };
    }
    return { ...result, message: '당근 공고 목록을 읽지 못했어요. 원문 검색에서 확인해 주세요.' };
  } catch (error) {
    const timeout = error instanceof Error && /(?:Timeout|Abort)/.test(error.name);
    return {
      ...result,
      checkedAt: new Date().toISOString(),
      message: timeout ? '당근 응답이 늦어 조회를 마치지 못했어요. 다시 검색해 주세요.' : '당근에 연결하지 못했어요. 잠시 후 다시 검색해 주세요.'
    };
  }
}
