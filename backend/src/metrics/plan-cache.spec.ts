import { PlanCache } from './plan-cache';

const TTL = 60_000;
const T0 = new Date('2026-08-25T12:00:00.000Z');

function at(msAfterT0: number): Date {
  return new Date(T0.getTime() + msAfterT0);
}

describe('PlanCache', () => {
  let cache: PlanCache;

  beforeEach(() => {
    cache = new PlanCache();
  });

  it('fetches on the first read and reports a miss', async () => {
    const fetch = jest.fn().mockResolvedValue({ players: 8 });

    const result = await cache.read('serverOverview:Survival', TTL, fetch, T0);

    expect(result).toEqual({
      outcome: 'miss',
      value: { players: 8 },
      storedAt: T0,
      ageMs: 0,
      reason: null,
      error: null,
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('serves from cache inside the TTL without touching Plan', async () => {
    // The whole point: an uncached read is an HTTP request to a webserver
    // running inside the Minecraft process, on the machine players are on.
    const fetch = jest.fn().mockResolvedValue({ players: 8 });
    await cache.read('k', TTL, fetch, T0);

    const result = await cache.read('k', TTL, fetch, at(TTL - 1));

    expect(result.outcome).toBe('fresh');
    expect(result.ageMs).toBe(TTL - 1);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('refetches once the TTL has passed', async () => {
    const fetch = jest
      .fn()
      .mockResolvedValueOnce({ players: 8 })
      .mockResolvedValueOnce({ players: 12 });
    await cache.read('k', TTL, fetch, T0);

    const result = await cache.read('k', TTL, fetch, at(TTL));

    expect(result.outcome).toBe('miss');
    expect(result.value).toEqual({ players: 12 });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('keeps separate entries per key, so TTLs do not collide', async () => {
    // TTL is per endpoint on purpose: `serverOverview` carries a live player
    // count worth refetching, `onlineOverview` is 30-day aggregates that barely
    // move. Sharing an entry would force one of the two to be wrong.
    const server = jest.fn().mockResolvedValue('server');
    const online = jest.fn().mockResolvedValue('online');

    await cache.read('serverOverview:Survival', TTL, server, T0);
    const result = await cache.read('onlineOverview:Survival', TTL, online, T0);

    expect(result.outcome).toBe('miss');
    expect(result.value).toBe('online');
    expect(server).toHaveBeenCalledTimes(1);
  });

  it('serves the previous value marked stale when Plan fails', async () => {
    const fetch = jest
      .fn()
      .mockResolvedValueOnce({ players: 8 })
      .mockRejectedValueOnce(new Error('Plan inalcancavel em http://x/v1/y'));
    await cache.read('k', TTL, fetch, T0);

    const result = await cache.read('k', TTL, fetch, at(TTL + 5_000));

    expect(result.outcome).toBe('stale');
    expect(result.value).toEqual({ players: 8 });
    expect(result.storedAt).toEqual(T0);
    // The real age, not a rounded-up one. A stale value that lies about how old
    // it is defeats the point of admitting it is stale.
    expect(result.ageMs).toBe(TTL + 5_000);
    expect(result.reason).toBe('Plan inalcancavel em http://x/v1/y');
  });

  it('reports unavailable with a null value when there is nothing cached', async () => {
    // Never an empty object and never zeros. "We could not ask" and "the answer
    // is zero" are different facts, and this epic exists because eight months of
    // the first were read as the second.
    const fetch = jest.fn().mockRejectedValue(new Error('recusou'));

    const result = await cache.read('k', TTL, fetch, T0);

    expect(result).toEqual({
      outcome: 'unavailable',
      value: null,
      storedAt: null,
      ageMs: null,
      reason: 'recusou',
      error: expect.any(Error) as Error,
    });
  });

  it('hands the error object over so the caller can classify it', async () => {
    // The cache knows about caching, not about Plan's error taxonomy. Teaching
    // it would put the same knowledge in two places; handing the error over
    // keeps the classification where the contract is decided.
    class Peculiar extends Error {}
    const fetch = jest.fn().mockRejectedValue(new Peculiar('especifico'));

    const result = await cache.read('k', TTL, fetch, T0);

    expect(result.error).toBeInstanceOf(Peculiar);
  });

  it('collapses concurrent misses into a single fetch', async () => {
    // A TTL bounds how OFTEN Plan is asked, not how many ask at once. Five
    // requests on a cold key would otherwise be five HTTP calls to a webserver
    // running inside the Minecraft process — the stampede this class exists to
    // prevent, on the axis a TTL alone does not cover.
    let release!: (value: string) => void;
    const fetch = jest
      .fn()
      .mockReturnValue(new Promise<string>((resolve) => (release = resolve)));

    const reads = Promise.all(
      Array.from({ length: 5 }, () => cache.read('k', TTL, fetch, T0)),
    );
    release('um');
    const results = await reads;

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(results.map((r) => r.value)).toEqual(['um', 'um', 'um', 'um', 'um']);
    // Every joiner reports the instant the SHARED request started, not the
    // instant it personally got the answer.
    expect(
      new Set(results.map((r) => r.storedAt?.toISOString())),
    ).toHaveProperty('size', 1);
  });

  it('lets the next caller retry after a shared fetch fails', async () => {
    // The in-flight entry must be cleared on rejection too. Leaving it would
    // make every later caller await an already-failed promise forever.
    const fetch = jest
      .fn()
      .mockRejectedValueOnce(new Error('caiu'))
      .mockResolvedValueOnce('depois');

    const first = await cache.read('k', TTL, fetch, T0);
    const second = await cache.read('k', TTL, fetch, T0);

    expect(first.outcome).toBe('unavailable');
    expect(second.outcome).toBe('miss');
    expect(second.value).toBe('depois');
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('keeps an expired entry so a later outage can still fall back to it', async () => {
    // Expiry means "worth refetching", not "worth forgetting". Evicting at TTL
    // would turn a Plan outage into `unavailable` after one minute, when a
    // ten-minute-old reading is the most useful thing anyone has.
    const fetch = jest
      .fn()
      .mockResolvedValueOnce('primeiro')
      .mockRejectedValue(new Error('caiu'));
    await cache.read('k', TTL, fetch, T0);

    const result = await cache.read('k', TTL, fetch, at(10 * TTL));

    expect(result.outcome).toBe('stale');
    expect(result.value).toBe('primeiro');
  });

  it('recovers to fresh data once Plan answers again', async () => {
    const fetch = jest
      .fn()
      .mockResolvedValueOnce('velho')
      .mockRejectedValueOnce(new Error('caiu'))
      .mockResolvedValueOnce('novo');
    await cache.read('k', TTL, fetch, T0);
    await cache.read('k', TTL, fetch, at(TTL));

    const result = await cache.read('k', TTL, fetch, at(2 * TTL));

    expect(result.outcome).toBe('miss');
    expect(result.value).toBe('novo');
  });

  it('does not replace a good value with a failure', async () => {
    // A failed fetch must leave the entry alone. Overwriting it with the error
    // would destroy the fallback at the exact moment it is needed.
    const fetch = jest
      .fn()
      .mockResolvedValueOnce('bom')
      .mockRejectedValueOnce(new Error('caiu'))
      .mockRejectedValueOnce(new Error('caiu de novo'));
    await cache.read('k', TTL, fetch, T0);
    await cache.read('k', TTL, fetch, at(TTL));

    const result = await cache.read('k', TTL, fetch, at(2 * TTL));

    expect(result.outcome).toBe('stale');
    expect(result.value).toBe('bom');
    expect(result.storedAt).toEqual(T0);
  });

  it('forgets everything on clear', async () => {
    const fetch = jest.fn().mockResolvedValue('v');
    await cache.read('k', TTL, fetch, T0);

    cache.clear();
    await cache.read('k', TTL, fetch, T0);

    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
