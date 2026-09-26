import { encodeFunctionData, keccak256, concatHex } from 'viem';
import { routerAbi } from './protocol.mjs';
import { StoredSubmission } from './submission.mjs';
export { ensureSubmissions } from './submission.mjs';
const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();

export function compatible(bid, ask) {
  return (
    bid.order.buy &&
    !ask.order.buy &&
    ['pool', 'startDay', 'endDay', 'quantity', 'terms', 'programHash'].every(
      (key) => same(bid.order[key], ask.order[key]),
    )
  );
}

// One dedicated relayer account per database. Signed bytes are persisted before
// broadcasting, so timeout/restart recovery never creates a second transaction.
export class Matcher {
  constructor(store, book, client, wallet, config) {
    this.db = store.db;
    this.book = book;
    this.client = client;
    this.wallet = wallet;
    this.config = config;
    this.sender = wallet.account.address.toLowerCase();
    this.submissions = new StoredSubmission(this.db, client, wallet, {
      chainId: Number(config.chainId),
      kind: 'ordinary',
    });
  }

  get(id) {
    return this.submissions.get(id);
  }

  async candidates(limit = 20, offset = 0) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      throw new Error('Invalid limit');
    const orders = this.book.list({ limit: 100, offset });
    const matches = [];
    for (const bid of orders.filter((o) => o.order.buy)) {
      for (const ask of orders.filter((o) => !o.order.buy)) {
        if (!compatible(bid, ask)) continue;
        try {
          const { result } = await this.simulate(bid, ask);
          matches.push({
            bidHash: bid.hash,
            askHash: ask.hash,
            price: result[0].toString(),
            fee: result[1].toString(),
          });
          if (matches.length === limit) return matches;
        } catch (error) {
          // Only contract rejection disqualifies a pair. RPC failures must surface.
          if (
            !error.walk?.(
              (cause) => cause.name === 'ContractFunctionRevertedError',
            )
          )
            throw error;
        }
      }
    }
    return matches;
  }

  async simulate(bid, ask) {
    if ((await this.client.getChainId()) !== Number(this.config.chainId))
      throw new Error('Wrong chain');
    if (!compatible(bid, ask)) throw new Error('Incompatible orders');
    return this.client.simulateContract({
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
      account: this.wallet.account,
    });
  }

  async submit(bidHash, askHash) {
    if ((await this.client.getChainId()) !== Number(this.config.chainId))
      throw new Error('Wrong chain');
    const bid = this.book.get(bidHash),
      ask = this.book.get(askHash);
    if (!bid || !ask) throw new Error('Unknown order');
    const id = keccak256(concatHex([bid.hash, ask.hash]));
    const data = encodeFunctionData({
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
    });
    const { job, receipt } = await this.submissions.submit({
      id,
      bidHash: bid.hash,
      askHash: ask.hash,
      to: this.config.router,
      data,
      simulate: () => this.simulate(bid, ask),
    });
    return this.result(job, receipt);
  }

  async receipt(hash) {
    return this.submissions.receipt(hash);
  }

  result(job, receipt) {
    return {
      id: job.id,
      transactionHash: job.tx_hash,
      state: receipt
        ? receipt.status === 'success'
          ? 'mined'
          : 'reverted'
        : 'broadcast',
    };
  }

  async status(id, index) {
    const job = this.get(id);
    if (!job) throw new Error('Unknown submission');
    if (!job.tx_hash) return { id, state: 'prepared' };
    const receipt = await this.receipt(job.tx_hash);
    const result = this.result(job, receipt);
    if (
      receipt?.status === 'success' &&
      (await index.confirmedSettlement(job.tx_hash, job.bid_hash, job.ask_hash))
    )
      result.state = 'confirmed';
    return result;
  }

  async recover() {
    const jobs = this.db
      .prepare(
        "SELECT bid_hash, ask_hash FROM submissions WHERE kind = 'ordinary' ORDER BY nonce",
      )
      .all();
    const results = [];
    for (const job of jobs)
      results.push(await this.submit(job.bid_hash, job.ask_hash));
    return results;
  }
}
