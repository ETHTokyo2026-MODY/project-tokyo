import {
  concatHex,
  decodeFunctionData,
  encodeFunctionData,
  getAddress,
  keccak256,
  parseEventLogs,
  toHex,
} from 'viem';
import {
  dayAssetAbi,
  dayFactoryAbi,
  dayRouterAbi,
  decodeDayPublication,
  hashDayStrategy,
  officialAquaAbi,
} from './day-protocol.mjs';
import { StoredSubmission } from './submission.mjs';

const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
const rejected = (error) =>
  error.name === 'ContractFunctionRevertedError' ||
  !!error.walk?.((cause) => cause.name === 'ContractFunctionRevertedError');
const askHash = (asks) =>
  keccak256(concatHex(asks.map((ask) => hashDayStrategy('ask', ask))));
const protocol = 'day-v1';
export const DEFAULT_TRANSACTION_GAS_LIMIT = 16_777_216n;

export function transactionGasLimit(value = DEFAULT_TRANSACTION_GAS_LIMIT) {
  if (!(
    typeof value === 'bigint' ||
    (typeof value === 'number' && Number.isSafeInteger(value)) ||
    (typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value))
  ))
    throw new Error('Invalid transaction gas limit');
  const limit = BigInt(value);
  if (limit < 21_000n || limit > DEFAULT_TRANSACTION_GAS_LIMIT)
    throw new Error('Transaction gas limit must be between 21000 and 16777216');
  return limit;
}

class CandidateGasError extends Error {}

// RPC wrappers vary by provider. Recognize explicit execution gas failures,
// while retaining transport/authentication failures even if their text mentions gas.
function gasRejected(error) {
  const causes = [],
    seen = new Set();
  for (let cause = error; cause && !seen.has(cause); cause = cause.cause) {
    seen.add(cause);
    causes.push(cause);
  }
  if (
    causes.some((cause) =>
      [
        'HttpRequestError',
        'TimeoutError',
        'SocketClosedError',
        'WebSocketRequestError',
      ].includes(cause.name),
    )
  )
    return false;
  return causes.some(
    (cause) =>
      cause instanceof CandidateGasError ||
      [
        'IntrinsicGasTooHighError',
        'IntrinsicGasTooLowError',
        'GasLimitTooHighError',
      ].includes(cause.name) ||
      /\bout of gas\b|gas required exceeds allowance|exceeds (?:the )?(?:block|transaction) gas limit|intrinsic gas too (?:low|high)|gas limit (?:is )?(?:too high|exceeded)/i.test(
        cause.details ?? cause.message ?? '',
      ),
  );
}

/** Permissionless execution of chain-published orders; only exact transaction recovery is durable. */
export class DayTaker {
  #running;
  constructor(db, index, client, wallet, config) {
    if (
      !index?.events ||
      !index?.sync ||
      !index?.readiness ||
      !Number.isSafeInteger(config.chainId) ||
      config.chainId <= 0 ||
      !Number.isSafeInteger(config.maxFills ?? 1) ||
      (config.maxFills ?? 1) < 1
    )
      throw new Error('Invalid day taker configuration');
    this.config = {
      ...config,
      router: getAddress(config.router),
      aqua: getAddress(config.aqua),
      factory: getAddress(config.factory),
      maxFills: config.maxFills ?? 1,
      transactionGasLimit: transactionGasLimit(config.transactionGasLimit),
    };
    this.db = db;
    this.index = index;
    this.client = client;
    this.wallet = wallet;
    this.sender = wallet.account.address.toLowerCase();
    const checkGas = (request) => {
      if (typeof request.gas !== 'bigint' || request.gas < 21_000n)
        throw new Error(
          'Prepared settlement requires an explicit valid gas estimate',
        );
      if (request.gas > this.config.transactionGasLimit)
        throw new CandidateGasError('Candidate exceeds transaction gas limit');
      return request;
    };
    // StoredSubmission prepares before inserting its durable nonce record.
    // Reject oversized estimates at that boundary; never delete an admitted job.
    const boundedWallet = {
      account: wallet.account,
      chain: wallet.chain,
      prepareTransactionRequest: async (request) =>
        checkGas(await wallet.prepareTransactionRequest(request)),
      signTransaction: (request) => wallet.signTransaction(checkGas(request)),
    };
    this.submissions = new StoredSubmission(db, client, boundedWallet, {
      chainId: config.chainId,
      kind: 'ordinary',
    });
  }

  /** Concurrent ticks share one run. Recovery always precedes admission of a new transaction. */
  async tick() {
    if (this.#running) return this.#running;
    this.#running = this.#tick();
    try {
      return await this.#running;
    } finally {
      this.#running = undefined;
    }
  }

  async #ready() {
    if ((await this.client.getChainId()) !== this.config.chainId)
      throw new Error('Wrong taker chain');
    await this.index.sync();
    return (await this.index.readiness()).ready;
  }

  #jobs() {
    return this.db
      .prepare('SELECT * FROM submissions WHERE sender=? ORDER BY nonce')
      .all(this.sender);
  }

  #saved(job) {
    let payload;
    try {
      payload = JSON.parse(job.payload);
    } catch {
      /* Reject legacy records below. */
    }
    if (
      job.kind !== 'ordinary' ||
      payload?.protocol !== protocol ||
      !same(payload.to, this.config.router) ||
      typeof payload.data !== 'string' ||
      !job.unsigned
    )
      throw new Error(
        `Unsupported saved submission ${job.id}; explicit recovery required`,
      );
    const decoded = decodeFunctionData({
      abi: dayRouterAbi,
      data: payload.data,
    });
    if (decoded.functionName !== 'settle')
      throw new Error('Saved day call is not settlement');
    const [bid, asks, programs] = decoded.args;
    if (
      !same(bid.app, this.config.router) ||
      bid.chainId !== BigInt(this.config.chainId) ||
      !same(hashDayStrategy('bid', bid), job.bid_hash) ||
      !same(askHash(asks), job.ask_hash) ||
      !same(
        encodeFunctionData({
          abi: dayRouterAbi,
          functionName: 'settle',
          args: decoded.args,
        }),
        payload.data,
      )
    )
      throw new Error(
        'Saved day submission differs from its authenticated call',
      );
    return { bid, asks, programs, data: payload.data, payload: job.payload };
  }

  async #status(job, receipt, call) {
    const result = {
      id: job.id,
      bidHash: job.bid_hash,
      transactionHash: job.tx_hash,
      state: 'pending',
    };
    if (!receipt) return result;
    if (
      !same(receipt.transactionHash, job.tx_hash) ||
      !same(receipt.to, this.config.router) ||
      !same(receipt.from, this.sender)
    )
      throw new Error('Receipt does not match saved transaction');
    const block = await this.client.getBlock({
      blockNumber: receipt.blockNumber,
    });
    if (!same(block?.hash, receipt.blockHash)) return result;
    const head = await this.client.getBlockNumber();
    if (head - receipt.blockNumber < BigInt(this.index.confirmations))
      return result;
    if (receipt.status === 'reverted') return { ...result, state: 'reverted' };
    if (receipt.status !== 'success')
      throw new Error('Unknown transaction receipt status');
    const fills = parseEventLogs({
      abi: dayRouterAbi,
      logs: receipt.logs.filter((log) => same(log.address, this.config.router)),
      eventName: 'Settled',
      strict: true,
    });
    if (
      fills.length !== 1 ||
      !same(fills[0].args.bidHash, job.bid_hash) ||
      !same(fills[0].args.buyer, call.bid.buyer) ||
      !same(fills[0].args.asset, call.bid.asset) ||
      fills[0].args.total > call.bid.maxTotal
    )
      throw new Error('Successful receipt lacks the expected settlement');
    // Recheck ancestry after inspecting effects; a reorg never becomes a filled claim.
    if (
      !same(
        (await this.client.getBlock({ blockNumber: receipt.blockNumber }))
          ?.hash,
        receipt.blockHash,
      )
    )
      return result;
    return { ...result, state: 'filled', total: fills[0].args.total };
  }

  #simulate(call) {
    return this.client.simulateContract({
      address: this.config.router,
      abi: dayRouterAbi,
      functionName: 'settle',
      args: [call.bid, call.asks, call.programs],
      account: this.wallet.account,
      gas: this.config.transactionGasLimit,
    });
  }

  async #submit(id, call, existing) {
    // A saved unsigned request must still be executable before this process signs it.
    // Signed requests instead retain their exact bytes even if live prices changed.
    if (existing && !existing.raw) await this.#simulate(call);
    const { job, receipt } = await this.submissions.submit({
      id,
      bidHash: hashDayStrategy('bid', call.bid),
      askHash: askHash(call.asks),
      to: this.config.router,
      data: call.data,
      payload: call.payload,
      simulate: () => this.#simulate(call),
    });
    return this.#status(
      job,
      receipt ?? (await this.submissions.receipt(job.tx_hash)),
      call,
    );
  }

  #publications() {
    const rows = [];
    let before;
    for (;;) {
      const page = this.index.events('Shipped', 1000, before);
      rows.push(...page);
      if (page.length < 1000) break;
      before = page.at(-1);
    }
    const bids = [],
      asks = new Map(),
      known = new Set();
    for (const row of rows.reverse()) {
      if (!same(row.address, this.config.aqua)) continue;
      let publication;
      try {
        publication = decodeDayPublication(row.args, this.config);
      } catch {
        continue;
      }
      if (known.has(publication.hash)) continue;
      known.add(publication.hash);
      if (publication.kind === 'bid') bids.push(publication);
      else {
        const a = publication.strategy,
          key = `${a.asset.toLowerCase()}:${a.day}`;
        const group = asks.get(key) ?? [];
        group.push(publication);
        asks.set(key, group);
      }
    }
    return { bids, asks };
  }

  async #call(bid, publications) {
    const block = await this.client.getBlock();
    const read = (address, abi, functionName, args = []) =>
      this.client.readContract({
        address,
        abi,
        functionName,
        args,
        blockNumber: block.number,
      });
    if (
      BigInt(bid.deadline) < block.timestamp ||
      (await read(this.config.router, dayRouterAbi, 'used', [
        bid.buyer,
        bid.nonce,
      ])) ||
      !(await read(this.config.factory, dayFactoryAbi, 'isAsset', [bid.asset]))
    )
      return null;
    const duration = bid.endDayExclusive - bid.startDay;
    if (duration < 1 || duration > 365) return null; // Canonical fixed calendar, not a purchase policy cap.
    const [states, version] = await Promise.all([
      read(bid.asset, dayAssetAbi, 'rangeState', [
        bid.startDay,
        bid.endDayExclusive,
      ]),
      read(bid.asset, dayAssetAbi, 'discountVersion'),
    ]);
    const asks = [];
    for (let i = 0; i < states.length; ++i) {
      const state = states[i];
      if (!state.deployed || !state.listed || same(state.owner, bid.buyer))
        return null;
      const candidates =
        publications.get(`${bid.asset.toLowerCase()}:${bid.startDay + i}`) ??
        [];
      let selected;
      for (const candidate of candidates) {
        const a = candidate.strategy;
        if (
          !same(a.seller, state.owner) ||
          a.saleNonce !== state.saleNonce ||
          a.discountVersion !== version
        )
          continue;
        const [amount, count] = await read(
          this.config.aqua,
          officialAquaAbi,
          'rawBalances',
          [a.seller, this.config.router, candidate.hash, state.token],
        );
        if (amount >= 1n && count > 0 && count < 255) {
          selected = a;
          break;
        }
      }
      if (!selected) return null;
      asks.push(selected);
    }
    if (asks.length !== duration) return null;
    const programs = await Promise.all(
      asks.map((a) =>
        read(this.config.router, dayRouterAbi, 'program', [
          bid.asset,
          a.day,
          duration,
        ]),
      ),
    );
    const data = encodeFunctionData({
      abi: dayRouterAbi,
      functionName: 'settle',
      args: [bid, asks, programs],
    });
    return {
      bid,
      asks,
      programs,
      data,
      payload: JSON.stringify({ protocol, to: this.config.router, data }),
    };
  }

  async #tick() {
    const result = { state: 'ready', recovered: [], submissions: [] };
    if (!(await this.#ready())) return { ...result, state: 'indexing' };
    const jobs = this.#jobs();
    // Validate the complete namespace before signing any recoverable record.
    const saved = jobs.map((job) => ({ job, call: this.#saved(job) }));
    for (const { job, call } of saved) {
      const receipt = job.tx_hash
        ? await this.submissions.receipt(job.tx_hash)
        : null;
      const status = receipt
        ? await this.#status(job, receipt, call)
        : await this.#submit(job.id, call, job);
      result.recovered.push(status);
      if (status.state === 'pending') return { ...result, state: 'pending' };
    }
    if (!(await this.#ready())) return { ...result, state: 'indexing' };
    const publications = this.#publications();
    for (const publication of publications.bids) {
      if (result.submissions.length >= this.config.maxFills) break;
      if (!(await this.#ready())) return { ...result, state: 'indexing' };
      let id;
      try {
        const call = await this.#call(publication.strategy, publications.asks);
        if (!call) continue;
        const prior = result.recovered.filter((job) =>
          same(job.bidHash, publication.hash),
        );
        if (prior.some((job) => job.state === 'filled')) continue;
        id = keccak256(
          toHex(
            `${protocol}:${this.config.chainId}:${this.config.router.toLowerCase()}:${publication.hash}:${prior.length}`,
          ),
        );
        const status = await this.#submit(id, call);
        result.submissions.push(status);
        if (status.state === 'pending') return { ...result, state: 'pending' };
      } catch (error) {
        // Contract rejections remain conditional; transport and recovery faults must surface.
        if (
          (id && this.submissions.get(id)) ||
          (!rejected(error) && !gasRejected(error))
        )
          throw error;
      }
    }
    return result;
  }
}
