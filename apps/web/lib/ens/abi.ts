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

export const inventoryAbi = parseAbi([
  'function administrator() view returns (address)',
  'function names() view returns (address)',
  'function setNames(address n)',
  'function createAsset(string label, address host, string kind, string title, string location) returns (bytes32 pool, uint32 startDay, uint32 endDay)',
  'function mintDays(bytes32 pool, uint32 start, uint32 end, uint128 listedPrice, uint128 sellingPrice)',
  'function setListing(uint256 id, bool listed, uint128 sellingPrice)',
  'function setListedPrice(uint256 id, uint128 listedPrice)',
  'function setBooked(uint256 id, bool booked)',
  'function tokenId(bytes32 pool, uint32 day) pure returns (uint256)',
  'function dayInfo(uint256 id) view returns (bool minted, bool booked, bool listed, uint128 listedPrice, uint128 sellingPrice)',
  'function holderOf(uint256 id) view returns (address)',
  'function assetHost(bytes32 pool) view returns (address)',
  'function assetInfo(bytes32 pool) view returns (address host, uint32 startDay, uint32 endDay, string label, string kind, string title, string location)',
  'function isAsset(bytes32 pool) view returns (bool)',
  'function currentDay() view returns (uint32)',
  'function safeTransferFrom(address from, address to, uint256 id, uint256 value, bytes data)',
  'function balanceOf(address account, uint256 id) view returns (uint256)',
  'function setApprovalForAll(address operator, bool approved)',
]);

export const namesAbi = parseAbi([
  'constructor(address inventory_, address factory_, address userRegistryImpl_, address permissionedResolverImpl_, address ethRegistry_, string parentLabel_)',
  'function assetRegistry() view returns (address)',
  'function parentDns() view returns (bytes)',
  'function parentLabel() view returns (string)',
  'function inventory() view returns (address)',
  'function linkParent()',
  'function registerAsset(string label, bytes32 pool, address host) returns (address dayRegistry, address resolver)',
  'function registerDays(bytes32 pool, uint32 startDay, uint32 endDay)',
  'function setAssetTexts(string label, string[] keys, string[] values)',
  'function dateLabel(uint32 day) pure returns (string)',
  'function parseDateLabel(string label) pure returns (uint32)',
  'function dayRegistryOf(bytes32 pool) view returns (address)',
  'function assetResolverOf(bytes32 pool) view returns (address)',
  'function poolOfLabel(bytes32 labelHash) view returns (bytes32)',
]);

export const resolverAbi = parseAbi([
  'function setText(bytes name, string key, string value)',
  'function text(bytes32 node, string key) view returns (string)',
  'function addr(bytes32 node) view returns (address)',
]);
