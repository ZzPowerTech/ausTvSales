import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { CollectionAliveCheck } from './collection-alive.check';
import { DiscordAlerter } from './discord-alerter';
import { HEALTH_CHECKS } from './health-check.contract';
import { HealthCheckRunner } from './health-check.runner';
import { HealthCheckScheduler } from './health-check.scheduler';
import { HealthCheckStore } from './health-check.store';
import { NetworkToSurvivalCheck } from './network-to-survival.check';
import { OrphanInstanceCheck } from './orphan-instance.check';
import { PlanApiClient } from './plan-api.client';
import { PlanDatabase } from './plan-database';
import { PlanServersConfig } from './plan-servers.config';
import { PlatformOfflineShareCheck } from './platform-offline-share.check';
import { ProxyRegistrationAliveCheck } from './proxy-registration-alive.check';
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
    ProxyRegistrationAliveCheck,
    NetworkToSurvivalCheck,
    {
      // The registry the runner iterates. The runner must not know which checks
      // exist, so adding one is a line here and nothing there.
      //
      // Six of the seven checks in spec 6.1. The seventh,
      // `funnel.tutorial_entry_rate`, has **no data source at all** — Plan
      // collects nothing about the tutorial, and the numbers in HANDOFF.md came
      // from reading `Quests/playerdata/*.yml` on the game machine, which no
      // API, no MySQL and no PostgreSQL can reach. It is a decision for the
      // owner between the four options recorded there, not a gap to paper over.
      provide: HEALTH_CHECKS,
      useFactory: (
        collectionAlive: CollectionAliveCheck,
        versionDivergence: VersionDivergenceCheck,
        orphanInstance: OrphanInstanceCheck,
        offlineShare: PlatformOfflineShareCheck,
        proxyRegistration: ProxyRegistrationAliveCheck,
        networkToSurvival: NetworkToSurvivalCheck,
      ) => [
        collectionAlive,
        versionDivergence,
        orphanInstance,
        offlineShare,
        proxyRegistration,
        networkToSurvival,
      ],
      inject: [
        CollectionAliveCheck,
        VersionDivergenceCheck,
        OrphanInstanceCheck,
        PlatformOfflineShareCheck,
        ProxyRegistrationAliveCheck,
        NetworkToSurvivalCheck,
      ],
    },
  ],
  exports: [
    HealthCheckStore,
    DiscordAlerter,
    PlanApiClient,
    HealthCheckRunner,
    // Exported for the S7.1 read model, which needs the cadence to decide
    // whether a stored verdict is still a measurement or already a photograph.
    HealthCheckScheduler,
    // Also for S7.1: the read model compares the registry against what the
    // store holds, because a registered check that never wrote a verdict is
    // absent from every count — and absence reads as fine.
    HEALTH_CHECKS,
    PlanServersConfig,
  ],
})
export class InstrumentationModule {}
