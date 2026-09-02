import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';
import { CronJob } from 'cron';
import { WeeklyReportService } from './weekly-report.service';

/** Matches the default documented in `.env.example`: Monday 09:00 BRT. */
const DEFAULT_CRON = '0 9 * * 1';
const TIME_ZONE = 'America/Sao_Paulo';
const JOB_NAME = 'weekly-report';

/**
 * Fires the weekly report (story S9.2).
 *
 * ## Monday morning, in São Paulo
 *
 * A report that lands when nobody is reading is a report nobody reads. The time
 * zone is pinned rather than inherited from the container, for the same reason
 * the tutorial ETL pins it: "09:00" means 09:00 for the people who read it, and
 * a container that came up in UTC would deliver it at 06:00.
 *
 * ## Opt-in, and loud about being off
 *
 * Off unless `WEEKLY_REPORT_ENABLED` is true. The boot warning matters more here
 * than almost anywhere else in this codebase: the failure mode of a disabled
 * weekly report is **silence**, and silence is what this whole epic exists to
 * make impossible to mistake for good news.
 *
 * The report body itself prints whether the health cycle is enabled, but nothing
 * inside a job that never fires can announce that it never fired. The boot log
 * is the only place this particular gap can be stated, which is why it is stated
 * in full sentences instead of a flag.
 */
@Injectable()
export class WeeklyReportScheduler implements OnModuleInit {
  private readonly logger = new Logger(WeeklyReportScheduler.name);
  private readonly enabled: boolean;
  private readonly cron: string;

  constructor(
    private readonly reports: WeeklyReportService,
    private readonly registry: SchedulerRegistry,
    config: ConfigService,
  ) {
    this.enabled = config.get<boolean>('WEEKLY_REPORT_ENABLED') === true;
    // `?? DEFAULT_CRON` and not `|| DEFAULT_CRON`: an unset variable takes the
    // default, but `"   "` is a value somebody typed, and `.env.example` says
    // an invalid expression leaves the job unscheduled rather than silently
    // running at an hour nobody chose. A whitespace string reaches `CronJob`,
    // which rejects it, which is the documented behaviour.
    this.cron =
      config.get<string>('WEEKLY_REPORT_CRON')?.trim() ?? DEFAULT_CRON;
  }

  onModuleInit(): void {
    if (!this.enabled) {
      this.logger.warn(
        'WEEKLY_REPORT_ENABLED nao esta ligado — nenhum relatorio semanal vai ' +
          'ser gerado nem entregue. A ausencia de relatorio no canal vai ser ' +
          'indistinguivel de "semana sem novidade", que e exatamente o padrao ' +
          'que deixou o proxy morto por tres meses.',
      );
      return;
    }

    let job: CronJob;
    try {
      // Registered through SchedulerRegistry rather than the @Cron decorator so
      // the job exists only when enabled — a decorator registers at class load
      // and would fire even with the switch off.
      job = CronJob.from({
        cronTime: this.cron,
        onTick: () => void this.tick(),
        start: false,
        timeZone: TIME_ZONE,
      });
    } catch (error) {
      // A malformed expression must not take the process down, and must not be
      // silently replaced by the default: someone wrote that string meaning
      // something, and delivering at an hour they did not choose is how a report
      // stops being read.
      this.logger.error(
        `WEEKLY_REPORT_CRON invalida ("${this.cron}"): ${
          error instanceof Error ? error.message : String(error)
        }. O relatorio semanal NAO foi agendado.`,
      );
      return;
    }

    this.registry.addCronJob(JOB_NAME, job);
    job.start();

    this.logger.log(
      `Relatorio semanal agendado em "${this.cron}" (${TIME_ZONE}); ` +
        'primeira execucao no proximo horario, nunca no boot',
    );
  }

  /**
   * One scheduled run.
   *
   * Swallows everything. An unhandled rejection inside a timer callback takes
   * the Node process down, which would turn a bad report into an API outage. The
   * service already converts its own failures into an `error` row plus a channel
   * notice; this is the last net, for the ones it cannot — a database that
   * refuses the insert, for instance, which leaves the log as the only witness.
   */
  private async tick(): Promise<void> {
    try {
      const record = await this.reports.run();
      this.logger.log(
        `Relatorio semanal #${record.id} (${record.periodFrom}..${record.periodTo}) ` +
          `status=${record.status} entregue=${record.delivered}`,
      );
    } catch (error) {
      this.logger.error(
        `Relatorio semanal falhou por inteiro: ${
          error instanceof Error ? error.message : String(error)
        }. Nada foi persistido e nada foi entregue; a proxima semana tenta de novo.`,
      );
    }
  }
}
