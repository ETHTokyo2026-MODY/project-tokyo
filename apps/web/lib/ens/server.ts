import { createEnsClients } from './client';
import { ENS } from './constants';
import { dateLabel } from './dates';
import {
  dayRegistryOf,
  getAssetRecords,
  listAssets,
  listDays,
  rentalAssetOf,
  readDayMetadata,
} from './lookup';
import { createAsset, type Deployment } from './names';
import { rentalAssetAbi } from './abi';
import type { Address } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

export type EnsListedAsset = {
  label: string;
  name: string;
  rentalAsset: Address;
  host: Address;
  title: string;
  kind: string;
  location: string;
  startDay: number;
  endDayExclusive: number;
  days: {
    day: number;
    date: string;
    name: string;
    token: Address;
    owner: Address;
    deployed: boolean;
    listed: boolean;
    booked: boolean;
    listedPrice: string;
    sellingPrice: string;
  }[];
};

function clients() {
  const key = process.env.PROJECTTOKYO_DEPLOYER_KEY?.trim();
  const account = key ? privateKeyToAccount(key as `0x${string}`) : undefined;
  return createEnsClients(undefined, account);
}

export function ensDeployment(): Deployment {
  return {
    names: ENS.names,
    assetRegistry: ENS.assetRegistry,
    rentalFactory: ENS.rentalFactory,
    deployBlock: BigInt(0),
  };
}

export function ensNameOf(label: string) {
  return `${label}.projecttokyo.eth`;
}

export function ensDayNameOf(label: string, day: number) {
  return `${dateLabel(day)}.${label}.projecttokyo.eth`;
}

export async function listEnsAssets(includeTest = false) {
  const c = clients();
  const labels = await listAssets(c, ENS.assetRegistry, BigInt(0), includeTest);
  const out: EnsListedAsset[] = [];
  for (const label of labels) {
    const rentalAsset = await rentalAssetOf(c, ENS.names, label);
    if (rentalAsset === '0x0000000000000000000000000000000000000000') continue;
    const [host, startDay, endDayExclusive, records] = await Promise.all([
      c.public.readContract({
        address: rentalAsset,
        abi: rentalAssetAbi,
        functionName: 'host',
      }),
      c.public.readContract({
        address: rentalAsset,
        abi: rentalAssetAbi,
        functionName: 'startDay',
      }),
      c.public.readContract({
        address: rentalAsset,
        abi: rentalAssetAbi,
        functionName: 'endDayExclusive',
      }),
      getAssetRecords(c, label),
    ]);
    const meta = await readDayMetadata(
      c,
      rentalAsset,
      startDay,
      endDayExclusive,
    );
    out.push({
      label,
      name: ensNameOf(label),
      rentalAsset,
      host,
      title: records.title || label,
      kind: records.kind || 'car',
      location: records.location || '',
      startDay,
      endDayExclusive,
      days: meta.map((d, i) => {
        const day = startDay + i;
        return {
          day,
          date: dateLabel(day),
          name: ensDayNameOf(label, day),
          token: d.token,
          owner: d.owner,
          deployed: d.deployed,
          listed: d.listed,
          booked: d.booked,
          listedPrice: d.listedPrice.toString(),
          sellingPrice: d.sellingPrice.toString(),
        };
      }),
    });
  }
  return out;
}

export async function createEnsAsset(input: {
  label: string;
  title: string;
  kind: string;
  location: string;
}) {
  const c = clients();
  if (!c.wallet) throw new Error('PROJECTTOKYO_DEPLOYER_KEY is not set');
  if (input.label.startsWith('testasset'))
    throw new Error('testasset labels are reserved');
  return createAsset(c, ensDeployment(), input.label, {
    title: input.title,
    kind: input.kind,
    location: input.location,
  });
}

export async function countRegisteredDays(label: string) {
  const c = clients();
  const dayReg = await dayRegistryOf(c, ENS.assetRegistry, label);
  if (dayReg === '0x0000000000000000000000000000000000000000') return 0;
  const days = await listDays(c, dayReg, BigInt(0), true);
  return days.length;
}
