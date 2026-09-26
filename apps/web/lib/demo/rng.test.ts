import { describe, expect, it } from 'vitest';
import { hashSeed, makeRng } from './rng';

describe('rng', () => {
  it('streams the same next() values for seed 38', () => {
    const rng = makeRng(38);
    expect([rng.next(), rng.next(), rng.next()]).toEqual([
      0.720611231168732, 0.848281288985163, 0.06606057216413319,
    ]);
  });

  it('streams the same int() values for a fresh seed 38', () => {
    const rng = makeRng(38);
    expect([
      rng.int(-3, 3),
      rng.int(-3, 3),
      rng.int(-3, 3),
      rng.int(0, 2),
    ]).toEqual([2, 2, -3, 2]);
  });

  it('hashes an account seed with FNV-1a', () => {
    expect(hashSeed('shimokita-studio|traderA')).toBe(2129916496);
  });
});
