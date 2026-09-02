import { Module } from '@nestjs/common';
import { InstrumentationModule } from '../instrumentation/instrumentation.module';
import { EconomyController } from './economy.controller';
import { EconomyService } from './economy.service';
import { PlayerDimensionScheduler } from './player-dimension.scheduler';
import { PlayerDimensionStore } from './player-dimension.store';
import { PlayerDimensionSyncService } from './player-dimension.sync.service';

/**
 * The economy layer (story S9.1, spec §6.4, ADR-007/ADR-008).
 *
 * ## What it does not do
 *
 * **No Java, nothing deployed on the game server.** ADR-007 deferred the
 * `ausPlanBridge` plugin and this module replaces it: the numbers come from
 * databases and an HTTP API that already exist.
 *
 * **No new credential.** The player dimension is filled from `/v1/retention`
 * through the `PlanApiClient` the instrumentation module already owns — the same
 * endpoint story S8.2 used to avoid opening exception 1 of ADR-002.
 *
 * **No MySQL.** The PlayerPoints ETL that E3 and E4 need is a separate slice; it
 * is the one that requires a read-only account on the game machine, and keeping
 * it out of this module is what lets revenue ship without waiting for that
 * credential to be provisioned.
 *
 * `ScheduleModule.forRoot()` is rooted once in `AppModule`; calling it again
 * here would make every scheduled job in the app fire twice.
 */
@Module({
  imports: [InstrumentationModule],
  controllers: [EconomyController],
  providers: [
    EconomyService,
    PlayerDimensionStore,
    PlayerDimensionSyncService,
    PlayerDimensionScheduler,
  ],
  exports: [EconomyService, PlayerDimensionStore],
})
export class EconomyModule {}
