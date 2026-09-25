import { sources, type AreaLevel, type DaangnSearchProgress, type JobListing, type SearchArea, type SearchOptions, type SearchResult, type SourceId } from './search.ts';
import { areaLabel, areaLevelNames, cityName, normalizeAreaLevel, supportsSearchArea } from './search-area.ts';
import { MAX_DAANGN_AREAS, neighborhoodKey, retryFailedDaangnAreas, searchDaangnAreas, toSearchArea } from './daangn-multi.ts';

/** Client safety bounds, not measured network latency or a service-level promise.
 * Providers have a separate 12s server limit; 5 Daangn areas can need 3 batches.
 * Aborting the browser request does not guarantee cancellation of server work.
 */
export const SINGLE_SOURCE_TIMEOUT_MS = 18_000;
export const MULTI_SOURCE_TIMEOUT_MS = 45_000;

export interface SearchDraft {
  query: string;
  selected: readonly SourceId[];
  scope: 'address' | 'nationwide';
  address: SearchArea | null;
  areaLevel: AreaLevel;
  daangnMultiEnabled: boolean;
  daangnAreas: readonly SearchArea[];
}

export type SearchSourceRequest = Readonly<{
  source: SourceId;
  mode: 'single';
  options: Readonly<SearchOptions>;
  /** Expected request coverage; a returned regionNote remains the server evidence. */
  label: string;
}> | Readonly<{
  source: 'daangn';
  mode: 'multi';
  areas: readonly SearchArea[];
  label: string;
}>;

export interface SearchSnapshot {
  readonly query: string;
  readonly requests: readonly SearchSourceRequest[];
  readonly label: string;
  readonly fingerprint: string;
}

export type SearchValidationField = 'query' | 'sources' | 'scope' | 'areaLevel' | 'address' | 'daangnAreas';
export type SearchSnapshotResult = { ok: true; snapshot: SearchSnapshot } | { ok: false; field: SearchValidationField; message: string };
export type SearchRequestErrorKind = 'abort' | 'timeout' | 'http' | 'network' | 'invalid-response' | 'invalid-request';

export class SearchRequestError extends Error {
  readonly kind: SearchRequestErrorKind;
  readonly retryable: boolean;
  readonly status?: number;

  constructor(kind: SearchRequestErrorKind, message: string, status?: number) {
    super(message);
    this.kind = kind;
    this.name = kind === 'abort' ? 'AbortError' : kind === 'timeout' ? 'TimeoutError' : 'SearchRequestError';
    // This describes a possible later manual retry, not an automatic retry policy.
    this.retryable = kind === 'network' || kind === 'timeout' || kind === 'http' && !!status && status >= 500;
    if (status !== undefined) this.status = status;
  }
}

const levels: readonly AreaLevel[] = ['neighborhood', 'district', 'city', 'province'];
const sourceIds = sources.map(({ id }) => id);
const invalidRequest = () => new SearchRequestError('invalid-request', '검색 조건을 확인하고 다시 검색해주세요.');
const cancelled = () => new SearchRequestError('abort', '검색을 중단했어요.');
const areaParts = (area: SearchArea) => [area.sido, area.sigungu, area.bname, area.bcode, area.sigunguCode];

/** Compare only coverage used by each provider, without changing its request data. */
function coverageParts(source: SourceId, area: SearchArea, level: AreaLevel | undefined): string[] {
  // Daangn's separately selected neighborhoods and ordering remain significant.
  if (source === 'daangn') return areaParts(area);
  if (level === 'province') return [area.sido];
  if (level === 'city') return [area.sido, cityName(area)];
  if (level === 'district' || source === 'alba') return [area.sido, area.sigungu];
  return areaParts(area);
}

/** Presentation filters, sort order, labels and inactive form fields are excluded.
 * Lower-level address changes are excluded when the requested coverage is unchanged.
 * Neighborhood order is significant because it determines aggregate listing order.
 */
export function searchFingerprint(snapshot: Pick<SearchSnapshot, 'query' | 'requests'>): string {
  return JSON.stringify([snapshot.query, snapshot.requests.map((request) => request.mode === 'multi'
    ? [request.source, 'multi', request.areas.map(areaParts)]
    : [request.source, 'single', request.options.scope,
      request.options.scope === 'address' ? request.options.areaLevel : null,
      request.options.scope === 'address' && request.options.area
        ? coverageParts(request.source, request.options.area, request.options.areaLevel) : null])]);
}

function singleLabel(source: SourceId, options: SearchOptions): string {
  if (options.scope === 'nationwide') return '전국';
  const area = options.area!;
  const level = options.areaLevel!;
  if (source === 'daangn') return `${areaLabel(area, 'neighborhood')} · 동네 및 주변`;
  if (source === 'alba' && level === 'neighborhood') {
    const effectiveLevel = area.sigungu ? 'district' : 'province';
    return `${areaLabel(area, effectiveLevel)} · ${areaLevelNames[effectiveLevel]} (동 단위 미지원)`;
  }
  return `${areaLabel(area, level)} · ${areaLevelNames[level]}`;
}

/** Pure request planning. Only cloned administrative fields cross this boundary. */
export function createSearchSnapshot(draft: SearchDraft): SearchSnapshotResult {
  const fail = (message: string, field: SearchValidationField): SearchSnapshotResult => ({ ok: false, field, message });
  if (!draft || typeof draft.query !== 'string') return fail('검색어를 1~80자로 입력해주세요.', 'query');
  const query = draft.query.trim();
  if (!query || query.length > 80 || /[\u0000-\u001f]/.test(query)) return fail('검색어를 1~80자로 입력해주세요.', 'query');
  if (!['address', 'nationwide'].includes(draft.scope)) return fail('검색 범위와 지역 단위를 확인해주세요.', 'scope');
  if (!levels.includes(draft.areaLevel)) return fail('검색 범위와 지역 단위를 확인해주세요.', 'areaLevel');
  if (typeof draft.daangnMultiEnabled !== 'boolean') return fail('검색 범위와 지역 단위를 확인해주세요.', 'daangnAreas');
  if (!Array.isArray(draft.selected) || draft.selected.some((id) => !sourceIds.includes(id))) {
    return fail('검색할 업체를 확인해주세요.', 'sources');
  }
  const active = sources.filter(({ id }) => draft.selected.includes(id)
    && supportsSearchArea(id, draft.scope, draft.areaLevel, draft.daangnMultiEnabled));
  if (!active.length) return fail('검색할 업체를 하나 이상 선택해주세요.', 'sources');
  const multi = draft.daangnMultiEnabled && active.some(({ id }) => id === 'daangn');
  const needsBase = draft.scope === 'address' && active.some(({ id }) => id !== 'daangn' || !multi);
  const area = needsBase ? toSearchArea(draft.address) : undefined;
  if (needsBase && !area) return fail('주소 찾기로 기준 주소를 지정하거나 전국을 선택해주세요.', 'address');
  if (area && normalizeAreaLevel(draft.areaLevel, area) !== draft.areaLevel) {
    return fail('선택한 주소에 맞는 지역 단위를 다시 선택해주세요.', 'areaLevel');
  }
  if (area) Object.freeze(area);
  const areas: SearchArea[] = [];
  if (multi) {
    if (!Array.isArray(draft.daangnAreas)) return fail('검색할 당근 동네를 확인해주세요.', 'daangnAreas');
    const seen = new Set<string>();
    for (const input of draft.daangnAreas) {
      const selected = toSearchArea(input);
      if (!selected) return fail('올바른 당근 동네 주소를 다시 선택해주세요.', 'daangnAreas');
      const key = neighborhoodKey(selected);
      if (seen.has(key)) continue;
      seen.add(key);
      areas.push(Object.freeze(selected));
      if (areas.length > MAX_DAANGN_AREAS) return fail(`당근 동네는 최대 ${MAX_DAANGN_AREAS}곳까지 선택해주세요.`, 'daangnAreas');
    }
    if (!areas.length) return fail('당근에서 검색할 동네를 하나 이상 추가해주세요.', 'daangnAreas');
  }
  const requests: SearchSourceRequest[] = active.map(({ id }) => {
    if (id === 'daangn' && multi) {
      return Object.freeze({ source: id, mode: 'multi', areas: Object.freeze(areas),
        label: `당근 별도 동네 ${areas.length}곳: ${areas.map((item) => areaLabel(item, 'neighborhood')).join(', ')} · 각 동네 및 주변` });
    }
    const options: SearchOptions = draft.scope === 'nationwide' ? { scope: 'nationwide' }
      : { scope: 'address', area, areaLevel: draft.areaLevel };
    return Object.freeze({ source: id, mode: 'single', options: Object.freeze(options), label: singleLabel(id, options) });
  });
  const baseLabel = area ? `${areaLabel(area, draft.areaLevel)} · ${areaLevelNames[draft.areaLevel]}` : '전국';
  const separate = requests.find((request) => request.mode === 'multi');
  const label = requests.length === 1 ? requests[0].label : [baseLabel, separate?.label].filter(Boolean).join(' / ');
  const snapshot = { query, requests: Object.freeze(requests), label };
  return { ok: true, snapshot: Object.freeze({ ...snapshot, fingerprint: searchFingerprint(snapshot) }) };
}

const officialOrigins: Record<SourceId, string> = {
  albamon: 'https://www.albamon.com', daangn: 'https://jobs.daangn.com', alba: 'https://www.alba.co.kr'
};
const queryKeys: Record<SourceId, string> = { albamon: 'keyword', daangn: 'query', alba: 'wsSrchWord' };
const searchPaths: Record<SourceId, string> = { albamon: '/total-search', daangn: '/s', alba: '/search/search' };

function officialUrl(value: unknown, source: SourceId): URL | undefined {
  if (typeof value !== 'string') return;
  try {
    const url = new URL(value);
    if (url.origin === officialOrigins[source] && !url.username && !url.password) return url;
  } catch { /* An invalid URL is a failed response, never a usable listing. */ }
}

function validJobUrl(value: unknown, source: SourceId): boolean {
  const url = officialUrl(value, source);
  if (!url) return false;
  if (source === 'albamon') return /^\/jobs\/detail\/\d+$/.test(url.pathname);
  if (source === 'alba') return url.pathname.toLowerCase() === '/job/detail' && /^\d+$/.test(url.searchParams.get('adid') || '');
  return /^\/job-posts\/[^/]+\/?$/.test(url.pathname);
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function readSingleResult(value: unknown, source: SourceId, query: string): SearchResult {
  const invalid = () => new SearchRequestError('invalid-response', '검색 응답 형식을 확인하지 못했어요. 다시 검색해주세요.');
  if (!record(value) || value.source !== source || typeof value.status !== 'string'
    || !['ok', 'empty', 'unavailable'].includes(value.status) || !Array.isArray(value.jobs)
    || typeof value.checkedAt !== 'string' || !Number.isFinite(Date.parse(value.checkedAt))) throw invalid();
  const searchUrl = officialUrl(value.searchUrl, source);
  if (!searchUrl || searchUrl.pathname.toLowerCase() !== searchPaths[source]
    || searchUrl.searchParams.get(queryKeys[source]) !== query) throw invalid();
  if (value.status === 'ok' ? !value.jobs.length : value.jobs.length !== 0) throw invalid();
  if (['message', 'regionNote'].some((key) => value[key] !== undefined && typeof value[key] !== 'string')) throw invalid();
  const ids = new Set<string>();
  const jobs: JobListing[] = value.jobs.map((job: unknown) => {
    if (!record(job) || typeof job.id !== 'string' || !job.id.trim() || ids.has(job.id)
      || typeof job.title !== 'string' || !job.title.trim() || !validJobUrl(job.url, source)
      || ['company', 'location', 'pay', 'schedule'].some((key) => job[key] !== undefined && typeof job[key] !== 'string')) throw invalid();
    ids.add(job.id);
    return {
      id: job.id, title: job.title, url: job.url as string,
      ...(job.company !== undefined && { company: job.company as string }),
      ...(job.location !== undefined && { location: job.location as string }),
      ...(job.pay !== undefined && { pay: job.pay as string }),
      ...(job.schedule !== undefined && { schedule: job.schedule as string })
    };
  });
  return {
    source, status: value.status as SearchResult['status'], jobs,
    searchUrl: searchUrl.href, checkedAt: value.checkedAt,
    ...(value.message !== undefined && { message: value.message as string }),
    ...(value.regionNote !== undefined && { regionNote: value.regionNote as string })
  };
}

function withAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(signal.reason); };
    // Attach settlement handlers even when fetch synchronously aborts the signal.
    promise.then((value) => { signal.removeEventListener('abort', abort); resolve(value); },
      (error) => { signal.removeEventListener('abort', abort); reject(error); });
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
  });
}

/** One source attempt, with no automatic retry and no substitute/mock results.
 * Retry manually by passing the same submitted snapshot and source again.
 * A multi attempt keeps the existing 2-request queue, deduplication and partial data.
 * retryFailedFrom is only for a matching submitted multi-Daangn result; successful
 * raw regions are preserved and the retry batch is committed atomically by callers.
 * onProgress observes completed initial multi regions independently of this promise;
 * cancellation/timeout still reject, and failed-only retries never publish progress.
 */
export async function requestSearchSource(
  snapshot: SearchSnapshot,
  source: SourceId,
  { signal, fetcher = fetch, timeoutMs, retryFailedFrom, onProgress }: {
    signal?: AbortSignal; fetcher?: typeof fetch; timeoutMs?: number; retryFailedFrom?: SearchResult;
    onProgress?: (progress: DaangnSearchProgress) => void;
  } = {}
): Promise<SearchResult> {
  if (signal?.aborted) throw cancelled();
  if (!snapshot || !Array.isArray(snapshot.requests) || typeof snapshot.query !== 'string'
    || !snapshot.query.trim() || snapshot.query !== snapshot.query.trim() || snapshot.query.length > 80
    || /[\u0000-\u001f]/.test(snapshot.query) || !sourceIds.includes(source)) throw invalidRequest();
  const request = snapshot.requests.find((candidate) => candidate.source === source);
  if (!request || !['single', 'multi'].includes(request.mode) || request.mode === 'multi' && source !== 'daangn') throw invalidRequest();
  if (retryFailedFrom !== undefined && (source !== 'daangn' || request.mode !== 'multi')) throw invalidRequest();
  const deadline = timeoutMs ?? (request.mode === 'multi' ? MULTI_SOURCE_TIMEOUT_MS : SINGLE_SOURCE_TIMEOUT_MS);
  if (!Number.isFinite(deadline) || deadline <= 0 || deadline > 120_000) throw invalidRequest();
  const controller = new AbortController();
  const abort = () => controller.abort(cancelled());
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  const timer = setTimeout(() => controller.abort(new SearchRequestError('timeout', '조회 시간이 길어 중단했어요. 잠시 후 이 업체를 다시 시도해주세요.')), deadline);
  const attemptSignal = controller.signal;
  const execute = async (): Promise<SearchResult> => {
    attemptSignal.throwIfAborted();
    if (request.mode === 'multi') {
      if (retryFailedFrom !== undefined) {
        try {
          return await retryFailedDaangnAreas(snapshot.query, request.areas, retryFailedFrom, { signal: attemptSignal, fetcher });
        } catch (error) {
          if (error instanceof TypeError || error instanceof RangeError) throw invalidRequest();
          throw error;
        }
      }
      return searchDaangnAreas(snapshot.query, request.areas, { signal: attemptSignal, fetcher, onProgress });
    }
    const options = request.options;
    if (!options || !['address', 'nationwide'].includes(options.scope)) throw invalidRequest();
    const params = new URLSearchParams({ q: snapshot.query, source, scope: options.scope });
    if (options.scope === 'address') {
      const area = toSearchArea(options.area);
      const level = options.areaLevel ?? 'neighborhood';
      if (!area || !levels.includes(level)) throw invalidRequest();
      params.set('areaLevel', level);
      for (const [key, value] of Object.entries(area)) params.set(key, value);
    }
    const response = await fetcher(`/api/search?${params}`, { signal: attemptSignal });
    attemptSignal.throwIfAborted();
    if (!response.ok) throw new SearchRequestError('http', `공고 조회에 실패했어요. (HTTP ${response.status})`, response.status);
    let value: unknown;
    try { value = await response.json(); }
    catch {
      attemptSignal.throwIfAborted();
      throw new SearchRequestError('invalid-response', '검색 응답을 읽지 못했어요. 다시 검색해주세요.');
    }
    attemptSignal.throwIfAborted();
    return readSingleResult(value, source, snapshot.query);
  };
  try {
    const result = await withAbort(execute(), attemptSignal);
    attemptSignal.throwIfAborted();
    return result;
  } catch (error) {
    if (attemptSignal.aborted) throw attemptSignal.reason;
    if (error instanceof SearchRequestError) throw error;
    throw new SearchRequestError('network', '연결을 확인하고 이 업체를 다시 시도해주세요.');
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}
