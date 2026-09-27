import { getAddress } from 'viem';
import { dayAssetAbi, dayFactoryAbi } from './day-protocol.mjs';

/** Read one recognized calendar at one block; reject a reorg rather than mix revisions. */
export async function readDayAsset(client, { factory, asset, blockNumber }) {
  const at = blockNumber ?? (await client.getBlockNumber());
  const block = await client.getBlock({ blockNumber: at });
  if (!block?.hash) throw new Error('Missing canonical block');
  const address = getAddress(asset);
  const recognized = await client.readContract({
    address: factory,
    abi: dayFactoryAbi,
    functionName: 'isAsset',
    args: [address],
    blockNumber: at,
  });
  if (!recognized) throw new Error('Unknown asset');
  const read = (functionName, args = []) =>
    client.readContract({
      address,
      abi: dayAssetAbi,
      functionName,
      args,
      blockNumber: at,
    });
  const [
    host,
    startDay,
    endDayExclusive,
    metadataURI,
    discounts,
    discountVersion,
  ] = await Promise.all([
    read('host'),
    read('startDay'),
    read('endDayExclusive'),
    read('metadataURI'),
    read('discountLadder'),
    read('discountVersion'),
  ]);
  if (endDayExclusive - startDay !== 365)
    throw new Error('Unexpected calendar horizon');
  const states = await read('rangeState', [startDay, endDayExclusive]);
  if (states.length !== endDayExclusive - startDay)
    throw new Error('Incomplete calendar');
  const days = states.map((state, i) => ({ day: startDay + i, ...state }));
  const after = await client.getBlock({ blockNumber: at });
  if (after?.hash !== block.hash)
    throw new Error('Calendar changed during reorg');
  return {
    address,
    host,
    startDay,
    endDayExclusive,
    metadataURI,
    discounts,
    discountVersion,
    days,
    blockNumber: at,
    blockHash: block.hash,
    timestamp: block.timestamp,
  };
}
