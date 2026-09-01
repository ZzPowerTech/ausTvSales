import { Inject, Injectable } from '@nestjs/common';
import {
  HEALTH_CHECKS,
  type HealthCheck,
} from '../instrumentation/health-check.contract';
import {
  HealthCheckScheduler,
  type HealthCheckSchedule,
} from '../instrumentation/health-check.scheduler';
import { HealthCheckStore } from '../instrumentation/health-check.store';
import {
  isAcceptedBlindSpot,
  parseCheckName,
  type HealthCheckRecord,
  type HealthCheckStatus,
} from '../instrumentation/health-check.types';
import type { InstrumentationStatus } from './dto/instrumentation-health.dto';
import type {
  HealthCheckHistoryDto,
  HealthCheckListDto,
  HealthCheckViewDto,
  InstrumentationSummaryDto,
} from './dto/instrumentation-health.dto';

/**
 * How many cycles a check may miss before the layer is considered blind.
 *
 * Two rather than one: a single skipped tick is normal — the runner stands down
 * when a previous cycle is still in flight against a slow Plan — and reporting
 * an outage for that would train the operator to ignore this endpoint, which is
 * the same ending ADR-006 exists to prevent.
 */
export const MISSED_CYCLES_BEFORE_STALE = 2;

/**
 * Read model over the instrumentation-health verdicts (story S7.1, issue #110).
 *
 * ## What this adds to S6.3, and what it deliberately does not
 *
 * The Discord alert of S6.3 is what stops the blindness; this is the on-demand
 * read of the same records. That ordering matters: if this module had come first
 * it would have been a page somebody has to remember to open, which is precisely
 * the posture ADR-006 rejects.
 *
 * There is **no** endpoint to trigger a cycle. A cycle is one HTTP request per
 * configured server against the Plan on the game VPS, and spec §8 lists "query
 * pesada afeta o jogo" as a real risk. An authenticated button that hammers the
 * game server is not an ops convenience, it is a foot-gun with a login.
 *
 * ## `ok` is never the default answer
 *
 * The aggregate is `unknown` when nothing has ever run and `down` when the cycle
 * itself is not alive — the scheduler switched off, or a verdict older than
 * {@link MISSED_CYCLES_BEFORE_STALE} intervals. A health endpoint that answers
 * `ok` because it has no bad news to report is the exact failure this epic was
 * built to remove: three months of a dead proxy looked like silence, and silence
 * looked like health.
 *
 * ## Freshness is the OLDEST check, not the newest
 *
 * The first version of this service derived staleness from the newest row across
 * the whole set, which answers "has *anything* run recently" and not "is *every*
 * check still running". Those two differ in exactly the case this endpoint
 * exists for: a check that goes quiet keeps its last row forever, contributes a
 * stale `ok` to the counts, and is masked by any sibling that is still writing.
 *
 * Not hypothetical here. `CollectionAliveCheck` and `NetworkToSurvivalCheck`
 * return no observations at all when `PLAN_SERVERS` lists no backends, so
 * renaming a server during a deploy freezes them at their last verdict while the
 * MySQL-backed checks keep reporting. Under a `max` the summary stays green and
 * fresh — the founding disaster of this epic one level up, since the proxy also
 * died *while everything else kept working*.
 *
 * So `stale` comes from the oldest of the newest-per-check rows, and both
 * `lastCheckedAt` and `oldestCheckedAt` are published, so the spread is visible
 * instead of collapsed into one reassuring number.
 *
 * ## A check that never ran is invisible unless we look for it
 *
 * `latestAll()` can only report names that have written a row at least once, so
 * a registered check that never produced a verdict appears in neither `total`,
 * `counts` nor `failing` — it is absent, and absence reads as fine. The registry
 * is therefore injected and compared against what the store holds, and the
 * difference is published as `missing`.
 *
 * Same shape as the `plan.orphan_instance` check itself: a thing that should be
 * reporting and is not.
 *
 * ## A check that can never measure is excluded from the verdict, not hidden
 *
 * `resolveStatus` reports `degraded` while any check is `no_data`, which is right
 * for a window that came back empty and wrong for a check whose source does not
 * exist. `funnel.network_to_survival` is the second kind: it returns `no_data`
 * every cycle, forever, so before this exclusion the aggregate could never read
 * `ok` again — and, worse, a **second** check going bad would not have moved it.
 * A status pinned at one value has stopped carrying information, which is the
 * failure of this epic wearing a yellow light instead of a green one.
 *
 * So the records of {@link ACCEPTED_BLIND_SPOTS} are left out of `counts` and
 * `failing`, and published by name in `blindSpots` instead. Left out, **not
 * dropped**: a blind spot missing from the payload altogether would read as
 * fine, which is the mistake the paragraph above this one exists to prevent.
 * They stay in `total`, in `reporting` and in the staleness window, because they
 * genuinely are registered, reporting and fresh.
 */
@Injectable()
export class InstrumentationHealthService {
  constructor(
    private readonly store: HealthCheckStore,
    private readonly scheduler: HealthCheckScheduler,
    @Inject(HEALTH_CHECKS) private readonly registry: readonly HealthCheck[],
  ) {}

  /** Aggregate verdict, shaped for an external uptime probe. */
  async summary(now: Date = new Date()): Promise<InstrumentationSummaryDto> {
    const records = await this.store.latestAll();
    const schedule = this.scheduler.schedule;
    const staleAfterMinutes =
      schedule.intervalMinutes * MISSED_CYCLES_BEFORE_STALE;
    const cutoff = staleCutoff(schedule, staleAfterMinutes, now);

    // Partitioned before anything is tallied. A blind spot is a check that
    // cannot measure by decision, not a check that is failing, and counting it
    // as either would make this endpoint answer a question nobody asked.
    const measuring = records.filter(
      (record) => !isAcceptedBlindSpot(record.checkName),
    );
    const blindSpots = records
      .filter((record) => isAcceptedBlindSpot(record.checkName))
      .map((record) => record.checkName)
      .sort();

    const counts = tally(measuring.map((record) => record.status));
    const staleChecks = records
      .filter((record) => isStale(record.checkedAt, cutoff))
      .map((record) => record.checkName)
      .sort();
    // One silent check is enough. That is the entire reason this looks at the
    // oldest verdict rather than the newest.
    const stale = records.length === 0 || staleChecks.length > 0;
    const missing = this.missing(records);
    const { newest, oldest } = bounds(records);

    return {
      status: resolveStatus(measuring.length, stale, counts, {
        missing: missing.length,
        // Base names, not rows: one registered check emits several scoped
        // observations, so counting rows here would compare two different
        // things and fire the majority rule at the wrong moment.
        //
        // Every record, blind spots included: this counter answers "how much of
        // the registry is writing rows at all", and a blind spot writes them.
        // Excluding it here would push the majority rule toward `down` for a
        // check that is behaving exactly as intended.
        reporting: new Set(
          records.map((record) => parseCheckName(record.checkName).name),
        ).size,
      }),
      stale,
      lastCheckedAt: newest?.toISOString() ?? null,
      oldestCheckedAt: oldest?.toISOString() ?? null,
      total: records.length,
      counts,
      failing: measuring
        .filter((record) => record.status !== 'ok')
        .map((record) => record.checkName)
        .sort(),
      staleChecks,
      blindSpots,
      missing,
      schedule: { ...schedule, staleAfterMinutes },
    };
  }

  /** Current verdict of every check that has ever run, newest state per name. */
  async checks(now: Date = new Date()): Promise<HealthCheckListDto> {
    const records = await this.store.latestAll();
    const schedule = this.scheduler.schedule;
    const cutoff = staleCutoff(
      schedule,
      schedule.intervalMinutes * MISSED_CYCLES_BEFORE_STALE,
      now,
    );

    const checks = records.map((record) =>
      toView(record, isStale(record.checkedAt, cutoff)),
    );
    // Sorted by name so a diff between two polls reflects a change of state and
    // not the order Postgres happened to return the rows in.
    checks.sort((a, b) => a.name.localeCompare(b.name));

    return { count: checks.length, checks };
  }

  /**
   * Registered checks with no stored verdict at all.
   *
   * Compared on the **base** name, because one registered check can emit several
   * scoped observations (`plan.collection_alive:Survival`), and counting rows
   * against registrations would be comparing two different things.
   */
  private missing(records: readonly HealthCheckRecord[]): string[] {
    const present = new Set(
      records.map((record) => parseCheckName(record.checkName).name),
    );
    return this.registry
      .map((check) => check.name)
      .filter((name) => !present.has(name))
      .sort();
  }

  /**
   * Recent verdicts of one check, newest first.
   *
   * The history is the whole point of `health_checks` being append-only: ADR-006
   * exists because nobody could answer "since when has this been broken?", and a
   * current-state endpoint alone still cannot answer it.
   */
  async history(name: string, limit: number): Promise<HealthCheckHistoryDto> {
    const records = await this.store.history(name, limit);

    return {
      name,
      limit,
      count: records.length,
      // History rows are never marked stale: every entry but the first is
      // *meant* to be old. Staleness is a property of the newest verdict, and
      // flagging a three-week-old historical row would say nothing at all.
      entries: records.map((record) => toView(record, false)),
    };
  }
}

function toView(record: HealthCheckRecord, stale: boolean): HealthCheckViewDto {
  const { name, target } = parseCheckName(record.checkName);

  return {
    name: record.checkName,
    check: name,
    target,
    status: record.status,
    stale,
    // Machine-readable, because the summary endpoint already publishes the same
    // fact in `blindSpots` and the two views must not disagree. Without it, this
    // row is byte-identical in shape to a check that came back `no_data` for one
    // quiet window, and the only thing separating them is 656 characters of
    // prose inside `detail.summary` — which the S12 dashboard would have to
    // substring-match to render them differently.
    blindSpot: isAcceptedBlindSpot(record.checkName),
    checkedAt: record.checkedAt.toISOString(),
    alertedAt: record.alertedAt?.toISOString() ?? null,
    detail: record.detail,
  };
}

function tally(
  statuses: readonly HealthCheckStatus[],
): Record<HealthCheckStatus, number> {
  const counts: Record<HealthCheckStatus, number> = {
    ok: 0,
    breached: 0,
    no_data: 0,
    error: 0,
  };
  for (const status of statuses) {
    counts[status] += 1;
  }
  return counts;
}

/** Both ends of the freshness spread, in one pass. */
function bounds(records: readonly HealthCheckRecord[]): {
  newest: Date | null;
  oldest: Date | null;
} {
  let newest: Date | null = null;
  let oldest: Date | null = null;

  for (const record of records) {
    if (newest === null || record.checkedAt > newest) {
      newest = record.checkedAt;
    }
    if (oldest === null || record.checkedAt < oldest) {
      oldest = record.checkedAt;
    }
  }

  return { newest, oldest };
}

/**
 * The instant before which a verdict counts as stale, or `null` when every
 * verdict is stale no matter its timestamp.
 *
 * `null` when the scheduler is off: nothing is running, so what is stored is a
 * photograph of the past, and how recent the photograph is does not make the
 * layer alive.
 *
 * ## Two clocks, and why comparing them is still safe here
 *
 * `checked_at` is stamped by Postgres — `HealthCheckStore` does that on purpose,
 * so the ordering the history depends on cannot be scrambled by skew between the
 * API container and the database — while `now` comes from the container.
 * Comparing them therefore crosses clocks, and skew moves the verdict in both
 * directions.
 *
 * Tolerable because the tolerance absorbs it: the default window is 30 minutes
 * (two 15-minute cycles) and skew between two hosts of one deployment is
 * seconds. If the window is ever tightened toward that magnitude, this has to
 * move into the database (`now() - max(checked_at)`) instead of being reasoned
 * about again.
 */
function staleCutoff(
  schedule: HealthCheckSchedule,
  staleAfterMinutes: number,
  now: Date,
): Date | null {
  if (!schedule.enabled) {
    return null;
  }
  return new Date(now.getTime() - staleAfterMinutes * 60_000);
}

function isStale(checkedAt: Date, cutoff: Date | null): boolean {
  return cutoff === null || checkedAt < cutoff;
}

/** How much of the registry is silent, for the majority rule below. */
interface RegistryCoverage {
  /** Registered base names with no stored verdict at all. */
  missing: number;
  /** Registered base names that do have one. */
  reporting: number;
}

function resolveStatus(
  total: number,
  stale: boolean,
  counts: Record<HealthCheckStatus, number>,
  coverage: RegistryCoverage,
): InstrumentationStatus {
  if (total === 0) {
    // Never measured is not healthy and it is not broken either. Saying `ok`
    // here would be an assertion about a game network nobody has looked at.
    return 'unknown';
  }
  if (stale || counts.error > 0) {
    // Either the cycle is not alive, or a check could not reach its source. Both
    // mean the same thing to a reader: we are not measuring right now.
    return 'down';
  }
  if (coverage.missing > coverage.reporting) {
    // ## The asymmetry this rule exists to correct
    //
    // A check that ran once and went quiet lands in `staleChecks` and makes the
    // layer `down`. A check that **never** ran was only `degraded` — even though
    // it is strictly worse: no history, no baseline, and blind since day one
    // rather than since a moment somebody can locate.
    //
    // Escalating on every missing check would be wrong in the other direction: a
    // staging box with no `PLAN_SERVERS` would sit permanently red, which is the
    // alert fatigue `MISSED_CYCLES_BEFORE_STALE` was calibrated against. So the
    // line is a strict majority: `>` and not `>=`, because half the registry
    // silent is a plausible partial setup, while more silent than reporting is
    // blindness with a green light on it. One unconfigured check stays
    // `degraded` and says so in `missing`.
    return 'down';
  }
  if (counts.breached > 0 || counts.no_data > 0 || coverage.missing > 0) {
    // A registered check with no verdict at all is not a smaller problem than a
    // breached one: part of the layer is not measuring, and it is the part
    // nobody would notice, because absence reads as fine.
    return 'degraded';
  }
  return 'ok';
}
