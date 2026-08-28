import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CronJob } from 'cron';
import { SchedulerRegistry } from '@nestjs/schedule';
import { TutorialSyncService } from './tutorial-sync.service';

/** Matches the default documented in `.env.example`. 03:00 BRT. */
const DEFAULT_CRON = '0 3 * * *';
const TIME_ZONE = 'America/Sao_Paulo';
const JOB_NAME = 'tutorial-sync';

/**
 * Runs the tutorial ETL off-peak (story S8.0, criterion 2).
 *
 * ## Why a cron expression here, and an interval for the health checks
 *
 * `HealthCheckScheduler` deliberately uses a plain interval, because "is
 * collection still happening?" has no relationship to wall-clock time. This job
 * is the opposite case: criterion 2 of S8.0 says **"fora do pico"**, and off-peak
 * is a statement about the clock. A run walks ~20.000 files across whatever link
 * carries them from the game machine, so *when* is part of the requirement.
 *
 * The time zone is pinned to America/Sao_Paulo rather than left to the container:
 * "03:00" means 03:00 for the players, and a container that came up in UTC would
 * quietly move the job into the evening peak.
 *
 * ## Opt-in, and loud about being off
 *
 * Off unless `TUTORIAL_SYNC_ENABLED` is true, for the same reason the health
 * scheduler is: a job that silently does not run produces a series that looks
 * current and is frozen. Being off is announced at boot rather than inferred
 * from data that stopped moving.
 *
 * Also off when the source directories are unconfigured — scheduling a job that
 * can only ever record failures would fill `tutorial_syncs` with noise and teach
 * whoever reads it to skip the table.
 */
@Injectable()
export class TutorialSyncScheduler implements OnModuleInit {
  private readonly logger = new Logger(TutorialSyncScheduler.name);
  private readonly enabled: boolean;
  private readonly cron: string;

  constructor(
    private readonly sync: TutorialSyncService,
    private readonly registry: SchedulerRegistry,
    config: ConfigService,
  ) {
    this.enabled = config.get<boolean>('TUTORIAL_SYNC_ENABLED') === true;
    this.cron =
      config.get<string>('TUTORIAL_SYNC_CRON')?.trim() || DEFAULT_CRON;
  }

  onModuleInit(): void {
    if (!this.enabled) {
      this.logger.warn(
        'TUTORIAL_SYNC_ENABLED nao esta ligado — o funil do tutorial NAO vai ' +
          'ser reconstruido. A serie existente fica congelada, e o check ' +
          'funnel.tutorial_entry_rate vai medir dados cada vez mais velhos.',
      );
      return;
    }

    if (!this.sync.configured) {
      this.logger.warn(
        'TUTORIAL_SYNC_ENABLED esta ligado, mas os diretorios da fonte nao ' +
          'estao configurados — agendamento NAO registrado. Um job que so pode ' +
          'registrar falha encheria tutorial_syncs de ruido.',
      );
      return;
    }

    let job: CronJob;
    try {
      // Registered through SchedulerRegistry rather than the @Cron decorator so
      // the job only exists when enabled — a decorator registers at class load
      // and would schedule the walk even with the switch off.
      job = CronJob.from({
        cronTime: this.cron,
        onTick: () => void this.tick(),
        start: false,
        timeZone: TIME_ZONE,
      });
    } catch (error) {
      // A malformed expression must not take the process down, and must not be
      // silently replaced by the default either: someone wrote that string
      // meaning something, and running at a different hour than they intended is
      // how a heavy job lands in peak.
      this.logger.error(
        `TUTORIAL_SYNC_CRON invalida ("${this.cron}"): ${
          error instanceof Error ? error.message : String(error)
        }. O ETL do tutorial NAO foi agendado.`,
      );
      return;
    }

    this.registry.addCronJob(JOB_NAME, job);
    job.start();

    this.logger.log(
      `ETL do tutorial agendado em "${this.cron}" (${TIME_ZONE}); ` +
        'primeira execucao no proximo horario, nunca no boot',
    );
  }

  /**
   * One scheduled run.
   *
   * Swallows everything. An unhandled rejection inside a timer callback takes the
   * Node process down, which would turn a bad night's disk read into an outage of
   * the API. The service already converts its own failures into `error` sync
   * records; this is the last net, for the ones it cannot.
   */
  private async tick(): Promise<void> {
    try {
      const result = await this.sync.sync();
      if (result.status === 'error') {
        this.logger.error(
          `ETL do tutorial falhou: ${result.detail ?? 'sem detalhe'}. ` +
            'A serie anterior continua de pe.',
        );
      }
    } catch (error) {
      this.logger.error(
        `ETL do tutorial falhou por inteiro: ${
          error instanceof Error ? error.message : String(error)
        }. O agendamento continua; a proxima noite tenta de novo.`,
      );
    }
  }
}
