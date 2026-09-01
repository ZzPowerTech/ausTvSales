import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';
import { CronJob } from 'cron';
import { PaymentsSyncService } from './payments-sync.service';

/**
 * Matches the default documented in `.env.example`: 03:45 BRT.
 *
 * Fifteen minutes after the player dimension and forty-five after the tutorial
 * ETL. The staggering is not about load — this is a few thousand rows — it is
 * about **not having three jobs reach the game machine at the same instant**,
 * which is the only shape of "off-peak" that survives adding a fourth job later.
 */
const DEFAULT_CRON = '45 3 * * *';
const TIME_ZONE = 'America/Sao_Paulo';
const JOB_NAME = 'payments-sync';

/**
 * Runs the PlayerPoints ETL off-peak (story S9.1, ADR-007).
 *
 * ## This is the job ADR-007 was written about
 *
 * *"Qualquer agregação vira full table scan no MySQL que o servidor de jogo
 * usa... uma varredura dessa tabela com jogadores online derruba TPS."* Every
 * other job in this codebase reads an HTTP API or the local filesystem; this one
 * puts a query on the database the Minecraft server is using. It is off by
 * default, and staying off is a safe state — E3 and E4 report `never_synced`,
 * never zero.
 *
 * ## Opt-in, and loud about being off
 *
 * The boot warning is the same shape as the tutorial ETL's, for the same reason:
 * on 2026-09-01 production validation found that ETL had been in the repo for
 * months and was never configured on the VPS. Two unset variables were all that
 * stood between two funnel steps and having ever produced a number.
 */
@Injectable()
export class PaymentsSyncScheduler implements OnModuleInit {
  private readonly logger = new Logger(PaymentsSyncScheduler.name);
  private readonly enabled: boolean;
  private readonly cron: string;

  constructor(
    private readonly sync: PaymentsSyncService,
    private readonly registry: SchedulerRegistry,
    config: ConfigService,
  ) {
    this.enabled = config.get<boolean>('PAYMENTS_SYNC_ENABLED') === true;
    this.cron =
      config.get<string>('PAYMENTS_SYNC_CRON')?.trim() || DEFAULT_CRON;
  }

  onModuleInit(): void {
    if (!this.enabled) {
      this.logger.warn(
        'PAYMENTS_SYNC_ENABLED nao esta ligado — o log de pagamentos do ' +
          'PlayerPoints NAO vai ser copiado. E3 (contato social) e E4 (feed de ' +
          'pagamentos) vao reportar `never_synced`, nunca zero. A camada de ' +
          'receita nao depende disto e continua inteira.',
      );
      return;
    }

    if (!this.sync.configured) {
      this.logger.warn(
        'PAYMENTS_SYNC_ENABLED esta ligado, mas a conexao com o PlayerPoints ' +
          'nao esta configurada — agendamento NAO registrado. Um job que so ' +
          'pode registrar falha encheria player_payment_syncs de ruido.',
      );
      return;
    }

    let job: CronJob;
    try {
      job = CronJob.from({
        cronTime: this.cron,
        onTick: () => void this.tick(),
        start: false,
        timeZone: TIME_ZONE,
      });
    } catch (error) {
      this.logger.error(
        `PAYMENTS_SYNC_CRON invalida ("${this.cron}"): ${
          error instanceof Error ? error.message : String(error)
        }. O ETL de pagamentos NAO foi agendado — o que, para um job que faz ` +
          'full table scan no banco do jogo, e o modo de falha seguro.',
      );
      return;
    }

    this.registry.addCronJob(JOB_NAME, job);
    job.start();

    this.logger.log(
      `ETL de pagamentos agendado em "${this.cron}" (${TIME_ZONE}); ` +
        'primeira execucao no proximo horario, nunca no boot',
    );
  }

  /** One scheduled run. Swallows everything — see the tutorial scheduler. */
  private async tick(): Promise<void> {
    try {
      const result = await this.sync.sync();
      if (result.status === 'error') {
        this.logger.error(
          `ETL de pagamentos falhou: ${result.detail ?? 'sem detalhe'}. ` +
            'A copia anterior continua de pe.',
        );
      }
    } catch (error) {
      this.logger.error(
        `ETL de pagamentos falhou por inteiro: ${
          error instanceof Error ? error.message : String(error)
        }. O agendamento continua; a proxima noite tenta de novo.`,
      );
    }
  }
}
