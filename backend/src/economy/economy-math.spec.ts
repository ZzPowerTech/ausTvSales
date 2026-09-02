import {
  formatCents,
  percentile,
  shareOf,
  toCents,
  toDate,
} from './economy-math';

describe('toCents', () => {
  it('reads the string a bigint column comes back as', () => {
    expect(toCents('123456')).toBe(123456n);
    expect(toCents('  -50 ')).toBe(-50n);
  });

  it('reads a bigint and an integer number', () => {
    expect(toCents(42n)).toBe(42n);
    expect(toCents(42)).toBe(42n);
  });

  it('throws instead of returning zero for something unreadable', () => {
    // A silent zero here would publish "nobody spent anything" for a value the
    // driver simply handed back in a shape this code did not expect — the exact
    // class of manufactured measurement the epic exists to remove.
    for (const raw of [null, undefined, '12.34', 'abc', {}, 1.5]) {
      expect(() => toCents(raw)).toThrow(TypeError);
    }
  });
});

describe('formatCents', () => {
  it('keeps two decimal places, including for round values', () => {
    expect(formatCents(0n)).toBe('0.00');
    expect(formatCents(5n)).toBe('0.05');
    expect(formatCents(100n)).toBe('1.00');
    expect(formatCents(123456n)).toBe('1234.56');
  });

  it('survives a total no float could hold exactly', () => {
    // 2^53 cents is past the point where a Number sum stops being exact. The
    // server will never earn this, and the guarantee is that the code path does
    // not care.
    expect(formatCents(9_007_199_254_740_993n)).toBe('90071992547409.93');
  });

  it('formats a negative total without losing the sign', () => {
    expect(formatCents(-1n)).toBe('-0.01');
  });
});

describe('shareOf', () => {
  it('returns one decimal', () => {
    expect(shareOf(4540n, 10_000n)).toBe(45.4);
  });

  it('rounds instead of truncating, so the slices still sum to 100', () => {
    // Bigint division truncates: 2/3 published 66.6 where the value is 66.67,
    // and every slice biased low by up to 0.1pp makes a breakdown sum to 99.9%
    // and read as a bug in the caller. `countShare` already used Math.round;
    // two share paths in one report must not use different rules.
    expect(shareOf(2n, 3n)).toBe(66.7);
    expect(shareOf(2000n, 10_700n)).toBe(18.7);
  });

  it('returns null — never zero — for an empty base', () => {
    // Publishing 0% over an empty base would invent a catastrophic-looking
    // reading out of a period where nothing happened.
    expect(shareOf(0n, 0n)).toBeNull();
    expect(shareOf(500n, 0n)).toBeNull();
  });

  it('is exact for totals beyond float precision', () => {
    const whole = 10_000_000_000_000_000n;
    expect(shareOf(whole / 4n, whole)).toBe(25);
  });
});

describe('percentile', () => {
  it('returns a value somebody actually waited, not an interpolation', () => {
    // Nearest-rank: with cohorts of a few dozen players, an interpolated median
    // invents a day count nobody experienced, and every reader will take the
    // number literally.
    expect(percentile([1, 2, 3, 4], 0.5)).toBe(2);
    expect(percentile([1, 2, 3, 4], 0.9)).toBe(4);
  });

  it('does not care about input order', () => {
    expect(percentile([9, 1, 5], 0.5)).toBe(5);
  });

  it('returns null for an empty sample instead of zero', () => {
    // Zero would read as "everybody bought on day one".
    expect(percentile([], 0.5)).toBeNull();
  });

  it('clamps the rank inside the sample', () => {
    expect(percentile([7], 0)).toBe(7);
    expect(percentile([7], 1)).toBe(7);
  });
});

describe('toDate', () => {
  it('accepts the string an aggregate comes back as', () => {
    // The bug this closes: `pg` parses a plain `timestamptz` column into a
    // `Date` but handed back `min(purchased_at)` as a **string**, and
    // `.getTime()` threw `is not a function` in production code that the unit
    // tests could not see, because they stub the driver. Only the e2e caught it.
    expect(toDate('2026-03-10T15:00:00.000Z')).toEqual(
      new Date('2026-03-10T15:00:00.000Z'),
    );
  });

  it('passes a Date through', () => {
    const date = new Date('2026-03-10T15:00:00.000Z');
    expect(toDate(date)).toBe(date);
  });

  it('accepts epoch milliseconds', () => {
    expect(toDate(1_772_000_000_000)?.getTime()).toBe(1_772_000_000_000);
  });

  it('refuses a string with no offset instead of guessing a zone', () => {
    // V8 reads a bare `2026-03-10 15:00:00` as process-local time while a plain
    // column arrives as a correct `Date`, and the two are subtracted three lines
    // later. An hour of container skew shifts the day count for a slice of
    // players, silently and always in one direction.
    expect(toDate('2026-03-10 15:00:00')).toBeNull();
    expect(toDate('2026-03-10T15:00:00')).toBeNull();
    expect(toDate('2026-03-10T15:00:00Z')).not.toBeNull();
    expect(toDate('2026-03-10 15:00:00+00')).not.toBeNull();
  });

  it('does not mistake the day of a date-only string for an offset', () => {
    // `2026-09-01` ends in `-01`, which a tail-only pattern reads as an offset.
    // V8 parses the date-only form as UTC midnight — 21:00 BRT of the previous
    // day — so the guard would have let through exactly the shift it exists to
    // refuse. The pattern now requires a time of day before the offset.
    expect(toDate('2026-09-01')).toBeNull();
    expect(toDate('2026-12-31')).toBeNull();
  });

  it('returns null — never "now" — for anything unusable', () => {
    // Falling back to the current time would file a row under today and produce
    // a measurement nobody can audit.
    for (const raw of [null, undefined, {}, [], 'nao e data', new Date('x')]) {
      expect(toDate(raw)).toBeNull();
    }
  });
});
