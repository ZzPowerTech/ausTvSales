import { parseServerOverview, toNumber } from './plan-server-overview';

/**
 * Real response of `GET /v1/serverOverview?server=Survival` from the AusTV
 * production Plan, 2026-08-23. Trimmed to the fields the adapter reads.
 *
 * Kept verbatim on purpose: a fixture invented from documentation would only
 * prove the parser agrees with my assumptions, which is exactly the mistake this
 * sprint already paid for once.
 */
const SURVIVAL_REAL = {
  timestamp: 1787494648039,
  timestamp_f: 'Today, 11:17',
  last_7_days: {
    new_players: 43,
    downtime: 4176035,
    new_players_retention: 25,
    average_tps: '19.99',
    unique_players_day: 59,
    unique_players: 237,
    low_tps_spikes: 0,
    new_players_retention_perc: '58.14%',
  },
  numbers: {
    sessions: 138965,
    regular_players: 78,
    best_peak_players: '58',
    total_players: 5540,
    playtime: 341043160093,
    last_peak_date: 1787427319373,
    online_players: '8',
    current_uptime: 6610744,
    last_peak_players: '17',
  },
};

/**
 * Real response for the proxy, `?server=AusTv`, same day.
 *
 * This one is the reason `number | null` exists: `average_tps` is
 * `"plugin.generic.unavailable"` and the retention percentage is `"-"`. Both are
 * Plan saying "no measurement", and both would become `0` under a naive parser.
 */
const PROXY_REAL = {
  timestamp: 1787495534365,
  timestamp_f: 'Today, 11:32',
  last_7_days: {
    new_players: 0,
    downtime: 231861,
    new_players_retention: 0,
    average_tps: 'plugin.generic.unavailable',
    unique_players_day: 0,
    unique_players: 0,
    low_tps_spikes: 0,
    new_players_retention_perc: '-',
  },
  numbers: {},
};

describe('toNumber', () => {
  it('passes a JSON number through', () => {
    expect(toNumber(43)).toBe(43);
    expect(toNumber(0)).toBe(0);
  });

  it('parses the numeric strings Plan mixes in', () => {
    // `online_players` and `average_tps` arrive as strings while `new_players`
    // is a number, in the very same response.
    expect(toNumber('8')).toBe(8);
    expect(toNumber('19.99')).toBe(19.99);
  });

  it('strips the percent suffix', () => {
    expect(toNumber('58.14%')).toBe(58.14);
  });

  it.each([['plugin.generic.unavailable'], ['-'], [''], ['   '], ['null']])(
    'maps the no-data sentinel %p to null, never 0',
    (sentinel) => {
      // The single most important assertion in this file. Coercing a sentinel to
      // zero is how a collection gap becomes a real-looking reading, which is the
      // failure the whole epic exists to prevent.
      expect(toNumber(sentinel)).toBeNull();
    },
  );

  it('distinguishes a real zero from a missing measurement', () => {
    expect(toNumber(0)).toBe(0);
    expect(toNumber('0')).toBe(0);
    expect(toNumber('-')).toBeNull();
    // Same downstream question, two different answers: "nobody joined" versus
    // "we did not measure".
    expect(toNumber(0)).not.toBe(toNumber('-'));
  });

  it('returns null for absent, unparseable and non-finite values', () => {
    expect(toNumber(undefined)).toBeNull();
    expect(toNumber(null)).toBeNull();
    expect(toNumber('abc')).toBeNull();
    expect(toNumber({})).toBeNull();
    expect(toNumber([])).toBeNull();
    expect(toNumber(Number.NaN)).toBeNull();
    expect(toNumber(Number.POSITIVE_INFINITY)).toBeNull();
  });
});

describe('parseServerOverview', () => {
  describe('resposta real do Survival', () => {
    it('reads the fields the checks consume', () => {
      const result = parseServerOverview(SURVIVAL_REAL);

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value.timestamp).toBe(1787494648039);
      expect(result.value.last7Days.newPlayers).toBe(43);
      expect(result.value.last7Days.uniquePlayers).toBe(237);
      expect(result.value.last7Days.uniquePlayersDay).toBe(59);
      expect(result.value.last7Days.newPlayersRetention).toBe(25);
      expect(result.value.numbers.onlinePlayers).toBe(8);
      expect(result.value.numbers.sessions).toBe(138965);
      expect(result.value.numbers.totalPlayers).toBe(5540);
      expect(result.value.numbers.lastPeakDate).toBe(1787427319373);
    });

    it('keeps the base beside the ratio so `n` is always available', () => {
      const result = parseServerOverview(SURVIVAL_REAL);
      if (!result.ok) throw new Error('esperava sucesso');

      const { newPlayers, newPlayersRetention } = result.value.last7Days;
      // 25 of 43 is the 58.14% Plan reports — the check can publish the
      // percentage with its base instead of a bare number.
      expect(newPlayers).toBe(43);
      expect(newPlayersRetention).toBe(25);
    });
  });

  describe('resposta real do proxy', () => {
    it('parses a payload full of zeros and sentinels', () => {
      const result = parseServerOverview(PROXY_REAL);

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      // These zeros are real zeros reported by Plan, and stay zero.
      expect(result.value.last7Days.newPlayers).toBe(0);
      expect(result.value.last7Days.uniquePlayers).toBe(0);
    });

    it('returns null for a `numbers` block Plan omitted', () => {
      const result = parseServerOverview(PROXY_REAL);
      if (!result.ok) throw new Error('esperava sucesso');

      // Absent block must not become zeros — the server did not report zero
      // players online, it reported nothing at all.
      expect(result.value.numbers.onlinePlayers).toBeNull();
      expect(result.value.numbers.sessions).toBeNull();
    });
  });

  describe('resposta malformada', () => {
    it.each([[null], [undefined], ['texto'], [42], [[]]])(
      'rejects a non-object body (%p)',
      (body) => {
        const result = parseServerOverview(body);
        expect(result.ok).toBe(false);
      },
    );

    it('rejects a body without a usable timestamp', () => {
      const result = parseServerOverview({ last_7_days: {}, numbers: {} });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toContain('timestamp');
    });

    it('names the problem instead of throwing', () => {
      // A caller turns this into an `error` verdict whose summary reaches
      // Discord. A stack trace there would be useless; "campo X ausente" is what
      // tells us a Plan upgrade changed the contract.
      const result = parseServerOverview('<html>login</html>');

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toContain('objeto JSON');
    });

    it('survives a response whose blocks are the wrong type', () => {
      const result = parseServerOverview({
        timestamp: 1,
        last_7_days: 'nope',
        numbers: 12,
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      // Degrades to "no data" per field rather than failing the whole parse: one
      // renamed block should not blind every check at once.
      expect(result.value.last7Days.newPlayers).toBeNull();
      expect(result.value.numbers.onlinePlayers).toBeNull();
    });
  });
});
