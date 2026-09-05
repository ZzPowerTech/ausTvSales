import { Inject, Injectable, Logger } from '@nestjs/common';
import { count, desc, eq, sql, type SQL } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDB } from '../db/database.module';
import {
  type Suggestion,
  type SuggestionAuditEntry,
  type SuggestionStatus,
  suggestionAudit,
  suggestions,
} from '../db/schema';
import { sanitizeNickname, sanitizeSuggestionText } from './suggestion-text';
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
  /**
   * The actor's Discord **server nickname**, as the bot read it right now.
   *
   * **Required to approve**, and the DTO enforces that with a 400 rather than
   * accepting the move and dropping the credit. There is no second chance:
   * `aprovada` is not reachable twice and neither ending re-opens, so a
   * suggestion approved without a name stays uncredited until someone runs an
   * `UPDATE` by hand — which writes no audit row.
   *
   * The bot is the only party that can resolve it (this API holds no Discord
   * token), so the name travels with the action instead of being looked up.
   */
  actorNickname?: string;
}

/** One page of suggestions, plus the size of the whole filtered set. */
export interface SuggestionPage {
  items: Suggestion[];
  /**
   * How many rows match the filter, ignoring the page.
   *
   * Required by story S10.3 ("paginada, com **total**"), and it is a second
   * query rather than `items.length`: the two answer different questions, and a
   * listing that reports the page size as the total tells the reader the backlog
   * is exactly one page long no matter how long it is.
   */
  total: number;
  limit: number;
  offset: number;
}

/** Largest page the listing will return, whatever the caller asks for. */
export const SUGGESTION_PAGE_MAX = 25;

/** Page size when the caller does not choose one. */
export const SUGGESTION_PAGE_DEFAULT = 5;

/**
 * How a listing may be ordered (story S11.1, "ordena por data ou votos").
 *
 * A closed set rather than a free `orderBy` string: the column names are an
 * implementation detail, and an open sort parameter on a public route is both a
 * schema leak and an invitation to sort by something unindexed.
 */
export const SUGGESTION_SORTS = ['recent', 'votes'] as const;

export type SuggestionSort = (typeof SUGGESTION_SORTS)[number];

/**
 * The score a `votes` sort ranks by: upvotes minus downvotes.
 *
 * Net score and not `votes_up`, because the two answer different questions and
 * only one of them is "what do the players want most". A suggestion at 40/38 is
 * controversial, not popular, and ranking it above a quiet 12/0 would publish
 * the wrong claim on a public page.
 *
 * Computed, not stored: the tally is overwritten wholesale by
 * {@link SuggestionsStore.setVotesByDiscordMsgId}, so a materialized score would
 * be a second thing to keep in step with no reader that needs the speed.
 */
export const suggestionScore = sql<number>`(votes_up - votes_down)`;

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
   * Overwrite the vote tally of the suggestion posted as `discordMsgId`.
   *
   * Returns the updated row, or `null` when no suggestion came from that
   * message — which is the ordinary case, not a fault: players react to plenty
   * of messages in the suggestions channel that are not cards (R4.4).
   *
   * ## Keyed by message, not by id
   *
   * A reaction event carries the message id and nothing else. Resolving it to a
   * suggestion id first would make every reaction two round trips, and the
   * lookup would be the same `WHERE` this statement already does.
   *
   * ## One statement, and the race it does and does not remove
   *
   * No read, no transaction, no `FOR UPDATE` — unlike {@link transition}, which
   * needs all three because its decision depends on the state it read. This
   * write depends on nothing it read, so a read-modify-write here would
   * introduce a lost update where there is currently no update to lose.
   *
   * What it does **not** buy is ordering. The payload carries no version and no
   * sequence number, so the row ends up holding the tally that *arrived* last,
   * not the one the bot *computed* last. A slow request carrying the count at
   * t1 can commit after a fast one carrying t2, and the card is then one vote
   * behind Discord. The mitigation is D2's and not this method's: the value is
   * absolute, so the next event of any kind repairs it — and the residual cost,
   * stated rather than denied, is that if the reordered write was the **last**
   * event, there is no next one and the snapshot stays wrong until somebody
   * reacts again.
   *
   * A version column would close it. It is not here because a stale vote count
   * on a card is a cosmetic error with a self-healing path, and the ordering
   * machinery would be permanent.
   *
   * ## `updated_at` moves, and it should
   *
   * `$onUpdate` bumps it on every vote — so a replay of an identical payload is
   * idempotent in the tally but not a literal no-op in the row. That is honest:
   * the row was written. It is also why the column is documented as "last
   * changed" rather than "last decided", and after this route the honest reading
   * narrows further — "when this was last decided" is a question only the audit
   * trail answers now.
   *
   * Nothing reads it today: the listing orders by `created_at, id`, and no other
   * module in this repository selects the column. So a busy card does not climb
   * the backlog because people are voting on it, and the cost above is a
   * semantic one rather than a broken consumer.
   *
   * No audit row is written (R4.6). The trail exists for staff decisions; one
   * entry per player click would bury them under what the tally already sums up.
   */
  async setVotesByDiscordMsgId(input: {
    discordMsgId: string;
    votesUp: number;
    votesDown: number;
  }): Promise<Suggestion | null> {
    const [row] = await this.db
      .update(suggestions)
      .set({ votesUp: input.votesUp, votesDown: input.votesDown })
      .where(eq(suggestions.discordMsgId, input.discordMsgId))
      .returning();
    return row ?? null;
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

      // The approver is recorded on the transition **into** `aprovada`, and
      // only then. Whoever later moves it to `em_andamento` or `concluida` is
      // answering a different question — "who accepted this" has one answer, and
      // every actor is in the audit trail regardless.
      //
      // Written at most once, and that is a property of the machine rather than
      // of this branch: `aprovada` is not reachable twice, and both endings are
      // terminal with no re-open. So there is no later write to guard against.
      //
      // Sanitized here, like `text`, and for the sharper reason: this is the one
      // field written *in order to be published*. The bot escapes markdown on
      // render, which leaves bidi and invisible characters exactly where they
      // are — `U+202E` in a nickname reverses the credit line on a public page,
      // and escaping cannot undo that afterwards.
      const claiming =
        input.to === 'aprovada'
          ? {
              assignee: input.actor,
              assigneeNickname: sanitizeNickname(input.actorNickname),
            }
          : {};

      const [updated] = await tx
        .update(suggestions)
        .set({ status: input.to, ...claiming })
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
   *
   * The read and the write are **not** in one transaction, unlike
   * {@link transition}. Inert today, because nothing deletes a suggestion: the
   * row cannot vanish between the two statements. The day a delete path exists,
   * this becomes a foreign-key violation — a 500 where the caller deserved the
   * 404 the check above was written to produce.
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

  /**
   * One page of suggestions, newest first, optionally filtered by state.
   *
   * ## Pagination is not optional here
   *
   * There is no unpaginated variant, and `limit` is clamped rather than
   * trusted. The table grows without bound and the only consumers are a Discord
   * embed (25 components maximum) and, later, a web list — neither of which has
   * a use for "all of them", and both of which would happily ask for it.
   *
   * ## The unfiltered path has no index, and that is a decision with a threshold
   *
   * `suggestions_status_created_at_idx` serves a filtered listing. Without a
   * `status` — the bot's default — Postgres sorts the whole table and counts it
   * unindexed, twice per page click. Fine at the size this table will have for
   * years, and the fix is one index on `(created_at DESC, id DESC)` the day
   * `GET /suggestions` stops being sub-millisecond. Written down so that day is
   * recognised rather than discovered.
   *
   * ## Two reads, two snapshots
   *
   * The rows and the count are separate statements and share no transaction, so
   * under `READ COMMITTED` a write between them makes `total` describe one
   * instant and `items` another. Accepted rather than fixed: the visible cost is
   * a "next page" button enabled for a page that renders one row more or less,
   * and `REPEATABLE READ` is a steep price for a Discord listing.
   *
   * Offset pagination also drifts *between* requests — a suggestion posted while
   * someone reads page one pushes a row down into page two, where they see it
   * twice. The guarantee below is about the inside of one query, not about a
   * sequence of them.
   *
   * ## Ordering is total, whichever sort is asked for
   *
   * `created_at DESC, id DESC` by default; `score DESC, created_at DESC, id DESC`
   * for `sort: 'votes'`. Every ordering ends in `id DESC` and that is the load
   * bearing part: two suggestions can share a timestamp — the column stores the
   * event date, so a backfill or a burst can produce duplicates — and ties on
   * score are not the exception but the rule, since a fresh backlog is a wall of
   * `0/0`. A non-total order makes pages overlap or skip rows under Postgres,
   * which is free to break the tie differently per query. The `id` is the
   * tiebreaker precisely because it is unique.
   *
   * ## Neither sort is indexed for the unfiltered case
   *
   * The note above covers the date sort. The score sort is worse off: it orders
   * by an expression, so `suggestions_status_created_at_idx` cannot serve it
   * even when a `status` is given, and every page click sorts the filtered set.
   * Accepted at this table's size for the same reason, with the same escape
   * hatch named in advance — an index on `((votes_up - votes_down) DESC, id DESC)`
   * — and one addition: the public surface that uses this sort is rate limited
   * (see `publicReadThrottle`), so the cost is bounded per client rather than
   * left to whoever finds the URL.
   */
  async list(options: {
    status?: SuggestionStatus;
    limit?: number;
    offset?: number;
    sort?: SuggestionSort;
  }): Promise<SuggestionPage> {
    const limit = clampPageSize(options.limit);
    const offset = clampOffset(options.offset);
    const where = options.status
      ? eq(suggestions.status, options.status)
      : undefined;

    const [items, [totals]] = await Promise.all([
      this.db
        .select()
        .from(suggestions)
        .where(where)
        .orderBy(...orderFor(options.sort))
        .limit(limit)
        .offset(offset),
      this.db.select({ value: count() }).from(suggestions).where(where),
    ]);

    return { items, total: totals?.value ?? 0, limit, offset };
  }
}

/**
 * Page size the store will honour.
 *
 * Clamped, not validated: a DTO already rejects nonsense at the HTTP door, and
 * this is the guarantee for every other caller. A `limit` of 10.000 from a
 * future internal caller should return 25 rows, not a table scan.
 */
/**
 * Offset the store will honour.
 *
 * The mirror of {@link clampPageSize}, and it was missing. `Math.trunc` passes
 * `NaN` and `Infinity` straight through, and drizzle then either sends Postgres
 * something it rejects (`1e+21` → `invalid input syntax for type bigint`, a 500)
 * or emits no `OFFSET` at all — returning page one while the response reports an
 * offset that was never applied. The second is the worse of the two: a wrong
 * answer that looks like a right one.
 *
 * The HTTP door does not cover this either: `@IsInt()` is `Number.isInteger`,
 * and `Number.isInteger(1e21)` is `true`.
 */
function clampOffset(requested: number | undefined): number {
  if (requested === undefined || !Number.isFinite(requested)) return 0;
  const truncated = Math.trunc(requested);
  return Number.isSafeInteger(truncated) ? Math.max(0, truncated) : 0;
}

function clampPageSize(requested: number | undefined): number {
  if (requested === undefined || !Number.isFinite(requested)) {
    return SUGGESTION_PAGE_DEFAULT;
  }
  return Math.min(SUGGESTION_PAGE_MAX, Math.max(1, Math.trunc(requested)));
}

/**
 * The `ORDER BY` for one sort, always ending in a unique column.
 *
 * Separate from {@link SuggestionsStore.list} so the tie-breaking rule is one
 * thing a test can assert on directly, rather than a property that has to be
 * inferred from a query builder.
 */
function orderFor(sort: SuggestionSort | undefined): SQL[] {
  const tiebreak = [desc(suggestions.createdAt), desc(suggestions.id)];
  return sort === 'votes' ? [desc(suggestionScore), ...tiebreak] : tiebreak;
}
