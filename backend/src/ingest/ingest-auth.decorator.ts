import { applyDecorators, UseGuards } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import { Public } from '../auth/public.decorator';
import { IngestApiKeyGuard } from './ingest-api-key.guard';

/**
 * The single decorator every plugin→API ingest route must use (spec §1.1).
 *
 * Composition, in order:
 *  - `@Public()` opts the route out of the global deny-by-default
 *    `SessionAuthGuard` (the plugin has no user session).
 *  - `IngestApiKeyGuard` then re-protects it with the shared API key, so
 *    `@Public()` never leaves the route open — it swaps session auth for key
 *    auth rather than removing auth.
 *  - `ThrottlerGuard` applies the ingest rate limit (see {@link
 *    ingestThrottlerOptions}); throttling is scoped here, never global, so
 *    dashboard routes keep their own profile.
 *
 * Bundling all three means it is impossible to mark an ingest route public
 * without also protecting and rate-limiting it (risk mitigation, spec §7).
 */
export function IngestAuth(): ReturnType<typeof applyDecorators> {
  return applyDecorators(
    Public(),
    UseGuards(IngestApiKeyGuard, ThrottlerGuard),
  );
}
