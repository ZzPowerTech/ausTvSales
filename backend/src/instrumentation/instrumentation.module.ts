import { Module } from '@nestjs/common';
import { DiscordAlerter } from './discord-alerter';
import { HEALTH_CHECKS } from './health-check.contract';
import { HealthCheckRunner } from './health-check.runner';
import { HealthCheckStore } from './health-check.store';
import { PlanApiClient } from './plan-api.client';

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
    {
      // The registry the runner iterates. Empty for now, on purpose: the checks
      // land in the next slice, and the runner must not know which exist.
      //
      // An empty registry is inert and says so — `runAll` logs that no check
      // produced an observation instead of reporting a clean bill of health for
      // a system it never looked at.
      provide: HEALTH_CHECKS,
      useValue: [],
    },
  ],
  exports: [HealthCheckStore, DiscordAlerter, PlanApiClient, HealthCheckRunner],
})
export class InstrumentationModule {}
