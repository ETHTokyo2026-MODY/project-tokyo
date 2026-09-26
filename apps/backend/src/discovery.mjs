import {
  decodeAbiParameters,
  encodeFunctionData,
  getAddress,
  keccak256,
  parseAbi,
  toHex,
} from 'viem';
import { namehash, normalize, packetToBytes } from 'viem/ens';

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
// ENS official Sepolia ENSv2 Beta public entrypoint and root registry.
export const SEPOLIA_ENS_V2 = {
  universalResolver: '0xeEeEEEeE14D718C2B47D9923Deab1335E144EeEe',
  rootRegistry: '0x9703dbd26dab89504490994138cf2c575251a9ce',
};
const POOL_RECORD = parseAbi(['function pool(bytes32) view returns (bytes32)']);
const UNIVERSAL = parseAbi([
  'function ROOT_REGISTRY() view returns (address)',
  'function resolve(bytes name, bytes data) view returns (bytes,address)',
]);
const RESOLVER = parseAbi([
  'function inventory() view returns (address)',
  'function parentNode() view returns (bytes32)',
  'function parentDnsHash() view returns (bytes32)',
]);
const INVENTORY = parseAbi([
  'function pools(bytes32) view returns (address supplier,uint32 startDay,uint32 endDay,uint32 capacity)',
]);
const ROUTER = parseAbi(['function inventory() view returns (address)']);
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export class DiscoveryInputError extends Error {}
export class DiscoveryNotFound extends Error {}

function reverted(error) {
  return (
    error?.name === 'ContractFunctionRevertedError' ||
    !!error?.walk?.((cause) => cause.name === 'ContractFunctionRevertedError')
  );
}

function nameParts(value) {
  if (typeof value !== 'string' || value.length > 253)
    throw new DiscoveryInputError('invalid ENS name');
  const parts = value.split('.');
  if (parts.some((label) => !LABEL.test(label)))
    throw new DiscoveryInputError('invalid ENS name');
  try {
    if (normalize(value) !== value)
      throw new DiscoveryInputError('invalid ENS name');
  } catch {
    throw new DiscoveryInputError('invalid ENS name');
  }
  return parts;
}

// Discovery returns a concrete pool before an order is signed. No name or
// resolver address appears in RentalSettlement.Order.
export class InventoryDiscovery {
  constructor(
    client,
    {
      chainId,
      universalResolver,
      rootRegistry,
      poolResolver,
      inventory,
      router,
      parentName,
    },
  ) {
    if (
      !client?.readContract ||
      !client?.getBlock ||
      !client?.getChainId ||
      !client?.getBytecode
    )
      throw new Error('Discovery client required');
    if (!Number.isSafeInteger(Number(chainId)) || Number(chainId) <= 0)
      throw new Error('Invalid discovery chain');
    this.client = client;
    this.chainId = Number(chainId);
    this.universalResolver = getAddress(universalResolver);
    this.rootRegistry = getAddress(rootRegistry);
    if (
      this.chainId === 11155111 &&
      (this.universalResolver !==
        getAddress(SEPOLIA_ENS_V2.universalResolver) ||
        this.rootRegistry !== getAddress(SEPOLIA_ENS_V2.rootRegistry))
    )
      throw new Error('Unsupported Sepolia ENSv2 deployment');
    this.poolResolver = getAddress(poolResolver);
    this.inventory = getAddress(inventory);
    this.router = getAddress(router);
    this.parentLabels = nameParts(parentName).length;
    if (this.parentLabels < 2) throw new Error('Invalid discovery parent');
    this.parentName = parentName;
    this.parentNode = namehash(parentName);
    this.parentDnsHash = keccak256(packetToBytes(parentName));
  }

  async resolve(name) {
    const parts = nameParts(name);
    if (
      parts.length !== this.parentLabels + 1 ||
      parts.slice(1).join('.') !== this.parentName
    )
      throw new DiscoveryInputError('name outside discovery parent');
    if ((await this.client.getChainId()) !== this.chainId)
      throw new Error('Discovery RPC chain mismatch');
    const block = await this.client.getBlock();
    if (block?.number === undefined || !block.hash)
      throw new Error('Discovery block unavailable');
    const at = { blockNumber: block.number };
    const [
      universalCode,
      resolverCode,
      routerCode,
      root,
      boundInventory,
      routerInventory,
      parentNode,
      parentDnsHash,
    ] = await Promise.all([
      this.client.getBytecode({ address: this.universalResolver, ...at }),
      this.client.getBytecode({ address: this.poolResolver, ...at }),
      this.client.getBytecode({ address: this.router, ...at }),
      this.client.readContract({
        address: this.universalResolver,
        abi: UNIVERSAL,
        functionName: 'ROOT_REGISTRY',
        ...at,
      }),
      this.client.readContract({
        address: this.poolResolver,
        abi: RESOLVER,
        functionName: 'inventory',
        ...at,
      }),
      this.client.readContract({
        address: this.router,
        abi: ROUTER,
        functionName: 'inventory',
        ...at,
      }),
      this.client.readContract({
        address: this.poolResolver,
        abi: RESOLVER,
        functionName: 'parentNode',
        ...at,
      }),
      this.client.readContract({
        address: this.poolResolver,
        abi: RESOLVER,
        functionName: 'parentDnsHash',
        ...at,
      }),
    ]);
    if (
      !universalCode ||
      universalCode === '0x' ||
      !resolverCode ||
      resolverCode === '0x' ||
      !routerCode ||
      routerCode === '0x' ||
      getAddress(root) !== this.rootRegistry ||
      getAddress(boundInventory) !== this.inventory ||
      getAddress(routerInventory) !== this.inventory ||
      parentNode.toLowerCase() !== this.parentNode.toLowerCase() ||
      parentDnsHash.toLowerCase() !== this.parentDnsHash.toLowerCase()
    )
      throw new Error('Discovery deployment mismatch');
    const data = encodeFunctionData({
      abi: POOL_RECORD,
      functionName: 'pool',
      args: [namehash(name)],
    });
    let answer;
    try {
      answer = await this.client.readContract({
        address: this.universalResolver,
        abi: UNIVERSAL,
        functionName: 'resolve',
        args: [toHex(packetToBytes(name)), data],
        ...at,
      });
    } catch (error) {
      if (reverted(error)) throw new DiscoveryNotFound('pool name unavailable');
      throw error;
    }
    const [encodedPool, usedResolver] = answer;
    if (getAddress(usedResolver) !== this.poolResolver)
      throw new DiscoveryNotFound('pool name uses another resolver');
    if (encodedPool.length !== 66)
      throw new Error('Invalid pool record response');
    const [pool] = decodeAbiParameters([{ type: 'bytes32' }], encodedPool);
    const [supplier, startDay, endDay, capacity] =
      await this.client.readContract({
        address: this.inventory,
        abi: INVENTORY,
        functionName: 'pools',
        args: [pool],
        ...at,
      });
    if (
      pool === `0x${'0'.repeat(64)}` ||
      getAddress(supplier) === ZERO_ADDRESS ||
      startDay >= endDay ||
      BigInt(capacity) === 0n
    )
      throw new DiscoveryNotFound('pool does not exist in inventory');
    if (
      (
        await this.client.getBlock({ blockNumber: block.number })
      ).hash?.toLowerCase() !== block.hash.toLowerCase()
    )
      throw new Error('Discovery snapshot reorganized');
    return {
      name,
      pool,
      inventory: this.inventory,
      router: this.router,
      resolver: this.poolResolver,
      blockNumber: block.number.toString(),
      blockHash: block.hash,
    };
  }

  async prepareOrder(name, draft) {
    if (
      !draft ||
      typeof draft !== 'object' ||
      Array.isArray(draft) ||
      Object.hasOwn(draft, 'pool')
    )
      throw new DiscoveryInputError('order draft must not contain a pool');
    const discovery = await this.resolve(name);
    return { discovery, order: { ...draft, pool: discovery.pool } };
  }
}
