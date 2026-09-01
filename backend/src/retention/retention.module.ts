import { Module } from '@nestjs/common';
import { InstrumentationModule } from '../instrumentation/instrumentation.module';
import { MetricsModule } from '../metrics/metrics.module';
import { RetentionController } from './retention.controller';
import { RetentionService } from './retention.service';

/**
 * Cohort retention by month × platform (story S8.2, spec §6.2).
 *
 * Borrows `PlanApiClient` from the instrumentation module rather than
 * constructing its own — one transport, one place that knows how to classify a
 * Plan failure, one place that would have to change if Plan ever turns
 * authentication on (it authenticates by session cookie, not by the bearer this
 * client sends; recorded in `plan-api.errors.ts`).
 *
 * **No MySQL.** The story was planned as the one module allowed to run direct
 * SQL against Plan's tables — exception 1 of ADR-002 — and reading
 * `/v1/retention` on 2026-08-29 removed the need. Nothing here writes, nothing
 * here is scheduled, and no new credential is provisioned.
 *
 * `MetricsModule` is imported for `PlanCache`, not for its service. Spec §8
 * lists a TTL cache in front of `/v1/*` as a **mitigation** — *"query pesada
 * afeta o jogo"* — and this module fetches the whole 5.565-row payload on every
 * request, which the dashboard throttle would happily allow 120 times a window.
 * The cache is what keeps that off the game machine, and it doubles as the
 * stale-fallback path when Plan is down.
 */
@Module({
  imports: [InstrumentationModule, MetricsModule],
  controllers: [RetentionController],
  providers: [RetentionService],
  exports: [RetentionService],
})
export class RetentionModule {}
