import { describe, expect, it } from 'vitest';
import { seedState } from './seed';
import { decodeState, encodeState } from './storage';

const TODAY = '2026-09-26';

describe('storage', () => {
  it('round-trips a seeded state and stays under 200 KB', async () => {
    const state = seedState(TODAY);
    const encoded = await encodeState(state);
    expect(encoded.startsWith('gz1:')).toBe(true);
    expect(new TextEncoder().encode(encoded).length).toBeLessThan(200_000);
    const decoded = await decodeState(encoded);
    expect(decoded).toEqual(state);
  });

  it('adds an empty bids list to older saved state', async () => {
    const decoded = await decodeState(
      JSON.stringify({
        version: 1,
        accounts: { host: { name: 'H', role: 'r', cash: 0, startCash: 0 } },
        assets: [],
      }),
    );
    expect(decoded?.bids).toEqual([]);
  });

  it('decodes garbage to null', async () => {
    expect(await decodeState('not-json')).toBeNull();
    expect(await decodeState('gz1:@@@')).toBeNull();
    expect(await decodeState('{"foo":1}')).toBeNull();
    expect(await decodeState('null')).toBeNull();
  });
});
