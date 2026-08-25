import { applyDecorators, UseGuards } from '@nestjs/common';
import { ApiResponse, ApiSecurity } from '@nestjs/swagger';
import { ThrottlerGuard } from '@nestjs/throttler';
import { Public } from '../auth/public.decorator';
import { INGEST_SECURITY_SCHEME } from '../config/swagger.constants';
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
 *    appThrottlerOptions}); throttling is scoped here, never global, so
 *    dashboard routes keep their own profile.
 *  - `ApiSecurity` overrides the document's global session requirement with the
 *    API-key scheme. Without it these routes would be documented as needing a
 *    dashboard cookie, which is the opposite of true — and describing an ingest
 *    route wrongly is how somebody eventually tries to call it wrongly.
 *  - `ApiResponse` for 401, 403 and 429. OpenAPI can express "send this header"
 *    but not "and from these IPs", so a reader of the operation alone would see
 *    a key requirement and conclude the key is sufficient. The three rejections
 *    each have a different cause and a different fix, and they are documented
 *    here — inside the decorator — so a new ingest route cannot be added with
 *    the guards and without the description of what the guards do.
 *
 * Bundling all four means it is impossible to mark an ingest route public
 * without also allowlisting, authenticating and rate-limiting it (risk
 * mitigation, spec §7).
 */
export function IngestAuth(): ReturnType<typeof applyDecorators> {
  return applyDecorators(
    Public(),
    UseGuards(IngestIpAllowlistGuard, IngestApiKeyGuard, ThrottlerGuard),
    ApiSecurity(INGEST_SECURITY_SCHEME),
    ApiResponse({
      status: 401,
      description: 'Chave de API ausente, malformada ou desconhecida.',
    }),
    ApiResponse({
      status: 403,
      description:
        'IP de origem fora da allowlist (ADR-0001). A chave correta vinda de ' +
        'fora da VPS do jogo cai aqui, nao em 401.',
    }),
    ApiResponse({
      status: 429,
      description:
        'Limite de taxa do grupo de ingest excedido (ver appThrottlerOptions).',
    }),
  );
}
