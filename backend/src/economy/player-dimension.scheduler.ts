import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';
import { CronJob } from 'cron';
import { PlayerDimensionSyncService } from './player-dimension.sync.service';

/**
 * Matches the default documented in `.env.example`: 03:30 BRT.
 *
 * Half an hour after the tutorial ETL rather than at the same minute, so two
 * jobs that both reach the game machine do not start together. Neither is heavy
 * — this one is a single HTTP request — but "off-peak" is a property of the
 * whole night's schedule, not of one job in isolation.
 */
const DEFAULT_CRON = '30 3 * * *';
const TIME_ZONE = 'America/Sao_Paulo';
const JOB_NAME = 'player-dimension-sync';

/**
 * Runs the player-dimension ETL off-peak (story S9.1, ADR-007/ADR-008).
 *
 * ## Opt-in, and loud about being off
 *
 * Off unless `PLAYER_DIMENSION_SYNC_ENABLED` is true, and the boot warning is
 * not boilerplate. On **2026-09-01** production validation found that the S8.0
 * tutorial ETL had shipped months earlier and was never configured on the VPS —
 * two unset variables were all that stood between two funnel steps and having
 * ever produced a number. This job has exactly the same shape, so it announces
 * its own absence in the same terms.
 */
@Injectable()
export class PlayerDimensionScheduler implements OnModuleInit {
  private readonly logger = new Logger(PlayerDimensionScheduler.name);
  private readonly enabled: boolean;
  private readonly cron: string;

  constructor(
    private readonly sync: PlayerDimensionSyncService,
    private readonly registry: SchedulerRegistry,
    config: ConfigService,
  ) {
    this.enabled =
      config.get<boolean>('PLAYER_DIMENSION_SYNC_ENABLED') === true;
    this.cron =
      config.get<string>('PLAYER_DIMENSION_SYNC_CRON')?.trim() || DEFAULT_CRON;
  }

  onModuleInit(): void {
    if (!this.enabled) {
      this.logger.warn(
        'PLAYER_DIMENSION_SYNC_ENABLED nao esta ligado — a dimensao de jogador ' +
          'NAO vai ser preenchida. A receita por plataforma continua saindo ' +
          '(ela deriva do proprio uuid da venda), mas TODA leitura por coorte ' +
          'vai reportar `never_synced`, e o tempo ate o primeiro gasto nao sai. ' +
          'E a mesma forma do ETL do tutorial, que ficou meses no repo sem ' +
          'estar configurado na VPS.',
      );
      return;
    }

    if (!this.sync.configured) {
      this.logger.warn(
        'PLAYER_DIMENSION_SYNC_ENABLED esta ligado, mas PLAN_BASE_URL nao esta ' +
          'configurada — agendamento NAO registrado. Um job que so pode ' +
          'registrar falha encheria player_dimension_syncs de ruido e ensinaria ' +
          'quem le a tabela a pular linha.',
      );
      return;
    }

    let job: CronJob;
    try {
      // Registered through SchedulerRegistry rather than the @Cron decorator so
      // the job exists only when enabled — a decorator registers at class load.
      job = CronJob.from({
        cronTime: this.cron,
        onTick: () => void this.tick(),
        start: false,
        timeZone: TIME_ZONE,
      });
    } catch (error) {
      this.logger.error(
        `PLAYER_DIMENSION_SYNC_CRON invalida ("${this.cron}"): ${
          error instanceof Error ? error.message : String(error)
        }. O ETL da dimensao de jogador NAO foi agendado.`,
      );
      return;
    }

    this.registry.addCronJob(JOB_NAME, job);
    job.start();

    this.logger.log(
      `ETL da dimensao de jogador agendado em "${this.cron}" (${TIME_ZONE}); ` +
        'primeira execucao no proximo horario, nunca no boot',
    );
  }

  /**
   * One scheduled run.
   *
   * Swallows everything: an unhandled rejection inside a timer callback takes
   * the Node process down, which would turn a bad night's HTTP call into an API
   * outage. The service already turns its own failures into `error` rows.
   */
  private async tick(): Promise<void> {
    try {
      const result = await this.sync.sync();
      if (result.status === 'error') {
        this.logger.error(
          `ETL da dimensao de jogador falhou: ${result.detail ?? 'sem detalhe'}. ` +
            'A dimensao anterior continua de pe.',
        );
      }
    } catch (error) {
      this.logger.error(
        `ETL da dimensao de jogador falhou por inteiro: ${
          error instanceof Error ? error.message : String(error)
        }. O agendamento continua; a proxima noite tenta de novo.`,
      );
    }
  }
}
