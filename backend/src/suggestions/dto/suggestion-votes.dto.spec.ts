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

  it('accepts the largest value the column holds, and rejects one more', () => {
    // Both halves, deliberately. With only the rejection, a `@Max(0)` typo
    // would pass the suite while refusing every real tally.
    expect(
      failures(SuggestionVotesDto, {
        votes_up: VOTE_COUNT_MAX,
        votes_down: VOTE_COUNT_MAX,
      }),
    ).toEqual([]);
    expect(
      failures(SuggestionVotesDto, {
        votes_up: VOTE_COUNT_MAX + 1,
        votes_down: 0,
      }),
    ).toEqual(['votes_up.max']);
  });

  it('rejects a value `@IsInt()` alone would let through', () => {
    // `IsInt` is `Number.isInteger`, and `Number.isInteger(1e21)` is `true`.
    // Unbounded, this reaches Postgres as `integer out of range` — a 500 for a
    // malformed request. Same hole `clampOffset` was written to close.
    expect(Number.isInteger(1e21)).toBe(true);
    expect(
      failures(SuggestionVotesDto, { votes_up: 1e21, votes_down: 0 }),
    ).toEqual(['votes_up.max']);
  });

  it('rejects a fractional count', () => {
    expect(
      failures(SuggestionVotesDto, { votes_up: 1.5, votes_down: 0 }),
    ).toEqual(['votes_up.isInt']);
  });

  it('rejects a count sent as a string', () => {
    // No `enableImplicitConversion` in the app's pipe, so "3" stays a string
    // and must be refused rather than coerced.
    expect(
      failures(SuggestionVotesDto, { votes_up: '3', votes_down: 0 }),
    ).toContain('votes_up.isInt');
  });

  it('rejects an absent count instead of defaulting it to zero', () => {
    // A partial payload means the bot computed one side and lost the other.
    // Writing a zero it never measured would be inventing a number.
    const missing = failures(SuggestionVotesDto, { votes_up: 3 });
    expect(missing).toContain('votes_down.isInt');
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
