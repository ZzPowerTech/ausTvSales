import { Module } from '@nestjs/common';
import { InstrumentationModule } from '../instrumentation/instrumentation.module';
import { TutorialModule } from '../tutorial/tutorial.module';
import { FunnelController } from './funnel.controller';
import { FunnelService } from './funnel.service';

/**
 * The four-step funnel (story S8.1, spec §6.2).
 *
 * Reads two stores and owns neither: `PlanDatabase` from the instrumentation
 * module (ADR-002 exception 2) and `TutorialStore` from the tutorial module
 * (story S8.0). Nothing here writes, and nothing here is scheduled — the only
 * job in this chain is the tutorial ETL, which lives with its own data.
 */
@Module({
  imports: [InstrumentationModule, TutorialModule],
  controllers: [FunnelController],
  providers: [FunnelService],
  exports: [FunnelService],
})
export class FunnelModule {}
