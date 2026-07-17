import { Controller, Get, Header } from '@nestjs/common';
import { IngestAuth } from '../ingest/ingest-auth.decorator';
import { ItemsService, type ItemSyncEntry } from './items.service';

/**
 * Item catalog sync for the game-server plugin cache (spec S2.3).
 *
 * `GET /items/sync` is an *ingest* route: protected by `@IngestAuth()` (the same
 * shared API key as `POST /sales`), NOT by the dashboard's `SessionAuthGuard`.
 * It is deliberately kept in its own controller, separate from
 * {@link ItemsController} (`GET /items`, session-guarded, full `Item`): the two
 * have different auth, different audiences and different payload shapes, so
 * mixing a `@Public()`/API-key route into the session-guarded controller would
 * be easy to get wrong.
 *
 * Because the route uses `@IngestAuth()`, the hosting module ({@link
 * ItemsModule}) imports `IngestModule` so the `IngestApiKeyGuard` and
 * `ThrottlerGuard` resolve their providers.
 *
 * Sync strategy (MVP, spec S2.3): the catalog is tiny, so we return the full
 * active list on every poll plus a short `Cache-Control` — cheap and simple. The
 * plugin polls every N minutes (`sync-interval`, S2.4). `ETag`/`If-None-Match` or
 * a `?since=updated_at` delta is a documented future optimization, not needed at
 * this volume.
 */
@Controller('items')
export class ItemsSyncController {
  constructor(private readonly itemsService: ItemsService) {}

  @IngestAuth()
  @Get('sync')
  @Header('Cache-Control', 'public, max-age=60')
  sync(): Promise<ItemSyncEntry[]> {
    return this.itemsService.findActiveForSync();
  }
}
