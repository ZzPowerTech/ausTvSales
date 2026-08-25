import { Module } from '@nestjs/common';
import { ThrottlingModule } from '../config/throttling';
import { IngestApiKeyGuard } from './ingest-api-key.guard';
import { IngestApiKeyService } from './ingest-api-key.service';
import { IngestIpAllowlistGuard } from './ingest-ip-allowlist.guard';
import { IngestIpAllowlistService } from './ingest-ip-allowlist.service';

/**
 * Ingest authentication foundation (spec S2.1 + ADR-0001): the source-IP
 * allowlist, the API-key guard/service and the rate-limit configuration shared
 * by every plugin→API route.
 *
 * The throttler root itself lives in {@link ThrottlingModule}, not here.
 * `ThrottlerModule.forRoot()` may only be called once per application, and while
 * it sat inside this module, adding a rate limit to a dashboard route meant
 * importing the *ingest* module from an unrelated feature. This module now just
 * re-exports it, so `@IngestAuth()`'s `ThrottlerGuard` still resolves its
 * options and storage wherever an ingest controller is hosted.
 *
 * Still not an `APP_GUARD`: a limit is opted into per route and can be read at
 * the route.
 */
@Module({
  imports: [ThrottlingModule],
  providers: [
    IngestApiKeyService,
    IngestApiKeyGuard,
    IngestIpAllowlistService,
    IngestIpAllowlistGuard,
  ],
  exports: [
    IngestApiKeyService,
    IngestApiKeyGuard,
    IngestIpAllowlistService,
    IngestIpAllowlistGuard,
    // Re-exported as the module actually imported here. Re-exporting
    // `ThrottlerModule` directly fails at boot: Nest only lets a module export
    // what it imports, and the root moved to `ThrottlingModule`.
    ThrottlingModule,
  ],
})
export class IngestModule {}
