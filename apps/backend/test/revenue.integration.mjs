import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import net from 'node:net';
import { test } from 'node:test';
import {
  createPublicClient,
  createWalletClient,
  http,
  keccak256,
  toHex,
} from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { foundry } from 'viem/chains';
import { RevenueClient, bookingStrategy } from '../src/revenue.mjs';

const artifact = (path) =>
  JSON.parse(
    readFileSync(
      new URL(`../../../contracts/out/${path}.json`, import.meta.url),
    ),
  );
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test(
  'Aqua-funded booking consumes capacity and transferable claim pays current holder',
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
    await send(buyer, usdc, 'approve', [aqua.address, 1_000_000n]);

    const { claimId } = await sellerClient.createClaim(pool, day, terms);
    await sellerClient.transferClaim(claimId, reseller.account.address);
    await resellerClient.setPrice(claimId, 250_000n);
    const mandate = {
      buyer: buyer.account.address,
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
      (await buyerClient.shipBooking(mandate)).mandateHash,
      strategy.hash,
    );
    const buyerBefore = await publicClient.readContract({
      ...usdc,
      functionName: 'balanceOf',
      args: [buyer.account.address],
    });
    const { reservationId } = await sellerClient.book(claimId, mandate);
    assert.equal(reservationId, 1n);
    assert.equal(
      await publicClient.readContract({
        ...usdc,
        functionName: 'balanceOf',
        args: [buyer.account.address],
      }),
      buyerBefore - 250_000n,
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
    await assert.rejects(resellerClient.claimRevenue(claimId));

    const unbooked = await sellerClient.createClaim(pool, day + 1, terms);

    const firstDayEnd = BigInt(day + 1) * 86400n;
    await publicClient.request({
      method: 'evm_setNextBlockTimestamp',
      params: [toHex(firstDayEnd)],
    });
    await publicClient.request({ method: 'evm_mine' });
    assert.equal((await resellerClient.claimRevenue(claimId)).amount, 250_000n);
    assert.equal(
      await publicClient.readContract({
        ...usdc,
        functionName: 'balanceOf',
        args: [reseller.account.address],
      }),
      250_000n,
    );
    assert.equal(
      await publicClient.readContract({
        ...revenue,
        functionName: 'escrowedRevenue',
      }),
      0n,
    );
    await assert.rejects(resellerClient.claimRevenue(claimId));

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
      0n,
    );
  },
);
