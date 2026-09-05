import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ServiceIpAllowlistService } from '../auth/service-auth/service-ip-allowlist.service';

/**
 * Source-IP allowlist for the bot→API routes.
 *
 * The bot runs on the **same VPS** as this API (decision of 2026-09-02, which
 * also answers open question 4 of the sprint plan), so it calls locally.
 *
 * ## The value is measured, not assumed
 *
 * `127.0.0.1` is the obvious guess for "same machine" and it is not what every
 * deployment produces. With the API in a container — the topology
 * `docs/nginx-ingest.md` describes, and the one behind the 2026-07-19 incident —
 * a caller from outside the container arrives as the bridge gateway
 * (`172.x.0.1`). `::1` is handled: `normalize` folds IPv6 loopback into the IPv4
 * form, so a caller that resolved `localhost` on a dual-stack host still
 * matches. The gateway case is not, and cannot be — it depends on the deploy.
 *
 * ## What the allowlist buys, stated conditionally
 *
 * A loopback-only list looks like it guards nothing: anything on the box reaches
 * the process anyway. The gain runs the other way — a request arriving through
 * Nginx **with `proxy_set_header X-Forwarded-For`** carries the real client
 * address and never matches, so an accidental `location` block does not expose
 * these routes.
 *
 * That is conditional and the condition matters: Nginx does not set that header
 * on its own. Without it the request reaches the app as loopback and **does**
 * match. What holds unconditionally is the smaller claim — a leaked key is
 * useless off this host.
 *
 * Required in production by env validation, like the ingest one, and optional in
 * dev/test so local runs are not blocked.
 */
@Injectable()
export class BotIpAllowlistService extends ServiceIpAllowlistService {
  constructor(config: ConfigService) {
    super(
      config.get<string>('BOT_ALLOWED_IPS') ?? '',
      'BOT_ALLOWED_IPS',
      'BOT_ALLOWED_IPS not set — bot IP allowlist DISABLED; the suggestion ' +
        'routes are protected by the API key alone. Required in production. ' +
        'MEASURE the value, do not guess it: 127.0.0.1 is the obvious guess ' +
        'and is wrong whenever this API runs in a container, where the ' +
        'co-located bot arrives as the bridge gateway (172.x.0.1). Procedure ' +
        'in ops/deploy/s10-sugestoes.md.',
      new Logger(BotIpAllowlistService.name),
    );
  }
}
