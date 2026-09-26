import type { AreaLevel, DaangnSearchProgress, SearchArea, SearchResult, SourceId } from './search';
import type { SelectedAddress } from './postcode';
import type { SortOrder } from './sort-jobs';
import type { JobFilters } from './filter-jobs';
import type { SearchSnapshot } from './search-request';

export type SearchLane = {
  source: SourceId;
  state: 'loading' | 'done';
  result?: SearchResult;
  error?: string;
  cancelled?: boolean;
  retryable?: boolean;
  retryingFailed?: boolean;
  retryNotice?: string;
  progress?: DaangnSearchProgress;
};

export interface SearchSessionState {
  query: string;
  selected: SourceId[];
  submitted: string;
  lanes: SearchLane[];
  validation: string;
  scope: 'nationwide' | 'address';
  address: SelectedAddress | null;
  areaLevel: AreaLevel;
  daangnMultiEnabled: boolean;
  daangnAreas: SearchArea[];
  daangnNotice: string;
  submittedArea: string;
  sortOrder: SortOrder;
  filters: JobFilters;
  appliedSnapshot: SearchSnapshot | null;
}

export const SEARCH_SESSION = Symbol('alba-search-session');

/** Created by each root layout, never shared between SSR requests or app tabs.
 * Plain page data only: no storage, URL serialization, DOM, timers or requests.
 * A reload/tab close drops this in-memory continuation of the current search.
 */
export function createSearchSession() {
  let state: SearchSessionState | null = null;
  return {
    read(): SearchSessionState | null { return state ? structuredClone(state) : null; },
    write(value: SearchSessionState) { state = structuredClone(value); },
    clear() { state = null; }
  };
}

export type SearchSession = ReturnType<typeof createSearchSession>;
