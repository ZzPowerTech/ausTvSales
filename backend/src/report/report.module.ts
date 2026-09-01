import { Module } from '@nestjs/common';
import { FunnelModule } from '../funnel/funnel.module';
import { HealthModule } from '../health/health.module';
import { RetentionModule } from '../retention/retention.module';
import { ReportController } from './report.controller';
import { WeeklyReportBuilder } from './weekly-report.builder';
import { WeeklyReportPublisher } from './weekly-report.publisher';
import { WeeklyReportScheduler } from './weekly-report.scheduler';
import { WeeklyReportService } from './weekly-report.service';
import { WeeklyReportStore } from './weekly-report.store';

/**
 * The weekly report (story S9.2, spec §6.1/§6.2).
 *
 * Reads three modules and owns none of their data: the funnel (S8.1), cohort
 * retention (S8.2) and the instrumentation-health read model (S7.1). The only
 * thing it owns is `weekly_reports`, which is the record of what was reported
 * when.
 *
 * `ScheduleModule.forRoot()` is **not** called here. It is rooted exactly once,
 * in `AppModule`, since story S8.0 — calling it twice makes every scheduled job
 * in the app fire in duplicate, which was measured the first time a second
 * module needed a scheduler.
 */
@Module({
  imports: [FunnelModule, RetentionModule, HealthModule],
  controllers: [ReportController],
  providers: [
    WeeklyReportBuilder,
    WeeklyReportStore,
    WeeklyReportPublisher,
    WeeklyReportService,
    WeeklyReportScheduler,
  ],
  exports: [WeeklyReportService],
})
export class ReportModule {}
