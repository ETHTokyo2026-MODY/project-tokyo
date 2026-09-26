import assert from 'node:assert/strict';
import test from 'node:test';
import {
  decodeFunctionData,
  encodeAbiParameters,
  getAddress,
  keccak256,
  parseAbi,
  toHex,
} from 'viem';
import { namehash, packetToBytes } from 'viem/ens';
import { resolveDayName, SEPOLIA_ENS_V2 } from '../src/day-names.mjs';
import { createDayServer } from '../src/day-server.mjs';

const address = (n) => getAddress(`0x${n.toString(16).padStart(40, '0')}`);
const hash = `0x${'ab'.repeat(32)}`;
const parentName = 'rental-proof-73e27831.eth';
const assetName = `car.${parentName}`;
const dayName = `2026-09-27.${assetName}`;
function fixture() {
  const config = {
    chainId: 11155111,
    factory: address(1),
    router: address(2),
    aqua: address(3),
    usdc: address(4),
    ens: { parentName, resolver: address(5) },
  };
  const f = {
    config,
    asset: address(6),
    token: address(7),
    calls: [],
    blockReads: 0,
    reorg: false,
    code: '0x',
  };
  const assetDns = toHex(packetToBytes(assetName)),
    dayDns = toHex(packetToBytes(dayName));
  f.client = {
    getChainId: async () => 11155111,
    getBlock: async () => ({
      number: 10n,
      hash: f.reorg && f.blockReads++ > 0 ? `0x${'cd'.repeat(32)}` : hash,
    }),
    getBytecode: async (call) => {
      f.calls.push(call);
      return f.code;
    },
    readContract: async (call) => {
      f.calls.push(call);
      if (call.functionName === 'resolve') {
        assert.equal(call.address, SEPOLIA_ENS_V2.universalResolver);
        const dns = call.args[0];
        assert.ok(dns === assetDns || dns === dayDns);
        const query = decodeFunctionData({
          abi: parseAbi(['function addr(bytes32) view returns(address)']),
          data: call.args[1],
        });
        assert.equal(
          query.args[0],
          namehash(dns === assetDns ? assetName : dayName),
        );
        return [
          encodeAbiParameters(
            [{ type: 'address' }],
            [dns === assetDns ? f.asset : f.token],
          ),
          f.usedResolver ?? config.ens.resolver,
        ];
      }
      if (call.functionName === 'tokenAddress') {
        assert.equal(call.address, f.asset);
        assert.deepEqual(call.args, [20723]);
        return f.expectedToken ?? f.token;
      }
      const result = {
        ROOT_REGISTRY: SEPOLIA_ENS_V2.rootRegistry,
        factory: config.factory,
        parentNode: namehash(parentName),
        parentDnsHash: keccak256(packetToBytes(parentName)),
        supportsInterface: true,
        FACTORY: config.factory,
        AQUA: config.aqua,
        USDC: config.usdc,
        isAsset: true,
        ...f.override,
      };
      assert.ok(call.functionName in result);
      return result[call.functionName];
    },
  };
  return f;
}

test('canonical Universal Resolver returns concrete asset and undeployed day addresses at one block', async () => {
  const f = fixture();
  const asset = await resolveDayName(f.client, f.config, assetName);
  assert.equal(asset.asset, f.asset);
  assert.equal(asset.address, f.asset);
  assert.equal(asset.day, null);
  const day = await resolveDayName(f.client, f.config, dayName);
  assert.deepEqual(day, {
    name: dayName,
    assetName,
    chainId: 11155111,
    asset: f.asset,
    day: 20723,
    address: f.token,
    deployed: false,
    resolver: f.config.ens.resolver,
    blockNumber: '10',
    blockHash: hash,
  });
  assert.ok(f.calls.every((call) => call.blockNumber === 10n));
  f.code = '0x1234';
  const materialized = await resolveDayName(f.client, f.config, dayName);
  assert.equal(materialized.address, day.address);
  assert.equal(materialized.deployed, true);
});

test('alias remapping returns new addresses without mutating the prior concrete result', async () => {
  const f = fixture();
  const first = await resolveDayName(f.client, f.config, dayName);
  f.asset = address(20);
  f.token = address(21);
  const next = await resolveDayName(f.client, f.config, dayName);
  assert.equal(first.asset, address(6));
  assert.equal(first.address, address(7));
  assert.equal(next.asset, address(20));
  assert.equal(next.address, address(21));
});

test('rejects a different resolver, foreign factory, wrong deployment or noncanonical token', async () => {
  for (const override of [
    { ROOT_REGISTRY: address(90) },
    { factory: address(90) },
    { FACTORY: address(90) },
    { AQUA: address(90) },
    { USDC: address(90) },
    { parentNode: `0x${'00'.repeat(32)}` },
    { parentDnsHash: `0x${'00'.repeat(32)}` },
    { supportsInterface: false },
    { isAsset: false },
  ]) {
    const f = fixture();
    f.override = override;
    await assert.rejects(resolveDayName(f.client, f.config, dayName));
  }
  const f = fixture();
  f.usedResolver = address(99);
  await assert.rejects(
    resolveDayName(f.client, f.config, dayName),
    /Unexpected ENS resolver/,
  );
  delete f.usedResolver;
  f.expectedToken = address(99);
  await assert.rejects(
    resolveDayName(f.client, f.config, dayName),
    /canonical token/,
  );
  f.config.ens.universalResolver = address(99);
  await assert.rejects(
    resolveDayName(f.client, f.config, dayName),
    /Unsupported Sepolia/,
  );
});

test('rejects invalid names and dates before any RPC request', async () => {
  const f = fixture();
  for (const name of [
    parentName,
    `Car.${parentName}`,
    `other.car.${parentName}`,
    `2026-02-29.${assetName}`,
    `2026-9-27.${assetName}`,
    `2026-09-31.${assetName}`,
    `1969-12-31.${assetName}`,
    `2026-09-27.extra.${assetName}`,
    'car.attacker.eth',
    `car.${parentName}.attacker.eth`,
  ]) {
    await assert.rejects(resolveDayName(f.client, f.config, name));
  }
  assert.equal(f.calls.length, 0);
});

test('wrong chain and a reorg cannot return a named trading target', async () => {
  const f = fixture();
  f.client.getChainId = async () => 1;
  await assert.rejects(
    resolveDayName(f.client, f.config, dayName),
    /chain mismatch/,
  );
  f.client.getChainId = async () => 11155111;
  f.reorg = true;
  await assert.rejects(
    resolveDayName(f.client, f.config, dayName),
    /reorganized/,
  );
});

test('HTTP resolve exposes verified canonical addresses and is disabled without ENS configuration', async () => {
  const f = fixture();
  async function request(config, path) {
    const server = createDayServer({ client: f.client, config });
    let status;
    const response = await new Promise((resolve) => {
      server.emit(
        'request',
        { method: 'GET', url: path },
        {
          writeHead(code) {
            status = code;
          },
          end(body) {
            resolve({ status, body: JSON.parse(body) });
          },
        },
      );
    });
    await server.drain();
    return response;
  }
  const resolved = await request(f.config, `/resolve?name=${dayName}`);
  assert.equal(resolved.status, 200);
  assert.equal(resolved.body.asset, f.asset);
  assert.equal(resolved.body.address, f.token);
  assert.equal(resolved.body.day, 20723);
  assert.deepEqual((await request(f.config, '/config')).body.ens, f.config.ens);
  assert.equal(
    (await request({ ...f.config, ens: undefined }, `/resolve?name=${dayName}`))
      .status,
    503,
  );
  assert.equal(
    (await request({ ...f.config, ens: undefined }, '/config')).body.ens,
    null,
  );
  assert.equal(
    (await request(f.config, '/resolve?name=car.attacker.eth')).status,
    400,
  );
});
