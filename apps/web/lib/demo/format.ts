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
