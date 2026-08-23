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
 * Read-only access to `plan_servers` — **documented exception 2 to ADR-002**,
 * approved by the owner on 2026-08-23.
 *
 * ## Why this class is allowed to exist
 *
 * ADR-002 says the API talks to `/v1/*` and never to Plan's tables. Two checks in
 * spec §6.1 cannot obey it, because Plan exposes **no catalogue of servers**:
 * `/v1/servers` and `/v1/networkOverview` both return 404 on the AusTV instance.
 *
 * Without a list, `plan.orphan_instance` could only ever check servers somebody
 * already configured by hand — which certifies health for exactly the case the
 * check exists to catch: the instance nobody knew was there.
 *
 * ## The limits, which are part of the approval
 *
 * 1. **One table only: `plan_servers`.** Any other table needs a new numbered
 *    exception in the spec, not a quiet query added here.
 * 2. **A dedicated read-only MySQL user**, separate from the plugins' user and
 *    from exception 1's. `SELECT` on this table and nothing else.
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
        'PLAN_DB_HOST nao configurado — os checks de inventario de instancia ' +
          '(orphan_instance, version_divergence) vao reportar `error`, nunca `ok`.',
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
}
