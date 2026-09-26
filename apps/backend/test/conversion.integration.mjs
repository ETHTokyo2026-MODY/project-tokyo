import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { keccak256, toHex } from 'viem';
import { foundry } from 'viem/chains';
import { Store } from '../src/store.mjs';
import { OrderBook } from '../src/orders.mjs';
import { Matcher } from '../src/matcher.mjs';
import {
  ConversionRelay,
  intentDomain,
  intentTypes,
} from '../src/conversion.mjs';
import { rentalStrategy, ZERO_HASH } from '../src/protocol.mjs';
import { StrategyWallet } from '../src/wallet.mjs';
import { localChain } from './local-chain.mjs';

test(
  'persisted conversion settles Aqua orders and recovers a prepared conversion',
  { timeout: 120000 },
  async (t) => {
    const {
      client,
      wallets,
      write: send,
      deploy: nativeDeploy,
    } = await localChain(t);
    const [seller, buyer, other, relayer] = wallets;
    const deploy = (path, args = []) => {
      const [file, name] = path.split('/');
      return nativeDeploy(name, args, file.replace(/\.sol$/, ''));
    };
    const aqua = await deploy('AquaVapor.sol/AquaVapor');
    const usdc = await deploy('Fixture.sol/TestUSDC');
    const inventory = await deploy('RentalInventory.sol/RentalInventory');
    const router = await deploy('AssetSwapVM.sol/AssetSwapVM', [
      aqua.address,
      usdc.address,
    ]);
    const weth = await deploy('AtomicConversion.t.sol/TestSource');
    const swap = await deploy('AtomicConversion.t.sol/TestSingleRouter', [
      weth.address,
      usdc.address,
    ]);
    await send(seller, swap, 'setOutput', [1_200_000n]);
    const converter = await deploy(
      'AssetAtomicConverter.sol/AssetAtomicConverter',
      [router.address, swap.address, weth.address, usdc.address, 500],
    );
    const config = {
      chainId: foundry.id,
      router: router.address,
      aqua: aqua.address,
      usdc: usdc.address,
      confirmations: 1,
    };
    const relayConfig = {
      ...config,
      executor: converter.address,
      swapRouter: swap.address,
      sourceToken: weth.address,
      poolFee: 500,
      confirmations: 1,
    };
    const directory = mkdtempSync(join(tmpdir(), 'rental-conversion-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const store = new Store(join(directory, 'orders.sqlite'));
    t.after(() => store.close());
    const book = new OrderBook(store, client, config);
    const relay = new ConversionRelay(book, client, relayer, relayConfig);
    const latest = await client.getBlock({ blockTag: 'latest' });
    const day = Number(latest.timestamp / 86400n) + 10;
    const expiry = latest.timestamp + 3600n;
    const pool = keccak256(toHex('conversion-room'));
    const terms = keccak256(toHex('conversion-terms'));
    await send(seller, inventory, 'createPool', [
      pool,
      seller.account.address,
      day,
      day + 1,
      4,
    ]);
    await send(seller, inventory, 'issue', [pool, day, day + 1, terms, 4]);
    await send(seller, inventory, 'setApprovalForAll', [aqua.address, true]);
    await send(seller, weth, 'mint', [buyer.account.address, 2n * 10n ** 16n]);
    await send(buyer, weth, 'approve', [converter.address, 2n * 10n ** 16n]);
    await send(buyer, usdc, 'approve', [aqua.address, 2_020_000n]);
    await send(seller, usdc, 'mint', [other.account.address, 2_400_000n]);
    await send(other, usdc, 'approve', [aqua.address, 2_400_000n]);
    const tokenId = await client.readContract({
      ...inventory,
      functionName: 'tokenId',
      args: [pool, day, terms],
    });
    async function order(wallet, buy, nonce) {
      const strategy = rentalStrategy(
        {
          maker: wallet.account.address,
          inventory: inventory.address,
          pool,
          startDay: day,
          endDay: day + 1,
          quantity: 1,
          terms,
          buy,
          price: buy ? 1_010_000n : 1_000_000n,
          expiry,
          nonce,
          salt: toHex(nonce, { size: 32 }),
        },
        config,
      );
      await new StrategyWallet(client, wallet, config).ship(strategy);
      return book.submit({ strategy });
    }
    const bid1 = await order(buyer, true, 1n);
    const ask1 = await order(seller, false, 1n);
    const intent = (bid, ask, nonce) => ({
      buyer: buyer.account.address,
      bidHash: bid.hash,
      askHash: ask.hash,
      sourceToken: weth.address,
      maxInput: 10n ** 16n,
      minOutput: 1_100_000n,
      usdcCap: 1_010_000n,
      recipient: buyer.account.address,
      deadline: expiry,
      chainId: BigInt(foundry.id),
      executor: converter.address,
      nonce,
    });
    const signIntent = (i) =>
      buyer.signTypedData({
        domain: intentDomain(relayConfig),
        types: intentTypes,
        primaryType: 'FundingIntent',
        message: i,
      });
    const first = intent(bid1, ask1, 1n);
    // Conversion must roll back even when the swap succeeds but settlement violates the signed cap.
    const beforeInput = await client.readContract({
      ...weth,
      functionName: 'balanceOf',
      args: [buyer.account.address],
    });
    for (const mutation of [
      { usdcCap: 999_999n },
      { minOutput: 1_300_000n },
      { askHash: ZERO_HASH },
      { deadline: 1n },
    ]) {
      const bad = { ...first, ...mutation };
      await assert.rejects(
        client.simulateContract({
          ...converter,
          functionName: 'execute',
          args: [bad, await signIntent(bad), bid1.strategy, ask1.strategy],
          account: relayer.account,
        }),
      );
      assert.equal(
        await client.readContract({
          ...converter,
          functionName: 'used',
          args: [buyer.account.address, 1n],
        }),
        false,
      );
      assert.equal(
        await client.readContract({
          ...weth,
          functionName: 'balanceOf',
          args: [buyer.account.address],
        }),
        beforeInput,
      );
    }
    // Mining a failed cap check must also leave the input, nonce and ERC-1155 ownership untouched.
    const capped = { ...first, usdcCap: 999_999n };
    const failedHash = await relayer.writeContract({
      ...converter,
      functionName: 'execute',
      args: [capped, await signIntent(capped), bid1.strategy, ask1.strategy],
      gas: 2_000_000n,
    });
    assert.equal(
      (await client.waitForTransactionReceipt({ hash: failedHash })).status,
      'reverted',
    );
    assert.equal(
      await client.readContract({
        ...weth,
        functionName: 'balanceOf',
        args: [buyer.account.address],
      }),
      beforeInput,
    );
    assert.equal(
      await client.readContract({
        ...converter,
        functionName: 'used',
        args: [buyer.account.address, 1n],
      }),
      false,
    );

    const ordinary = await relay.submit({
      bidHash: bid1.hash,
      askHash: ask1.hash,
      intent: first,
      intentSig: await signIntent(first),
    });
    assert.equal(ordinary.state, 'confirmed');
    assert.equal(ordinary.output, 1_200_000n);
    assert.equal(ordinary.buyerPrice, 1_000_000n);
    assert.equal(ordinary.conversionSurplus, 200_000n);
    assert.equal(
      await client.readContract({
        ...inventory,
        functionName: 'balanceOf',
        args: [buyer.account.address, tokenId],
      }),
      1n,
    );
    assert.equal(
      await client.readContract({
        ...usdc,
        functionName: 'balanceOf',
        args: [buyer.account.address],
      }),
      200_000n,
    );
    const independentBid = await order(other, true, 4n);
    const independentAsk = await order(seller, false, 4n);
    const matcher = new Matcher(store, book, client, relayer, config);
    const ordinaryJob = await matcher.submit(
      independentBid.hash,
      independentAsk.hash,
    );
    assert.equal(
      (
        await client.waitForTransactionReceipt({
          hash: ordinaryJob.transactionHash,
        })
      ).status,
      'success',
    );
    assert.equal(
      store.db
        .prepare("SELECT nonce FROM submissions WHERE kind = 'ordinary'")
        .get().nonce,
      2,
    );
    const bid2 = await order(buyer, true, 2n);
    const ask2 = await order(seller, false, 2n);
    const second = intent(bid2, ask2, 2n);
    const secondSig = await signIntent(second);
    let interruptSigning = true;
    const crashWallet = new Proxy(relayer, {
      get(target, key) {
        if (key === 'signTransaction' && interruptSigning)
          return async () => {
            interruptSigning = false;
            throw new Error('simulated process crash');
          };
        return target[key];
      },
    });
    const crashingRelay = new ConversionRelay(
      book,
      client,
      crashWallet,
      relayConfig,
    );
    await assert.rejects(
      crashingRelay.submit({
        bidHash: bid2.hash,
        askHash: ask2.hash,
        intent: second,
        intentSig: secondSig,
      }),
      /simulated process crash/,
    );
    const prepared = store.db
      .prepare(
        "SELECT nonce, raw FROM submissions WHERE kind = 'conversion' ORDER BY nonce DESC LIMIT 1",
      )
      .get();
    assert.equal(prepared.raw, null);
    assert.equal(prepared.nonce, 3);
    const recovered = await relay.recover();
    assert.equal(recovered.length, 2);
    assert.equal(recovered[1].state, 'confirmed');
    assert.equal(recovered[1].totalPrice, 1_000_000n);
    assert.equal(
      await client.readContract({
        ...inventory,
        functionName: 'balanceOf',
        args: [buyer.account.address, tokenId],
      }),
      2n,
    );
    assert.equal(
      await client.readContract({
        ...inventory,
        functionName: 'balanceOf',
        args: [other.account.address, tokenId],
      }),
      1n,
    );
    assert.equal(
      await client.readContract({
        ...usdc,
        functionName: 'balanceOf',
        args: [buyer.account.address],
      }),
      400_000n,
    );
    for (const mutation of [
      { input: '0x' },
      { to: '0x0000000000000000000000000000000000000000' },
    ]) {
      const alteredClient = new Proxy(client, {
        get(target, key) {
          if (key === 'getTransaction')
            return async (args) => ({
              ...(await target.getTransaction(args)),
              ...mutation,
            });
          return target[key];
        },
      });
      await assert.rejects(
        new ConversionRelay(book, alteredClient, relayer, relayConfig).status(
          recovered[1].id,
        ),
        /mined call mismatched/,
      );
    }
    for (const wrongEmitter of [false, true]) {
      const alteredClient = new Proxy(client, {
        get(target, key) {
          if (key === 'getTransactionReceipt')
            return async (args) => {
              const receipt = await target.getTransactionReceipt(args);
              return {
                ...receipt,
                logs: wrongEmitter
                  ? receipt.logs.map((log) => ({
                      ...log,
                      address: '0x0000000000000000000000000000000000000000',
                    }))
                  : [],
              };
            };
          return target[key];
        },
      });
      await assert.rejects(
        new ConversionRelay(book, alteredClient, relayer, relayConfig).status(
          recovered[1].id,
        ),
        /settlement events missing/,
      );
    }
    const orphanClient = new Proxy(client, {
      get(target, key) {
        if (key === 'getBlock')
          return async (args) =>
            args.blockNumber === undefined
              ? target.getBlock(args)
              : { ...(await target.getBlock(args)), hash: ZERO_HASH };
        return target[key];
      },
    });
    const orphanRelay = new ConversionRelay(
      book,
      orphanClient,
      relayer,
      relayConfig,
    );
    await assert.rejects(
      orphanRelay.status(recovered[1].id),
      /no longer canonical/,
    );
    const wrongChainClient = new Proxy(client, {
      get(target, key) {
        return key === 'getChainId' ? async () => 1 : target[key];
      },
    });
    const wrongChainRelay = new ConversionRelay(
      book,
      wrongChainClient,
      relayer,
      relayConfig,
    );
    await assert.rejects(
      wrongChainRelay.status(recovered[1].id),
      /chain mismatch/,
    );
  },
);
