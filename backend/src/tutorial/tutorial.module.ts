import { Module } from '@nestjs/common';
import { TutorialStore } from './tutorial.store';
import { TutorialSyncScheduler } from './tutorial-sync.scheduler';
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
 * rebuild is driven by {@link TutorialSyncScheduler}, off-peak. The read side of
 * the funnel is story S8.1 and lives in its own module, which consumes
 * {@link TutorialStore}.
 */
// `ScheduleModule.forRoot()` is deliberately **not** imported here. It is called
// exactly once, in `AppModule`.
//
// It is not idempotent, despite registering itself as a global module: a second
// call creates a second `SchedulerOrchestrator`, and each orchestrator sweeps the
// whole app through `DiscoveryModule`. Every `@Cron`/`@Interval` in the process
// then fires **twice** — measured, not assumed. Nothing in this repo uses those
// decorators today (both schedulers register through `SchedulerRegistry` by
// hand), so the duplication was invisible; the next `@Cron` somebody writes would
// have run a 20.000-file walk twice a night.
//
// Same shape as the `ThrottlerModule.forRoot()` problem this repo already hit in
// PR #156, and the same resolution: one root, at the composition root.
@Module({
  providers: [TutorialStore, TutorialSyncService, TutorialSyncScheduler],
  exports: [TutorialStore, TutorialSyncService],
})
export class TutorialModule {}
