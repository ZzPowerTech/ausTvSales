import { Module } from '@nestjs/common';
import { AnalyticsController } from './analytics.controller';
import { AnalyticsService } from './analytics.service';

/**
 * Read-side analytics for the dashboard (spec S5.1). Depends only on the global
 * `DatabaseModule` (DRIZZLE) and the global `SessionAuthGuard` from AuthModule.
 */
@Module({
  controllers: [AnalyticsController],
  providers: [AnalyticsService],
})
export class AnalyticsModule {}
