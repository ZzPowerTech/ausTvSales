import { Module } from '@nestjs/common';
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
import { TutorialModule } from '../tutorial/tutorial.module';
import { TutorialEntryRateCheck } from './tutorial-entry-rate.check';
import { VersionDivergenceCheck } from './version-divergence.check';

/**
 * Instrumentation health (AusTV Admin story S6.3, spec §6.1, ADR-006).
 *
 * Distinct from `HealthModule`, and the two are easy to confuse: `HealthModule`
 * answers "is this API process alive?" for Nginx and the container. This module
 * answers "is the *measurement* of the game network still happening?" — the
 * question nobody was asking while the proxy sat dead for three months.
 *
 * **Code-complete** as of story S6.3: persistence, alert policy, Discord
 * alerter, Plan transport, the two adapters, the runner, the scheduler, and
 * **six of the seven checks** of spec §6.1.
 *
 * Code-complete is the whole claim, and the distinction is the one this epic is
 * about. Criterion 4 of S6.3 — *"verified by taking an instance down on
 * purpose"* — has **never been done**: nobody has run this layer with the
 * schedule enabled and a webhook configured and watched an alert arrive. Every
 * piece below is assembled and unit-tested; none of it has been observed
 * end-to-end. See `.specs/features/austv-admin/S6-VERIFICACAO.md`.
 *
 * The seventh, `funnel.tutorial_entry_rate`, is absent because Plan **collects
 * nothing about the tutorial** — the numbers in `HANDOFF.md` came from reading
 * `Quests/playerdata/*.yml` on the game machine, which no API, no MySQL and no
 * PostgreSQL can reach. The owner chose option 3 on 2026-08-23: ship the six
 * that have a source and give the seventh its own story, **S8.0**, which starts
 * by choosing the source.
 *
 * That leaves the longest outage this server ever recorded — the tutorial stopped
 * capturing newcomers in dec/2025 and nobody noticed for eight months — without
 * an automatic alert until S8.0 lands. A trade-off taken with that fact in view,
 * not an omission.
 */
// `ScheduleModule.forRoot()` moved to `AppModule` in S8.0, when a second module
// needed a scheduler and calling it twice turned out to duplicate every
// decorator-driven job. It registers globally, so `SchedulerRegistry` is still
// injectable here; it just must be rooted exactly once.
@Module({
  // The seventh check reads `TutorialStore`. That is the one place this module
  // depends on the S8.0 source, and it is a one-way edge: `TutorialModule` knows
  // nothing about the health layer.
  imports: [TutorialModule],
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
    TutorialEntryRateCheck,
    {
      // The registry the runner iterates. The runner must not know which checks
      // exist, so adding one is a line here and nothing there.
      //
      // **All seven** checks of spec §6.1 as of story S8.0. The seventh,
      // `funnel.tutorial_entry_rate`, joined once ADR-0004 gave it a source —
      // it is the one that would have caught the eight months of the tutorial
      // silently not capturing newcomers, and the epic's longest-standing gap.
      provide: HEALTH_CHECKS,
      useFactory: (
        collectionAlive: CollectionAliveCheck,
        versionDivergence: VersionDivergenceCheck,
        orphanInstance: OrphanInstanceCheck,
        offlineShare: PlatformOfflineShareCheck,
        proxyRegistration: ProxyRegistrationAliveCheck,
        networkToSurvival: NetworkToSurvivalCheck,
        tutorialEntryRate: TutorialEntryRateCheck,
      ) => [
        collectionAlive,
        versionDivergence,
        orphanInstance,
        offlineShare,
        proxyRegistration,
        networkToSurvival,
        tutorialEntryRate,
      ],
      inject: [
        CollectionAliveCheck,
        VersionDivergenceCheck,
        OrphanInstanceCheck,
        PlatformOfflineShareCheck,
        ProxyRegistrationAliveCheck,
        NetworkToSurvivalCheck,
        TutorialEntryRateCheck,
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
