/**
 * Adapter for `GET /v1/serverOverview?server=<name>` (story S6.3, ADR-002).
 *
 * ## Shape observed, not guessed
 *
 * Every field below was read from a real response of the AusTV production Plan on
 * 2026-08-23. That matters: an earlier slice of this sprint was built on an
 * assumed state of a system nobody had read and had to be reverted, so nothing
 * here is inferred from documentation. The upstream wiki documents the Java
 * plugin API only and says nothing about these payloads.
 *
 * ## The two things this endpoint is not
 *
 * It returns **aggregate statistics for one server**, addressed by name. It is
 * not a catalogue of instances and it carries no Plan build number, so the
 * `plan.orphan_instance` and `plan.version_divergence` checks cannot be built on
 * it and are not attempted here.
 *
 * ## Why every number is `number | null`
 *
 * Plan does not use zero for "unknown" — it emits sentinel strings:
 * `"plugin.generic.unavailable"` for a metric the server cannot provide (TPS on a
 * proxy, for instance) and `"-"` for a percentage with no base. Both were seen in
 * the same production response.
 *
 * Coercing those to `0` would be the single worst bug this module could carry.
 * The whole epic exists because a collection gap was read as a real reading for
 * eight months, and the project rule is explicit: "sem dados" is different from
 * zero, and a gap is never filled with zero. So the sentinels become `null`, the
 * checks turn `null` into a `no_data` verdict, and `no_data` never renders as
 * healthy.
 *
 * Numeric fields also arrive with **mixed types** — `new_players` is a JSON
 * number while `online_players` and `average_tps` are strings — so the parser
 * accepts both rather than trusting either.
 */

/** Sentinels Plan uses for "this value does not exist", never for zero. */
const NO_DATA_SENTINELS = new Set([
  'plugin.generic.unavailable',
  '-',
  '',
  'null',
]);

/** Result of parsing, so a shape mismatch is a value rather than an exception. */
export type ParseResult<T> =
  { ok: true; value: T } | { ok: false; reason: string };

/**
 * The subset of `/v1/serverOverview` the health checks consume.
 *
 * Deliberately a subset. Mapping all ~40 fields would be more surface to break
 * on the next Plan upgrade, for data nothing reads.
 */
export interface ServerOverview {
  /** When Plan generated the response, epoch ms. */
  timestamp: number;
  last7Days: {
    /** New players in the window. `null` when Plan reported no data. */
    newPlayers: number | null;
    /** Distinct players in the 7-day window. */
    uniquePlayers: number | null;
    /** Distinct players today — the freshest collection signal available here. */
    uniquePlayersDay: number | null;
    /**
     * How many of `newPlayers` came back. The base for the retention ratio, so
     * the percentage can always be published with its `n` as the project
     * requires.
     */
    newPlayersRetention: number | null;
  };
  numbers: {
    /** Players connected right now. */
    onlinePlayers: number | null;
    /** Total sessions ever recorded for this server. */
    sessions: number | null;
    /** Distinct players ever seen. */
    totalPlayers: number | null;
    /** Epoch ms of the most recent player peak. */
    lastPeakDate: number | null;
  };
}

/**
 * Narrow an unknown body into {@link ServerOverview}.
 *
 * Returns a result instead of throwing so a caller can turn a shape mismatch into
 * an `error` verdict that names what was missing — which is far more useful in
 * Discord than a stack trace, and is what tells us a Plan upgrade changed the
 * contract.
 */
export function parseServerOverview(
  body: unknown,
): ParseResult<ServerOverview> {
  if (!isRecord(body)) {
    return { ok: false, reason: 'corpo do Plan nao e um objeto JSON' };
  }

  const timestamp = toNumber(body.timestamp);
  if (timestamp === null) {
    // The only field treated as mandatory: without it we cannot tell a fresh
    // response from a cached one, and every verdict built on it would be undated.
    return {
      ok: false,
      reason: 'campo `timestamp` ausente ou nao numerico na resposta do Plan',
    };
  }

  const last7Days = isRecord(body.last_7_days) ? body.last_7_days : {};
  const numbers = isRecord(body.numbers) ? body.numbers : {};

  return {
    ok: true,
    value: {
      timestamp,
      last7Days: {
        newPlayers: toNumber(last7Days.new_players),
        uniquePlayers: toNumber(last7Days.unique_players),
        uniquePlayersDay: toNumber(last7Days.unique_players_day),
        newPlayersRetention: toNumber(last7Days.new_players_retention),
      },
      numbers: {
        onlinePlayers: toNumber(numbers.online_players),
        sessions: toNumber(numbers.sessions),
        totalPlayers: toNumber(numbers.total_players),
        lastPeakDate: toNumber(numbers.last_peak_date),
      },
    },
  };
}

/**
 * Coerce a Plan field to a number, or `null` when it carries no measurement.
 *
 * `null` is returned for the sentinels, for unparseable strings and for absent
 * fields. It is **never** returned as `0` — a caller that cannot tell "nobody
 * joined" from "we did not measure" will eventually publish the second as the
 * first, which is the failure this whole epic was built to prevent.
 */
export function toNumber(raw: unknown): number | null {
  if (typeof raw === 'number') {
    return Number.isFinite(raw) ? raw : null;
  }

  if (typeof raw !== 'string') {
    return null;
  }

  const trimmed = raw.trim();
  if (NO_DATA_SENTINELS.has(trimmed)) {
    return null;
  }

  // Percentages arrive as "58.14%"; the number is what matters.
  const withoutSuffix = trimmed.endsWith('%') ? trimmed.slice(0, -1) : trimmed;
  if (withoutSuffix === '') {
    return null;
  }

  const parsed = Number(withoutSuffix);
  return Number.isFinite(parsed) ? parsed : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
