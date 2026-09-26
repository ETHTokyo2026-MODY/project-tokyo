import {
  decodeFunctionResult,
  encodeFunctionData,
  keccak256,
  stringToBytes,
  toHex,
  type Address,
} from 'viem';
import { packetToBytes } from 'viem/ens';
import {
  inventoryAbi,
  labelRegistered,
  namesAbi,
  registryAbi,
  resolverAbi,
  urAbi,
} from './abi';
import {
  ENS,
  LABEL_REGISTERED_TOPIC,
  LOG_CHUNK,
  PARENT_NAME,
} from './constants';
import { filterLabels } from './filter';
import type { EnsClients } from './client';

export type AssetProperties = {
  title?: string;
  kind?: string;
  location?: string;
  description?: string;
  discounts?: string;
};

export type DayMetadata = {
  minted: boolean;
  booked: boolean;
  listed: boolean;
  listedPrice: bigint;
  sellingPrice: bigint;
  holder: Address;
};

export type ResolvedDay = {
  name: string;
  resolver: Address | null;
  addr: Address | null;
  token: string | null;
};

export function parseCaip19(token: string) {
  const m = /^eip155:(\d+)\/erc1155:(0x[0-9a-fA-F]{40})\/(\d+)$/.exec(token);
  return m
    ? { chainId: Number(m[1]), contract: m[2] as Address, id: BigInt(m[3]) }
    : null;
}

export function poolOfLabel(label: string) {
  return keccak256(stringToBytes(label));
}

export async function registeredLabels(
  clients: EnsClients,
  address: Address,
  fromBlock: bigint,
  toBlock: bigint,
) {
  const out: { label: string; block: bigint }[] = [];
  for (let a = fromBlock; a <= toBlock; a += LOG_CHUNK) {
    const b =
      a + LOG_CHUNK - BigInt(1) < toBlock ? a + LOG_CHUNK - BigInt(1) : toBlock;
    const logs = await clients.public.getLogs({
      address,
      event: labelRegistered,
      fromBlock: a,
      toBlock: b,
    });
    for (const log of logs) {
      if (log.args.label)
        out.push({ label: log.args.label, block: log.blockNumber });
    }
  }
  return out;
}

export async function listAssets(
  clients: EnsClients,
  assetRegistry: Address,
  fromBlock: bigint,
  includeTest = false,
) {
  const head = await clients.public.getBlockNumber();
  const labels = [
    ...new Set(
      (await registeredLabels(clients, assetRegistry, fromBlock, head)).map(
        (r) => r.label,
      ),
    ),
  ];
  return filterLabels(labels, includeTest);
}

export async function listDays(
  clients: EnsClients,
  dayRegistry: Address,
  fromBlock: bigint,
  includeTest = false,
) {
  const head = await clients.public.getBlockNumber();
  const labels = [
    ...new Set(
      (await registeredLabels(clients, dayRegistry, fromBlock, head)).map(
        (r) => r.label,
      ),
    ),
  ];
  return filterLabels(labels, includeTest);
}

export async function dayRegistryOf(
  clients: EnsClients,
  assetRegistry: Address,
  label: string,
) {
  return clients.public.readContract({
    address: assetRegistry,
    abi: registryAbi,
    functionName: 'getSubregistry',
    args: [label],
  });
}

export async function resolveDay(
  clients: EnsClients,
  name: string,
): Promise<ResolvedDay> {
  const [resolver, addr, token] = await Promise.all([
    clients.public.getEnsResolver({ name }).catch(() => null),
    clients.public.getEnsAddress({ name }).catch(() => null),
    clients.public.getEnsText({ name, key: 'token' }).catch(() => null),
  ]);
  return { name, resolver, addr, token };
}

export async function getAssetRecords(
  clients: EnsClients,
  label: string,
): Promise<AssetProperties> {
  const name = `${label}.${PARENT_NAME}`;
  const keys = [
    'title',
    'kind',
    'location',
    'description',
    'discounts',
  ] as const;
  const values = await Promise.all(
    keys.map((key) => clients.public.getEnsText({ name, key }).catch(() => '')),
  );
  return Object.fromEntries(
    keys.map((k, i) => [k, values[i] ?? '']),
  ) as AssetProperties;
}

export async function readDayMetadata(
  clients: EnsClients,
  inventory: Address,
  ids: bigint[],
): Promise<DayMetadata[]> {
  if (ids.length === 0) return [];
  const contracts = ids.flatMap((id) => [
    {
      address: inventory,
      abi: inventoryAbi,
      functionName: 'dayInfo' as const,
      args: [id] as const,
    },
    {
      address: inventory,
      abi: inventoryAbi,
      functionName: 'holderOf' as const,
      args: [id] as const,
    },
  ]);
  const out = await clients.public.multicall({
    contracts,
    allowFailure: false,
  });
  return ids.map((_, i) => {
    const info = out[2 * i] as readonly [
      boolean,
      boolean,
      boolean,
      bigint,
      bigint,
    ];
    return {
      minted: info[0],
      booked: info[1],
      listed: info[2],
      listedPrice: info[3],
      sellingPrice: info[4],
      holder: out[2 * i + 1] as Address,
    };
  });
}

export async function resolveDayViaUniversal(
  clients: EnsClients,
  name: string,
) {
  const data = encodeFunctionData({
    abi: resolverAbi,
    functionName: 'text',
    args: [toHex(0, { size: 32 }), 'token'],
  });
  const [raw, resolver] = await clients.public.readContract({
    address: ENS.universalResolver,
    abi: urAbi,
    functionName: 'resolve',
    args: [toHex(packetToBytes(name)), data],
  });
  const token = decodeFunctionResult({
    abi: resolverAbi,
    functionName: 'text',
    data: raw,
  }) as string;
  return { token, resolver };
}

export { LABEL_REGISTERED_TOPIC, namesAbi };
