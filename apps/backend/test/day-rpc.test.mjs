import assert from 'node:assert/strict';
import test from 'node:test';
import { createPublicClient, defineChain } from 'viem';
import { balancedDayRpc, dayRpcUrls } from '../src/day-rpc.mjs';

const chain = defineChain({
  id: 11155111,
  name: 'Sepolia',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: ['https://a.invalid'] } },
});

test('reads rotate among endpoints and fail over without exposing API keys', async () => {
  const original = globalThis.fetch;
  const calls = [];
  let firstFails = false;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    const body = JSON.parse(init.body);
    calls.push([url, body.method]);
    if (
      firstFails &&
      url.includes('a.invalid') &&
      body.method !== 'eth_chainId'
    )
      throw new Error('endpoint down');
    return Response.json({
      jsonrpc: '2.0',
      id: body.id,
      result: body.method === 'eth_chainId' ? '0xaa36a7' : '0x7b',
    });
  };
  try {
    const client = createPublicClient({
      chain,
      transport: balancedDayRpc([
        'https://a.invalid/key-one',
        'https://b.invalid/key-two',
      ]),
    });
    await client.request({ method: 'eth_blockNumber' });
    await client.request({ method: 'eth_blockNumber' });
    firstFails = true;
    await client.request({ method: 'eth_blockNumber' });
    assert.deepEqual(
      calls
        .filter(([, method]) => method === 'eth_blockNumber')
        .map(([url]) => new URL(url).host),
      ['a.invalid', 'b.invalid', 'a.invalid', 'b.invalid'],
    );
  } finally {
    globalThis.fetch = original;
  }
});

test('wrong-chain endpoints are skipped and credentials stay out of errors', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const body = JSON.parse(init.body);
    if (String(input).includes('bad.invalid'))
      return Response.json({ jsonrpc: '2.0', id: body.id, result: '0x1' });
    return Response.json({
      jsonrpc: '2.0',
      id: body.id,
      result: body.method === 'eth_chainId' ? '0xaa36a7' : '0x2a',
    });
  };
  try {
    const client = createPublicClient({
      chain,
      transport: balancedDayRpc([
        'https://bad.invalid/private-key',
        'https://good.invalid/private-key',
      ]),
    });
    assert.equal(await client.request({ method: 'eth_blockNumber' }), '0x2a');
    const badOnly = createPublicClient({
      chain,
      transport: balancedDayRpc(['https://bad.invalid/private-key']),
    });
    await assert.rejects(
      badOnly.request({ method: 'eth_blockNumber' }),
      (error) => !String(error).includes('private-key'),
    );
  } finally {
    globalThis.fetch = original;
  }
});

test('configuration accepts additional keyed endpoints and rejects unsafe URLs', () => {
  assert.deepEqual(
    dayRpcUrls({
      DAY_RPC_URL: 'https://a.invalid/key',
      DAY_RPC_URLS: 'https://b.invalid/key, https://a.invalid/key',
    }),
    ['https://a.invalid/key', 'https://b.invalid/key'],
  );
  assert.throws(
    () => dayRpcUrls({ DAY_RPC_URL: 'file:///tmp/rpc' }),
    /Invalid RPC/,
  );
  assert.throws(
    () => dayRpcUrls({ DAY_RPC_URL: 'https://user:secret@host.invalid' }),
    /Invalid RPC/,
  );
});
