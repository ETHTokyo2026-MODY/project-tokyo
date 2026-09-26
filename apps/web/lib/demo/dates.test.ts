import { describe, expect, it } from 'vitest';
import { addDays, calendarEnd, dayNum, todayTokyo, weekday } from './dates';

describe('dates', () => {
  it('adds days across month end, year end and Feb 29 2028', () => {
    expect(addDays('2026-09-30', 1)).toBe('2026-10-01');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
    expect(addDays('2028-02-29', 1)).toBe('2028-03-01');
  });

  it('treats 2026-09-26 as Saturday', () => {
    expect(weekday('2026-09-26')).toBe(6);
  });

  it('counts whole UTC days between dates', () => {
    expect(dayNum('2026-09-27') - dayNum('2026-09-26')).toBe(1);
    expect(dayNum('2026-10-01') - dayNum('2026-09-26')).toBe(5);
    expect(dayNum('2027-01-01') - dayNum('2026-01-01')).toBe(365);
  });

  it('ends the calendar on the last day 24 months out', () => {
    expect(calendarEnd('2026-09-26')).toBe('2028-09-30');
    expect(calendarEnd('2026-12-15')).toBe('2028-12-31');
  });

  it('uses the Tokyo calendar date', () => {
    expect(todayTokyo(new Date('2026-09-25T15:30:00Z'))).toBe('2026-09-26');
  });
});
