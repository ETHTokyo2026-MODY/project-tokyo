function validOrigin(raw: string): string | null {
  try {
    const parsed = new URL(raw);
    if (
      parsed.origin !== raw ||
      !['http:', 'https:'].includes(parsed.protocol) ||
      parsed.username ||
      parsed.password
    ) {
      return null;
    }
    return parsed.origin;
  } catch {
    return null;
  }
}

const LOOPBACK_HOSTS = ['localhost', '127.0.0.1', '0.0.0.0'];

function withLoopbackAlias(origin: string): string[] {
  try {
    const url = new URL(origin);
    if (!LOOPBACK_HOSTS.includes(url.hostname)) return [origin];
    return LOOPBACK_HOSTS.map((host) => {
      const next = new URL(origin);
      next.hostname = host;
      return next.origin;
    });
  } catch {
    return [origin];
  }
}

export function appOrigin(request: Request, env = process.env): string | null {
  return validOrigin(env.DAY_APP_ORIGIN ?? new URL(request.url).origin);
}

export function sameOrigin(request: Request, env = process.env): boolean {
  const header = request.headers.get('origin');
  if (!header) return false;
  const allowed = new Set<string>();
  const configured = validOrigin(env.DAY_APP_ORIGIN ?? '');
  if (configured) {
    for (const origin of withLoopbackAlias(configured)) allowed.add(origin);
  }
  try {
    for (const origin of withLoopbackAlias(new URL(request.url).origin))
      allowed.add(origin);
  } catch {
    /* Request URL is not a usable origin. */
  }
  return allowed.has(header);
}
