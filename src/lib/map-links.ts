import type { SelectedAddress } from './postcode';
import type { SearchArea } from './search';

const SEARCH_BASE = 'https://map.kakao.com/link/search/';
const MAX_QUERY_LENGTH = 300;

/** Official Kakao map search links; no coordinates or administrative boundaries are inferred. */
export function kakaoMapSearchUrl(query: string | null | undefined): string | undefined {
  if (typeof query !== 'string' || query.length > 2_000 || /[\u0000-\u001f\u007f-\u009f]/u.test(query)) return;
  const normalized = query.replace(/\s+/gu, ' ').trim();
  // URL parsers collapse dot-only path segments, even when their dots are encoded.
  if (!normalized || normalized.length > MAX_QUERY_LENGTH || normalized === '.' || normalized === '..') return;
  try {
    return `${SEARCH_BASE}${encodeURIComponent(normalized)}`;
  } catch {
    // Malformed Unicode (such as an unmatched surrogate) must not break rendering.
    return undefined;
  }
}

export function addressMapUrl(address: Pick<SelectedAddress, 'address'> | null): string | undefined {
  return kakaoMapSearchUrl(address?.address);
}

export function neighborhoodMapUrl(area: SearchArea): string | undefined {
  if (!area || typeof area.sido !== 'string' || typeof area.sigungu !== 'string' || typeof area.bname !== 'string'
    || !area.sido.trim() || !area.bname.trim()) return;
  // Deliberately select only these three fields, even if the input also has a street address.
  return kakaoMapSearchUrl([area.sido, area.sigungu, area.bname].join(' '));
}
