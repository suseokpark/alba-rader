export type SourceId = 'daangn' | 'albamon' | 'alba';

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

export interface SearchResult {
  source: SourceId;
  status: 'ok' | 'empty' | 'unavailable';
  jobs: JobListing[];
  searchUrl: string;
  checkedAt: string;
  message?: string;
  regionNote?: string;
}

export const sources: { id: SourceId; name: string; hint: string }[] = [
  { id: 'albamon', name: '알바몬', hint: '통합 채용정보' },
  { id: 'daangn', name: '당근', hint: '동네 공고' },
  { id: 'alba', name: '알바천국', hint: '통합 채용정보' }
];
