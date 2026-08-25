import { Module } from '@nestjs/common';
import { InstrumentationModule } from '../instrumentation/instrumentation.module';
import { HealthController } from './health.controller';
import { HealthService } from './health.service';
import { InstrumentationHealthController } from './instrumentation-health.controller';
import { InstrumentationHealthService } from './instrumentation-health.service';

/**
 * Two questions that are easy to confuse, answered side by side.
 *
 * `HealthController` answers "is this API process alive?" for Nginx and the
 * container. `InstrumentationHealthController` answers "is the *measurement* of
 * the game network still happening?" — the question nobody was asking while the
 * proxy sat dead for three months (ADR-006).
 *
 * They live in one module because an operator looking for either one looks under
 * `/health`, and they are kept as separate controllers because conflating them
 * is the mistake: a green liveness probe says nothing at all about collection,
 * and reading it as if it did is how the blindness lasted.
 *
 * `InstrumentationModule` is imported for read access to the stored verdicts and
 * to the configured cadence. Nothing here writes, and nothing here triggers a
 * cycle — see the controller for why that is deliberate.
 */
@Module({
  imports: [InstrumentationModule],
  controllers: [HealthController, InstrumentationHealthController],
  providers: [HealthService, InstrumentationHealthService],
  exports: [HealthService],
})
export class HealthModule {}
