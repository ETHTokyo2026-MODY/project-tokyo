import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { getAddress, parseEventLogs, zeroHash } from 'viem';
import { localChain } from './local-chain.mjs';
import { readDayAsset } from '../src/day-catalog.mjs';
import { EventIndex } from '../src/event-index.mjs';
import { DayTaker } from '../src/day-taker.mjs';
import {
  approveDayFunding,
  dayAssetAbi,
  dayFactoryAbi,
  dayRouterAbi,
  dayTokenAbi,
  decodeDayPublication,
  hashDayStrategy,
  officialAquaAbi,
  shipDayStrategy,
  tokyoDay,
} from '../src/day-protocol.mjs';

const events = (abi) => abi.filter((entry) => entry.type === 'event');

/** Real contract fixture; the localChain teardown owns exactly its Anvil child. */
async function dayMarket(t) {
  const chain = await localChain(t);
  const { client, wallets, deploy, read, write, receipt } = chain;
  const [host, seller, buyer, taker] = wallets;
  const usdc = await deploy('MarketUSDC', [], 'DaySwapVM.t');
  const aqua = await deploy('Aqua');
  const factory = await deploy('RentalAssetFactory');
  const router = await deploy('DaySwapVM', [
    aqua.address,
    usdc.address,
    factory.address,
  ]);
  for (const contract of [usdc, aqua, factory, router])
    contract.address = getAddress(contract.address);
  const created = await write(host, factory, 'createAsset', [
    zeroHash,
    'ipfs://integration-car',
    {
      minimum: 1_000000n,
      listedPrices: Array(7).fill(120_000000n),
      sellingPrices: Array(7).fill(100_000000n),
    },
    [{ minDays: 3, discountBps: 1000 }],
  ]);
  const creation = parseEventLogs({
    abi: dayFactoryAbi,
    logs: created.logs,
    eventName: 'AssetCreated',
  })[0];
  assert.ok(creation);
  const asset = { address: creation.args.asset, abi: dayAssetAbi };
  const startDay = creation.args.startDay;
  const config = {
    chainId: 31337,
    router: router.address,
    aqua: aqua.address,
    factory: factory.address,
  };
  const send = (wallet, transaction) =>
    wallet.sendTransaction(transaction).then(receipt);
  const approve = (wallet, token, amount) =>
    send(wallet, approveDayFunding({ token, aqua: aqua.address, amount }));
  const publish = async (wallet, kind, strategy, token) => {
    const hash = hashDayStrategy(kind, strategy);
    assert.equal(
      await read(router, kind === 'bid' ? 'hashBid' : 'hashAsk', [strategy]),
      hash,
    );
    const mined = await send(
      wallet,
      shipDayStrategy({ aqua: aqua.address, kind, strategy, token }),
    );
    const logs = parseEventLogs({
      abi: officialAquaAbi,
      logs: mined.logs,
      eventName: 'Shipped',
    });
    assert.equal(logs.length, 1);
    assert.equal(logs[0].topics.length, 1); // Official Aqua indexes no event arguments.
    const decoded = decodeDayPublication(logs[0].args, config);
    assert.equal(decoded.kind, kind);
    assert.equal(decoded.hash, hash);
    assert.deepEqual(decoded.strategy, strategy);
    return hash;
  };
  const makeAsk = async (day) => {
    const state = await read(asset, 'dayState', [day]);
    return {
      seller: state.owner,
      chainId: 31337n,
      app: router.address,
      asset: asset.address,
      day,
      saleNonce: state.saleNonce,
      discountVersion: await read(asset, 'discountVersion'),
      salt: zeroHash,
    };
  };
  const programsFor = (bid) =>
    Promise.all(
      Array.from({ length: bid.endDayExclusive - bid.startDay }, (_, i) =>
        read(router, 'program', [
          bid.asset,
          bid.startDay + i,
          bid.endDayExclusive - bid.startDay,
        ]),
      ),
    );
  const simulate = async (bid, asks, functionName = 'quote') =>
    client.simulateContract({
      ...router,
      account: taker.account,
      functionName,
      args: [bid, asks, await programsFor(bid)],
    });
  const settle = async (bid, asks) => {
    const simulation = await simulate(bid, asks, 'settle');
    const mined = await taker.writeContract(simulation.request).then(receipt);
    return { total: simulation.result, receipt: mined };
  };
  return {
    ...chain,
    host,
    seller,
    buyer,
    taker,
    usdc,
    aqua,
    factory,
    router,
    asset,
    startDay,
    config,
    created,
    approve,
    publish,
    makeAsk,
    programsFor,
    simulate,
    settle,
  };
}

async function syncToHead(index) {
  for (let i = 0; i < 10; i++) {
    await index.sync();
    if ((await index.readiness()).ready) return;
  }
  assert.fail('Event index did not reach this bounded scenario head');
}

function chainIndex(t, f) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  const options = {
    chainId: 31337,
    startBlock: Number(f.created.blockNumber),
    confirmations: 0,
    scope: { factory: f.factory.address, router: f.router.address },
    sources: [
      { address: f.factory.address, events: events(dayFactoryAbi) },
      { address: f.aqua.address, events: events(officialAquaAbi) },
      { address: f.router.address, events: events(dayRouterAbi) },
    ],
  };
  return {
    db,
    index: new EventIndex(db, f.client, options),
    restart: () => new EventIndex(db, f.client, options),
  };
}

test(
  'day backend consumes real Aqua publications, calendar, atomic fills and shared funding',
  { timeout: 90000 },
  async (t) => {
    const f = await dayMarket(t);
    const {
      client,
      read,
      write,
      host,
      seller,
      buyer,
      asset,
      router,
      aqua,
      usdc,
    } = f;
    const buyerAddress = buyer.account.address;
    const initial = await readDayAsset(client, {
      factory: f.factory.address,
      asset: asset.address,
    });
    assert.equal(initial.days.length, 365);
    assert.equal(initial.endDayExclusive - initial.startDay, 365);
    assert.equal(initial.startDay, tokyoDay(initial.timestamp));
    assert.equal(initial.metadataURI, 'ipfs://integration-car');
    assert.equal(initial.host, host.account.address);
    assert.equal(new Set(initial.days.map((day) => day.token)).size, 365);
    assert.ok(
      initial.days.every(
        (day) => day.owner === initial.host && day.listed && !day.deployed,
      ),
    );
    assert.equal(initial.discountVersion, 1n);
    assert.deepEqual(initial.discounts, [{ minDays: 3, discountBps: 1000 }]);

    const asks = [];
    for (let i = 0; i < 3; i++) {
      const day = f.startDay + i;
      await write(host, asset, 'materialize', [day]);
      const token = { address: initial.days[i].token, abi: dayTokenAbi };
      const owner = i === 1 ? seller : host;
      if (i === 1) {
        await write(host, token, 'transfer', [seller.account.address, 1n]);
        await write(seller, asset, 'setListing', [
          day,
          day + 1,
          true,
          100_000000n,
        ]);
      }
      assert.equal(await read(token, 'decimals'), 0);
      const ask = await f.makeAsk(day);
      await f.approve(owner, token.address, 1n);
      await f.publish(owner, 'ask', ask, token.address);
      asks.push(ask);
    }
    await write(host, usdc, 'mint', [buyerAddress, 300_000000n]);
    assert.equal(await read(usdc, 'decimals'), 6);
    await f.approve(buyer, usdc.address, 300_000000n);
    const now = (await client.getBlock()).timestamp;
    const bid = {
      buyer: buyerAddress,
      chainId: 31337n,
      app: router.address,
      asset: asset.address,
      startDay: f.startDay,
      endDayExclusive: f.startDay + 3,
      maxTotal: 250_000000n,
      nonce: 1n,
      deadline: Number(now + 3600n),
      salt: zeroHash,
    };
    const otherBid = { ...bid, nonce: 2n };
    const bidHash = await f.publish(buyer, 'bid', bid, usdc.address);
    const otherHash = await f.publish(buyer, 'bid', otherBid, usdc.address);
    assert.equal(await read(usdc, 'balanceOf', [buyerAddress]), 300_000000n);
    await assert.rejects(f.simulate(bid, asks)); // 270 exceeds unchanged standing cap 250.
    await assert.rejects(f.simulate(otherBid, asks));

    const indexed = chainIndex(t, f);
    let index = indexed.index;
    await syncToHead(index);
    const taker = new DayTaker(indexed.db, index, client, f.taker, f.config);
    assert.equal((await taker.tick()).submissions.length, 0);
    assert.equal(
      indexed.db.prepare('SELECT count(*) AS n FROM submissions').get().n,
      0,
    );
    assert.equal(index.events('AssetCreated').length, 1);
    const publications = index
      .events('Shipped')
      .map((event) => decodeDayPublication(event.args, f.config));
    assert.equal(publications.length, 5);
    assert.equal(publications.filter((p) => p.kind === 'bid').length, 2);
    assert.deepEqual(
      new Set(publications.map((p) => p.hash)),
      new Set([
        bidHash,
        otherHash,
        ...asks.map((ask) => hashDayStrategy('ask', ask)),
      ]),
    );

    // Owner price edits are live; buyer and sellers keep their original shipped preimages.
    await write(seller, asset, 'setListing', [
      f.startDay + 1,
      f.startDay + 2,
      true,
      70_000000n,
    ]);
    const quoted = await f.simulate(bid, asks);
    assert.equal(quoted.result[0], 243_000000n);
    assert.deepEqual(
      quoted.result[1].map((fill) => fill.payment),
      [90_000000n, 63_000000n, 90_000000n],
    );
    const executed = await taker.tick();
    assert.equal(executed.submissions.length, 1);
    await f.receipt(executed.submissions[0].transactionHash);
    const confirmed = await taker.tick();
    assert.equal(confirmed.recovered[0].state, 'filled');
    assert.equal(confirmed.recovered[0].total, 243_000000n);
    assert.equal(await read(usdc, 'balanceOf', [buyerAddress]), 57_000000n);
    assert.equal(
      await read(usdc, 'balanceOf', [host.account.address]),
      180_000000n,
    );
    assert.equal(
      await read(usdc, 'balanceOf', [seller.account.address]),
      63_000000n,
    );
    assert.equal(await read(router, 'used', [buyerAddress, 1n]), true);
    assert.equal(await read(router, 'used', [buyerAddress, 2n]), false);
    const remaining = await read(aqua, 'rawBalances', [
      buyerAddress,
      router.address,
      bidHash,
      usdc.address,
    ]);
    assert.equal(remaining[0], 7_000000n);
    const acquired = await readDayAsset(client, {
      factory: f.factory.address,
      asset: asset.address,
    });
    for (let i = 0; i < 3; i++) {
      const state = acquired.days[i];
      assert.equal(state.owner, buyerAddress);
      assert.equal(state.listed, false);
      assert.equal(state.saleNonce, asks[i].saleNonce + 1n);
      assert.equal(
        await read({ address: state.token, abi: dayTokenAbi }, 'allowance', [
          buyerAddress,
          aqua.address,
        ]),
        0n,
      );
    }
    assert.ok(
      acquired.days
        .slice(3)
        .every((day) => !day.deployed && day.owner === host.account.address),
    );
    await syncToHead(index);
    assert.equal(index.events('Settled').length, 1);
    assert.equal(index.events('DaySettled').length, 3);
    assert.equal(index.events('Pulled').length, 6); // Three USDC pulls plus three actual day-token pulls.
    assert.equal(index.events('Settled')[0].args.total, '243000000');
    index = indexed.restart();
    assert.equal((await index.readiness()).ready, true);
    assert.equal(index.events('Settled')[0].args.bidHash, bidHash);

    // New ownership epochs allow fresh asks, while the other bid still shares the depleted wallet.
    for (let i = 0; i < 3; i++) {
      const day = f.startDay + i;
      const owner = i === 1 ? seller : host;
      const token = { address: acquired.days[i].token, abi: dayTokenAbi };
      await write(buyer, token, 'transfer', [owner.account.address, 1n]);
      await write(owner, asset, 'setListing', [
        day,
        day + 1,
        true,
        acquired.days[i].sellingPrice,
      ]);
      asks[i] = await f.makeAsk(day);
      await f.approve(owner, token.address, 1n);
      await f.publish(owner, 'ask', asks[i], token.address);
    }
    await assert.rejects(f.simulate(otherBid, asks)); // 57 actual USDC cannot satisfy its 250 virtual cap.
    assert.equal(await read(router, 'used', [buyerAddress, 2n]), false);
    assert.equal((await taker.tick()).submissions.length, 0);
    await write(host, usdc, 'mint', [buyerAddress, 186_000000n]);
    await f.approve(buyer, usdc.address, 243_000000n);
    // Lose the RPC response immediately after the real node accepted and mined the signed bytes.
    let crashed = false;
    const crashingClient = {
      ...client,
      async sendRawTransaction(request) {
        await client.sendRawTransaction(request);
        crashed = true;
        throw new Error('process lost after broadcast');
      },
      async getTransactionReceipt(request) {
        if (crashed) throw new Error('process lost after broadcast');
        return client.getTransactionReceipt(request);
      },
    };
    const crashTaker = new DayTaker(
      indexed.db,
      index,
      crashingClient,
      f.taker,
      f.config,
    );
    await assert.rejects(crashTaker.tick(), /process lost after broadcast/);
    const saved = indexed.db
      .prepare('SELECT * FROM submissions ORDER BY nonce')
      .all();
    assert.equal(saved.length, 2);
    assert.ok(saved.every((job) => job.raw && job.tx_hash));
    await f.receipt(saved[1].tx_hash);
    const noSign = {
      ...f.taker,
      signTransaction: async () => {
        throw new Error('unexpected signature');
      },
    };
    const recovered = await new DayTaker(
      indexed.db,
      index,
      client,
      noSign,
      f.config,
    ).tick();
    assert.deepEqual(
      recovered.recovered.map((job) => job.state),
      ['filled', 'filled'],
    );
    assert.equal(recovered.submissions.length, 0);
    assert.deepEqual(
      indexed.db.prepare('SELECT * FROM submissions ORDER BY nonce').all(),
      saved,
    );
    assert.equal(
      await client.getTransactionCount({ address: f.taker.account.address }),
      2,
    );
    assert.equal(await read(usdc, 'balanceOf', [buyerAddress]), 0n);
    await syncToHead(index);
    assert.equal(index.events('Settled').length, 2);
    assert.equal(index.events('DaySettled').length, 6);
    assert.equal(index.events('Pulled').length, 12);

    // A real local-chain branch replacement removes orphaned events from the derived cache.
    const snapshot = await client.request({ method: 'evm_snapshot' });
    await write(buyer, router, 'cancel', [99n]);
    await syncToHead(index);
    assert.equal(index.events('Cancelled')[0].args.nonce, '99');
    assert.equal(
      await client.request({ method: 'evm_revert', params: [snapshot] }),
      true,
    );
    await write(buyer, router, 'cancel', [100n]);
    await client.request({ method: 'anvil_mine', params: ['0x80'] });
    const waiting = await new DayTaker(
      indexed.db,
      index,
      client,
      noSign,
      f.config,
    ).tick();
    assert.equal(waiting.state, 'indexing');
    assert.equal(
      await client.getTransactionCount({ address: f.taker.account.address }),
      2,
    );
    await syncToHead(index);
    assert.deepEqual(
      index.events('Cancelled').map((event) => event.args.nonce),
      ['100'],
    );
    assert.equal(index.events('Settled').length, 2);
    assert.equal(
      getAddress(index.events('Settled')[0].args.buyer),
      buyerAddress,
    );
  },
);

// The same unsigned plans consumed by the website execute against real contracts.
test('HTTP create, list, conditional bid and taker fill use canonical calendars', async (t) => {
  const { createDayServer } = await import('../src/day-server.mjs');
  const chain = await localChain(t);
  const {
    client,
    wallets: [host, trader, , relayer],
    deploy,
    write,
    receipt,
    read,
  } = chain;
  const usdc = await deploy('MarketUSDC', [], 'DaySwapVM.t');
  const aqua = await deploy('Aqua');
  const factory = await deploy('RentalAssetFactory');
  const router = await deploy('DaySwapVM', [
    aqua.address,
    usdc.address,
    factory.address,
  ]);
  const config = {
    chainId: 31337,
    usdc: usdc.address,
    aqua: aqua.address,
    factory: factory.address,
    router: router.address,
    bookingReporter: relayer.account.address,
  };
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  const index = new EventIndex(db, client, {
    chainId: 31337,
    startBlock: 0,
    confirmations: 0,
    scope: 'http',
    sources: [
      { address: factory.address, events: events(dayFactoryAbi) },
      { address: aqua.address, events: events(officialAquaAbi) },
      { address: router.address, events: events(dayRouterAbi) },
    ],
  });
  const server = createDayServer({ client, index, config });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  async function request(path, body) {
    const response = await fetch(
      base + path,
      body
        ? {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
          }
        : {},
    );
    const result = await response.json();
    assert.equal(response.status, 200, JSON.stringify(result));
    return result;
  }
  async function execute(wallet, action, body) {
    const plan = await request('/prepare', {
      actor: wallet.account.address,
      action,
      body,
    });
    let last;
    for (const transaction of plan.transactions)
      last = await receipt(
        await wallet.sendTransaction({
          ...transaction,
          value: BigInt(transaction.value),
        }),
      );
    return last;
  }
  const created = await execute(host, 'create-asset', {
    salt: zeroHash,
    metadataURI: 'data:application/json,{"name":"Host car"}',
    defaults: {
      minimum: '1000000',
      listedPrices: Array(7).fill('120000000'),
      sellingPrices: Array(7).fill('100000000'),
    },
    discounts: [],
  });
  const result = await request(`/receipt/${created.transactionHash}`);
  const asset = result.asset;
  assert.ok(asset);
  const state = await request('/state');
  assert.equal(state.ready, true);
  assert.equal(state.calendars.length, 1);
  assert.equal(state.calendars[0].days.length, 365);
  const day = state.today + 1;
  await execute(host, 'list', {
    asset,
    startDay: day,
    endDayExclusive: day + 1,
    sellingPrice: '100000000',
  });
  await execute(host, 'authorize-reporter', { asset });
  assert.equal(
    await read({ address: asset, abi: dayAssetAbi }, 'bookingRelayers', [
      relayer.account.address,
    ]),
    true,
  );
  const curve = await request(`/curve?asset=${asset}&day=${day}`);
  assert.ok(curve.points.length >= 2);
  await write(host, usdc, 'mint', [trader.account.address, 100000000n]);
  const deadline = String((await client.getBlock()).timestamp + 3600n);
  await execute(trader, 'publish-bid', {
    asset,
    startDay: day,
    endDayExclusive: day + 1,
    maxTotal: '100000000',
    nonce: '1',
    deadline,
    salt: zeroHash,
  });
  const open = await request(`/state?account=${trader.account.address}`);
  assert.equal(open.bids.length, 1);
  assert.equal(open.usdcBalance, '100000000');
  const taker = new DayTaker(db, index, client, relayer, config);
  await taker.tick();
  await taker.tick();
  const filled = await request(`/state?account=${trader.account.address}`);
  assert.equal(filled.bids.length, 0);
  assert.equal(filled.usdcBalance, '0');
  assert.equal(
    filled.calendars[0].days.find((d) => d.day === day).owner.toLowerCase(),
    trader.account.address.toLowerCase(),
  );
});
