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

    it('strips every Unicode format character, not a hand-picked list', () => {
      // The first version enumerated ranges and let these four through while
      // its comment claimed to cover "any renderer".
      expect(sanitizeSuggestionText('so\u00ADft')).toBe('soft');
      expect(sanitizeSuggestionText('a\u061Cb')).toBe('ab');
      expect(sanitizeSuggestionText('a\uFFF9b')).toBe('ab');
      // Tag block: arbitrary invisible payload riding inside the text.
      expect(sanitizeSuggestionText('ok\u{E0041}\u{E0042}')).toBe('ok');
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

  describe('NFC normalization', () => {
    it('composes decomposed input', () => {
      const decomposed = 'sugesta\u0303o';
      expect(sanitizeSuggestionText(decomposed)).toBe('sugest\u00E3o');
    });

    it('normalizes AFTER removing invisibles, not before', () => {
      // Regression for the ordering bug. A zero-width space between the base
      // letter and its combining tilde blocks composition, so normalizing first
      // leaves the pair decomposed and the removal step then deletes what was
      // blocking it. Output renders identically and is not NFC.
      const blocked = 'sugesta\u200B\u0303o';
      const plain = 'sugest\u00E3o';

      const cleaned = sanitizeSuggestionText(blocked);
      expect(cleaned).toBe(plain);
      expect(cleaned).toBe(cleaned.normalize('NFC'));
      expect(cleaned).toHaveLength(plain.length);
    });

    it('normalizes after removing a control character too', () => {
      expect(sanitizeSuggestionText('sugesta\u0000\u0303o')).toBe(
        'sugest\u00E3o',
      );
    });
  });

  describe('length', () => {
    it('accepts text exactly at the limit', () => {
      const atLimit = 'a'.repeat(SUGGESTION_TEXT_MAX_CHARS);
      expect(sanitizeSuggestionText(atLimit)).toHaveLength(
        SUGGESTION_TEXT_MAX_CHARS,
      );
    });

    it('counts code points, not UTF-16 units', () => {
      // `String.prototype.length` counts an emoji twice; the database's
      // `length()` counts it once. Measured in UTF-16 units, 1001 emoji were
      // refused as "2002 characters" - a number the player never typed - while
      // the CHECK, seeing 1001, would have accepted them.
      const astral = '\u{1F600}'.repeat(SUGGESTION_TEXT_MAX_CHARS);
      expect([...sanitizeSuggestionText(astral)]).toHaveLength(
        SUGGESTION_TEXT_MAX_CHARS,
      );
    });

    it('rejects one code point over the limit, astral included', () => {
      const astral = '\u{1F600}'.repeat(SUGGESTION_TEXT_MAX_CHARS + 1);
      expect(() => sanitizeSuggestionText(astral)).toThrow(
        `is ${SUGGESTION_TEXT_MAX_CHARS + 1} characters`,
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
