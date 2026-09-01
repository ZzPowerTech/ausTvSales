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

  it('parses a date string', () => {
    expect(toEpochMs('2026-03-10T15:00:00Z')).toBe(
      Date.parse('2026-03-10T15:00:00Z'),
    );
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
