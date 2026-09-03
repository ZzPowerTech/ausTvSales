import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ServiceIpAllowlistService } from '../auth/service-auth/service-ip-allowlist.service';

/**
 * App-level source-IP allowlist for the plugin→API ingest routes (ADR-0001,
 * defense in depth on top of the Nginx `allow/deny` edge rule).
 *
 * The mechanism is shared with the Discord bot's principal and lives in
 * {@link ServiceIpAllowlistService}. What is specific to ingest is the variable
 * and what its absence costs: without the allowlist, a leaked API key would let
 * sales be submitted from anywhere, not only the game VPS.
 *
 * `INGEST_ALLOWED_IPS` is required in production by env validation and optional
 * in dev/test so local runs are not blocked. Exact IPs only — the game VPS has a
 * fixed address per ADR-0001; use Nginx for ranges.
 */
@Injectable()
export class IngestIpAllowlistService extends ServiceIpAllowlistService {
  constructor(config: ConfigService) {
    super(
      config.get<string>('INGEST_ALLOWED_IPS') ?? '',
      'INGEST_ALLOWED_IPS',
      'INGEST_ALLOWED_IPS not set — ingest IP allowlist DISABLED; the ingest ' +
        'endpoint is protected by the API key and the Nginx edge rule only. ' +
        'Set INGEST_ALLOWED_IPS in production for defense in depth.',
      new Logger(IngestIpAllowlistService.name),
    );
  }
}
