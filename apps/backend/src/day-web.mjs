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

/** Public deployment metadata is available without contacting an RPC provider. */
export function dayWebConfig(env = process.env) {
  const config = normalize(
    env.DAY_CONFIG_JSON == null ? deployment : JSON.parse(env.DAY_CONFIG_JSON),
  );
  if (env.DAY_BOOKING_REPORTER)
    config.bookingReporter = getAddress(env.DAY_BOOKING_REPORTER);
  return config;
}

/**
 * Read cache only: replicas and restarts reconstruct it from canonical chain events.
 * @param {Record<string, string | undefined>} env
 */
export async function createDayWeb(env = process.env) {
  const config = dayWebConfig(env);
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
    transport: http(rpc.href, { timeout: 5000, retryCount: 1 }),
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
/** Coalesce slow reads across polls and retain a completed result for the next poll. */
export function createDayWebHandler(liveHandler = lazyDayWeb(), waitMs = 8000) {
  const reads = new Map();
  return async (request) => {
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/config')
      return createDayHandler({
        config: dayWebConfig(),
        client: null,
        index: null,
      })(request);
    if (request.method !== 'GET' || url.pathname !== '/state')
      return withinDeadline(liveHandler(request), waitMs);
    const key = url.pathname + url.search;
    let job = reads.get(key);
    if (!job) {
      if (reads.size >= 32)
        return Response.json(
          { error: 'Chain reads are busy; retry shortly' },
          { status: 503 },
        );
      job = liveHandler(request).then(
        (response) => ({ response }),
        (error) => ({ error }),
      );
      reads.set(key, job);
      // Retain late completions briefly, never an unbounded per-account cache.
      void job.then(() => {
        const timer = setTimeout(() => {
          if (reads.get(key) === job) reads.delete(key);
        }, 30000);
        timer.unref?.();
      });
    }
    const result = await withinDeadline(job, waitMs);
    if (result instanceof Response) return result;
    if (reads.get(key) === job) reads.delete(key);
    if (result.error) throw result.error;
    return result.response.clone();
  };
}
export const handleDayWeb = createDayWebHandler();

/** A deadline bounds HTTP work, while its shared read may finish for a later poll. */
export async function withinDeadline(work, waitMs) {
  let timer;
  try {
    return await Promise.race([
      work,
      new Promise((resolve) => {
        timer = setTimeout(
          () =>
            resolve(
              Response.json(
                { error: 'Chain RPC is slow or unavailable; retry shortly' },
                { status: 503 },
              ),
            ),
          waitMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Requests yield indexing status while one shared batch continues; errors surface on the next poll. */
export function boundedIndexSync(index, waitMs = 1000) {
  let pending, failure;
  let completed = false;
  const start = () => {
    pending ??= index
      .sync()
      .then(() => {
        completed = true;
      })
      .catch((error) => {
        failure = error;
      })
      .finally(() => {
        pending = undefined;
      });
  };
  return async () => {
    if (failure) {
      const error = failure;
      failure = undefined;
      throw error;
    }
    if (completed) {
      completed = false;
      return true;
    }
    if (index.readiness && (await index.readiness()).ready) {
      start();
      return true;
    }
    start();
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
    if (completed) {
      completed = false;
      return true;
    }
    return false;
  };
}
