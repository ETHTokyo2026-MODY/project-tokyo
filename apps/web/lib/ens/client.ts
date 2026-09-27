import {
  createPublicClient,
  createWalletClient,
  http,
  type Account,
  type Chain,
  type Hex,
  type PublicClient,
  type Transport,
  type WalletClient,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { sepolia } from 'viem/chains';
import { DEFAULT_RPC_URL, ENS } from './constants';
import { balancedDayRpc, dayRpcUrls } from '../../../backend/src/day-rpc.mjs';
import { urAbi } from './abi';

export type EnsClients = {
  public: PublicClient<Transport, Chain>;
  wallet?: WalletClient<Transport, Chain, Account>;
};

export function deployerAccount() {
  const key = process.env.PROJECTTOKYO_DEPLOYER_KEY;
  if (!key) throw new Error('PROJECTTOKYO_DEPLOYER_KEY is not set');
  return privateKeyToAccount(key as Hex);
}

export function createEnsClients(
  rpcUrl?: string,
  account?: Account,
): EnsClients {
  const urls = rpcUrl
    ? dayRpcUrls({ DAY_RPC_URL: rpcUrl })
    : dayRpcUrls(process.env, DEFAULT_RPC_URL);
  const transport = balancedDayRpc(urls);
  const pub = createPublicClient({
    chain: sepolia,
    transport,
    batch: { multicall: true },
  });
  const wallet = account
    ? createWalletClient({ chain: sepolia, transport: http(urls[0]), account })
    : undefined;
  return { public: pub, wallet };
}

export async function assertEnsRoot(client: PublicClient) {
  const root = await client.readContract({
    address: ENS.universalResolver,
    abi: urAbi,
    functionName: 'ROOT_REGISTRY',
  });
  if (root.toLowerCase() !== ENS.rootRegistry.toLowerCase()) {
    throw new Error(`ENSv2 root changed: ${root}`);
  }
}
