import { describe, expect, it } from 'vitest';
import { dateLabel, parseDateLabel, tokyoDay } from './dates';

describe('ens dates', () => {
  it('round-trips unix epoch and 2026 dates', () => {
    expect(dateLabel(0)).toBe('1970-01-01');
    expect(parseDateLabel('1970-01-01')).toBe(0);
    expect(dateLabel(20454)).toBe('2026-01-01');
    expect(parseDateLabel('2026-01-01')).toBe(20454);
    expect(parseDateLabel('2026-10-01')).toBe(20727);
  });

  it('rejects impossible calendar days', () => {
    expect(() => parseDateLabel('2026-02-29')).toThrow(/invalid date/);
    expect(() => parseDateLabel('2026/10/01')).toThrow(/invalid date/);
  });

  it('uses Tokyo midnight for the service day', () => {
    expect(tokyoDay(0)).toBe(0);
    expect(tokyoDay(15 * 3600)).toBe(1);
  });
});
