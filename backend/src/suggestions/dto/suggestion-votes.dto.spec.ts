import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import {
  SuggestionMessageParamsDto,
  SuggestionVotesDto,
  VOTE_COUNT_MAX,
} from './suggestion-votes.dto';

/** The constraint names that failed, flattened across properties. */
function failures(
  dto: new () => object,
  plain: Record<string, unknown>,
): string[] {
  const errors = validateSync(plainToInstance(dto, plain), {
    whitelist: true,
    forbidNonWhitelisted: true,
  });
  return errors.flatMap((error) => [
    ...Object.keys(error.constraints ?? {}).map(
      (name) => `${error.property}.${name}`,
    ),
  ]);
}

/**
 * The vote payload's validation, exercised directly rather than only through
 * HTTP.
 *
 * The e2e suite proves the route wears these rules; it needs a database, so it
 * only runs in CI. This runs everywhere, which matters for the assertions that
 * are easy to delete by accident — every `@Max` below guards a **500**, not a
 * cosmetic 400, and a missing one leaves every other test green.
 */
describe('SuggestionVotesDto', () => {
  it('accepts a plain tally', () => {
    expect(
      failures(SuggestionVotesDto, { votes_up: 7, votes_down: 2 }),
    ).toEqual([]);
  });

  it('accepts zero on both sides', () => {
    // The state a card is in until someone votes, and the state it returns to
    // when the last reaction is removed. If this were rejected, R2.4 would be
    // unimplementable.
    expect(
      failures(SuggestionVotesDto, { votes_up: 0, votes_down: 0 }),
    ).toEqual([]);
  });

  it('rejects a negative count on either side', () => {
    expect(
      failures(SuggestionVotesDto, { votes_up: -1, votes_down: 0 }),
    ).toEqual(['votes_up.min']);
    expect(
      failures(SuggestionVotesDto, { votes_up: 0, votes_down: -1 }),
    ).toEqual(['votes_down.min']);
  });

  it('accepts the largest value the column holds', () => {
    // The half that would be missing if only the rejections were tested: a
    // `@Max(0)` typo would pass a suite that only ever sends bad values, while
    // refusing every real tally in production.
    expect(
      failures(SuggestionVotesDto, {
        votes_up: VOTE_COUNT_MAX,
        votes_down: VOTE_COUNT_MAX,
      }),
    ).toEqual([]);
  });

  /**
   * Every rejection is asserted **once per field**, and the loop is the point.
   *
   * The first version of this file sent every bad value in `votes_up` and a
   * valid one in `votes_down`. Deleting `@Max` from `votes_down` alone left the
   * whole suite green — unit, e2e, typecheck — while
   * `{ votes_up: 0, votes_down: 2147483648 }` went on to produce the 500 these
   * rules exist to prevent. The property is declared on both fields, so it has
   * to be exercised on both; asserting it on one and trusting symmetry is how a
   * guard comes to protect half of what its docblock claims.
   */
  const FIELDS = ['votes_up', 'votes_down'] as const;

  /** A valid payload with exactly one field replaced by `value`. */
  function only(field: (typeof FIELDS)[number], value: unknown) {
    return { votes_up: 0, votes_down: 0, [field]: value };
  }

  describe.each(FIELDS)('%s', (field) => {
    it('rejects a negative count', () => {
      expect(failures(SuggestionVotesDto, only(field, -1))).toEqual([
        `${field}.min`,
      ]);
    });

    it('rejects one more than the column holds', () => {
      expect(
        failures(SuggestionVotesDto, only(field, VOTE_COUNT_MAX + 1)),
      ).toEqual([`${field}.max`]);
    });

    it('rejects a value `@IsInt()` alone would let through', () => {
      // `IsInt` is `Number.isInteger`, and `Number.isInteger(1e21)` is `true`.
      // Unbounded, this reaches Postgres as `integer out of range` — a 500 for
      // a malformed request. Same hole `clampOffset` was written to close.
      expect(Number.isInteger(1e21)).toBe(true);
      expect(failures(SuggestionVotesDto, only(field, 1e21))).toEqual([
        `${field}.max`,
      ]);
    });

    it('rejects a fractional count', () => {
      expect(failures(SuggestionVotesDto, only(field, 1.5))).toEqual([
        `${field}.isInt`,
      ]);
    });

    it('rejects a count sent as a string', () => {
      // No `enableImplicitConversion` in the app's pipe, so "3" stays a string
      // and must be refused rather than coerced.
      expect(failures(SuggestionVotesDto, only(field, '3'))).toContain(
        `${field}.isInt`,
      );
    });

    it('rejects an absent count instead of defaulting it to zero', () => {
      // A partial payload means the bot computed one side and lost the other.
      // Writing a zero it never measured would be inventing a number.
      const partial: Record<string, unknown> = { votes_up: 0, votes_down: 0 };
      delete partial[field];
      expect(failures(SuggestionVotesDto, partial)).toContain(`${field}.isInt`);
    });
  });

  it('refuses a field nobody declared', () => {
    // `forbidNonWhitelisted`, exercised where it can run without a database. A
    // `status` smuggled into a vote payload must be refused rather than quietly
    // dropped — silently ignoring it is how a caller comes to believe it works.
    expect(
      failures(SuggestionVotesDto, {
        votes_up: 1,
        votes_down: 0,
        status: 'aprovada',
      }),
    ).toContain('status.whitelistValidation');
  });
});

describe('SuggestionMessageParamsDto', () => {
  it('accepts a Discord snowflake', () => {
    expect(
      failures(SuggestionMessageParamsDto, {
        discordMsgId: '900000000000000100',
      }),
    ).toEqual([]);
  });

  it('rejects anything that is not one', () => {
    // 400 rather than 404, so the 404 keeps exactly one meaning: "no suggestion
    // came from that message" (R4.4). A route that answered 404 to both would
    // report a caller bug as an ordinary miss, and the bot would stop retrying
    // for the wrong reason.
    for (const bad of [
      'nao-e-um-id',
      '123',
      '',
      '9'.repeat(21),
      '12a4567890123456789',
    ]) {
      expect(
        failures(SuggestionMessageParamsDto, { discordMsgId: bad }),
      ).toEqual(['discordMsgId.matches']);
    }
  });
});
