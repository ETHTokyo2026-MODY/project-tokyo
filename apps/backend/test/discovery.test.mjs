import assert from 'node:assert/strict';
import { test } from 'node:test';
import { encodeAbiParameters, keccak256, toHex } from 'viem';
import { rentalStrategy, ZERO_HASH } from '../src/protocol.mjs';
import { namehash, packetToBytes } from 'viem/ens';
import {
  DiscoveryInputError,
  DiscoveryNotFound,
  InventoryDiscovery,
  SEPOLIA_ENS_V2,
} from '../src/discovery.mjs';

const config = {
  chainId: 31337,
  universalResolver: '0x1111111111111111111111111111111111111111',
  rootRegistry: '0x2222222222222222222222222222222222222222',
  poolResolver: '0x3333333333333333333333333333333333333333',
  inventory: '0x4444444444444444444444444444444444444444',
  router: '0x6666666666666666666666666666666666666666',
  aqua: '0x7777777777777777777777777777777777777777',
  usdc: '0x8888888888888888888888888888888888888888',
  parentName: 'rental-proof.eth',
};
const name = `demo-room.${config.parentName}`;
const pool = keccak256(toHex('demo room'));
const block = { number: 42n, hash: `0x${'aa'.repeat(32)}` };

function fixture() {
  const calls = [];
  const client = {
    getChainId: async () => config.chainId,
    getBlock: async () => block,
    getBytecode: async (request) => {
      calls.push(request);
      return '0x6000';
    },
    readContract: async (request) => {
      calls.push(request);
      switch (request.functionName) {
        case 'AQUA':
          return config.aqua;
        case 'USDC':
          return config.usdc;
        case 'ROOT_REGISTRY':
          return config.rootRegistry;
        case 'inventory':
          return config.inventory;
        case 'parentNode':
          return namehash(config.parentName);
        case 'parentDnsHash':
          return keccak256(packetToBytes(config.parentName));
        case 'resolve':
          return [
            encodeAbiParameters([{ type: 'bytes32' }], [pool]),
            config.poolResolver,
          ];
        case 'pools':
          return [
            '0x5555555555555555555555555555555555555555',
            40000,
            40010,
            1,
          ];
        default:
          throw new Error('unexpected contract read');
      }
    },
  };
  return { discovery: new InventoryDiscovery(client, config), client, calls };
}

test('resolves a wildcard ENS name to a fixed pool before signing', async () => {
  const { discovery, calls } = fixture();
  const result = await discovery.prepareStrategy(name, {
    maker: config.inventory,
    startDay: 40000,
    endDay: 40001,
    terms: pool,
    quantity: 1,
    buy: true,
    price: 100,
    expiry: 10000,
    nonce: 1,
    salt: ZERO_HASH,
  });
  assert.equal(result.strategy.ids.length, 1);
  assert.equal(result.strategy.inventory, config.inventory);
  assert.equal(result.strategy.maker, config.inventory);
  assert.equal(result.discovery.blockHash, block.hash);
  assert.equal(result.discovery.resolver, config.poolResolver);
  assert.equal(result.discovery.router, config.router);
  const universalCall = calls.find((call) => call.functionName === 'resolve');
  assert.equal(universalCall.address, config.universalResolver);
  assert.equal(universalCall.blockNumber, 42n);
  assert.equal(universalCall.args[0], toHex(packetToBytes(name)));
  assert.equal(universalCall.args[1].slice(10), namehash(name).slice(2));
  assert.ok(calls.every((call) => call.blockNumber === 42n));
  await assert.rejects(
    discovery.prepareStrategy(name, { pool }),
    DiscoveryInputError,
  );
});

test('rejects malformed or out-of-parent names before any RPC call', async () => {
  const { discovery, calls } = fixture();
  for (const invalid of [
    'Demo-room.rental-proof.eth',
    'demo-room.other.eth',
    'extra.demo-room.rental-proof.eth',
    'demo_room.rental-proof.eth',
    `room..${config.parentName}`,
  ])
    await assert.rejects(discovery.resolve(invalid), DiscoveryInputError);
  assert.deepEqual(calls, []);
});

test('rejects resolver override, unknown pool, wrong deployment and reorg', async () => {
  const { discovery, client } = fixture();
  const originalRead = client.readContract;
  client.readContract = async (request) =>
    request.functionName === 'resolve'
      ? [encodeAbiParameters([{ type: 'bytes32' }], [pool]), config.inventory]
      : originalRead(request);
  await assert.rejects(discovery.resolve(name), DiscoveryNotFound);
  client.readContract = async (request) =>
    request.functionName === 'pools'
      ? ['0x0000000000000000000000000000000000000000', 0, 0, 0]
      : originalRead(request);
  await assert.rejects(discovery.resolve(name), DiscoveryNotFound);
  client.readContract = async (request) =>
    request.functionName === 'parentNode'
      ? `0x${'99'.repeat(32)}`
      : originalRead(request);
  await assert.rejects(discovery.resolve(name), /deployment mismatch/);
  client.readContract = originalRead;
  client.readContract = async (request) =>
    request.functionName === 'AQUA' && request.address === config.router
      ? '0x9999999999999999999999999999999999999999'
      : originalRead(request);
  await assert.rejects(
    discovery.prepareStrategy(name, {}),
    /deployment mismatch/,
  );
  client.readContract = originalRead;
  client.getBlock = async (request) =>
    request?.blockNumber ? { ...block, hash: `0x${'bb'.repeat(32)}` } : block;
  await assert.rejects(discovery.resolve(name), /snapshot reorganized/);
  client.getChainId = async () => 1;
  await assert.rejects(discovery.resolve(name), /chain mismatch/);
});

test('surfaces RPC failures and treats contract rejection as unknown name', async () => {
  const { discovery, client } = fixture();
  const originalRead = client.readContract;
  client.readContract = async (request) => {
    if (request.functionName === 'resolve') {
      const error = new Error('UnknownPool');
      error.name = 'ContractFunctionRevertedError';
      throw error;
    }
    return originalRead(request);
  };
  await assert.rejects(discovery.resolve(name), DiscoveryNotFound);
  client.readContract = async (request) => {
    if (request.functionName === 'resolve') throw new Error('RPC unavailable');
    return originalRead(request);
  };
  await assert.rejects(discovery.resolve(name), /RPC unavailable/);
});

test('Sepolia discovery pins the official public ENSv2 deployment', () => {
  const { client } = fixture();
  assert.throws(
    () => new InventoryDiscovery(client, { ...config, chainId: 11155111 }),
    /Unsupported Sepolia ENSv2 deployment/,
  );
  const official = new InventoryDiscovery(client, {
    ...config,
    chainId: 11155111,
    ...SEPOLIA_ENS_V2,
  });
  assert.equal(
    official.rootRegistry.toLowerCase(),
    SEPOLIA_ENS_V2.rootRegistry,
  );
});
