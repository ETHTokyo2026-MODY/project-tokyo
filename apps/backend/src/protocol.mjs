import { encodeAbiParameters, hashTypedData, keccak256 } from 'viem';

const orderFields = [
  ['maker', 'address'],
  ['buy', 'bool'],
  ['pool', 'bytes32'],
  ['startDay', 'uint32'],
  ['endDay', 'uint32'],
  ['quantity', 'uint32'],
  ['terms', 'bytes32'],
  ['recipient', 'address'],
  ['priceLimit', 'uint256'],
  ['maxFee', 'uint256'],
  ['expiry', 'uint256'],
  ['nonce', 'uint256'],
  ['group', 'bytes32'],
  ['mandate', 'bytes32'],
  ['programHash', 'bytes32'],
].map(([name, type]) => ({ name, type }));
const mandateFields = [
  ['buyer', 'address'],
  ['app', 'address'],
  ['token', 'address'],
  ['limit', 'uint256'],
  ['expiry', 'uint256'],
  ['salt', 'bytes32'],
].map(([name, type]) => ({ name, type }));
const tuple = (name, components) => ({ name, type: 'tuple', components });
const bytes32 = (name, indexed = false) => ({ name, type: 'bytes32', indexed });
const address = (name, indexed = false) => ({ name, type: 'address', indexed });
const uint256 = (name) => ({ name, type: 'uint256' });

// The settle tuple is the sole source for EIP-712 Order fields.
export const routerAbi = [
  {
    type: 'function',
    name: 'settle',
    stateMutability: 'nonpayable',
    inputs: [
      tuple('bid', orderFields),
      { name: 'bidSig', type: 'bytes' },
      tuple('ask', orderFields),
      { name: 'askSig', type: 'bytes' },
      tuple('m', mandateFields),
      { name: 'program', type: 'bytes' },
    ],
    outputs: [uint256('price'), uint256('fee')],
  },
  {
    type: 'function',
    name: 'quote',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'program', type: 'bytes' }, uint256('units')],
    outputs: [uint256('price'), uint256('fee')],
  },
  {
    type: 'function',
    name: 'quote',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'program', type: 'bytes' },
      uint256('durationDays'),
      uint256('quantity'),
    ],
    outputs: [uint256('price'), uint256('fee')],
  },
  {
    type: 'function',
    name: 'hashOrder',
    stateMutability: 'view',
    inputs: [tuple('o', orderFields)],
    outputs: [bytes32('')],
  },
  {
    type: 'function',
    name: 'hashMandate',
    stateMutability: 'pure',
    inputs: [tuple('m', mandateFields)],
    outputs: [bytes32('')],
  },
  {
    type: 'function',
    name: 'used',
    stateMutability: 'view',
    inputs: [address('maker'), uint256('nonce')],
    outputs: [{ name: '', type: 'bool' }],
  },
  {
    type: 'function',
    name: 'closedGroup',
    stateMutability: 'view',
    inputs: [address('maker'), bytes32('group')],
    outputs: [{ name: '', type: 'bool' }],
  },
  {
    type: 'function',
    name: 'usdc',
    stateMutability: 'view',
    inputs: [],
    outputs: [address('')],
  },
  {
    type: 'event',
    name: 'Cancelled',
    inputs: [address('maker', true), { ...uint256('nonce'), indexed: false }],
  },
  {
    type: 'event',
    name: 'GroupClosed',
    inputs: [address('maker', true), bytes32('group', false)],
  },
  {
    type: 'event',
    name: 'Settled',
    inputs: [
      bytes32('buyHash', true),
      bytes32('sellHash', true),
      bytes32('mandate', true),
      uint256('price'),
      uint256('fee'),
    ],
  },
];

export const orderTypes = {
  Order: routerAbi[0].inputs[0].components.map(({ name, type }) => ({
    name,
    type,
  })),
};
export const orderDomain = ({ chainId, router }) => ({
  name: 'RentalSettlement',
  version: '1',
  chainId: Number(chainId),
  verifyingContract: router,
});
export const hashOrder = (order, config) =>
  hashTypedData({
    domain: orderDomain(config),
    types: orderTypes,
    primaryType: 'Order',
    message: order,
  });
export const hashMandate = (mandate) =>
  keccak256(
    encodeAbiParameters(
      [tuple('m', routerAbi[0].inputs[4].components)],
      [mandate],
    ),
  );

export const ZERO_HASH = `0x${'0'.repeat(64)}`;
