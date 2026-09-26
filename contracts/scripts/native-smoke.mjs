// Aqua — © Degensoft Ltd 2025. SwapVM — © Degensoft Ltd 2025.
// SPDX-License-Identifier: LicenseRef-Degensoft-Aqua-Source-1.1 AND LicenseRef-Degensoft-SwapVM-1.1
// Isolated local transactions: no public RPC, persistent keys, or funded wallets.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import net from 'node:net';
import {
  createPublicClient,
  createWalletClient,
  http,
  encodeAbiParameters,
  concatHex,
  toHex,
  keccak256,
} from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { foundry } from 'viem/chains';

const artifact = (name) =>
  JSON.parse(
    readFileSync(new URL(`../out/${name}.sol/${name}.json`, import.meta.url)),
  );
const port = await new Promise((resolve, reject) => {
  const s = net.createServer();
  s.on('error', reject);
  s.listen(0, '127.0.0.1', () => {
    const p = s.address().port;
    s.close(() => resolve(p));
  });
});
const anvil = spawn(
  'anvil',
  ['--host', '127.0.0.1', '--port', String(port), '--silent'],
  { stdio: 'ignore' },
);
let spawnError;
anvil.on('error', (e) => {
  spawnError = e;
});
const transport = http(`http://127.0.0.1:${port}`, { retryCount: 0 });
const client = createPublicClient({
  chain: foundry,
  transport,
  pollingInterval: 10,
});
const wallets = Array.from({ length: 3 }, () =>
  createWalletClient({
    chain: foundry,
    transport,
    account: privateKeyToAccount(generatePrivateKey()),
  }),
);
const [host, buyer, other] = wallets;
const USD = 1_000_000n;
let salt = 0n;
try {
  for (let i = 0; ; ++i) {
    if (spawnError) throw spawnError;
    try {
      await client.getChainId();
      break;
    } catch (e) {
      if (i >= 100) throw e;
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  for (const w of wallets)
    await client.request({
      method: 'anvil_setBalance',
      params: [w.account.address, toHex(100n * 10n ** 18n)],
    });
  async function receipt(hash) {
    const r = await client.waitForTransactionReceipt({ hash });
    assert.equal(r.status, 'success');
    return r;
  }
  async function deploy(name, args = [], file = name) {
    const a =
      file === name
        ? artifact(name)
        : JSON.parse(
            readFileSync(
              new URL(`../out/${file}.sol/${name}.json`, import.meta.url),
            ),
          );
    const r = await receipt(
      await host.deployContract({
        abi: a.abi,
        bytecode: a.bytecode.object,
        args,
      }),
    );
    return { address: r.contractAddress, abi: a.abi };
  }
  const write = async (w, c, functionName, args) =>
    receipt(await w.writeContract({ ...c, functionName, args }));
  const read = (c, functionName, args) =>
    client.readContract({ ...c, functionName, args });
  const usd = await deploy('ProofUSDC', [], 'NativeAqua.t');
  const inventory = await deploy('RentalInventory');
  const aqua = await deploy('AquaVapor');
  const router = await deploy('AssetSwapVM', [aqua.address, usd.address]);
  for (const w of [buyer, other]) {
    await write(host, usd, 'mint', [w.account.address, 10000n * USD]);
    await write(w, usd, 'approve', [aqua.address, 2n ** 256n - 1n]);
  }
  await write(host, inventory, 'setApprovalForAll', [aqua.address, true]);
  const day = Number((await client.getBlock()).timestamp / 86400n) + 10;
  const pool = keccak256(toHex('native inventory'));
  const terms = keccak256(toHex('supplier terms'));
  await write(host, inventory, 'createPool', [
    pool,
    host.account.address,
    day,
    day + 400,
    1,
  ]);
  const strategyType = router.abi.find(
    (x) => x.type === 'function' && x.name === 'hash',
  ).inputs;
  function program(price, n = 1n) {
    const [a, b] =
      BigInt(usd.address) < BigInt(inventory.address) ? [price, n] : [n, price];
    return concatHex([
      '0x9040',
      encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }], [a, b]),
      '0x5401',
      BigInt(usd.address) < BigInt(inventory.address) ? '0x80' : '0x00',
    ]);
  }
  const make = (wallet, buy, ids, price) => ({
    maker: wallet.account.address,
    inventory: inventory.address,
    ids: [...ids].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
    quantity: 1n,
    buy,
    salt: toHex(++salt, { size: 32 }),
    program: program(price),
  });
  async function ship(wallet, s, budget = 0n) {
    const assets = s.buy
      ? [{ kind: 0, token: usd.address, id: 0n }]
      : s.ids.map((id) => ({ kind: 1, token: inventory.address, id }));
    return write(wallet, aqua, 'ship', [
      router.address,
      encodeAbiParameters(strategyType, [s]),
      assets,
      s.buy ? [budget] : s.ids.map(() => s.quantity),
    ]);
  }
  async function issue(start, count) {
    // Supply batches do not split the eventual atomic swap.
    for (let offset = 0; offset < count; offset += 31) {
      await write(host, inventory, 'issue', [
        pool,
        start + offset,
        Math.min(start + count, start + offset + 31),
        terms,
        1n,
      ]);
    }
    return Promise.all(
      Array.from({ length: count }, (_, i) =>
        read(inventory, 'tokenId', [pool, start + i, terms]),
      ),
    );
  }
  const ids = await issue(day, 7);
  const bid = make(buyer, true, ids, 300n * USD);
  await ship(buyer, bid, 300n * USD);
  const oldAsk = make(host, false, ids, 330n * USD);
  await ship(host, oldAsk);
  await assert.rejects(
    client.simulateContract({
      ...router,
      functionName: 'swap',
      args: [bid, oldAsk],
      account: other.account,
    }),
  );
  const ask = make(host, false, ids, 290n * USD);
  await ship(host, ask);
  assert.equal(
    await read(usd, 'balanceOf', [buyer.account.address]),
    10000n * USD,
  );
  const dayBid = make(other, true, [ids[2]], 100n * USD);
  await ship(other, dayBid, 100n * USD);
  const dayAsk = make(host, false, [ids[2]], 100n * USD);
  await ship(host, dayAsk);
  const fill = await write(other, router, 'swap', [bid, ask]);
  assert.equal(
    await read(usd, 'balanceOf', [buyer.account.address]),
    9710n * USD,
  );
  await assert.rejects(
    client.simulateContract({
      ...router,
      functionName: 'swap',
      args: [dayBid, dayAsk],
      account: other.account,
    }),
  );
  const reservation = await write(buyer, inventory, 'reserve', [
    buyer.account.address,
    pool,
    day,
    day + 7,
    terms,
    1n,
    buyer.account.address,
  ]);
  for (const id of ids)
    assert.equal(
      await read(inventory, 'balanceOf', [buyer.account.address, id]),
      0n,
    );
  for (let i = 0; i < 7; ++i)
    assert.equal(await read(inventory, 'consumed', [pool, day + i]), 1n);
  console.log(
    JSON.stringify({
      scenario:
        'standing cap, later ask, overlap rejection, existing inventory redemption',
      swapGas: String(fill.gasUsed),
      reserveGas: String(reservation.gasUsed),
    }),
  );
  // Actual transaction receipts: independent cold state, calldata costs and refunds included.
  let cursor = day + 7;
  for (const size of [1, 7, 31, 90, 254]) {
    const basket = await issue(cursor, size);
    cursor += size;
    const b = make(buyer, true, basket, USD);
    const a = make(host, false, basket, USD);
    const bs = await ship(buyer, b, USD);
    const as = await ship(host, a);
    const r = await write(other, router, 'swap', [b, a]);
    assert.ok(r.gasUsed < 15_000_000n, 'bounded receipt gas');
    for (const id of basket)
      assert.equal(
        await read(inventory, 'balanceOf', [buyer.account.address, id]),
        1n,
      );
    console.log(
      JSON.stringify({
        ids: size,
        buyerShipGas: String(bs.gasUsed),
        sellerShipGas: String(as.gasUsed),
        swapGas: String(r.gasUsed),
      }),
    );
  }
  assert.equal(await read(usd, 'balanceOf', [aqua.address]), 0n);
  assert.equal(await read(usd, 'balanceOf', [router.address]), 0n);
} finally {
  if (anvil.exitCode === null) {
    await new Promise((resolve) => {
      anvil.once('exit', resolve);
      anvil.kill('SIGTERM');
    });
  }
}
