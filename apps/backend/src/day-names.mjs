import {
  decodeAbiParameters,
  encodeFunctionData,
  getAddress,
  keccak256,
  parseAbi,
  toHex,
} from 'viem';
import { namehash, normalize, packetToBytes } from 'viem/ens';
import { dayFactoryAbi, dayRouterAbi } from './day-protocol.mjs';

export const SEPOLIA_ENS_V2 = {
  universalResolver: '0xeEeEEEeE14D718C2B47D9923Deab1335E144EeEe',
  rootRegistry: '0x9703DBD26dAB89504490994138cF2c575251a9cE',
};
export const dayNameResolverAbi = parseAbi([
  'function factory() view returns (address)',
  'function parentNode() view returns (bytes32)',
  'function parentDnsHash() view returns (bytes32)',
  'function supportsInterface(bytes4) view returns (bool)',
  'function setAsset(string label,address asset)',
  'function resolve(bytes name,bytes data) view returns (bytes)',
]);
const universalAbi = parseAbi([
  'function ROOT_REGISTRY() view returns (address)',
  'function resolve(bytes name,bytes data) view returns (bytes,address)',
]);
const addrAbi = parseAbi([
  'function addr(bytes32 node) view returns (address)',
]);
const tokenAddressAbi = parseAbi([
  'function tokenAddress(uint32 day) view returns (address)',
]);
const same = (a, b) => a?.toLowerCase() === b?.toLowerCase();
const label = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** Read through the canonical ENSv2 Universal Resolver and freeze concrete trading addresses. */
export async function resolveDayName(client, config, name) {
  const ens = config.ens;
  if (!ens?.parentName || !ens.resolver)
    throw new Error('ENS discovery is not configured');
  if (
    typeof name !== 'string' ||
    name.length > 253 ||
    normalize(name) !== name ||
    !name.endsWith(`.${ens.parentName}`) ||
    ens.parentName.split('.').some((part) => !label.test(part))
  )
    throw new Error('Invalid day name');
  const parts = name.slice(0, -ens.parentName.length - 1).split('.');
  if (parts.length < 1 || parts.length > 2 || !label.test(parts.at(-1)))
    throw new Error('Invalid day name');
  let day = null;
  if (parts.length === 2) {
    const date = parts[0];
    const milliseconds = Date.parse(`${date}T00:00:00.000Z`);
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
      !Number.isFinite(milliseconds) ||
      milliseconds < 0 ||
      new Date(milliseconds).toISOString().slice(0, 10) !== date
    )
      throw new Error('Invalid day date');
    day = milliseconds / 86400000;
  }
  const chainId = Number(config.chainId);
  if ((await client.getChainId()) !== chainId)
    throw new Error('ENS RPC chain mismatch');
  const universal = getAddress(
    ens.universalResolver ?? SEPOLIA_ENS_V2.universalResolver,
  );
  const root = getAddress(ens.rootRegistry ?? SEPOLIA_ENS_V2.rootRegistry);
  const resolver = getAddress(ens.resolver);
  if (
    chainId === 11155111 &&
    (!same(universal, SEPOLIA_ENS_V2.universalResolver) ||
      !same(root, SEPOLIA_ENS_V2.rootRegistry))
  )
    throw new Error('Unsupported Sepolia ENSv2 deployment');
  const block = await client.getBlock();
  if (block.number == null || !block.hash)
    throw new Error('Missing canonical block');
  const read = (address, abi, functionName, args = []) =>
    client.readContract({
      address,
      abi,
      functionName,
      args,
      blockNumber: block.number,
    });
  const [
    actualRoot,
    factory,
    parentNode,
    parentDnsHash,
    extended,
    routerFactory,
    aqua,
    usdc,
  ] = await Promise.all([
    read(universal, universalAbi, 'ROOT_REGISTRY'),
    read(resolver, dayNameResolverAbi, 'factory'),
    read(resolver, dayNameResolverAbi, 'parentNode'),
    read(resolver, dayNameResolverAbi, 'parentDnsHash'),
    read(resolver, dayNameResolverAbi, 'supportsInterface', ['0x9061b923']),
    read(config.router, dayRouterAbi, 'FACTORY'),
    read(config.router, dayRouterAbi, 'AQUA'),
    read(config.router, dayRouterAbi, 'USDC'),
  ]);
  if (
    !same(actualRoot, root) ||
    !same(factory, config.factory) ||
    !same(routerFactory, config.factory) ||
    !same(aqua, config.aqua) ||
    !same(usdc, config.usdc) ||
    !extended ||
    !same(parentNode, namehash(ens.parentName)) ||
    !same(parentDnsHash, keccak256(packetToBytes(ens.parentName)))
  )
    throw new Error('ENS deployment mismatch');
  const resolve = async (value) => {
    const [encoded, usedResolver] = await read(
      universal,
      universalAbi,
      'resolve',
      [
        toHex(packetToBytes(value)),
        encodeFunctionData({
          abi: addrAbi,
          functionName: 'addr',
          args: [namehash(value)],
        }),
      ],
    );
    if (!same(usedResolver, resolver) || encoded.length !== 66)
      throw new Error('Unexpected ENS resolver or address record');
    const [address] = decodeAbiParameters([{ type: 'address' }], encoded);
    return getAddress(address);
  };
  const assetName = `${parts.at(-1)}.${ens.parentName}`;
  const asset = await resolve(assetName);
  if (!(await read(config.factory, dayFactoryAbi, 'isAsset', [asset])))
    throw new Error('Unknown named asset');
  const address = day === null ? asset : await resolve(name);
  if (
    day !== null &&
    !same(address, await read(asset, tokenAddressAbi, 'tokenAddress', [day]))
  )
    throw new Error('Named day does not match canonical token');
  const code = await client.getBytecode({ address, blockNumber: block.number });
  if (
    !same(
      (await client.getBlock({ blockNumber: block.number })).hash,
      block.hash,
    )
  )
    throw new Error('ENS snapshot reorganized');
  return {
    name,
    assetName,
    chainId,
    asset,
    day,
    address,
    deployed: Boolean(code && code !== '0x'),
    resolver,
    blockNumber: block.number.toString(),
    blockHash: block.hash,
  };
}
