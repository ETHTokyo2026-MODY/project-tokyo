import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createPublicClient,
  createWalletClient,
  getAddress,
  http,
  parseAbi,
} from 'viem';
import { sepolia } from 'viem/chains';
import { setup, createAsset, updateAssetRecords, transferDay } from './names';
import {
  dayRegistryOf,
  getAssetRecords,
  listAssets,
  listDays,
  parseCaip19,
  readDayMetadata,
  resolveDay,
} from './lookup';
import { filterLabels } from './filter';
import type { EnsClients } from './client';

const RUN = process.env.RUN_ENS_FORK === '1';
const RPC =
  process.env.SEPOLIA_RPC_URL ?? 'https://ethereum-sepolia-rpc.publicnode.com';
const PORT = process.env.ANVIL_PORT ?? '8547';
const ANVIL = `http://127.0.0.1:${PORT}`;
const OWNER = '0x92f6055f1a631E3C5fd3100920c63d8654729847' as const;
const HOST = getAddress('0x000000000000000000000000000000000000a11c');
const TRADER = getAddress('0x0000000000000000000000000000000000000b0b');

function artifact(name: string) {
  return JSON.parse(
    readFileSync(
      join(process.cwd(), '../../contracts/out', `${name}.sol`, `${name}.json`),
      'utf8',
    ),
  );
}

async function waitForRpc(url: string, proc: ChildProcess) {
  const started = Date.now();
  while (Date.now() - started < 90_000) {
    if (proc.exitCode != null) throw new Error(`anvil exited ${proc.exitCode}`);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'eth_chainId',
          params: [],
        }),
      });
      if (res.ok) return;
    } catch {
      // booting
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('anvil start timeout');
}

describe.skipIf(!RUN)('projecttokyo ens fork', () => {
  let anvil: ChildProcess;
  let clients: EnsClients;
  let hostClients: EnsClients;
  let traderClients: EnsClients;

  beforeAll(async () => {
    const bin =
      process.env.ANVIL_BIN ?? `${process.env.HOME}/.foundry/bin/anvil`;
    anvil = spawn(bin, ['--fork-url', RPC, '--port', PORT], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    await waitForRpc(ANVIL, anvil);
    const pub = createPublicClient({
      chain: sepolia,
      transport: http(ANVIL),
      batch: { multicall: true },
    });
    const rpc = (method: string, params: unknown[] = []) =>
      pub.request({ method: method as never, params: params as never });
    await rpc('anvil_impersonateAccount', [OWNER]);
    await rpc('anvil_impersonateAccount', [HOST]);
    await rpc('anvil_impersonateAccount', [TRADER]);
    await rpc('anvil_setBalance', [OWNER, '0x56BC75E2D63100000']);
    await rpc('anvil_setBalance', [HOST, '0x56BC75E2D63100000']);
    await rpc('anvil_setBalance', [TRADER, '0x56BC75E2D63100000']);
    clients = {
      public: pub,
      wallet: createWalletClient({
        chain: sepolia,
        transport: http(ANVIL),
        account: OWNER,
      }),
    };
    hostClients = {
      public: pub,
      wallet: createWalletClient({
        chain: sepolia,
        transport: http(ANVIL),
        account: HOST,
      }),
    };
    traderClients = {
      public: pub,
      wallet: createWalletClient({
        chain: sepolia,
        transport: http(ANVIL),
        account: TRADER,
      }),
    };
  }, 120_000);

  afterAll(() => {
    anvil?.kill('SIGTERM');
  });

  it('sets up, creates 365 days, resolves, trades, and hides testasset', async () => {
    const deployed = await setup(clients, {
      inventory: artifact('ProjectTokyoInventory').bytecode.object,
      names: artifact('ProjectTokyoNames').bytecode.object,
    });
    const label = `testasset${String(Math.floor(Math.random() * 100000)).padStart(5, '0')}`;
    const created = await createAsset(clients, deployed, label, HOST, {
      kind: 'car',
      title: 'Fork car',
      location: 'Tokyo',
      discounts: '{"3":10,"7":20}',
    });
    expect(created.endDay - created.startDay).toBe(BigInt(365));

    const dateLabel = await clients.public.readContract({
      address: deployed.names,
      abi: parseAbi(['function dateLabel(uint32 day) pure returns (string)']),
      functionName: 'dateLabel',
      args: [Number(created.startDay)],
    });
    const lastLabel = await clients.public.readContract({
      address: deployed.names,
      abi: parseAbi(['function dateLabel(uint32 day) pure returns (string)']),
      functionName: 'dateLabel',
      args: [Number(created.endDay - BigInt(1))],
    });
    const first = await resolveDay(
      clients,
      `${dateLabel}.${label}.projecttokyo.eth`,
    );
    const last = await resolveDay(
      clients,
      `${lastLabel}.${label}.projecttokyo.eth`,
    );
    expect(first.addr?.toLowerCase()).toBe(deployed.inventory.toLowerCase());
    const parsed = parseCaip19(first.token ?? '');
    const parsedLast = parseCaip19(last.token ?? '');
    expect(parsed?.contract.toLowerCase()).toBe(
      deployed.inventory.toLowerCase(),
    );
    expect(parsedLast?.contract.toLowerCase()).toBe(
      deployed.inventory.toLowerCase(),
    );

    const records = await getAssetRecords(clients, label);
    expect(records.title).toBe('Fork car');

    const before = await readDayMetadata(clients, deployed.inventory, [
      parsed!.id,
    ]);
    expect(before[0].holder.toLowerCase()).toBe(HOST.toLowerCase());
    await transferDay(
      hostClients,
      deployed.inventory,
      HOST,
      TRADER,
      parsed!.id,
    );
    const after = await readDayMetadata(clients, deployed.inventory, [
      parsed!.id,
    ]);
    expect(after[0].holder.toLowerCase()).toBe(TRADER.toLowerCase());

    await expect(
      clients.public.simulateContract({
        account: HOST,
        address: deployed.inventory,
        abi: parseAbi([
          'function setListing(uint256 id, bool listed, uint128 sellingPrice)',
        ]),
        functionName: 'setListing',
        args: [parsed!.id, false, BigInt(1)],
      }),
    ).rejects.toThrow();

    await traderClients.wallet!.writeContract(
      (
        await clients.public.simulateContract({
          account: TRADER,
          address: deployed.inventory,
          abi: parseAbi([
            'function setListing(uint256 id, bool listed, uint128 sellingPrice)',
          ]),
          functionName: 'setListing',
          args: [parsed!.id, true, BigInt(123000000)],
        })
      ).request,
    );
    await hostClients.wallet!.writeContract(
      (
        await clients.public.simulateContract({
          account: HOST,
          address: deployed.inventory,
          abi: parseAbi(['function setBooked(uint256 id, bool booked)']),
          functionName: 'setBooked',
          args: [parsed!.id, true],
        })
      ).request,
    );
    await transferDay(
      traderClients,
      deployed.inventory,
      TRADER,
      HOST,
      parsed!.id,
    );
    const booked = await readDayMetadata(clients, deployed.inventory, [
      parsed!.id,
    ]);
    expect(booked[0].booked).toBe(true);
    expect(booked[0].holder.toLowerCase()).toBe(HOST.toLowerCase());

    expect(
      await listAssets(
        clients,
        deployed.assetRegistry,
        deployed.deployBlock,
        false,
      ),
    ).not.toContain(label);
    expect(
      await listAssets(
        clients,
        deployed.assetRegistry,
        deployed.deployBlock,
        true,
      ),
    ).toContain(label);
    expect(filterLabels([label, 'tesla-model-3'])).toEqual(['tesla-model-3']);

    const dayReg = await dayRegistryOf(clients, deployed.assetRegistry, label);
    const days = await listDays(clients, dayReg, deployed.deployBlock, true);
    expect(days).toHaveLength(365);

    await updateAssetRecords(hostClients, deployed.names, label, {
      description: 'updated',
    });
    expect((await getAssetRecords(clients, label)).description).toBe('updated');
  }, 300_000);
});
