import assert from 'node:assert/strict';
import { test } from 'node:test';
import { scheduleMatch } from '../src/lib/schedule-filters.ts';

test('unselected filters accept missing data; selected filters preserve unknown', () => {
  for (const value of [undefined, '', '  ']) {
    assert.equal(scheduleMatch(value, 'all', 'all'), 'match');
    assert.equal(scheduleMatch(value, 'weekdays', 'all'), 'unknown');
    assert.equal(scheduleMatch(value, 'all', 'morning'), 'unknown');
  }
});

test('explicit recurring days are classified as weekday-only or weekend-only', () => {
  for (const value of ['월~금', '월요일~금요일', '매주 월,화', '평일', '주중(월,수)', '근무요일: 월~금']) {
    assert.equal(scheduleMatch(`${value} · 09:00~13:00 · 6개월~1년`, 'weekdays', 'morning'), 'match', value);
    assert.equal(scheduleMatch(value, 'weekends', 'all'), 'mismatch', value);
  }
  for (const value of ['토,일', '토~일', '주말(토,일)', '주말', '일', '매주 토,일']) {
    assert.equal(scheduleMatch(`${value} · 09:00~13:00 · 6개월~1년`, 'weekends', 'morning'), 'match', value);
    assert.equal(scheduleMatch(value, 'weekdays', 'all'), 'mismatch', value);
  }
  for (const value of ['월~일', '금,토', '금~월']) {
    assert.equal(scheduleMatch(value, 'weekdays', 'all'), 'mismatch', value);
    assert.equal(scheduleMatch(value, 'weekends', 'all'), 'mismatch', value);
  }
});

test('day counts, dates, durations and ambiguous clauses never invent weekdays', () => {
  for (const value of [
    '주5일', '주2일', '주 2일', '총 2일 / 9월 24~25일', '9월 26일(토)',
    '총 7일 / 오늘~9월 29일', '1일~1주일', '6개월~1년',
    '6개월 이상 (주말 포함)', '월~금 또는 주말', '주말(월,화)', '격주 토,일',
    '월~금 · 토,일', '월~금 · 주2일'
  ]) {
    assert.equal(scheduleMatch(`${value} · 17:00 ~ 00:00`, 'weekends', 'all'), 'unknown', value);
  }
});

test('day negotiation is distinct from time and period negotiation', () => {
  for (const value of ['요일협의', '요일 협의', '근무요일: 협의', '월~금 협의', '월~금(요일 협의)', '주말 협의']) {
    assert.equal(scheduleMatch(`${value} · 09:00~13:00`, 'negotiable', 'morning'), 'match', value);
    assert.equal(scheduleMatch(value, 'weekdays', 'all'), 'unknown', value);
    assert.equal(scheduleMatch(value, 'weekends', 'all'), 'unknown', value);
  }
  assert.equal(scheduleMatch('토,일 · 12:00 ~ 15:00 협의', 'negotiable', 'all'), 'mismatch');
  assert.equal(scheduleMatch('토,일 · 09:00~13:00 · 6개월~1년 협의', 'negotiable', 'morning'), 'mismatch');
  assert.equal(scheduleMatch('요일 협의 · 09:00~13:00', 'all', 'negotiable'), 'mismatch');
});

test('time bands use only the explicit start time including midnight crossing', () => {
  const cases = [
    ['00:00', 'overnight'], ['05:59', 'overnight'], ['06:00', 'morning'],
    ['11:59', 'morning'], ['12:00', 'afternoon'], ['17:59', 'afternoon'],
    ['18:00', 'evening'], ['23:59', 'evening']
  ];
  for (const [start, expected] of cases) {
    for (const band of ['morning', 'afternoon', 'evening', 'overnight']) {
      assert.equal(scheduleMatch(`월~금 · ${start} ~ 09:30`, 'all', band), band === expected ? 'match' : 'mismatch', start);
    }
  }
  assert.equal(scheduleMatch('토 · 21:00 ~ 09:00', 'weekends', 'evening'), 'match');
  assert.equal(scheduleMatch('주말(토,일) · 00:00~08:00 (익일) · 6개월~1년', 'weekends', 'overnight'), 'match');
  assert.equal(scheduleMatch('월~금 · 23:00~07:00(다음날)', 'weekdays', 'evening'), 'match');
  assert.equal(scheduleMatch('월~금 · 23:00~07:00 (다음 날) 협의', 'weekdays', 'evening'), 'unknown');
  assert.equal(scheduleMatch('월~금 · 23:00 ~ 09:30', 'weekdays', 'overnight'), 'mismatch');
  assert.equal(scheduleMatch('09:00~24:00', 'all', 'morning'), 'match');
  assert.equal(scheduleMatch('매주 월,화 09:00~13:00', 'weekdays', 'morning'), 'match');
  assert.equal(scheduleMatch('근무시간: 06:00-12:00', 'all', 'morning'), 'match');
});

test('time negotiation remains unknown for fixed-start filters', () => {
  for (const value of ['시간협의', '시간 협의', '12:00 ~ 15:00 협의', '12:00~15:00 (시간 협의)', '09:00~13:00(협의가능)']) {
    assert.equal(scheduleMatch(`토,일 · ${value}`, 'weekends', 'negotiable'), 'match', value);
    assert.equal(scheduleMatch(`토,일 · ${value}`, 'weekends', 'morning'), 'unknown', value);
  }
  assert.equal(scheduleMatch('토,일 · 09:00~13:00 · 6개월~1년 협의', 'weekends', 'morning'), 'match');
});

test('multiple shifts, extra clock clauses and invalid times remain unknown', () => {
  for (const value of [
    '09:00~13:00 / 18:00~22:00', '평일 09:00~13:00 / 주말 10:00~14:00',
    '09:00~13:00 또는 18:00', '휴게시간 12:00~13:00', '오후 09:00~13:00',
    '25:00~26:00', '09:60~13:00', '24:00~08:00', '09:00~24:01', '야간', '오전'
  ]) {
    assert.equal(scheduleMatch(value, 'all', 'morning'), 'unknown', value);
  }
});

test('real Daangn display formats preserve date and negotiation limits', () => {
  assert.equal(scheduleMatch('토,일 · 12:00 ~ 15:00 협의', 'weekends', 'afternoon'), 'unknown');
  assert.equal(scheduleMatch('총 2일 / 9월 24~25일 · 17:00 ~ 00:00', 'weekends', 'afternoon'), 'unknown');
  assert.equal(scheduleMatch('총 2일 / 9월 24~25일 · 17:00 ~ 00:00', 'all', 'afternoon'), 'match');
  assert.equal(scheduleMatch('총 7일 / 오늘~9월 29일 · 시간 협의', 'all', 'negotiable'), 'match');
});

test('known mismatches take precedence over another unknown condition', () => {
  assert.equal(scheduleMatch('월~금 · 시간협의', 'weekends', 'morning'), 'mismatch');
  assert.equal(scheduleMatch('주2일 · 18:00~22:00', 'weekends', 'morning'), 'mismatch');
  assert.equal(scheduleMatch('주2일 · 09:00~13:00', 'weekends', 'morning'), 'unknown');
  assert.equal(scheduleMatch('주말(토,일) · 09:00~13:00 · 6개월~1년', 'weekends', 'morning'), 'match');
});

test('negative or incomplete day negotiation clauses are not affirmative evidence', () => {
  for (const clause of ['요일 협의 불가', '요일 협의 불가능', '요일 협의 안됨', '요일 협의 없음',
    '요일 협의 가능 여부 미정', '요일 협의 가능한지 문의', '요일 협의 가능하지 않음']) {
    for (const value of [clause, `월~금 (${clause})`, `요일 협의 · ${clause}`]) {
      assert.equal(scheduleMatch(`${value} · 09:00~18:00`, 'negotiable', 'all'), 'unknown', value);
      assert.equal(scheduleMatch(`${value} · 09:00~18:00`, 'weekdays', 'all'), 'unknown', value);
    }
  }
});

test('negative time negotiation remains unknown even beside a nominal range or affirmative clause', () => {
  for (const clause of ['시간 협의 불가', '시간 협의 불가능', '시간 협의 안됨', '시간 협의 없음',
    '시간 협의 가능 여부 미정', '시간 협의 가능한지 문의', '시간 협의 가능하지 않음']) {
    for (const value of [clause, `09:00~18:00 (${clause})`, `09:00~18:00 · ${clause}`, `시간 협의 · ${clause}`]) {
      assert.equal(scheduleMatch(`월~금 · ${value}`, 'all', 'negotiable'), 'unknown', value);
      assert.equal(scheduleMatch(`월~금 · ${value}`, 'all', 'morning'), 'unknown', value);
    }
  }
});

test('complete positive negotiation formats still work without confusing the other dimension', () => {
  for (const value of ['요일 협의 가능', '(요일 협의)', '월~금 (요일 협의 가능)', '주5일(요일 협의)', '근무요일: 협의 가능']) {
    assert.equal(scheduleMatch(`${value} · 09:00~18:00`, 'negotiable', 'morning'), 'match', value);
  }
  for (const value of ['시간 협의 가능', '(시간 협의)', '근무시간: 협의 가능', '근무시간 협의', '시간 협의: 09:00~18:00',
    '09:00~18:00 (시간 협의 가능)', '09:00~18:00 · 시간 협의']) {
    assert.equal(scheduleMatch(`월~금 · ${value}`, 'weekdays', 'negotiable'), 'match', value);
  }
  assert.equal(scheduleMatch('요일 협의 불가 · 09:00~18:00', 'all', 'morning'), 'match');
  assert.equal(scheduleMatch('월~금 · 시간 협의 불가', 'weekdays', 'all'), 'match');
  assert.equal(scheduleMatch('요일 협의 · 시간 협의 불가', 'negotiable', 'all'), 'match');
  assert.equal(scheduleMatch('월~금 · 09:00~18:00 (요일 협의)', 'negotiable', 'all'), 'match');
  for (const label of ['휴게시간', '면접시간']) {
    const value = `월~금 · 09:00~18:00 · ${label}: 협의`;
    assert.equal(scheduleMatch(value, 'all', 'negotiable'), 'mismatch', value);
    assert.equal(scheduleMatch(value, 'weekdays', 'morning'), 'match', value);
  }
  for (const nextDay of ['익일', '다음날', '다음 날']) {
    assert.equal(scheduleMatch(`월~금 · 시간 협의: 23:00~07:00 (${nextDay})`, 'weekdays', 'negotiable'), 'match');
  }
});

test('labelled negotiation conflicts include colons and clauses after clock ranges', () => {
  for (const [value, days, time] of [
    ['요일 협의 · 근무요일: 협의 불가 · 09:00~18:00', 'negotiable', 'all'],
    ['월~금 · 시간 협의 · 근무시간: 협의 불가', 'all', 'negotiable'],
    ['요일 협의 · 09:00~18:00 (요일 협의 불가)', 'negotiable', 'all'],
    ['시간 협의 · 09:00~18:00 (근무시간: 협의 불가)', 'all', 'negotiable'],
    ['요일 협의(불가)', 'negotiable', 'all'],
    ['시간 협의(불가)', 'all', 'negotiable']
  ]) assert.equal(scheduleMatch(value, days, time), 'unknown', value);
});
