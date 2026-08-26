import { Injectable, Logger } from '@nestjs/common';

/**
 * How an entry was served. Published in the log line and used by the service to
 * decide the HTTP status, so it is part of the contract rather than a detail.
 */
export type CacheOutcome =
  /** Served from cache, inside its TTL. Plan was not contacted. */
  | 'fresh'
  /** Fetched from Plan, because there was nothing or the TTL had passed. */
  | 'miss'
  /** Plan failed and a previous value was served instead, marked stale. */
  | 'stale'
  /** Plan failed and there is no previous value. Nothing to serve. */
  | 'unavailable';

export interface CacheResult<T> {
  outcome: CacheOutcome;
  /** Null only when `outcome` is `unavailable`. */
  value: T | null;
  /** When the served value was fetched from Plan. Null when unavailable. */
  storedAt: Date | null;
  /** Age of the served value in milliseconds. Null when unavailable. */
  ageMs: number | null;
  /**
   * The failure itself, for a caller that needs to classify it.
   *
   * Handed over rather than pre-classified here: this class is generic over
   * `fetch`, so teaching it Plan's error taxonomy would weld a reusable cache to
   * one upstream — and the S8.2 cohort module is a second consumer waiting.
   *
   * There is deliberately **no** `reason: string` beside it. The raw message
   * carries the Plan URL and, for some failures, an excerpt of Plan's own
   * response body; it is logged here and goes no further. A field holding it on
   * the object the service passes around is a spread away from being republished,
   * which is the bug this contract was already corrected for once.
   */
  error: unknown;
}

interface Entry {
  value: unknown;
  storedAt: Date;
}

/** A fetch already in progress for a key, awaited instead of duplicated. */
interface InFlight {
  promise: Promise<unknown>;
  startedAt: Date;
}

/** Safety net; the real bound is the handful of endpoints x configured servers. */
const MAX_ENTRIES = 200;

/**
 * Read-through cache in front of the Plan API (story S7.2, issue #111).
 *
 * ## The cache is protection, not optimisation
 *
 * Spec §8 lists "query pesada afeta o jogo" as a real item on the attack
 * surface. Every uncached read here becomes an HTTP request to a webserver
 * running **inside the Minecraft process**, on the machine players are connected
 * to. Without a TTL, a dashboard left open in a browser tab — or a frontend
 * polling loop nobody noticed — is a load generator pointed at production.
 *
 * That is why the TTL is per endpoint rather than global: `serverOverview`
 * carries `online_players`, which changes minute to minute and is worth
 * refetching; `onlineOverview` is 24h/7d/30d aggregates that barely move inside
 * an hour, and refetching those every minute would be paying the game server for
 * a number that did not change.
 *
 * ## Stale is served, and it says so
 *
 * When Plan cannot be reached and a previous value exists, that value is
 * returned with `outcome: 'stale'` and the age it actually has. It is never
 * silently refreshed and never rounded up to fresh.
 *
 * When Plan cannot be reached and there is **no** previous value, the outcome is
 * `unavailable` and the value is `null` — never an empty object, never zeros.
 * "We could not ask" and "the answer is zero" are different facts, and the whole
 * epic exists because eight months of the first were read as the second.
 *
 * ## Why entries are kept past their TTL
 *
 * An expired entry is not evicted, because expiry means "worth refetching", not
 * "worth forgetting". The stale fallback above is the reason: dropping the value
 * at TTL would turn a Plan outage into `unavailable` after one minute, when a
 * ten-minute-old reading is still the most useful thing anyone has.
 *
 * ## Concurrent readers share one fetch
 *
 * A TTL bounds how *often* Plan is asked, but on its own it does nothing about
 * how many ask at the same instant: N requests arriving on a cold or
 * just-expired key would each miss and each issue their own HTTP call. That is
 * the stampede, and it lands on a webserver inside the Minecraft process — the
 * precise thing this class exists to prevent, so bounding the rate and leaving
 * the concurrency open would be protecting the wrong axis.
 *
 * So an in-flight fetch is recorded and later callers await it instead of
 * starting a second one. They all get the same value and the same outcome; only
 * one request leaves the process.
 *
 * ## The failure reason does not leave this class
 *
 * `CacheResult.reason` is the raw error message, which carries the Plan URL and
 * sometimes an excerpt of Plan's own response body (an HTML login page, when
 * auth is misconfigured). It belongs in the log, where it already goes. A caller
 * publishing it over HTTP would be pushing internal topology and unfiltered
 * upstream content across a trust boundary — `MetricsService` classifies it
 * before it reaches a response.
 */
@Injectable()
export class PlanCache {
  private readonly logger = new Logger(PlanCache.name);
  private readonly entries = new Map<string, Entry>();
  private readonly inFlight = new Map<string, InFlight>();

  /**
   * Serve `key` from cache, or call `fetch` and store what it returns.
   *
   * `fetch` is expected to throw on failure — that is how the transport already
   * reports trouble, and translating it into a sentinel here would be one more
   * place for "no data" and "could not ask" to be confused.
   */
  async read<T>(
    key: string,
    ttlMs: number,
    fetch: () => Promise<T>,
    now: Date = new Date(),
  ): Promise<CacheResult<T>> {
    const cached = this.entries.get(key);
    const age = cached ? now.getTime() - cached.storedAt.getTime() : null;

    if (cached && age !== null && age < ttlMs) {
      this.log(key, 'fresh', age, ttlMs, null);
      return {
        outcome: 'fresh',
        value: cached.value as T,
        storedAt: cached.storedAt,
        ageMs: age,
        error: null,
      };
    }

    try {
      const { value, startedAt } = await this.fetchOnce(key, ttlMs, fetch, now);
      return {
        outcome: 'miss',
        value: value as T,
        storedAt: startedAt,
        ageMs: Math.max(0, now.getTime() - startedAt.getTime()),
        error: null,
      };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);

      if (cached && age !== null) {
        this.log(key, 'stale', age, ttlMs, reason);
        return {
          outcome: 'stale',
          value: cached.value as T,
          storedAt: cached.storedAt,
          ageMs: age,
          error,
        };
      }

      this.log(key, 'unavailable', null, ttlMs, reason);
      return {
        outcome: 'unavailable',
        value: null,
        storedAt: null,
        ageMs: null,
        error,
      };
    }
  }

  /** Drop everything. Exists for tests and for a future admin action. */
  clear(): void {
    this.entries.clear();
    this.inFlight.clear();
  }

  /**
   * Run `fetch` for `key`, or join the call already running for it.
   *
   * The entry is stored here rather than by the caller so that every joiner sees
   * the same `storedAt` — the instant the *shared* request started, not the
   * instant each of them happened to be handed the result.
   */
  private async fetchOnce(
    key: string,
    ttlMs: number,
    fetch: () => Promise<unknown>,
    now: Date,
  ): Promise<{ value: unknown; startedAt: Date }> {
    const running = this.inFlight.get(key);
    if (running) {
      this.logger.debug(
        `Plan cache coalesce: ${key} — juntando-se a uma busca ja em andamento`,
      );
      return {
        value: await running.promise,
        startedAt: running.startedAt,
      };
    }

    const promise = fetch();
    this.inFlight.set(key, { promise, startedAt: now });

    try {
      const value = await promise;
      this.store(key, value, now);
      this.log(key, 'miss', 0, ttlMs, null);
      return { value, startedAt: now };
    } finally {
      // `finally`, not the success path: a rejection that left the entry behind
      // would make every later caller await an already-failed promise forever.
      //
      // Guarded on identity because `clear()` can empty the map mid-flight. An
      // unconditional delete would then remove the registration of a *newer*
      // leader started after the clear, and the reader after that would open a
      // second concurrent fetch for the same key — the stampede this method
      // exists to close, reintroduced by the cleanup of the previous one.
      if (this.inFlight.get(key)?.promise === promise) {
        this.inFlight.delete(key);
      }
    }
  }

  private store(key: string, value: unknown, now: Date): void {
    if (this.entries.size >= MAX_ENTRIES && !this.entries.has(key)) {
      // Eviction is by FIRST insertion, not by last use — `Map.set` on an
      // existing key keeps its original position, so this is not an LRU and
      // would happily evict the hottest entry. That is acceptable only because
      // the bound is unreachable: keys are `<endpoint>:<configured server>`,
      // and the server is always the name resolved from `PLAN_SERVERS`, never
      // the caller's string. The key space is exactly 2 x |PLAN_SERVERS|.
      //
      // Reaching this at all therefore means something started generating keys
      // per request, and the warning below is the point — the eviction is just
      // a better failure than growing without bound.
      const oldest = this.entries.keys().next();
      if (!oldest.done) {
        this.entries.delete(oldest.value);
        this.logger.warn(
          `Cache do Plan atingiu ${MAX_ENTRIES} entradas; removendo "${oldest.value}". ` +
            'Isso nao deveria acontecer com o numero de endpoints e servidores ' +
            'configurados — verifique se alguma chave esta sendo gerada por request.',
        );
      }
    }

    this.entries.set(key, { value, storedAt: now });
  }

  /**
   * One line per read, at a level that matches what happened.
   *
   * Criterion 2 of the story asks for the cache to be observable in the log, and
   * the reason is operational: without it, "the dashboard is slow" and "the
   * dashboard is hammering the game server" look identical from the outside.
   *
   * A stale read is a warning because it means Plan is failing — the value being
   * usable does not make the outage less real.
   */
  private log(
    key: string,
    outcome: CacheOutcome,
    ageMs: number | null,
    ttlMs: number,
    reason: string | null,
  ): void {
    const age = ageMs === null ? 'sem valor' : `${Math.round(ageMs / 1000)}s`;
    const line =
      `Plan cache ${outcome}: ${key} (idade ${age}, ttl ${Math.round(ttlMs / 1000)}s)` +
      (reason ? ` — ${reason}` : '');

    if (outcome === 'stale' || outcome === 'unavailable') {
      this.logger.warn(line);
      return;
    }
    this.logger.log(line);
  }
}
