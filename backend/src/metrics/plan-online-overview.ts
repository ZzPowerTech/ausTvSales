import {
  toNumber,
  type ParseResult,
} from '../instrumentation/plan-server-overview';

/**
 * Adapter for `GET /v1/onlineOverview?server=<name>` (story S7.2, ADR-002).
 *
 * ## Shape observed, not guessed
 *
 * Every field below was read from a real response of the AusTV production Plan
 * on 2026-08-25. That is the rule this project works under, and it is not
 * fussiness: the upstream documentation is a **Javadoc of the plugin's Java
 * API** and says nothing about these payloads, so anything written from the docs
 * would be written from imagination. An earlier slice of this epic was built on
 * an assumed state of a system nobody had read and had to be reverted.
 *
 * ## What this endpoint is
 *
 * Playerbase activity for one server across three fixed windows — 24h, 7d and
 * 30d. Arrivals, distinct players, sessions, playtime, session length and
 * new-player retention. It is the closest thing Plan offers to the funnel this
 * epic is being built to measure, and unlike `serverOverview` it carries the
 * **base beside every ratio**: `new_players_retention_7d` (24) sits next to
 * `new_players_7d` (36), which is the 66.67% the payload also prints as a
 * string.
 *
 * That matters because the project rule is that no percentage is published
 * without its base. This source satisfies it without any arithmetic of ours, so
 * the parser keeps both numbers and never keeps the pre-formatted percentage.
 *
 * ## Three shapes in one object
 *
 * `numbers` mixes them freely, so the parser trusts none of them:
 *
 * - JSON number — `new_players_7d: 36`
 * - string with a suffix — `new_players_retention_7d_perc: "66.67%"`
 * - trend object — `sessions_30d_trend: { text, direction, reversed }`
 *
 * The trend objects are deliberately **not** mapped. They are a presentation
 * concern of Plan's own React page: a pre-formatted string plus an arrow, with
 * no window attached to the comparison. Publishing them would be publishing a
 * number whose meaning we cannot state.
 *
 * ## Durations stay in milliseconds
 *
 * Plan reports playtime and session length in ms (`playtime_7d: 3833062041` is
 * ~44 days of accumulated play, not 44 seconds). The field names carry `Ms` so
 * the unit travels with the value — a silent factor of 1000 in a metric nobody
 * can eyeball is exactly the kind of error this epic keeps finding.
 */

/** A ratio and the base it was computed from. Never one without the other. */
export interface Ratio {
  /** Count of the numerator — e.g. new players that came back. */
  value: number | null;
  /** Count of the denominator — e.g. new players in the window. */
  n: number | null;
}

/** One time window of playerbase activity. */
export interface OnlineWindow {
  /** Players whose first session on this server fell inside the window. */
  newPlayers: number | null;
  /** Distinct players seen in the window. */
  uniquePlayers: number | null;
  /** Sessions started in the window. */
  sessions: number | null;
  /** Accumulated playtime across the window, in milliseconds. */
  playtimeMs: number | null;
  /** Mean session length in the window, in milliseconds. */
  sessionLengthAvgMs: number | null;
  /**
   * New players that came back, over new players in the window.
   *
   * Kept as numerator and denominator rather than the percentage Plan also
   * prints, so a consumer can never render a rate without its base.
   */
  newPlayerRetention: Ratio;
}

/** The subset of `/v1/onlineOverview` this API republishes. */
export interface OnlineOverview {
  /** When Plan generated the response, epoch ms. */
  timestamp: number;
  last24h: OnlineWindow;
  last7d: OnlineWindow;
  last30d: OnlineWindow;
}

/**
 * The three windows Plan exposes, as they appear in the field names.
 *
 * A union rather than a runtime array: nothing iterates the windows — the three
 * are named individually in {@link OnlineOverview} so the contract stays a fixed
 * shape a consumer can rely on, instead of a map whose keys depend on what Plan
 * happened to return.
 */
type WindowSuffix = '24h' | '7d' | '30d';

/**
 * Narrow an unknown body into {@link OnlineOverview}.
 *
 * Returns a result rather than throwing, so a shape mismatch becomes a value the
 * caller can turn into an honest "could not read this" instead of a stack trace
 * — and so a Plan upgrade that changes the contract is visible as a message
 * naming what went missing.
 */
export function parseOnlineOverview(
  body: unknown,
): ParseResult<OnlineOverview> {
  if (!isRecord(body)) {
    return { ok: false, reason: 'corpo do Plan nao e um objeto JSON' };
  }

  const timestamp = toNumber(body.timestamp);
  if (timestamp === null) {
    // The only mandatory field. Without it there is no way to tell a fresh
    // response from a cached one, and every value below would be undated.
    return {
      ok: false,
      reason: 'campo `timestamp` ausente ou nao numerico na resposta do Plan',
    };
  }

  const numbers = isRecord(body.numbers) ? body.numbers : {};

  return {
    ok: true,
    value: {
      timestamp,
      last24h: readWindow(numbers, '24h'),
      last7d: readWindow(numbers, '7d'),
      last30d: readWindow(numbers, '30d'),
    },
  };
}

function readWindow(
  numbers: Record<string, unknown>,
  window: WindowSuffix,
): OnlineWindow {
  return {
    newPlayers: toNumber(numbers[`new_players_${window}`]),
    uniquePlayers: toNumber(numbers[`unique_players_${window}`]),
    sessions: toNumber(numbers[`sessions_${window}`]),
    playtimeMs: toNumber(numbers[`playtime_${window}`]),
    sessionLengthAvgMs: toNumber(numbers[`session_length_${window}_avg`]),
    newPlayerRetention: {
      value: toNumber(numbers[`new_players_retention_${window}`]),
      // The denominator is the arrivals of the same window — the same field the
      // window already publishes. Reading it here rather than referencing the
      // parsed value keeps the ratio self-contained: if arrivals go missing, the
      // ratio reports no base instead of quietly borrowing one.
      n: toNumber(numbers[`new_players_${window}`]),
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
