import { sepolia } from 'viem/chains';
import deployment from '../../../../contracts/deployments/sepolia.json';

/** Same RPC resolution as the day API: DAY_RPC_URL, else viem Sepolia. */
export function dayRpcUrl(
  env = process.env as Record<string, string | undefined>,
) {
  const config =
    env.DAY_CONFIG_JSON == null
      ? deployment
      : (JSON.parse(env.DAY_CONFIG_JSON) as { chainId?: number });
  if (!env.DAY_RPC_URL && config.chainId !== sepolia.id)
    throw new Error('A custom chain requires DAY_RPC_URL');
  const rpc = new URL(env.DAY_RPC_URL ?? sepolia.rpcUrls.default.http[0]);
  if (!['https:', 'http:'].includes(rpc.protocol))
    throw new Error('Invalid RPC protocol');
  return rpc.href;
}
