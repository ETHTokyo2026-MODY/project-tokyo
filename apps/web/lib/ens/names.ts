import { type Address, type Hex } from 'viem';
import { inventoryAbi, namesAbi, registryAbi } from './abi';
import { DAY_CHUNK, ENS, HORIZON, PARENT_LABEL } from './constants';
import { assertEnsRoot, type EnsClients } from './client';
import { poolOfLabel } from './lookup';

export type Deployment = {
  inventory: Address;
  names: Address;
  assetRegistry: Address;
};

export type AssetPropertiesInput = {
  kind: string;
  title: string;
  location: string;
  description?: string;
  discounts?: string;
};

async function send(
  clients: EnsClients,
  address: Address,
  abi: typeof inventoryAbi | typeof namesAbi | typeof registryAbi,
  functionName: string,
  args: readonly unknown[],
) {
  if (!clients.wallet) throw new Error('wallet client required');
  const account = clients.wallet.account;
  const { request } = await clients.public.simulateContract({
    account,
    address,
    abi: abi as typeof inventoryAbi,
    functionName: functionName as never,
    args: args as never,
  });
  const hash = await clients.wallet.writeContract(request);
  const receipt = await clients.public.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success')
    throw new Error(`${functionName} failed ${hash}`);
  return { hash, receipt };
}

export async function setup(
  clients: EnsClients,
  bytecode: { inventory: Hex; names: Hex },
  existing?: Partial<Deployment>,
): Promise<Deployment> {
  if (!clients.wallet) throw new Error('wallet client required');
  await assertEnsRoot(clients.public);
  const account = clients.wallet.account;

  let inventory = existing?.inventory;
  if (!inventory) {
    const hash = await clients.wallet.deployContract({
      abi: inventoryAbi,
      bytecode: bytecode.inventory,
      account,
    });
    const receipt = await clients.public.waitForTransactionReceipt({ hash });
    if (!receipt.contractAddress) throw new Error('inventory deploy failed');
    inventory = receipt.contractAddress;
  }

  let names = existing?.names;
  if (!names) {
    const hash = await clients.wallet.deployContract({
      abi: namesAbi,
      bytecode: bytecode.names,
      args: [
        inventory,
        ENS.verifiableFactory,
        ENS.userRegistryImpl,
        ENS.permissionedResolverImpl,
        ENS.ethRegistry,
        PARENT_LABEL,
      ],
      account,
    });
    const receipt = await clients.public.waitForTransactionReceipt({ hash });
    if (!receipt.contractAddress) throw new Error('names deploy failed');
    names = receipt.contractAddress;
  }

  const currentNames = await clients.public.readContract({
    address: inventory,
    abi: inventoryAbi,
    functionName: 'names',
  });
  if (currentNames === '0x0000000000000000000000000000000000000000') {
    await send(clients, inventory, inventoryAbi, 'setNames', [names]);
  }
  await send(clients, names, namesAbi, 'linkParent', []);

  const assetRegistry = await clients.public.readContract({
    address: names,
    abi: namesAbi,
    functionName: 'assetRegistry',
  });
  const currentSub = await clients.public.readContract({
    address: ENS.ethRegistry,
    abi: registryAbi,
    functionName: 'getSubregistry',
    args: [PARENT_LABEL],
  });
  if (currentSub.toLowerCase() !== assetRegistry.toLowerCase()) {
    await send(clients, ENS.ethRegistry, registryAbi, 'setSubregistry', [
      ENS.parentTokenId,
      assetRegistry,
    ]);
  }
  return { inventory, names, assetRegistry };
}

export async function createAsset(
  clients: EnsClients,
  deployment: Deployment,
  label: string,
  owner: Address,
  properties: AssetPropertiesInput,
  prices: { listedPrice: bigint; sellingPrice: bigint } = {
    listedPrice: BigInt(80_000000),
    sellingPrice: BigInt(50_000000),
  },
) {
  if (!clients.wallet) throw new Error('wallet client required');
  const created = await clients.public.simulateContract({
    account: clients.wallet.account,
    address: deployment.inventory,
    abi: inventoryAbi,
    functionName: 'createAsset',
    args: [
      label,
      owner,
      properties.kind,
      properties.title,
      properties.location,
    ],
  });
  const createHash = await clients.wallet.writeContract(created.request);
  const receipt = await clients.public.waitForTransactionReceipt({
    hash: createHash,
  });
  if (receipt.status !== 'success')
    throw new Error(`createAsset failed ${createHash}`);
  const startDay = BigInt(created.result[1]);
  const keys = ['title', 'kind', 'location'];
  const values = [properties.title, properties.kind, properties.location];
  if (properties.description) {
    keys.push('description');
    values.push(properties.description);
  }
  if (properties.discounts) {
    keys.push('discounts');
    values.push(properties.discounts);
  }
  await send(clients, deployment.names, namesAbi, 'setAssetTexts', [
    label,
    keys,
    values,
  ]);

  const pool = poolOfLabel(label);
  const end = startDay + BigInt(HORIZON);
  const hashes: Hex[] = [receipt.transactionHash];
  for (let d = startDay; d < end; d += BigInt(DAY_CHUNK)) {
    const chunkEnd = d + BigInt(DAY_CHUNK) < end ? d + BigInt(DAY_CHUNK) : end;
    const minted = await send(
      clients,
      deployment.inventory,
      inventoryAbi,
      'mintDays',
      [pool, d, chunkEnd, prices.listedPrice, prices.sellingPrice],
    );
    hashes.push(minted.hash);
  }
  return { pool, startDay, endDay: end, hashes };
}

export async function updateAssetRecords(
  clients: EnsClients,
  names: Address,
  label: string,
  records: Record<string, string>,
) {
  const keys = Object.keys(records);
  const values = keys.map((k) => records[k]);
  return send(clients, names, namesAbi, 'setAssetTexts', [label, keys, values]);
}

export async function transferDay(
  clients: EnsClients,
  inventory: Address,
  from: Address,
  to: Address,
  id: bigint,
) {
  return send(clients, inventory, inventoryAbi, 'safeTransferFrom', [
    from,
    to,
    id,
    BigInt(1),
    '0x',
  ]);
}
