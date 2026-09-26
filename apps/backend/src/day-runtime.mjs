import { DatabaseSync } from 'node:sqlite';
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  getAddress,
  http,
  zeroAddress,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { EventIndex } from './event-index.mjs';
import { DayTaker } from './day-taker.mjs';
import { createDayServer } from './day-server.mjs';
import {
  dayFactoryAbi,
  dayRouterAbi,
  dayTokenAbi,
  officialAquaAbi,
} from './day-protocol.mjs';

function integer(value, fallback, minimum = 0) {
  const input = value ?? fallback;
  if (!(
    (typeof input === 'number' && Number.isSafeInteger(input)) ||
    (typeof input === 'string' && /^(0|[1-9][0-9]*)$/.test(input))
  ))
    throw new Error('Invalid runtime integer');
  const result = Number(input);
  if (!Number.isSafeInteger(result) || result < minimum)
    throw new Error('Invalid runtime integer');
  return result;
}
function outsideGit(path) {
  for (let current = path; ; current = dirname(current)) {
    if (existsSync(resolve(current, '.git')))
      throw new Error('Runtime files must be outside Git checkouts');
    if (current === dirname(current)) return;
  }
}
function externalPath(path) {
  if (typeof path !== 'string' || !isAbsolute(path))
    throw new Error('An absolute external runtime path is required');
  const target = resolve(path);
  outsideGit(target);
  let existing = target;
  while (!existsSync(existing)) existing = dirname(existing);
  const actual = realpathSync(existing);
  outsideGit(actual);
  return resolve(actual, relative(existing, target));
}
function openDatabase(path) {
  const target = externalPath(path),
    directory = dirname(target);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (statSync(directory).mode & 0o077)
    throw new Error('Runtime database directory must be private');
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    const entry = lstatSync(target + suffix, { throwIfNoEntry: false });
    if (entry && (!entry.isFile() || entry.nlink !== 1 || entry.mode & 0o077))
      throw new Error('Runtime database files must be private regular files');
  }
  if (!existsSync(target)) closeSync(openSync(target, 'wx', 0o600));
  const db = new DatabaseSync(target);
  try {
    db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL');
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}
function normalize(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config))
    throw new Error('Runtime deployment configuration required');
  const result = {
    chainId: integer(config.chainId, undefined, 1),
    startBlock: integer(config.startBlock),
    confirmations: integer(config.confirmations, 2),
    maxFills: integer(config.maxFills, 1, 1),
  };
  for (const key of ['factory', 'router', 'aqua', 'usdc']) {
    result[key] = getAddress(config[key]);
    if (result[key] === zeroAddress)
      throw new Error('Runtime deployment address is zero');
  }
  return result;
}

/** Credentials remain in clients, never in public deployment config or log messages. */
export function loadDayRuntimeOptions(env = process.env) {
  const configPath = externalPath(env.DAY_CONFIG);
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(configPath, 'utf8'));
  } catch {
    throw new Error('Unable to load DAY_CONFIG JSON');
  }
  const config = normalize(parsed);
  let url;
  try {
    url = new URL(env.DAY_RPC_URL);
  } catch {
    throw new Error('DAY_RPC_URL is required');
  }
  if (!['http:', 'https:'].includes(url.protocol))
    throw new Error('RPC must use HTTP or HTTPS');
  const chain = defineChain({
    id: config.chainId,
    name: 'Rental day chain',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [env.DAY_RPC_URL] } },
  });
  const transport = http(env.DAY_RPC_URL, { timeout: 15000, retryCount: 1 });
  const wallet = (key) =>
    key
      ? createWalletClient({
          chain,
          transport,
          account: privateKeyToAccount(key),
        })
      : null;
  const takerWallet = wallet(env.DAY_TAKER_PRIVATE_KEY),
    bookingWallet = wallet(env.DAY_BOOKING_PRIVATE_KEY);
  if (bookingWallet && (!env.DAY_BOOKING_DB || !env.DAY_WEBHOOK_TOKEN))
    throw new Error('Booking signer requires its database and webhook token');
  if (!bookingWallet && (env.DAY_BOOKING_DB || env.DAY_WEBHOOK_TOKEN))
    throw new Error('Booking configuration requires a booking signer');
  return {
    config,
    client: createPublicClient({ chain, transport, cacheTime: 0 }),
    takerWallet,
    bookingWallet,
    webhookToken: env.DAY_WEBHOOK_TOKEN,
    databasePath: externalPath(env.DAY_DB),
    bookingDatabasePath: bookingWallet
      ? externalPath(env.DAY_BOOKING_DB)
      : undefined,
    host: env.DAY_HOST ?? '127.0.0.1',
    port: integer(env.DAY_PORT, 8787),
    intervalMs: integer(env.DAY_INTERVAL_MS, 3000, 1),
  };
}

/** One serial background cycle; HTTP requests finish before private databases close. */
export async function startDayRuntime(
  options,
  {
    Index = EventIndex,
    Taker = DayTaker,
    serverFactory = createDayServer,
    BookingReporter,
    log = () => {},
  } = {},
) {
  const {
    client,
    takerWallet,
    bookingWallet,
    webhookToken,
    databasePath,
    bookingDatabasePath,
  } = options;
  const config = normalize(options.config),
    intervalMs = integer(options.intervalMs, 3000, 1);
  const database = externalPath(databasePath);
  const bookingDatabase = bookingWallet
    ? externalPath(bookingDatabasePath)
    : undefined;
  const host = options.host ?? '127.0.0.1',
    port = integer(options.port, 8787);
  if (port > 65535 || typeof host !== 'string' || !host)
    throw new Error('Invalid listen address');
  if (BigInt(await client.getChainId()) !== BigInt(config.chainId))
    throw new Error('Wrong runtime chain');
  const [factory, aqua, usdc, decimals] = await Promise.all([
    ...['FACTORY', 'AQUA', 'USDC'].map((functionName) =>
      client.readContract({
        address: config.router,
        abi: dayRouterAbi,
        functionName,
      }),
    ),
    client.readContract({
      address: config.usdc,
      abi: dayTokenAbi,
      functionName: 'decimals',
    }),
  ]);
  if (
    getAddress(factory) !== config.factory ||
    getAddress(aqua) !== config.aqua ||
    getAddress(usdc) !== config.usdc ||
    Number(decimals) !== 6
  )
    throw new Error('Runtime contracts differ from deployment configuration');
  if (bookingWallet) {
    if (
      !webhookToken ||
      !bookingDatabasePath ||
      bookingDatabase === database ||
      (takerWallet &&
        getAddress(takerWallet.account.address) ===
          getAddress(bookingWallet.account.address))
    )
      throw new Error(
        'Booking requires a separate wallet, database and webhook token',
      );
    config.bookingReporter = getAddress(bookingWallet.account.address);
  }
  let db,
    bookingDb,
    server,
    timer,
    active,
    stopping = false,
    closing;
  const stop = () => {
    if (closing) return closing;
    stopping = true;
    clearTimeout(timer);
    closing = (async () => {
      const drains = [];
      if (server?.listening)
        drains.push(
          new Promise((done, reject) =>
            server.close((error) => (error ? reject(error) : done())),
          ),
        );
      if (active) drains.push(active);
      const results = await Promise.allSettled(drains);
      if (server?.drain)
        results.push(
          ...(await Promise.allSettled([
            Promise.resolve().then(() => server.drain()),
          ])),
        );
      bookingDb?.close();
      db?.close();
      const failed = results.find((result) => result.status === 'rejected');
      if (failed) throw failed.reason;
    })();
    return closing;
  };
  try {
    db = openDatabase(database);
    const events = (abi) => abi.filter((entry) => entry.type === 'event');
    const index = new Index(db, client, {
      chainId: config.chainId,
      startBlock: config.startBlock,
      confirmations: config.confirmations,
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
    const taker = takerWallet
      ? new Taker(db, index, client, takerWallet, config)
      : null;
    let bookingReporter;
    if (bookingWallet) {
      bookingDb = openDatabase(bookingDatabase);
      const Reporter =
        BookingReporter ??
        (await import('./day-booking.mjs')).DayBookingReporter;
      bookingReporter = new Reporter(bookingDb, client, bookingWallet, {
        chainId: config.chainId,
        factory: config.factory,
      });
    }
    server = serverFactory({
      client,
      index,
      config,
      bookingReporter,
      webhookToken,
    });
    await new Promise((done, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => {
        server.removeListener('error', reject);
        done();
      });
    });
    const cycle = () => {
      if (stopping) return;
      active = (async () => {
        try {
          await bookingReporter?.recover();
          if (stopping) return;
          if (taker) await taker.tick();
          else await index.sync();
        } catch {
          log('Day backend cycle failed; saved transactions retained.');
        } finally {
          if (!stopping) timer = setTimeout(cycle, intervalMs);
        }
      })();
    };
    cycle();
    return { server, index, taker, bookingReporter, config, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    const runtime = await startDayRuntime(loadDayRuntimeOptions(), {
      log: (message) => console.error(message),
    });
    const shutdown = () => {
      void runtime
        .stop()
        .catch(() => {
          console.error('Day backend shutdown failed.');
          process.exitCode = 1;
        })
        .finally(() => {
          process.off('SIGINT', shutdown);
          process.off('SIGTERM', shutdown);
        });
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
    console.log(
      `Day backend listening on port ${runtime.server.address().port}.`,
    );
  } catch {
    console.error(
      'Day backend startup failed; check deployment and private runtime configuration.',
    );
    process.exitCode = 1;
  }
}
