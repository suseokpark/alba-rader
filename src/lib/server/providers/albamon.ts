import { load } from 'cheerio';
import type { JobListing, SearchArea, SearchOptions, SearchResult } from '../../search';

type RecordValue = Record<string, unknown>;

function record(value: unknown): RecordValue {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as RecordValue)
    : {};
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
}

interface AlbamonArea {
  si: string;
  gu: string;
  dong: string;
  code: string;
  note: string;
}

const codeCache = new Map<string, { expires: number; rows: RecordValue[] }>();

async function areaCodes(path: string, signal: AbortSignal): Promise<RecordValue[]> {
  const cached = codeCache.get(path);
  if (cached && cached.expires > Date.now()) return cached.rows;
  // These unauthenticated code lists are used by Albamon's public area selector.
  const response = await fetch(`https://api-code.albamon.com${path}`, {
    signal,
    headers: { Accept: 'application/json' }
  });
  if (!response.ok) throw new Error('Area code lookup failed');
  const data: unknown = await response.json();
  if (!Array.isArray(data)) throw new Error('Area code format changed');
  const rows = data.map(record);
  if (codeCache.size >= 64) codeCache.clear();
  codeCache.set(path, { expires: Date.now() + 24 * 60 * 60_000, rows });
  return rows;
}

async function resolveArea(area: SearchArea, signal: AbortSignal): Promise<AlbamonArea | undefined> {
  const cities = await areaCodes('/codes/areas/korean/sigu/codes', signal);
  const city = cities.find((row) => text(row.name) === text(area.sido) || text(row.shortName) === text(area.sido));
  if (!city || !Array.isArray(city.collection)) return undefined;
  const districts = city.collection.map(record);
  // Kakao addresses omit the district for Sejong, which Albamon represents as 세종시.
  const district = !area.sigungu && text(city.name) === '세종특별자치시'
    ? districts.find((row) => text(row.name) === '세종시')
    : districts.find((row) => text(row.name) === text(area.sigungu));
  if (!district) return undefined;

  const si = text(city.code);
  const gu = text(district.code);
  if (!/^[A-Z0-9]\d{3}$/.test(si) || !/^[A-Z0-9]\d{3}$/.test(gu)) return undefined;
  const place = [text(city.shortName) || text(city.name), text(district.name)].join(' ');
  if (!area.bname) return { si, gu, dong: '', code: gu, note: `${place} · 시·군·구 단위` };

  const dongs = await areaCodes(`/codes/areas/korean/dongs/gucode?code=${encodeURIComponent(gu)}`, signal);
  const dong = dongs.find((row) => text(row.name) === text(area.bname));
  const dongCode = text(dong?.code);
  if (!dong || !/^[A-Z0-9]\d{7}$/.test(dongCode)) return undefined;
  return { si, gu, dong: dongCode, code: dongCode, note: `${place} ${text(dong.name)} · 읍·면·동 단위` };
}

/** Read the same public, server-rendered search results that a visitor receives. */
export async function searchAlbamon(query: string, options: SearchOptions = { scope: 'nationwide' }): Promise<SearchResult> {
  let searchUrl = `https://www.albamon.com/total-search?keyword=${encodeURIComponent(query)}`;
  let regionNote = options.scope === 'nationwide' ? '전국 검색' : '주소 지역 확인 중';
  const result = (status: SearchResult['status'], jobs: JobListing[] = [], message?: string): SearchResult => ({
    source: 'albamon',
    status,
    jobs,
    searchUrl,
    checkedAt: new Date().toISOString(),
    regionNote,
    ...(message ? { message } : {})
  });

  try {
    // One shared deadline covers mapping (at most two requests) and the search.
    const signal = AbortSignal.timeout(12_000);
    let selectedArea: AlbamonArea | undefined;
    if (options.scope === 'address') {
      if (!options.area) return result('unavailable', [], '검색할 주소를 선택해 주세요.');
      selectedArea = await resolveArea(options.area, signal);
      if (!selectedArea) {
        regionNote = '선택한 주소의 알바몬 지역 코드 확인 불가';
        return result('unavailable', [], '선택한 주소와 일치하는 알바몬 지역을 찾지 못했습니다.');
      }
      regionNote = selectedArea.note;
      searchUrl += `&areas=${encodeURIComponent(selectedArea.code)}&disableExtensionSearch=true&similarDongJoin=false`;
    }
    const response = await fetch(searchUrl, {
      signal,
      headers: { Accept: 'text/html', 'Accept-Language': 'ko-KR,ko;q=0.9' }
    });
    if (!response.ok) return result('unavailable', [], `알바몬에서 응답을 받지 못했습니다 (HTTP ${response.status}).`);

    const html = await response.text();
    const $ = load(html);
    const nextData = $('#__NEXT_DATA__').text();
    if (!nextData) return result('unavailable', [], '알바몬 검색 결과를 읽지 못했습니다. 원문 검색을 이용해 주세요.');

    const page = record(record(record(JSON.parse(nextData)).props).pageProps);
    // Never show a generic landing page or a response for another keyword as a match.
    if (text(record(page.query).keyword) !== query) {
      return result('unavailable', [], '알바몬에서 요청한 검색어의 결과를 확인하지 못했습니다.');
    }

    const queries = record(page.dehydratedState).queries;
    const searchQuery = Array.isArray(queries)
      ? queries.find((item) => {
          const key = record(item).queryKey;
          return Array.isArray(key) && key[0] === 'SEARCH_RECRUIT_LIST' && key[1] === 'list';
        })
      : undefined;
    const data = record(record(record(searchQuery).state).data);
    if (selectedArea) {
      const returnedAreas = record(record(page.condition).condition).areas;
      const areaTags = record(data.condition).tags;
      const expectedCode = `${selectedArea.si}-${selectedArea.gu}-${selectedArea.dong}`;
      const conditionMatches = Array.isArray(returnedAreas) && returnedAreas.length === 1 && returnedAreas.some((item) => {
        const area = record(item);
        return text(area.si) === selectedArea.si && text(area.gu) === selectedArea.gu && text(area.dong) === selectedArea.dong;
      });
      const appliedTagMatches = Array.isArray(areaTags) && areaTags.some((item) => {
        const tag = record(item);
        return text(record(tag.searchConditionType).key) === 'AREA' && text(tag.code) === expectedCode;
      });
      if (!conditionMatches || !appliedTagMatches) {
        return result('unavailable', [], '알바몬에서 선택한 주소의 지역 조건이 적용되었는지 확인하지 못했습니다.');
      }
    }
    const base = record(data.base);
    const collection = record(base.normal).collection;
    const totalCount = record(base.pagination).totalCount;
    if (!Array.isArray(collection)) {
      return result('unavailable', [], '알바몬 검색 결과 형식이 달라 공고를 읽지 못했습니다.');
    }

    // Only use the actual keyword-search collection, excluding recommendations
    // and advertising collections elsewhere in the page's hydration payload.
    const jobs: JobListing[] = [];
    const seen = new Set<string>();
    for (const item of collection) {
      const job = record(item);
      const recruitNo = String(job.recruitNo ?? '');
      const title = text(job.recruitTitle);
      if (!/^\d+$/.test(recruitNo) || !title || seen.has(recruitNo)) continue;
      const jobUrl = `https://www.albamon.com/jobs/detail/${recruitNo}`;
      // Verify this is a detail URL actually linked by the returned search page.
      const linked = $('a[href]').toArray().some((element) => {
        try {
          const url = new URL($(element).attr('href') || '', searchUrl);
          return url.origin === 'https://www.albamon.com' && url.pathname === `/jobs/detail/${recruitNo}`;
        } catch {
          return false;
        }
      });
      if (!linked) continue;
      seen.add(recruitNo);
      jobs.push({
        id: `albamon-${recruitNo}`,
        title,
        url: jobUrl,
        company: text(job.companyName) || undefined,
        location: text(job.workplaceArea) || text(job.workplaceAddress) || undefined,
        pay: [text(record(job.payType).description), text(job.pay)].filter(Boolean).join(' ') || undefined,
        schedule: [text(job.workingWeek), text(job.workingTime), text(job.workingPeriod)].filter(Boolean).join(' · ') || undefined
      });
      if (jobs.length === 20) break;
    }

    if (jobs.length) return result('ok', jobs);
    if (collection.length === 0 && totalCount === 0) return result('empty');
    return result('unavailable', [], '알바몬 응답에서 확인 가능한 공고를 읽지 못했습니다. 원문 검색을 이용해 주세요.');
  } catch (error) {
    const timedOut = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
    return result('unavailable', [], timedOut ? '알바몬 검색 응답이 지연되고 있습니다. 다시 검색해 주세요.' : '알바몬에 연결하거나 검색 결과를 읽지 못했습니다.');
  }
}
