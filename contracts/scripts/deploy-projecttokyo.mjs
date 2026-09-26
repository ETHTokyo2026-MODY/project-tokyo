#!/usr/bin/env node
// Deploy ProjectTokyoNames + register demo-room. Never broadcasts without --send.
// node --experimental-strip-types contracts/scripts/deploy-projecttokyo.mjs --dry-run
// PROJECTTOKYO_DEPLOYER_KEY=0x… node --experimental-strip-types contracts/scripts/deploy-projecttokyo.mjs --send
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicClient, formatEther, formatGwei, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { sepolia } from 'viem/chains';

const DRY = process.argv.includes('--dry-run');
const SEND = process.argv.includes('--send');
if (DRY === SEND) {
  console.error('pass exactly one of --dry-run / --send');
  process.exit(1);
}

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const RPC =
  process.env.SEPOLIA_RPC_URL ?? 'https://ethereum-sepolia-rpc.publicnode.com';
const OWNER = '0x92f6055f1a631E3C5fd3100920c63d8654729847';
const RESERVE_WEI = 3_000_000_000_000_000n; // 0.003 ETH leftover buffer
const ENS = {
  ur: '0xeEeEEEeE14D718C2B47D9923Deab1335E144EeEe',
  root: '0x9703DBD26dAB89504490994138cF2c575251a9cE',
  eth: '0x657eA849311d3D5823348ddEd7C2AaAFb3EDE09E',
  owner: OWNER,
  tokenId:
    1539694647528357085717297762044227324969906285209016262484180021492479688704n,
};
const pub = createPublicClient({ chain: sepolia, transport: http(RPC) });

function artifact(name) {
  return JSON.parse(
    readFileSync(
      join(ROOT, 'contracts/out', `${name}.sol`, `${name}.json`),
      'utf8',
    ),
  );
}

const log = (...a) => console.log(new Date().toISOString(), ...a);

const [root, owner, sub, resolver, chainId, gasPrice, balance] =
  await Promise.all([
    pub.readContract({
      address: ENS.ur,
      abi: [
        {
          type: 'function',
          name: 'ROOT_REGISTRY',
          stateMutability: 'view',
          inputs: [],
          outputs: [{ type: 'address' }],
        },
      ],
      functionName: 'ROOT_REGISTRY',
    }),
    pub.readContract({
      address: ENS.eth,
      abi: [
        {
          type: 'function',
          name: 'ownerOf',
          stateMutability: 'view',
          inputs: [{ type: 'uint256' }],
          outputs: [{ type: 'address' }],
        },
      ],
      functionName: 'ownerOf',
      args: [ENS.tokenId],
    }),
    pub.readContract({
      address: ENS.eth,
      abi: [
        {
          type: 'function',
          name: 'getSubregistry',
          stateMutability: 'view',
          inputs: [{ type: 'string' }],
          outputs: [{ type: 'address' }],
        },
      ],
      functionName: 'getSubregistry',
      args: ['projecttokyo'],
    }),
    pub.readContract({
      address: ENS.eth,
      abi: [
        {
          type: 'function',
          name: 'getResolver',
          stateMutability: 'view',
          inputs: [{ type: 'string' }],
          outputs: [{ type: 'address' }],
        },
      ],
      functionName: 'getResolver',
      args: ['projecttokyo'],
    }),
    pub.getChainId(),
    pub.getGasPrice(),
    pub.getBalance({ address: OWNER }),
  ]);

log('chain', chainId, 'rpc', RPC);
log('UR.ROOT_REGISTRY', root);
log('projecttokyo.eth owner', owner);
log('current subregistry', sub);
log('current resolver', resolver);
log('owner balance ETH', formatEther(balance));
log('gasPrice gwei', formatGwei(gasPrice));

if (root.toLowerCase() !== ENS.root.toLowerCase()) {
  throw new Error('ENSv2 root changed; abort');
}
if (chainId !== 11155111) throw new Error('not Sepolia');

log(
  'plan: deploy ProjectTokyoNames (asset registry via VerifiableFactory), ETHRegistry.setSubregistry(projecttokyo), create RentalAsset demo-room, register 365 day names in 73-day chunks',
);

if (DRY) {
  log('dry-run only; no transactions sent');
  process.exit(0);
}

const key = process.env.PROJECTTOKYO_DEPLOYER_KEY;
if (!key) throw new Error('PROJECTTOKYO_DEPLOYER_KEY required for --send');
const account = privateKeyToAccount(key);
if (account.address.toLowerCase() !== ENS.owner.toLowerCase()) {
  throw new Error('signer is not the recorded projecttokyo.eth owner');
}
log('signer', account.address);

const { setup, createAsset } = await import('../../apps/web/lib/ens/names.ts');
const { createEnsClients } = await import('../../apps/web/lib/ens/client.ts');
const { resolveDay, getAssetRecords } =
  await import('../../apps/web/lib/ens/lookup.ts');
const clients = createEnsClients(RPC, account);
const namesArt = artifact('ProjectTokyoNames');

async function afford(label, gasHint) {
  const left = await pub.getBalance({ address: account.address });
  const cost = gasPrice * gasHint;
  if (left < cost + RESERVE_WEI) {
    log(
      'stop',
      label,
      'balance',
      formatEther(left),
      'need',
      formatEther(cost + RESERVE_WEI),
    );
    return false;
  }
  return true;
}

if (!(await afford('deploy names', 4_000_000n))) process.exit(2);
const deployed = await setup(clients, { names: namesArt.bytecode.object });
log('deployed names', deployed.names);
log('assetRegistry', deployed.assetRegistry);
log('deployBlock', deployed.deployBlock.toString());

const demoLabel = process.env.PROJECTTOKYO_DEMO_LABEL ?? 'demo-room';
const existing = await clients.public.readContract({
  address: deployed.names,
  abi: [
    {
      type: 'function',
      name: 'assetOf',
      stateMutability: 'view',
      inputs: [{ type: 'string' }],
      outputs: [{ type: 'address' }],
    },
  ],
  functionName: 'assetOf',
  args: [demoLabel],
});
let created;
if (existing !== '0x0000000000000000000000000000000000000000') {
  log('demo asset already registered', existing);
  created = { asset: existing, hashes: [], startDay: 0, endDay: 0 };
} else if (await afford('create demo-room + first register', 6_000_000n)) {
  created = await createAsset(
    clients,
    deployed,
    demoLabel,
    {
      kind: 'airbnb',
      title: 'Demo room',
      location: 'Shibuya, Tokyo',
      description: 'ProjectTokyo ENSv2 demo',
    },
    ({ startDay, endDay, hash, gasUsed }) => {
      log(
        'day chunk',
        startDay,
        endDay,
        'tx',
        hash,
        'gasUsed',
        gasUsed?.toString(),
      );
      return undefined;
    },
  );
  log('demo asset', created.asset);
  log(
    'days',
    created.startDay,
    created.endDay,
    'txs',
    created.hashes.length,
    created.stoppedAt ? `stoppedAt ${created.stoppedAt}` : 'complete',
  );
} else {
  created = { asset: '0x0000000000000000000000000000000000000000', hashes: [] };
}

const records = await getAssetRecords(clients, demoLabel).catch(() => null);
if (records)
  log('asset records', records.title, records.kind, records.location);
if (created.startDay) {
  const { dateLabel } = await import('../../apps/web/lib/ens/dates.ts');
  const dayName = `${dateLabel(created.startDay)}.${demoLabel}.projecttokyo.eth`;
  const resolved = await resolveDay(clients, dayName);
  log('resolved', dayName, resolved.addr, resolved.token);
  const assetName = `${demoLabel}.projecttokyo.eth`;
  const assetResolved = await resolveDay(clients, assetName);
  log('resolved', assetName, assetResolved.addr);
}

const deploymentPath = join(ROOT, 'contracts/deployments/sepolia.json');
const recorded = JSON.parse(readFileSync(deploymentPath, 'utf8'));
recorded.ens = {
  names: deployed.names,
  assetRegistry: deployed.assetRegistry,
  deployBlock: Number(deployed.deployBlock),
  parent: 'projecttokyo.eth',
  demoLabel,
  demoAsset:
    created.asset &&
    created.asset !== '0x0000000000000000000000000000000000000000'
      ? created.asset
      : undefined,
  setupTransactions: created.hashes,
};
writeFileSync(deploymentPath, `${JSON.stringify(recorded, null, 2)}\n`);
log('wrote', deploymentPath);
log('final balance ETH', formatEther(await pub.getBalance({ address: OWNER })));
