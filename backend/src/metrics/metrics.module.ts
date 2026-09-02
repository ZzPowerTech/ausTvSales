import { Module } from '@nestjs/common';
import { ThrottlingModule } from '../config/throttling';
import { InstrumentationModule } from '../instrumentation/instrumentation.module';
import { MetricsController } from './metrics.controller';
import { MetricsService } from './metrics.service';
import { PlanCache } from './plan-cache';

/**
 * Normalised reads of the game network (story S7.2, issue #111).
 *
 * ## The cache lives here, and deliberately not in `InstrumentationModule`
 *
 * The health checks of S6.3 use the **uncached** `PlanApiClient`, and that is a
 * requirement rather than an oversight. A check answers "is collection still
 * happening right now?"; served from a cache it would answer "was collection
 * happening the last time somebody asked", and a dead Plan would keep reporting
 * healthy for a full TTL. The layer built to detect blindness would have been
 * given a blind spot.
 *
 * So the boundary is: dashboard reads go through {@link PlanCache}, health
 * checks do not. Keeping the provider in this module makes that structural
 * instead of a convention somebody has to remember.
 */
@Module({
  imports: [InstrumentationModule, ThrottlingModule],
  controllers: [MetricsController],
  providers: [MetricsService, PlanCache],
  // `PlanCache` e exportado para o modulo de retencao (S8.2), que consome o
  // mesmo `/v1/*` e esta sob a mesma mitigacao da secao 8 do spec. O docblock do
  // proprio cache ja antecipava isto: "the S8.2 cohort module is a second
  // consumer waiting".
  exports: [MetricsService, PlanCache],
})
export class MetricsModule {}
