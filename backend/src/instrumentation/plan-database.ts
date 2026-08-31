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
/** Two is plenty: this pool serves two checks on a schedule of minutes. */
const POOL_SIZE = 2;

/** One row of `plan_servers`, narrowed to the columns the checks read. */
export interface PlanServerRow {
  uuid: string;
  name: string;
  proxy: boolean;
  /** e.g. `5.8 build 3605`. Null when Plan never recorded one. */
  planVersion: string | null;
}

/** Raw shape as MySQL returns it. */
interface RawServerRow extends RowDataPacket {
  uuid: string;
  name: string;
  is_proxy: number | boolean | null;
  plan_version: string | null;
}

/**
 * Rows of `plan_users`, counted.
 *
 * `plan_users` is Plan's identity table: one row per player the installation
 * ever registered, created by whichever instance saw them first. The proxy
 * records **users** while the backends record **sessions** (spec §2), so every
 * session-derived endpoint is structurally empty for the proxy and this table is
 * the only path to a registration count at all.
 *
 * ## ⚠️ In this installation these are **Survival** players, not the network
 *
 * Measured 2026-08-31, and it inverts what this file used to claim. The proxy
 * (`AusTv`, `is_proxy = 1`) sits in the `plan_servers` catalogue with **zero**
 * players in `plan_user_info`; `Survival` is the only server that appears there,
 * with 5575 of the 5638 rows; and the monthly counts of this table are, to the
 * row, the `survival` column of the verified table in `HANDOFF.md` — 682, 641,
 * 727, 374, 258, 192, 1, 106 — while its `rede` column is roughly double. The
 * network's population is in the **old** database.
 *
 * The type is named for the table rather than for either population, so a caller
 * has to decide what it is measuring instead of inheriting the answer from a
 * field name. Callers that need the distinction say so in their own docs.
 */
export interface RegisteredPlayers {
  /**
   * Rows counted, scoped to the window when one was given. **Null means the
   * count could not be read**, which is not the same as zero.
   *
   * This used to be `number`, with an `?? 0` swallowing the difference, and that
   * `?? 0` was a manufactured measurement: `toNumber` returns null for an empty
   * result *and* for any shape it does not expect — a `bigint`, a `Buffer`, a
   * `Date`, whatever the next driver bump decides a `COUNT(*)` looks like. A
   * caller then read "zero rows" and said so out loud. Callers must now handle
   * the two separately, which is the whole point of the type.
   */
  total: number | null;
  /**
   * Most recent `registered`, epoch ms. Null when the table is empty **or** when
   * the value could not be read — same caveat as {@link total}, and the reason
   * the two are reported independently.
   */
  lastRegisteredAt: number | null;
}

interface RawArrivalsRow extends RowDataPacket {
  total: number | string;
  last_registered: number | string | null;
}

/**
 * One row of `plan_users`, as the funnel needs it.
 *
 * The uuid exists only to be handed to `platformOf` (ADR-003) and dropped. It is
 * never persisted and never leaves the aggregation — spec §8 keeps player
 * identity out of this database.
 *
 * Which population these rows are is {@link RegisteredPlayers}' problem, and it
 * is not the one the name used to claim.
 */
export interface RegisteredPlayer {
  uuid: string;
  /** `plan_users.registered`, epoch ms. */
  registeredAt: number;
}

interface RawArrivalRow extends RowDataPacket {
  uuid: string;
  registered: number | string | null;
}

interface RawEarliestRow extends RowDataPacket {
  earliest: number | string | null;
}

/**
 * Read-only access to `plan_servers` and `plan_users` — **documented exception 2
 * to ADR-002**, approved by the owner on 2026-08-23 and extended the same day.
 *
 * ## Why this class is allowed to exist
 *
 * ADR-002 says the API talks to `/v1/*` and never to Plan's tables. Two checks in
 * spec §6.1 need a catalogue of servers, because without a list
 * `plan.orphan_instance` could only ever check servers somebody already
 * configured by hand — which certifies health for exactly the case the check
 * exists to catch: the instance nobody knew was there.
 *
 * ## ⚠️ The argument this exception was granted on has since been falsified
 *
 * The approval of 2026-08-23 rested on "Plan exposes **no** catalogue of
 * servers", evidenced by 404s from `/v1/servers` and `/v1/networkOverview`.
 * **Both names were wrong.** The instance's own OpenAPI, read at `/docs` on
 * 2026-08-26, documents `GET /v1/networkMetadata` — *"metadata about the network
 * such as list of servers"*.
 *
 * So this class exists on a premise that did not hold. It has **not** been
 * removed, and that is a decision, not an oversight:
 *
 * 1. Nobody has read the body of `/v1/networkMetadata`. Whether it carries
 *    `plan_version` per instance — which `plan.version_divergence` reads from
 *    `plan_servers` today — is unknown. Swapping the source before knowing would
 *    trade a working check for a hopeful one.
 * 2. The same is unresolved for the `plan_users` half: `/v1/playersTable`
 *    documents `registered` per player, but nobody checked whether it serves the
 *    network-arrivals count these checks need.
 *
 * **Trigger to revisit:** read those two bodies. Until then the exception has
 * lost its stated motive but not its function, and the honest state is to say so
 * here rather than to leave the old justification standing. Detail in ADR-002 of
 * the spec and in `HANDOFF.md`.
 *
 * ## The limits, which are part of the approval
 *
 * 1. **Two tables, and only these: `plan_servers` and `plan_users`.** Any other —
 *    `plan_user_info` and `plan_sessions` included — needs a new numbered
 *    exception in the spec, not a quiet query added here.
 * 2. **A dedicated read-only MySQL user**, separate from the plugins' user and
 *    from exception 1's. `SELECT` on those two tables and nothing else.
 * 3. **This is the only place** in the NestJS app that opens a MySQL connection
 *    to the game database.
 * 4. Credentials from the environment, never versioned.
 * 5. Unreachable database degrades to an `error` verdict naming the cause —
 *    never `ok`, never a zero.
 *
 * The coupling is real: `plan_servers` is internal schema and can change between
 * Plan versions. The mitigation is the size of the target — four columns, one
 * module — and that a schema change surfaces as a loud `error` rather than as a
 * wrong number in silence.
 */
@Injectable()
export class PlanDatabase implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PlanDatabase.name);
  private pool: Pool | null = null;
  private readonly host: string | null;
  private readonly database: string;
  private readonly user: string;
  private readonly password: string;
  private readonly port: number;

  constructor(config: ConfigService) {
    this.host = config.get<string>('PLAN_DB_HOST')?.trim() || null;
    this.port = config.get<number>('PLAN_DB_PORT') ?? DEFAULT_PORT;
    this.database = config.get<string>('PLAN_DB_NAME')?.trim() ?? '';
    this.user = config.get<string>('PLAN_DB_USER')?.trim() ?? '';
    this.password = config.get<string>('PLAN_DB_PASSWORD') ?? '';
  }

  onModuleInit(): void {
    if (!this.configured) {
      this.logger.warn(
        'PLAN_DB_HOST nao configurado — os checks que dependem do banco do Plan ' +
          '(orphan_instance, version_divergence e proxy_registration_alive) vao ' +
          'reportar `error`, nunca `ok`.',
      );
      return;
    }

    this.pool = createPool({
      host: this.host ?? undefined,
      port: this.port,
      user: this.user,
      password: this.password,
      database: this.database,
      connectionLimit: POOL_SIZE,
      connectTimeout: DEFAULT_CONNECT_TIMEOUT_MS,
      // Belt and braces next to the read-only grant: even if someone points this
      // at an over-privileged account by mistake, a stacked
      // `SELECT 1; DROP TABLE ...` cannot be sent down this connection.
      multipleStatements: false,
      // The driver would otherwise hand back `Date` objects built in the
      // container's timezone, silently shifting every timestamp we compare.
      dateStrings: true,
    });

    // Host and database are not secrets and are the first thing anyone debugging
    // a connection failure needs. The password is never logged.
    this.logger.log(
      `Plan MySQL (somente leitura) em ${this.host}:${this.port}/${this.database} ` +
        `como ${this.user}`,
    );
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool?.end();
    this.pool = null;
  }

  /** False when unconfigured — callers must report `error`, never `ok`. */
  get configured(): boolean {
    return Boolean(this.host && this.database && this.user);
  }

  /**
   * Every server Plan knows about.
   *
   * @throws when the database is unreachable or the query fails. The caller turns
   *   that into an `error` verdict; it must never be smoothed into an empty list,
   *   which would read as "no servers registered" and pass the checks.
   */
  async listServers(): Promise<PlanServerRow[]> {
    if (!this.pool) {
      throw new Error(
        'PLAN_DB_HOST nao configurado — sem conexao com o banco do Plan',
      );
    }

    // Explicit column list, never `SELECT *`: this is someone else's schema, and
    // naming the four columns makes a rename fail here, loudly, instead of
    // arriving as `undefined` somewhere downstream.
    const [rows] = await this.pool.query<RawServerRow[]>(
      'SELECT uuid, name, is_proxy, plan_version FROM plan_servers',
    );

    return rows.map((row) => ({
      uuid: row.uuid,
      name: row.name,
      // MySQL hands back TINYINT(1) as a number, or a boolean depending on
      // driver settings; both spellings are accepted rather than trusted.
      proxy: row.is_proxy === 1 || row.is_proxy === true,
      planVersion: row.plan_version ?? null,
    }));
  }

  /**
   * Registrations in `plan_users`, optionally windowed by registration time.
   *
   * Renamed from `networkArrivals` on 2026-08-31: these are Survival players in
   * this installation, not the network's. See {@link RegisteredPlayers}.
   *
   * @param since epoch ms; when given, only rows registered at or after it are
   *   counted. `lastRegisteredAt` is always the **overall** maximum, unwindowed,
   *   because "when did we last see anyone at all" is the question the liveness
   *   check asks and a windowed maximum would answer a different one.
   *
   * @throws when the database is unreachable. Never smoothed into a zero — a
   *   count of zero and a failed query mean opposite things to every caller.
   */
  async registeredPlayers(since?: number): Promise<RegisteredPlayers> {
    if (!this.pool) {
      throw new Error(
        'PLAN_DB_HOST nao configurado — sem conexao com o banco do Plan',
      );
    }

    // Parameterised even though `since` is internal: a query builder that
    // interpolates today is a query builder that interpolates user input the
    // day someone reuses it.
    const [rows] = await this.pool.query<RawArrivalsRow[]>(
      since === undefined
        ? 'SELECT COUNT(*) AS total, MAX(registered) AS last_registered FROM plan_users'
        : 'SELECT (SELECT COUNT(*) FROM plan_users WHERE registered >= ?) AS total, ' +
            '(SELECT MAX(registered) FROM plan_users) AS last_registered',
      since === undefined ? [] : [since],
    );

    const row = rows[0];
    return {
      total: toNumber(row?.total),
      lastRegisteredAt: toNumber(row?.last_registered),
    };
  }

  /**
   * Every `plan_users` row in a window, as `(uuid, registered)` pairs.
   *
   * Renamed from `networkArrivalsBetween` on 2026-08-31, with the population it
   * describes. The funnel fed these rows to its **network** step for two
   * sprints; they are the Survival, and the conversion derived from them was
   * Survival ÷ Survival. See {@link RegisteredPlayers}.
   *
   * ## ⚠️ This reads a third column, and that is an extension of exception 2
   *
   * The approval of 2026-08-23 says *"only two columns are read: `registered`
   * and the row count"*. This method also reads **`uuid`**, and the reason is
   * that the spec asks for two things that can only be satisfied together:
   *
   * - §6.2 requires every funnel step to be **segmentable by `platform`**;
   * - ADR-003 says `platform` is **derived from the uuid**, in this project by
   *   design, because deriving it any other way would need a plugin.
   *
   * So a funnel that honours §6.2 has to read the uuid. The alternative is
   * shipping the network step without platform segmentation, which fails
   * criterion 2 of story S8.1.
   *
   * **What this is not:** a new table. `plan_users` was already opened by the
   * same approval, the access stays `SELECT`-only on the same read-only user,
   * and the uuid is consumed by `platformOf` and **discarded** — spec §8 keeps
   * player identity out of this database, so nothing here is ever persisted.
   *
   * Flagged for the owner rather than done quietly: the exception's own text
   * says any widening belongs in the spec, and this is a widening.
   *
   * ## Why the whole window rather than a `GROUP BY`
   *
   * Bucketing by day has to happen in America/Sao_Paulo (`CLAUDE.md`), and
   * `platform` comes from a UUID rule that is TypeScript, not SQL. Doing either
   * in MySQL would either hardcode a timezone into someone else's database or
   * duplicate ADR-003 in a second language, where the two spellings would drift.
   *
   * The cost is bounded and measured: `plan_users` held **5.566 rows** in total
   * on 2026-08-23, and this is windowed. Streaming a few thousand pairs is
   * cheaper than either alternative is risky.
   *
   * @param from epoch ms, inclusive.
   * @param to epoch ms, inclusive.
   *
   * @throws when the database is unreachable. Never an empty array on failure —
   *   "nobody arrived" and "we could not ask" must stay distinguishable.
   */
  /**
   * Earliest `registered` in `plan_users`, epoch ms. Null when the table is empty.
   *
   * ## The number this exists to stop being invented
   *
   * `plan_users` may not hold the network's whole history. The belief on
   * record is that the proxy's rows did not come across in the 2026-08-20
   * unification, leaving the network metric shallow — but that belief was
   * **inferred, never measured**, and this very method is what measures it.
   * Whatever it returns is the answer; the paragraph above is only why the
   * question matters.
   *
   * A query for March 2026 therefore **succeeds and returns nothing**, and a
   * caller that reads "the source answered, so an empty bucket is a measured
   * zero" would publish `rede: 0` for a month when thousands of people
   * connected. Beside a tutorial step whose ETL reads plugin files going back to
   * 2025, that renders a funnel where more people enter the tutorial than reach
   * the network.
   *
   * This is the exact defect the epic exists to prevent, so the coverage floor
   * is a first-class question the funnel must ask before trusting a zero.
   */
  async earliestArrivalAt(): Promise<number | null> {
    if (!this.pool) {
      throw new Error(
        'PLAN_DB_HOST nao configurado — sem conexao com o banco do Plan',
      );
    }

    const [rows] = await this.pool.query<RawEarliestRow[]>(
      'SELECT MIN(registered) AS earliest FROM plan_users',
    );

    return toNumber(rows[0]?.earliest);
  }

  async registeredPlayersBetween(
    from: number,
    to: number,
  ): Promise<RegisteredPlayer[]> {
    if (!this.pool) {
      throw new Error(
        'PLAN_DB_HOST nao configurado — sem conexao com o banco do Plan',
      );
    }

    const [rows] = await this.pool.query<RawArrivalRow[]>(
      'SELECT uuid, registered FROM plan_users ' +
        'WHERE registered >= ? AND registered <= ? ORDER BY registered',
      [from, to],
    );

    return rows
      .map((row) => ({
        uuid: row.uuid,
        registeredAt: toNumber(row.registered),
      }))
      .filter((row): row is RegisteredPlayer => row.registeredAt !== null);
  }
}

/**
 * Coerce a MySQL numeric back to a number.
 *
 * `COUNT(*)` and `BIGINT` come back as a string from some driver/version
 * combinations and as a number from others. Trusting either spelling produces a
 * bug that only appears after a dependency bump.
 */
function toNumber(raw: number | string | null | undefined): number | null {
  if (typeof raw === 'number') {
    return Number.isFinite(raw) ? raw : null;
  }
  if (typeof raw !== 'string') {
    return null;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}
