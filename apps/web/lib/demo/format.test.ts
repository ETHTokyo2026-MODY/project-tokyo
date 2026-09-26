import { describe, expect, it } from 'vitest';
import {
  DOW,
  MONTHS,
  historyLine,
  longDate,
  money,
  shortDate,
  signed,
  weekdayDate,
} from './format';

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
    expect(weekdayDate('2026-09-26', 6)).toBe('Sat Sep 26, 2026');
  });

  it('formats trade history lines', () => {
    const at = '2026-09-26T00:00:00.000Z';
    expect(
      historyLine(
        { type: 'booking', price: 88, at, simulated: true },
        'traderA',
      ),
    ).toBe('Booked at $88');
    expect(historyLine({ type: 'unbook', price: 88, at }, 'traderA')).toBe(
      'Booking undone',
    );
    expect(
      historyLine({ type: 'payout', to: 'traderA', price: 88, at }, 'traderA'),
    ).toBe('Paid out $88 to you (day passed)');
    expect(
      historyLine({ type: 'payout', to: 'host', price: 70, at }, 'traderA'),
    ).toBe('Paid out $70 (day passed)');
    expect(
      historyLine(
        {
          type: 'trade',
          from: 'host',
          to: 'traderA',
          price: 73,
          block: 7,
          at,
        },
        'traderA',
      ),
    ).toBe('You bought for $73 (in 7-day block)');
    expect(
      historyLine(
        { type: 'trade', from: 'traderA', to: 'traderB', price: 80, at },
        'traderA',
      ),
    ).toBe('You sold for $80');
    expect(
      historyLine(
        { type: 'trade', from: 'host', to: 'traderB', price: 65, at },
        'traderA',
      ),
    ).toBe('Bought for $65');
  });
});
