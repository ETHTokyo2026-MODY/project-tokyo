import deployment from '../../../contracts/deployments/sepolia.json' with { type: 'json' };
import { sepolia } from 'viem/chains';
import { DatabaseSync } from 'node:sqlite';
import { createPublicClient, defineChain, getAddress, http } from 'viem';
import { normalize } from './day-config.mjs';
import { EventIndex } from './event-index.mjs';
import { createDayHandler } from './day-server.mjs';
import {
  dayFactoryAbi,
  dayRouterAbi,
  dayTokenAbi,
  officialAquaAbi,
} from './day-protocol.mjs';

/**
 * Read cache only: replicas and restarts reconstruct it from canonical chain events.
 * @param {Record<string, string | undefined>} env
 */
export async function createDayWeb(env = process.env) {
  const config = normalize(
    env.DAY_CONFIG_JSON == null ? deployment : JSON.parse(env.DAY_CONFIG_JSON),
  );
  if (!env.DAY_RPC_URL && config.chainId !== sepolia.id)
    throw new Error('A custom chain requires DAY_RPC_URL');
  const rpc = new URL(env.DAY_RPC_URL ?? sepolia.rpcUrls.default.http[0]);
  if (!['https:', 'http:'].includes(rpc.protocol))
    throw new Error('Invalid RPC protocol');
  const chain = defineChain({
    id: config.chainId,
    name: 'Rental day chain',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [rpc.href] } },
  });
  const client = createPublicClient({
    chain,
    cacheTime: 0,
    transport: http(rpc.href, { timeout: 15000, retryCount: 1 }),
  });
  if ((await client.getChainId()) !== config.chainId)
    throw new Error('Wrong runtime chain');
  const values = await Promise.all(
    ['FACTORY', 'AQUA', 'USDC'].map((functionName) =>
      client.readContract({
        address: config.router,
        abi: dayRouterAbi,
        functionName,
      }),
    ),
  );
  if (
    values.some(
      (address, i) =>
        getAddress(address) !== config[['factory', 'aqua', 'usdc'][i]],
    ) ||
    Number(
      await client.readContract({
        address: config.usdc,
        abi: dayTokenAbi,
        functionName: 'decimals',
      }),
    ) !== 6
  )
    throw new Error('Runtime contracts differ from deployment configuration');
  if (env.DAY_BOOKING_REPORTER)
    config.bookingReporter = getAddress(env.DAY_BOOKING_REPORTER);
  const db = new DatabaseSync(':memory:');
  try {
    const events = (abi) => abi.filter((item) => item.type === 'event');
    const index = new EventIndex(db, client, {
      ...config,
      sources: [
        { address: config.factory, events: events(dayFactoryAbi) },
        { address: config.aqua, events: events(officialAquaAbi) },
        { address: config.router, events: events(dayRouterAbi) },
      ],
      scope: {
        factory: config.factory,
        router: config.router,
        aqua: config.aqua,
        usdc: config.usdc,
      },
    });
    return createDayHandler({
      client,
      config,
      index,
      syncIndex: boundedIndexSync(index),
    });
  } catch (error) {
    db.close();
    throw error;
  }
}

/** One initialization per process, including concurrent requests; failed setup can retry. */
export function lazyDayWeb(create = createDayWeb) {
  let pending;
  return async (request) => {
    pending ??= Promise.resolve()
      .then(create)
      .catch((error) => {
        pending = undefined;
        throw error;
      });
    return (await pending)(request);
  };
}
export const handleDayWeb = lazyDayWeb();

/** Requests yield indexing status while one shared batch continues; errors surface on the next poll. */
export function boundedIndexSync(index, waitMs = 1000) {
  let pending, failure;
  return async () => {
    if (failure) {
      const error = failure;
      failure = undefined;
      throw error;
    }
    pending ??= index
      .sync()
      .catch((error) => {
        failure = error;
      })
      .finally(() => {
        pending = undefined;
      });
    let timer;
    try {
      await Promise.race([
        pending,
        new Promise((resolve) => {
          timer = setTimeout(resolve, waitMs);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
    if (failure) {
      const error = failure;
      failure = undefined;
      throw error;
    }
    return !pending;
  };
}
