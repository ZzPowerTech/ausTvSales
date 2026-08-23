import { Module } from '@nestjs/common';
import { HealthCheckStore } from './health-check.store';

/**
 * Instrumentation health (AusTV Admin story S6.3, spec §6.1, ADR-006).
 *
 * Distinct from `HealthModule`, and the two are easy to confuse: `HealthModule`
 * answers "is this API process alive?" for Nginx and the container. This module
 * answers "is the *measurement* of the game network still happening?" — the
 * question nobody was asking while the proxy sat dead for three months.
 *
 * Grows over the story: this first slice is persistence only. The Discord
 * alerter, the Plan data source and the seven checks land on top of it.
 */
@Module({
  providers: [HealthCheckStore],
  exports: [HealthCheckStore],
})
export class InstrumentationModule {}
