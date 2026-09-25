export type DayFilter = 'all' | 'weekdays' | 'weekends' | 'negotiable';
export type TimeFilter = 'all' | 'morning' | 'afternoon' | 'evening' | 'overnight' | 'negotiable';
export type ScheduleMatch = 'match' | 'mismatch' | 'unknown';

type UnconfirmedEvidence = { kind: 'negotiable' } | { kind: 'unknown' };
type DayEvidence = { kind: 'fixed'; days: Set<number> } | UnconfirmedEvidence;
type TimeEvidence = { kind: 'fixed'; start: number } | UnconfirmedEvidence;
const DAY_NAMES = '월화수목금토일';
const UNKNOWN = { kind: 'unknown' } as const;
const NEGOTIABLE = { kind: 'negotiable' } as const;
const segments = (text: string) => text.split(/[·ㆍ•|]/).map((part) => part.trim()).filter(Boolean);

// Check every labelled clause, including after a clock range. A complete positive
// clause may be wrapped in parentheses or followed by a range; extra wording is
// unresolved, not affirmative evidence (e.g. "협의 불가" or "협의 가능 여부 미정").
function labelledNegotiation(text: string, label: '요일' | '시간'): UnconfirmedEvidence | undefined {
  let found = false;
  for (const part of segments(text)) {
    const clauses = part.matchAll(new RegExp(`(?<![가-힣])(?:근무\\s*)?${label}\\s*:?\\s*협의`, 'g'));
    for (const clause of clauses) {
      found = true;
      const tail = part.slice(clause.index! + clause[0].length).trim()
        .replace(/\(\s*(?:익일|다음\s*날)\s*\)$/, '').trim()
        .replace(/\)+\s*$/, '').trim()
        .replace(/\s*:?\s*\d{1,2}:\d{2}\s*[~〜～\-–—]\s*\d{1,2}:\d{2}$/, '').trim()
        .replace(/\)+\s*$/, '').trim();
      if (!/^(?:가능)?$/.test(tail)) return UNKNOWN;
    }
  }
  return found ? NEGOTIABLE : undefined;
}

// Only complete day expressions are accepted: a date's "일" is never Sunday.
function parseDays(value: string): DayEvidence {
  let text = value.trim().replace(/^근무\s*요일\s*:?\s*/, '').replace(/^매주\s*/, '');
  if (/^요일\s*협의(?:\s*가능)?$/.test(text) || /^(?:협의|협의\s*가능)$/.test(text) && /^근무\s*요일/.test(value)) {
    return NEGOTIABLE;
  }
  const negotiable = /\(?\s*(?:요일\s*)?협의(?:\s*가능)?\s*\)?$/.test(text);
  if (negotiable) text = text.replace(/\(?\s*(?:요일\s*)?협의(?:\s*가능)?\s*\)?$/, '').trim();
  text = text.replace(/\s*근무$/, '').replaceAll('요일', '').replace(/\s+/g, '');

  const label = text.match(/^(평일|주중|주말)(?:\((.+)\))?$/);
  if (label) {
    const allowed = label[1] === '주말' ? new Set([5, 6]) : new Set([0, 1, 2, 3, 4]);
    if (!label[2]) return negotiable ? NEGOTIABLE : { kind: 'fixed', days: allowed };
    const inner = parseDays(label[2]);
    if (inner.kind !== 'fixed' || [...inner.days].some((day) => !allowed.has(day))) return UNKNOWN;
    return negotiable ? NEGOTIABLE : inner;
  }
  if (!/^[월화수목금토일](?:[~〜～][월화수목금토일])?(?:,[월화수목금토일](?:[~〜～][월화수목금토일])?)*$/.test(text)) return UNKNOWN;
  const days = new Set<number>();
  for (const term of text.split(',')) {
    const start = DAY_NAMES.indexOf(term[0]);
    const end = term.length === 1 ? start : DAY_NAMES.indexOf(term.at(-1)!);
    for (let day = start; ; day = (day + 1) % 7) {
      days.add(day);
      if (day === end) break;
    }
  }
  return negotiable ? NEGOTIABLE : { kind: 'fixed', days };
}

function dayEvidence(text: string): DayEvidence {
  const negotiation = labelledNegotiation(text, '요일');
  if (negotiation) return negotiation;
  const evidence: DayEvidence[] = [];
  for (const part of segments(text)) {
    const clock = part.search(/\d{1,2}:\d{2}/);
    const candidate = (clock < 0 ? part : part.slice(0, clock)).trim();
    if (!candidate) continue;
    const parsed = parseDays(candidate);
    if (parsed.kind !== 'unknown') evidence.push(parsed);
    else if (/주\s*\d+\s*일|격주|요일|평일|주중|주말|(?<![가-힣\d])[월화수목금토일]\s*[,~〜～]/.test(candidate)) {
      evidence.push(UNKNOWN);
    }
  }
  if (evidence.some((item) => item.kind === 'negotiable')) return NEGOTIABLE;
  // Multiple day clauses may represent alternative shifts; do not invent a union.
  return evidence.length === 1 ? evidence[0] : UNKNOWN;
}

function timeEvidence(text: string): TimeEvidence {
  const ranges = [...text.matchAll(/(?<!\d)(\d{1,2}):(\d{2})\s*[~〜～\-–—]\s*(\d{1,2}):(\d{2})(?!\d)/g)];
  if (ranges.length > 1) return UNKNOWN;
  const parts = segments(text);
  const negotiation = labelledNegotiation(text, '시간');
  if (negotiation?.kind === 'unknown') return UNKNOWN;
  const explicitNegotiation = negotiation?.kind === 'negotiable';
  if (!ranges.length) return explicitNegotiation ? NEGOTIABLE : UNKNOWN;
  if ([...text.matchAll(/\d{1,2}:\d{2}/g)].length !== 2) return UNKNOWN;
  const range = ranges[0];
  const [startHour, startMinute, endHour, endMinute] = [range[1], range[2], range[3], range[4]].map(Number);
  if (startHour > 23 || startMinute > 59 || endHour > 24 || endMinute > 59 || endHour === 24 && endMinute !== 0) return UNKNOWN;

  const part = parts.find((segment) => segment.includes(range[0]))!;
  const index = part.indexOf(range[0]);
  const prefix = part.slice(0, index).trim();
  const suffix = part.slice(index + range[0].length)
    .replace(/\(\s*(?:익일|다음\s*날)\s*\)/g, '')
    .replace(/[()\s]/g, '');
  const timeLabel = /^(?:근무\s*)?시간\s*:?\s*$/.test(prefix);
  const dayPrefix = parseDays(prefix);
  const countOnly = /^주\s*\d+\s*일(?:\s*근무)?$/.test(prefix);
  const timeNegotiationPrefix = /^(?:근무\s*)?시간\s*협의(?:\s*가능)?\s*:?\s*$/.test(prefix);
  if (prefix && !timeLabel && !countOnly && !timeNegotiationPrefix && dayPrefix.kind === 'unknown') return UNKNOWN;
  const negotiableSuffix = /^(?:시간)?협의(?:가능)?$/.test(suffix);
  if (suffix && suffix !== '근무' && !negotiableSuffix) return UNKNOWN;
  if (explicitNegotiation || negotiableSuffix || timeNegotiationPrefix) return NEGOTIABLE;
  return { kind: 'fixed', start: startHour * 60 + startMinute };
}

function matchDays(text: string, filter: DayFilter): ScheduleMatch {
  if (filter === 'all') return 'match';
  const evidence = dayEvidence(text);
  if (evidence.kind === 'unknown') return 'unknown';
  if (filter === 'negotiable') return evidence.kind === 'negotiable' ? 'match' : 'mismatch';
  if (evidence.kind === 'negotiable') return 'unknown';
  return [...evidence.days].every((day) => filter === 'weekdays' ? day < 5 : day >= 5) ? 'match' : 'mismatch';
}

function matchTime(text: string, filter: TimeFilter): ScheduleMatch {
  if (filter === 'all') return 'match';
  const evidence = timeEvidence(text);
  if (evidence.kind === 'unknown') return 'unknown';
  if (filter === 'negotiable') return evidence.kind === 'negotiable' ? 'match' : 'mismatch';
  if (evidence.kind === 'negotiable') return 'unknown';
  const hour = evidence.start / 60;
  const band: TimeFilter = hour < 6 ? 'overnight' : hour < 12 ? 'morning' : hour < 18 ? 'afternoon' : 'evening';
  return band === filter ? 'match' : 'mismatch';
}

export function scheduleMatch(schedule: string | undefined, days: DayFilter, time: TimeFilter): ScheduleMatch {
  if (days === 'all' && time === 'all') return 'match';
  if (!schedule?.trim()) return 'unknown';
  const matches = [matchDays(schedule, days), matchTime(schedule, time)];
  if (matches.includes('mismatch')) return 'mismatch';
  return matches.includes('unknown') ? 'unknown' : 'match';
}
