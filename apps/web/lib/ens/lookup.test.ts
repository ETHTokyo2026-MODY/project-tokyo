import { describe, expect, it, vi } from 'vitest';
import { DAY_CHUNK } from './constants';
import { readDayMetadata } from './lookup';

describe('readDayMetadata', () => {
  it('reads rangeState in parallel pages for multicall', async () => {
    const calls: [number, number][] = [];
    const clients = {
      public: {
        readContract: vi.fn(async ({ args }: { args: [number, number] }) => {
          calls.push(args);
          return Array.from({ length: args[1] - args[0] }, () => ({
            token: '0x1',
            owner: '0x2',
            deployed: false,
            listed: true,
            saleNonce: BigInt(0),
            booked: false,
            listedPrice: BigInt(1),
            sellingPrice: BigInt(1),
          }));
        }),
      },
    };
    const days = await readDayMetadata(
      clients as never,
      '0x3',
      0,
      DAY_CHUNK * 2 + 4,
    );
    expect(days).toHaveLength(DAY_CHUNK * 2 + 4);
    expect(calls).toEqual([
      [0, DAY_CHUNK],
      [DAY_CHUNK, DAY_CHUNK * 2],
      [DAY_CHUNK * 2, DAY_CHUNK * 2 + 4],
    ]);
    expect(clients.public.readContract).toHaveBeenCalledTimes(3);
  });
});
