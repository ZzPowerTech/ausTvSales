import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ServiceIpAllowlistService } from '../auth/service-auth/service-ip-allowlist.service';

/**
 * Source-IP allowlist for the bot→API routes.
 *
 * The bot runs on the **same VPS** as this API (decision of 2026-09-02, which
 * also answers open question 4 of the sprint plan), so it calls over loopback
 * and the expected value is `127.0.0.1`.
 *
 * A loopback-only allowlist looks like it guards nothing — anything on the box
 * can reach it. What it actually buys is the opposite direction: a request that
 * arrives **through Nginx** carries the real client address in `X-Forwarded-For`
 * and so never matches, which makes these routes unreachable from the internet
 * even if a location block is added by mistake. That is worth having for the
 * only routes in this API that mutate staff-facing state.
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
        'routes are protected by the API key alone. Set BOT_ALLOWED_IPS in ' +
        'production (127.0.0.1 for the co-located bot) so the routes stay ' +
        'unreachable from outside this host.',
      new Logger(BotIpAllowlistService.name),
    );
  }
}
