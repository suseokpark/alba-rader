import type { AreaLevel, SearchArea, SourceId } from './search';

export const areaLevelNames: Record<AreaLevel, string> = {
  neighborhood: '동·읍·면', district: '시·군·구', city: '시·군 전체', province: '시·도 전체'
};

/** General cities can contain districts, e.g. 경기 수원시 영통구. */
export function cityName(area: SearchArea): string {
  const first = area.sigungu.trim().split(/\s+/)[0] || '';
  return /[시군]$/.test(first) ? first : '';
}

export function areaLabel(area: SearchArea, level: AreaLevel): string {
  const parts = [area.sido];
  if (level === 'city') parts.push(cityName(area));
  else if (level !== 'province') {
    parts.push(area.sigungu);
    if (level === 'neighborhood') parts.push(area.bname);
  }
  return parts.map((part) => part.trim()).filter(Boolean).join(' ');
}

export function areaLevelChoices(area: SearchArea | null): { value: AreaLevel; label: string }[] {
  const levels: AreaLevel[] = ['neighborhood'];
  if (!area || area.sigungu.trim()) levels.push('district');
  // Show a distinct city option only when it adds coverage beyond this district.
  if (area && cityName(area) && cityName(area) !== area.sigungu.trim()) levels.push('city');
  levels.push('province');
  return levels.map((value) => ({ value, label: area ? `${areaLevelNames[value]} · ${areaLabel(area, value)}` : areaLevelNames[value] }));
}

export function normalizeAreaLevel(level: AreaLevel, area: SearchArea): AreaLevel {
  if (level === 'district' && !area.sigungu.trim()) return 'province';
  if (level !== 'city' || areaLevelChoices(area).some((choice) => choice.value === 'city')) return level;
  return cityName(area) ? 'district' : 'province';
}

/** Base-provider coverage only; separately selected Daangn areas have their own help. */
export function baseAreaHelp(scope: 'nationwide' | 'address', level: AreaLevel, area: SearchArea | null): string {
  if (scope === 'nationwide') return '전국은 알바몬·알바천국에서 검색합니다.';
  if (level === 'neighborhood') {
    const albaCoverage = area && !area.sigungu.trim() ? `${areaLabel(area, 'province')} 전체` : '시·군·구';
    return `알바몬은 동·읍·면, 알바천국은 ${albaCoverage} 기준으로 검색해요.`;
  }
  return '선택한 주소에서 지역 범위를 넓혀 알바몬·알바천국을 검색합니다.';
}

/** Parse only supported scopes. An invalid value must never become a nationwide query. */
export function parseAreaLevel(value: string | null): AreaLevel | undefined {
  if (value === null) return 'neighborhood';
  return ['neighborhood', 'district', 'city', 'province'].includes(value) ? value as AreaLevel : undefined;
}

export function supportsSearchArea(source: SourceId, scope: 'nationwide' | 'address', level: AreaLevel, separateDaangnSelection = false): boolean {
  // Separate selection still dispatches neighborhood requests, never a broad Daangn request.
  return source !== 'daangn' || separateDaangnSelection || scope === 'address' && level === 'neighborhood';
}
