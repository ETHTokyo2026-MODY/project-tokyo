#!/usr/bin/env node
// Deploy ProjectTokyo ENS inventory + names. Never broadcasts without --send.
// node contracts/scripts/deploy-projecttokyo.mjs --dry-run
// node contracts/scripts/deploy-projecttokyo.mjs --send
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createPublicClient,
  createWalletClient,
  http,
  formatEther,
} from 'viem';
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
const ENS = {
  ur: '0xeEeEEEeE14D718C2B47D9923Deab1335E144EeEe',
  root: '0x9703DBD26dAB89504490994138cF2c575251a9cE',
  eth: '0x657eA849311d3D5823348ddEd7C2AaAFb3EDE09E',
  owner: '0x92f6055f1a631E3C5fd3100920c63d8654729847',
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

const [root, owner, sub, resolver, chainId] = await Promise.all([
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
]);

log('chain', chainId, 'rpc', RPC);
log('UR.ROOT_REGISTRY', root);
log('projecttokyo.eth owner', owner);
log('current subregistry', sub);
log('current resolver', resolver);

if (root.toLowerCase() !== ENS.root.toLowerCase()) {
  throw new Error('ENSv2 root changed; abort');
}
if (chainId !== 11155111) throw new Error('not Sepolia');

log(
  'plan: deploy ProjectTokyoInventory, ProjectTokyoNames (asset registry via VerifiableFactory), inventory.setNames, names.linkParent, ETHRegistry.setSubregistry(projecttokyo)',
);
log('then createAsset + mintDays in 73-day chunks (see apps/web/lib/ens)');

if (DRY) {
  log('dry-run only; no transactions sent');
  process.exit(0);
}

const key = process.env.PROJECTTOKYO_DEPLOYER_KEY;
if (!key) throw new Error('PROJECTTOKYO_DEPLOYER_KEY required for --send');
const account = privateKeyToAccount(key);
if (account.address.toLowerCase() !== ENS.owner.toLowerCase()) {
  log(
    'warning: signer',
    account.address,
    'is not the recorded projecttokyo.eth owner',
  );
}
const wallet = createWalletClient({
  chain: sepolia,
  transport: http(RPC),
  account,
});
log(
  'signer',
  account.address,
  'balance',
  formatEther(await pub.getBalance({ address: account.address })),
);

const { setup } = await import('../../apps/web/lib/ens/names.ts');
const { createEnsClients } = await import('../../apps/web/lib/ens/client.ts');
const clients = createEnsClients(RPC, account);
const inventoryArt = artifact('ProjectTokyoInventory');
const namesArt = artifact('ProjectTokyoNames');
const deployed = await setup(clients, {
  inventory: inventoryArt.bytecode.object,
  names: namesArt.bytecode.object,
});
log(JSON.stringify(deployed, null, 2));
