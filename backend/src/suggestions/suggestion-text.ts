import { NICKNAME_MAX_CHARS, SUGGESTION_TEXT_MAX_CHARS } from '../db/schema';

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
 * Every Unicode **format** character (general category `Cf`).
 *
 * These are the ones that let a stored string misrepresent itself in *any*
 * renderer: `U+202E` reverses the visual order of what follows, `U+00AD` hides a
 * break point inside a word so a substring filter misses it, and the tag block
 * `U+E0000`-`U+E007F` carries arbitrary invisible payload. Escaping at render
 * time undoes none of that, which is why they go on write.
 *
 * The category rather than a hand-written list: the first version of this
 * enumerated eight ranges, still let `U+00AD`, `U+061C`, `U+FFF9`-`U+FFFB` and
 * the whole tag block through, and claimed in its own comment to cover "any
 * renderer". A list of ranges is a claim to re-check against every Unicode
 * revision; the category is the definition.
 */
const FORMAT_CHARS = /\p{Cf}/gu;

/**
 * Clean player-written suggestion text for storage.
 *
 * ## What it does, and the order matters
 *
 * 1. Folds CRLF and a lone CR into a plain newline.
 * 2. Drops control characters and Unicode format characters.
 * 3. **Then** normalizes to NFC.
 * 4. Collapses three or more consecutive newlines into a single blank line.
 * 5. Trims, then rejects an empty result and a result over the length cap.
 *
 * Normalizing **after** the removals is the part that is easy to get wrong, and
 * the first version of this function got it wrong. A zero-width space between a
 * base letter and its combining mark - `a` + `U+200B` + `U+0303` - blocks
 * composition, so normalizing first leaves the pair decomposed and the removal
 * step then deletes the thing that was blocking it. The output renders as one
 * accented letter, is **not** NFC, and does not compare equal to the same word
 * typed normally. Anything that dedupes, searches or filters this text would
 * see two suggestions where a reader sees one.
 *
 * Length is measured **after** cleaning, and in code points: otherwise a string
 * padded with a thousand zero-width spaces would be rejected for a size it does
 * not have, and the limit would mean a different number here than in the
 * database's own CHECK.
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
    .replace(/\r\n?/g, '\n')
    .replace(CONTROL_CHARS, '')
    .replace(FORMAT_CHARS, '')
    .normalize('NFC')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  if (cleaned.length === 0) {
    throw new SuggestionTextError(
      'Suggestion text is empty after sanitization',
      'empty',
    );
  }

  // Code points, not UTF-16 units - this is the same count the database's
  // `length()` performs, so one limit means one thing on both sides. With
  // `String.prototype.length` an emoji counted twice: the store rejected 1001
  // emoji as "2002 characters" while the CHECK, which saw 1001, would have
  // accepted them. A false refusal carrying a number the player never typed.
  const codePoints = [...cleaned].length;
  if (codePoints > SUGGESTION_TEXT_MAX_CHARS) {
    throw new SuggestionTextError(
      `Suggestion text is ${codePoints} characters, over the ${SUGGESTION_TEXT_MAX_CHARS} limit`,
      'too_long',
    );
  }

  return cleaned;
}

/**
 * CR, LF and tab, as escapes rather than literals.
 *
 * Written this way for the same reason as {@link CONTROL_CHARS}: spelled out,
 * the class is invisible in a diff — and this file has already had a regex
 * silently turn into raw control bytes once.
 */
const LINE_BREAKS = new RegExp('[\\r\\n\\t]+', 'g');

/**
 * Clean a Discord nickname for storage.
 *
 * ## Why this exists at all
 *
 * `assignee_nickname` is the one field of this subsystem written **in order to
 * be published** — it is the shop's credit line — and it was the only one with
 * no write-side cleaning. §8 asks for sanitizing on write *and* escaping on
 * render, and the bot's `renderPlayerText` only does the second half: it escapes
 * markdown and leaves bidi and invisible characters exactly where they were.
 *
 * Measured before this was added: a nickname of `U+202E` + text, one of only
 * zero-width spaces, one of a single `U+00A0`, and one of three plain spaces
 * all reached the column untouched.
 * reverses the visual order of everything after it, so a credit line could be
 * made to read backwards on a public page, and escaping cannot undo that later.
 *
 * ## Why it is not `sanitizeSuggestionText`
 *
 * A nickname is one line. Newlines are removed rather than collapsed — a
 * multi-line "nickname" in an embed field is a way to forge a second field, e.g.
 * `Fulano
Aprovado por: Dono`.
 *
 * @throws {SuggestionTextError} if the value is not a string, is blank once
 *   cleaned, or exceeds {@link NICKNAME_MAX_CHARS}.
 */
export function sanitizeNickname(raw: unknown): string {
  if (typeof raw !== 'string') {
    throw new SuggestionTextError(
      `Nickname must be a string, got ${typeof raw}`,
      'not_a_string',
    );
  }

  const cleaned = raw
    // Newlines become spaces rather than disappearing, so two words do not run
    // together into a name nobody has.
    .replace(LINE_BREAKS, ' ')
    .replace(CONTROL_CHARS, '')
    .replace(FORMAT_CHARS, '')
    .normalize('NFC')
    .replace(/ {2,}/g, ' ')
    .trim();

  if (cleaned.length === 0) {
    throw new SuggestionTextError(
      'Nickname is empty after sanitization',
      'empty',
    );
  }

  const codePoints = [...cleaned].length;
  if (codePoints > NICKNAME_MAX_CHARS) {
    throw new SuggestionTextError(
      `Nickname is ${codePoints} characters, over the ${NICKNAME_MAX_CHARS} limit`,
      'too_long',
    );
  }

  return cleaned;
}
