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
import {
  setup,
  createAsset,
  updateAssetRecords,
  materializeDay,
  transferDayToken,
  setDayListing,
} from './names';
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
import { rentalAssetAbi } from './abi';

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
  let ownerClients: EnsClients;
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
    ownerClients = {
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
    const deployed = await setup(ownerClients, {
      names: artifact('ProjectTokyoNames').bytecode.object,
    });
    const label = `testasset${String(Math.floor(Math.random() * 100000)).padStart(5, '0')}`;
    const created = await createAsset(hostClients, deployed, label, {
      kind: 'car',
      title: 'Fork car',
      location: 'Tokyo',
    });
    expect(created.endDay - created.startDay).toBe(365);
    expect(created.asset).toMatch(/^0x[0-9a-fA-F]{40}$/);

    const dateLabel = await ownerClients.public.readContract({
      address: deployed.names,
      abi: parseAbi(['function dateLabel(uint32 day) pure returns (string)']),
      functionName: 'dateLabel',
      args: [created.startDay],
    });
    const lastLabel = await ownerClients.public.readContract({
      address: deployed.names,
      abi: parseAbi(['function dateLabel(uint32 day) pure returns (string)']),
      functionName: 'dateLabel',
      args: [created.endDay - 1],
    });
    const predicted = await ownerClients.public.readContract({
      address: created.asset,
      abi: rentalAssetAbi,
      functionName: 'tokenAddress',
      args: [created.startDay],
    });
    const first = await resolveDay(
      ownerClients,
      `${dateLabel}.${label}.projecttokyo.eth`,
    );
    const last = await resolveDay(
      ownerClients,
      `${lastLabel}.${label}.projecttokyo.eth`,
    );
    expect(first.addr?.toLowerCase()).toBe(predicted.toLowerCase());
    const parsed = parseCaip19(first.token ?? '');
    const parsedLast = parseCaip19(last.token ?? '');
    expect(parsed?.contract.toLowerCase()).toBe(predicted.toLowerCase());
    expect(parsedLast?.contract.toLowerCase()).toBe(
      (
        await ownerClients.public.readContract({
          address: created.asset,
          abi: rentalAssetAbi,
          functionName: 'tokenAddress',
          args: [created.endDay - 1],
        })
      ).toLowerCase(),
    );

    const records = await getAssetRecords(ownerClients, label);
    expect(records.title).toBe('Fork car');

    await materializeDay(hostClients, created.asset, created.startDay);
    const before = await readDayMetadata(
      ownerClients,
      created.asset,
      created.startDay,
      created.startDay + 1,
    );
    expect(before[0].owner.toLowerCase()).toBe(HOST.toLowerCase());
    expect(before[0].token.toLowerCase()).toBe(predicted.toLowerCase());
    await transferDayToken(hostClients, predicted, TRADER);
    const after = await readDayMetadata(
      ownerClients,
      created.asset,
      created.startDay,
      created.startDay + 1,
    );
    expect(after[0].owner.toLowerCase()).toBe(TRADER.toLowerCase());

    await expect(
      ownerClients.public.simulateContract({
        account: HOST,
        address: created.asset,
        abi: rentalAssetAbi,
        functionName: 'setListing',
        args: [created.startDay, created.startDay + 1, false, BigInt(1)],
      }),
    ).rejects.toThrow();

    await setDayListing(
      traderClients,
      created.asset,
      created.startDay,
      true,
      BigInt(123_000000),
    );
    await transferDayToken(traderClients, predicted, HOST);
    const back = await readDayMetadata(
      ownerClients,
      created.asset,
      created.startDay,
      created.startDay + 1,
    );
    expect(back[0].owner.toLowerCase()).toBe(HOST.toLowerCase());
    expect(back[0].deployed).toBe(true);

    expect(
      await listAssets(
        ownerClients,
        deployed.assetRegistry,
        deployed.deployBlock,
        false,
      ),
    ).not.toContain(label);
    expect(
      await listAssets(
        ownerClients,
        deployed.assetRegistry,
        deployed.deployBlock,
        true,
      ),
    ).toContain(label);
    expect(filterLabels([label, 'tesla-model-3'])).toEqual(['tesla-model-3']);

    const dayReg = await dayRegistryOf(
      ownerClients,
      deployed.assetRegistry,
      label,
    );
    const days = await listDays(
      ownerClients,
      dayReg,
      deployed.deployBlock,
      true,
    );
    expect(days).toHaveLength(365);

    await updateAssetRecords(hostClients, deployed.names, label, {
      description: 'updated',
    });
    expect((await getAssetRecords(ownerClients, label)).description).toBe(
      'updated',
    );
  }, 300_000);
});
