export function formatYen(amount: number): string {
  if (!Number.isFinite(amount)) {
    throw new Error('amount must be a finite number');
  }

  return `¥${Math.round(amount).toLocaleString('en-US')}`;
}
