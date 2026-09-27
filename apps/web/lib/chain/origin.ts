export function appOrigin(request: Request, env = process.env): string | null {
  const configured = env.DAY_APP_ORIGIN;
  const fallback = new URL(request.url).origin;
  const raw = configured ?? fallback;
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

export function sameOrigin(request: Request, env = process.env): boolean {
  const origin = appOrigin(request, env);
  return Boolean(origin && request.headers.get('origin') === origin);
}
