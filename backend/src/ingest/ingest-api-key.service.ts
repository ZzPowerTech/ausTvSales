import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ServiceApiKeyService } from '../auth/service-auth/service-api-key.service';

/**
 * The set of API keys accepted from the game-server plugin (ADR-0001).
 *
 * All of the mechanism — scrypt digests over a per-boot salt, constant-time
 * comparison against every configured key, the comma-separated rotation window —
 * lives in {@link ServiceApiKeyService} and is shared with the Discord bot's
 * principal. What is specific to ingest is only which variable holds the keys.
 *
 * `INGEST_API_KEYS` is a deploy secret, never committed; the rotation runbook is
 * in ADR-0001.
 */
@Injectable()
export class IngestApiKeyService extends ServiceApiKeyService {
  constructor(config: ConfigService) {
    super(
      config.getOrThrow<string>('INGEST_API_KEYS'),
      'INGEST_API_KEYS',
      new Logger(IngestApiKeyService.name),
    );
  }
}
