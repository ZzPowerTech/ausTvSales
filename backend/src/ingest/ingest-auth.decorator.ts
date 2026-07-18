import { applyDecorators, UseGuards } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import { Public } from '../auth/public.decorator';
import { IngestApiKeyGuard } from './ingest-api-key.guard';
import { IngestIpAllowlistGuard } from './ingest-ip-allowlist.guard';

/**
 * The single decorator every plugin→API ingest route must use (spec §1.1).
 *
 * Composition, in order:
 *  - `@Public()` opts the route out of the global deny-by-default
 *    `SessionAuthGuard` (the plugin has no user session).
 *  - `IngestIpAllowlistGuard` rejects any source IP not on the allowlist
 *    (ADR-0001, defense in depth) FIRST, so a leaked key is useless off the
 *    game-server VPS and the key is never evaluated for a foreign IP.
 *  - `IngestApiKeyGuard` then re-protects it with the shared API key, so
 *    `@Public()` never leaves the route open — it swaps session auth for
 *    IP + key auth rather than removing auth.
 *  - `ThrottlerGuard` applies the ingest rate limit (see {@link
 *    ingestThrottlerOptions}); throttling is scoped here, never global, so
 *    dashboard routes keep their own profile.
 *
 * Bundling all four means it is impossible to mark an ingest route public
 * without also allowlisting, authenticating and rate-limiting it (risk
 * mitigation, spec §7).
 */
export function IngestAuth(): ReturnType<typeof applyDecorators> {
  return applyDecorators(
    Public(),
    UseGuards(IngestIpAllowlistGuard, IngestApiKeyGuard, ThrottlerGuard),
  );
}
