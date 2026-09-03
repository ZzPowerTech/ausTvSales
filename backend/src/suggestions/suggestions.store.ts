import { Inject, Injectable, Logger } from '@nestjs/common';
import { desc, eq } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDB } from '../db/database.module';
import {
  type Suggestion,
  type SuggestionAuditEntry,
  type SuggestionStatus,
  suggestionAudit,
  suggestions,
} from '../db/schema';
import { sanitizeSuggestionText } from './suggestion-text';
import { canTransition, describeRefusal } from './suggestion-transitions';

/**
 * Everything needed to record a suggestion, and nothing the database decides.
 *
 * `status`, `votes*` and `updatedAt` are absent on purpose: the first two have
 * defaults that are correct for every new suggestion, and `updatedAt` genuinely
 * is the write time. `createdAt` is required because it is **not** the write
 * time — see the note on the column.
 */
export interface NewSuggestionInput {
  /** Id of the Discord message the suggestion came from. Natural key. */
  discordMsgId: string;
  /** Discord user id of the author. An identifier, never a display name (§8). */
  author: string;
  /** Raw player text. Sanitized here; the caller must not pre-clean it. */
  text: string;
  /** When the player posted it. Not defaulted, and not the insert time. */
  createdAt: Date;
}

/**
 * What a staff action asks for. `command` is carried on every one of them
 * because story S10.2 wants a denied attempt logged "with author and command" —
 * and an actor without the route they took is half an incident report.
 */
export interface StaffActionInput {
  /** Suggestion being acted upon. */
  id: number;
  /** Discord user id of the staff member. */
  actor: string;
  /** Bot command name or component custom id that produced the attempt. */
  command: string;
}

/** Result of {@link SuggestionsStore.transition}. */
export type TransitionOutcome =
  | { ok: true; suggestion: Suggestion }
  | { ok: false; reason: 'not_found' }
  | {
      ok: false;
      reason: 'invalid_transition';
      /** State the suggestion is actually in. */
      current: SuggestionStatus;
      /** Player-facing explanation, naming what *is* allowed. */
      message: string;
    };

/**
 * The write path for player suggestions (spec §7, story S10.1).
 *
 * ## Why sanitization lives here and not in a DTO
 *
 * A DTO only guards the HTTP door. This table has more than one writer by
 * design — the Discord bot raises suggestions, the API (S11.1) edits them — and
 * a rule that lives at one door is not a rule. Putting it on the single
 * insert means "sanitized on write" is a property of the table rather than a
 * habit of its callers.
 *
 * The database backs this up independently: `suggestions_text_present` and
 * `suggestions_text_max_length` reject the two failures that matter even if some
 * future path skips this class entirely.
 */
@Injectable()
export class SuggestionsStore {
  private readonly logger = new Logger(SuggestionsStore.name);

  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDB) {}

  /**
   * Insert one suggestion, sanitizing its text first.
   *
   * Idempotent by `discord_msg_id`: a bot that replays the same Discord message
   * — reconnect, restart, double dispatch — gets the row it already wrote back
   * instead of a duplicate or a unique-violation crash. The stored text is *not*
   * overwritten on conflict, because the first write is the one that matches
   * what the players voting on it read.
   *
   * @throws {SuggestionTextError} if the text cannot be stored (see
   *   {@link sanitizeSuggestionText}). The row is not written.
   */
  async create(input: NewSuggestionInput): Promise<Suggestion> {
    const text = sanitizeSuggestionText(input.text);

    const [row] = await this.db
      .insert(suggestions)
      .values({
        discordMsgId: input.discordMsgId,
        author: input.author,
        text,
        createdAt: input.createdAt,
      })
      .onConflictDoNothing({ target: suggestions.discordMsgId })
      .returning();

    if (row) return row;

    // `onConflictDoNothing` returns no row when the suggestion already exists.
    // Reading it back is the honest answer to "record this suggestion": the
    // caller asked for it to exist, and it does.
    this.logger.debug(
      `Suggestion for message ${input.discordMsgId} already recorded`,
    );
    const existing = await this.getByDiscordMsgId(input.discordMsgId);
    if (existing) return existing;

    // No row inserted and no row present: the conflicting row was removed
    // between the two statements. Rare, but returning a fabricated row — or
    // casting the `null` away — would hand the caller a suggestion that does
    // not exist.
    throw new Error(
      `Suggestion for message ${input.discordMsgId} was neither inserted nor found`,
    );
  }

  /** One suggestion by the Discord message it came from, or `null`. */
  async getByDiscordMsgId(discordMsgId: string): Promise<Suggestion | null> {
    // The plain select builder, not `db.query.suggestions` — the relational
    // query builder's callback types resolve `SQL` through a second module
    // instance and `nest build` rejects the result.
    const rows = await this.db
      .select()
      .from(suggestions)
      .where(eq(suggestions.discordMsgId, discordMsgId))
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * Move one suggestion to `to`, if the state machine allows it.
   *
   * ## "Refused without altering the record", literally
   *
   * The read, the decision and the write happen in one transaction, with the
   * row held by `FOR UPDATE`. Two staff members pressing buttons at the same
   * moment therefore serialize: the second one decides against the state the
   * first one left behind, not against the state it saw when it rendered.
   *
   * Without the lock this would be check-then-act, and the failure is not
   * theoretical — it is `aprovada` and `recusada` both landing on the same
   * suggestion, each having been legal at the instant it was checked.
   *
   * A refused transition still **commits**: the suggestion is untouched and an
   * `transition_denied` row is written. That is the point of recording refusals
   * — an audit trail that only holds what succeeded cannot answer who has been
   * trying what.
   */
  async transition(
    input: StaffActionInput & { to: SuggestionStatus },
  ): Promise<TransitionOutcome> {
    return this.db.transaction(async (tx) => {
      const [current] = await tx
        .select()
        .from(suggestions)
        .where(eq(suggestions.id, input.id))
        .for('update');

      if (!current) return { ok: false, reason: 'not_found' };

      if (!canTransition(current.status, input.to)) {
        const message = describeRefusal(current.status, input.to);
        await tx.insert(suggestionAudit).values({
          suggestionId: current.id,
          actor: input.actor,
          action: 'transition_denied',
          fromStatus: current.status,
          toStatus: input.to,
          command: input.command,
          reason: message,
        });
        this.logger.warn(
          `Refused ${current.status} -> ${input.to} on suggestion ${input.id} by ${input.actor} via ${input.command}`,
        );
        return {
          ok: false,
          reason: 'invalid_transition',
          current: current.status,
          message,
        };
      }

      const [updated] = await tx
        .update(suggestions)
        .set({ status: input.to })
        .where(eq(suggestions.id, input.id))
        .returning();

      await tx.insert(suggestionAudit).values({
        suggestionId: input.id,
        actor: input.actor,
        action: 'transition',
        fromStatus: current.status,
        toStatus: input.to,
        command: input.command,
      });

      return { ok: true, suggestion: updated };
    });
  }

  /**
   * Record an attempt the **bot** refused before it ever got here.
   *
   * The staff-role check has to happen where the Discord roles are, which is the
   * bot. That makes the refusal invisible to this database unless the bot
   * reports it — and a refusal nobody can query is the `sendTicketLog` problem
   * again, one layer up.
   *
   * Returns `false` when the suggestion does not exist. No row is written in
   * that case: the trail is joined to real suggestions, and an orphan attempt
   * belongs in the log, not in a table that cannot represent it.
   */
  async recordAuthDenied(
    input: StaffActionInput & { reason: string },
  ): Promise<boolean> {
    const [current] = await this.db
      .select({ status: suggestions.status })
      .from(suggestions)
      .where(eq(suggestions.id, input.id));

    if (!current) return false;

    await this.db.insert(suggestionAudit).values({
      suggestionId: input.id,
      actor: input.actor,
      action: 'auth_denied',
      fromStatus: current.status,
      command: input.command,
      reason: input.reason,
    });
    this.logger.warn(
      `Bot refused ${input.actor} on suggestion ${input.id} via ${input.command}: ${input.reason}`,
    );
    return true;
  }

  /** One suggestion by id, or `null`. */
  async getById(id: number): Promise<Suggestion | null> {
    const rows = await this.db
      .select()
      .from(suggestions)
      .where(eq(suggestions.id, id))
      .limit(1);
    return rows[0] ?? null;
  }

  /** This suggestion's audit trail, newest first. */
  async auditFor(
    suggestionId: number,
    limit = 50,
  ): Promise<SuggestionAuditEntry[]> {
    return this.db
      .select()
      .from(suggestionAudit)
      .where(eq(suggestionAudit.suggestionId, suggestionId))
      .orderBy(desc(suggestionAudit.at))
      .limit(limit);
  }
}
