import { Module } from '@nestjs/common';
import { IngestModule } from '../ingest/ingest.module';
import { SalesController } from './sales.controller';

/**
 * Sales ingest module. Imports {@link IngestModule} for the API-key guard and
 * the throttler wiring used by `@IngestAuth()`. Persistence (service + repo)
 * lands in S2.2.
 */
@Module({
  imports: [IngestModule],
  controllers: [SalesController],
})
export class SalesModule {}
