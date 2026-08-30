import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, gt, inArray, isNotNull, sql } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDB } from '../db/database.module';
import { healthChecks } from '../db/schema';
import type {
  HealthCheckDetail,
  HealthCheckRecord,
  HealthCheckStatus,
  LastAlert,
} from './health-check.types';

/**
 * How far back {@link HealthCheckStore.healthyStreak} looks.
 *
 * Generous next to any plausible cadence — at 15 minutes it covers ~670 rows per
 * check — and its only failure direction is holding a recovery back.
 */
const STREAK_HORIZON_DAYS = 7;

/** One check verdict, before it is persisted. */
export interface HealthCheckObservation {
  /** Persisted check name, possibly scoped (`plan.collection_alive:survival`). */
  checkName: string;
  status: HealthCheckStatus;
  detail: HealthCheckDetail;
}

/**
 * Persistence for instrumentation-health verdicts (story S6.3, spec §6.1).
 *
 * `health_checks` is append-only, so this class only ever inserts and reads —
 * with the single exception of {@link markAlerted}, which stamps a row after its
 * notification actually went out. Never updating a verdict in place is what
 * makes the history trustworthy: ADR-006 exists because nobody could answer
 * "since when has this been broken?", and an overwritten row cannot answer it
 * either.
 *
 * `checked_at` is stamped by the database (`defaultNow()`) rather than by the
 * application, so the ordering the history depends on cannot be scrambled by
 * clock skew between the API container and Postgres.
 *
 * ## Retiring a check name is a manual step, and it has to be
 *
 * There is no `delete` here and no retention policy — the price of append-only.
 * One consequence is worth knowing before it surprises somebody: a check name
 * that stops being written (a server renamed in `PLAN_SERVERS`, a check dropped
 * from the registry) keeps its last row forever, so the S7.1 read model watches
 * it age past the tolerance and reports the layer as `down` permanently.
 *
 * That is the correct default. Dropping the name automatically would be the same
 * class of mistake as reading a collection gap as zero: the row *is* the
 * evidence that something used to report and stopped. Retiring it is a
 * deliberate act:
 *
 * ```sql
 * DELETE FROM health_checks WHERE check_name = 'plan.collection_alive:NomeAntigo';
 * ```
 *
 * Run it when the name is genuinely gone — never to quiet an endpoint that is
 * telling the truth.
 */
@Injectable()
export class HealthCheckStore {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDB) {}

  /**
   * Append one verdict per observation, in a single statement.
   *
   * Returns the persisted rows so the caller can stamp `alerted_at` on exactly
   * the rows it announced, without a second lookup.
   */
  async record(
    observations: readonly HealthCheckObservation[],
  ): Promise<HealthCheckRecord[]> {
    if (observations.length === 0) {
      return [];
    }

    const rows = await this.db
      .insert(healthChecks)
      .values(
        observations.map((observation) => ({
          checkName: observation.checkName,
          status: observation.status,
          detail: observation.detail,
        })),
      )
      .returning();

    return rows.map(toRecord);
  }

  /** Most recent verdict for one check, or null if it has never run. */
  async latest(checkName: string): Promise<HealthCheckRecord | null> {
    const rows = await this.db
      .select()
      .from(healthChecks)
      .where(eq(healthChecks.checkName, checkName))
      .orderBy(desc(healthChecks.checkedAt), desc(healthChecks.id))
      .limit(1);

    return rows.length > 0 ? toRecord(rows[0]) : null;
  }

  /**
   * Current state of every check: the most recent row per `check_name`.
   *
   * `DISTINCT ON` keeps this a single index scan instead of a correlated
   * subquery per check. The tiebreak on `id` matters — two rows of the same
   * check can share a `checked_at` when a run is fast, and without it the
   * "current" verdict would be arbitrary.
   */
  async latestAll(): Promise<HealthCheckRecord[]> {
    const result = await this.db.execute<PersistedRow>(sql`
      SELECT DISTINCT ON (${healthChecks.checkName})
        ${healthChecks.id}         AS id,
        ${healthChecks.checkName}  AS check_name,
        ${healthChecks.status}     AS status,
        ${healthChecks.checkedAt}  AS checked_at,
        ${healthChecks.detail}     AS detail,
        ${healthChecks.alertedAt}  AS alerted_at
      FROM ${healthChecks}
      ORDER BY ${healthChecks.checkName}, ${healthChecks.checkedAt} DESC, ${healthChecks.id} DESC
    `);

    return result.rows.map(fromRawRow);
  }

  /**
   * How many of the most recent verdicts, per check, are consecutively `ok`.
   *
   * Counts backwards from the newest row and stops at the first row that is not
   * `ok`, saturating at `window` — so with the runner's `window = 2` a check
   * that has been healthy all week also reports 2, and one that just turned `ok`
   * after a breach reports 1.
   *
   * `no_data` breaks the streak like a failure does, and that is the point: a
   * cycle in which the check could not be measured is not evidence that it is
   * healthy. Counting it would be the project's oldest mistake — reading an
   * absence of data as a good reading — wearing a different hat.
   *
   * ## Why the alert layer needs this
   *
   * Production, 2026-08-26: `platform.offline_account_share` went
   * `breached (51,5%) → ok (50,0%) → breached (51,6%)` in under two hours, and
   * announced all three. With n≈32 arrivals a **single player** moves the ratio
   * by three points, so the check was reporting sampling noise as a state
   * change and the channel got three messages about nothing changing.
   *
   * A recovery confirmed over several cycles is a recovery; one observation is a
   * coin flip. This is what lets the policy tell them apart — see
   * `AlertPolicyInput.healthyStreak`.
   *
   * ## Two bounds, both erring toward silence
   *
   * The streak saturates at `window`, so the caller must pass at least the
   * threshold it intends to compare against — otherwise the recovery is starved
   * forever and, worse, `lastAlert` stays pinned to a failure that was fixed
   * long ago, so the channel is left believing a solved problem is still open.
   * The runner passes its own `confirmRecoveryAfter` for exactly this reason.
   *
   * Rows older than {@link STREAK_HORIZON_DAYS} are not read at all, which keeps
   * this from re-ranking an append-only table that has no retention policy. A
   * check whose rows are all older than the horizon is simply absent from the
   * result, and absent means streak 0 — held back, never a false all-clear.
   *
   * @param window how many recent rows per check to consider.
   */
  async healthyStreak(window = 10): Promise<Map<string, number>> {
    const result = await this.db.execute<{
      check_name: string;
      status: HealthCheckStatus;
      rn: number;
    }>(sql`
      SELECT check_name, status, rn FROM (
        SELECT
          ${healthChecks.checkName} AS check_name,
          ${healthChecks.status}    AS status,
          row_number() OVER (
            PARTITION BY ${healthChecks.checkName}
            ORDER BY ${healthChecks.checkedAt} DESC, ${healthChecks.id} DESC
          ) AS rn
        FROM ${healthChecks}
        WHERE ${healthChecks.checkedAt} > now() - ${sql.raw(`interval '${STREAK_HORIZON_DAYS} days'`)}
      ) ranked
      WHERE rn <= ${window}
      ORDER BY check_name, rn
    `);

    const streaks = new Map<string, number>();
    const broken = new Set<string>();

    for (const row of result.rows) {
      // Rows arrive newest-first per check. Once a non-`ok` verdict appears,
      // the streak for that check is closed and later (older) rows are ignored.
      if (broken.has(row.check_name)) {
        continue;
      }
      if (row.status !== 'ok') {
        broken.add(row.check_name);
        continue;
      }
      streaks.set(row.check_name, (streaks.get(row.check_name) ?? 0) + 1);
    }

    return streaks;
  }

  /** Recent verdicts of one check, newest first. */
  async history(checkName: string, limit = 50): Promise<HealthCheckRecord[]> {
    const rows = await this.db
      .select()
      .from(healthChecks)
      .where(eq(healthChecks.checkName, checkName))
      .orderBy(desc(healthChecks.checkedAt), desc(healthChecks.id))
      .limit(limit);

    return rows.map(toRecord);
  }

  /**
   * What this check last told Discord, or null if it never has.
   *
   * This is the input to alert grouping: a check that has been failing for three
   * months must not notify once per cycle, or the channel gets trained into
   * being ignored — which reproduces ADR-006's silence, only louder.
   *
   * The **status** travels with the timestamp because the alert policy compares
   * each verdict against what the channel was last told, not against the last
   * row written. Only rows whose message actually went out carry `alerted_at`,
   * so a recovery that was held back leaves this pointing at the failure that is
   * still, as far as anyone reading the channel knows, open.
   */
  async lastAlert(checkName: string): Promise<LastAlert | null> {
    const rows = await this.db
      .select({
        status: healthChecks.status,
        alertedAt: healthChecks.alertedAt,
      })
      .from(healthChecks)
      .where(
        and(
          eq(healthChecks.checkName, checkName),
          isNotNull(healthChecks.alertedAt),
        ),
      )
      // The tiebreak is not decoration: `markAlerted` stamps every row of a
      // cycle with the same `now()`, so two observations of one check announced
      // together tie exactly — and the winner decides which *status* the whole
      // policy compares against.
      .orderBy(desc(healthChecks.alertedAt), desc(healthChecks.id))
      .limit(1);

    const row = rows[0];
    return row?.alertedAt ? { status: row.status, at: row.alertedAt } : null;
  }

  /**
   * How many messages this check has had delivered inside the last `windowMs`.
   *
   * Counts stamped rows, not verdicts: the question is how much the channel has
   * heard about this check recently, which is the only thing a message budget
   * can sensibly be spent against. Bounded by `alerted_at`, which is stamped by
   * the database, so the count does not move with the application clock.
   */
  async alertsInWindow(checkName: string, windowMs: number): Promise<number> {
    const rows = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(healthChecks)
      .where(
        and(
          eq(healthChecks.checkName, checkName),
          isNotNull(healthChecks.alertedAt),
          gt(
            healthChecks.alertedAt,
            sql`now() - make_interval(secs => ${windowMs / 1000})`,
          ),
        ),
      );

    return rows[0]?.count ?? 0;
  }

  /**
   * Stamp `alerted_at` on rows whose notification has already been delivered.
   *
   * Called **after** the send succeeds, never before: a row marked as announced
   * when the webhook actually failed would suppress the retry and lose the alert
   * entirely.
   */
  async markAlerted(ids: readonly number[]): Promise<number> {
    if (ids.length === 0) {
      return 0;
    }

    const rows = await this.db
      .update(healthChecks)
      .set({ alertedAt: sql`now()` })
      .where(inArray(healthChecks.id, [...ids]))
      .returning({ id: healthChecks.id });

    return rows.length;
  }
}

/** Row shape returned by `db.execute` (snake_case, untyped by Drizzle). */
interface PersistedRow extends Record<string, unknown> {
  id: number;
  check_name: string;
  status: HealthCheckStatus;
  checked_at: Date | string;
  detail: HealthCheckDetail | null;
  alerted_at: Date | string | null;
}

function toRecord(row: typeof healthChecks.$inferSelect): HealthCheckRecord {
  return {
    id: row.id,
    checkName: row.checkName,
    status: row.status,
    checkedAt: row.checkedAt,
    detail: row.detail ?? null,
    alertedAt: row.alertedAt ?? null,
  };
}

function fromRawRow(row: PersistedRow): HealthCheckRecord {
  return {
    id: row.id,
    checkName: row.check_name,
    status: row.status,
    checkedAt: new Date(row.checked_at),
    detail: row.detail ?? null,
    alertedAt: row.alerted_at === null ? null : new Date(row.alerted_at),
  };
}
