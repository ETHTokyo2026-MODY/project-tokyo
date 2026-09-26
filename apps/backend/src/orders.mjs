import {
  address,
  aquaAbi,
  assetsFor,
  decodeStrategy,
  hashStrategy,
  normalizeStrategy,
  programTerms,
  PROTOCOL,
  serialize,
  verifyDeployment,
} from './protocol.mjs';

export class OrderInputError extends Error {}
const same = (a, b) => a.toLowerCase() === b.toLowerCase();
const hashValue = (h) => {
  if (!/^0x[0-9a-fA-F]{64}$/.test(h))
    throw new OrderInputError('Invalid strategy hash');
  return h.toLowerCase();
};

/** A durable cache of immutable shipped strategies. Onchain authorization remains authoritative. */
export class OrderBook {
  constructor(store, publicClient, config) {
    if (
      !store?.db ||
      !publicClient?.readContract ||
      !Number.isSafeInteger(config?.chainId) ||
      config.chainId <= 0
    )
      throw new OrderInputError('Invalid order book dependencies');
    this.config = {
      protocol: PROTOCOL,
      chainId: config.chainId,
      router: address(config.router),
      aqua: address(config.aqua),
      usdc: address(config.usdc),
    };
    this.store = store;
    this.publicClient = publicClient;
    const scope = serialize(this.config);
    const prior = store.db
      .prepare("SELECT value FROM metadata WHERE key='scope'")
      .get();
    if (prior && prior.value !== scope)
      throw new OrderInputError(
        'Order store deployment/protocol mismatch; use a new database',
      );
    if (!prior)
      store.db
        .prepare("INSERT INTO metadata(key,value) VALUES ('scope',?)")
        .run(scope);
  }

  /** Fast-path intake after wallet registration; no offchain signature or separate funding mandate. */
  async submit(envelope) {
    let strategy;
    try {
      if (!envelope || Object.keys(envelope).join() !== 'strategy')
        throw new Error('Expected strategy');
      strategy = normalizeStrategy(envelope.strategy, this.config.usdc);
    } catch (e) {
      throw new OrderInputError(e.message);
    }
    const hash = hashStrategy(strategy);
    const block = await this.publicClient.getBlock();
    const at = { blockNumber: block.number };
    await verifyDeployment(this.publicClient, this.config, at);
    if (programTerms(strategy, this.config.usdc).expiry < block.timestamp)
      throw new OrderInputError('Expired strategy');
    const balances = await Promise.all(
      assetsFor(strategy, this.config.usdc).map((asset) =>
        this.publicClient.readContract({
          address: this.config.aqua,
          abi: aquaAbi,
          functionName: 'rawBalances',
          args: [strategy.maker, this.config.router, hash, asset],
          ...at,
        }),
      ),
    );
    if (
      balances.some(
        ([amount, count]) =>
          Number(count) === 0 || Number(count) === 255 || BigInt(amount) === 0n,
      )
    )
      throw new OrderInputError('Strategy is not actively registered');
    const after = await this.publicClient.getBlock({
      blockNumber: block.number,
    });
    if (!same(after.hash, block.hash))
      throw new Error('Registration snapshot reorganized');
    return this.persist(strategy);
  }

  /** Called only for verified canonical Shipped logs from the configured AquaVapor deployment. */
  ingestShipped(event) {
    if (!same(event.app, this.config.router)) return;
    let strategy;
    try {
      strategy = decodeStrategy(event.strategy, this.config.usdc);
    } catch {
      return;
    }
    if (
      !same(strategy.maker, event.maker) ||
      !same(hashStrategy(strategy), event.strategyHash)
    )
      return;
    return this.persist(strategy);
  }

  persist(strategy) {
    const hash = hashStrategy(strategy),
      payload = serialize({ hash, strategy });
    const prior = this.get(hash);
    if (prior && serialize(prior) !== payload)
      throw new OrderInputError('Conflicting strategy');
    this.store.db
      .prepare(
        'INSERT OR IGNORE INTO orders(hash,payload,created_at) VALUES (?,?,?)',
      )
      .run(hash, payload, Math.floor(Date.now() / 1000));
    return this.get(hash);
  }
  get(hash) {
    const row = this.store.db
      .prepare('SELECT payload FROM orders WHERE hash=?')
      .get(hashValue(hash));
    return row ? JSON.parse(row.payload) : undefined;
  }
  list({ limit = 100, offset = 0 } = {}) {
    if (
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 1000 ||
      !Number.isSafeInteger(offset) ||
      offset < 0
    )
      throw new OrderInputError('Invalid pagination');
    return this.store.db
      .prepare(
        'SELECT payload FROM orders ORDER BY created_at,rowid LIMIT ? OFFSET ?',
      )
      .all(limit, offset)
      .map(({ payload }) => JSON.parse(payload));
  }
}
