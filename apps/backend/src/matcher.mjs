import {
  encodeFunctionData,
  keccak256,
  concatHex,
  parseTransaction,
  recoverTransactionAddress,
} from 'viem';
import { routerAbi } from './protocol.mjs';

const pack = (value) =>
  JSON.stringify(value, (_, v) =>
    typeof v === 'bigint' ? { bigint: v.toString() } : v,
  );
const unpack = (value) =>
  JSON.parse(value, (_, v) =>
    v && typeof v === 'object' && Object.keys(v).length === 1 && 'bigint' in v
      ? BigInt(v.bigint)
      : v,
  );
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
    this.db.exec(`CREATE TABLE IF NOT EXISTS submissions (
      id TEXT PRIMARY KEY, bid_hash TEXT NOT NULL, ask_hash TEXT NOT NULL,
      sender TEXT NOT NULL, nonce INTEGER NOT NULL, unsigned TEXT,
      raw TEXT, tx_hash TEXT, UNIQUE(sender, nonce)
    )`);
  }

  get(id) {
    return this.db.prepare('SELECT * FROM submissions WHERE id = ?').get(id);
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
    let job = this.get(id);
    if (!job) {
      await this.simulate(bid, ask); // Funding/signatures/prices may have changed since intake.
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
      // RPC estimation completes before reserving a nonce; failed estimates cannot
      // leave a gap that blocks all later transactions from the relayer.
      const prepared = await this.wallet.prepareTransactionRequest({
        account: this.wallet.account,
        chain: this.wallet.chain,
        to: this.config.router,
        data,
        value: 0n,
      });
      const { account, chain, ...unsigned } = prepared;
      if (Number(unsigned.chainId) !== Number(this.config.chainId))
        throw new Error('Signer chain mismatch');
      const pending = await this.client.getTransactionCount({
        address: this.sender,
        blockTag: 'pending',
      });
      this.db.exec('BEGIN IMMEDIATE');
      try {
        job = this.get(id);
        if (!job) {
          const last = this.db
            .prepare('SELECT MAX(nonce) AS n FROM submissions WHERE sender = ?')
            .get(this.sender).n;
          const nonce = Math.max(pending, last === null ? 0 : last + 1);
          this.db
            .prepare(
              'INSERT INTO submissions(id,bid_hash,ask_hash,sender,nonce,unsigned) VALUES(?,?,?,?,?,?)',
            )
            .run(
              id,
              bid.hash,
              ask.hash,
              this.sender,
              nonce,
              pack({ ...unsigned, nonce }),
            );
        }
        this.db.exec('COMMIT');
      } catch (error) {
        this.db.exec('ROLLBACK');
        throw error;
      }
      job = this.get(id);
    }
    if (job.sender !== this.sender)
      throw new Error('Relayer changed for existing submission');
    if (!job.raw) {
      const request = unpack(job.unsigned);
      const expectedData = encodeFunctionData({
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
      if (
        !same(request.to, this.config.router) ||
        !same(request.data, expectedData) ||
        request.nonce !== job.nonce ||
        Number(request.chainId) !== Number(this.config.chainId) ||
        (request.value ?? 0n) !== 0n
      )
        throw new Error('Stored transaction differs from signed orders');
      const raw = await this.wallet.signTransaction({
        ...request,
        account: this.wallet.account,
        chain: this.wallet.chain,
      });
      const decoded = parseTransaction(raw);
      if (
        !same(
          await recoverTransactionAddress({ serializedTransaction: raw }),
          this.sender,
        ) ||
        !same(decoded.to, this.config.router) ||
        !same(decoded.data, request.data) ||
        decoded.nonce !== job.nonce ||
        Number(decoded.chainId) !== Number(this.config.chainId) ||
        (decoded.value ?? 0n) !== 0n
      )
        throw new Error('Signer returned a different transaction');
      this.db
        .prepare(
          'UPDATE submissions SET raw = ?, tx_hash = ? WHERE id = ? AND raw IS NULL',
        )
        .run(raw, keccak256(raw), id);
      job = this.get(id);
    }
    const receipt = await this.receipt(job.tx_hash);
    if (receipt) return this.result(job, receipt);
    // A lost RPC response leaves these exact bytes available for retry.
    try {
      await this.client.sendRawTransaction({ serializedTransaction: job.raw });
    } catch (error) {
      const mined = await this.receipt(job.tx_hash);
      if (!mined) throw error;
      return this.result(job, mined);
    }
    return this.result(job);
  }

  async receipt(hash) {
    try {
      return await this.client.getTransactionReceipt({ hash });
    } catch (error) {
      if (error.name === 'TransactionReceiptNotFoundError') return null;
      throw error;
    }
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
      .prepare('SELECT bid_hash, ask_hash FROM submissions ORDER BY nonce')
      .all();
    const results = [];
    for (const job of jobs)
      results.push(await this.submit(job.bid_hash, job.ask_hash));
    return results;
  }
}
