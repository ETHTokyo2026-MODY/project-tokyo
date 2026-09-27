import { getAddress } from 'viem';

const BATCH = 2000;
const READY_LAG = 5;
const hash = (value) => {
  if (typeof value !== 'string' || !/^0x[0-9a-f]{64}$/i.test(value))
    throw new Error('Invalid chain hash');
  return value.toLowerCase();
};
function integer(value, label) {
  if (
    !['number', 'bigint'].includes(typeof value) ||
    !Number.isSafeInteger(Number(value)) ||
    Number(value) < 0
  )
    throw new Error(`Invalid ${label}`);
  return Number(value);
}
// JSON event integers are decimal strings; strings and their case are preserved.
function stable(value) {
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((k) => [k, stable(value[k])]),
    );
  return value;
}
const encode = (value) => JSON.stringify(stable(value));
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

/** Rebuildable chain data only. Range tips and log-bearing blocks retain ancestry; confirmations are not finality. */
export class EventIndex {
  #syncing;
  #reorgVersion = 0;
  constructor(
    db,
    client,
    { chainId, startBlock, confirmations = 2, sources, scope },
  ) {
    this.db = db;
    this.client = client;
    this.chainId = integer(chainId, 'chain ID');
    this.startBlock = integer(startBlock, 'start block');
    this.confirmations = integer(confirmations, 'confirmations');
    if (
      !db?.prepare ||
      !client?.getChainId ||
      !client?.getBlockNumber ||
      !client?.getBlock ||
      !client?.getLogs ||
      !scope ||
      !Array.isArray(sources) ||
      !sources.length
    )
      throw new Error(
        'Database, client, deployment scope and event sources required',
      );
    this.sources = sources
      .map(({ address, events }) => {
        if (
          !Array.isArray(events) ||
          !events.length ||
          events.some(
            (e) => e.type !== 'event' || !e.name || !Array.isArray(e.inputs),
          ) ||
          new Set(events.map((e) => e.name)).size !== events.length
        )
          throw new Error('Each source requires uniquely named event ABIs');
        return {
          address: getAddress(address).toLowerCase(),
          events: JSON.parse(encode(events)).sort((a, b) =>
            a.name.localeCompare(b.name),
          ),
        };
      })
      .sort((a, b) => a.address.localeCompare(b.address));
    if (
      new Set(this.sources.map((s) => s.address)).size !== this.sources.length
    )
      throw new Error('Duplicate event source address');
    const identity = encode({
      chainId: this.chainId,
      startBlock: this.startBlock,
      confirmations: this.confirmations,
      sources: this.sources,
      scope,
    });
    transaction(db, () => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS event_index_identity (
          id INTEGER PRIMARY KEY CHECK(id=1), identity TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS event_index_blocks (
          number INTEGER PRIMARY KEY, hash TEXT NOT NULL, parent_hash TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS event_index_logs (
          block_number INTEGER NOT NULL, log_index INTEGER NOT NULL,
          address TEXT NOT NULL, name TEXT NOT NULL, args TEXT NOT NULL,
          transaction_hash TEXT NOT NULL,
          PRIMARY KEY(block_number, log_index)
        );
        CREATE INDEX IF NOT EXISTS event_index_log_names ON event_index_logs(name);
      `);
      const prior = db
        .prepare('SELECT identity FROM event_index_identity WHERE id=1')
        .get();
      if (prior && prior.identity !== identity)
        throw new Error('Event index deployment identity differs');
      if (!prior)
        db.prepare('INSERT INTO event_index_identity VALUES(1, ?)').run(
          identity,
        );
    });
  }

  /** Cached cursor. Use readiness() before treating cached events as current. */
  tip() {
    const row = this.db
      .prepare(
        'SELECT number, hash FROM event_index_blocks ORDER BY number DESC LIMIT 1',
      )
      .get();
    return row ? { number: row.number, hash: row.hash } : null;
  }

  /** Retained ancestry at a pinned height; forward growth preserves this row. */
  block(number) {
    const row = this.db
      .prepare('SELECT number, hash FROM event_index_blocks WHERE number = ?')
      .get(integer(number, 'block number'));
    return row ? { number: row.number, hash: row.hash } : null;
  }

  /** Detect a rewind even if the same branch is restored during a consumer read. */
  get reorgVersion() {
    return this.#reorgVersion;
  }

  async #target() {
    if (
      integer(await this.client.getChainId(), 'RPC chain ID') !== this.chainId
    )
      throw new Error('RPC chain ID differs from event index');
    return (
      integer(await this.client.getBlockNumber(), 'RPC block number') -
      this.confirmations
    );
  }

  /** Point-in-time readiness; callers must still validate execution against live contract state. */
  async readiness() {
    const target = await this.#target();
    const tip = this.tip();
    const block =
      tip && tip.number <= target
        ? await this.client.getBlock({ blockNumber: BigInt(tip.number) })
        : null;
    const canonical =
      !!tip &&
      block?.hash?.toLowerCase() === tip.hash &&
      this.tip()?.hash === tip.hash;
    return {
      ready:
        canonical && tip.number <= target && target - tip.number <= READY_LAG,
      canonical,
      tip,
      target,
    };
  }

  // Concurrent callers share one sync; each run walks 500-block ranges to target.
  async sync() {
    if (this.#syncing) return this.#syncing;
    this.#syncing = this.#sync();
    try {
      return await this.#syncing;
    } finally {
      this.#syncing = null;
    }
  }

  async #sync() {
    const target = await this.#target();
    let tip = this.tip();
    if (tip && tip.number > target) {
      this.#removeFrom(Math.max(this.startBlock, target + 1));
      tip = this.tip();
    }
    let remaining = BATCH;
    while (tip && remaining > 0) {
      const block = await this.client.getBlock({
        blockNumber: BigInt(tip.number),
      });
      if (block?.hash?.toLowerCase() === tip.hash) break;
      this.#removeFrom(tip.number);
      tip = this.tip();
      remaining--;
    }
    if (!remaining || target < this.startBlock) return this.tip();
    while (true) {
      const first = tip ? tip.number + 1 : this.startBlock;
      if (first > target) return this.tip();
      const last = Math.min(target, first + BATCH - 1);
      const fromBlock = BigInt(first),
        toBlock = BigInt(last);
      // Drain every source before accepting a range or propagating a failure.
      const [firstBlock, lastBlock, results] = await Promise.all([
        this.client.getBlock({ blockNumber: fromBlock }),
        this.client.getBlock({ blockNumber: toBlock }),
        Promise.allSettled(
          this.sources.map((source) =>
            this.client.getLogs({
              address: source.address,
              events: source.events,
              strict: true,
              fromBlock,
              toBlock,
            }),
          ),
        ),
      ]);
      if (!firstBlock || integer(firstBlock.number, 'block number') !== first)
        throw new Error(`Missing or mismatched block ${first}`);
      if (!lastBlock || integer(lastBlock.number, 'block number') !== last)
        throw new Error(`Missing or mismatched block ${last}`);
      if (tip && hash(firstBlock.parentHash) !== tip.hash) {
        this.#removeFrom(tip.number);
        return this.tip();
      }
      const failed = results.find((result) => result.status === 'rejected');
      if (failed) throw failed.reason;
      const logs = [];
      const needed = new Set([last]);
      const rows = new Map([
        [
          first,
          {
            hash: hash(firstBlock.hash),
            parentHash: hash(firstBlock.parentHash),
          },
        ],
        [
          last,
          {
            hash: hash(lastBlock.hash),
            parentHash: hash(lastBlock.parentHash),
          },
        ],
      ]);
      for (let i = 0; i < this.sources.length; i++) {
        const source = this.sources[i];
        for (const log of results[i].value) {
          const number = integer(log.blockNumber, 'log block number');
          if (
            log.removed ||
            log.address?.toLowerCase() !== source.address ||
            !source.events.some((event) => event.name === log.eventName) ||
            number < first ||
            number > last ||
            !log.args ||
            typeof log.args !== 'object'
          )
            throw new Error(`Log does not match source or block ${number}`);
          logs.push({
            number,
            blockHash: hash(log.blockHash),
            address: source.address,
            name: log.eventName,
            args: encode(log.args),
            transactionHash: hash(log.transactionHash),
            logIndex: integer(log.logIndex, 'log index'),
          });
          needed.add(number);
        }
      }
      const missing = [...needed].filter((number) => !rows.has(number));
      const fetched = await Promise.all(
        missing.map((number) =>
          this.client.getBlock({ blockNumber: BigInt(number) }),
        ),
      );
      for (let i = 0; i < missing.length; i++) {
        const block = fetched[i],
          number = missing[i];
        if (!block || integer(block.number, 'block number') !== number)
          throw new Error(`Missing or mismatched block ${number}`);
        rows.set(number, {
          hash: hash(block.hash),
          parentHash: hash(block.parentHash),
        });
      }
      for (const log of logs) {
        if (log.blockHash !== rows.get(log.number)?.hash)
          throw new Error(`Log does not match source or block ${log.number}`);
      }
      const lastHash = rows.get(last).hash;
      const after = await this.client.getBlock({ blockNumber: toBlock });
      if (after?.hash?.toLowerCase() !== lastHash) return this.tip();
      transaction(this.db, () => {
        const insertBlock = this.db.prepare(
          'INSERT INTO event_index_blocks VALUES(?, ?, ?)',
        );
        for (const number of needed) {
          const row = rows.get(number);
          insertBlock.run(number, row.hash, row.parentHash);
        }
        const insert = this.db.prepare(
          'INSERT INTO event_index_logs VALUES(?, ?, ?, ?, ?, ?)',
        );
        for (const log of logs)
          insert.run(
            log.number,
            log.logIndex,
            log.address,
            log.name,
            log.args,
            log.transactionHash,
          );
      });
      tip = { number: last, hash: lastHash };
    }
  }

  #removeFrom(number) {
    let removed = false;
    transaction(this.db, () => {
      this.db
        .prepare('DELETE FROM event_index_logs WHERE block_number >= ?')
        .run(number);
      removed =
        this.db
          .prepare('DELETE FROM event_index_blocks WHERE number >= ?')
          .run(number).changes > 0;
    });
    if (removed) this.#reorgVersion++;
  }

  /**
   * Cached logs, newest first. Bigint args are decimal strings. limit bounds one
   * page, not history: pass its last row as before until a short page is returned.
   * Read pages synchronously between sync calls and recheck readiness before use.
   */
  events(name, limit = 1000, before) {
    if (
      (name !== undefined && (typeof name !== 'string' || !name)) ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 10000
    )
      throw new Error('Invalid event query');
    const clauses = [],
      params = [];
    if (name !== undefined) {
      clauses.push('l.name=?');
      params.push(name);
    }
    if (before !== undefined) {
      if (!before || typeof before !== 'object')
        throw new Error('Invalid event cursor');
      const block = integer(before.blockNumber, 'cursor block number');
      const log = integer(before.logIndex, 'cursor log index');
      clauses.push(
        '(l.block_number < ? OR (l.block_number = ? AND l.log_index < ?))',
      );
      params.push(block, block, log);
    }
    return this.db
      .prepare(
        `SELECT l.address, l.name, l.args,
      l.transaction_hash AS transactionHash, b.hash AS blockHash,
      l.block_number AS blockNumber, l.log_index AS logIndex
      FROM event_index_logs l JOIN event_index_blocks b ON b.number=l.block_number
      ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}
      ORDER BY l.block_number DESC, l.log_index DESC LIMIT ?`,
      )
      .all(...params, limit)
      .map((row) => ({ ...row, args: JSON.parse(row.args) }));
  }
}
