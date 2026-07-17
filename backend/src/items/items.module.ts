import { Module } from '@nestjs/common';
import { IngestModule } from '../ingest/ingest.module';
import { ItemsSyncController } from './items-sync.controller';
import { ItemsController } from './items.controller';
import { ItemsService } from './items.service';

/**
 * Catalog module. Hosts both the dashboard admin routes ({@link ItemsController},
 * session-guarded) and the plugin cache sync route ({@link ItemsSyncController},
 * API-key/ingest-guarded).
 *
 * `IngestModule` is imported so the `IngestApiKeyGuard`/`ThrottlerGuard` behind
 * `@IngestAuth()` on `GET /items/sync` resolve their providers.
 *
 * `ItemsSyncController` is registered *before* `ItemsController` so the static
 * `GET /items/sync` route is matched ahead of the `GET /items/:id` param route
 * (whose `ParseIntPipe` would otherwise reject "sync").
 */
@Module({
  imports: [IngestModule],
  controllers: [ItemsSyncController, ItemsController],
  providers: [ItemsService],
  exports: [ItemsService],
})
export class ItemsModule {}
