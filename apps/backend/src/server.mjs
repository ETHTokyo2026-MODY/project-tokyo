import { createServer as createHttpServer } from 'node:http';
import { resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createPublicClient, getAddress, http } from 'viem';
import { ChainIndex } from './chain.mjs';
import { Market, MarketInputError } from './market.mjs';
import { OrderBook, OrderInputError } from './orders.mjs';
import { routerAbi } from './protocol.mjs';
import { Store } from './store.mjs';
import { SupplyBook, SupplyInputError } from './supply.mjs';

const BODY_LIMIT = 64 * 1024;
const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

function json(response, status, body) {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  response.end(JSON.stringify(body));
}

function pageInteger(value, fallback, { min, max }) {
  if (value === null) return fallback;
  if (!/^(0|[1-9][0-9]*)$/.test(value)) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= min && number <= max
    ? number
    : null;
}

async function readJson(request) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > BODY_LIMIT) {
      const error = new Error('body too large');
      error.status = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    const error = new Error('invalid JSON');
    error.status = 400;
    throw error;
  }
}

export function createServer({ book, index, supply, market }) {
  if (!book || !index) throw new Error('Order book and chain index required');
  const health = { lastSuccessAt: null, lastErrorAt: null };
  const server = createHttpServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://localhost');
      if (request.method === 'GET' && url.pathname === '/health') {
        const stale =
          health.lastSuccessAt === null ||
          Date.now() - health.lastSuccessAt > 30_000 ||
          (health.lastErrorAt !== null &&
            health.lastErrorAt >= health.lastSuccessAt);
        return json(response, 200, {
          cursor: index.tip()?.number ?? null,
          stale,
          lastSyncAt: health.lastSuccessAt,
        });
      }
      if (supply && request.method === 'POST' && url.pathname === '/supply') {
        try {
          return json(
            response,
            201,
            await supply.publish(await readJson(request)),
          );
        } catch (error) {
          return json(
            response,
            error.status === 413
              ? 413
              : error.status === 400 || error instanceof SupplyInputError
                ? 400
                : 503,
            {
              error:
                error.status || error instanceof SupplyInputError
                  ? 'supply publication rejected'
                  : 'supply verification unavailable',
            },
          );
        }
      }
      const supplyMatch = /^\/supply\/(0x[0-9a-fA-F]{64})$/.exec(url.pathname);
      if (supply && request.method === 'GET' && supplyMatch) {
        try {
          return json(response, 200, await supply.reconcile(supplyMatch[1]));
        } catch {
          return json(response, 503, {
            error: 'supply reconciliation unavailable',
          });
        }
      }
      if (request.method === 'POST' && url.pathname === '/orders') {
        let payload;
        try {
          payload = await readJson(request);
        } catch (error) {
          return json(response, error.status ?? 400, {
            error: error.status === 413 ? 'body too large' : 'invalid JSON',
          });
        }
        try {
          return json(response, 201, await book.submit(payload));
        } catch (error) {
          if (error instanceof OrderInputError) {
            return json(
              response,
              error.message === 'conflicting signed order' ? 409 : 400,
              {
                error:
                  error.message === 'conflicting signed order'
                    ? 'conflicting signed order'
                    : 'invalid order',
              },
            );
          }
          return json(response, 503, {
            error: 'order verification unavailable',
          });
        }
      }
      if (request.method === 'GET' && url.pathname === '/orders') {
        const limit = pageInteger(url.searchParams.get('limit'), 100, {
          min: 1,
          max: 1000,
        });
        const offset = pageInteger(url.searchParams.get('offset'), 0, {
          min: 0,
          max: Number.MAX_SAFE_INTEGER,
        });
        if (limit === null || offset === null)
          return json(response, 400, { error: 'invalid pagination' });
        return json(response, 200, { orders: book.list({ limit, offset }) });
      }
      if (
        market &&
        request.method === 'GET' &&
        (url.pathname === '/market/quotes' ||
          url.pathname === '/market/history')
      ) {
        const limit = pageInteger(url.searchParams.get('limit'), 20, {
          min: 1,
          max: 20,
        });
        const offset = pageInteger(url.searchParams.get('offset'), 0, {
          min: 0,
          max: 1000,
        });
        if (limit === null || offset === null)
          return json(response, 400, { error: 'invalid pagination' });
        try {
          return json(
            response,
            200,
            await (url.pathname === '/market/quotes'
              ? market.quotes({ limit, offset })
              : market.history({ limit, offset })),
          );
        } catch (error) {
          if (error instanceof MarketInputError)
            return json(response, 400, { error: 'invalid pagination' });
          return json(response, 503, { error: 'market state unavailable' });
        }
      }
      const match = /^\/orders\/(0x[0-9a-fA-F]{64})$/.exec(url.pathname);
      if (request.method === 'GET' && match) {
        const order = book.get(match[1]);
        if (!order) return json(response, 404, { error: 'order not found' });
        try {
          return json(response, 200, {
            ...order,
            status: await index.status({ hash: order.hash, ...order.order }),
          });
        } catch {
          return json(response, 503, { error: 'chain status unavailable' });
        }
      }
      return json(response, 404, { error: 'not found' });
    } catch {
      return json(response, 500, { error: 'server error' });
    }
  });
  server.reportIndexSync = (error = null) => {
    if (error) health.lastErrorAt = Date.now();
    else {
      health.lastSuccessAt = Date.now();
      health.lastErrorAt = null;
    }
  };
  return server;
}

export async function verifyDeployment(client, config) {
  if (Number(await client.getChainId()) !== config.chainId)
    throw new Error('RPC chain ID differs from configured chain');
  const token = await client.readContract({
    address: getAddress(config.router),
    abi: routerAbi,
    functionName: 'usdc',
  });
  if (getAddress(token) !== getAddress(config.usdc))
    throw new Error('Router USDC differs from configured token');
}

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function main() {
  const database = resolve(required('DATABASE_PATH'));
  const insideRepo = relative(REPO_ROOT, database);
  if (!insideRepo.startsWith('..') && !isAbsolute(insideRepo))
    throw new Error('DATABASE_PATH must be outside the repository');
  const chainId = Number(process.env.CHAIN_ID ?? 11155111);
  const startBlock = Number(required('START_BLOCK'));
  const port = Number(process.env.PORT ?? 8787);
  if (
    !Number.isSafeInteger(chainId) ||
    chainId <= 0 ||
    !Number.isSafeInteger(startBlock) ||
    startBlock < 0 ||
    !Number.isSafeInteger(port) ||
    port < 0 ||
    port > 65535
  )
    throw new Error('Invalid numeric configuration');
  const config = {
    chainId,
    router: required('ROUTER_ADDRESS'),
    usdc: required('USDC_ADDRESS'),
  };
  const client = createPublicClient({ transport: http(required('RPC_URL')) });
  await verifyDeployment(client, config);
  const store = new Store(database);
  let server;
  try {
    const book = new OrderBook(store, client, config);
    const index = new ChainIndex(store, client, { ...config, startBlock });
    const market = new Market(book, index, client, config);
    const supply = process.env.INVENTORY_ADDRESS
      ? new SupplyBook(store, client, {
          chainId,
          inventory: process.env.INVENTORY_ADDRESS,
        })
      : undefined;
    server = createServer({ book, index, supply, market });
    let syncTask = null;
    const sync = () => {
      if (syncTask) return syncTask;
      syncTask = (async () => {
        try {
          await index.sync();
          server.reportIndexSync();
        } catch (error) {
          server.reportIndexSync(error);
          console.error('Index sync failed');
        }
      })().finally(() => {
        syncTask = null;
      });
      return syncTask;
    };
    await new Promise((done, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', done);
    });
    console.log(`Order API listening on 127.0.0.1:${server.address().port}`);
    void sync();
    const timer = setInterval(() => {
      void sync();
    }, 10_000);
    let stopping = false;
    const stop = async () => {
      if (stopping) return;
      stopping = true;
      clearInterval(timer);
      await new Promise((done) => server.close(done));
      await syncTask;
      store.close();
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  } catch (error) {
    if (server?.listening) server.close();
    store.close();
    throw error;
  }
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
