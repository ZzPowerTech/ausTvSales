import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AlertDecision } from './alert-policy';
import { parseCheckName, type HealthCheckRecord } from './health-check.types';

/** Discord hard limits we must stay inside, or the webhook rejects the payload. */
const DISCORD_LIMITS = {
  contentChars: 2000,
  embedFields: 25,
  fieldNameChars: 256,
  fieldValueChars: 1024,
} as const;

/**
 * Red for failures, green for recoveries, amber for lost signal.
 *
 * The third colour is not decoration. A check that fell to `no_data` after
 * failing has not recovered — it stopped being measurable — and painting that
 * green is a false all-clear on exactly the kind of gap ADR-006 exists to catch.
 */
const COLOR_FAILURE = 0xd9_36_3c;
const COLOR_RECOVERY = 0x2e_8b_57;
const COLOR_LOST_SIGNAL = 0xd7_8b_1f;

/** One retry is enough for a rate limit; beyond that the next cycle covers it. */
const MAX_RATE_LIMIT_RETRIES = 1;
const MAX_RETRY_DELAY_MS = 10_000;
const REQUEST_TIMEOUT_MS = 10_000;

interface DiscordEmbedField {
  name: string;
  value: string;
  inline: boolean;
}

interface DiscordEmbed {
  title: string;
  description?: string;
  color: number;
  fields: DiscordEmbedField[];
  timestamp: string;
}

/**
 * Delivers instrumentation-health alerts to Discord (story S6.3, spec §5.3/§6.1).
 *
 * ADR-006 is the reason this class exists at all: a check that notices an outage
 * and waits for someone to open a page is the same silence that let the proxy sit
 * dead for three months. The alert has to go out on its own.
 *
 * Three properties this class must never lose:
 *
 * 1. **It never throws at the caller.** The scheduler must keep running even when
 *    Discord is down. A failed delivery is logged at error level and reported by
 *    returning fewer announced ids, so the row stays unstamped and the next cycle
 *    retries it. Losing the alert entirely is the one outcome worse than a late one.
 * 2. **It never lets data become a mention.** Check details carry server names
 *    from the Plan; `allowed_mentions: { parse: [] }` makes `@everyone` inert no
 *    matter what any string contains, and markdown is escaped on top of that.
 * 3. **It never logs the webhook URL.** The URL *is* the credential — anyone
 *    holding it can post to the channel.
 */
@Injectable()
export class DiscordAlerter implements OnModuleInit {
  private readonly logger = new Logger(DiscordAlerter.name);
  private readonly webhookUrl: string | undefined;

  // Read once at construction and kept private: the URL is the credential, so it
  // is never re-fetched, never re-exposed and never logged.
  constructor(config: ConfigService) {
    this.webhookUrl = config.get<string>('DISCORD_ALERT_WEBHOOK_URL')?.trim();
  }

  onModuleInit(): void {
    if (this.enabled) {
      this.logger.log(
        'Alerta de saude da instrumentacao ativo (webhook configurado)',
      );
      return;
    }
    // Loud on purpose. A health system that cannot alert is the exact failure
    // ADR-006 exists to prevent, and it must never be discovered months later.
    this.logger.warn(
      'DISCORD_ALERT_WEBHOOK_URL nao configurado — os checks vao rodar e ' +
        'persistir, mas NENHUM alerta sera entregue. Configure antes de confiar ' +
        'na instrumentacao (ADR-006).',
    );
  }

  get enabled(): boolean {
    return Boolean(this.webhookUrl);
  }

  /**
   * Publish one decision as a single Discord message.
   *
   * Returns the ids of the observations that were actually delivered, so the
   * caller can stamp `alerted_at` on exactly those. An empty result means nothing
   * reached the channel — never that nothing was wrong.
   */
  async publish(decision: AlertDecision): Promise<number[]> {
    // Slice FIRST, then derive the returned ids from the same slices that became
    // embed fields.
    //
    // The previous version built the embeds from `slice(0, 25)` but returned
    // every id in the decision. The caller stamps `alerted_at` on what we return,
    // so with 30 failing checks, 5 were recorded as announced without ever
    // appearing in the message — and `decideAlerts` then suppressed them as
    // `grouped` for the whole re-alert window. Broken checks went quiet for a
    // day while the database claimed they had been reported.
    const failures = decision.announce.slice(0, DISCORD_LIMITS.embedFields);
    const recoveries = decision.recovered.slice(0, DISCORD_LIMITS.embedFields);
    const lost = decision.lostSignal.slice(0, DISCORD_LIMITS.embedFields);

    const embeds: DiscordEmbed[] = [];

    if (failures.length > 0) {
      embeds.push(this.buildFailureEmbed(failures, decision.announce.length));
    }
    if (recoveries.length > 0) {
      embeds.push(
        this.buildRecoveryEmbed(recoveries, decision.recovered.length),
      );
    }
    if (lost.length > 0) {
      embeds.push(this.buildLostSignalEmbed(lost, decision.lostSignal.length));
    }
    if (embeds.length === 0) {
      return [];
    }

    if (!this.enabled) {
      this.logger.warn(
        `Alerta suprimido por falta de webhook: ${decision.announce.length} falha(s), ` +
          `${decision.recovered.length} recuperacao(oes), ` +
          `${decision.lostSignal.length} sem dados`,
      );
      return [];
    }

    const delivered = await this.post({
      content: truncate(buildSummary(decision), DISCORD_LIMITS.contentChars),
      embeds,
      // The single most important field here: it makes every mention inert,
      // whatever the check detail happens to contain.
      allowed_mentions: { parse: [] as string[] },
    });

    if (!delivered) {
      return [];
    }

    // Only what actually reached the channel. Anything truncated stays unstamped
    // so the next cycle announces it instead of grouping it away.
    return [...failures, ...recoveries, ...lost].map((record) => record.id);
  }

  /** POST the payload, retrying once on a rate limit. Never throws. */
  private async post(payload: unknown): Promise<boolean> {
    for (let attempt = 0; attempt <= MAX_RATE_LIMIT_RETRIES; attempt++) {
      try {
        const response = await fetch(this.webhookUrl as string, {
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
            `Discord respondeu 429; nova tentativa em ${delay}ms`,
          );
          await sleep(delay);
          continue;
        }

        // Status only — the body can echo the payload, and the URL is a secret.
        this.logger.error(
          `Falha ao entregar alerta no Discord: HTTP ${response.status}`,
        );
        return false;
      } catch (error) {
        this.logger.error(
          'Falha ao entregar alerta no Discord',
          error instanceof Error ? error.message : String(error),
        );
        return false;
      }
    }

    return false;
  }

  /**
   * @param shown records that fit inside the message
   * @param total how many there were before truncation — the title states the
   *   real count even when the fields cannot show them all
   */
  private buildFailureEmbed(
    shown: HealthCheckRecord[],
    total: number,
  ): DiscordEmbed {
    return {
      title: `🔴 Instrumentacao: ${total} check(s) em falha`,
      description:
        'A medicao da rede do jogo parou de responder como esperado. ' +
        'Detalhe por check abaixo.',
      color: COLOR_FAILURE,
      fields: shown.map((record) => toField(record)),
      timestamp: new Date().toISOString(),
    };
  }

  private buildRecoveryEmbed(
    shown: HealthCheckRecord[],
    total: number,
  ): DiscordEmbed {
    return {
      title: `🟢 Instrumentacao: ${total} check(s) normalizado(s)`,
      color: COLOR_RECOVERY,
      fields: shown.map((record) => toField(record)),
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Checks that went quiet after failing — explicitly *not* a recovery.
   *
   * The wording matters as much as the colour: someone skimming a green banner
   * concludes the incident is over. This one has to say that measurement
   * stopped, because that is what happened.
   */
  private buildLostSignalEmbed(
    shown: HealthCheckRecord[],
    total: number,
  ): DiscordEmbed {
    return {
      title: `🟡 Instrumentacao: ${total} check(s) sem dados`,
      description:
        'Estes checks estavam em falha e agora nao retornam dado nenhum. ' +
        'Isso NAO e recuperacao: a fonte parou de responder, e o problema ' +
        'anterior segue sem poder ser medido.',
      color: COLOR_LOST_SIGNAL,
      fields: shown.map((record) => toField(record)),
      timestamp: new Date().toISOString(),
    };
  }
}

function buildSummary(decision: AlertDecision): string {
  const parts: string[] = [];
  if (decision.announce.length > 0) {
    parts.push(`${decision.announce.length} check(s) em falha`);
  }
  if (decision.recovered.length > 0) {
    parts.push(`${decision.recovered.length} normalizado(s)`);
  }
  if (decision.lostSignal.length > 0) {
    parts.push(`${decision.lostSignal.length} sem dados`);
  }
  const overflow =
    Math.max(0, decision.announce.length - DISCORD_LIMITS.embedFields) +
    Math.max(0, decision.recovered.length - DISCORD_LIMITS.embedFields) +
    Math.max(0, decision.lostSignal.length - DISCORD_LIMITS.embedFields);
  if (overflow > 0) {
    // Silent truncation would read as "that was everything" when it was not.
    parts.push(`${overflow} nao exibido(s) por limite do Discord`);
  }
  return `**Saude da instrumentacao** — ${parts.join(' · ')}`;
}

function toField(record: HealthCheckRecord): DiscordEmbedField {
  const { name, target } = parseCheckName(record.checkName);
  const heading = target ? `${name} (${target})` : name;

  return {
    name: truncate(escapeMarkdown(heading), DISCORD_LIMITS.fieldNameChars),
    value: truncate(
      escapeMarkdown(describe(record)),
      DISCORD_LIMITS.fieldValueChars,
    ),
    inline: false,
  };
}

/**
 * Human-readable body of one verdict.
 *
 * A ratio is never rendered without the `n` behind it: the project rule is that
 * no percentage is published without its base, and an alert is the worst place
 * to break it — someone is about to act on this number.
 */
function describe(record: HealthCheckRecord): string {
  const detail = record.detail;
  const lines = [`status: ${record.status}`];

  if (detail?.summary) {
    lines.push(detail.summary);
  }

  if (detail?.observed !== undefined) {
    const base =
      detail.n === undefined ? ' (n indisponivel)' : ` (n=${detail.n})`;
    const threshold =
      detail.threshold === undefined ? '' : ` · limite ${detail.threshold}`;
    lines.push(`observado ${detail.observed}${base}${threshold}`);
  }

  if (detail?.context) {
    const context = Object.entries(detail.context)
      .map(([key, value]) => `${key}=${String(value)}`)
      .join(' · ');
    if (context) {
      lines.push(context);
    }
  }

  return lines.join('\n');
}

/**
 * Neutralise Discord markdown in values that come from outside this codebase.
 *
 * Defence in depth next to `allowed_mentions`: that field stops a mention from
 * pinging, this stops a server name from silently reformatting the message and
 * hiding the rest of the alert behind a spoiler or a code fence.
 */
export function escapeMarkdown(value: string): string {
  return value.replace(/[\\*_~`|>#\-[\]()]/g, (match) => `\\${match}`);
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

/** Discord's documented `retry_after` is in seconds; the header is too. */
async function readRetryDelay(response: Response): Promise<number> {
  const header = response.headers.get('retry-after');
  const fromHeader = header === null ? Number.NaN : Number(header) * 1000;
  if (Number.isFinite(fromHeader) && fromHeader > 0) {
    return Math.min(fromHeader, MAX_RETRY_DELAY_MS);
  }

  try {
    const body: unknown = await response.json();
    const retryAfter =
      typeof body === 'object' && body !== null && 'retry_after' in body
        ? Number(body.retry_after) * 1000
        : Number.NaN;
    if (Number.isFinite(retryAfter) && retryAfter > 0) {
      return Math.min(retryAfter, MAX_RETRY_DELAY_MS);
    }
  } catch {
    // Body was not JSON — fall through to the default.
  }

  return 1000;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
