import { NICKNAME_MAX_CHARS } from '../db/schema';
import { SuggestionTextError, sanitizeNickname } from './suggestion-text';

/**
 * The nickname is the one field of this subsystem written **in order to be
 * published**, and it was the only one with no write-side cleaning. Every case
 * below was measured reaching the column untouched before this existed.
 */
describe('sanitizeNickname', () => {
  it('keeps an ordinary nickname', () => {
    expect(sanitizeNickname('Shinigami')).toBe('Shinigami');
  });

  it('strips a bidi override, which no amount of escaping undoes later', () => {
    // `U+202E` reverses the visual order of everything after it. On a public
    // page the credit line would read backwards, and HTML escaping does not
    // touch it.
    expect(sanitizeNickname('\u202EFulano')).toBe('Fulano');
  });

  it('strips zero-width characters', () => {
    expect(sanitizeNickname('Ful\u200Bano')).toBe('Fulano');
  });

  it('turns a forged second line into one line', () => {
    // A multi-line "nickname" in an embed field is a way to forge a field:
    // `Fulano\nAprovado por: Dono` reads as two rows.
    expect(sanitizeNickname('Fulano\nAprovado por: Dono')).toBe(
      'Fulano Aprovado por: Dono',
    );
  });

  it('collapses the runs that fold-to-space creates', () => {
    expect(sanitizeNickname('Ful\n\n\tano')).toBe('Ful ano');
  });

  describe('blank is not a name', () => {
    it('rejects spaces', () => {
      expect(() => sanitizeNickname('   ')).toThrow(SuggestionTextError);
    });

    it('rejects a non-breaking space', () => {
      // Accepted before: `trim()` removes it, but nothing was calling `trim()`.
      expect(() => sanitizeNickname('\u00A0')).toThrow(SuggestionTextError);
    });

    it('rejects a string of only zero-width characters', () => {
      expect(() => sanitizeNickname('\u200B\u200B\u200B')).toThrow(
        SuggestionTextError,
      );
    });

    it('rejects a non-string', () => {
      expect(() => sanitizeNickname(undefined)).toThrow(SuggestionTextError);
    });
  });

  describe('length', () => {
    it('accepts exactly the Discord cap', () => {
      const atCap = 'a'.repeat(NICKNAME_MAX_CHARS);
      expect(sanitizeNickname(atCap)).toHaveLength(NICKNAME_MAX_CHARS);
    });

    it('counts code points, like the database does', () => {
      const astral = '\u{1F600}'.repeat(NICKNAME_MAX_CHARS);
      expect([...sanitizeNickname(astral)]).toHaveLength(NICKNAME_MAX_CHARS);
    });

    it('rejects one code point over', () => {
      expect(() =>
        sanitizeNickname('\u{1F600}'.repeat(NICKNAME_MAX_CHARS + 1)),
      ).toThrow(/over the/);
    });
  });

  it('does not escape markdown, which is the renderer job', () => {
    // Same split as `sanitizeSuggestionText`: this stops what escaping cannot
    // undo, and the bot's `renderPlayerText` stops what escaping is for.
    expect(sanitizeNickname('**Dono**')).toBe('**Dono**');
  });
});
