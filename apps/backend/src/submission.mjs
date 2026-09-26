import { keccak256, parseTransaction, recoverTransactionAddress } from 'viem';

const same = (a, b) =>
  typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
const pack = (value) => JSON.stringify(value, (_, v) =>
  typeof v === 'bigint' ? { bigint: v.toString() } : v);
const unpack = (value) => JSON.parse(value, (_, v) =>
  v && typeof v === 'object' && Object.keys(v).length === 1 && 'bigint' in v
    ? BigInt(v.bigint) : v);

export function ensureSubmissions(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS submissions (
    id TEXT PRIMARY KEY, bid_hash TEXT NOT NULL, ask_hash TEXT NOT NULL,
    sender TEXT NOT NULL, nonce INTEGER NOT NULL, unsigned TEXT,
    raw TEXT, tx_hash TEXT, kind TEXT NOT NULL DEFAULT 'ordinary', payload TEXT,
    UNIQUE(sender, nonce)
  )`);
  const columns = new Set(db.prepare('PRAGMA table_info(submissions)').all().map(({ name }) => name));
  if (!columns.has('kind')) db.exec("ALTER TABLE submissions ADD COLUMN kind TEXT NOT NULL DEFAULT 'ordinary'");
  if (!columns.has('payload')) db.exec('ALTER TABLE submissions ADD COLUMN payload TEXT');
}

// Shared exact-call lifecycle. Route owners simulate and verify mined effects;
// this helper owns only nonce allocation, saved bytes and idempotent broadcast.
export class StoredSubmission {
  constructor(db, publicClient, walletClient, { chainId, kind }) {
    if (!db?.prepare || !publicClient?.getTransactionCount ||
        !publicClient?.getTransactionReceipt || !publicClient?.sendRawTransaction ||
        !walletClient?.prepareTransactionRequest || !walletClient?.signTransaction ||
        !walletClient?.account?.address || !Number.isSafeInteger(chainId) || chainId <= 0 ||
        !['ordinary', 'conversion', 'collective'].includes(kind))
      throw new Error('Invalid submission dependencies');
    ensureSubmissions(db);
    this.db = db;
    this.publicClient = publicClient;
    this.walletClient = walletClient;
    this.chainId = chainId;
    this.kind = kind;
    this.sender = walletClient.account.address.toLowerCase();
  }

  get(id) {
    return this.db.prepare('SELECT * FROM submissions WHERE id = ? AND kind = ?').get(id, this.kind);
  }

  async receipt(hash) {
    try { return await this.publicClient.getTransactionReceipt({ hash }); }
    catch (error) {
      if (error.name === 'TransactionReceiptNotFoundError') return null;
      throw error;
    }
  }

  async submit({ id, bidHash, askHash, to, data, payload = null, simulate }) {
    if (!id || !bidHash || !askHash || !to || !data || typeof simulate !== 'function')
      throw new Error('Incomplete exact submission');
    let job = this.get(id);
    if (job && (job.sender !== this.sender || job.payload !== payload))
      throw new Error('Conflicting saved submission');
    if (!job) {
      await simulate();
      const prepared = await this.walletClient.prepareTransactionRequest({
        account: this.walletClient.account, chain: this.walletClient.chain,
        to, data, value: 0n,
      });
      const { account, chain, ...unsigned } = prepared;
      if (!same(unsigned.to, to) || !same(unsigned.data, data) ||
          Number(unsigned.chainId) !== this.chainId || (unsigned.value ?? 0n) !== 0n)
        throw new Error('Prepared transaction differs from exact call');
      const pending = await this.publicClient.getTransactionCount({
        address: this.sender, blockTag: 'pending',
      });
      this.db.exec('BEGIN IMMEDIATE');
      try {
        job = this.get(id);
        if (!job) {
          const unsignedPrior = this.db.prepare(
            'SELECT id FROM submissions WHERE sender = ? AND raw IS NULL LIMIT 1',
          ).get(this.sender);
          if (unsignedPrior)
            throw new Error('Earlier relayer submission requires recovery');
          const last = this.db.prepare('SELECT MAX(nonce) AS n FROM submissions WHERE sender = ?').get(this.sender).n;
          const nonce = Math.max(pending, last === null ? 0 : last + 1);
          this.db.prepare(`INSERT INTO submissions(
            id,bid_hash,ask_hash,sender,nonce,unsigned,kind,payload
          ) VALUES(?,?,?,?,?,?,?,?)`).run(
            id, bidHash, askHash, this.sender, nonce,
            pack({ ...unsigned, nonce }), this.kind, payload,
          );
        }
        this.db.exec('COMMIT');
      } catch (error) {
        this.db.exec('ROLLBACK');
        throw error;
      }
      job = this.get(id);
    }
    if (job.sender !== this.sender || job.payload !== payload ||
        !same(job.bid_hash, bidHash) || !same(job.ask_hash, askHash))
      throw new Error('Conflicting saved submission');
    const unsignedPrior = this.db.prepare(
      'SELECT id FROM submissions WHERE sender = ? AND nonce < ? AND raw IS NULL LIMIT 1',
    ).get(this.sender, job.nonce);
    if (unsignedPrior)
      throw new Error('Earlier relayer submission requires recovery');
    if (!job.raw) {
      const request = unpack(job.unsigned);
      if (!same(request.to, to) || !same(request.data, data) ||
          request.nonce !== job.nonce || Number(request.chainId) !== this.chainId ||
          (request.value ?? 0n) !== 0n)
        throw new Error('Stored transaction differs from exact call');
      const raw = await this.walletClient.signTransaction({
        ...request, account: this.walletClient.account, chain: this.walletClient.chain,
      });
      const decoded = parseTransaction(raw);
      if (!same(await recoverTransactionAddress({ serializedTransaction: raw }), this.sender) ||
          !same(decoded.to, to) || !same(decoded.data, data) ||
          decoded.nonce !== job.nonce || Number(decoded.chainId) !== this.chainId ||
          (decoded.value ?? 0n) !== 0n)
        throw new Error('Signed transaction differs from exact call');
      this.db.prepare('UPDATE submissions SET raw = ?, tx_hash = ? WHERE id = ? AND raw IS NULL')
        .run(raw, keccak256(raw), id);
      job = this.get(id);
    }
    let receipt = await this.receipt(job.tx_hash);
    if (!receipt) {
      try {
        const sent = await this.publicClient.sendRawTransaction({ serializedTransaction: job.raw });
        if (!same(sent, job.tx_hash)) throw new Error('Broadcast hash differs from signed bytes');
      } catch (error) {
        receipt = await this.receipt(job.tx_hash);
        if (!receipt) throw error;
      }
    }
    return { job, receipt };
  }
}
