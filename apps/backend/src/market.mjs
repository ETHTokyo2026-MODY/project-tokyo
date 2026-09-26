import { compatible } from './matcher.mjs';
import { routerAbi, programTerms } from './protocol.mjs';

const MAX_ORDERS = 20;
const MAX_HISTORY = 20;

export class MarketInputError extends Error {}

function page(limit, offset, max) {
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > max ||
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    offset > 1000
  )
    throw new MarketInputError('invalid pagination');
}

function reverted(error) {
  return (
    error?.name === 'ContractFunctionRevertedError' ||
    !!error?.walk?.((cause) => cause.name === 'ContractFunctionRevertedError')
  );
}

function live(order, timestamp, usdc) {
  return timestamp <= programTerms(order.strategy, usdc).expiry;
}

function rank(a, b) {
  for (const key of ['total', 'price']) {
    const left = BigInt(a[key]);
    const right = BigInt(b[key]);
    if (left !== right) return left < right ? -1 : 1;
  }
  if (a.bidHash !== b.bidHash) return a.bidHash < b.bidHash ? -1 : 1;
  if (a.askHash !== b.askHash) return a.askHash < b.askHash ? -1 : 1;
  return 0;
}

function basketKey(quote) {
  return JSON.stringify([
    quote.bidMaker.toLowerCase(),
    quote.inventory.toLowerCase(),
    quote.ids,
    quote.quantity,
  ]);
}

// Quotes are independent simulations at one block. A buyer may register many
// alternative orders against the same wallet funds; the list is not liquidity.
/** Bounded, funding-aware views of shipped strategies and canonical right-sale events. */
export class Market {
  constructor(book, index, client, config) {
    if (!book?.list || !index?.tip || !client?.simulateContract)
      throw new Error('Market dependencies required');
    this.book = book;
    this.index = index;
    this.client = client;
    this.config = config;
    this.db = book.store?.db;
  }

  async #chain() {
    if ((await this.client.getChainId()) !== Number(this.config.chainId))
      throw new Error('RPC chain ID differs from market');
  }

  async #canonical(block) {
    const current = await this.client.getBlock({ blockNumber: block.number });
    if (current?.hash?.toLowerCase() !== block.hash?.toLowerCase())
      throw new Error('Market snapshot reorganized');
  }

  /**
   * Simulate pairs at one block. Results are independent opportunities, not additive liquidity:
   * multiple bids can spend the same wallet funds and multiple asks can overlap in inventory.
   */
  async quotes({ limit = MAX_ORDERS, offset = 0 } = {}) {
    page(limit, offset, MAX_ORDERS);
    await this.#chain();
    const block = await this.client.getBlock();
    if (
      block?.number === undefined ||
      !block.hash ||
      block.timestamp === undefined
    )
      throw new Error('Market block unavailable');
    const orders = this.book
      .list({ limit, offset })
      .filter((order) =>
        live(order, BigInt(block.timestamp), this.config.usdc),
      );
    const bids = orders.filter((order) => order.strategy.buy);
    const asks = orders.filter((order) => !order.strategy.buy);
    const quotes = [];
    let checkedPairs = 0;
    for (const bid of bids) {
      for (const ask of asks) {
        if (!compatible(bid, ask)) continue;
        checkedPairs++;
        try {
          const { result } = await this.client.simulateContract({
            address: this.config.router,
            abi: routerAbi,
            functionName: 'swap',
            args: [bid.strategy, ask.strategy],
            blockNumber: block.number,
          });
          const price = result;
          quotes.push({
            bidHash: bid.hash,
            askHash: ask.hash,
            bidMaker: bid.strategy.maker,
            askMaker: ask.strategy.maker,
            inventory: bid.strategy.inventory,
            ids: bid.strategy.ids,
            quantity: bid.strategy.quantity,
            price: price.toString(),
            total: price.toString(),
          });
        } catch (error) {
          if (!reverted(error)) throw error;
        }
      }
    }
    await this.#canonical(block);
    quotes.sort(rank);
    const byBasket = new Map();
    for (const quote of quotes) {
      const key = basketKey(quote);
      if (!byBasket.has(key)) byBasket.set(key, quote);
    }
    return {
      blockNumber: block.number.toString(),
      blockHash: block.hash,
      window: { limit, offset, checkedPairs },
      execution: 'one pair at a time; shared-wallet bids are alternatives',
      bestByBasket: [...byBasket.entries()]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([, quote]) => quote),
      quotes,
    };
  }

  /** Attribute a bounded settlement window to stored baskets; these are right-sale prices, not guest revenue. */
  async history({ limit = MAX_HISTORY, offset = 0 } = {}) {
    page(limit, offset, MAX_HISTORY);
    await this.#chain();
    const tip = this.index.tip();
    if (!tip || !this.db)
      throw new Error('Canonical settlement index unavailable');
    const block = { number: BigInt(tip.number), hash: tip.hash };
    await this.#canonical(block);
    const rows = this.db
      .prepare(
        `WITH event_window AS MATERIALIZED (
           SELECT block_number, log_index, transaction_hash, args
           FROM chain_events
           WHERE name = 'Swapped'
           ORDER BY block_number DESC, log_index DESC
           LIMIT ? OFFSET ?
         )
         SELECT e.block_number, e.transaction_hash, e.args,
          bid.payload AS bid, ask.payload AS ask
         FROM event_window e
         LEFT JOIN orders bid ON bid.hash = json_extract(e.args, '$.bidHash')
         LEFT JOIN orders ask ON ask.hash = json_extract(e.args, '$.askHash')
         ORDER BY e.block_number DESC, e.log_index DESC`,
      )
      .all(limit, offset);
    const sales = rows
      .filter((row) => row.bid && row.ask)
      .map((row) => {
        const event = JSON.parse(row.args);
        const bid = JSON.parse(row.bid).strategy;
        const ask = JSON.parse(row.ask).strategy;
        return {
          blockNumber: String(row.block_number),
          transactionHash: row.transaction_hash,
          bidHash: event.bidHash,
          askHash: event.askHash,
          inventory: bid.inventory,
          ids: bid.ids,
          quantity: bid.quantity,
          buyer: bid.maker,
          seller: ask.maker,
          price: event.payment,
        };
      });
    if (this.index.tip()?.hash !== tip.hash)
      throw new Error('Market index changed');
    await this.#canonical(block);
    return {
      indexedThrough: String(tip.number),
      priceSignal: 'settled rental-right sales',
      bookingHistory: 'unavailable',
      window: { limit, offset, events: rows.length, attributed: sales.length },
      sales,
    };
  }
}
