import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createPool, type Pool, type RowDataPacket } from 'mysql2/promise';

const DEFAULT_PORT = 3306;
const DEFAULT_CONNECT_TIMEOUT_MS = 8_000;
/** One is enough: a single nightly job is the only caller. */
const POOL_SIZE = 1;
/** PlayerPoints' own default. Configurable because the plugin allows a prefix. */
const DEFAULT_TABLE = 'playerpoints_transaction_log';

/**
 * Charset of the table name.
 *
 * A table name cannot be a bound parameter — it is an identifier, so it is
 * interpolated into the statement, and interpolation is where injection lives.
 * The value comes from our own `.env` rather than from a request, so this is not
 * the last line of defence; it is the one that makes "someone pasted the wrong
 * thing into an environment file" fail at boot instead of at midnight.
 */
const TABLE_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

/** One `PAY_*` row, exactly as the source records it. */
export interface PaymentRow {
  transactionType: string;
  /** Counterparty uuid. `NOT NULL` for `PAY_*` rows (measured 2026-08-21). */
  source: string;
  /** The account the row applies to. */
  receiver: string;
  /** Signed integer amount. */
  amount: number;
  /** `timestamp` column, epoch ms. */
  occurredAt: number;
}

/** One `SET` row, reduced to the only thing this system stores about it. */
export interface CreationRow {
  occurredAt: number;
}

interface RawPaymentRow extends RowDataPacket {
  transaction_type: string;
  source: string | null;
  receiver: string | null;
  amount: number | string | null;
  ts: number | string | null;
}

interface RawCreationRow extends RowDataPacket {
  ts: number | string | null;
}

/**
 * Read-only access to the PlayerPoints transaction log (story S9.1, ADR-007).
 *
 * ## This is a different database from `PlanDatabase`, and the distinction matters
 *
 * ADR-002's exception 2 says `PlanDatabase` is *"the only place in the NestJS app
 * that opens a MySQL connection to the game database"*. That sentence is about
 * **Plan's** schema, which ADR-002 governs. PlayerPoints is a different plugin,
 * a different schema, and its own ADR: ADR-007 authorises reading it directly
 * because *"leitura direta de schema de plugin é acoplamento aceito apenas onde o
 * schema é trivial e estável"*, and this one is six columns that have not moved.
 *
 * Reading it as an ADR-002 violation would be a category error, and reading it
 * as a licence to add a third MySQL connection would be worse. The rule that
 * survives both: **one class per authorised source, and a new source needs a new
 * ADR.**
 *
 * ## Nothing here runs while players are online
 *
 * The source table has **no index at all** — no primary key, nothing on
 * `receiver`, `timestamp` or `source`. Every query below is therefore a full
 * table scan by construction, and there is no query shape that avoids it. ADR-007
 * is explicit about the consequence: *"uma varredura dessa tabela com jogadores
 * online derruba TPS"*. Hence a nightly job, hence the scheduler is opt-in, and
 * hence the ETL measures its own time so the cost stops being a guess.
 *
 * ## The limits, which are part of the authorisation
 *
 * 1. **One table.** Any other needs a new numbered decision, not a quiet query.
 * 2. **A dedicated read-only MySQL user**, separate from the plugins' own —
 *    which is the same account whose credentials sit in plain text in four
 *    plugin configs, and therefore exactly the account this must not reuse.
 * 3. Credentials from the environment, never versioned.
 * 4. Unreachable database records an `error` run and keeps the previous copy —
 *    never an empty table, never a zero.
 */
@Injectable()
export class PlayerPointsDatabase implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PlayerPointsDatabase.name);
  private pool: Pool | null = null;

  private readonly host: string | null;
  private readonly port: number;
  private readonly database: string;
  private readonly user: string;
  private readonly password: string;
  private readonly table: string;

  constructor(config: ConfigService) {
    this.host = config.get<string>('PLAYERPOINTS_DB_HOST')?.trim() || null;
    this.port = config.get<number>('PLAYERPOINTS_DB_PORT') ?? DEFAULT_PORT;
    this.database = config.get<string>('PLAYERPOINTS_DB_NAME')?.trim() ?? '';
    this.user = config.get<string>('PLAYERPOINTS_DB_USER')?.trim() ?? '';
    this.password = config.get<string>('PLAYERPOINTS_DB_PASSWORD') ?? '';
    this.table =
      config.get<string>('PLAYERPOINTS_TABLE')?.trim() || DEFAULT_TABLE;
  }

  onModuleInit(): void {
    if (!TABLE_NAME_PATTERN.test(this.table)) {
      // Refusing to start the pool rather than throwing: a bad table name must
      // not take the whole API down, and the ETL will record `error` with a
      // reason a human can act on.
      this.logger.error(
        `PLAYERPOINTS_TABLE invalida ("${this.table}") — so letras, digitos e ` +
          'underscore sao aceitos. O ETL de pagamentos NAO vai rodar.',
      );
      return;
    }

    if (!this.host) {
      this.logger.warn(
        'PLAYERPOINTS_DB_HOST nao configurado — E3 (contato social) e E4 (feed ' +
          'de pagamentos) vao reportar `never_synced`, nunca zero. A camada de ' +
          'receita nao depende disto.',
      );
      return;
    }

    this.pool = createPool({
      host: this.host,
      port: this.port,
      user: this.user,
      password: this.password,
      database: this.database,
      connectionLimit: POOL_SIZE,
      connectTimeout: DEFAULT_CONNECT_TIMEOUT_MS,
      // Belt and braces next to the read-only grant: even pointed at an
      // over-privileged account by mistake, a stacked statement cannot be sent.
      multipleStatements: false,
      // `timestamp` comes back as a driver `Date` built in the process timezone
      // otherwise, which would silently re-time every row on a container that
      // is not in America/Sao_Paulo. Epoch milliseconds have no timezone.
      dateStrings: false,
      timezone: 'Z',
    });

    this.logger.log(
      `PlayerPoints em ${this.host}:${this.port}/${this.database}, tabela ` +
        `${this.table} (somente leitura, ${POOL_SIZE} conexao)`,
    );
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool?.end();
    this.pool = null;
  }

  /** False when the host is unset or the table name was rejected at boot. */
  get configured(): boolean {
    return this.pool !== null;
  }

  /**
   * Every `PAY_SENDER` / `PAY_RECEIVER` row, ordered deterministically.
   *
   * The whole table, every run. Two reasons, and the second is the one that is
   * not obvious: without an index a `WHERE timestamp > ?` scans exactly as much
   * as no `WHERE` at all, so incremental reading buys nothing; and a full read
   * makes the ETL self-healing, since a row edited or deleted upstream is
   * reflected instead of being frozen forever by an incremental high-water mark.
   *
   * The `ORDER BY` is what makes the ordinal deterministic across runs. Without
   * it, MySQL is free to return byte-identical rows in a different order and the
   * ordinals would shuffle, which would turn a re-run into a set of new rows.
   */
  async payments(): Promise<PaymentRow[]> {
    const pool = this.requirePool();
    const [rows] = await pool.query<RawPaymentRow[]>(
      `SELECT transaction_type, source, receiver, amount,
              UNIX_TIMESTAMP(timestamp) * 1000 AS ts
         FROM \`${this.table}\`
        WHERE transaction_type IN ('PAY_SENDER', 'PAY_RECEIVER')
        ORDER BY timestamp ASC, transaction_type ASC, source ASC,
                 receiver ASC, amount ASC`,
    );

    const payments: PaymentRow[] = [];
    for (const row of rows) {
      const amount = toNumber(row.amount);
      const occurredAt = toNumber(row.ts);
      // A row missing a uuid, an amount or a timestamp cannot be filed under a
      // payment. Dropped rather than defaulted — the caller counts the drops.
      if (
        row.source === null ||
        row.receiver === null ||
        amount === null ||
        occurredAt === null
      ) {
        continue;
      }
      payments.push({
        transactionType: row.transaction_type,
        source: row.source,
        receiver: row.receiver,
        amount,
        occurredAt,
      });
    }

    return payments;
  }

  /**
   * Every `SET` row's timestamp — the arrivals series of R1.
   *
   * Only the timestamp comes back. The `receiver` uuid is deliberately not
   * selected: the question is a count, and spec §8 keeps player identity out of
   * this system wherever counting suffices.
   */
  async accountCreations(): Promise<CreationRow[]> {
    const pool = this.requirePool();
    const [rows] = await pool.query<RawCreationRow[]>(
      `SELECT UNIX_TIMESTAMP(timestamp) * 1000 AS ts
         FROM \`${this.table}\`
        WHERE transaction_type = 'SET'`,
    );

    const creations: CreationRow[] = [];
    for (const row of rows) {
      const occurredAt = toNumber(row.ts);
      if (occurredAt !== null) {
        creations.push({ occurredAt });
      }
    }
    return creations;
  }

  private requirePool(): Pool {
    if (this.pool === null) {
      throw new Error(
        'PlayerPoints nao configurado — PLAYERPOINTS_DB_HOST ausente ou nome ' +
          'de tabela recusado no boot',
      );
    }
    return this.pool;
  }
}

/**
 * Coerce a MySQL scalar to a number, or `null` when it carries no value.
 *
 * Never `0`. The driver returns `DECIMAL` and `BIGINT` as strings depending on
 * version and column, and a caller that cannot tell "no value" from "zero" will
 * eventually publish the second as the first.
 */
function toNumber(raw: unknown): number | null {
  if (typeof raw === 'number') {
    return Number.isFinite(raw) ? raw : null;
  }
  if (typeof raw === 'string' && raw.trim() !== '') {
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}
