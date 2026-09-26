import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
import { RevenueClient, bookingStrategy } from '../src/revenue.mjs';
import { Store } from '../src/store.mjs';
import { OrderBook } from '../src/orders.mjs';
import { Matcher } from '../src/matcher.mjs';
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

test(
  'Aqua-backed claim resale, guest booking, and funded payout to the buyer',
  { timeout: 90000 },
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
    const publicClient = createPublicClient({
      chain: foundry,
      transport,
      pollingInterval: 10,
      cacheTime: 0,
    });
    for (let attempt = 0; ; attempt++) {
      try {
        await publicClient.getChainId();
        break;
      } catch (error) {
        if (attempt === 40) throw error;
        await sleep(100);
      }
    }
    const wallets = Array.from({ length: 4 }, () =>
      createWalletClient({
        chain: foundry,
        transport,
        account: privateKeyToAccount(generatePrivateKey()),
      }),
    );
    const [seller, buyer, reseller, guest] = wallets;
    for (const wallet of wallets)
      await publicClient.request({
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
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
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
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      assert.equal(receipt.status, 'success');
      return { address: receipt.contractAddress, abi: a.abi };
    };
    const aqua = await deploy('Aqua.sol/Aqua');
    const usdc = await deploy('Fixture.sol/TestUSDC');
    const inventory = await deploy('RentalInventory.sol/RentalInventory');
    const revenue = await deploy('RentalRevenue.sol/RentalRevenue', [
      aqua.address,
      inventory.address,
      usdc.address,
    ]);
    const claimRouter = await deploy('RentalSwapVM.sol/RentalSwapVM', [
      aqua.address,
      revenue.address,
      usdc.address,
      seller.account.address,
    ]);
    const config = {
      chainId: 31337,
      revenue: revenue.address,
      aqua: aqua.address,
      usdc: usdc.address,
      confirmations: 1,
    };
    const sellerClient = new RevenueClient(publicClient, seller, config);
    const buyerClient = new RevenueClient(publicClient, buyer, config);
    const resellerClient = new RevenueClient(publicClient, reseller, config);
    const guestClient = new RevenueClient(publicClient, guest, config);
    const day = Math.floor(Date.now() / 86400000) + 10;
    const pool = keccak256(toHex('one-attested-room'));
    const terms = keccak256(toHex('one-day-nonrefundable'));
    await send(seller, inventory, 'createPool', [
      pool,
      seller.account.address,
      day,
      day + 2,
      1,
    ]);
    await send(seller, inventory, 'issue', [pool, day, day + 2, terms, 1]);
    await send(seller, inventory, 'setApprovalForAll', [revenue.address, true]);
    await send(seller, usdc, 'mint', [buyer.account.address, 1_000_000n]);
    await send(seller, usdc, 'mint', [guest.account.address, 1_000_000n]);
    await send(buyer, usdc, 'approve', [aqua.address, 1_000_000n]);
    await send(guest, usdc, 'approve', [aqua.address, 1_000_000n]);

    const { claimId } = await sellerClient.createClaim(pool, day, terms);
    assert.equal(
      await publicClient.readContract({
        ...revenue,
        functionName: 'tokenId',
        args: [pool, day, terms],
      }),
      claimId,
    );
    await sellerClient.transferClaim(claimId, reseller.account.address);
    await resellerClient.setPrice(claimId, 200_000n);
    await send(reseller, revenue, 'setApprovalForAll', [
      claimRouter.address,
      true,
    ]);

    const saleMandate = {
      buyer: buyer.account.address,
      app: claimRouter.address,
      token: usdc.address,
      limit: 101_000n,
      expiry: BigInt(Math.floor(Date.now() / 1000) + 3600),
      salt: keccak256(toHex('claim-sale')),
    };
    await send(buyer, aqua, 'ship', [
      claimRouter.address,
      encodeAbiParameters([routerAbi[0].inputs[4]], [saleMandate]),
      [usdc.address],
      [101_000n],
    ]);
    const saleProgram = `0x9e20${toHex(100_000n, { size: 32 }).slice(2)}540180`;
    const saleConfig = {
      chainId: 31337,
      router: claimRouter.address,
      usdc: usdc.address,
    };
    const saleOrder = async (wallet, buy) => {
      const order = {
        maker: wallet.account.address,
        buy,
        pool,
        startDay: day,
        endDay: day + 1,
        quantity: 1,
        terms,
        recipient: wallet.account.address,
        priceLimit: buy ? 101_000n : 1n,
        maxFee: 1_000n,
        expiry: saleMandate.expiry,
        nonce: 1n,
        group: ZERO_HASH,
        mandate: buy ? hashMandate(saleMandate) : ZERO_HASH,
        programHash: keccak256(saleProgram),
      };
      const signature = await wallet.signTypedData({
        domain: orderDomain(saleConfig),
        types: orderTypes,
        primaryType: 'Order',
        message: order,
      });
      const envelope = {
        order: JSON.parse(
          JSON.stringify(order, (_, value) =>
            typeof value === 'bigint' ? value.toString() : value,
          ),
        ),
        signature,
        program: saleProgram,
        ...(buy
          ? {
              mandate: JSON.parse(
                JSON.stringify(saleMandate, (_, value) =>
                  typeof value === 'bigint' ? value.toString() : value,
                ),
              ),
            }
          : {}),
      };
      return book.submit(envelope);
    };
    const directory = mkdtempSync(join(tmpdir(), 'rental-claim-sale-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const store = new Store(join(directory, 'orders.sqlite'));
    t.after(() => store.close());
    const book = new OrderBook(store, publicClient, saleConfig);
    const bid = await saleOrder(buyer, true);
    const ask = await saleOrder(reseller, false);
    const matcher = new Matcher(store, book, publicClient, seller, saleConfig);
    const sale = await matcher.submit(bid.hash, ask.hash);
    assert.equal(
      (
        await publicClient.waitForTransactionReceipt({
          hash: sale.transactionHash,
        })
      ).status,
      'success',
    );
    assert.equal(
      await publicClient.readContract({
        ...revenue,
        functionName: 'balanceOf',
        args: [buyer.account.address, claimId],
      }),
      1n,
    );
    assert.equal(
      await publicClient.readContract({
        ...usdc,
        functionName: 'balanceOf',
        args: [reseller.account.address],
      }),
      100_000n,
    );
    await buyerClient.setPrice(claimId, 250_000n);
    const mandate = {
      buyer: guest.account.address,
      app: revenue.address,
      token: usdc.address,
      claimId,
      beneficiary: guest.account.address,
      price: 250_000n,
      expiry: BigInt(Math.floor(Date.now() / 1000) + 3600),
      salt: keccak256(toHex('guest-booking')),
    };
    const strategy = bookingStrategy(mandate);
    assert.equal(
      strategy.hash,
      await publicClient.readContract({
        ...revenue,
        functionName: 'hashMandate',
        args: [mandate],
      }),
    );
    assert.equal(
      (await guestClient.shipBooking(mandate)).mandateHash,
      strategy.hash,
    );
    const guestBefore = await publicClient.readContract({
      ...usdc,
      functionName: 'balanceOf',
      args: [guest.account.address],
    });
    const { reservationId } = await sellerClient.book(claimId, mandate);
    assert.equal(reservationId, 1n);
    assert.equal(
      await publicClient.readContract({
        ...usdc,
        functionName: 'balanceOf',
        args: [guest.account.address],
      }),
      guestBefore - 250_000n,
    );
    assert.equal(
      await publicClient.readContract({
        ...usdc,
        functionName: 'balanceOf',
        args: [revenue.address],
      }),
      250_000n,
    );
    assert.equal(
      await publicClient.readContract({
        ...revenue,
        functionName: 'escrowedRevenue',
      }),
      250_000n,
    );
    assert.equal(
      await publicClient.readContract({
        ...inventory,
        functionName: 'consumed',
        args: [pool, day],
      }),
      1n,
    );
    const reservation = await publicClient.readContract({
      ...inventory,
      functionName: 'reservations',
      args: [reservationId],
    });
    assert.equal(reservation[0].toLowerCase(), revenue.address.toLowerCase());
    assert.equal(
      reservation[1].toLowerCase(),
      guest.account.address.toLowerCase(),
    );
    await assert.rejects(sellerClient.book(claimId, mandate));
    await assert.rejects(buyerClient.claimRevenue(claimId));

    const unbooked = await sellerClient.createClaim(pool, day + 1, terms);

    const firstDayEnd = BigInt(day + 1) * 86400n;
    await publicClient.request({
      method: 'evm_setNextBlockTimestamp',
      params: [toHex(firstDayEnd)],
    });
    await publicClient.request({ method: 'evm_mine' });
    assert.equal((await buyerClient.claimRevenue(claimId)).amount, 250_000n);
    assert.equal(
      await publicClient.readContract({
        ...usdc,
        functionName: 'balanceOf',
        args: [buyer.account.address],
      }),
      1_000_000n - 101_000n + 250_000n,
    );
    assert.equal(
      await publicClient.readContract({
        ...revenue,
        functionName: 'escrowedRevenue',
      }),
      0n,
    );
    await assert.rejects(buyerClient.claimRevenue(claimId));

    await publicClient.request({
      method: 'evm_setNextBlockTimestamp',
      params: [toHex(BigInt(day + 2) * 86400n)],
    });
    await publicClient.request({ method: 'evm_mine' });
    await sellerClient.withdrawUnbooked(unbooked.claimId);
    assert.equal(
      await publicClient.readContract({
        ...inventory,
        functionName: 'consumed',
        args: [pool, day + 1],
      }),
      0n,
    );
    assert.equal(
      await publicClient.readContract({
        ...usdc,
        functionName: 'balanceOf',
        args: [seller.account.address],
      }),
      1_000n,
    );
  },
);
