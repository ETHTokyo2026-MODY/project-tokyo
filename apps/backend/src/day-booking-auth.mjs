import { getAddress, zeroAddress } from 'viem';

function uint(value, bits) {
  if (!(
    (typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value)) ||
    typeof value === 'bigint' ||
    (typeof value === 'number' && Number.isSafeInteger(value))
  ))
    throw new Error('Booking values must be exact unsigned integers');
  const number = BigInt(value);
  if (number < 0n || number >= 1n << BigInt(bits))
    throw new Error('Booking integer out of range');
  return number.toString();
}

function address(value) {
  const result = getAddress(value);
  if (result === zeroAddress) throw new Error('Zero booking address');
  return result.toLowerCase();
}

/** EIP-191 plaintext, fixed field order and no trailing newline. */
export function bookingMessage(input) {
  const chainId = uint(input.chainId, 256);
  if (chainId === '0') throw new Error('Invalid booking chain');
  if (
    typeof input.eventId !== 'string' ||
    !/^[A-Za-z0-9_.:-]{1,128}$/.test(input.eventId) ||
    typeof input.booked !== 'boolean'
  )
    throw new Error('Invalid booking event');
  return [
    'ProjectTokyo booking v1',
    `chainId:${chainId}`,
    `factory:${address(input.factory)}`,
    `host:${address(input.host)}`,
    `asset:${address(input.asset)}`,
    `eventId:${input.eventId}`,
    `day:${uint(input.day, 32)}`,
    `booked:${input.booked}`,
    `expectedListedPrice:${uint(input.expectedListedPrice, 128)}`,
  ].join('\n');
}
