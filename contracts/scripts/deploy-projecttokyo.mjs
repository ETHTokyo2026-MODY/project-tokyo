#!/usr/bin/env node
// Deploy ProjectTokyoNames + register demo-room. Never broadcasts without --send.
// node --experimental-strip-types contracts/scripts/deploy-projecttokyo.mjs --dry-run
// PROJECTTOKYO_DEPLOYER_KEY=0x… node --experimental-strip-types contracts/scripts/deploy-projecttokyo.mjs --send
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createPublicClient,
  createWalletClient,
  formatEther,
  formatGwei,
  http,
  keccak256,
  parseAbi,
  stringToBytes,
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

const wallet = createWalletClient({
  chain: sepolia,
  transport: http(RPC),
  account,
});
const namesArt = artifact('ProjectTokyoNames');
const namesAbi = parseAbi([
  'constructor(address ensFactory_, address userRegistryImpl_, address permissionedResolverImpl_, address ethRegistry_, string parentLabel_, address rentalFactory_)',
  'function assetRegistry() view returns (address)',
  'function assetOf(string label) view returns (address)',
  'function registerAsset(string label, address rentalAsset) returns (address, address)',
  'function registerDays(string label, uint32 startDay, uint32 endDay)',
  'function setAssetTexts(string label, string[] keys, string[] values)',
  'function dateLabel(uint32 day) pure returns (string)',
]);
const factoryAbi = parseAbi([
  'function createAsset(bytes32 hostSalt, string metadataURI, (uint128 minimum, uint128[7] listedPrices, uint128[7] sellingPrices) defaults, (uint16 minDays, uint16 discountBps)[] discounts) returns (address asset)',
  'function assets(address host, bytes32 hostSalt) view returns (address)',
]);
const rentalAbi = parseAbi([
  'function startDay() view returns (uint32)',
  'function endDayExclusive() view returns (uint32)',
]);
const registryAbi = parseAbi([
  'function setSubregistry(uint256 anyId, address registry)',
  'function getSubregistry(string label) view returns (address)',
]);
const FACTORY = '0x45a2982217399379155078b0e42dE055A7f11993';
const VF = '0x9e726Eb570beb6BCEb495AB8cdA7df517d4e841C';
const USER_IMPL = '0xA80338aAA8D23831cEa25E858D1774534aBb0263';
const RESOLVER_IMPL = '0x14F09Fd05d4585759e54844DC9B00147131Cf243';
const ETH_REG = '0x657eA849311d3D5823348ddEd7C2AaAFb3EDE09E';
const DAY_CHUNK = 73;

async function send(address, abi, functionName, args) {
  const { request } = await pub.simulateContract({
    account,
    address,
    abi,
    functionName,
    args,
  });
  const hash = await wallet.writeContract(request);
  const receipt = await pub.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') throw new Error(`${functionName} ${hash}`);
  log(functionName, hash, 'gasUsed', receipt.gasUsed.toString());
  return { hash, receipt };
}

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
const deployHash = await wallet.deployContract({
  abi: namesAbi,
  bytecode: namesArt.bytecode.object,
  args: [VF, USER_IMPL, RESOLVER_IMPL, ETH_REG, 'projecttokyo', FACTORY],
  account,
});
const deployReceipt = await pub.waitForTransactionReceipt({ hash: deployHash });
if (!deployReceipt.contractAddress) throw new Error('names deploy failed');
const names = deployReceipt.contractAddress;
log(
  'deployed names',
  names,
  deployHash,
  'gasUsed',
  deployReceipt.gasUsed.toString(),
);
const assetRegistry = await pub.readContract({
  address: names,
  abi: namesAbi,
  functionName: 'assetRegistry',
});
log('assetRegistry', assetRegistry);
if (sub.toLowerCase() !== assetRegistry.toLowerCase()) {
  await send(ETH_REG, registryAbi, 'setSubregistry', [
    ENS.tokenId,
    assetRegistry,
  ]);
}
const deployBlock = await pub.getBlockNumber();
const deployed = { names, assetRegistry, deployBlock };

const demoLabel = process.env.PROJECTTOKYO_DEMO_LABEL ?? 'demo-room';
const existing = await pub.readContract({
  address: names,
  abi: namesAbi,
  functionName: 'assetOf',
  args: [demoLabel],
});
const hashes = [deployHash];
let created = { asset: existing, hashes, startDay: 0, endDay: 0 };
if (existing !== '0x0000000000000000000000000000000000000000') {
  log('demo asset already registered', existing);
} else if (await afford('create demo-room', 3_000_000n)) {
  const salt = keccak256(stringToBytes(`${demoLabel}:${Date.now()}`));
  const metadataURI = JSON.stringify({
    title: 'Demo room',
    type: 'airbnb',
    location: 'Shibuya, Tokyo',
  });
  const listed = Array(7).fill(80_000000n);
  const selling = Array(7).fill(60_000000n);
  const createdTx = await send(FACTORY, factoryAbi, 'createAsset', [
    salt,
    metadataURI,
    { minimum: 40_000000n, listedPrices: listed, sellingPrices: selling },
    [],
  ]);
  hashes.push(createdTx.hash);
  const asset = await pub.readContract({
    address: FACTORY,
    abi: factoryAbi,
    functionName: 'assets',
    args: [account.address, salt],
  });
  log('demo asset', asset);
  const registered = await send(names, namesAbi, 'registerAsset', [
    demoLabel,
    asset,
  ]);
  hashes.push(registered.hash);
  const texts = await send(names, namesAbi, 'setAssetTexts', [
    demoLabel,
    ['title', 'kind', 'location', 'description'],
    ['Demo room', 'airbnb', 'Shibuya, Tokyo', 'ProjectTokyo ENSv2 demo'],
  ]);
  hashes.push(texts.hash);
  const startDay = await pub.readContract({
    address: asset,
    abi: rentalAbi,
    functionName: 'startDay',
  });
  const endDay = await pub.readContract({
    address: asset,
    abi: rentalAbi,
    functionName: 'endDayExclusive',
  });
  created = { asset, hashes, startDay, endDay };
  for (let d = startDay; d < endDay; d += DAY_CHUNK) {
    if (!(await afford('day chunk', 8_000_000n))) {
      created.stoppedAt = d;
      break;
    }
    const chunkEnd = d + DAY_CHUNK < endDay ? d + DAY_CHUNK : endDay;
    try {
      const chunk = await send(names, namesAbi, 'registerDays', [
        demoLabel,
        d,
        chunkEnd,
      ]);
      hashes.push(chunk.hash);
      log('day chunk', d, chunkEnd);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log('registerDays failed', d, chunkEnd, msg.split('\n')[0]);
      created.stoppedAt = d;
      break;
    }
  }
  log(
    'days',
    startDay,
    endDay,
    'txs',
    hashes.length,
    created.stoppedAt ? `stoppedAt ${created.stoppedAt}` : 'complete',
  );
}

const title = await pub
  .getEnsText({
    name: `${demoLabel}.projecttokyo.eth`,
    key: 'title',
  })
  .catch(() => null);
if (title) log('asset title', title);
const assetAddr = await pub
  .getEnsAddress({
    name: `${demoLabel}.projecttokyo.eth`,
  })
  .catch(() => null);
log('resolved', `${demoLabel}.projecttokyo.eth`, assetAddr);
if (created.startDay) {
  const dateLabel = await pub.readContract({
    address: names,
    abi: namesAbi,
    functionName: 'dateLabel',
    args: [created.startDay],
  });
  const dayName = `${dateLabel}.${demoLabel}.projecttokyo.eth`;
  const dayAddr = await pub.getEnsAddress({ name: dayName }).catch(() => null);
  const token = await pub
    .getEnsText({ name: dayName, key: 'token' })
    .catch(() => null);
  log('resolved', dayName, dayAddr, token);
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
