import { createTransport, fallback, http, shouldThrow } from 'viem';

/** Keep credentials in server environment variables, never in public config. */
export function dayRpcUrls(env, defaultUrl) {
  const primary =
    env.DAY_RPC_URL === undefined
      ? env.DAY_RPC_URLS
        ? undefined
        : defaultUrl
      : env.DAY_RPC_URL;
  const urls = [primary, ...(env.DAY_RPC_URLS?.split(',') ?? [])]
    .map((value) => value?.trim())
    .filter(Boolean);
  if (!urls.length || urls.length > 8) throw new Error('Invalid RPC endpoints');
  const unique = [
    ...new Set(
      urls.map((value) => {
        let parsed;
        try {
          parsed = new URL(value);
        } catch {
          throw new Error('Invalid RPC endpoint');
        }
        if (
          !['http:', 'https:'].includes(parsed.protocol) ||
          parsed.username ||
          parsed.password
        )
          throw new Error('Invalid RPC endpoint');
        return parsed.href;
      }),
    ),
  ];
  return unique;
}

/** Rotate the first choice; viem fallback handles transport failures. */
export function balancedDayRpc(urls, { timeout = 5000 } = {}) {
  if (!urls.length) throw new Error('RPC endpoint required');
  const endpoints = urls.map((url) => {
    let validated;
    return (context) => {
      const transport = http(url, { timeout, retryCount: 0 })(context);
      return {
        ...transport,
        async request(args) {
          validated ??= transport
            .request({ method: 'eth_chainId' })
            .then((id) => {
              if (BigInt(id) !== BigInt(context.chain.id))
                throw new Error('Wrong RPC chain');
              return id;
            })
            .catch(() => {
              validated = undefined;
              throw new Error('RPC endpoint unavailable or wrong chain');
            });
          const chainId = await validated;
          return args.method === 'eth_chainId'
            ? chainId
            : transport.request(args);
        },
      };
    };
  });
  const choices = endpoints.map((_, start) =>
    fallback([...endpoints.slice(start), ...endpoints.slice(0, start)], {
      retryCount: 0,
    }),
  );
  return (context) => {
    const transports = choices.map((choice) => choice(context));
    let next = 0;
    return createTransport({
      key: 'balanced-day-rpc',
      name: 'Balanced Day RPC',
      type: 'balanced-day-rpc',
      retryCount: 0,
      async request(args) {
        try {
          return await transports[next++ % transports.length].request(args);
        } catch (error) {
          if (shouldThrow(error)) throw error;
          throw new Error('RPC endpoints unavailable');
        }
      },
    });
  };
}
