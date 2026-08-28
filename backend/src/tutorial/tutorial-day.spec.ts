import { toSaoPauloDay } from './tutorial-day';

describe('toSaoPauloDay', () => {
  it('buckets by America/Sao_Paulo, not by UTC', () => {
    // 2026-03-10 21:00 BRT is 2026-03-11 00:00 UTC. `toISOString().slice(0,10)`
    // would file it under the 11th — and it would do that to every Brazilian
    // evening, which is this server's busiest window, every single day, always
    // in the same direction.
    const evening = Date.UTC(2026, 2, 11, 0, 0, 0);

    expect(new Date(evening).toISOString()).toContain('2026-03-11');
    expect(toSaoPauloDay(evening)).toBe('2026-03-10');
  });

  it('keeps a midday timestamp on its own day', () => {
    expect(toSaoPauloDay(Date.UTC(2026, 2, 10, 15, 0, 0))).toBe('2026-03-10');
  });

  it('handles the pre-2019 Brazilian DST, when the offset was -02:00', () => {
    // Brazil abolished DST in 2019, but `started-date` values from 2018 exist in
    // the corpus — the baseline holds timestamps back to 2018. A hardcoded -03:00
    // would be an hour off for those, which matters at the day boundary.
    // 2018-02-17 23:30 BRST (-02:00) is 2018-02-18 01:30 UTC.
    const summer = Date.UTC(2018, 1, 18, 1, 30, 0);

    expect(toSaoPauloDay(summer)).toBe('2018-02-17');
  });

  it.each([
    ['null', null],
    ['zero', 0],
    ['negative', -1],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
  ])('returns null for %s rather than inventing a day', (_label, value) => {
    // Zero is the dangerous one: it is finite, and would render as 1970-01-01,
    // planting a phantom cohort at the head of every series.
    expect(toSaoPauloDay(value)).toBeNull();
  });

  it('always returns the YYYY-MM-DD shape', () => {
    const day = toSaoPauloDay(Date.UTC(2026, 11, 31, 12, 0, 0));

    expect(day).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(day).toBe('2026-12-31');
  });
});
