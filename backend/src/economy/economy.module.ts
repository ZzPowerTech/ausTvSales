import { Module } from '@nestjs/common';
import { InstrumentationModule } from '../instrumentation/instrumentation.module';
import { TutorialModule } from '../tutorial/tutorial.module';
import { AccountCreationsService } from './account-creations.service';
import { EconomyController } from './economy.controller';
import { EconomyService } from './economy.service';
import { PlayerDimensionScheduler } from './player-dimension.scheduler';
import { PlayerDimensionStore } from './player-dimension.store';
import { PlayerDimensionSyncService } from './player-dimension.sync.service';
import { PaymentsFeedService } from './payments-feed.service';
import { PaymentsStore } from './payments.store';
import { PaymentsSyncScheduler } from './payments-sync.scheduler';
import { PaymentsSyncService } from './payments-sync.service';
import { PlayerPointsDatabase } from './playerpoints.database';
import { SocialService } from './social.service';

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
 * **No MySQL for the revenue half.** E1 and E2 answer with nothing but this
 * PostgreSQL and one HTTP endpoint, which is why they ship without waiting for
 * a credential to be provisioned.
 *
 * The **social** half (E3, E4) does open a MySQL connection, to the PlayerPoints
 * log on the game machine, and it is the only one in this module. That is
 * authorised by ADR-007 — a six-column schema that has not moved — and not by
 * ADR-002's exception 2, which governs Plan's schema and is a different
 * database entirely. Reading the two as one rule would be a category error in
 * either direction; the rule that survives both is **one class per authorised
 * source, and a new source needs a new decision.**
 *
 * `ScheduleModule.forRoot()` is rooted once in `AppModule`; calling it again
 * here would make every scheduled job in the app fire twice.
 */
@Module({
  // `TutorialModule` for `TutorialStore`: E2's second half needs the per-player
  // tutorial position and its provenance, and the provenance is what separates
  // "nobody is in that position" from "the switch is off".
  imports: [InstrumentationModule, TutorialModule],
  controllers: [EconomyController],
  providers: [
    EconomyService,
    PlayerDimensionStore,
    PlayerDimensionSyncService,
    PlayerDimensionScheduler,
    PlayerPointsDatabase,
    PaymentsStore,
    PaymentsSyncService,
    PaymentsSyncScheduler,
    SocialService,
    PaymentsFeedService,
    AccountCreationsService,
  ],
  exports: [EconomyService, PlayerDimensionStore, PaymentsStore],
})
export class EconomyModule {}
