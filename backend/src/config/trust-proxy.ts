/**
 * Parses the `TRUST_PROXY` env into an Express `trust proxy` value: a bare
 * integer becomes the hop count; anything else ('loopback', an IP, a
 * comma-separated list of trusted proxies) is passed through as-is. Defaults to
 * 'loopback'.
 *
 * This governs how `req.ip` is derived from `X-Forwarded-For`, which the ingest
 * IP allowlist (ADR-0001) relies on being trustworthy. Lives in its own module
 * rather than inside `main.ts` so it can be unit-tested without booting the app.
 */
export function resolveTrustProxy(raw: string | undefined): string | number {
  const value = (raw ?? '').trim();
  // `TRUST_PROXY=` with no value is a realistic .env shape (the example file
  // ships `INGEST_ALLOWED_IPS=` that way). Falling through with '' would hand
  // Express an empty setting instead of the documented default.
  if (value === '') {
    return 'loopback';
  }
  return /^\d+$/.test(value) ? Number(value) : value;
}
