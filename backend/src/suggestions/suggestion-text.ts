import { SUGGESTION_TEXT_MAX_CHARS } from '../db/schema';

/** Raised when player-written text cannot be stored as a suggestion. */
export class SuggestionTextError extends Error {
  constructor(
    message: string,
    /** Machine-readable cause, so a caller can pick the right player-facing message. */
    readonly reason: 'not_a_string' | 'empty' | 'too_long',
  ) {
    super(message);
    this.name = 'SuggestionTextError';
  }
}

/**
 * C0 controls except tab and newline, plus DEL and the C1 block.
 *
 * Carriage return is absent on purpose: it is normalized to a newline before
 * this runs, rather than dropped, so `a\r\nb` stays two lines instead of
 * becoming one.
 *
 * Written as escapes rather than literals — spelled literally this character
 * class would be unreadable in the source and invisible in a diff.
 */
const CONTROL_CHARS = new RegExp(
  // eslint-disable-next-line no-control-regex -- control characters are the subject
  '[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]',
  'g',
);

/**
 * Zero-width and bidirectional-formatting characters.
 *
 * These are the ones that let a stored string misrepresent itself in *any*
 * renderer: `U+202E` reverses the visual order of everything after it, and the
 * zero-width family hides content from a reader while keeping it in the data.
 * Escaping at render time cannot undo either, which is why they go on write.
 *
 * Escapes again, for the same reason as {@link CONTROL_CHARS} — and here the
 * reason is sharper, since every character in the class is invisible by
 * definition.
 */
const INVISIBLE_CHARS = new RegExp(
  '[\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]',
  'g',
);

/**
 * Clean player-written suggestion text for storage.
 *
 * ## What it does, and the order matters
 *
 * 1. Unicode-normalizes to NFC, so two spellings of the same word are one string.
 * 2. Folds CRLF and a lone CR into a plain newline.
 * 3. Drops control characters and invisible/bidi formatting characters.
 * 4. Collapses three or more consecutive newlines into a single blank line.
 * 5. Trims, then rejects an empty result and a result over the length cap.
 *
 * Length is measured **after** cleaning: otherwise a string padded with a
 * thousand zero-width spaces would be rejected for a size it does not have.
 *
 * ## What it deliberately does not do
 *
 * It does not escape markdown and it does not remove mentions. §8 of the spec
 * asks for sanitizing on write *and* escaping on render, because they solve
 * different problems: sanitizing cannot know whether the target is a Discord
 * embed or an HTML page, and escaping for one corrupts the value for the other.
 * `@everyone` inside a suggestion is ordinary text; what must never happen is it
 * being *rendered* as a mention, and that is `allowedMentions` at the send site.
 *
 * It rejects over-long text instead of truncating it. A truncated suggestion is
 * indistinguishable from a complete one once stored, and it no longer says what
 * the player asked for.
 *
 * @throws {SuggestionTextError} if the value is not a string, is empty once
 *   cleaned, or exceeds {@link SUGGESTION_TEXT_MAX_CHARS}.
 */
export function sanitizeSuggestionText(raw: unknown): string {
  if (typeof raw !== 'string') {
    throw new SuggestionTextError(
      `Suggestion text must be a string, got ${typeof raw}`,
      'not_a_string',
    );
  }

  const cleaned = raw
    .normalize('NFC')
    .replace(/\r\n?/g, '\n')
    .replace(CONTROL_CHARS, '')
    .replace(INVISIBLE_CHARS, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  if (cleaned.length === 0) {
    throw new SuggestionTextError(
      'Suggestion text is empty after sanitization',
      'empty',
    );
  }

  if (cleaned.length > SUGGESTION_TEXT_MAX_CHARS) {
    throw new SuggestionTextError(
      `Suggestion text is ${cleaned.length} characters, over the ${SUGGESTION_TEXT_MAX_CHARS} limit`,
      'too_long',
    );
  }

  return cleaned;
}
