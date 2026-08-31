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
  /**
   * The limit that is not per-embed: Discord sums the titles, descriptions,
   * field names and field values of **every** embed in one message and rejects
   * the whole request with a 400 above this budget.
   *
   * The per-embed cap of 25 fields gives false comfort here. Three buckets of 25
   * fields is structurally allowed and lands far above 6000 — and the payload
   * that reaches that size is exactly the one nobody can afford to lose, because
   * `runChecks` turns an unreachable source into one `error` observation per
   * check, each carrying an exception message of up to `fieldValueChars`. A
   * blackout is what makes the message too big to send.
   */
  aggregateChars: 6000,
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
/** Grey: not a verdict about the game, a verdict about this layer's own noise. */
const COLOR_FLAPPING = 0x6b_72_80;

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
 * One group of observations and the embed that renders it.
 *
 * `cutOrder` is the order in which the aggregate budget takes fields away, not
 * the order the embeds appear in: a flapping notice is a message about this
 * layer's own noise, recoveries are good news, a lost signal is a failure we can
 * no longer see, and an active failure is the message's whole reason to exist.
 * Display order stays as it reads best.
 *
 * "Can wait a cycle" is a claim about the alert policy, not a hope. A record cut
 * here is never stamped, and `decideAlerts` compares against the last verdict
 * that was *stamped* — so next cycle the check is in the same state as far as
 * the channel is concerned, and the same bucket is produced again. Under the
 * older policy, which compared against the previous **row**, that was false: a
 * cut recovery was reclassified as `not_notifiable` the next cycle and lost for
 * good. The comparison basis is what makes this cut safe.
 */
interface AlertBucket {
  /** Everything the decision put in this bucket, before any cap. */
  records: readonly HealthCheckRecord[];
  /** Rendered fields, already capped at `embedFields` — 1:1 with `records`. */
  fields: DiscordEmbedField[];
  /** Lower is dropped first when the payload does not fit. */
  cutOrder: number;
  build: (fields: DiscordEmbedField[], total: number) => DiscordEmbed;
}

/** What one POST attempt did, so the caller can tell refusal from silence. */
type DeliveryOutcome = { ok: true } | { ok: false; status: number | null };

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
    const buckets = this.buildBuckets(decision);
    const total = buckets.reduce((sum, b) => sum + b.records.length, 0);

    if (total === 0) {
      return [];
    }

    if (!this.enabled) {
      this.logger.warn(
        `Alerta suprimido por falta de webhook: ${decision.announce.length} falha(s), ` +
          `${decision.recovered.length} recuperacao(oes), ` +
          `${decision.lostSignal.length} sem dados, ` +
          `${decision.flapping.length} oscilando`,
      );
      return [];
    }

    // Cap FIRST, then derive the returned ids from exactly what was rendered.
    //
    // The caller stamps `alerted_at` on what we return here. An id returned for
    // a field that never made it into the message is recorded as announced
    // without anyone seeing it, and `decideAlerts` then suppresses it as
    // `grouped` for the whole re-alert window — a broken check going quiet for a
    // day while the database claims it was reported. That was the bug behind the
    // 25-field cap, and the aggregate budget below can drop fields for exactly
    // the same reason, so it obeys exactly the same rule.
    const { embeds, shown } = fitWithinBudget(buckets);

    if (embeds.length === 0) {
      // Structurally reachable only with absurdly long details in every bucket.
      // Sending the summary alone still beats silence: the count is in it, and
      // the state is always in /health/instrumentation.
      this.logger.error(
        `Nenhum embed coube no orcamento de ${DISCORD_LIMITS.aggregateChars} ` +
          `caracteres do Discord; enviando apenas o resumo de ${total} ` +
          'observacao(oes)',
      );
    }

    const outcome = await this.post({
      content: truncate(
        buildSummary(decision, shown.length),
        DISCORD_LIMITS.contentChars,
      ),
      embeds,
      // The single most important field here: it makes every mention inert,
      // whatever the check detail happens to contain.
      allowed_mentions: { parse: [] as string[] },
    });

    if (!outcome.ok) {
      // Said out loud, because `publish` returning `[]` on its own is
      // indistinguishable from "there was nothing to report".
      this.logger.error(
        `Alerta NAO entregue${outcome.status === null ? '' : ` (HTTP ${outcome.status})`}: ` +
          `${total} observacao(oes) seguem sem carimbo e serao reanunciadas no ` +
          'proximo ciclo',
      );
      return [];
    }

    // Only what actually reached the channel. Anything cut — by the field cap or
    // by the aggregate budget — stays unstamped so the next cycle announces it
    // instead of grouping it away.
    return shown.map((record) => record.id);
  }

  /** Display order; `cutOrder` decides what the budget takes away first. */
  private buildBuckets(decision: AlertDecision): AlertBucket[] {
    const buckets: AlertBucket[] = [
      {
        records: decision.announce,
        fields: [],
        cutOrder: 3,
        build: (fields, total) => this.buildFailureEmbed(fields, total),
      },
      {
        records: decision.recovered,
        fields: [],
        cutOrder: 1,
        build: (fields, total) => this.buildRecoveryEmbed(fields, total),
      },
      {
        records: decision.lostSignal,
        fields: [],
        cutOrder: 2,
        build: (fields, total) => this.buildLostSignalEmbed(fields, total),
      },
      {
        records: decision.flapping,
        fields: [],
        cutOrder: 0,
        build: (fields, total) => this.buildFlappingEmbed(fields, total),
      },
    ];

    for (const bucket of buckets) {
      bucket.fields = bucket.records
        .slice(0, DISCORD_LIMITS.embedFields)
        .map((record) => toField(record));
    }

    return buckets;
  }

  /** POST the payload, retrying once on a rate limit. Never throws. */
  private async post(payload: unknown): Promise<DeliveryOutcome> {
    for (let attempt = 0; attempt <= MAX_RATE_LIMIT_RETRIES; attempt++) {
      try {
        const response = await fetch(this.webhookUrl as string, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });

        if (response.ok) {
          return { ok: true };
        }

        if (response.status === 429 && attempt < MAX_RATE_LIMIT_RETRIES) {
          const delay = await readRetryDelay(response);
          this.logger.warn(
            `Discord respondeu 429; nova tentativa em ${delay}ms`,
          );
          await sleep(delay);
          continue;
        }

        if (response.status === 400) {
          // Named apart from the other statuses because it is the one this
          // module causes. A 400 does not heal on the next cycle: the same
          // decision rebuilds the same oversized payload and is refused again,
          // for as long as the outage lasts. If this line ever appears, the
          // budget below has a hole in it.
          this.logger.error(
            'Discord recusou o payload (HTTP 400) — a mensagem estourou algum ' +
              `limite de formato apesar do orcamento de ${DISCORD_LIMITS.aggregateChars} ` +
              'caracteres. Isso e um defeito deste modulo, nao uma falha do ' +
              'Discord, e ele se repete a cada ciclo ate ser corrigido.',
          );
          return { ok: false, status: 400 };
        }

        // Status only — the body can echo the payload, and the URL is a secret.
        this.logger.error(
          `Falha ao entregar alerta no Discord: HTTP ${response.status}`,
        );
        return { ok: false, status: response.status };
      } catch (error) {
        this.logger.error(
          'Falha ao entregar alerta no Discord',
          error instanceof Error ? error.message : String(error),
        );
        return { ok: false, status: null };
      }
    }

    return { ok: false, status: null };
  }

  /**
   * @param shown fields that fit inside the message
   * @param total how many there were before truncation — the title states the
   *   real count even when the fields cannot show them all
   */
  private buildFailureEmbed(
    shown: DiscordEmbedField[],
    total: number,
  ): DiscordEmbed {
    return {
      title: `🔴 Instrumentacao: ${total} check(s) em falha`,
      description:
        'A medicao da rede do jogo parou de responder como esperado. ' +
        'Detalhe por check abaixo.',
      color: COLOR_FAILURE,
      fields: shown,
      timestamp: new Date().toISOString(),
    };
  }

  private buildRecoveryEmbed(
    shown: DiscordEmbedField[],
    total: number,
  ): DiscordEmbed {
    return {
      title: `🟢 Instrumentacao: ${total} check(s) normalizado(s)`,
      color: COLOR_RECOVERY,
      fields: shown,
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
    shown: DiscordEmbedField[],
    total: number,
  ): DiscordEmbed {
    return {
      title: `🟡 Instrumentacao: ${total} check(s) sem dados`,
      description:
        'Estes checks estavam em falha e agora nao retornam dado nenhum. ' +
        'Isso NAO e recuperacao: a fonte parou de responder, e o problema ' +
        'anterior segue sem poder ser medido.',
      color: COLOR_LOST_SIGNAL,
      fields: shown,
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Checks that hit their message budget and are about to go quiet.
   *
   * This embed is the reason the budget is allowed to exist. Capping messages
   * without saying so would leave the channel quiet about a check that is
   * misbehaving, which is indistinguishable from a check that is fine — the
   * exact confusion ADR-006 was written against. So the mute announces itself
   * and points at where the truth still lives.
   */
  private buildFlappingEmbed(
    shown: DiscordEmbedField[],
    total: number,
  ): DiscordEmbed {
    return {
      title: `⚪ Instrumentacao: ${total} check(s) oscilando — silenciado(s)`,
      description:
        'Estes checks mudaram de estado vezes demais nesta janela e gastaram o ' +
        'orcamento de mensagens. NAO significa que estao bem: significa que o ' +
        'alerta por evento parou de informar. O estado atual continua em ' +
        '/health/instrumentation, e o limiar do check provavelmente precisa de ' +
        'calibracao.',
      color: COLOR_FLAPPING,
      fields: shown,
      timestamp: new Date().toISOString(),
    };
  }
}

/**
 * Fit the buckets inside Discord's aggregate character budget.
 *
 * Returns the embeds to send and, in bucket order, the records whose fields
 * survived — the two are derived from the same slice on purpose, because the
 * caller stamps `alerted_at` on what comes back.
 *
 * The cut is one field at a time from the lowest `cutOrder` that still has one,
 * and a bucket emptied by the budget loses its embed entirely: an embed with a
 * title and no fields still costs characters and reads as if the list were the
 * whole story. What it was carrying is not lost — the counts stay in every
 * title and in the summary line.
 */
function fitWithinBudget(buckets: readonly AlertBucket[]): {
  embeds: DiscordEmbed[];
  shown: HealthCheckRecord[];
} {
  const counts = buckets.map((bucket) => bucket.fields.length);

  for (;;) {
    const embeds = renderEmbeds(buckets, counts);
    if (aggregateCost(embeds) <= DISCORD_LIMITS.aggregateChars) {
      const shown = buckets.flatMap((bucket, index) =>
        bucket.records.slice(0, counts[index]),
      );
      return { embeds, shown };
    }

    const victim = nextToCut(buckets, counts);
    if (victim === -1) {
      // Nothing left to give back. Better an embedless summary than a 400.
      return { embeds: [], shown: [] };
    }
    counts[victim] -= 1;
  }
}

/** Build the embeds for the first `counts[i]` fields of each bucket. */
function renderEmbeds(
  buckets: readonly AlertBucket[],
  counts: readonly number[],
): DiscordEmbed[] {
  return buckets
    .map((bucket, index) =>
      counts[index] > 0
        ? bucket.build(
            bucket.fields.slice(0, counts[index]),
            bucket.records.length,
          )
        : null,
    )
    .filter((embed): embed is DiscordEmbed => embed !== null);
}

/** Index of the bucket the budget takes the next field from, or -1 if empty. */
function nextToCut(
  buckets: readonly AlertBucket[],
  counts: readonly number[],
): number {
  let victim = -1;
  for (let index = 0; index < buckets.length; index++) {
    if (counts[index] === 0) {
      continue;
    }
    if (victim === -1 || buckets[index].cutOrder < buckets[victim].cutOrder) {
      victim = index;
    }
  }
  return victim;
}

/**
 * What Discord counts against the 6000: titles, descriptions, field names and
 * field values of every embed. `timestamp` and `color` are free, `content` has
 * its own separate budget.
 */
function aggregateCost(embeds: readonly DiscordEmbed[]): number {
  return embeds.reduce(
    (total, embed) =>
      total +
      embed.title.length +
      (embed.description?.length ?? 0) +
      embed.fields.reduce(
        (sum, field) => sum + field.name.length + field.value.length,
        0,
      ),
    0,
  );
}

/**
 * @param shown how many observations actually became fields in this message
 */
function buildSummary(decision: AlertDecision, shown: number): string {
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
  if (decision.flapping.length > 0) {
    parts.push(`${decision.flapping.length} oscilando (silenciado)`);
  }
  // Counted from what was rendered, not from the field cap alone, so a field
  // dropped by the aggregate budget is reported here like any other.
  const overflow =
    decision.announce.length +
    decision.recovered.length +
    decision.lostSignal.length +
    decision.flapping.length -
    shown;
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
