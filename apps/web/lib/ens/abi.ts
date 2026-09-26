import { parseAbi, parseAbiItem } from 'viem';

export const labelRegistered = parseAbiItem(
  'event LabelRegistered(uint256 indexed tokenId, bytes32 indexed labelHash, string label, address owner, uint64 expiry, address indexed sender)',
);

export const registryAbi = parseAbi([
  'function getSubregistry(string label) view returns (address)',
  'function getResolver(string label) view returns (address)',
  'function setSubregistry(uint256 anyId, address registry)',
  'function setResolver(uint256 anyId, address resolver)',
  'function ownerOf(uint256 tokenId) view returns (address)',
]);

export const urAbi = parseAbi([
  'function ROOT_REGISTRY() view returns (address)',
  'function resolve(bytes name, bytes data) view returns (bytes, address)',
  'function findResolver(bytes name) view returns (address, bytes32, uint256)',
]);

export const factoryAbi = parseAbi([
  'function createAsset(bytes32 hostSalt, string metadataURI, (uint128 minimum, uint128[7] listedPrices, uint128[7] sellingPrices) defaults, (uint16 minDays, uint16 discountBps)[] discounts) returns (address asset)',
  'function assets(address host, bytes32 hostSalt) view returns (address)',
  'function isAsset(address asset) view returns (bool)',
  'function dayTokenImplementation() view returns (address)',
]);

export const rentalAssetAbi = [
  {
    type: 'function',
    name: 'host',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'address' }],
  },
  {
    type: 'function',
    name: 'startDay',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint32' }],
  },
  {
    type: 'function',
    name: 'endDayExclusive',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint32' }],
  },
  {
    type: 'function',
    name: 'tokenAddress',
    stateMutability: 'view',
    inputs: [{ name: 'day', type: 'uint32' }],
    outputs: [{ type: 'address' }],
  },
  {
    type: 'function',
    name: 'metadataURI',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'string' }],
  },
  {
    type: 'function',
    name: 'materialize',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'day', type: 'uint32' }],
    outputs: [{ type: 'address' }],
  },
  {
    type: 'function',
    name: 'setListing',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'start', type: 'uint32' },
      { name: 'endExclusive', type: 'uint32' },
      { name: 'listed', type: 'bool' },
      { name: 'sellingPrice', type: 'uint128' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'dayState',
    stateMutability: 'view',
    inputs: [{ name: 'day', type: 'uint32' }],
    outputs: [
      {
        name: 'state',
        type: 'tuple',
        components: [
          { name: 'token', type: 'address' },
          { name: 'owner', type: 'address' },
          { name: 'deployed', type: 'bool' },
          { name: 'listed', type: 'bool' },
          { name: 'saleNonce', type: 'uint64' },
          { name: 'booked', type: 'bool' },
          { name: 'listedPrice', type: 'uint128' },
          { name: 'sellingPrice', type: 'uint128' },
        ],
      },
    ],
  },
  {
    type: 'function',
    name: 'rangeState',
    stateMutability: 'view',
    inputs: [
      { name: 'start', type: 'uint32' },
      { name: 'endExclusive', type: 'uint32' },
    ],
    outputs: [
      {
        name: 'states',
        type: 'tuple[]',
        components: [
          { name: 'token', type: 'address' },
          { name: 'owner', type: 'address' },
          { name: 'deployed', type: 'bool' },
          { name: 'listed', type: 'bool' },
          { name: 'saleNonce', type: 'uint64' },
          { name: 'booked', type: 'bool' },
          { name: 'listedPrice', type: 'uint128' },
          { name: 'sellingPrice', type: 'uint128' },
        ],
      },
    ],
  },
] as const;

export const dayTokenAbi = parseAbi([
  'function transfer(address to, uint256 value) returns (bool)',
  'function owner() view returns (address)',
  'function balanceOf(address account) view returns (uint256)',
  'function totalSupply() view returns (uint256)',
]);

export const namesAbi = parseAbi([
  'constructor(address ensFactory_, address userRegistryImpl_, address permissionedResolverImpl_, address ethRegistry_, string parentLabel_, address rentalFactory_)',
  'function assetRegistry() view returns (address)',
  'function parentDns() view returns (bytes)',
  'function parentLabel() view returns (string)',
  'function rentalFactory() view returns (address)',
  'function assetOf(string label) view returns (address)',
  'function linkParent()',
  'function registerAsset(string label, address rentalAsset) returns (address dayRegistry, address resolver)',
  'function registerDays(string label, uint32 startDay, uint32 endDay)',
  'function setAssetTexts(string label, string[] keys, string[] values)',
  'function dateLabel(uint32 day) pure returns (string)',
  'function parseDateLabel(string label) pure returns (uint32)',
  'function dayRegistryOf(bytes32 labelHash) view returns (address)',
  'function assetResolverOf(bytes32 labelHash) view returns (address)',
  'function assetOfLabel(bytes32 labelHash) view returns (address)',
]);

export const resolverAbi = parseAbi([
  'function setText(bytes name, string key, string value)',
  'function text(bytes32 node, string key) view returns (string)',
  'function addr(bytes32 node) view returns (address)',
]);
