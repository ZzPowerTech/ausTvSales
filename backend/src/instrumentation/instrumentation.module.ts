import { Module } from '@nestjs/common';
import { CollectionAliveCheck } from './collection-alive.check';
import { DiscordAlerter } from './discord-alerter';
import { HEALTH_CHECKS } from './health-check.contract';
import { HealthCheckRunner } from './health-check.runner';
import { HealthCheckStore } from './health-check.store';
import { PlanApiClient } from './plan-api.client';
import { PlanServersConfig } from './plan-servers.config';

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
  providers: [
    HealthCheckStore,
    DiscordAlerter,
    PlanApiClient,
    HealthCheckRunner,
    PlanServersConfig,
    CollectionAliveCheck,
    {
      // The registry the runner iterates. The runner must not know which checks
      // exist, so adding one is a line here and nothing there.
      //
      // Six of the seven checks in spec 6.1 are still absent, and three of those
      // have no data source at all — `funnel.tutorial_entry_rate` (Plan collects
      // nothing about the tutorial) plus `plan.orphan_instance` and
      // `plan.version_divergence` (Plan exposes no server-list endpoint; both
      // `/v1/servers` and `/v1/networkOverview` return 404). Those are decisions
      // for the owner, recorded in HANDOFF.md, not gaps to paper over here.
      provide: HEALTH_CHECKS,
      useFactory: (collectionAlive: CollectionAliveCheck) => [collectionAlive],
      inject: [CollectionAliveCheck],
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
