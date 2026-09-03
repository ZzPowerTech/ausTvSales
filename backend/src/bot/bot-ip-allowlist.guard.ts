import { Injectable, Logger } from '@nestjs/common';
import { ServiceIpAllowlistGuard } from '../auth/service-auth/service-ip-allowlist.guard';
import { BotIpAllowlistService } from './bot-ip-allowlist.service';

/**
 * Hint shown when a private/loopback source is refused for the bot.
 *
 * The bot is co-located, so loopback here is the *expected* address — being
 * refused anyway means `BOT_ALLOWED_IPS` does not hold the value this
 * deployment actually produces. The two candidates are named because both have
 * bitten this repo: `::1` when the caller resolved `localhost` on a dual-stack
 * host (now normalized, but worth saying), and the bridge gateway when the API
 * runs in a container and the bot calls it from outside — the same shape as the
 * 2026-07-19 incident in `docs/nginx-ingest.md`.
 */
const BOT_SOURCE_HINT =
  'endereco privado/loopback recusado para um principal CO-LOCADO: o valor de' +
  ' BOT_ALLOWED_IPS provavelmente nao e o que este deploy produz. Compare com o' +
  ' IP acima — em container o peer e o gateway da bridge (ex.: 172.x.0.1), nao' +
  ' o loopback. Ver TRUST_PROXY, logado no boot.';

/**
 * Source-IP allowlist guard for the bot→API routes.
 *
 * It gets its own hint rather than silence. The first version passed a flag that
 * suppressed the hint entirely, on the reasoning that loopback is normal for a
 * co-located caller — which turned off the one diagnostic that points at the
 * likely cause on the one failure that actually happens here.
 */
@Injectable()
export class BotIpAllowlistGuard extends ServiceIpAllowlistGuard {
  constructor(allowlist: BotIpAllowlistService) {
    super(
      allowlist,
      'bot',
      new Logger(BotIpAllowlistGuard.name),
      BOT_SOURCE_HINT,
    );
  }
}
