import { compatible } from './matcher.mjs';
import { routerAbi } from './protocol.mjs';

const MAX_ORDERS = 20;
const MAX_HISTORY = 20;
const DAY = 86_400n;

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

function live(order, timestamp) {
  return (
    timestamp < BigInt(order.order.expiry) &&
    timestamp < BigInt(order.order.startDay) * DAY &&
    (!order.order.buy || timestamp < BigInt(order.mandate.expiry))
  );
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

// Quotes are independent simulations at one block. A buyer may sign many
// alternative orders against the same wallet funds; the list is not liquidity.
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
      .filter((order) => live(order, BigInt(block.timestamp)));
    const bids = orders.filter((order) => order.order.buy);
    const asks = orders.filter((order) => !order.order.buy);
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
            functionName: 'settle',
            args: [
              bid.order,
              bid.signature,
              ask.order,
              ask.signature,
              bid.mandate,
              bid.program,
            ],
            blockNumber: block.number,
          });
          const [price, fee] = result;
          quotes.push({
            bidHash: bid.hash,
            askHash: ask.hash,
            bidMaker: bid.order.maker,
            askMaker: ask.order.maker,
            mandate: bid.order.mandate,
            pool: bid.order.pool,
            startDay: bid.order.startDay,
            endDay: bid.order.endDay,
            quantity: bid.order.quantity,
            terms: bid.order.terms,
            price: price.toString(),
            fee: fee.toString(),
            total: (price + fee).toString(),
          });
        } catch (error) {
          if (!reverted(error)) throw error;
        }
      }
    }
    await this.#canonical(block);
    quotes.sort(rank);
    return {
      blockNumber: block.number.toString(),
      blockHash: block.hash,
      window: { limit, offset, checkedPairs },
      execution: 'one pair at a time; shared-wallet bids are alternatives',
      best: quotes[0] ?? null,
      quotes,
    };
  }

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
        `SELECT e.block_number, e.transaction_hash, e.args,
          bid.payload AS bid, ask.payload AS ask
         FROM chain_events e
         JOIN orders bid ON bid.hash = json_extract(e.args, '$.buyHash')
         JOIN orders ask ON ask.hash = json_extract(e.args, '$.sellHash')
         WHERE e.name = 'Settled'
         ORDER BY e.block_number DESC, e.log_index DESC
         LIMIT ? OFFSET ?`,
      )
      .all(limit, offset);
    const sales = rows.map((row) => {
      const event = JSON.parse(row.args);
      const bid = JSON.parse(row.bid).order;
      const ask = JSON.parse(row.ask).order;
      return {
        blockNumber: String(row.block_number),
        transactionHash: row.transaction_hash,
        bidHash: event.buyHash,
        askHash: event.sellHash,
        pool: bid.pool,
        startDay: bid.startDay,
        endDay: bid.endDay,
        quantity: bid.quantity,
        terms: bid.terms,
        buyer: bid.maker,
        seller: ask.maker,
        price: event.price,
        fee: event.fee,
      };
    });
    if (this.index.tip()?.hash !== tip.hash)
      throw new Error('Market index changed');
    await this.#canonical(block);
    return {
      indexedThrough: String(tip.number),
      priceSignal: 'settled rental-right sales',
      bookingHistory: 'unavailable',
      sales,
    };
  }
}
