import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
import { test } from 'node:test';
import {
  createPublicClient,
  createWalletClient,
  http,
  keccak256,
  toHex,
  encodeAbiParameters,
} from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { foundry } from 'viem/chains';
import { Store } from '../src/store.mjs';
import { OrderBook } from '../src/orders.mjs';
import { ChainIndex } from '../src/chain.mjs';
import { Matcher } from '../src/matcher.mjs';
import { createServer } from '../src/server.mjs';
import { Redemption } from '../src/redemption.mjs';
import {
  hashMandate,
  orderDomain,
  orderTypes,
  routerAbi,
  ZERO_HASH,
} from '../src/protocol.mjs';

const artifact = (path) =>
  JSON.parse(
    readFileSync(
      new URL(`../../../contracts/out/${path}.json`, import.meta.url),
    ),
  );
const json = (v) =>
  JSON.parse(
    JSON.stringify(v, (_, x) => (typeof x === 'bigint' ? x.toString() : x)),
  );
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test(
  'real Aqua settlement: persisted orders, competing fills, broadcast recovery and reorg',
  { timeout: 90000 },
  async (t) => {
    const port = await new Promise((resolve) => {
      const socket = net.createServer().listen(0, '127.0.0.1', () => {
        const port = socket.address().port;
        socket.close(() => resolve(port));
      });
    });
    const anvil = spawn('anvil', ['--port', String(port), '--silent'], {
      stdio: 'ignore',
    });
    t.after(() => anvil.kill());
    const transport = http(`http://127.0.0.1:${port}`, { retryCount: 0 });
    const client = createPublicClient({
      chain: foundry,
      transport,
      pollingInterval: 10,
      cacheTime: 0,
    });
    for (let attempt = 0; ; attempt++) {
      try {
        await client.getChainId();
        break;
      } catch (e) {
        if (attempt === 40) throw e;
        await sleep(100);
      }
    }
    const wallets = Array.from({ length: 3 }, () =>
      createWalletClient({
        chain: foundry,
        transport,
        account: privateKeyToAccount(generatePrivateKey()),
      }),
    );
    const [seller, buyer, relayer] = wallets;
    for (const wallet of wallets)
      await client.request({
        method: 'anvil_setBalance',
        params: [wallet.account.address, toHex(10n ** 20n)],
      });
    const send = async (wallet, contract, functionName, args = []) => {
      const hash = await wallet.writeContract({
        address: contract.address,
        abi: contract.abi,
        functionName,
        args,
      });
      const receipt = await client.waitForTransactionReceipt({ hash });
      assert.equal(receipt.status, 'success');
      return receipt;
    };
    const deploy = async (path, args = []) => {
      const a = artifact(path);
      const hash = await seller.deployContract({
        abi: a.abi,
        bytecode: a.bytecode.object,
        args,
      });
      const receipt = await client.waitForTransactionReceipt({ hash });
      assert.equal(receipt.status, 'success');
      return {
        address: receipt.contractAddress,
        abi: a.abi,
        block: receipt.blockNumber,
      };
    };
    const aqua = await deploy('Aqua.sol/Aqua');
    const usd = await deploy('Fixture.sol/TestUSDC');
    const inventory = await deploy('RentalInventory.sol/RentalInventory');
    const router = await deploy('RentalSwapVM.sol/RentalSwapVM', [
      aqua.address,
      inventory.address,
      usd.address,
      relayer.account.address,
    ]);
    const config = {
      chainId: 31337,
      router: router.address,
      usdc: usd.address,
      startBlock: Number(router.block),
      confirmations: 0,
    };
    const directory = mkdtempSync(join(tmpdir(), 'rental-integration-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const dbPath = join(directory, 'orders.sqlite');
    let store = new Store(dbPath),
      book = new OrderBook(store, client, config);
    t.after(() => store.close());
    let index = new ChainIndex(store, client, config);
    const api = createServer({ book, index });
    await new Promise((resolve) => api.listen(0, '127.0.0.1', resolve));
    t.after(
      () => api.listening && new Promise((resolve) => api.close(resolve)),
    );
    const apiUrl = `http://127.0.0.1:${api.address().port}`;
    const day = Math.floor(Date.now() / 86400000) + 10;
    const pool = keccak256(toHex('unit-class')),
      terms = keccak256(toHex('supplier-allotment'));
    await send(seller, inventory, 'createPool', [
      pool,
      seller.account.address,
      day,
      day + 7,
      1,
    ]);
    await send(seller, inventory, 'issue', [pool, day, day + 7, terms, 1]);
    await send(seller, inventory, 'setApprovalForAll', [router.address, true]);
    await send(seller, usd, 'mint', [buyer.account.address, 10_000_000n]);
    await send(buyer, usd, 'approve', [aqua.address, 10_000_000n]);
    const expiry = BigInt(Math.floor(Date.now() / 1000) + 3600);
    const mandate = {
      buyer: buyer.account.address,
      app: router.address,
      token: usd.address,
      limit: 10_000_000n,
      expiry,
      salt: keccak256(toHex('funding')),
    };
    const mandateBytes = encodeAbiParameters(
      [routerAbi[0].inputs[4]],
      [mandate],
    );
    await send(buyer, aqua, 'ship', [
      router.address,
      mandateBytes,
      [usd.address],
      [10_000_000n],
    ]);
    const program = `0x9e20${toHex(1_000_000n, { size: 32 }).slice(2)}540180`;
    async function order(
      wallet,
      buy,
      nonce,
      endDay,
      maker = wallet.account.address,
    ) {
      const o = {
        maker,
        buy,
        pool,
        startDay: day,
        endDay,
        quantity: 1,
        terms,
        recipient: wallet.account.address,
        priceLimit: buy ? 2_000_000n : 1n,
        maxFee: 20_000n,
        expiry,
        nonce: BigInt(nonce),
        group: ZERO_HASH,
        mandate: buy ? hashMandate(mandate) : ZERO_HASH,
        programHash: keccak256(program),
      };
      const signature = await wallet.signTypedData({
        domain: orderDomain(config),
        types: orderTypes,
        primaryType: 'Order',
        message: o,
      });
      const response = await fetch(`${apiUrl}/orders`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(
          json({ order: o, signature, program, ...(buy ? { mandate } : {}) }),
        ),
      });
      assert.equal(response.status, 201);
      const record = await response.json();
      assert.equal(
        record.hash,
        await client.readContract({
          ...router,
          functionName: 'hashOrder',
          args: [o],
        }),
      );
      return record;
    }
    const bid = await order(buyer, true, 1, day + 1),
      ask = await order(seller, false, 1, day + 1);
    const weekBid = await order(buyer, true, 2, day + 7),
      weekAsk = await order(seller, false, 2, day + 7);
    // Real ERC-1271 intake uses the same verifier as ordinary order submissions.
    const smartWallet = await deploy('Adversarial.t.sol/Rental1271Buyer', [
      seller.account.address,
    ]);
    await order(seller, false, 3, day + 1, smartWallet.address);
    const balance = () =>
      client.readContract({
        ...usd,
        functionName: 'balanceOf',
        args: [buyer.account.address],
      });
    assert.equal(await balance(), 10_000_000n); // Publishing alternatives did not escrow or reserve money.
    if (api.listening) await new Promise((resolve) => api.close(resolve));
    store.close();
    store = new Store(dbPath);
    book = new OrderBook(store, client, config);
    index = new ChainIndex(store, client, config);
    const matcher = new Matcher(store, book, client, relayer, config);
    assert.deepEqual(book.get(bid.hash), bid);
    assert.equal((await matcher.candidates()).length, 2);
    await send(buyer, usd, 'transfer', [seller.account.address, 10_000_000n]);
    await assert.rejects(matcher.submit(bid.hash, ask.hash));
    assert.equal(
      store.db.prepare('SELECT COUNT(*) AS n FROM submissions').get().n,
      0,
    );
    await send(seller, usd, 'transfer', [buyer.account.address, 10_000_000n]);
    const snapshot = await client.request({ method: 'evm_snapshot' });
    let dropped = false;
    const lossyClient = new Proxy(client, {
      get(target, name) {
        if (name === 'sendRawTransaction')
          return async (request) => {
            if (!dropped) {
              dropped = true;
              throw new Error('transport disconnected before acknowledgement');
            }
            return target.sendRawTransaction(request);
          };
        return target[name];
      },
    });
    const interrupted = new Matcher(store, book, lossyClient, relayer, config);
    await assert.rejects(
      interrupted.submit(bid.hash, ask.hash),
      /disconnected/,
    );
    const saved = store.db.prepare('SELECT raw,tx_hash FROM submissions').get();
    assert.ok(saved.raw);
    if (api.listening) await new Promise((resolve) => api.close(resolve));
    store.close();
    store = new Store(dbPath);
    book = new OrderBook(store, client, config);
    index = new ChainIndex(store, client, config);
    const restarted = new Matcher(store, book, client, relayer, config);
    const settled = await restarted.submit(bid.hash, ask.hash);
    assert.equal(settled.transactionHash, saved.tx_hash);
    assert.equal(
      (
        await client.waitForTransactionReceipt({
          hash: settled.transactionHash,
        })
      ).status,
      'success',
    );
    await index.sync();
    await index.sync();
    assert.equal(await index.status(bid), 'filled');
    assert.equal(
      (await restarted.status(settled.id, index)).state,
      'confirmed',
    );
    assert.equal(await balance(), 8_990_000n);
    const redemption = new Redemption(client, buyer, {
      chainId: 31337,
      inventory: inventory.address,
      confirmations: 1,
    });
    const reservation = await redemption.reserve({
      holder: buyer.account.address,
      pool,
      startDay: day,
      endDay: day + 1,
      terms,
      quantity: 1,
      beneficiary: relayer.account.address,
    });
    assert.equal(reservation.reservationId, 1n);
    assert.equal(
      await client.readContract({
        ...inventory,
        functionName: 'consumed',
        args: [pool, day],
      }),
      1n,
    );
    assert.equal(
      await client.readContract({
        ...inventory,
        functionName: 'issued',
        args: [pool, day],
      }),
      1n,
    );
    const record = await client.readContract({
      ...inventory,
      functionName: 'reservations',
      args: [reservation.reservationId],
    });
    assert.equal(record[0], buyer.account.address);
    assert.equal(record[1], relayer.account.address);
    await assert.rejects(
      redemption.reserve({
        holder: buyer.account.address,
        pool,
        startDay: day,
        endDay: day + 1,
        terms,
        quantity: 1,
        beneficiary: relayer.account.address,
      }),
    );
    await assert.rejects(restarted.submit(weekBid.hash, weekAsk.hash)); // Overlap must fail without payment.
    assert.equal(await balance(), 8_990_000n);
    assert.equal(await index.status(weekBid), 'open'); // Open does not guarantee available inventory.
    assert.equal(
      store.db.prepare('SELECT COUNT(*) AS n FROM submissions').get().n,
      1,
    );
    await client.request({ method: 'evm_revert', params: [snapshot] });
    await client.request({ method: 'evm_mine' });
    await index.sync();
    assert.equal(await index.status(bid), 'open');
    assert.equal(await balance(), 10_000_000n);
    assert.equal(
      await client.readContract({
        ...inventory,
        functionName: 'consumed',
        args: [pool, day],
      }),
      0n,
    );
    assert.equal(index.settled(bid.hash), false);
    // The persisted raw transaction is safe to rebroadcast after a reorg.
    assert.equal(
      (await restarted.submit(bid.hash, ask.hash)).transactionHash,
      saved.tx_hash,
    );
    await index.sync();
    assert.equal(await index.status(bid), 'filled');
    assert.equal(
      (await restarted.status(settled.id, index)).state,
      'confirmed',
    );
  },
);
