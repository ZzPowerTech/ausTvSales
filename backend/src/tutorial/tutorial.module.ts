import { Module } from '@nestjs/common';
import { TutorialStore } from './tutorial.store';
import { TutorialSyncService } from './tutorial-sync.service';

/**
 * Tutorial funnel source (story S8.0, ADR-0004).
 *
 * The seventh check of spec §6.1 — the one that would have caught the eight
 * months of the tutorial silently not capturing newcomers — has no source in any
 * API or database. This module is that source: it reads the Quests plugin's own
 * `playerdata` files and turns them into the daily series the funnel and the
 * check consume.
 *
 * ## No controller, and that is deliberate
 *
 * A sync walks ~20.000 files. Nothing here is reachable from an HTTP route: the
 * rebuild is invoked by schedule or by hand. The read side of the funnel is
 * story S8.1 and lives in its own module, which consumes {@link TutorialStore}.
 */
@Module({
  providers: [TutorialStore, TutorialSyncService],
  exports: [TutorialStore, TutorialSyncService],
})
export class TutorialModule {}
