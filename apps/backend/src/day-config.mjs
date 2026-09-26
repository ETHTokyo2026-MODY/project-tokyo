import { getAddress, zeroAddress } from 'viem';
import { transactionGasLimit } from './day-taker.mjs';
export function integer(value, fallback, minimum = 0) {
  const input = value ?? fallback;
  if (!(
    (typeof input === 'number' && Number.isSafeInteger(input)) ||
    (typeof input === 'string' && /^(0|[1-9][0-9]*)$/.test(input))
  ))
    throw new Error('Invalid runtime integer');
  const result = Number(input);
  if (!Number.isSafeInteger(result) || result < minimum)
    throw new Error('Invalid runtime integer');
  return result;
}
export function normalize(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config))
    throw new Error('Runtime deployment configuration required');
  const result = {
    chainId: integer(config.chainId, undefined, 1),
    startBlock: integer(config.startBlock),
    confirmations: integer(config.confirmations, 2),
    maxFills: integer(config.maxFills, 1, 1),
    transactionGasLimit: Number(
      transactionGasLimit(config.transactionGasLimit),
    ),
  };
  for (const key of ['factory', 'router', 'aqua', 'usdc']) {
    result[key] = getAddress(config[key]);
    if (result[key] === zeroAddress)
      throw new Error('Runtime deployment address is zero');
  }
  if (config.conversion != null) {
    const conversion = {
      poolFee: integer(config.conversion.poolFee, undefined, 1),
    };
    if (conversion.poolFee >= 2 ** 24)
      throw new Error('Invalid conversion pool fee');
    for (const key of ['converter', 'sourceToken', 'swapRouter']) {
      conversion[key] = getAddress(config.conversion[key]);
      if (conversion[key] === zeroAddress)
        throw new Error('Conversion address is zero');
    }
    result.conversion = conversion;
  }
  return result;
}
