import {
  type ParseResult,
  toNumber,
} from '../instrumentation/plan-server-overview';

/**
 * Adapter for `GET /v1/retention` (story S8.2, ADR-002).
 *
 * ## What was observed, and what was not — read this before editing
 *
 * The body was read against the production Plan on **2026-08-29** and
 * `HANDOFF.md` records what it found: *5565 linhas, uma por jogador, com
 * `playerUUID`, `registerDate`, `lastSeenDate`, `playtime` e `timeDifference`*.
 *
 * That is the **field names and the row count**. It is not the JSON types of
 * those fields, and it is not the envelope the array arrives in — neither was
 * written down, and this session has no access to the instance to look.
 *
 * The repo's rule is not to write parsers against an unobserved contract; story
 * S6.2 was written, merged and reverted for exactly that. The rule is honoured
 * here in the only way still available: the parser is written to be **tolerant
 * about the shapes it has not seen and loud when it cannot find what it needs**.
 * It never guesses a value, it never substitutes zero, and a mismatch comes back
 * as `{ ok: false, reason }` that names the missing piece — which is what turns
 * the first production run into the observation nobody has made yet.
 *
 * Concretely, three unknowns are handled rather than assumed:
 *
 * 1. **Envelope.** A bare array is accepted; so is an object holding exactly one
 *    array-valued property (`{ players: [...] }`, `{ data: [...] }`, whatever it
 *    turns out to be). An object with two array properties is ambiguous and is
 *    refused instead of picked from.
 * 2. **Date encoding.** Epoch milliseconds, epoch seconds and parseable date
 *    strings are all accepted. See {@link toEpochMs} for why the seconds
 *    heuristic is safe on this dataset.
 * 3. **Field spelling.** `playerUUID` is what was recorded; `playerUuid` and
 *    `uuid` are accepted alongside it, because a case convention read once from
 *    a console is a weak observation and being wrong about it would produce
 *    `unknown` for every platform in the report — a plausible-looking result,
 *    which is the dangerous kind.
 *
 * ## Two fields deliberately dropped
 *
 * `playtime` and `timeDifference` are not read. Retention by cohort needs the
 * two dates and the uuid; carrying more of someone else's schema is more surface
 * to break on the next Plan upgrade, for data nothing consumes.
 */

/** One row of `/v1/retention`, narrowed to what cohort retention needs. */
export interface RetentionPlayer {
  /** Player UUID — read to derive `platform` (ADR-003), then dropped. */
  uuid: string;
  /** `registerDate`, epoch ms. */
  registeredAt: number;
  /** `lastSeenDate`, epoch ms. */
  lastSeenAt: number;
}

/** Accepted spellings of the uuid field. First match wins. */
const UUID_KEYS = ['playerUUID', 'playerUuid', 'playeruuid', 'uuid'] as const;
const REGISTERED_KEYS = ['registerDate', 'registered', 'registerdate'] as const;
const LAST_SEEN_KEYS = ['lastSeenDate', 'lastSeen', 'lastseendate'] as const;

/**
 * Below this, a numeric date is epoch **seconds** rather than milliseconds.
 *
 * `1e11` ms is 1973-03-03 and `1e11` s is the year 5138 — no real value from
 * this dataset (which starts in 2024-06) can be on the wrong side of it in
 * either encoding. The alternative, assuming milliseconds, would silently file
 * every 2026 player under 1970 and produce a report of empty cohorts that looks
 * like a data outage rather than like a unit bug.
 */
const SECONDS_CEILING = 1e11;

/**
 * Narrow an unknown `/v1/retention` body into rows.
 *
 * Rows that cannot be read are **dropped and counted**, not defaulted: a player
 * with an unparseable `registerDate` belongs to no cohort, and putting them in
 * an arbitrary one would move a number that whoever reads it cannot audit. The
 * count comes back so the caller can say how much of the payload it understood.
 */
export function parseRetention(body: unknown): ParseResult<ParsedRetention> {
  const rowsResult = findRows(body);
  if (!rowsResult.ok) {
    return rowsResult;
  }

  const players: RetentionPlayer[] = [];
  let dropped = 0;

  for (const row of rowsResult.value) {
    if (!isRecord(row)) {
      dropped++;
      continue;
    }

    const uuid = firstString(row, UUID_KEYS);
    const registeredAt = toEpochMs(firstDefined(row, REGISTERED_KEYS));
    const lastSeenAt = toEpochMs(firstDefined(row, LAST_SEEN_KEYS));

    if (uuid === null || registeredAt === null || lastSeenAt === null) {
      dropped++;
      continue;
    }

    players.push({ uuid, registeredAt, lastSeenAt });
  }

  // Every row unreadable is a contract mismatch, not an empty population. The
  // difference matters: the first reads as "Plan changed shape", the second as
  // "nobody ever registered", and this module must never report the second by
  // accident. A genuinely empty array is allowed through — that is a real,
  // if implausible, answer, and it produces a report with no cohorts rather
  // than a false failure.
  if (players.length === 0 && dropped > 0) {
    return {
      ok: false,
      reason:
        `nenhuma das ${dropped} linhas de /v1/retention tinha os campos ` +
        `esperados (${UUID_KEYS[0]}, ${REGISTERED_KEYS[0]}, ${LAST_SEEN_KEYS[0]})`,
    };
  }

  return {
    ok: true,
    value: { players, rows: rowsResult.value.length, dropped },
  };
}

/** What one parse produced, plus how much of the payload it had to discard. */
export interface ParsedRetention {
  players: RetentionPlayer[];
  /** Rows the payload carried. */
  rows: number;
  /** Rows dropped for missing or unreadable fields. */
  dropped: number;
}

/**
 * Locate the array of players inside whatever envelope Plan used.
 *
 * Refuses ambiguity rather than resolving it. If a future Plan version answers
 * `{ players: [...], servers: [...] }`, picking the first array would be a coin
 * flip whose wrong side is a report full of plausible numbers about the wrong
 * population.
 */
function findRows(body: unknown): ParseResult<unknown[]> {
  if (Array.isArray(body)) {
    return { ok: true, value: body };
  }

  if (!isRecord(body)) {
    return {
      ok: false,
      reason: 'corpo de /v1/retention nao e um array nem um objeto JSON',
    };
  }

  const arrays = Object.entries(body).filter(([, value]) =>
    Array.isArray(value),
  );

  if (arrays.length === 1) {
    return { ok: true, value: arrays[0][1] as unknown[] };
  }

  return {
    ok: false,
    reason:
      arrays.length === 0
        ? 'corpo de /v1/retention nao contem nenhuma lista de jogadores'
        : `corpo de /v1/retention tem ${arrays.length} listas (${arrays
            .map(([key]) => key)
            .join(', ')}) e nao da para saber qual e a de jogadores`,
  };
}

/**
 * Coerce a Plan date field to epoch milliseconds.
 *
 * Accepts the three encodings the payload could plausibly use, and returns
 * `null` for everything else. Never `0` and never "now": a row whose date
 * cannot be read is dropped by the caller, because filing it under an invented
 * day is precisely how a measurement stops being auditable.
 */
export function toEpochMs(raw: unknown): number | null {
  const numeric = toNumber(raw);
  if (numeric !== null) {
    if (numeric <= 0) {
      return null;
    }
    return numeric < SECONDS_CEILING ? numeric * 1000 : numeric;
  }

  if (typeof raw !== 'string') {
    return null;
  }

  const trimmed = raw.trim();

  // An explicit offset is REQUIRED, and refusing the string without one is the
  // point rather than an inconvenience. Two ways a bare string goes wrong, both
  // silent:
  //
  //  - `2026-09-01` is UTC midnight by spec, which is 21:00 BRT of the PREVIOUS
  //    day. Every player registering on the 1st would land in the previous
  //    month's cohort, and every `lastSeenDate` would shift a day — moving the
  //    stamp-day histogram with it.
  //  - `2026-09-02 01:00:00` (a MySQL DATETIME rendering) is parsed by V8 as
  //    **process-local** time, so the answer would depend on the container's TZ.
  //
  // The repo rule is not to guess an unobserved contract. The field types of
  // `/v1/retention` were never recorded, so a string without an offset is
  // refused: the row is dropped, counted, and published as dropped.
  if (!HAS_TIMEZONE.test(trimmed)) {
    return null;
  }

  const parsed = Date.parse(trimmed);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

/**
 * A time of day followed by an explicit UTC offset.
 *
 * The time half is not decoration, and leaving it out was a bug: `2026-09-01`
 * ends in `-01`, which reads as an offset of minus one hour to a pattern that
 * only looks at the tail. V8 then parses the date-only form as **UTC midnight**,
 * which is 21:00 BRT of the previous day — the exact silent shift this guard
 * exists to refuse, let through by the guard itself.
 */
const HAS_TIMEZONE = /\d{2}:\d{2}(:\d{2})?(\.\d+)?\s*(Z|[+-]\d{2}(:?\d{2})?)$/i;

/**
 * Canonical dashed UUID, the only form ADR-003 can classify.
 *
 * The field NAME got careful treatment (three accepted spellings, because being
 * wrong about it "would produce `unknown` for every platform — a
 * plausible-looking result, which is the dangerous kind"). The VALUE did not,
 * and it has the same failure: an undashed or truncated uuid classifies as
 * `unknown` for every row, and a cohort table full of `unknown` still carries
 * real-looking percentages. Rows that do not match are dropped and counted, so
 * the failure surfaces as a drop count instead of as a platform split.
 */
const CANONICAL_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function firstDefined(
  row: Record<string, unknown>,
  keys: readonly string[],
): unknown {
  for (const key of keys) {
    if (row[key] !== undefined && row[key] !== null) {
      return row[key];
    }
  }
  return undefined;
}

function firstString(
  row: Record<string, unknown>,
  keys: readonly string[],
): string | null {
  const value = firstDefined(row, keys);
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  // Shape-checked, not merely non-empty — see `CANONICAL_UUID`.
  return CANONICAL_UUID.test(trimmed) ? trimmed : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
