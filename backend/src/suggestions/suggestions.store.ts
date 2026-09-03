import { Inject, Injectable, Logger } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDB } from '../db/database.module';
import { type Suggestion, suggestions } from '../db/schema';
import { sanitizeSuggestionText } from './suggestion-text';

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
}
