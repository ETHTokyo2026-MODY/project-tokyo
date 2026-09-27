import {
  createPublicClient,
  createWalletClient,
  defineChain,
  getAddress,
  http,
  parseAbi,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { sepolia } from 'viem/chains';
import { dayWebConfig } from '../../../../backend/src/day-web.mjs';
import { sameOrigin } from '@/lib/chain/origin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const erc20 = parseAbi([
  'function transfer(address to, uint256 amount) returns (bool)',
  'function balanceOf(address owner) view returns (uint256)',
]);

const ETH_WEI = BigInt(process.env.DEMO_FAUCET_ETH_WEI ?? '20000000000000000');
const USDC_RAW = BigInt(process.env.DEMO_FAUCET_USDC ?? '250000000');
const hits = new Map<string, number[]>();

function allow(key: string, max: number, windowMs: number) {
  const now = Date.now();
  const times = (hits.get(key) ?? []).filter((at) => now - at < windowMs);
  if (times.length >= max) {
    hits.set(key, times);
    return false;
  }
  times.push(now);
  hits.set(key, times);
  return true;
}

function clientIp(request: Request) {
  const forwarded = request.headers.get('x-forwarded-for');
  return forwarded?.split(',')[0]?.trim() || 'local';
}

function faucetAccount() {
  const key = process.env.DEMO_FAUCET_PRIVATE_KEY?.trim();
  if (!key || !/^0x[0-9a-fA-F]{64}$/.test(key)) return null;
  return privateKeyToAccount(key as `0x${string}`);
}

type FaucetConfig = { chainId: number; usdc: `0x${string}` };

function chainClients() {
  const config = dayWebConfig() as unknown as FaucetConfig;
  const url =
    process.env.DAY_RPC_URL ??
    (config.chainId === sepolia.id
      ? (sepolia.rpcUrls.default.http[0] as string)
      : null);
  if (!url) throw new Error('DAY_RPC_URL is required for the demo faucet');
  const chain = defineChain({
    id: config.chainId,
    name: 'DayTrader chain',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [url] } },
  });
  const transport = http(url, { timeout: 20_000, retryCount: 1 });
  return {
    config,
    public: createPublicClient({ chain, transport }),
    chain,
    transport,
  };
}

export async function GET(request: Request) {
  const address = new URL(request.url).searchParams.get('address');
  if (!address || !/^0x[0-9a-fA-F]{40}$/.test(address)) {
    return Response.json({ error: 'Address required' }, { status: 400 });
  }
  try {
    const { config, public: client } = chainClients();
    const account = getAddress(address);
    const [ethBalance, usdcBalance] = await Promise.all([
      client.getBalance({ address: account }),
      client.readContract({
        address: config.usdc,
        abi: erc20,
        functionName: 'balanceOf',
        args: [account],
      }),
    ]);
    return Response.json({
      address: account.toLowerCase(),
      ethBalance: ethBalance.toString(),
      usdcBalance: usdcBalance.toString(),
    });
  } catch (error) {
    return Response.json(
      {
        error: error instanceof Error ? error.message : 'Balance read failed',
      },
      { status: 502 },
    );
  }
}

export async function POST(request: Request) {
  if (!sameOrigin(request)) {
    return Response.json(
      { error: 'Same-origin request required' },
      { status: 403 },
    );
  }
  if (!request.headers.get('content-type')?.startsWith('application/json')) {
    return Response.json({ error: 'JSON required' }, { status: 415 });
  }
  let body: { address?: unknown };
  try {
    body = (await request.json()) as { address?: unknown };
  } catch {
    return Response.json({ error: 'Invalid JSON' }, { status: 400 });
  }
  if (
    typeof body.address !== 'string' ||
    !/^0x[0-9a-fA-F]{40}$/.test(body.address)
  ) {
    return Response.json({ error: 'Address required' }, { status: 400 });
  }
  const recipient = getAddress(body.address);
  const signer = faucetAccount();
  if (!signer) {
    return Response.json(
      {
        error:
          'Demo faucet is not configured. Set DEMO_FAUCET_PRIVATE_KEY on the server.',
      },
      { status: 503 },
    );
  }
  const ip = clientIp(request);
  if (
    !allow(`addr:${recipient.toLowerCase()}`, 3, 60 * 60 * 1000) ||
    !allow(`ip:${ip}`, 30, 60 * 60 * 1000)
  ) {
    return Response.json(
      { error: 'Faucet rate limit reached. Try another wallet shortly.' },
      { status: 429 },
    );
  }
  try {
    const { config, public: reader, chain, transport } = chainClients();
    const wallet = createWalletClient({
      account: signer,
      chain,
      transport,
    });
    const [ethBalance, usdcBalance] = await Promise.all([
      reader.getBalance({ address: recipient }),
      reader.readContract({
        address: config.usdc,
        abi: erc20,
        functionName: 'balanceOf',
        args: [recipient],
      }),
    ]);
    const hashes: string[] = [];
    if (ethBalance < ETH_WEI / BigInt(2)) {
      hashes.push(
        await wallet.sendTransaction({
          account: signer,
          chain,
          to: recipient,
          value: ETH_WEI,
        }),
      );
    }
    if (usdcBalance < USDC_RAW / BigInt(2)) {
      hashes.push(
        await wallet.writeContract({
          account: signer,
          chain,
          address: config.usdc,
          abi: erc20,
          functionName: 'transfer',
          args: [recipient, USDC_RAW],
        }),
      );
    }
    const [ethAfter, usdcAfter] = await Promise.all([
      reader.getBalance({ address: recipient }),
      reader.readContract({
        address: config.usdc,
        abi: erc20,
        functionName: 'balanceOf',
        args: [recipient],
      }),
    ]);
    return Response.json({
      ok: true,
      address: recipient.toLowerCase(),
      hashes,
      ethBalance: ethAfter.toString(),
      usdcBalance: usdcAfter.toString(),
    });
  } catch (error) {
    return Response.json(
      {
        error:
          error instanceof Error
            ? error.message
            : 'Faucet could not fund this wallet',
      },
      { status: 502 },
    );
  }
}
