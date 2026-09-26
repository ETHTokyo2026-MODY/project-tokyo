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
  encodeAbiParameters,
  http,
  keccak256,
  toHex,
} from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { foundry } from 'viem/chains';
import { Store } from '../src/store.mjs';
import { OrderBook } from '../src/orders.mjs';
import { Matcher } from '../src/matcher.mjs';
import {
  ConversionRelay,
  intentDomain,
  intentTypes,
} from '../src/conversion.mjs';
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
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const json = (value) =>
  JSON.parse(
    JSON.stringify(value, (_, v) => (typeof v === 'bigint' ? v.toString() : v)),
  );

test(
  'persisted conversion settles Aqua orders and recovers a prepared conversion',
  { timeout: 120000 },
  async (t) => {
    const port = await new Promise((resolve) => {
      const socket = net.createServer().listen(0, '127.0.0.1', () => {
        const selected = socket.address().port;
        socket.close(() => resolve(selected));
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
      } catch (error) {
        if (attempt === 40) throw error;
        await sleep(100);
      }
    }
    const [seller, buyer, other, relayer] = Array.from({ length: 4 }, () =>
      createWalletClient({
        chain: foundry,
        transport,
        account: privateKeyToAccount(generatePrivateKey()),
      }),
    );
    for (const wallet of [seller, buyer, other, relayer])
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
      return { address: receipt.contractAddress, abi: a.abi };
    };
    const aqua = await deploy('Aqua.sol/Aqua');
    const usdc = await deploy('Fixture.sol/TestUSDC');
    const inventory = await deploy('RentalInventory.sol/RentalInventory');
    const router = await deploy('RentalSwapVM.sol/RentalSwapVM', [
      aqua.address,
      inventory.address,
      usdc.address,
      relayer.account.address,
    ]);
    const weth = await deploy('AtomicConversion.t.sol/TestSource');
    const swap = await deploy('AtomicConversion.t.sol/TestSingleRouter', [
      weth.address,
      usdc.address,
    ]);
    await send(seller, swap, 'setOutput', [1_200_000n]);
    const converter = await deploy(
      'RentalAtomicConverter.sol/RentalAtomicConverter',
      [router.address, swap.address, weth.address, usdc.address, 500],
    );
    const config = {
      chainId: foundry.id,
      router: router.address,
      usdc: usdc.address,
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
    await send(seller, inventory, 'setApprovalForAll', [router.address, true]);
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
    const fixed = `0x9e20${toHex(1_000_000n, { size: 32 }).slice(2)}540180`;
    async function mandate(wallet, salt) {
      const m = {
        buyer: wallet.account.address,
        app: router.address,
        token: usdc.address,
        limit: 1_010_000n,
        expiry,
        salt: keccak256(toHex(salt)),
      };
      await send(wallet, aqua, 'ship', [
        router.address,
        encodeAbiParameters([routerAbi[0].inputs[4]], [m]),
        [usdc.address],
        [m.limit],
      ]);
      return m;
    }
    const firstMandate = await mandate(buyer, 'ordinary');
    const secondMandate = await mandate(buyer, 'second');
    const otherOrdinaryMandate = await mandate(other, 'other-ordinary');
    async function order(wallet, buy, nonce, program, m) {
      const o = {
        maker: wallet.account.address,
        buy,
        pool,
        startDay: day,
        endDay: day + 1,
        quantity: 1,
        terms,
        recipient: wallet.account.address,
        priceLimit: buy ? 1_010_000n : 1n,
        maxFee: 10_000n,
        expiry,
        nonce,
        group: ZERO_HASH,
        mandate: buy ? hashMandate(m) : ZERO_HASH,
        programHash: keccak256(program),
      };
      const sig = await wallet.signTypedData({
        domain: orderDomain(config),
        types: orderTypes,
        primaryType: 'Order',
        message: o,
      });
      return book.submit(
        json({
          order: o,
          signature: sig,
          program,
          ...(buy ? { mandate: m } : {}),
        }),
      );
    }
    const bid1 = await order(buyer, true, 1n, fixed, firstMandate);
    const ask1 = await order(seller, false, 1n, fixed);
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
    const ordinary = await relay.submit({
      bidHash: bid1.hash,
      askHash: ask1.hash,
      intent: first,
      intentSig: await signIntent(first),
    });
    assert.equal(ordinary.state, 'confirmed');
    assert.equal(ordinary.output, 1_200_000n);
    assert.equal(ordinary.buyerPrice, 1_000_000n);
    assert.equal(ordinary.buyerFee, 10_000n);
    assert.equal(ordinary.conversionSurplus, 190_000n);
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
      190_000n,
    );
    const independentBid = await order(
      other,
      true,
      4n,
      fixed,
      otherOrdinaryMandate,
    );
    const independentAsk = await order(seller, false, 4n, fixed);
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
      1,
    );
    const bid2 = await order(buyer, true, 2n, fixed, secondMandate);
    const ask2 = await order(seller, false, 2n, fixed);
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
    assert.equal(prepared.nonce, 2);
    const recovered = await relay.recover();
    assert.equal(recovered.length, 2);
    assert.equal(recovered[1].state, 'confirmed');
    assert.equal(recovered[1].totalPrice, 1_000_000n);
    assert.equal(recovered[1].totalFee, 10_000n);
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
      380_000n,
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
