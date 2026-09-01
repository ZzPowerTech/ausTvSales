import { Injectable, Logger } from '@nestjs/common';
import { toSaoPauloDay } from '../tutorial/tutorial-day';
import { assignOrdinals } from './payment-key';
import { PaymentsStore, type CreationDay } from './payments.store';
import { PlayerPointsDatabase } from './playerpoints.database';

/**
 * How far the payment count may shrink before the run refuses to write.
 *
 * Same rule and same reason as the player-dimension ETL: the failure mode that
 * matters is not an exception, it is a **successful** read of a fraction of the
 * table. Here it would leave the feed missing payments while looking healthy —
 * and the feed exists to catch abuse, so a silently short feed is the worst
 * possible degradation of this module.
 */
const MIN_SHARE_OF_PREVIOUS = 0.5;

/**
 * Copies `PAY_*` payments and the `SET` arrivals series into PostgreSQL
 * (story S9.1, criteria 2 and 9, ADR-007).
 *
 * ## Nothing here runs while players are online, by design
 *
 * The source table has no index, so every read is a full scan of the MySQL the
 * Minecraft server itself uses. ADR-007: *"uma varredura dessa tabela com
 * jogadores online derruba TPS."* Hence nightly, hence opt-in, and hence the run
 * measures **both** its own wall clock and the time spent inside the MySQL query
 * — the second is the number the S9 Definition of Done actually asks about, and
 * the only way to have it is to write it down when it happens.
 *
 * ## One scan serves both outputs
 *
 * Payments and account creations are two `WHERE`s over the same unindexed table.
 * Issuing them as two statements would double the scan for no benefit — but they
 * *are* two statements here, deliberately, because the alternative is pulling
 * 6.664 rows into memory to partition them in TypeScript, and `SET` rows must
 * not carry their `receiver` uuid into this process at all (spec §8: the
 * arrivals question is answered by counting). Two scans of a 6.664-row table at
 * 03:45 is the cheaper end of that trade, and the timing is recorded so the
 * assumption is falsifiable rather than merely stated.
 *
 * ## Idempotent, and re-running is the normal operation
 *
 * Payments are upserted on the natural key plus the tiebreak ordinal; the
 * arrivals series is recomputed and replaced. The same source state produces the
 * same tables, every time.
 */
@Injectable()
export class PaymentsSyncService {
  private readonly logger = new Logger(PaymentsSyncService.name);

  constructor(
    private readonly source: PlayerPointsDatabase,
    private readonly store: PaymentsStore,
  ) {}

  /** False when the PlayerPoints connection was not configured at boot. */
  get configured(): boolean {
    return this.source.configured;
  }

  /**
   * One run. Never throws: every failure becomes an `error` row plus a log line,
   * and the previous copy stays exactly as it was.
   */
  async sync(): Promise<{ status: 'ok' | 'error'; detail?: string }> {
    const startedAt = Date.now();

    if (!this.configured) {
      return this.fail(
        startedAt,
        0,
        'PlayerPoints nao configurado — E3 (contato social) e E4 (feed de ' +
          'pagamentos) continuam reportando `never_synced`, nunca zero.',
      );
    }

    const queryStartedAt = Date.now();
    let payments;
    let creations;
    try {
      payments = await this.source.payments();
      creations = await this.source.accountCreations();
    } catch (error) {
      return this.fail(
        startedAt,
        Date.now() - queryStartedAt,
        'Nao foi possivel ler o log de transacoes do PlayerPoints. Detalhe ' +
          'tecnico no log da API.',
        error,
      );
    }
    const sourceQueryMs = Date.now() - queryStartedAt;

    const floor = await this.floorRefusal(payments.length);
    if (floor !== null) {
      return this.fail(startedAt, sourceQueryMs, floor);
    }

    const senderRows = payments.filter(
      (row) => row.transactionType === 'PAY_SENDER',
    ).length;
    const receiverRows = payments.length - senderRows;

    let paymentsWritten: number;
    let creationDaysWritten: number;
    try {
      paymentsWritten = await this.store.upsertPayments(
        assignOrdinals(payments),
      );
      creationDaysWritten = await this.store.replaceCreations(
        toDailySeries(creations),
      );
    } catch (error) {
      return this.fail(
        startedAt,
        sourceQueryMs,
        'Falha ao gravar os pagamentos no PostgreSQL. Detalhe no log da API.',
        error,
      );
    }

    const durationMs = Date.now() - startedAt;
    await this.store.recordSuccess({
      paymentsRead: payments.length,
      paymentsWritten,
      senderRows,
      receiverRows,
      creationsRead: creations.length,
      creationDaysWritten,
      durationMs,
      sourceQueryMs,
    });

    if (senderRows !== receiverRows) {
      // Not a failure — the copy is fine. But every social number is built on
      // the assumption that the two types are the two halves of one payment,
      // and this is the one observation that can falsify it.
      this.logger.warn(
        `PAY_SENDER (${senderRows}) e PAY_RECEIVER (${receiverRows}) nao ` +
          'batem. A premissa de que os dois tipos sao as duas metades de um ' +
          'mesmo pagamento pode estar errada, e E3/E4 sao construidos sobre ' +
          'ela. Vale conferir antes de citar qualquer numero social.',
      );
    }

    this.logger.log(
      `Pagamentos sincronizados: ${paymentsWritten} linha(s), ` +
        `${creationDaysWritten} dia(s) de criacao de conta, em ${durationMs}ms ` +
        `(${sourceQueryMs}ms dentro do MySQL do jogo)`,
    );

    return { status: 'ok' };
  }

  /** Refuse the write when the read is degenerate. */
  private async floorRefusal(read: number): Promise<string | null> {
    if (read === 0) {
      return (
        'O log do PlayerPoints devolveu zero pagamentos. A copia anterior foi ' +
        'mantida: uma tabela vazia e indistinguivel de uma leitura degradada, ' +
        'e gravar isso como fato apagaria o feed que existe para pegar abuso.'
      );
    }

    const previous = await this.store.lastSuccessfulSync();
    const before = previous?.paymentsRead ?? 0;
    if (before > 0 && read < before * MIN_SHARE_OF_PREVIOUS) {
      return (
        `O log do PlayerPoints devolveu ${read} pagamentos contra ${before} da ` +
        'ultima execucao bem-sucedida. A copia anterior foi mantida: um upsert ' +
        'parcial nao apaga nada, mas deixa o feed curto sem parecer quebrado, ' +
        'que e a pior degradacao possivel de um instrumento de moderacao.'
      );
    }

    return null;
  }

  private async fail(
    startedAt: number,
    sourceQueryMs: number,
    detail: string,
    cause?: unknown,
  ): Promise<{ status: 'error'; detail: string }> {
    // The upstream message names a host, a port and an account. It goes to the
    // log; the persisted detail is a sentence without topology (CWE-209).
    this.logger.error(
      cause === undefined ? detail : `${detail} — ${describe(cause)}`,
    );

    await this.store.recordFailure({
      detail,
      durationMs: Date.now() - startedAt,
      sourceQueryMs,
    });

    return { status: 'error', detail };
  }
}

/**
 * Bucket `SET` timestamps into São Paulo days.
 *
 * A day with no creations gets **no row**, not a zero — the series is read
 * alongside the sync provenance, and "no row inside a covered range" is what
 * genuinely means nobody arrived. Writing zeros would make an absent day and a
 * measured-empty day identical, which is the distinction this project spends
 * most of its effort keeping.
 */
export function toDailySeries(
  creations: readonly { occurredAt: number }[],
): CreationDay[] {
  const byDay = new Map<string, number>();

  for (const creation of creations) {
    const day = toSaoPauloDay(creation.occurredAt);
    if (day === null) {
      continue;
    }
    byDay.set(day, (byDay.get(day) ?? 0) + 1);
  }

  return [...byDay.entries()]
    .map(([day, created]) => ({ day, created }))
    .sort((a, b) => a.day.localeCompare(b.day));
}

/** A one-line description of an unknown throw, safe to log. */
function describe(cause: unknown): string {
  if (cause instanceof Error) {
    return cause.message;
  }
  try {
    return JSON.stringify(cause) ?? typeof cause;
  } catch {
    return typeof cause;
  }
}
