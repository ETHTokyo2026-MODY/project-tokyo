import {
  fixedProgram,
  hashStrategy,
  normalizeStrategy,
  ZERO_HASH,
} from '../src/protocol.mjs';
export const config = {
  chainId: 31337,
  router: '0x1111111111111111111111111111111111111111',
  aqua: '0x2222222222222222222222222222222222222222',
  usdc: '0x3333333333333333333333333333333333333333',
};
export const inventory = '0x4444444444444444444444444444444444444444';
export const buyer = '0x5555555555555555555555555555555555555555';
export const seller = '0x6666666666666666666666666666666666666666';
export const hex = (n) => `0x${BigInt(n).toString(16).padStart(64, '0')}`;
export function envelope(buy = true, price = 300n, changes = {}) {
  const strategy = normalizeStrategy(
    {
      maker: buy ? buyer : seller,
      inventory,
      ids: ['1', '2'],
      quantity: '1',
      buy,
      salt: ZERO_HASH,
      program: fixedProgram({
        usdc: config.usdc,
        inventory,
        price,
        expiry: 10000n,
        nonce: 1n,
      }),
      ...changes,
    },
    config.usdc,
  );
  return { hash: hashStrategy(strategy), strategy };
}
