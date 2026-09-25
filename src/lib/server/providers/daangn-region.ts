import type { AreaLevel, SearchArea } from '../../search';

export interface DaangnRegion {
  id: number;
  label: string;
}

// The unauthenticated region picker uses this public read-only persisted query.
// Observed in https://jobs.daangn.com/assets/routes-3rrULvPU.js (keywordResultsQuery).
// A changed/removed query fails closed; it never substitutes a default region.
const REGION_QUERY_ID = 'e5eb7d7e6ca3a71821db69609e66d47d';
const cache = new Map<string, { region: DaangnRegion; expiresAt: number }>();
const compact = (value: string) => value.replace(/\s+/g, '');
const provinceAliases: Record<string, string> = {
  서울특별시: '서울', 부산광역시: '부산', 대구광역시: '대구', 인천광역시: '인천',
  광주광역시: '광주', 대전광역시: '대전', 울산광역시: '울산', 세종특별자치시: '세종',
  경기도: '경기', 강원도: '강원', 강원특별자치도: '강원', 충청북도: '충북',
  충청남도: '충남', 전라북도: '전북', 전북특별자치도: '전북', 전라남도: '전남',
  경상북도: '경북', 경상남도: '경남', 제주도: '제주', 제주특별자치도: '제주'
};
const province = (value: string) => provinceAliases[compact(value)] ?? compact(value);

export async function resolveDaangnRegion(
  area: SearchArea,
  signal: AbortSignal,
  areaLevel: AreaLevel = 'neighborhood'
): Promise<DaangnRegion | null> {
  // The public picker defaults to regionDepth 3. Checked depth 1/2 responses
  // do not provide province/district IDs; never reuse a dong ID for wider areas.
  if (areaLevel !== 'neighborhood') return null;
  if (!area.sido || !area.bname) return null;
  const key = [area.bcode, area.sido, area.sigungu, area.bname].join('|');
  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.region;
  cache.delete(key);

  const response = await fetch('https://jobs.kr.karrotmarket.com/graphql', {
    method: 'POST',
    signal,
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      id: REGION_QUERY_ID,
      query: '',
      variables: { query: [area.sido, area.sigungu, area.bname].filter(Boolean).join(' '), first: 20, regionDepth: 3 }
    })
  });
  if (!response.ok) throw new Error('Daangn region lookup unavailable');
  const data = await response.json();
  if (data.errors || !Array.isArray(data.data?.searchRegions?.edges)) {
    throw new Error('Daangn region lookup response changed');
  }

  const matches = new Map<number, DaangnRegion>();
  for (const edge of data.data.searchRegions.edges) {
    const node = edge?.node;
    if (!node || !Number.isSafeInteger(node._id) || node._id <= 0 ||
        typeof node.name1 !== 'string' || typeof node.name2 !== 'string' || typeof node.name3 !== 'string') continue;
    // A same-named dong in another province/district must never be selected.
    if (province(node.name1) !== province(area.sido) || compact(node.name2) !== compact(area.sigungu) ||
        compact(node.name3) !== compact(area.bname)) continue;
    matches.set(node._id, { id: node._id, label: [node.name1, node.name2, node.name3].filter(Boolean).join(' ') });
  }
  if (matches.size !== 1) return null;
  const region = [...matches.values()][0];
  if (cache.size >= 256) cache.delete(cache.keys().next().value!);
  cache.set(key, { region, expiresAt: Date.now() + 24 * 60 * 60 * 1000 });
  return region;
}
