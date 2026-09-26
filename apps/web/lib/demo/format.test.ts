import { describe, expect, it } from 'vitest';
import { DOW, MONTHS, longDate, money, shortDate, signed } from './format';

describe('format', () => {
  it('lists month and weekday names', () => {
    expect(MONTHS[8]).toBe('September');
    expect(DOW[6]).toBe('Sat');
  });

  it('formats money with en-US thousands separators', () => {
    expect(money(1001)).toBe('$1,001');
    expect(money(-5)).toBe('-$5');
  });

  it('formats signed money', () => {
    expect(signed(65)).toBe('+$65');
    expect(signed(0)).toBe('$0');
    expect(signed(-130)).toBe('-$130');
  });

  it('formats short and long dates', () => {
    expect(shortDate('2026-09-26')).toBe('Sep 26');
    expect(longDate('2026-09-26')).toBe('Sep 26, 2026');
  });
});
