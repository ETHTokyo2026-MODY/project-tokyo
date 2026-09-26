import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { keccak256, toHex, decodeFunctionData } from 'viem';
import { localChain } from './local-chain.mjs';
import { Store } from '../src/store.mjs';
import { OrderBook } from '../src/orders.mjs';
import { ChainIndex } from '../src/chain.mjs';
import { Matcher } from '../src/matcher.mjs';
import { Market } from '../src/market.mjs';
import { StrategyWallet } from '../src/wallet.mjs';
import { Redemption } from '../src/redemption.mjs';
import { createServer, verifyDeployment } from '../src/server.mjs';
import {
  rentalStrategy,
  hashStrategy,
  serialize,
  routerAbi,
} from '../src/protocol.mjs';

test(
  'AquaVapor HTTP, shipped discovery, later ask, reorg recovery, resale and redemption',
  { timeout: 90000 },
  async (t) => {
    const { client, wallets, write, read, deploy, receipt } =
      await localChain(t);
    const [host, buyer, other, relayer] = wallets;
    const usdc = await deploy('ProofUSDC', [], 'NativeAqua.t');
    const inventory = await deploy('RentalInventory');
    const aqua = await deploy('AquaVapor');
    const router = await deploy('AssetSwapVM', [aqua.address, usdc.address]);
    const config = {
      chainId: 31337,
      aqua: aqua.address,
      router: router.address,
      usdc: usdc.address,
      confirmations: 0,
    };
    await verifyDeployment(client, config);
    for (const w of [buyer, other])
      await write(host, usdc, 'mint', [w.account.address, 1000_000000n]);
    const now = (await client.getBlock()).timestamp,
      day = Number(now / 86400n) + 2;
    const pool = keccak256(toHex('host room')),
      terms = keccak256(toHex('terms'));
    await write(host, inventory, 'createPool', [
      pool,
      host.account.address,
      day,
      day + 100,
      1,
    ]);
    await write(host, inventory, 'issue', [pool, day, day + 8, terms, 1n]);
    let salt = 0;
    const make = (
      wallet,
      buy,
      price,
      nonce,
      startDay = day,
      endDay = day + 7,
    ) =>
      rentalStrategy(
        {
          maker: wallet.account.address,
          inventory: inventory.address,
          pool,
          terms,
          startDay,
          endDay,
          quantity: 1,
          buy,
          price,
          expiry: now + 3600n,
          nonce,
          salt: keccak256(toHex(String(++salt))),
        },
        config,
      );
    const bid = make(buyer, true, 300_000000n, 1),
      expensive = make(host, false, 330_000000n, 1);
    const hostWallet = new StrategyWallet(client, host, config),
      buyerWallet = new StrategyWallet(client, buyer, config),
      otherWallet = new StrategyWallet(client, other, config);
    await buyerWallet.approve(bid, 1000_000000n);
    await hostWallet.approve(expensive);
    await buyerWallet.ship(bid);
    await hostWallet.ship(expensive);
    assert.equal(
      await read(usdc, 'balanceOf', [buyer.account.address]),
      1000_000000n,
    );
    const dir = mkdtempSync(join(tmpdir(), 'aquavapor-backend-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const database = join(dir, 'orders.sqlite');
    let store = new Store(database);
    t.after(() => store.close());
    let book = new OrderBook(store, client, config);
    let index = new ChainIndex(
      store,
      client,
      { ...config, startBlock: 0 },
      book,
    );
    await index.sync();
    assert.equal(book.list().length, 2);
    assert.equal(
      (await new Market(book, index, client, config).quotes()).quotes.length,
      0,
    );
    const server = createServer({
      book,
      index,
      market: new Market(book, index, client, config),
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    t.after(() =>
      server.listening
        ? new Promise((resolve) => server.close(resolve))
        : undefined,
    );
    const post = (path, payload) =>
      fetch(`${base}${path}`, { method: 'POST', body: serialize(payload) });
    assert.equal((await post('/orders', { strategy: bid })).status, 201);
    assert.equal(
      (await post('/orders', { order: bid, signature: '0x1234' })).status,
      400,
    );
    assert.equal(
      (await (await fetch(`${base}/deployment`)).json()).protocol,
      'aquavapor-v1',
    );
    const ask = make(host, false, 290_000000n, 2);
    await hostWallet.ship(ask);
    await index.sync();
    const quotes = await (await fetch(`${base}/market/quotes`)).json();
    assert.equal(quotes.quotes.length, 1);
    assert.equal(quotes.quotes[0].price, '290000000');
    assert.equal(quotes.quotes[0].bidHash, hashStrategy(bid));
    assert.equal(await read(router, 'hash', [bid]), hashStrategy(bid));
    assert.equal(await read(router, 'hash', [ask]), hashStrategy(ask));
    // Persist an unsigned transaction, restart the consumer, then recover its exact call.
    const broken = Object.create(relayer);
    broken.signTransaction = async () => {
      throw new Error('signer temporarily unavailable');
    };
    const matcher = new Matcher(store, book, client, broken, config);
    await assert.rejects(
      matcher.submit(hashStrategy(bid), hashStrategy(ask)),
      /temporarily unavailable/,
    );
    const job = store.db.prepare('SELECT unsigned,raw FROM submissions').get();
    assert.ok(job.unsigned);
    assert.equal(job.raw, null);
    await new Promise((resolve) => server.close(resolve));
    store.close();
    store = new Store(database);
    book = new OrderBook(store, client, config);
    index = new ChainIndex(store, client, { ...config, startBlock: 0 }, book);
    const snapshot = await client.request({ method: 'evm_snapshot' });
    let recovered = new Matcher(store, book, client, relayer, config);
    const [filled] = await recovered.recover();
    await receipt(filled.transactionHash);
    await index.sync();
    assert.equal((await recovered.status(filled.id, index)).state, 'confirmed');
    assert.equal(await index.status(book.get(hashStrategy(bid))), 'filled');
    const tx = await client.getTransaction({ hash: filled.transactionHash });
    assert.equal(
      decodeFunctionData({ abi: routerAbi, data: tx.input }).functionName,
      'swap',
    );
    assert.equal(
      await read(usdc, 'balanceOf', [buyer.account.address]),
      710_000000n,
    );
    // Orphan the fill. The cache remains, but authority/status and confirmation follow canonical state.
    assert.equal(
      await client.request({ method: 'evm_revert', params: [snapshot] }),
      true,
    );
    await client.request({ method: 'evm_mine' });
    await index.sync();
    assert.equal(await index.status(book.get(hashStrategy(bid))), 'open');
    assert.equal(
      await index.confirmedSettlement(
        filled.transactionHash,
        hashStrategy(bid),
        hashStrategy(ask),
      ),
      false,
    );
    recovered = new Matcher(store, book, client, relayer, config);
    const [refilled] = await recovered.recover();
    assert.equal(refilled.transactionHash, filled.transactionHash);
    await receipt(refilled.transactionHash);
    await index.sync();
    assert.equal(
      (await recovered.status(refilled.id, index)).state,
      'confirmed',
    );
    // A separate daily offer still has virtual authority, but cannot sell the now-missing inventory.
    const dailyBid = make(other, true, 100_000000n, 1, day + 1, day + 2),
      dailyAsk = make(host, false, 100_000000n, 3, day + 1, day + 2);
    await otherWallet.approve(dailyBid, 1000_000000n);
    await otherWallet.ship(dailyBid);
    await hostWallet.ship(dailyAsk);
    await index.sync();
    await assert.rejects(
      recovered.simulate(
        book.get(hashStrategy(dailyBid)),
        book.get(hashStrategy(dailyAsk)),
      ),
    );
    // Resell through the same native path, then reuse the existing reservation consumer.
    const resale = make(buyer, false, 300_000000n, 2),
      nextBid = make(other, true, 310_000000n, 2);
    await buyerWallet.approve(resale);
    await buyerWallet.ship(resale);
    await otherWallet.ship(nextBid);
    await index.sync();
    const sale = await recovered.submit(
      hashStrategy(nextBid),
      hashStrategy(resale),
    );
    await receipt(sale.transactionHash);
    await index.sync();
    assert.equal(
      await read(usdc, 'balanceOf', [buyer.account.address]),
      1010_000000n,
    );
    const reserve = new Redemption(client, other, {
      chainId: 31337,
      inventory: inventory.address,
      confirmations: 1,
    });
    await reserve.reserve({
      holder: other.account.address,
      pool,
      startDay: day,
      endDay: day + 7,
      terms,
      quantity: 1,
      beneficiary: other.account.address,
    });
    for (let d = day; d < day + 7; d++)
      assert.equal(await read(inventory, 'consumed', [pool, d]), 1n);
    const history = await new Market(book, index, client, config).history();
    assert.equal(history.sales.length, 2);
    // Dock revokes permission without transferring money.
    const cancelled = make(buyer, true, 50_000000n, 4, day + 7, day + 8);
    await buyerWallet.ship(cancelled);
    await index.sync();
    await buyerWallet.dock(cancelled);
    await index.sync();
    assert.equal(
      await index.status(book.get(hashStrategy(cancelled))),
      'cancelled',
    );
  },
);
