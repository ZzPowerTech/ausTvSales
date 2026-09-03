import { Injectable, Logger } from '@nestjs/common';
import { ServiceApiKeyGuard } from '../auth/service-auth/service-api-key.guard';
import { IngestApiKeyService } from './ingest-api-key.service';

/**
 * API-key guard for the plugin→API ingest routes (ADR-0001, spec S2.1).
 *
 * The mechanism — header extraction, constant-time key check, bare `401` with
 * an auditable log line — is shared with the Discord bot's principal and lives
 * in {@link ServiceApiKeyGuard}.
 */
@Injectable()
export class IngestApiKeyGuard extends ServiceApiKeyGuard {
  constructor(apiKeys: IngestApiKeyService) {
    super(apiKeys, 'ingest', new Logger(IngestApiKeyGuard.name));
  }
}
