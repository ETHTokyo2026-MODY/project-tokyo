import { getAddress } from 'viem';
import { routerAbi, aquaAbi, assetsFor, programTerms } from './protocol.mjs';

const BATCH_SIZE = 64;
const EVENTS = new Set([
  'Swapped',
  'InvalidateBitUpdated',
  'Shipped',
  'Docked',
  'Moved',
]);
const EVENT_ABI = [...routerAbi, ...aquaAbi].filter(
  (item) => item.type === 'event' && EVENTS.has(item.name),
);

function integer(value, name) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0)
    throw new Error(`Invalid ${name}`);
  return number;
}

function normalize(value) {
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'string' && value.startsWith('0x'))
    return value.toLowerCase();
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, normalize(item)]),
    );
  }
  return value;
}

function transaction(db, action) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = action();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

/**
 * Canonical, confirmation-delayed view of one router. Stored block ancestry includes empty blocks
 * so a reorg can invalidate both events and apparent absence of events. Confirmed is not finality.
 */
export class ChainIndex {
  constructor(
    store,
    client,
    { chainId, router, aqua, usdc, startBlock, confirmations = 2 },
    book,
  ) {
    this.db = store.db;
    this.client = client;
    this.chainId = integer(chainId, 'chainId');
    this.router = getAddress(router);
    this.aqua = getAddress(aqua);
    this.usdc = getAddress(usdc);
    this.book = book;
    this.startBlock = integer(startBlock, 'startBlock');
    this.confirmations = integer(confirmations, 'confirmations');
    if (!this.db || !client) throw new Error('Store and chain client required');

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS chain_meta (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        chain_id INTEGER NOT NULL,
        router TEXT NOT NULL,
        start_block INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS blocks (
        number INTEGER PRIMARY KEY,
        hash TEXT NOT NULL,
        parent_hash TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS chain_events (
        block_number INTEGER NOT NULL REFERENCES blocks(number) ON DELETE CASCADE,
        log_index INTEGER NOT NULL,
        transaction_hash TEXT NOT NULL,
        name TEXT NOT NULL,
        args TEXT NOT NULL,
        PRIMARY KEY (block_number, log_index)
      );
      CREATE INDEX IF NOT EXISTS chain_events_name ON chain_events(name);
      CREATE INDEX IF NOT EXISTS chain_events_name_position ON chain_events(name, block_number DESC, log_index DESC);
      CREATE INDEX IF NOT EXISTS chain_events_tx ON chain_events(transaction_hash);
    `);
    const hasScopeTable = this.db
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'metadata'",
      )
      .get();
    const scope =
      hasScopeTable &&
      this.db.prepare("SELECT value FROM metadata WHERE key = 'scope'").get();
    if (scope) {
      const configured = JSON.parse(scope.value);
      if (
        integer(configured.chainId, 'stored chainId') !== this.chainId ||
        getAddress(configured.router).toLowerCase() !==
          this.router.toLowerCase() ||
        configured.aqua?.toLowerCase() !== this.aqua.toLowerCase() ||
        configured.usdc?.toLowerCase() !== this.usdc.toLowerCase()
      ) {
        throw new Error(
          'Chain index configuration differs from order store scope',
        );
      }
    }
    this.db.exec(
      'CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL)',
    );
    const identity = JSON.stringify({
      chainId: this.chainId,
      router: this.router,
      aqua: this.aqua,
      usdc: this.usdc,
    });
    const priorIdentity = this.db
      .prepare("SELECT value FROM metadata WHERE key='chain_scope'")
      .get();
    if (priorIdentity && priorIdentity.value !== identity)
      throw new Error('Chain deployment identity differs');
    if (!priorIdentity)
      this.db
        .prepare("INSERT INTO metadata VALUES ('chain_scope', ?)")
        .run(identity);
    const meta = this.db
      .prepare(
        'SELECT chain_id, router, start_block FROM chain_meta WHERE id = 1',
      )
      .get();
    if (meta) {
      if (
        meta.chain_id !== this.chainId ||
        meta.router !== this.router.toLowerCase() ||
        meta.start_block !== this.startBlock
      ) {
        throw new Error(
          'Chain index configuration differs from stored chain identity',
        );
      }
    } else {
      this.db
        .prepare(
          'INSERT INTO chain_meta (id, chain_id, router, start_block) VALUES (1, ?, ?, ?)',
        )
        .run(this.chainId, this.router.toLowerCase(), this.startBlock);
    }
  }

  tip() {
    return (
      this.db
        .prepare('SELECT number, hash FROM blocks ORDER BY number DESC LIMIT 1')
        .get() ?? null
    );
  }

  // Each call reconciles and indexes at most one batch. Repeated calls catch up a long history.
  async sync() {
    if (this.syncing) return this.syncing;
    this.syncing = this.#sync();
    try {
      return await this.syncing;
    } finally {
      this.syncing = null;
    }
  }

  async #sync() {
    const actualChainId = integer(
      await this.client.getChainId(),
      'RPC chainId',
    );
    if (actualChainId !== this.chainId)
      throw new Error('RPC chain ID differs from chain index');

    const head = integer(
      await this.client.getBlockNumber(),
      'RPC block number',
    );
    const target = head - this.confirmations;
    let tip = this.tip();
    if (tip && tip.number > target) {
      this.#removeFrom(Math.max(this.startBlock, target + 1));
      tip = this.tip();
    }

    // Walk only one batch backwards. A deeper reorg is unwound across sync calls.
    let checked = 0;
    while (tip && checked < BATCH_SIZE) {
      const canonical = await this.client.getBlock({
        blockNumber: BigInt(tip.number),
      });
      if (canonical?.hash?.toLowerCase() === tip.hash) break;
      this.#removeFrom(tip.number);
      tip = this.tip();
      checked++;
    }
    if (tip && checked === BATCH_SIZE) return tip.number;
    if (target < this.startBlock) return null;

    const first = tip ? tip.number + 1 : this.startBlock;
    const last = Math.min(target, first + BATCH_SIZE - 1);
    for (let number = first; number <= last; number++) {
      const block = await this.client.getBlock({ blockNumber: BigInt(number) });
      if (!block?.hash || !block.parentHash)
        throw new Error(`Missing block ${number}`);
      const hash = block.hash.toLowerCase();
      const parentHash = block.parentHash.toLowerCase();
      if (tip && parentHash !== tip.hash) {
        this.#removeFrom(tip.number);
        return this.tip()?.number ?? null;
      }
      const logs = await this.client.getLogs({
        address: [this.router, this.aqua],
        events: EVENT_ABI,
        blockHash: block.hash,
      });
      const after = await this.client.getBlock({ blockNumber: BigInt(number) });
      if (after?.hash?.toLowerCase() !== hash)
        return this.tip()?.number ?? null;

      transaction(this.db, () => {
        this.db
          .prepare(
            'INSERT INTO blocks (number, hash, parent_hash) VALUES (?, ?, ?)',
          )
          .run(number, hash, parentHash);
        const insert = this.db.prepare(`INSERT INTO chain_events
          (block_number, log_index, transaction_hash, name, args) VALUES (?, ?, ?, ?, ?)`);
        for (const log of logs) {
          if (
            log.blockHash?.toLowerCase() !== hash ||
            integer(log.blockNumber, 'log block number') !== number ||
            log.address?.toLowerCase() !==
              (['Shipped', 'Docked', 'Moved'].includes(log.eventName)
                ? this.aqua
                : this.router
              ).toLowerCase()
          ) {
            throw new Error(`Log does not match block ${number} or router`);
          }
          if (!EVENTS.has(log.eventName)) continue;
          if (
            log.args.app &&
            log.args.app.toLowerCase() !== this.router.toLowerCase()
          )
            continue;
          if (log.eventName === 'Shipped') this.book?.ingestShipped(log.args);
          insert.run(
            number,
            integer(log.logIndex, 'log index'),
            log.transactionHash.toLowerCase(),
            log.eventName,
            JSON.stringify(normalize(log.args)),
          );
        }
      });
      tip = { number, hash };
    }
    return tip?.number ?? null;
  }

  #removeFrom(number) {
    transaction(this.db, () => {
      this.db
        .prepare('DELETE FROM chain_events WHERE block_number >= ?')
        .run(number);
      this.db.prepare('DELETE FROM blocks WHERE number >= ?').run(number);
    });
  }

  settled(hash) {
    const needle = hash.toLowerCase();
    return !!this.db
      .prepare(
        `SELECT 1 FROM chain_events WHERE name = 'Swapped'
      AND (json_extract(args, '$.bidHash') = ? OR json_extract(args, '$.askHash') = ?) LIMIT 1`,
      )
      .get(needle, needle);
  }

  async confirmedSettlement(transactionHash, bidHash, askHash) {
    const tip = this.tip();
    if (!tip || !(await this.#isCanonical(tip))) return false;
    const matched = !!this.db
      .prepare(
        `SELECT 1 FROM chain_events WHERE transaction_hash = ? AND name = 'Swapped'
      AND json_extract(args, '$.bidHash') = ? AND json_extract(args, '$.askHash') = ? LIMIT 1`,
      )
      .get(
        transactionHash.toLowerCase(),
        bidHash.toLowerCase(),
        askHash.toLowerCase(),
      );
    const stillCanonical =
      this.tip()?.hash === tip.hash && (await this.#isCanonical(tip));
    return matched && stillCanonical;
  }

  /** Open means active virtual authority at the indexed block, not reserved funds or guaranteed execution. */
  async status(envelope) {
    const tip = this.tip();
    if (!tip || !(await this.#isCanonical(tip))) return 'unknown';
    const s = envelope.strategy,
      hash = envelope.hash;
    const at = { blockNumber: BigInt(tip.number) };
    const terms = programTerms(s, this.usdc);
    const block = await this.client.getBlock(at);
    const balances = await Promise.all(
      assetsFor(s, this.usdc).map((asset) =>
        this.client.readContract({
          address: this.aqua,
          abi: aquaAbi,
          functionName: 'rawBalances',
          args: [s.maker, this.router, hash, asset],
          ...at,
        }),
      ),
    );
    const bitmap =
      terms.nonce === undefined
        ? 0n
        : await this.client.readContract({
            address: this.router,
            abi: routerAbi,
            functionName: 'bitInvalidators',
            args: [s.maker, terms.nonce >> 8n],
            ...at,
          });
    if (this.tip()?.hash !== tip.hash || !(await this.#isCanonical(tip)))
      return 'unknown';
    if (balances.some(([, count]) => Number(count) === 0))
      return 'unregistered';
    if (balances.some(([, count]) => Number(count) === 255)) return 'cancelled';
    const used =
      terms.nonce !== undefined &&
      (bitmap & (1n << (terms.nonce & 255n))) !== 0n;
    if (used) return this.settled(hash) ? 'filled' : 'cancelled';
    if (
      balances.some(
        ([amount]) => BigInt(amount) < (s.buy ? 1n : BigInt(s.quantity)),
      )
    )
      return this.settled(hash) ? 'filled' : 'exhausted';
    if (BigInt(block.timestamp) > terms.expiry) return 'expired';
    return 'open';
  }

  async #isCanonical(tip) {
    const block = await this.client.getBlock({
      blockNumber: BigInt(tip.number),
    });
    return block?.hash?.toLowerCase() === tip.hash;
  }
}
