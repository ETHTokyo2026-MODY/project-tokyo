import { describe, expect, it } from 'vitest';
import { formatYen } from './formatYen';

describe('formatYen', () => {
  it('formats a whole yen amount with a yen sign and grouping', () => {
    expect(formatYen(12000)).toBe('¥12,000');
  });
});
