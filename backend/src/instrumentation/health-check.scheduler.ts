import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';
import { HealthCheckRunner } from './health-check.runner';

/** Matches the default documented in `.env.example`. */
const DEFAULT_INTERVAL_MINUTES = 15;
const MS_PER_MINUTE = 60_000;

const TIMER_NAME = 'instrumentation-health';

/**
 * Drives {@link HealthCheckRunner} on a fixed interval (story S6.3, ADR-006).
 *
 * This is the slice that makes the whole layer stop being inert: everything
 * before it could run, but nothing did. The epic's promise — "a problem is
 * detected in days, not months" — is delivered here or not at all.
 *
 * ## Opt-in, and loud about being off
 *
 * The scheduler stays off unless `HEALTH_CHECK_ENABLED` is true. A health layer
 * that silently does not run is strictly worse than none, because it manufactures
 * the confidence ADR-006 exists to destroy, so being off is announced at boot
 * every time rather than inferred from an absence of alerts.
 *
 * ## Why an interval and not a cron expression
 *
 * These checks answer "is collection still happening?", which has no relationship
 * to wall-clock time — there is no hour of the day at which the question matters
 * more. An interval also degrades sanely if the container restarts, where a cron
 * could skip a whole window.
 *
 * ## The first run is delayed on purpose
 *
 * Running at boot would evaluate a Plan that may still be starting, and a
 * deploy-time restart of both machines would produce a false `breached` on every
 * check at once. One interval of grace costs nothing on a schedule of minutes.
 */
@Injectable()
export class HealthCheckScheduler implements OnModuleInit {
  private readonly logger = new Logger(HealthCheckScheduler.name);
  private readonly enabled: boolean;
  private readonly intervalMs: number;

  constructor(
    private readonly runner: HealthCheckRunner,
    private readonly registry: SchedulerRegistry,
    config: ConfigService,
  ) {
    this.enabled = config.get<boolean>('HEALTH_CHECK_ENABLED') === true;
    const minutes =
      config.get<number>('HEALTH_CHECK_INTERVAL_MINUTES') ??
      DEFAULT_INTERVAL_MINUTES;
    this.intervalMs = minutes * MS_PER_MINUTE;
  }

  onModuleInit(): void {
    if (!this.enabled) {
      this.logger.warn(
        'HEALTH_CHECK_ENABLED nao esta ligado — os checks de instrumentacao ' +
          'NAO vao rodar. Nada sera medido e nenhum alerta sera enviado.',
      );
      return;
    }

    // Registered through SchedulerRegistry rather than the @Interval decorator so
    // the timer only exists when enabled. A decorator registers at class load,
    // which would schedule the job even with the feature switched off.
    const timer = setInterval(() => {
      void this.tick();
    }, this.intervalMs);

    this.registry.addInterval(TIMER_NAME, timer);

    this.logger.log(
      `Checks de instrumentacao agendados a cada ${
        this.intervalMs / MS_PER_MINUTE
      } minuto(s); primeira execucao em um intervalo`,
    );
  }

  /**
   * One scheduled cycle.
   *
   * Swallows everything. An unhandled rejection inside a timer callback takes the
   * Node process down, which would turn a transient database blip into an outage
   * of the very system meant to notice outages. The runner already converts check
   * failures into verdicts; this is the last net, for the failures it cannot.
   */
  private async tick(): Promise<void> {
    try {
      await this.runner.runAll();
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.logger.error(
        `Ciclo de saude falhou por inteiro: ${reason}. ` +
          'O agendamento continua; o proximo ciclo tenta de novo.',
      );
    }
  }
}
