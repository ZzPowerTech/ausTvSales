import { parseRetention, toEpochMs } from './plan-retention';

const UUID = '11111111-1111-4111-8111-111111111111';

/** 2026-03-10 12:00 BRT, in the three encodings the parser accepts. */
const EPOCH_MS = Date.parse('2026-03-10T12:00:00-03:00');
const EPOCH_S = Math.floor(EPOCH_MS / 1000);

describe('toEpochMs', () => {
  it('passes epoch milliseconds through', () => {
    expect(toEpochMs(EPOCH_MS)).toBe(EPOCH_MS);
  });

  it('scales epoch seconds up instead of filing 2026 under 1970', () => {
    // The bug this guards against is silent: seconds read as milliseconds put
    // every player in January 1970, producing a report of empty cohorts that
    // looks like a data outage rather than like a unit mistake.
    expect(toEpochMs(EPOCH_S)).toBe(EPOCH_S * 1000);
  });

  it('parses a date string that carries an offset', () => {
    expect(toEpochMs('2026-03-10T15:00:00Z')).toBe(
      Date.parse('2026-03-10T15:00:00Z'),
    );
    expect(toEpochMs('2026-03-10T12:00:00-03:00')).toBe(
      Date.parse('2026-03-10T12:00:00-03:00'),
    );
  });

  it('refuses a date string with no offset instead of guessing a zone', () => {
    // Two silent failures this closes. `2026-09-01` is UTC midnight by spec,
    // which is 21:00 BRT of the PREVIOUS day — every player registering on the
    // 1st would land in the previous month's cohort. And a MySQL-style
    // `2026-09-02 01:00:00` is parsed by V8 as process-local time, so the answer
    // would depend on the container's TZ.
    //
    // The field types of /v1/retention were never observed, so the parser
    // refuses rather than guesses: the row is dropped, counted, and published
    // as dropped.
    expect(toEpochMs('2026-09-01')).toBeNull();
    expect(toEpochMs('2026-09-02 01:00:00')).toBeNull();
    expect(toEpochMs('2026-09-02T01:00:00')).toBeNull();
  });

  it('does not mistake the day of a date-only string for an offset', () => {
    // The first version of this guard only looked at the tail, and `2026-09-01`
    // ends in `-01` — which reads as an offset of minus one hour. V8 then parses
    // the date-only form as UTC midnight, 21:00 BRT of the PREVIOUS day: the
    // exact shift the guard exists to refuse, let through by the guard itself.
    // The pattern now requires a time of day before the offset.
    expect(toEpochMs('2026-09-01')).toBeNull();
    expect(toEpochMs('2026-12-31')).toBeNull();
    // And the forms Postgres and Plan actually emit still pass.
    expect(toEpochMs('2026-09-01T00:00:00-03:00')).not.toBeNull();
    expect(toEpochMs('2026-09-01 03:00:00+00')).not.toBeNull();
  });

  it('returns null — never zero — for anything unreadable', () => {
    for (const raw of [null, undefined, '', 'nao e data', {}, [], -5, 0]) {
      expect(toEpochMs(raw)).toBeNull();
    }
  });
});

describe('parseRetention', () => {
  const row = {
    playerUUID: UUID,
    registerDate: EPOCH_MS,
    lastSeenDate: EPOCH_MS + 86_400_000,
    playtime: 12_345,
    timeDifference: 86_400_000,
  };

  describe('envelope', () => {
    it('reads a bare array', () => {
      const result = parseRetention([row]);

      expect(result).toEqual({
        ok: true,
        value: {
          players: [
            {
              uuid: UUID,
              registeredAt: EPOCH_MS,
              lastSeenAt: EPOCH_MS + 86_400_000,
            },
          ],
          rows: 1,
          dropped: 0,
        },
      });
    });

    it('reads an object holding exactly one array', () => {
      const result = parseRetention({ players: [row] });

      expect(result.ok).toBe(true);
      expect(result.ok && result.value.players).toHaveLength(1);
    });

    it('refuses an ambiguous envelope instead of picking an array', () => {
      // Picking the first array would be a coin flip whose wrong side is a
      // report full of plausible numbers about the wrong population.
      const result = parseRetention({ players: [row], servers: [] });

      expect(result.ok).toBe(false);
      expect(result.ok === false && result.reason).toContain('2 listas');
    });

    it('refuses a body that is neither an array nor an object', () => {
      expect(parseRetention('nope').ok).toBe(false);
    });
  });

  describe('field spelling', () => {
    it('accepts the alternative casings of the uuid field', () => {
      for (const key of ['playerUUID', 'playerUuid', 'uuid']) {
        const result = parseRetention([
          { [key]: UUID, registerDate: EPOCH_MS, lastSeenDate: EPOCH_MS },
        ]);
        expect(result.ok && result.value.players[0].uuid).toBe(UUID);
      }
    });
  });

  describe('the uuid value, not only its field name', () => {
    it('drops a uuid that is not in canonical form', () => {
      // The field NAME got three accepted spellings, because being wrong about
      // it "would produce `unknown` for every platform — a plausible-looking
      // result, which is the dangerous kind". The VALUE has the same failure:
      // an undashed uuid classifies as `unknown` for every row, and a cohort
      // table full of `unknown` still carries real-looking percentages.
      const result = parseRetention([
        {
          playerUUID: '11111111111141118111111111111111',
          registerDate: EPOCH_MS,
          lastSeenDate: EPOCH_MS,
        },
      ]);

      expect(result.ok).toBe(false);
      expect(result.ok === false && result.reason).toContain('nenhuma das 1');
    });

    it('keeps a canonical uuid in either case', () => {
      for (const uuid of [UUID, UUID.toUpperCase()]) {
        const result = parseRetention([
          { playerUUID: uuid, registerDate: EPOCH_MS, lastSeenDate: EPOCH_MS },
        ]);
        expect(result.ok).toBe(true);
      }
    });
  });

  describe('unreadable rows', () => {
    it('drops and counts a row missing a date, keeping the rest', () => {
      const result = parseRetention([row, { playerUUID: UUID }]);

      expect(result.ok).toBe(true);
      expect(result.ok && result.value).toMatchObject({
        rows: 2,
        dropped: 1,
      });
      expect(result.ok && result.value.players).toHaveLength(1);
    });

    it('calls it a contract mismatch when NO row could be read', () => {
      // "Plan changed shape" and "nobody ever registered" must not look alike:
      // this module must never report the second by accident.
      const result = parseRetention([{ nope: 1 }, { nope: 2 }]);

      expect(result.ok).toBe(false);
      expect(result.ok === false && result.reason).toContain('nenhuma das 2');
    });

    it('lets a genuinely empty payload through as an empty population', () => {
      const result = parseRetention([]);

      expect(result).toEqual({
        ok: true,
        value: { players: [], rows: 0, dropped: 0 },
      });
    });
  });
});
