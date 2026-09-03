import { Injectable, Logger } from '@nestjs/common';
import { ServiceIpAllowlistGuard } from '../auth/service-auth/service-ip-allowlist.guard';
import { IngestIpAllowlistService } from './ingest-ip-allowlist.service';

/**
 * Source-IP allowlist guard for the plugin→API ingest routes (ADR-0001, defense
 * in depth). Applied by `@IngestAuth()` BEFORE the API-key guard, so a request
 * from an unlisted IP is rejected without the key ever being evaluated.
 *
 * The mechanism is shared with the Discord bot's principal and lives in
 * {@link ServiceIpAllowlistGuard}. The plugin calls from the game VPS, so a
 * private/loopback source here is a `trust proxy` misconfiguration and the guard
 * says so — which is why this subclass leaves `expectsPrivateSource` at its
 * default.
 */
@Injectable()
export class IngestIpAllowlistGuard extends ServiceIpAllowlistGuard {
  constructor(allowlist: IngestIpAllowlistService) {
    super(allowlist, 'ingest', new Logger(IngestIpAllowlistGuard.name));
  }
}
