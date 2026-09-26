import {
  decodeFunctionResult,
  encodeFunctionData,
  toHex,
  type Address,
} from 'viem';
import { packetToBytes } from 'viem/ens';
import {
  labelRegistered,
  namesAbi,
  registryAbi,
  rentalAssetAbi,
  resolverAbi,
  urAbi,
} from './abi';
import {
  DAY_CHUNK,
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
};

export type DayMetadata = {
  token: Address;
  owner: Address;
  deployed: boolean;
  listed: boolean;
  saleNonce: bigint;
  booked: boolean;
  listedPrice: bigint;
  sellingPrice: bigint;
};

export type ResolvedDay = {
  name: string;
  resolver: Address | null;
  addr: Address | null;
  token: string | null;
  asset: string | null;
};

export function parseCaip19(token: string) {
  const erc20 = /^eip155:(\d+)\/erc20:(0x[0-9a-fA-F]{40})$/.exec(token);
  return erc20
    ? { chainId: Number(erc20[1]), contract: erc20[2] as Address }
    : null;
}

function earliestFromError(err: unknown): bigint | null {
  const msg = err instanceof Error ? err.message : String(err);
  const match = /earliest available (\d+)/i.exec(msg);
  return match ? BigInt(match[1]) : null;
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
    let logs;
    try {
      logs = await clients.public.getLogs({
        address,
        event: labelRegistered,
        fromBlock: a,
        toBlock: b,
      });
    } catch (err) {
      const earliest = earliestFromError(err);
      if (earliest == null || earliest > b) throw err;
      a = earliest;
      continue;
    }
    for (const log of logs) {
      if (log.args.label)
        out.push({ label: log.args.label, block: log.blockNumber });
    }
  }
  return out;
}

function scanFrom(fromBlock: bigint, head: bigint) {
  if (fromBlock === BigInt(0) && head > LOG_CHUNK) return head - LOG_CHUNK;
  return fromBlock;
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
      (
        await registeredLabels(
          clients,
          assetRegistry,
          scanFrom(fromBlock, head),
          head,
        )
      ).map((r) => r.label),
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
      (
        await registeredLabels(
          clients,
          dayRegistry,
          scanFrom(fromBlock, head),
          head,
        )
      ).map((r) => r.label),
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

export async function rentalAssetOf(
  clients: EnsClients,
  names: Address,
  label: string,
) {
  return clients.public.readContract({
    address: names,
    abi: namesAbi,
    functionName: 'assetOf',
    args: [label],
  });
}

export async function resolveDay(
  clients: EnsClients,
  name: string,
): Promise<ResolvedDay> {
  const [resolver, addr, token, asset] = await Promise.all([
    clients.public.getEnsResolver({ name }).catch(() => null),
    clients.public.getEnsAddress({ name }).catch(() => null),
    clients.public.getEnsText({ name, key: 'token' }).catch(() => null),
    clients.public.getEnsText({ name, key: 'asset' }).catch(() => null),
  ]);
  return { name, resolver, addr, token, asset };
}

export async function getAssetRecords(
  clients: EnsClients,
  label: string,
): Promise<AssetProperties> {
  const name = `${label}.${PARENT_NAME}`;
  const keys = ['title', 'kind', 'location', 'description'] as const;
  const values = await Promise.all(
    keys.map((key) => clients.public.getEnsText({ name, key }).catch(() => '')),
  );
  return Object.fromEntries(
    keys.map((k, i) => [k, values[i] ?? '']),
  ) as AssetProperties;
}

export async function readDayMetadata(
  clients: EnsClients,
  asset: Address,
  startDay: number,
  endDayExclusive: number,
): Promise<DayMetadata[]> {
  if (endDayExclusive <= startDay) return [];
  const pages = [];
  for (let start = startDay; start < endDayExclusive; start += DAY_CHUNK) {
    const end = Math.min(start + DAY_CHUNK, endDayExclusive);
    pages.push(
      clients.public.readContract({
        address: asset,
        abi: rentalAssetAbi,
        functionName: 'rangeState',
        args: [start, end],
      }),
    );
  }
  return (await Promise.all(pages)).flat().map((s) => ({
    token: s.token,
    owner: s.owner,
    deployed: s.deployed,
    listed: s.listed,
    saleNonce: s.saleNonce,
    booked: s.booked,
    listedPrice: s.listedPrice,
    sellingPrice: s.sellingPrice,
  }));
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
