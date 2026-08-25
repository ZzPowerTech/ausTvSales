import { parseOnlineOverview } from './plan-online-overview';

/**
 * Real response of `GET /v1/onlineOverview?server=Survival` from the AusTV
 * production Plan, 2026-08-25. Trimmed to the fields the adapter reads, plus a
 * trend object kept verbatim so the "trends are ignored" rule is exercised
 * against the real shape rather than a stand-in.
 *
 * Kept verbatim on purpose: the upstream documentation is a Javadoc of the
 * plugin's Java API and says nothing about this payload, so a fixture written
 * from the docs would only prove the parser agrees with someone's imagination.
 */
const SURVIVAL_REAL = {
  timestamp: 1787692872298,
  timestamp_f: 'Today, 18:21',
  insights: {
    first_session_length_median: 174025,
    lone_joins: 0,
    players_first_join_avg: '11.14',
  },
  numbers: {
    new_players_24h: 1,
    unique_players_24h: 60,
    sessions_24h: 295,
    playtime_24h: 702319717,
    session_length_24h_avg: 2380744,
    new_players_retention_24h: 1,
    new_players_retention_24h_perc: '100%',

    new_players_7d: 36,
    unique_players_7d: 230,
    sessions_7d: 1588,
    playtime_7d: 3833062041,
    session_length_7d_avg: 2413767,
    new_players_retention_7d: 24,
    new_players_retention_7d_perc: '66.67%',

    new_players_30d: 200,
    unique_players_30d: 577,
    sessions_30d: 7057,
    playtime_30d: 18431062145,
    session_length_30d_avg: 2611741,
    new_players_retention_30d: 111,
    new_players_retention_30d_perc: '55.5%',

    sessions_30d_trend: { text: '1213', direction: '-', reversed: false },
  },
};

describe('parseOnlineOverview', () => {
  it('reads the three windows out of the real production payload', () => {
    const result = parseOnlineOverview(SURVIVAL_REAL);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.timestamp).toBe(1787692872298);
    expect(result.value.last7d).toEqual({
      newPlayers: 36,
      uniquePlayers: 230,
      sessions: 1588,
      playtimeMs: 3833062041,
      sessionLengthAvgMs: 2413767,
      newPlayerRetention: { value: 24, n: 36 },
    });
  });

  it('keeps the base beside the ratio instead of the formatted percentage', () => {
    // Plan prints `"66.67%"` and also ships 24 and 36. The project rule is that
    // no percentage is published without its base, and this source satisfies it
    // without any arithmetic of ours — so the two counts are what travel, and
    // the pre-formatted string is deliberately dropped.
    const result = parseOnlineOverview(SURVIVAL_REAL);
    if (!result.ok) throw new Error(result.reason);

    const { newPlayerRetention } = result.value.last7d;

    expect(newPlayerRetention).toEqual({ value: 24, n: 36 });
    expect(JSON.stringify(result.value)).not.toContain('66.67');
  });

  it('does not publish the trend objects', () => {
    // They are a presentation concern of Plan's own React page: a pre-formatted
    // string and an arrow, with no window attached to the comparison.
    // Republishing one would be republishing a number whose meaning we cannot
    // state.
    const result = parseOnlineOverview(SURVIVAL_REAL);
    if (!result.ok) throw new Error(result.reason);

    expect(JSON.stringify(result.value)).not.toContain('direction');
    expect(JSON.stringify(result.value)).not.toContain('1213');
  });

  it('reports a missing field as null, never as zero', () => {
    // The failure this whole epic exists to prevent. A window Plan could not
    // measure must arrive as "no reading", because a zero here is a claim that
    // nobody joined — and that claim, believed, is what hid the tutorial
    // collapse for eight months.
    const result = parseOnlineOverview({
      timestamp: 1,
      numbers: { new_players_7d: 5 },
    });
    if (!result.ok) throw new Error(result.reason);

    expect(result.value.last7d.newPlayers).toBe(5);
    expect(result.value.last7d.uniquePlayers).toBeNull();
    expect(result.value.last7d.sessions).toBeNull();
    expect(result.value.last30d.newPlayers).toBeNull();
  });

  it('reports no base when the arrivals of that window are missing', () => {
    // A ratio that borrowed a denominator from another window would be worse
    // than no ratio: it would look computable and be wrong.
    const result = parseOnlineOverview({
      timestamp: 1,
      numbers: { new_players_retention_7d: 24, new_players_30d: 200 },
    });
    if (!result.ok) throw new Error(result.reason);

    expect(result.value.last7d.newPlayerRetention).toEqual({
      value: 24,
      n: null,
    });
  });

  it('turns the Plan sentinels into null', () => {
    // `plugin.generic.unavailable` and `-` are how Plan says "no measurement".
    // Coercing either to 0 would be the single worst bug this module could
    // carry, which is why the shared `toNumber` is reused rather than rewritten.
    const result = parseOnlineOverview({
      timestamp: 1,
      numbers: {
        new_players_7d: 'plugin.generic.unavailable',
        unique_players_7d: '-',
        sessions_7d: '',
      },
    });
    if (!result.ok) throw new Error(result.reason);

    expect(result.value.last7d.newPlayers).toBeNull();
    expect(result.value.last7d.uniquePlayers).toBeNull();
    expect(result.value.last7d.sessions).toBeNull();
  });

  it('refuses a body without a usable timestamp', () => {
    // Without it there is no telling a fresh response from a cached one, and
    // every value below would be undated.
    expect(parseOnlineOverview({ numbers: {} })).toEqual({
      ok: false,
      reason: 'campo `timestamp` ausente ou nao numerico na resposta do Plan',
    });
  });

  it('refuses something that is not an object', () => {
    expect(parseOnlineOverview('<html>login</html>').ok).toBe(false);
    expect(parseOnlineOverview(null).ok).toBe(false);
    expect(parseOnlineOverview([1, 2]).ok).toBe(false);
  });

  it('survives `numbers` being absent entirely', () => {
    // A proxy answers with `numbers: {}` for session-derived metrics (spec §2),
    // so an empty or missing section is a normal response, not a malformed one.
    const result = parseOnlineOverview({ timestamp: 1 });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.last24h.sessions).toBeNull();
  });
});
