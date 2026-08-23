import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { CollectionAliveCheck } from './collection-alive.check';
import { DiscordAlerter } from './discord-alerter';
import { HEALTH_CHECKS } from './health-check.contract';
import { HealthCheckRunner } from './health-check.runner';
import { HealthCheckScheduler } from './health-check.scheduler';
import { HealthCheckStore } from './health-check.store';
import { OrphanInstanceCheck } from './orphan-instance.check';
import { PlanApiClient } from './plan-api.client';
import { PlanDatabase } from './plan-database';
import { PlanServersConfig } from './plan-servers.config';
import { PlatformOfflineShareCheck } from './platform-offline-share.check';
import { VersionDivergenceCheck } from './version-divergence.check';

/**
 * Instrumentation health (AusTV Admin story S6.3, spec §6.1, ADR-006).
 *
 * Distinct from `HealthModule`, and the two are easy to confuse: `HealthModule`
 * answers "is this API process alive?" for Nginx and the container. This module
 * answers "is the *measurement* of the game network still happening?" — the
 * question nobody was asking while the proxy sat dead for three months.
 *
 * Grows over the story: persistence, then the Discord alerter, then the Plan
 * transport. Still missing, in order: the response shape of each `/v1` endpoint
 * (needs one observation against the live instance), the six checks that have a
 * source, and the scheduler that runs them.
 *
 * The seventh check, `funnel.tutorial_entry_rate`, has **no data source at all**
 * — Plan does not collect anything about the tutorial. That is recorded in
 * `HANDOFF.md` with four options and is a decision for the owner, not a gap to
 * paper over here.
 */
@Module({
  imports: [ScheduleModule.forRoot()],
  providers: [
    HealthCheckScheduler,
    HealthCheckStore,
    DiscordAlerter,
    PlanApiClient,
    HealthCheckRunner,
    PlanServersConfig,
    PlanDatabase,
    CollectionAliveCheck,
    VersionDivergenceCheck,
    OrphanInstanceCheck,
    PlatformOfflineShareCheck,
    {
      // The registry the runner iterates. The runner must not know which checks
      // exist, so adding one is a line here and nothing there.
      //
      // Still absent from spec 6.1: `plan.proxy_registration_alive` and
      // `funnel.network_to_survival`, which both need a network-level arrival
      // count that no session-derived endpoint can give (the proxy records users,
      // not sessions); and `funnel.tutorial_entry_rate`, which has no data source
      // at all — Plan collects nothing about the tutorial. Both are decisions for
      // the owner, recorded in HANDOFF.md.
      provide: HEALTH_CHECKS,
      useFactory: (
        collectionAlive: CollectionAliveCheck,
        versionDivergence: VersionDivergenceCheck,
        orphanInstance: OrphanInstanceCheck,
        offlineShare: PlatformOfflineShareCheck,
      ) => [collectionAlive, versionDivergence, orphanInstance, offlineShare],
      inject: [
        CollectionAliveCheck,
        VersionDivergenceCheck,
        OrphanInstanceCheck,
        PlatformOfflineShareCheck,
      ],
    },
  ],
  exports: [
    HealthCheckStore,
    DiscordAlerter,
    PlanApiClient,
    HealthCheckRunner,
    PlanServersConfig,
  ],
})
export class InstrumentationModule {}
