import type { HistoryEntry } from './types';

export const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;

export const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

export function money(n: number): string {
  return (n < 0 ? '-$' : '$') + Math.abs(Math.round(n)).toLocaleString('en-US');
}

export function signed(n: number): string {
  return (n > 0 ? '+' : '') + money(n);
}

export function shortDate(date: string): string {
  return `${MONTHS[Number(date.slice(5, 7)) - 1].slice(0, 3)} ${Number(date.slice(8))}`;
}

export function longDate(date: string): string {
  return `${shortDate(date)}, ${date.slice(0, 4)}`;
}

/** `Sat Sep 26, 2026` — weekday from the day's stored index (0 = Sun). */
export function weekdayDate(date: string, weekday: number): string {
  return `${DOW[weekday]} ${longDate(date)}`;
}

export function historyLine(h: HistoryEntry, account: string): string {
  if (h.type === 'booking') return `Booked at ${money(h.price)}`;
  if (h.type === 'unbook') return 'Booking undone';
  if (h.type === 'payout') {
    return `Paid out ${money(h.price)}${h.to === account ? ' to you' : ''} (day passed)`;
  }
  const block = h.block && h.block > 1 ? ` (in ${h.block}-day block)` : '';
  if (h.to === account) return `You bought for ${money(h.price)}${block}`;
  if (h.from === account) return `You sold for ${money(h.price)}${block}`;
  return `Bought for ${money(h.price)}${block}`;
}
