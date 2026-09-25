export type SourceId = 'daangn' | 'albamon' | 'alba';
export type AreaLevel = 'neighborhood' | 'district' | 'city' | 'province';

export interface SearchArea {
  sido: string;
  sigungu: string;
  bname: string;
  bcode: string;
  sigunguCode: string;
}

export interface SearchOptions {
  scope: 'nationwide' | 'address';
  area?: SearchArea;
  /** Omitted by legacy API callers: retain neighborhood search behavior. */
  areaLevel?: AreaLevel;
}

export interface JobListing {
  id: string;
  title: string;
  url: string;
  company?: string;
  location?: string;
  pay?: string;
  schedule?: string;
}

/** Client-only initial multi-search progress. Entries are completed responses,
 * in submitted neighborhood order, not placeholders for pending requests.
 * Callbacks receive copied, deeply frozen snapshots.
 */
export interface DaangnSearchProgress {
  entries: { area: SearchArea; result: SearchResult }[];
  total: number;
}

export interface SearchResult {
  source: SourceId;
  status: 'ok' | 'empty' | 'unavailable';
  jobs: JobListing[];
  searchUrl: string;
  checkedAt: string;
  message?: string;
  regionNote?: string;
  regionResults?: {
    area: SearchArea;
    label: string;
    status: 'ok' | 'empty' | 'unavailable';
    jobsCount: number;
    searchUrl: string;
    checkedAt: string;
    message?: string;
  }[];
  /** Client-only validated, ordered pre-deduplication responses for failed-area retry.
   * Never sent to the search API; each nested result is a single region response.
   */
  regionEntries?: { area: SearchArea; result: SearchResult }[];
  duplicateCount?: number;
  partial?: boolean;
  /** Client-only interruption of an initial multi-search. These areas have no
   * completed response: they are not empty results or provider failures.
   */
  interruption?: { reason: 'cancelled' | 'timeout'; remainingAreas: SearchArea[] };
}

export const sources: { id: SourceId; name: string; hint: string }[] = [
  { id: 'albamon', name: '알바몬', hint: '통합 채용정보' },
  { id: 'daangn', name: '당근', hint: '동네 공고' },
  { id: 'alba', name: '알바천국', hint: '통합 채용정보' }
];
