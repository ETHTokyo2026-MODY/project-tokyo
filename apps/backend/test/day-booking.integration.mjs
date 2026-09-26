import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { getAddress, parseEventLogs, zeroHash } from 'viem';
import { artifact, localChain } from './local-chain.mjs';
import { DayBookingReporter } from '../src/day-booking.mjs';
import { dayFactoryAbi, dayTokenAbi } from '../src/day-protocol.mjs';

test(
  'trusted host reporter books and reverses a real trader-owned day with durable idempotency',
  { timeout: 30000 },
  async (t) => {
    const { client, wallets, deploy, write, read, receipt } =
      await localChain(t);
    const [host, trader, , relayer] = wallets;
    const factory = await deploy('RentalAssetFactory');
    const creation = await write(host, factory, 'createAsset', [
      zeroHash,
      'ipfs://booking-test',
      {
        minimum: 40_000000n,
        listedPrices: Array(7).fill(120_000000n),
        sellingPrices: Array(7).fill(100_000000n),
      },
      [],
    ]);
    const event = parseEventLogs({
      abi: dayFactoryAbi,
      logs: creation.logs,
      eventName: 'AssetCreated',
    })[0];
    const asset = {
      address: event.args.asset,
      abi: artifact('RentalAsset').abi,
    };
    const day = event.args.startDay + 3;
    await write(host, asset, 'materialize', [day]);
    const token = {
      address: (await read(asset, 'dayState', [day])).token,
      abi: dayTokenAbi,
    };
    await write(host, token, 'transfer', [trader.account.address, 1n]);
    const original = await read(asset, 'dayState', [day]);
    const db = new DatabaseSync(':memory:');
    t.after(() => db.close());
    const config = { chainId: 31337, factory: getAddress(factory.address) };
    let reporter = new DayBookingReporter(db, client, relayer, config);
    const booking = {
      eventId: 'host:book:1',
      host: host.account.address,
      asset: asset.address,
      day,
      booked: true,
      expectedListedPrice: original.listedPrice.toString(),
    };
    await assert.rejects(reporter.report(booking), /not authorized/);
    assert.equal(
      db.prepare('SELECT count(*) AS n FROM submissions').get().n,
      0,
    );
    await write(host, asset, 'setBookingRelayer', [
      relayer.account.address,
      true,
    ]);
    const first = await reporter.report(booking);
    await receipt(first.hash);
    const booked = await read(asset, 'dayState', [day]);
    assert.equal(booked.booked, true);
    assert.equal(booked.listedPrice, original.listedPrice);
    assert.equal(booked.owner, trader.account.address);
    assert.equal(booked.saleNonce, original.saleNonce);
    assert.equal(booked.sellingPrice, original.sellingPrice);
    assert.equal(await read(token, 'balanceOf', [trader.account.address]), 1n);
    const before = db.prepare('SELECT * FROM submissions').get();
    reporter = new DayBookingReporter(
      db,
      client,
      {
        ...relayer,
        signTransaction: async () => {
          throw new Error('Unexpected duplicate signature');
        },
      },
      config,
    );
    assert.deepEqual(await reporter.report(booking), first);
    assert.deepEqual(db.prepare('SELECT * FROM submissions').get(), before);
    assert.equal(
      await client.getTransactionCount({ address: relayer.account.address }),
      1,
    );

    await client.request({
      method: 'evm_setNextBlockTimestamp',
      params: [(event.args.startDay + 1) * 86400 - 32400],
    });
    await client.request({ method: 'evm_mine' });
    const resumedPrice = await read(asset, 'listedPriceAt', [
      day,
      event.args.startDay + 1,
    ]);
    assert.notEqual(resumedPrice, original.listedPrice);
    reporter = new DayBookingReporter(db, client, relayer, config);
    const unbooked = await reporter.report({
      ...booking,
      eventId: 'host:reverse:1',
      booked: false,
    });
    await receipt(unbooked.hash);
    assert.deepEqual(
      await reporter.report({
        ...booking,
        eventId: 'host:reverse:1',
        booked: false,
      }),
      unbooked,
    );
    const state = await read(asset, 'dayState', [day]);
    assert.equal(state.booked, false);
    assert.equal(state.listedPrice, resumedPrice);
    assert.equal(state.owner, trader.account.address);
    assert.equal(
      await client.getTransactionCount({ address: relayer.account.address }),
      2,
    );
    await write(host, asset, 'setBookingRelayer', [
      relayer.account.address,
      false,
    ]);
    await assert.rejects(
      reporter.report({
        ...booking,
        eventId: 'host:book:2',
        expectedListedPrice: resumedPrice.toString(),
      }),
      /not authorized/,
    );
  },
);
