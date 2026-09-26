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
import { SupplyBook, supplyDomain, scheduleTypes } from '../src/supply.mjs';
import { OrderBook } from '../src/orders.mjs';
import { ChainIndex } from '../src/chain.mjs';
import { Matcher } from '../src/matcher.mjs';
import { Market } from '../src/market.mjs';
import { CollectiveBatch, guardProgram } from '../src/collective.mjs';
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
    const supplyConfig = { chainId: foundry.id, inventory: inventory.address };
    const supply = new SupplyBook(store, client, supplyConfig);
    const api = createServer({
      book,
      index,
      supply,
      market: new Market(book, index, client, config),
    });
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
    const schedule = {
      supplier: seller.account.address,
      pool,
      terms,
      startDay: day,
      endDay: day + 7,
      weekdays: 127,
      target: 1,
    };
    const signature = await seller.signTypedData({
      domain: supplyDomain(supplyConfig),
      types: scheduleTypes,
      primaryType: 'Schedule',
      message: schedule,
    });
    const publicationResponse = await fetch(`${apiUrl}/supply`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ schedule, signature }),
    });
    assert.equal(publicationResponse.status, 201);
    const publication = await publicationResponse.json();
    const plannedSupply = await supply.reconcile(publication.hash);
    assert.equal(plannedSupply.slots.length, 7);
    for (const slot of plannedSupply.slots) {
      const hash = await seller.sendTransaction({
        ...slot.transaction,
        account: seller.account,
      });
      assert.equal(
        (await client.waitForTransactionReceipt({ hash })).status,
        'success',
      );
    }
    // Replaying the exact unsigned transaction does not mint a second entitlement.
    await client.waitForTransactionReceipt({
      hash: await seller.sendTransaction({
        ...plannedSupply.slots[0].transaction,
        account: seller.account,
      }),
    });
    assert.ok(
      (await supply.reconcile(publication.hash)).slots.every(
        (slot) => slot.issued === '1' && slot.transaction === null,
      ),
    );
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
      funding = mandate,
      programBytes = program,
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
        mandate: buy ? hashMandate(funding) : ZERO_HASH,
        programHash: keccak256(programBytes),
      };
      const signature = await wallet.signTypedData({
        domain: orderDomain(config),
        types: orderTypes,
        primaryType: 'Order',
        message: o,
      });
      const payload = json({
        order: o,
        signature,
        program: programBytes,
        ...(buy ? { mandate: funding } : {}),
      });
      let record;
      if (api.listening) {
        const response = await fetch(`${apiUrl}/orders`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        });
        assert.equal(response.status, 201);
        record = await response.json();
      } else record = await book.submit(payload);
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
    const economicProgram = `0xa080${[100_000n, 250n, 7n, 1000n]
      .map((value) => toHex(value, { size: 32 }).slice(2))
      .join('')}540180`;
    assert.deepEqual(
      await client.readContract({
        ...router,
        functionName: 'quote',
        args: [economicProgram, 7n, 1n],
      }),
      [630_000n, 15_750n],
    );
    const economicBid = await order(
      buyer,
      true,
      4,
      day + 7,
      buyer.account.address,
      mandate,
      economicProgram,
    );
    const economicAsk = await order(
      seller,
      false,
      4,
      day + 7,
      seller.account.address,
      mandate,
      economicProgram,
    );
    assert.equal(economicBid.order.programHash, economicAsk.order.programHash);
    const listed = await fetch(`${apiUrl}/market/quotes?limit=5`);
    assert.equal(listed.status, 200);
    const alternatives = await listed.json();
    assert.equal(alternatives.quotes.length, 2);
    assert.equal(alternatives.bestByBasket.length, 2);
    assert.ok(
      alternatives.bestByBasket.every((quote) => quote.total === '1010000'),
    );
    assert.equal(alternatives.quotes[0].bidMaker, buyer.account.address);
    assert.equal(alternatives.quotes[1].bidMaker, buyer.account.address);
    assert.match(alternatives.execution, /alternatives/);
    const balance = () =>
      client.readContract({
        ...usd,
        functionName: 'balanceOf',
        args: [buyer.account.address],
      });
    assert.equal(await balance(), 10_000_000n); // Publishing alternatives did not escrow or reserve money.
    await send(buyer, usd, 'transfer', [seller.account.address, 8_500_000n]);
    assert.equal(await balance(), 1_500_000n);
    const constrained = await (
      await fetch(`${apiUrl}/market/quotes?limit=5`)
    ).json();
    assert.equal(constrained.quotes.length, 2);
    assert.ok(
      constrained.quotes.reduce((sum, quote) => sum + BigInt(quote.total), 0n) >
        (await balance()),
    ); // Each alternative is fillable; their combined cost exceeds the wallet.
    await send(seller, usd, 'transfer', [buyer.account.address, 8_500_000n]);
    if (api.listening) await new Promise((resolve) => api.close(resolve));
    store.close();
    store = new Store(dbPath);
    book = new OrderBook(store, client, config);
    index = new ChainIndex(store, client, config);
    const matcher = new Matcher(store, book, client, relayer, config);
    let market = new Market(book, index, client, config);
    assert.deepEqual(book.get(bid.hash), bid);
    assert.equal((await matcher.candidates()).length, 3);
    // Execute the persisted economic program through the production relay, then
    // restore the fixture chain for the independent recovery scenario below.
    const economicSnapshot = await client.request({ method: 'evm_snapshot' });
    const economicStore = new Store(join(directory, 'economic.sqlite'));
    try {
      const economicMatcher = new Matcher(
        economicStore,
        book,
        client,
        relayer,
        config,
      );
      const executed = await economicMatcher.submit(
        economicBid.hash,
        economicAsk.hash,
      );
      assert.equal(
        (
          await client.waitForTransactionReceipt({
            hash: executed.transactionHash,
          })
        ).status,
        'success',
      );
      assert.equal(await balance(), 9_354_250n);
      assert.equal(
        await client.readContract({
          ...inventory,
          functionName: 'balanceOf',
          args: [
            buyer.account.address,
            await client.readContract({
              ...inventory,
              functionName: 'tokenId',
              args: [pool, day, terms],
            }),
          ],
        }),
        1n,
      );
    } finally {
      economicStore.close();
      await client.request({
        method: 'evm_revert',
        params: [economicSnapshot],
      });
    }
    assert.equal(await balance(), 10_000_000n);

    await send(buyer, usd, 'transfer', [seller.account.address, 10_000_000n]);
    assert.equal((await market.quotes()).quotes.length, 0);
    await assert.rejects(matcher.submit(bid.hash, ask.hash));
    assert.equal(
      store.db.prepare('SELECT COUNT(*) AS n FROM submissions').get().n,
      0,
    );
    await send(seller, usd, 'transfer', [buyer.account.address, 10_000_000n]);
    assert.deepEqual(
      new Set((await market.quotes()).quotes.map((quote) => quote.bidHash)),
      new Set([bid.hash, weekBid.hash, economicBid.hash]),
    );
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
    market = new Market(book, index, client, config);
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
    await client.waitForTransactionReceipt({ hash: saved.tx_hash });
    await index.sync();
    assert.equal(await index.status(bid), 'filled');
    const firstSales = await market.history();
    assert.equal(firstSales.sales.length, 1);
    assert.equal(firstSales.sales[0].price, '1000000');
    assert.equal(firstSales.bookingHistory, 'unavailable');
    const readApi = createServer({ book, index, market });
    await new Promise((resolve) => readApi.listen(0, '127.0.0.1', resolve));
    const historyResponse = await fetch(
      `http://127.0.0.1:${readApi.address().port}/market/history`,
    );
    assert.equal(historyResponse.status, 200);
    assert.equal((await historyResponse.json()).sales.length, 1);
    await new Promise((resolve) => readApi.close(resolve));
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
    assert.deepEqual((await market.history()).sales, []);
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
    await client.waitForTransactionReceipt({ hash: saved.tx_hash });
    await index.sync();
    assert.equal(await index.status(bid), 'filled');
    assert.equal(
      (await restarted.status(settled.id, index)).state,
      'confirmed',
    );
    await send(seller, usd, 'mint', [seller.account.address, 10_000n]);
    await send(seller, usd, 'approve', [aqua.address, 1_010_000n]);
    const resaleMandate = {
      buyer: seller.account.address,
      app: router.address,
      token: usd.address,
      limit: 1_010_000n,
      expiry,
      salt: keccak256(toHex('resale-funding')),
    };
    await send(seller, aqua, 'ship', [
      router.address,
      encodeAbiParameters([routerAbi[0].inputs[4]], [resaleMandate]),
      [usd.address],
      [1_010_000n],
    ]);
    await send(buyer, inventory, 'setApprovalForAll', [router.address, true]);
    const resaleBid = await order(
      seller,
      true,
      4,
      day + 1,
      seller.account.address,
      resaleMandate,
    );
    const resaleAsk = await order(buyer, false, 4, day + 1);
    const resaleQuotes = await market.quotes();
    assert.equal(resaleQuotes.quotes.length, 1);
    assert.equal(resaleQuotes.bestByBasket[0].bidHash, resaleBid.hash);
    assert.equal(resaleQuotes.bestByBasket[0].askHash, resaleAsk.hash);
    const resale = await restarted.submit(resaleBid.hash, resaleAsk.hash);
    assert.equal(
      (await client.waitForTransactionReceipt({ hash: resale.transactionHash }))
        .status,
      'success',
    );
    await index.sync();
    assert.equal((await market.history()).sales.length, 2);
    const resaleTokenId = await client.readContract({
      ...inventory,
      functionName: 'tokenId',
      args: [pool, day, terms],
    });
    assert.equal(
      await client.readContract({
        ...inventory,
        functionName: 'balanceOf',
        args: [seller.account.address, resaleTokenId],
      }),
      1n,
    );
    assert.equal(
      await client.readContract({
        ...inventory,
        functionName: 'balanceOf',
        args: [buyer.account.address, resaleTokenId],
      }),
      0n,
    );
    const afterResale = await market.quotes();
    assert.equal(afterResale.quotes.length, 1);
    assert.equal(afterResale.bestByBasket[0].bidHash, weekBid.hash);
    assert.equal(afterResale.bestByBasket[0].askHash, weekAsk.hash);
    await send(buyer, router, 'cancel', [2n]);
    assert.equal((await market.quotes()).quotes.length, 0);
    await order(buyer, true, 5, day + 1);
    await order(seller, false, 5, day + 1);
    assert.equal((await market.quotes()).quotes.length, 1);
    const beforeExpiry = await client.request({ method: 'evm_snapshot' });
    await client.request({
      method: 'evm_setNextBlockTimestamp',
      params: [Number(expiry + 1n)],
    });
    await client.request({ method: 'evm_mine' });
    assert.equal((await market.quotes()).quotes.length, 0);
    await client.request({ method: 'evm_revert', params: [beforeExpiry] });
    const secondBuyer = createWalletClient({
      chain: foundry,
      transport,
      account: privateKeyToAccount(generatePrivateKey()),
    });
    await client.request({
      method: 'anvil_setBalance',
      params: [secondBuyer.account.address, toHex(10n ** 20n)],
    });
    const collectiveAddress = await client.readContract({
      ...router,
      functionName: 'collective',
    });
    const collectivePool = keccak256(toHex('collective-room-class'));
    await send(seller, inventory, 'createPool', [
      collectivePool,
      seller.account.address,
      day,
      day + 1,
      2,
    ]);
    await send(seller, inventory, 'issue', [
      collectivePool,
      day,
      day + 1,
      terms,
      2,
    ]);
    await send(seller, usd, 'mint', [secondBuyer.account.address, 10_000_000n]);
    await send(secondBuyer, usd, 'approve', [aqua.address, 10_000_000n]);
    const secondMandate = {
      ...mandate,
      buyer: secondBuyer.account.address,
      salt: keccak256(toHex('second-collective-funding')),
    };
    await send(secondBuyer, aqua, 'ship', [
      router.address,
      encodeAbiParameters([routerAbi[0].inputs[4]], [secondMandate]),
      [usd.address],
      [10_000_000n],
    ]);
    const collectiveProgram = guardProgram({
      coordinator: collectiveAddress,
      campaign: keccak256(toHex('integration-collective')),
      minParticipants: 2,
      minSpend: 2_020_000n,
      priceProgram: program,
    });
    async function collectiveOrder(wallet, buy, nonce, funding) {
      const o = {
        maker: wallet.account.address,
        buy,
        pool: collectivePool,
        startDay: day,
        endDay: day + 1,
        quantity: 1,
        terms,
        recipient: wallet.account.address,
        priceLimit: buy ? 2_000_000n : 1n,
        maxFee: 20_000n,
        expiry,
        nonce,
        group: ZERO_HASH,
        mandate: buy ? hashMandate(funding) : ZERO_HASH,
        programHash: keccak256(collectiveProgram),
      };
      const signature = await wallet.signTypedData({
        domain: orderDomain(config),
        types: orderTypes,
        primaryType: 'Order',
        message: o,
      });
      return book.submit(
        json({
          order: o,
          signature,
          program: collectiveProgram,
          ...(buy ? { mandate: funding } : {}),
        }),
      );
    }
    const collectiveBid1 = await collectiveOrder(buyer, true, 10n, mandate);
    const collectiveAsk1 = await collectiveOrder(seller, false, 10n);
    const collectiveBid2 = await collectiveOrder(
      secondBuyer,
      true,
      11n,
      secondMandate,
    );
    const collectiveAsk2 = await collectiveOrder(seller, false, 11n);
    const collectiveBatch = new CollectiveBatch(book, client, relayer.account, {
      chainId: config.chainId,
      router: router.address,
      collective: collectiveAddress,
    });
    const { request, result } = await collectiveBatch.simulate([
      [collectiveBid1.hash, collectiveAsk1.hash],
      [collectiveBid2.hash, collectiveAsk2.hash],
    ]);
    assert.deepEqual(result, [2_000_000n, 20_000n]);
    const collectiveTx = await relayer.writeContract(request);
    const collectiveReceipt = await client.waitForTransactionReceipt({
      hash: collectiveTx,
    });
    assert.equal(collectiveReceipt.status, 'success');
    assert.deepEqual(
      await collectiveBatch.confirm(collectiveReceipt, request),
      {
        transactionHash: collectiveTx,
        campaign: keccak256(toHex('integration-collective')),
        participants: 2,
        price: 2_000_000n,
        fee: 20_000n,
      },
    );
    await assert.rejects(
      collectiveBatch.confirm(
        { ...collectiveReceipt, blockHash: ZERO_HASH },
        request,
      ),
      /Collective transaction mismatch/,
    );
    await assert.rejects(
      collectiveBatch.confirm(collectiveReceipt, {
        ...request,
        args: [[...request.args[0]].reverse()],
      }),
      /Collective transaction mismatch/,
    );
    assert.equal(
      await client.readContract({
        ...usd,
        functionName: 'balanceOf',
        args: [secondBuyer.account.address],
      }),
      8_990_000n,
    );
  },
);
