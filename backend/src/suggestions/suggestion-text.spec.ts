import { SUGGESTION_TEXT_MAX_CHARS } from '../db/schema';
import { SuggestionTextError, sanitizeSuggestionText } from './suggestion-text';

describe('sanitizeSuggestionText', () => {
  it('keeps ordinary text untouched', () => {
    expect(sanitizeSuggestionText('Colocar mais eventos no Survival')).toBe(
      'Colocar mais eventos no Survival',
    );
  });

  it('trims surrounding whitespace', () => {
    expect(sanitizeSuggestionText('  ideia  ')).toBe('ideia');
  });

  it('rejects a value that is not a string', () => {
    expect(() => sanitizeSuggestionText(42)).toThrow(SuggestionTextError);
    expect(() => sanitizeSuggestionText(null)).toThrow(SuggestionTextError);
    expect(() => sanitizeSuggestionText(undefined)).toThrow(
      SuggestionTextError,
    );
  });

  it('rejects text that is empty, or empty once sanitized', () => {
    expect(() => sanitizeSuggestionText('')).toThrow(SuggestionTextError);
    expect(() => sanitizeSuggestionText('   \n\t ')).toThrow(
      SuggestionTextError,
    );
    // Nothing but invisible characters is nothing.
    expect(() => sanitizeSuggestionText('\u200B\u200B\uFEFF')).toThrow(
      SuggestionTextError,
    );
  });

  describe('control characters', () => {
    it('strips C0 controls but keeps newline and tab', () => {
      expect(sanitizeSuggestionText('a\u0000b\u0007c\td\ne')).toBe('abc\td\ne');
    });

    it('strips DEL and the C1 block', () => {
      expect(sanitizeSuggestionText('a\u007Fb\u0085c\u009Fd')).toBe('abcd');
    });

    it('strips zero-width and bidi override characters', () => {
      // These let stored text misrepresent itself in *any* renderer, so they
      // are removed on write rather than escaped later.
      const hostile = 'sug\u200Bges\u202Etão\u2066 boa\u2069';
      expect(sanitizeSuggestionText(hostile)).toBe('suggestão boa');
    });
  });

  describe('newlines', () => {
    it('normalizes CRLF and lone CR to LF', () => {
      expect(sanitizeSuggestionText('a\r\nb\rc')).toBe('a\nb\nc');
    });

    it('collapses runs of three or more newlines into a paragraph break', () => {
      expect(sanitizeSuggestionText('a\n\n\n\n\nb')).toBe('a\n\nb');
    });

    it('keeps a single blank line', () => {
      expect(sanitizeSuggestionText('a\n\nb')).toBe('a\n\nb');
    });
  });

  it('normalizes to NFC so equal-looking text compares equal', () => {
    const decomposed = 'sugestão';
    expect(sanitizeSuggestionText(decomposed)).toBe('sugestão');
  });

  describe('length', () => {
    it('accepts text exactly at the limit', () => {
      const atLimit = 'a'.repeat(SUGGESTION_TEXT_MAX_CHARS);
      expect(sanitizeSuggestionText(atLimit)).toHaveLength(
        SUGGESTION_TEXT_MAX_CHARS,
      );
    });

    it('rejects text over the limit instead of truncating it', () => {
      // Truncation would silently change what the player asked for, and the
      // stored row would look like a complete suggestion.
      const tooLong = 'a'.repeat(SUGGESTION_TEXT_MAX_CHARS + 1);
      expect(() => sanitizeSuggestionText(tooLong)).toThrow(
        SuggestionTextError,
      );
    });

    it('measures length after sanitizing, not before', () => {
      const padded = `${'a'.repeat(SUGGESTION_TEXT_MAX_CHARS)}\u200B\u200B   `;
      expect(sanitizeSuggestionText(padded)).toHaveLength(
        SUGGESTION_TEXT_MAX_CHARS,
      );
    });
  });

  describe('what it deliberately does not do', () => {
    it('does not escape markdown', () => {
      // Escaping belongs to the renderer: the stored value has to serve both a
      // Discord embed and an HTML page, and escaping for one corrupts the other.
      expect(sanitizeSuggestionText('**bold** _italic_')).toBe(
        '**bold** _italic_',
      );
    });

    it('does not strip mentions', () => {
      // `@everyone` is legitimate text in a suggestion. What must never happen
      // is it being *rendered* as a mention, which is `allowedMentions` at the
      // send site, not a rewrite of what the player wrote.
      expect(sanitizeSuggestionText('cadê o @everyone?')).toBe(
        'cadê o @everyone?',
      );
    });
  });
});
