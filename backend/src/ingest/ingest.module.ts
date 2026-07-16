import { Module } from '@nestjs/common';
import { ThrottlerModule } from '@nestjs/throttler';
import { IngestApiKeyGuard } from './ingest-api-key.guard';
import { IngestApiKeyService } from './ingest-api-key.service';
import { ingestThrottlerOptions } from './ingest.throttle';

/**
 * Ingest authentication foundation (spec S2.1): the API-key guard/service and
 * the rate-limit configuration shared by every plugin→API route.
 *
 * `ThrottlerModule.forRoot` is imported here (not as an APP_GUARD) and
 * re-exported so the `ThrottlerGuard` referenced by `@IngestAuth()` resolves its
 * options/storage in the modules that host ingest controllers — while dashboard
 * routes, which never apply `ThrottlerGuard`, stay unthrottled.
 */
@Module({
  imports: [ThrottlerModule.forRoot(ingestThrottlerOptions)],
  providers: [IngestApiKeyService, IngestApiKeyGuard],
  exports: [IngestApiKeyService, IngestApiKeyGuard, ThrottlerModule],
})
export class IngestModule {}
