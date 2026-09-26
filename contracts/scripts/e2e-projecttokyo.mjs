#!/usr/bin/env node
// Anvil-fork e2e for ProjectTokyo ENS. Does not send real Sepolia transactions.
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createPublicClient,
  createWalletClient,
  http,
  parseAbi,
  keccak256,
  toBytes,
} from 'viem';
import { foundry, sepolia } from 'viem/chains';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const RPC =
  process.env.SEPOLIA_RPC_URL ?? 'https://ethereum-sepolia-rpc.publicnode.com';
const PORT = process.env.ANVIL_PORT ?? '8547';
const OWNER = '0x92f6055f1a631E3C5fd3100920c63d8654729847';
const HOST = '0x000000000000000000000000000000000000A11c';
const TRADER = '0x0000000000000000000000000000000000000B0b';
const ANVIL = `http://127.0.0.1:${PORT}`;

function artifact(name) {
  return JSON.parse(
    readFileSync(
      join(ROOT, 'contracts/out', `${name}.sol`, `${name}.json`),
      'utf8',
    ),
  );
}

function waitFor(proc) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(
      () => reject(new Error('anvil start timeout')),
      60_000,
    );
    proc.stdout.on('data', (buf) => {
      if (String(buf).includes('Listening')) {
        clearTimeout(t);
        resolve();
      }
    });
    proc.stderr.on('data', (buf) => process.stderr.write(buf));
    proc.on('exit', (code) => reject(new Error(`anvil exited ${code}`)));
  });
}

const anvil = spawn(
  `${process.env.HOME}/.foundry/bin/anvil`,
  ['--fork-url', RPC, '--port', PORT, '--silent'],
  { stdio: ['ignore', 'pipe', 'pipe'] },
);
process.on('exit', () => anvil.kill('SIGTERM'));

try {
  await waitFor(anvil);
  const [
    { setup, createAsset, updateAssetRecords, transferDay },
    { createEnsClients },
    lookup,
    filter,
  ] = await Promise.all([
    import('../../apps/web/lib/ens/names.ts'),
    import('../../apps/web/lib/ens/client.ts'),
    import('../../apps/web/lib/ens/lookup.ts'),
    import('../../apps/web/lib/ens/filter.ts'),
  ]);

  const pub = createPublicClient({ chain: sepolia, transport: http(ANVIL) });
  const rpc = (method, params = []) => pub.request({ method, params });
  await rpc('anvil_impersonateAccount', [OWNER]);
  await rpc('anvil_setBalance', [OWNER, '0x56BC75E2D63100000']);
  await rpc('anvil_setBalance', [HOST, '0x56BC75E2D63100000']);
  await rpc('anvil_setBalance', [TRADER, '0x56BC75E2D63100000']);

  const wallet = createWalletClient({
    chain: sepolia,
    transport: http(ANVIL),
    account: OWNER,
  });
  const clients = {
    public: createPublicClient({
      chain: sepolia,
      transport: http(ANVIL),
      batch: { multicall: true },
    }),
    wallet,
  };

  const deployed = await setup(clients, {
    inventory: artifact('ProjectTokyoInventory').bytecode.object,
    names: artifact('ProjectTokyoNames').bytecode.object,
  });
  console.log('deployed', deployed);

  const label = `testasset${String(Math.floor(Math.random() * 100000)).padStart(5, '0')}`;
  const created = await createAsset(clients, deployed, label, HOST, {
    kind: 'car',
    title: 'Fork car',
    location: 'Tokyo',
    discounts: '{"3":10,"7":20}',
  });
  console.log(
    'created',
    label,
    created.startDay.toString(),
    created.endDay.toString(),
    'txs',
    created.hashes.length,
  );
  if (created.endDay - created.startDay !== 365n)
    throw new Error('expected 365-day horizon');

  const first = `${await clients.public.readContract({
    address: deployed.names,
    abi: parseAbi(['function dateLabel(uint32) pure returns (string)']),
    functionName: 'dateLabel',
    args: [Number(created.startDay)],
  })}.${label}.projecttokyo.eth`;
  const lastDay = created.endDay - 1n;
  const last = `${await clients.public.readContract({
    address: deployed.names,
    abi: parseAbi(['function dateLabel(uint32) pure returns (string)']),
    functionName: 'dateLabel',
    args: [Number(lastDay)],
  })}.${label}.projecttokyo.eth`;

  const resolved = await lookup.resolveDay(clients, first);
  const resolvedLast = await lookup.resolveDay(clients, last);
  if (
    !resolved.addr ||
    resolved.addr.toLowerCase() !== deployed.inventory.toLowerCase()
  ) {
    throw new Error(`first day addr ${resolved.addr}`);
  }
  if (
    !resolvedLast.token?.includes(
      deployed.inventory.toLowerCase().slice(2)
        ? deployed.inventory.toLowerCase()
        : '',
    )
  ) {
    const parsed = lookup.parseCaip19(resolvedLast.token ?? '');
    if (
      !parsed ||
      parsed.contract.toLowerCase() !== deployed.inventory.toLowerCase()
    ) {
      throw new Error(`last token ${resolvedLast.token}`);
    }
  }
  const parsed = lookup.parseCaip19(resolved.token ?? '');
  if (!parsed) throw new Error(`bad token ${resolved.token}`);

  const records = await lookup.getAssetRecords(clients, label);
  if (records.title !== 'Fork car') throw new Error(`title ${records.title}`);

  const meta = await lookup.readDayMetadata(clients, deployed.inventory, [
    parsed.id,
  ]);
  if (!meta[0].minted || meta[0].holder.toLowerCase() !== HOST.toLowerCase()) {
    throw new Error('holder metadata');
  }

  const hostWallet = createWalletClient({
    chain: sepolia,
    transport: http(ANVIL),
    account: HOST,
  });
  await rpc('anvil_impersonateAccount', [HOST]);
  const hostClients = { public: clients.public, wallet: hostWallet };
  await transferDay(hostClients, deployed.inventory, HOST, TRADER, parsed.id);
  const after = await lookup.readDayMetadata(clients, deployed.inventory, [
    parsed.id,
  ]);
  if (after[0].holder.toLowerCase() !== TRADER.toLowerCase())
    throw new Error('trade did not move holder');

  const traderWallet = createWalletClient({
    chain: sepolia,
    transport: http(ANVIL),
    account: TRADER,
  });
  await rpc('anvil_impersonateAccount', [TRADER]);
  await createPublicClient({ chain: sepolia, transport: http(ANVIL) })
    .simulateContract({
      account: HOST,
      address: deployed.inventory,
      abi: parseAbi(['function setListing(uint256,bool,uint128)']),
      functionName: 'setListing',
      args: [parsed.id, false, 1n],
    })
    .then(
      () => {
        throw new Error('former holder still controls listing');
      },
      () => {},
    );
  const traderClients = { public: clients.public, wallet: traderWallet };
  const { request } = await clients.public.simulateContract({
    account: TRADER,
    address: deployed.inventory,
    abi: parseAbi(['function setListing(uint256,bool,uint128)']),
    functionName: 'setListing',
    args: [parsed.id, true, 123000000n],
  });
  await traderWallet.writeContract(request);

  await rpc('anvil_impersonateAccount', [HOST]);
  await hostWallet.writeContract(
    (
      await clients.public.simulateContract({
        account: HOST,
        address: deployed.inventory,
        abi: parseAbi(['function setBooked(uint256,bool)']),
        functionName: 'setBooked',
        args: [parsed.id, true],
      })
    ).request,
  );
  await traderWallet.writeContract(
    (
      await clients.public.simulateContract({
        account: TRADER,
        address: deployed.inventory,
        abi: parseAbi([
          'function safeTransferFrom(address,address,uint256,uint256,bytes)',
        ]),
        functionName: 'safeTransferFrom',
        args: [TRADER, HOST, parsed.id, 1n, '0x'],
      })
    ).request,
  );
  const booked = await lookup.readDayMetadata(clients, deployed.inventory, [
    parsed.id,
  ]);
  if (
    !booked[0].booked ||
    booked[0].holder.toLowerCase() !== HOST.toLowerCase()
  ) {
    throw new Error('booked token was not tradable');
  }

  const hidden = await lookup.listAssets(
    clients,
    deployed.assetRegistry,
    0n,
    false,
  );
  const shown = await lookup.listAssets(
    clients,
    deployed.assetRegistry,
    0n,
    true,
  );
  if (hidden.includes(label))
    throw new Error('testasset leaked into default list');
  if (!shown.includes(label)) throw new Error('includeTest missing asset');
  if (filter.filterLabels([label, 'tesla-model-3']).includes(label)) {
    throw new Error('filter helper failed');
  }

  const dayReg = await lookup.dayRegistryOf(
    clients,
    deployed.assetRegistry,
    label,
  );
  const days = await lookup.listDays(clients, dayReg, 0n, true);
  if (days.length !== 365)
    throw new Error(`expected 365 day labels, got ${days.length}`);

  await updateAssetRecords(hostClients, deployed.names, label, {
    description: 'updated',
  });
  const afterRec = await lookup.getAssetRecords(clients, label);
  if (afterRec.description !== 'updated')
    throw new Error('host record update failed');

  console.log('e2e ok', {
    label,
    days: days.length,
    token: resolved.token,
    inventory: deployed.inventory,
  });
} finally {
  anvil.kill('SIGTERM');
}
