import { Inject, Injectable } from '@nestjs/common';
import { desc, eq } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDB } from '../db/database.module';
import { weeklyReports } from '../db/schema';
import type { WeeklyReport, WeeklyReportRecord } from './weekly-report.types';

/** What a successful run persists. */
export interface StoredRun {
  periodFrom: string;
  periodTo: string;
  payload: WeeklyReport;
  rendered: string;
}

/** What a failed run persists. */
export interface StoredFailure {
  periodFrom: string;
  periodTo: string;
  detail: string;
  /** The failure notice as it was rendered for the channel. */
  rendered: string;
}

/**
 * Persistence of generated weekly reports (story S9.2, criterion 4).
 *
 * Append-only. Every run writes a row, including the ones that failed — that is
 * what makes "the job is broken" different from "the week was quiet", and the
 * inability to tell those apart is what let the proxy sit dead for three months.
 *
 * A **missing** row for a week therefore means something specific: the scheduler
 * itself never fired. Nothing inside this process can write that fact down, so
 * it is the one failure mode the table cannot record — which is precisely why
 * `instrumentation.schedule.enabled` is printed in the report body every week.
 */
@Injectable()
export class WeeklyReportStore {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDB) {}

  async recordSuccess(run: StoredRun): Promise<WeeklyReportRecord> {
    const [row] = await this.db
      .insert(weeklyReports)
      .values({
        periodFrom: run.periodFrom,
        periodTo: run.periodTo,
        status: 'ok',
        payload: run.payload as unknown as Record<string, unknown>,
        rendered: run.rendered,
        delivered: false,
      })
      .returning();

    return toRecord(row);
  }

  async recordFailure(failure: StoredFailure): Promise<WeeklyReportRecord> {
    const [row] = await this.db
      .insert(weeklyReports)
      .values({
        periodFrom: failure.periodFrom,
        periodTo: failure.periodTo,
        status: 'error',
        payload: null,
        rendered: failure.rendered,
        delivered: false,
        detail: failure.detail,
      })
      .returning();

    return toRecord(row);
  }

  /**
   * Stamp a row as delivered.
   *
   * A separate write rather than a field set at insert time, and the ordering is
   * the point: the report is stored **before** anyone tries to send it. A
   * webhook outage then loses the message and keeps the content, instead of
   * losing both.
   */
  async markDelivered(id: number): Promise<void> {
    await this.db
      .update(weeklyReports)
      .set({ delivered: true })
      .where(eq(weeklyReports.id, id));
  }

  /** The most recent run, whatever its status. Null when none exists. */
  async latest(): Promise<WeeklyReportRecord | null> {
    const [row] = await this.db
      .select()
      .from(weeklyReports)
      .orderBy(desc(weeklyReports.generatedAt), desc(weeklyReports.id))
      .limit(1);

    return row === undefined ? null : toRecord(row);
  }

  /** One run by id. Null when it does not exist. */
  async byId(id: number): Promise<WeeklyReportRecord | null> {
    const [row] = await this.db
      .select()
      .from(weeklyReports)
      .where(eq(weeklyReports.id, id))
      .limit(1);

    return row === undefined ? null : toRecord(row);
  }

  /** Newest first, capped by the caller. */
  async recent(limit: number): Promise<WeeklyReportRecord[]> {
    const rows = await this.db
      .select()
      .from(weeklyReports)
      .orderBy(desc(weeklyReports.generatedAt), desc(weeklyReports.id))
      .limit(limit);

    return rows.map(toRecord);
  }
}

function toRecord(row: typeof weeklyReports.$inferSelect): WeeklyReportRecord {
  return {
    id: row.id,
    generatedAt: row.generatedAt,
    periodFrom: row.periodFrom,
    periodTo: row.periodTo,
    status: row.status,
    // ⚠️ An unvalidated cast over a JSON column, so a row written by an older
    // version does not necessarily satisfy the current `WeeklyReport` — rows
    // from before `contaminatedSpans` existed have no such field, and the type
    // says they do. Nothing renders from here (the delivered text is served from
    // `rendered`), so there is no crash path; a consumer reading `payload` off
    // the recents endpoint is the one that has to expect gaps.
    payload: (row.payload as WeeklyReport | null) ?? null,
    rendered: row.rendered,
    delivered: row.delivered,
    detail: row.detail,
  };
}
