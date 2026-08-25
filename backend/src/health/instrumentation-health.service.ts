import { Injectable } from '@nestjs/common';
import {
  HealthCheckScheduler,
  type HealthCheckSchedule,
} from '../instrumentation/health-check.scheduler';
import { HealthCheckStore } from '../instrumentation/health-check.store';
import {
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
 * itself is not alive — the scheduler switched off, or the last verdict older
 * than {@link MISSED_CYCLES_BEFORE_STALE} intervals. A health endpoint that
 * answers `ok` because it has no bad news to report is the exact failure this
 * epic was built to remove: three months of a dead proxy looked like silence,
 * and silence looked like health.
 */
@Injectable()
export class InstrumentationHealthService {
  constructor(
    private readonly store: HealthCheckStore,
    private readonly scheduler: HealthCheckScheduler,
  ) {}

  /** Aggregate verdict, shaped for an external uptime probe. */
  async summary(now: Date = new Date()): Promise<InstrumentationSummaryDto> {
    const records = await this.store.latestAll();
    const schedule = this.scheduler.schedule;
    const staleAfterMinutes =
      schedule.intervalMinutes * MISSED_CYCLES_BEFORE_STALE;

    const counts = tally(records.map((record) => record.status));
    const lastCheckedAt = latestTimestamp(records);
    const stale = isStale(lastCheckedAt, schedule, staleAfterMinutes, now);

    return {
      status: resolveStatus(records.length, stale, counts),
      stale,
      lastCheckedAt: lastCheckedAt?.toISOString() ?? null,
      total: records.length,
      counts,
      failing: records
        .filter((record) => record.status !== 'ok')
        .map((record) => record.checkName)
        .sort(),
      schedule: { ...schedule, staleAfterMinutes },
    };
  }

  /** Current verdict of every check that has ever run, newest state per name. */
  async checks(): Promise<HealthCheckListDto> {
    const records = await this.store.latestAll();
    const checks = records.map(toView);
    // Sorted by name so a diff between two polls reflects a change of state and
    // not the order Postgres happened to return the rows in.
    checks.sort((a, b) => a.name.localeCompare(b.name));

    return { count: checks.length, checks };
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
      entries: records.map(toView),
    };
  }
}

function toView(record: HealthCheckRecord): HealthCheckViewDto {
  const { name, target } = parseCheckName(record.checkName);

  return {
    name: record.checkName,
    check: name,
    target,
    status: record.status,
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

function latestTimestamp(records: readonly HealthCheckRecord[]): Date | null {
  let latest: Date | null = null;
  for (const record of records) {
    if (latest === null || record.checkedAt > latest) {
      latest = record.checkedAt;
    }
  }
  return latest;
}

function isStale(
  lastCheckedAt: Date | null,
  schedule: HealthCheckSchedule,
  staleAfterMinutes: number,
  now: Date,
): boolean {
  if (!schedule.enabled) {
    // Nothing is running, so whatever is stored is a photograph of the past. It
    // does not matter how recent it is.
    return true;
  }
  if (lastCheckedAt === null) {
    return true;
  }
  return now.getTime() - lastCheckedAt.getTime() > staleAfterMinutes * 60_000;
}

function resolveStatus(
  total: number,
  stale: boolean,
  counts: Record<HealthCheckStatus, number>,
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
  if (counts.breached > 0 || counts.no_data > 0) {
    return 'degraded';
  }
  return 'ok';
}
