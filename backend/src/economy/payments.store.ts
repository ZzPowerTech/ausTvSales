import { Inject, Injectable } from '@nestjs/common';
import { desc, eq, gte, sql } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDB } from '../db/database.module';
import {
  accountCreationsDaily,
  playerPaymentSyncs,
  playerPayments,
} from '../db/schema';
import type { KeyedPayment } from './payment-key';

/** Rows written per statement — see the note in `PlayerDimensionStore`. */
const CHUNK_SIZE = 500;

/** One payment as it comes back from Postgres. */
export interface StoredPayment {
  transactionType: string;
  source: string;
  receiver: string;
  amount: number;
  occurredAt: Date;
  ordinal: number;
}

/** One day of the arrivals series. */
export type CreationDay = {
  day: string;
  created: number;
};

/** Provenance of one run, as read back. */
export interface PaymentSyncRecord {
  id: number;
  ranAt: Date;
  status: 'ok' | 'error';
  paymentsRead: number | null;
  paymentsWritten: number | null;
  senderRows: number | null;
  receiverRows: number | null;
  creationsRead: number | null;
  creationDaysWritten: number | null;
  durationMs: number | null;
  sourceQueryMs: number | null;
  detail: string | null;
}

/** What a successful run records. */
export interface SuccessfulPaymentSync {
  paymentsRead: number;
  paymentsWritten: number;
  senderRows: number;
  receiverRows: number;
  creationsRead: number;
  creationDaysWritten: number;
  durationMs: number;
  sourceQueryMs: number;
}

/**
 * Persistence of the PlayerPoints copy (story S9.1).
 *
 * Payments are **upserted, never deleted**: an absent row upstream is far more
 * often a degraded read than a real deletion, and this domain has no update path
 * that would produce one. The arrivals series is **replaced**, because it is a
 * recount of a log rather than an accumulation — the same shape `tutorial_daily`
 * uses, for the same reason.
 */
@Injectable()
export class PaymentsStore {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDB) {}

  /** Upsert every payment, in chunks. Returns how many were written. */
  async upsertPayments(payments: readonly KeyedPayment[]): Promise<number> {
    let written = 0;

    for (let i = 0; i < payments.length; i += CHUNK_SIZE) {
      const chunk = payments.slice(i, i + CHUNK_SIZE);
      await this.db
        .insert(playerPayments)
        .values(
          chunk.map((payment) => ({
            transactionType: payment.transactionType,
            source: payment.source,
            receiver: payment.receiver,
            amount: payment.amount,
            occurredAt: new Date(payment.occurredAt),
            ordinal: payment.ordinal,
            syncedAt: new Date(),
          })),
        )
        // The composite key is the whole row minus `synced_at`, so a re-read
        // updates nothing but the timestamp — which is what makes a second run
        // observably a no-op rather than merely harmless.
        .onConflictDoUpdate({
          target: [
            playerPayments.transactionType,
            playerPayments.source,
            playerPayments.receiver,
            playerPayments.amount,
            playerPayments.occurredAt,
            playerPayments.ordinal,
          ],
          set: { syncedAt: sql`excluded.synced_at` },
        });
      written += chunk.length;
    }

    return written;
  }

  /**
   * Replace the arrivals series with `days`.
   *
   * Delete-then-insert inside one transaction: a failure between the two would
   * otherwise leave the series empty, which reads as "nobody ever created an
   * account" — the exact shape of manufactured measurement this project refuses.
   */
  async replaceCreations(days: readonly CreationDay[]): Promise<number> {
    await this.db.transaction(async (tx) => {
      await tx.delete(accountCreationsDaily);
      for (let i = 0; i < days.length; i += CHUNK_SIZE) {
        const chunk = days.slice(i, i + CHUNK_SIZE);
        if (chunk.length > 0) {
          await tx.insert(accountCreationsDaily).values([...chunk]);
        }
      }
    });

    return days.length;
  }

  /** Payments in a window, newest first, capped by the caller. */
  async paymentsSince(since: Date, limit: number): Promise<StoredPayment[]> {
    const rows = await this.db
      .select()
      .from(playerPayments)
      .where(gte(playerPayments.occurredAt, since))
      .orderBy(desc(playerPayments.occurredAt))
      .limit(limit);

    return rows.map((row) => ({
      transactionType: row.transactionType,
      source: row.source,
      receiver: row.receiver,
      amount: row.amount,
      occurredAt: row.occurredAt,
      ordinal: row.ordinal,
    }));
  }

  /** Every payment since `since`, unbounded — used by the social aggregation. */
  async allPaymentsSince(since: Date): Promise<StoredPayment[]> {
    return this.paymentsSince(since, Number.MAX_SAFE_INTEGER);
  }

  /** The arrivals series between two days, inclusive. */
  async creations(from: string, to: string): Promise<CreationDay[]> {
    const result = await this.db.execute<CreationDay>(sql`
      SELECT to_char(${accountCreationsDaily.day}, 'YYYY-MM-DD') AS day,
             ${accountCreationsDaily.created} AS created
        FROM ${accountCreationsDaily}
       WHERE ${accountCreationsDaily.day} BETWEEN ${from}::date AND ${to}::date
       ORDER BY 1 ASC
    `);
    return result.rows;
  }

  async recordSuccess(run: SuccessfulPaymentSync): Promise<void> {
    await this.db.insert(playerPaymentSyncs).values({ status: 'ok', ...run });
  }

  async recordFailure(run: {
    detail: string;
    durationMs?: number;
    sourceQueryMs?: number;
  }): Promise<void> {
    await this.db.insert(playerPaymentSyncs).values({
      status: 'error',
      detail: run.detail,
      durationMs: run.durationMs ?? null,
      sourceQueryMs: run.sourceQueryMs ?? null,
    });
  }

  /**
   * The most recent **successful** run, or null when none exists.
   *
   * Consulted before every social read: an empty payments table and a table
   * nobody ever filled produce the same query result, and reading the second as
   * the first is how a collection gap becomes a reported zero.
   */
  async lastSuccessfulSync(): Promise<PaymentSyncRecord | null> {
    const [row] = await this.db
      .select()
      .from(playerPaymentSyncs)
      .where(eq(playerPaymentSyncs.status, 'ok'))
      .orderBy(desc(playerPaymentSyncs.ranAt), desc(playerPaymentSyncs.id))
      .limit(1);

    return row ?? null;
  }
}
