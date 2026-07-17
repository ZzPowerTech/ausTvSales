import { Module } from '@nestjs/common';
import { IngestModule } from '../ingest/ingest.module';
import { SalesController } from './sales.controller';
import { SalesService } from './sales.service';

/**
 * Sales ingest module. Imports {@link IngestModule} for the API-key guard and
 * the throttler wiring used by `@IngestAuth()`. {@link SalesService} owns the
 * idempotent persistence + catalog validation (S2.2); the Drizzle instance is
 * provided globally by `DatabaseModule`.
 */
@Module({
  imports: [IngestModule],
  controllers: [SalesController],
  providers: [SalesService],
})
export class SalesModule {}
