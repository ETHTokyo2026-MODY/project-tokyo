import { keccak256, stringToBytes, type Address, type Hex } from 'viem';
import {
  dayTokenAbi,
  factoryAbi,
  namesAbi,
  registryAbi,
  rentalAssetAbi,
} from './abi';
import { DAY_CHUNK, ENS, PARENT_LABEL } from './constants';
import { assertEnsRoot, type EnsClients } from './client';

export type Deployment = {
  names: Address;
  assetRegistry: Address;
  rentalFactory: Address;
  deployBlock: bigint;
};

export type AssetPropertiesInput = {
  kind: string;
  title: string;
  location: string;
  description?: string;
  metadataURI?: string;
  salt?: Hex;
  defaults?: {
    minimum: bigint;
    listedPrices: readonly bigint[];
    sellingPrices: readonly bigint[];
  };
  discounts?: { minDays: number; discountBps: number }[];
};

const WEEKDAY = (n: bigint) => [n, n, n, n, n, n, n] as const;

async function send(
  clients: EnsClients,
  address: Address,
  abi: readonly unknown[],
  functionName: string,
  args: readonly unknown[],
) {
  if (!clients.wallet) throw new Error('wallet client required');
  const account = clients.wallet.account;
  const { request } = await clients.public.simulateContract({
    account,
    address,
    abi: abi as typeof namesAbi,
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
  bytecode: { names: Hex },
  existing?: Partial<Deployment>,
): Promise<Deployment> {
  if (!clients.wallet) throw new Error('wallet client required');
  await assertEnsRoot(clients.public);
  const account = clients.wallet.account;

  let names = existing?.names;
  if (!names) {
    const hash = await clients.wallet.deployContract({
      abi: namesAbi,
      bytecode: bytecode.names,
      args: [
        ENS.verifiableFactory,
        ENS.userRegistryImpl,
        ENS.permissionedResolverImpl,
        ENS.ethRegistry,
        PARENT_LABEL,
        ENS.rentalFactory,
      ],
      account,
    });
    const receipt = await clients.public.waitForTransactionReceipt({ hash });
    if (!receipt.contractAddress) throw new Error('names deploy failed');
    names = receipt.contractAddress;
  }

  try {
    await send(clients, names, namesAbi, 'linkParent', []);
  } catch {
    // setParent may require a role on the .eth name; resolution uses setSubregistry only.
  }

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
  const deployBlock = await clients.public.getBlockNumber();
  return {
    names,
    assetRegistry,
    rentalFactory: ENS.rentalFactory,
    deployBlock,
  };
}

export async function createRentalAsset(
  clients: EnsClients,
  factory: Address,
  properties: AssetPropertiesInput,
  label: string,
) {
  if (!clients.wallet) throw new Error('wallet client required');
  const account = clients.wallet.account;
  const salt =
    properties.salt ??
    keccak256(stringToBytes(`${label}:${account.address}:${Date.now()}`));
  const metadataURI =
    properties.metadataURI ??
    JSON.stringify({
      title: properties.title,
      type: properties.kind,
      location: properties.location,
    });
  const listed =
    properties.defaults?.listedPrices ?? WEEKDAY(BigInt(80_000000));
  const selling =
    properties.defaults?.sellingPrices ?? WEEKDAY(BigInt(60_000000));
  const minimum = properties.defaults?.minimum ?? BigInt(40_000000);
  const discounts = (properties.discounts ?? []).map((d) => ({
    minDays: d.minDays,
    discountBps: d.discountBps,
  }));
  const created = await send(clients, factory, factoryAbi, 'createAsset', [
    salt,
    metadataURI,
    { minimum, listedPrices: listed, sellingPrices: selling },
    discounts,
  ]);
  const asset = await clients.public.readContract({
    address: factory,
    abi: factoryAbi,
    functionName: 'assets',
    args: [account.address, salt],
  });
  if (asset === '0x0000000000000000000000000000000000000000') {
    throw new Error('factory did not record the new asset');
  }
  return { asset, salt, hash: created.hash };
}

export async function registerEnsAsset(
  clients: EnsClients,
  names: Address,
  label: string,
  asset: Address,
  properties: Pick<
    AssetPropertiesInput,
    'title' | 'kind' | 'location' | 'description'
  >,
) {
  const registered = await send(clients, names, namesAbi, 'registerAsset', [
    label,
    asset,
  ]);
  const keys = ['title', 'kind', 'location'];
  const values = [properties.title, properties.kind, properties.location];
  if (properties.description) {
    keys.push('description');
    values.push(properties.description);
  }
  const texts = await send(clients, names, namesAbi, 'setAssetTexts', [
    label,
    keys,
    values,
  ]);
  return { hashes: [registered.hash, texts.hash] };
}

export async function registerDayRange(
  clients: EnsClients,
  names: Address,
  label: string,
  startDay: number,
  endDay: number,
) {
  return send(clients, names, namesAbi, 'registerDays', [
    label,
    startDay,
    endDay,
  ]);
}

export async function createAsset(
  clients: EnsClients,
  deployment: Deployment,
  label: string,
  properties: AssetPropertiesInput,
  onChunk?: (info: {
    startDay: number;
    endDay: number;
    hash: Hex;
    gasUsed?: bigint;
  }) => boolean | void | Promise<boolean | void>,
) {
  const rental = await createRentalAsset(
    clients,
    deployment.rentalFactory,
    properties,
    label,
  );
  const ens = await registerEnsAsset(
    clients,
    deployment.names,
    label,
    rental.asset,
    properties,
  );
  const startDay = await clients.public.readContract({
    address: rental.asset,
    abi: rentalAssetAbi,
    functionName: 'startDay',
  });
  const endDay = await clients.public.readContract({
    address: rental.asset,
    abi: rentalAssetAbi,
    functionName: 'endDayExclusive',
  });
  const hashes: Hex[] = [rental.hash, ...ens.hashes];
  for (let d = startDay; d < endDay; d += DAY_CHUNK) {
    const chunkEnd = d + DAY_CHUNK < endDay ? d + DAY_CHUNK : endDay;
    const registered = await registerDayRange(
      clients,
      deployment.names,
      label,
      d,
      chunkEnd,
    );
    hashes.push(registered.hash);
    const stop = await onChunk?.({
      startDay: d,
      endDay: chunkEnd,
      hash: registered.hash,
      gasUsed: registered.receipt.gasUsed,
    });
    if (stop === false) {
      return {
        asset: rental.asset,
        salt: rental.salt,
        startDay,
        endDay,
        hashes,
        stoppedAt: chunkEnd,
      };
    }
  }
  return {
    asset: rental.asset,
    salt: rental.salt,
    startDay,
    endDay,
    hashes,
  };
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

export async function materializeDay(
  clients: EnsClients,
  asset: Address,
  day: number,
) {
  return send(clients, asset, rentalAssetAbi, 'materialize', [day]);
}

export async function transferDayToken(
  clients: EnsClients,
  token: Address,
  to: Address,
) {
  return send(clients, token, dayTokenAbi, 'transfer', [to, BigInt(1)]);
}

export async function setDayListing(
  clients: EnsClients,
  asset: Address,
  day: number,
  listed: boolean,
  sellingPrice: bigint,
) {
  return send(clients, asset, rentalAssetAbi, 'setListing', [
    day,
    day + 1,
    listed,
    sellingPrice,
  ]);
}
