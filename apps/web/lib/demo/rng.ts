/** FNV-1a 32-bit hash of a string. */
export function hashSeed(s: string): number {
  let h = 2166136261;
  for (const c of s) {
    const code = c.codePointAt(0);
    if (code === undefined) continue;
    h = Math.imul(h ^ code, 16777619) >>> 0;
  }
  return h;
}

/** mulberry32: returns `next()` in [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function makeRng(seed: number): {
  next: () => number;
  int: (lo: number, hi: number) => number;
} {
  const next = mulberry32(seed);
  const int = (lo: number, hi: number) =>
    lo + Math.floor(next() * (hi - lo + 1));
  return { next, int };
}
