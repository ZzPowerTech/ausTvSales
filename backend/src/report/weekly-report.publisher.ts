import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/** Discord's per-embed description cap. The renderer already clamps to it. */
const DESCRIPTION_LIMIT = 4096;
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_RATE_LIMIT_RETRIES = 1;
const MAX_RETRY_DELAY_MS = 10_000;

const COLOR_REPORT = 0x2f_6f_ed;
const COLOR_FAILURE = 0xd9_36_3c;

/**
 * Delivers the weekly report to Discord (story S9.2).
 *
 * ## Why a second Discord class instead of reusing `DiscordAlerter`
 *
 * They send to **different channels and mean different things**. `DiscordAlerter`
 * pages: something broke, look now. This posts a scheduled reading that is
 * normal even when everything is fine. Mixing them costs both — a weekly wall of
 * text dilutes an alert channel until people stop reading it, which is the exact
 * mechanism by which a Discord channel goes mute, and this epic already has one
 * story about that.
 *
 * `DISCORD_REPORT_WEBHOOK_URL` is therefore its own variable with **no fallback**
 * to the alert webhook. A silent fallback would put the report in the alert
 * channel and nobody would find out until the alerts stopped being read.
 *
 * ## Three properties it shares with the alerter, and must not lose
 *
 * 1. **It never throws at the caller.** A failed delivery comes back as `false`,
 *    is logged, and leaves the stored row un-stamped. The scheduler keeps
 *    running; the report is already persisted before this class is called.
 * 2. **It never lets content become a mention.** `allowed_mentions: { parse: [] }`
 *    makes `@everyone` inert whatever any string contains.
 * 3. **It never logs the webhook URL.** The URL *is* the credential.
 */
@Injectable()
export class WeeklyReportPublisher implements OnModuleInit {
  private readonly logger = new Logger(WeeklyReportPublisher.name);
  private readonly webhookUrl: string | undefined;

  constructor(config: ConfigService) {
    this.webhookUrl = config.get<string>('DISCORD_REPORT_WEBHOOK_URL')?.trim();
  }

  onModuleInit(): void {
    if (this.configured) {
      this.logger.log('Relatorio semanal com webhook configurado');
      return;
    }

    this.logger.warn(
      'DISCORD_REPORT_WEBHOOK_URL nao configurado — o relatorio semanal vai ' +
        'ser gerado e persistido, mas NAO vai chegar a canal nenhum. A leitura ' +
        'que chega sozinha e a razao de ser desta historia; sem o webhook ela ' +
        'volta a depender de alguem abrir uma pagina.',
    );
  }

  get configured(): boolean {
    return Boolean(this.webhookUrl);
  }

  /** Post the report. Returns whether the channel received it. */
  publish(title: string, body: string): Promise<boolean> {
    return this.post(title, body, COLOR_REPORT);
  }

  /**
   * Post the notice that the job failed (criterion 3).
   *
   * The whole point of the criterion: *"um relatório semanal que simplesmente
   * para de chegar é indistinguível de uma semana sem novidade"*. This is the
   * message that keeps those two apart.
   */
  publishFailure(title: string, body: string): Promise<boolean> {
    return this.post(title, body, COLOR_FAILURE);
  }

  private async post(
    title: string,
    body: string,
    color: number,
  ): Promise<boolean> {
    if (!this.webhookUrl) {
      this.logger.warn(
        `Relatorio semanal nao entregue: sem webhook configurado (${title})`,
      );
      return false;
    }

    const payload = {
      embeds: [
        {
          title,
          description: body.slice(0, DESCRIPTION_LIMIT),
          color,
          timestamp: new Date().toISOString(),
        },
      ],
      allowed_mentions: { parse: [] as string[] },
    };

    for (let attempt = 0; attempt <= MAX_RATE_LIMIT_RETRIES; attempt++) {
      try {
        const response = await fetch(this.webhookUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });

        if (response.ok) {
          return true;
        }

        if (response.status === 429 && attempt < MAX_RATE_LIMIT_RETRIES) {
          const delay = await readRetryDelay(response);
          this.logger.warn(
            `Discord respondeu 429 no relatorio; nova tentativa em ${delay}ms`,
          );
          await sleep(delay);
          continue;
        }

        // Status only: the body can echo the payload, and the URL is a secret.
        this.logger.error(
          `Falha ao entregar o relatorio semanal: HTTP ${response.status}. ` +
            'O relatorio ficou persistido e pode ser lido em /reports/weekly.',
        );
        return false;
      } catch (error) {
        this.logger.error(
          'Falha ao entregar o relatorio semanal',
          error instanceof Error ? error.message : String(error),
        );
        return false;
      }
    }

    return false;
  }
}

/** Honour `retry_after`, bounded, so a bad header cannot park the job. */
async function readRetryDelay(response: Response): Promise<number> {
  try {
    const body = (await response.json()) as { retry_after?: number };
    const seconds = typeof body.retry_after === 'number' ? body.retry_after : 1;
    return Math.min(Math.max(seconds, 0) * 1000, MAX_RETRY_DELAY_MS);
  } catch {
    return 1000;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
