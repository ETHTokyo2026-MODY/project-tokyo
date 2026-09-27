import { createWalletClient, http, type Address, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { sepolia } from 'viem/chains';
import { DEFAULT_RPC_URL } from '../ens/constants';
import {
  WalletBatchError,
  type FundingTypedData,
  type PreparedTransaction,
  SEPOLIA_CHAIN_ID,
} from './wallet';

export const SESSION_WALLET_KEY = 'daytrader.generated-wallet';
export const SAVED_WALLETS_KEY = 'daytrader.generated-wallets';
const MAX_SAVED = 8;

export type SavedWallet = {
  address: string;
  privateKey: Hex;
  createdAt: number;
};

function isHexKey(value: unknown): value is Hex {
  return typeof value === 'string' && /^0x[0-9a-fA-F]{64}$/.test(value);
}

function normalizeWallet(value: unknown): SavedWallet | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as SavedWallet;
  if (!isHexKey(row.privateKey)) return null;
  const address = privateKeyToAccount(row.privateKey).address.toLowerCase();
  return {
    address,
    privateKey: row.privateKey,
    createdAt:
      typeof row.createdAt === 'number' && Number.isFinite(row.createdAt)
        ? row.createdAt
        : Date.now(),
  };
}

function readJson(storage: Storage, key: string): unknown {
  try {
    const raw = storage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function readSessionWallet(): SavedWallet | null {
  if (typeof sessionStorage === 'undefined') return null;
  return normalizeWallet(readJson(sessionStorage, SESSION_WALLET_KEY));
}

export function listSavedWallets(): SavedWallet[] {
  if (typeof localStorage === 'undefined') return [];
  const rows = readJson(localStorage, SAVED_WALLETS_KEY);
  if (!Array.isArray(rows)) return [];
  const seen = new Set<string>();
  const out: SavedWallet[] = [];
  for (const row of rows) {
    const wallet = normalizeWallet(row);
    if (!wallet || seen.has(wallet.address)) continue;
    seen.add(wallet.address);
    out.push(wallet);
  }
  return out;
}

export function persistWallet(wallet: SavedWallet) {
  const next = normalizeWallet(wallet);
  if (!next) throw new Error('Invalid generated wallet');
  sessionStorage.setItem(SESSION_WALLET_KEY, JSON.stringify(next));
  const history = [
    next,
    ...listSavedWallets().filter((item) => item.address !== next.address),
  ].slice(0, MAX_SAVED);
  localStorage.setItem(SAVED_WALLETS_KEY, JSON.stringify(history));
  return next;
}

export function clearSessionWallet() {
  try {
    sessionStorage.removeItem(SESSION_WALLET_KEY);
  } catch {
    /* private mode */
  }
}

export function createGeneratedWallet(): SavedWallet {
  const privateKey = generatePrivateKey();
  return persistWallet({
    address: privateKeyToAccount(privateKey).address.toLowerCase(),
    privateKey,
    createdAt: Date.now(),
  });
}

function addressOf(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !/^0x[0-9a-f]{40}$/i.test(value) ||
    /^0x0{40}$/i.test(value)
  ) {
    throw new Error('Invalid wallet or transaction address');
  }
  return value.toLowerCase();
}

/** Local signer for the onchain Demo path. Private keys never leave the browser. */
export class GeneratedWalletSession {
  readonly generated = true as const;
  private disposed = false;
  private busy = false;
  private readonly subscribers = new Set<(account: string | null) => void>();
  private readonly accountAddress: string;
  private readonly walletClient;

  constructor(private readonly saved: SavedWallet) {
    const account = privateKeyToAccount(saved.privateKey);
    this.accountAddress = account.address.toLowerCase();
    this.walletClient = createWalletClient({
      account,
      chain: sepolia,
      transport: http(DEFAULT_RPC_URL, { timeout: 20_000, retryCount: 1 }),
    });
  }

  get account(): string | null {
    return this.disposed ? null : this.accountAddress;
  }

  subscribe(listener: (account: string | null) => void): () => void {
    this.assertOpen();
    this.subscribers.add(listener);
    listener(this.account);
    return () => {
      this.subscribers.delete(listener);
    };
  }

  async disconnect(): Promise<void> {
    clearSessionWallet();
    this.dispose();
  }

  async verifySession(): Promise<void> {
    this.assertOpen();
  }

  async switchToSepolia(): Promise<void> {
    this.assertOpen();
  }

  async sendBatch(
    transactions: readonly PreparedTransaction[],
  ): Promise<string[]> {
    const hashes: string[] = [];
    try {
      return await this.exclusive(async () => {
        if (!Array.isArray(transactions) || transactions.length === 0)
          throw new Error('No transactions to send');
        for (const tx of transactions) {
          this.prepare(tx);
          const raw = await this.walletClient.signTransaction({
            account: this.walletClient.account,
            chain: sepolia,
            to: tx.to as Address,
            data: tx.data as Hex,
            value: BigInt(0),
            ...(tx.gas ? { gas: BigInt(tx.gas) } : {}),
          });
          const response = await fetch('/api/chain/send', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ raw }),
            cache: 'no-store',
          });
          const value = (await response.json()) as {
            hash?: string;
            error?: string;
          };
          if (!response.ok || !value.hash)
            throw new Error(value.error ?? 'Broadcast failed');
          if (!/^0x[0-9a-f]{64}$/i.test(value.hash))
            throw new Error('Broadcast returned an invalid transaction hash');
          hashes.push(value.hash);
          this.assertOpen();
        }
        return hashes;
      });
    } catch (error) {
      throw new WalletBatchError(error, hashes);
    }
  }

  async signFunding(
    input: FundingTypedData,
    converter: string,
  ): Promise<string> {
    return this.exclusive(async () => {
      const data = structuredClone(input);
      if (
        data.domain.name !== 'DayAtomicConverter' ||
        data.domain.version !== '1' ||
        BigInt(data.domain.chainId) !== BigInt(SEPOLIA_CHAIN_ID) ||
        addressOf(data.domain.verifyingContract) !== addressOf(converter) ||
        data.primaryType !== 'FundingIntent' ||
        addressOf(data.message.buyer) !== this.accountAddress ||
        addressOf(data.message.recipient) !== this.accountAddress ||
        addressOf(data.message.executor) !== addressOf(converter) ||
        BigInt(data.message.chainId) !== BigInt(SEPOLIA_CHAIN_ID)
      ) {
        throw new Error(
          'Funding signature differs from selected wallet or deployment',
        );
      }
      const signature = await this.walletClient.signTypedData({
        ...data,
        domain: {
          ...data.domain,
          chainId: sepolia.id,
          verifyingContract: converter as Address,
        },
        account: this.walletClient.account,
      });
      if (!/^0x[0-9a-f]{130}$/i.test(signature))
        throw new Error('Wallet returned an invalid funding signature');
      return signature;
    });
  }

  dispose(): void {
    this.disposed = true;
    for (const listener of this.subscribers) listener(null);
    this.subscribers.clear();
  }

  private prepare(tx: PreparedTransaction) {
    if (
      !tx ||
      typeof tx !== 'object' ||
      Object.keys(tx).some(
        (key) => !['to', 'data', 'from', 'value', 'gas'].includes(key),
      )
    ) {
      throw new Error('Unsupported prepared transaction');
    }
    if (tx.from !== undefined && addressOf(tx.from) !== this.accountAddress)
      throw new Error('Prepared transaction is for a different account');
    if (typeof tx.data !== 'string' || !/^0x(?:[0-9a-f]{2})*$/i.test(tx.data))
      throw new Error('Invalid transaction data');
    if (tx.value !== undefined && !/^0x0$/i.test(tx.value))
      throw new Error('This action cannot send ETH');
  }

  private assertOpen() {
    if (this.disposed) throw new Error('Wallet session closed');
  }

  private async exclusive<T>(action: () => Promise<T>): Promise<T> {
    this.assertOpen();
    if (this.busy) throw new Error('A wallet request is already in progress');
    this.busy = true;
    try {
      return await action();
    } finally {
      this.busy = false;
    }
  }
}
