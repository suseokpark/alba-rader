import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { searchDaangn } from '$lib/server/providers/daangn';
import { searchAlbamon } from '$lib/server/providers/albamon';
import { searchAlba } from '$lib/server/providers/alba';
import type { SearchArea, SearchOptions, SearchResult, SourceId } from '$lib/search';
import { parseAreaLevel } from '$lib/search-area';

const providers: Record<SourceId, (query: string, options: SearchOptions) => Promise<SearchResult>> = {
  daangn: searchDaangn,
  albamon: searchAlbamon,
  alba: searchAlba
};

// Short-lived, bounded cache also coalesces duplicate in-flight searches.
const cache = new Map<string, { expires: number; result: Promise<SearchResult> }>();

export const GET: RequestHandler = async ({ url }) => {
  const query = (url.searchParams.get('q') || '').trim();
  const source = url.searchParams.get('source') || '';
  if (!query || query.length > 80 || /[\u0000-\u001f]/.test(query)) {
    return json({ message: '검색어를 1~80자로 입력해주세요.' }, { status: 400 });
  }
  if (!Object.hasOwn(providers, source)) {
    return json({ message: '지원하지 않는 검색 서비스입니다.' }, { status: 400 });
  }

  const scope = url.searchParams.get('scope') || 'nationwide';
  if (scope !== 'nationwide' && scope !== 'address') {
    return json({ message: '검색 범위를 확인해주세요.' }, { status: 400 });
  }
  const areaLevel = parseAreaLevel(url.searchParams.get('areaLevel'));
  if (!areaLevel) return json({ message: '지원하는 지역 단위를 선택해주세요.' }, { status: 400 });
  let area: SearchArea | undefined;
  if (scope === 'address') {
    const read = (key: string) => (url.searchParams.get(key) || '').trim();
    area = { sido: read('sido'), sigungu: read('sigungu'), bname: read('bname'), bcode: read('bcode'), sigunguCode: read('sigunguCode') };
    if (!/^[가-힣 ]{2,20}$/.test(area.sido) || !/^[가-힣0-9· ]{0,40}$/.test(area.sigungu)
      || !/^[가-힣0-9·. ]{1,40}$/.test(area.bname) || !/^\d{10}$/.test(area.bcode)
      || !/^\d{5}$/.test(area.sigunguCode) || !area.bcode.startsWith(area.sigunguCode)) {
      return json({ message: '주소 검색에서 기준 주소를 다시 선택해주세요.' }, { status: 400 });
    }
  }
  const options: SearchOptions = { scope, ...(area && { area, areaLevel }) };

  const key = JSON.stringify([source, query, options]);
  let entry = cache.get(key);
  if (!entry || entry.expires < Date.now()) {
    for (const [cacheKey, cached] of cache) {
      if (cached.expires < Date.now()) cache.delete(cacheKey);
    }
    if (cache.size >= 100) cache.delete(cache.keys().next().value!);
    entry = { expires: Date.now() + 60_000, result: providers[source as SourceId](query, options) };
    cache.set(key, entry);
  }
  try {
    const result = await entry.result;
    // An evicted request may finish after a newer request has claimed this key.
    if (result.status === 'unavailable' && cache.get(key) === entry) cache.delete(key);
    return json(result, { headers: { 'Cache-Control': 'no-store' } });
  } catch {
    if (cache.get(key) === entry) cache.delete(key);
    return json({ message: '조회에 실패했습니다. 잠시 후 다시 시도해주세요.' }, { status: 502 });
  }
};
