import type { DaangnSearchProgress, JobListing, SearchArea, SearchResult } from './search';

export const MAX_DAANGN_AREAS = 5;
/** Link-condition evidence only; not a claim about the current remote results. */
export function hasDaangnRegion(input: string): boolean {
  try {
    const url = new URL(input);
    const ids = url.searchParams.getAll('regionId');
    return url.origin === 'https://jobs.daangn.com' && url.pathname === '/s'
      && !url.username && !url.password && ids.length === 1 && /^\d+$/.test(ids[0])
      && Number.isSafeInteger(Number(ids[0])) && Number(ids[0]) > 0;
  } catch { return false; }
}

const CONCURRENCY = 2;
const normalize = (value: string) => value.trim().replace(/\s+/g, ' ');
const provinceAliases: Record<string, string> = {
  서울특별시: '서울', 부산광역시: '부산', 대구광역시: '대구', 인천광역시: '인천',
  광주광역시: '광주', 대전광역시: '대전', 울산광역시: '울산', 세종특별자치시: '세종',
  경기도: '경기', 강원도: '강원', 강원특별자치도: '강원', 충청북도: '충북',
  충청남도: '충남', 전라북도: '전북', 전북특별자치도: '전북', 전라남도: '전남',
  경상북도: '경북', 경상남도: '경남', 제주도: '제주', 제주특별자치도: '제주'
};

/** Copy only the administrative fields; street addresses and postcodes stay local. */
export function toSearchArea(input: unknown): SearchArea | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return;
  const record = input as Record<string, unknown>;
  const keys = ['sido', 'sigungu', 'bname', 'bcode', 'sigunguCode'] as const;
  if (keys.some((key) => typeof record[key] !== 'string')) return;
  const area = Object.fromEntries(keys.map((key) => [key, normalize(record[key] as string)])) as unknown as SearchArea;
  if (!/^[가-힣 ]{2,20}$/.test(area.sido) || !/^[가-힣0-9· ]{0,40}$/.test(area.sigungu)
    || !/^[가-힣0-9·. ]{1,40}$/.test(area.bname) || !/^\d{10}$/.test(area.bcode)
    || !/^\d{5}$/.test(area.sigunguCode) || !area.bcode.startsWith(area.sigunguCode)) return;
  return area;
}

export function neighborhoodKey(area: SearchArea): string {
  const safe = toSearchArea(area);
  if (!safe) throw new TypeError('올바른 동네 주소를 선택해 주세요.');
  const sido = safe.sido.replace(/\s+/g, '');
  // Different legal ri codes can map to the same selected eup/myeon neighborhood.
  return [provinceAliases[sido] ?? sido, safe.sigungu, safe.bname].map((part) => part.replace(/\s+/g, '')).join('|');
}

function uniqueAreas(input: readonly SearchArea[], allowEmpty = false): SearchArea[] {
  if (!Array.isArray(input)) throw new TypeError('동네 목록을 확인해 주세요.');
  const areas: SearchArea[] = [];
  const seen = new Set<string>();
  for (const item of input) {
    const area = toSearchArea(item);
    if (!area) throw new TypeError('올바른 동네 주소를 선택해 주세요.');
    const key = neighborhoodKey(area);
    if (seen.has(key)) continue;
    seen.add(key);
    areas.push(area);
    if (areas.length > MAX_DAANGN_AREAS) throw new RangeError(`당근 동네는 최대 ${MAX_DAANGN_AREAS}개까지 선택할 수 있어요.`);
  }
  if (!allowEmpty && !areas.length) throw new RangeError('검색할 당근 동네를 선택해 주세요.');
  return areas;
}

export function addDaangnArea(areas: readonly SearchArea[], input: SearchArea): { areas: SearchArea[]; reason?: 'duplicate' | 'limit' } {
  const current = uniqueAreas(areas, true);
  const area = toSearchArea(input);
  if (!area) throw new TypeError('올바른 동네 주소를 선택해 주세요.');
  if (current.some((item) => neighborhoodKey(item) === neighborhoodKey(area))) return { areas: current, reason: 'duplicate' };
  if (current.length === MAX_DAANGN_AREAS) return { areas: current, reason: 'limit' };
  return { areas: [...current, area] };
}

function checkedQuery(input: string): string {
  if (typeof input !== 'string') throw new TypeError('검색어를 확인해 주세요.');
  const query = input.trim();
  if (!query || query.length > 80 || /[\u0000-\u001f]/.test(query)) throw new RangeError('검색어를 1~80자로 입력해 주세요.');
  return query;
}

function failedResult(query: string, message: string): SearchResult {
  return {
    source: 'daangn', status: 'unavailable', jobs: [],
    searchUrl: `https://jobs.daangn.com/s?${new URLSearchParams({ query })}`,
    checkedAt: new Date().toISOString(), message
  };
}

function officialUrl(input: unknown, path: string): input is string {
  if (typeof input !== 'string') return false;
  try {
    const url = new URL(input);
    return url.origin === 'https://jobs.daangn.com' && !url.username && !url.password
      && (path === '/s' ? url.pathname === path : url.pathname.startsWith(path));
  } catch { return false; }
}

/** An invalid response is a failed region, never a successful empty search. */
function readResult(input: unknown, query: string, strict = false): SearchResult {
  const invalid = () => {
    if (strict) throw new TypeError('이전 동네별 검색 결과를 확인하지 못했어요. 다시 검색해 주세요.');
    return failedResult(query, '당근 검색 응답 형식을 확인하지 못했어요. 다시 검색해 주세요.');
  };
  if (!input || typeof input !== 'object' || Array.isArray(input)) return invalid();
  const result = input as Record<string, unknown>;
  if (result.source !== 'daangn' || typeof result.status !== 'string' || !['ok', 'empty', 'unavailable'].includes(result.status)
    || !Array.isArray(result.jobs) || !officialUrl(result.searchUrl, '/s')
    || new URL(result.searchUrl).searchParams.get('query') !== query
    || typeof result.checkedAt !== 'string' || !Number.isFinite(Date.parse(result.checkedAt))) return invalid();
  if (result.status === 'ok' ? !result.jobs.length : result.jobs.length !== 0) return invalid();
  if (result.jobs.some((job) => !job || typeof job !== 'object'
    || typeof job.id !== 'string' || !job.id.trim() || typeof job.title !== 'string' || !job.title.trim()
    || !officialUrl(job.url, '/job-posts/')
    || ['company', 'location', 'pay', 'schedule'].some((key) => job[key] !== undefined && typeof job[key] !== 'string'))) return invalid();
  if (['message', 'regionNote'].some((key) => result[key] !== undefined && typeof result[key] !== 'string')) return invalid();
  // Ignore any unexpected fields in the server response.
  return {
    source: 'daangn', status: result.status as SearchResult['status'], jobs: result.jobs as JobListing[],
    searchUrl: result.searchUrl, checkedAt: result.checkedAt,
    ...(result.message !== undefined && { message: result.message as string }),
    ...(result.regionNote !== undefined && { regionNote: result.regionNote as string })
  };
}

export function aggregateDaangnResults(queryInput: string, entries: { area: SearchArea; result: SearchResult }[]): SearchResult {
  const query = checkedQuery(queryInput);
  if (!Array.isArray(entries)) throw new TypeError('동네별 검색 결과를 확인해 주세요.');
  const areas = uniqueAreas(entries.map((entry) => entry?.area));
  const byArea = new Map<string, SearchResult>();
  for (const entry of entries) {
    const key = neighborhoodKey(entry.area);
    if (!byArea.has(key)) byArea.set(key, readResult(entry.result, query));
  }
  const regionResults: NonNullable<SearchResult['regionResults']> = [];
  const regionEntries: NonNullable<SearchResult['regionEntries']> = [];
  const jobs: JobListing[] = [];
  const ids = new Set<string>();
  const urls = new Set<string>();
  let duplicateCount = 0;
  for (const area of areas) {
    const result = byArea.get(neighborhoodKey(area))!;
    regionEntries.push({ area, result });
    regionResults.push({
      area, label: [area.sido, area.sigungu, area.bname].filter(Boolean).join(' '),
      status: result.status, jobsCount: result.jobs.length, searchUrl: result.searchUrl,
      checkedAt: result.checkedAt,
      ...(result.message && { message: result.message })
    });
    for (const job of result.jobs) {
      const url = new URL(job.url);
      url.search = '';
      url.hash = '';
      const duplicate = ids.has(job.id) || urls.has(url.href);
      // Remember both aliases even if this copy was removed, for transitive overlaps.
      ids.add(job.id);
      urls.add(url.href);
      if (duplicate) duplicateCount++;
      else jobs.push(job);
    }
  }
  const failures = regionResults.filter((result) => result.status === 'unavailable').length;
  const partial = failures > 0 && failures < regionResults.length;
  const status = regionResults.some((result) => result.status === 'ok') ? 'ok'
    : failures < regionResults.length ? 'empty' : 'unavailable';
  return {
    source: 'daangn', status, jobs, searchUrl: regionResults[0].searchUrl,
    checkedAt: new Date().toISOString(), regionResults, regionEntries, duplicateCount, partial,
    regionNote: `${areas.length}개 선택 동네 및 각 주변 기준 · 지역 전체 검색 아님 · 동네당 최대 20건 · 겹치는 공고는 한 번만 표시`,
    ...(partial ? { message: `${failures}개 동네는 조회하지 못했어요. 나머지 동네의 결과만 표시합니다.` }
      : status === 'unavailable' ? { message: '선택한 모든 동네를 조회하지 못했어요. 동네별 오류를 확인해 주세요.' }
      : status === 'empty' ? { message: '조회한 동네에서 검색된 공고가 없어요.' } : {})
  };
}

function withAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  return new Promise((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener('abort', abort);
      reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
    };
    // Attach settlement handlers even if fetch synchronously triggered an abort.
    promise.then((value) => {
      signal.removeEventListener('abort', abort);
      resolve(value);
    }, (error) => {
      signal.removeEventListener('abort', abort);
      reject(error);
    });
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
  });
}

/** Do not expose collector references or unexpected server fields to observers. */
function progressSnapshot(entries: DaangnSearchProgress['entries'], total: number): DaangnSearchProgress {
  const completed = entries.filter(Boolean).map(({ area, result }) => {
    const jobs = result.jobs.map((job) => Object.freeze({
      id: job.id, title: job.title, url: job.url,
      ...(job.company !== undefined && { company: job.company }),
      ...(job.location !== undefined && { location: job.location }),
      ...(job.pay !== undefined && { pay: job.pay }),
      ...(job.schedule !== undefined && { schedule: job.schedule })
    }));
    Object.freeze(jobs);
    return Object.freeze({ area: Object.freeze(toSearchArea(area)!), result: Object.freeze({ ...result, jobs }) });
  });
  Object.freeze(completed);
  return Object.freeze({ entries: completed, total });
}

export async function searchDaangnAreas(
  queryInput: string,
  input: readonly SearchArea[],
  { signal, fetcher = fetch, onProgress }: {
    signal?: AbortSignal; fetcher?: typeof fetch; onProgress?: (progress: DaangnSearchProgress) => void;
  } = {}
): Promise<SearchResult> {
  signal?.throwIfAborted();
  const query = checkedQuery(queryInput);
  const areas = uniqueAreas(input);
  const entries: { area: SearchArea; result: SearchResult }[] = new Array(areas.length);
  let cursor = 0;
  async function worker() {
    while (cursor < areas.length) {
      signal?.throwIfAborted();
      const index = cursor++;
      const area = areas[index];
      const params = new URLSearchParams({ q: query, source: 'daangn', scope: 'address', areaLevel: 'neighborhood', ...area });
      let result: SearchResult;
      try {
        const response = await withAbort(fetcher(`/api/search?${params}`, { signal }), signal);
        signal?.throwIfAborted();
        result = response.ok ? readResult(await withAbort(response.json(), signal), query)
          : failedResult(query, `당근 검색 요청에 응답하지 않았어요. (HTTP ${response.status})`);
      } catch (error) {
        if (signal?.aborted) throw signal.reason ?? error;
        result = failedResult(query, '당근에 연결하거나 검색 결과를 읽지 못했어요. 다시 검색해 주세요.');
      }
      signal?.throwIfAborted();
      entries[index] = { area, result };
      if (onProgress) {
        const progress = progressSnapshot(entries, areas.length);
        // An optional synchronous UI observer must not turn a valid response
        // into a provider failure or stop the remaining search queue.
        try { onProgress(progress); } catch { /* The collected response stays valid. */ }
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, areas.length) }, worker));
  signal?.throwIfAborted();
  return aggregateDaangnResults(query, entries);
}

/** Finish only the observed responses after an initial attempt is interrupted.
 * Never manufacture status, jobs, or checkedAt for uncompleted neighborhoods.
 * Stale/mismatched snapshots are rejected instead of silently applied.
 */
export function finalizeInterruptedDaangn(
  queryInput: string,
  input: readonly SearchArea[],
  progress: DaangnSearchProgress | undefined,
  reason: 'cancelled' | 'timeout'
): SearchResult | undefined {
  const query = checkedQuery(queryInput);
  const areas = uniqueAreas(input);
  const invalid = () => new TypeError('완료된 동네 응답이 제출한 검색 조건과 일치하지 않아요.');
  if (!['cancelled', 'timeout'].includes(reason)) throw invalid();
  if (progress === undefined) return;
  if (!progress || typeof progress !== 'object' || Array.isArray(progress)
    || progress.total !== areas.length || !Array.isArray(progress.entries)
    || progress.entries.length > areas.length) throw invalid();
  const fields = ['sido', 'sigungu', 'bname', 'bcode', 'sigunguCode'] as const;
  const entries: DaangnSearchProgress['entries'] = [];
  const completed = new Set<number>();
  let previousIndex = -1;
  for (const entry of progress.entries) {
    const area = toSearchArea(entry?.area);
    if (!area) throw invalid();
    const index = areas.findIndex((selected) => fields.every((field) => area[field] === selected[field]));
    if (index <= previousIndex) throw invalid();
    entries.push({ area, result: readResult(entry.result, query, true) });
    completed.add(index);
    previousIndex = index;
  }
  if (!entries.length) return;
  const value = aggregateDaangnResults(query, entries);
  // The aggregate's creation time is not a new observation of any region.
  value.checkedAt = entries.reduce((latest, entry) => Date.parse(entry.result.checkedAt) > Date.parse(latest)
    ? entry.result.checkedAt : latest, entries[0].result.checkedAt);
  const remainingAreas = areas.filter((_area, index) => !completed.has(index));
  // Cancellation can race the last completed response. Full coverage remains a
  // normal aggregate, including eligibility for a failed-neighborhood-only retry.
  if (!remainingAreas.length) return value;
  value.interruption = { reason, remainingAreas };
  value.regionNote = `${entries.length}/${areas.length}개 동네 응답 확인 · 선택 동네 및 각 주변 기준 · 지역 전체 검색 아님 · 동네당 최대 20건 · 겹치는 공고는 한 번만 표시`;
  value.message = `${reason === 'timeout' ? '조회 시간이 길어 검색을 중단했어요.' : '검색을 중단했어요.'} 완료된 ${entries.length}/${areas.length}개 동네 응답만 표시합니다.`;
  return value;
}

/** One manual retry batch. Existing successful/empty region responses stay intact;
 * no partial updates are committed to the previous aggregate while it is pending.
 */
export async function retryFailedDaangnAreas(
  queryInput: string,
  input: readonly SearchArea[],
  previous: SearchResult,
  { signal, fetcher = fetch }: { signal?: AbortSignal; fetcher?: typeof fetch } = {}
): Promise<SearchResult> {
  signal?.throwIfAborted();
  const query = checkedQuery(queryInput);
  const areas = uniqueAreas(input);
  if (!Array.isArray(previous?.regionEntries)) throw new TypeError('이전 동네별 검색 결과가 없어 다시 검색해야 해요.');
  readResult(previous, query, true);
  if (previous.regionEntries.length !== areas.length) throw new TypeError('이전 검색의 동네 목록과 일치하지 않아요.');
  const fields = ['sido', 'sigungu', 'bname', 'bcode', 'sigunguCode'] as const;
  const entries = previous.regionEntries.map((entry, index) => {
    const area = toSearchArea(entry?.area);
    if (!area || fields.some((field) => area[field] !== areas[index][field])) {
      throw new TypeError('이전 검색의 동네 순서와 주소가 일치하지 않아요.');
    }
    return { area, result: readResult(entry.result, query, true) };
  });
  const failed = entries.filter((entry) => entry.result.status === 'unavailable');
  if (!failed.length) return previous;
  const retried = await searchDaangnAreas(query, failed.map((entry) => entry.area), { signal, fetcher });
  signal?.throwIfAborted();
  const updates = new Map(retried.regionEntries!.map((entry) => [neighborhoodKey(entry.area), entry]));
  return aggregateDaangnResults(query, entries.map((entry) => updates.get(neighborhoodKey(entry.area)) ?? entry));
}
