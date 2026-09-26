import { DatabaseSync } from 'node:sqlite';
import { createDayServer } from '../src/day-server.mjs';
import { EventIndex } from '../src/event-index.mjs';
import { prepareDayAction } from '../src/day-commands.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getAddress, hashTypedData, parseEventLogs, zeroHash } from 'viem';
import { artifact, localChain } from './local-chain.mjs';
import {
  dayAssetAbi,
  dayRouterAbi,
  officialAquaAbi,
  dayFactoryAbi,
  dayTokenAbi,
  shipDayStrategy,
} from '../src/day-protocol.mjs';
import {
  dayFundingIntent,
  dayFundingTypedData,
  encodeDayConversion,
} from '../src/day-conversion.mjs';

test(
  'maintained conversion consumer signs and atomically settles the real day market',
  { timeout: 30000 },
  async (t) => {
    const { client, wallets, deploy, write, read, receipt } =
      await localChain(t);
    const [host, seller, buyer, taker] = wallets;
    const aqua = await deploy('Aqua'),
      factory = await deploy('RentalAssetFactory');
    const usd = await deploy(
      'ConversionToken',
      ['USDC', 6],
      'DayAtomicConverter.t',
    );
    const weth = await deploy(
      'ConversionToken',
      ['WETH', 18],
      'DayAtomicConverter.t',
    );
    const market = await deploy('DaySwapVM', [
      aqua.address,
      usd.address,
      factory.address,
    ]);
    // Only the external V3 endpoint is mocked; all rental/Aqua/token contracts are current production code.
    const route = await deploy(
      'ConversionRoute',
      [weth.address, usd.address],
      'DayAtomicConverter.t',
    );
    const converter = await deploy('DayAtomicConverter', [
      market.address,
      route.address,
      weth.address,
      500,
    ]);
    const created = await write(host, factory, 'createAsset', [
      zeroHash,
      'conversion-car',
      {
        minimum: 1_000000n,
        listedPrices: Array(7).fill(120_000000n),
        sellingPrices: Array(7).fill(100_000000n),
      },
      [],
    ]);
    const event = parseEventLogs({
      abi: dayFactoryAbi,
      logs: created.logs,
      eventName: 'AssetCreated',
    })[0];
    const asset = { address: event.args.asset, abi: dayAssetAbi },
      start = event.args.startDay;
    const asks = [],
      programs = [],
      tokens = [];
    const send = (wallet, tx) => wallet.sendTransaction(tx).then(receipt);
    for (let i = 0; i < 2; i++) {
      await write(host, asset, 'materialize', [start + i]);
      const token = {
        address: await read(
          { ...asset, abi: artifact('RentalAsset').abi },
          'tokenAddress',
          [start + i],
        ),
        abi: dayTokenAbi,
      };
      tokens.push(token);
      if (i === 1)
        await write(host, token, 'transfer', [seller.account.address, 1n]);
      const owner = i === 1 ? seller : host;
      await write(owner, asset, 'setListing', [
        start + i,
        start + i + 1,
        true,
        100_000000n,
      ]);
      const state = await read(asset, 'dayState', [start + i]);
      const ask = {
        seller: owner.account.address,
        chainId: 31337n,
        app: getAddress(market.address),
        asset: asset.address,
        day: start + i,
        saleNonce: state.saleNonce,
        discountVersion: await read(asset, 'discountVersion'),
        salt: zeroHash,
      };
      asks.push(ask);
      programs.push(
        await read(market, 'program', [asset.address, start + i, 2]),
      );
      await write(owner, token, 'approve', [aqua.address, 1n]);
      await send(
        owner,
        shipDayStrategy({
          aqua: aqua.address,
          kind: 'ask',
          strategy: ask,
          token: token.address,
        }),
      );
    }
    const bid = {
      buyer: buyer.account.address,
      chainId: 31337n,
      app: getAddress(market.address),
      asset: asset.address,
      startDay: start,
      endDayExclusive: start + 2,
      maxTotal: 250_000000n,
      nonce: 1n,
      deadline: Number((await client.getBlock()).timestamp) + 3600,
      salt: zeroHash,
    };
    await write(host, weth, 'mint', [buyer.account.address, 2n * 10n ** 18n]);
    await write(host, usd, 'mint', [buyer.account.address, 17_000000n]);
    const config = {
      chainId: 31337,
      factory: factory.address,
      router: market.address,
      aqua: aqua.address,
      usdc: usd.address,
      conversion: {
        converter: converter.address,
        sourceToken: weth.address,
        swapRouter: route.address,
        poolFee: 500,
      },
    };
    const db = new DatabaseSync(':memory:');
    t.after(() => db.close());
    const events = (abi) => abi.filter((entry) => entry.type === 'event');
    const index = new EventIndex(db, client, {
      chainId: 31337,
      startBlock: Number(created.blockNumber),
      confirmations: 0,
      scope: 'conversion-http',
      sources: [
        { address: factory.address, events: events(dayFactoryAbi) },
        { address: aqua.address, events: events(officialAquaAbi) },
        { address: market.address, events: events(dayRouterAbi) },
      ],
    });
    const server = createDayServer({ client, index, config });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise((resolve) => server.close(resolve)));
    const base = `http://127.0.0.1:${server.address().port}`;
    const prepare = async (action, body) => {
      const response = await fetch(`${base}/prepare`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ actor: buyer.account.address, action, body }),
      });
      const result = await response.json();
      assert.equal(response.status, 200, result.error);
      return result;
    };
    assert.deepEqual(
      (await (await fetch(`${base}/config`)).json()).conversion,
      config.conversion,
    );
    const prepared = await prepare('prepare-conversion', {
      asset: asset.address,
      startDay: start,
      endDayExclusive: start + 2,
      maxTotal: bid.maxTotal.toString(),
      nonce: bid.nonce.toString(),
      deadline: bid.deadline,
      salt: zeroHash,
      maxInput: (10n ** 18n).toString(),
      minOutput: '200000000',
      fundingNonce: '9',
    });
    assert.equal(prepared.transactions.length, 3);
    for (const tx of prepared.transactions)
      await send(buyer, { ...tx, value: 0n });
    const intent = dayFundingIntent({
      converter: converter.address,
      bid,
      asks,
      sourceToken: weth.address,
      maxInput: 10n ** 18n,
      minOutput: 200_000000n,
      usdcCap: bid.maxTotal,
      deadline: bid.deadline,
      nonce: 9n,
    });
    assert.deepEqual(
      prepared.funding.intent,
      JSON.parse(
        JSON.stringify(intent, (_, v) =>
          typeof v === 'bigint' ? String(v) : v,
        ),
      ),
    );
    assert.throws(
      () =>
        dayFundingIntent({
          converter: converter.address,
          bid,
          asks,
          sourceToken: weth.address,
          maxInput: Number.MAX_SAFE_INTEGER + 1,
          minOutput: 1n,
          usdcCap: 1n,
          deadline: bid.deadline,
          nonce: 1n,
        }),
      /exact unsigned/,
    );
    assert.equal(intent.asksHash, await read(converter, 'hashAsks', [asks]));
    assert.equal(
      hashTypedData(dayFundingTypedData(intent)),
      await read(converter, 'hashIntent', [intent]),
    );
    const signature = await buyer.signTypedData({
      ...prepared.funding.typedData,
      domain: { ...prepared.funding.typedData.domain, chainId: 31337 },
    });
    const tx = encodeDayConversion({ intent, signature, bid, asks, programs });
    await write(seller, asset, 'setListing', [
      start + 1,
      start + 2,
      false,
      100_000000n,
    ]);
    await assert.rejects(
      prepareDayAction(
        client,
        config,
        buyer.account.address,
        'execute-conversion',
        { ...prepared.funding, signature },
      ),
    );
    const failed = await client.waitForTransactionReceipt({
      hash: await taker.sendTransaction({ ...tx, gas: 8_000000n }),
    });
    assert.equal(failed.status, 'reverted');
    assert.equal(
      await read(weth, 'balanceOf', [buyer.account.address]),
      2n * 10n ** 18n,
    );
    assert.equal(
      await read(usd, 'balanceOf', [buyer.account.address]),
      17_000000n,
    );
    assert.equal(
      await read(converter, 'used', [buyer.account.address, intent.nonce]),
      false,
    );
    await write(seller, asset, 'setListing', [
      start + 1,
      start + 2,
      true,
      100_000000n,
    ]);
    // Aqua publication remains an ordinary bid: sufficient USDC lets another taker preempt conversion.
    const snapshot = await client.request({ method: 'evm_snapshot' });
    await write(host, usd, 'mint', [buyer.account.address, 200_000000n]);
    await write(taker, market, 'settle', [bid, asks, programs]);
    await assert.rejects(
      prepareDayAction(
        client,
        config,
        buyer.account.address,
        'execute-conversion',
        { ...prepared.funding, signature },
      ),
    );
    assert.equal(
      await read(weth, 'balanceOf', [buyer.account.address]),
      2n * 10n ** 18n,
    );
    assert.equal(
      await read(converter, 'used', [buyer.account.address, intent.nonce]),
      false,
    );
    assert.equal(
      await client.request({ method: 'evm_revert', params: [snapshot] }),
      true,
    );
    const executable = await prepare('execute-conversion', {
      ...prepared.funding,
      signature,
    });
    assert.ok(BigInt(executable.transactions[0].gas) <= 16_777_216n);
    const { gas, ...unsigned } = executable.transactions[0];
    await send(taker, { ...unsigned, gas: BigInt(gas), value: 0n });
    assert.equal(
      await read(usd, 'balanceOf', [buyer.account.address]),
      117_000000n,
    );
    assert.equal(
      await read(usd, 'balanceOf', [host.account.address]),
      100_000000n,
    );
    assert.equal(
      await read(usd, 'balanceOf', [seller.account.address]),
      100_000000n,
    );
    assert.equal(
      await read(weth, 'balanceOf', [buyer.account.address]),
      10n ** 18n,
    );
    assert.equal(
      await read(weth, 'allowance', [converter.address, route.address]),
      0n,
    );
    assert.equal(
      await read(market, 'used', [buyer.account.address, bid.nonce]),
      true,
    );
    for (const token of tokens)
      assert.equal(await read(token, 'balanceOf', [buyer.account.address]), 1n);
  },
);
