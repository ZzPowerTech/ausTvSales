import { Injectable, Logger } from '@nestjs/common';
import { ServiceIpAllowlistGuard } from '../auth/service-auth/service-ip-allowlist.guard';
import { BotIpAllowlistService } from './bot-ip-allowlist.service';

/**
 * Source-IP allowlist guard for the bot→API routes.
 *
 * `expectsPrivateSource` is true: the bot is co-located, so loopback here is the
 * normal case. The ingest guard's "this is probably the proxy, check
 * TRUST_PROXY" hint would be a confident pointer at a non-problem every time a
 * legitimate bot request is refused for some other reason.
 */
@Injectable()
export class BotIpAllowlistGuard extends ServiceIpAllowlistGuard {
  constructor(allowlist: BotIpAllowlistService) {
    super(allowlist, 'bot', new Logger(BotIpAllowlistGuard.name), true);
  }
}
