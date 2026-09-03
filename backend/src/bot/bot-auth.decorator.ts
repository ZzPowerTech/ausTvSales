import { applyDecorators, UseGuards } from '@nestjs/common';
import { ApiResponse, ApiSecurity } from '@nestjs/swagger';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import { Public } from '../auth/public.decorator';
import { botThrottle } from '../config/throttling';
import { BOT_SECURITY_SCHEME } from '../config/swagger.constants';
import { BotApiKeyGuard } from './bot-api-key.guard';
import { BotIpAllowlistGuard } from './bot-ip-allowlist.guard';

/**
 * The single decorator every bot→API route must use (story S10.2).
 *
 * Composition, in order, and the order is the security property:
 *  - `@Public()` opts the route out of the global deny-by-default
 *    `SessionAuthGuard` — the bot has no user session.
 *  - `BotIpAllowlistGuard` rejects any source IP not on the bot's allowlist
 *    FIRST, so a leaked key is useless off this host and the key is never
 *    evaluated for a foreign IP.
 *  - `BotApiKeyGuard` then re-protects the route with the bot's shared key, so
 *    `@Public()` never leaves it open — it swaps session auth for IP + key auth
 *    rather than removing auth.
 *  - `ThrottlerGuard` **with** `@Throttle`, both of them. `@Throttle` alone is
 *    metadata and `ThrottlerGuard` is not an `APP_GUARD` here; a bare `@Throttle`
 *    compiles, reads as throttled and enforces nothing. This repo already
 *    shipped that bug once, on its only route with an external effect.
 *  - `ApiSecurity` overrides the document's global session requirement, and
 *    `ApiResponse` documents the three rejections — each has a different cause
 *    and a different fix, and OpenAPI can say "send this header" but not "and
 *    from this host".
 *
 * Bundling them means a bot route cannot be marked public without also being
 * allowlisted, authenticated and rate-limited.
 */
export function BotAuth(): ReturnType<typeof applyDecorators> {
  return applyDecorators(
    Public(),
    UseGuards(BotIpAllowlistGuard, BotApiKeyGuard, ThrottlerGuard),
    Throttle(botThrottle),
    ApiSecurity(BOT_SECURITY_SCHEME),
    ApiResponse({
      status: 401,
      description: 'Chave do bot ausente, malformada ou desconhecida.',
    }),
    ApiResponse({
      status: 403,
      description:
        'IP de origem fora da allowlist do bot. A chave correta vinda de outro ' +
        'host cai aqui, nao em 401.',
    }),
    ApiResponse({
      status: 429,
      description: 'Limite de taxa do bot excedido (ver botThrottle).',
    }),
  );
}
