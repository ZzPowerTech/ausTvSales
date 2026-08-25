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
  /** Why the fetch failed, when it did. Null on `fresh` and `miss`. */
  reason: string | null;
}

interface Entry {
  value: unknown;
  storedAt: Date;
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
 */
@Injectable()
export class PlanCache {
  private readonly logger = new Logger(PlanCache.name);
  private readonly entries = new Map<string, Entry>();

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
        reason: null,
      };
    }

    try {
      const value = await fetch();
      this.store(key, value, now);
      this.log(key, 'miss', 0, ttlMs, null);
      return {
        outcome: 'miss',
        value,
        storedAt: now,
        ageMs: 0,
        reason: null,
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
          reason,
        };
      }

      this.log(key, 'unavailable', null, ttlMs, reason);
      return {
        outcome: 'unavailable',
        value: null,
        storedAt: null,
        ageMs: null,
        reason,
      };
    }
  }

  /** Drop everything. Exists for tests and for a future admin action. */
  clear(): void {
    this.entries.clear();
  }

  private store(key: string, value: unknown, now: Date): void {
    if (this.entries.size >= MAX_ENTRIES && !this.entries.has(key)) {
      // Insertion order is fine as an eviction rule here: the key space is a
      // handful of endpoints times the configured servers, so hitting this at
      // all means something is generating keys it should not be, and dropping
      // the oldest is a better failure than growing without bound.
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
