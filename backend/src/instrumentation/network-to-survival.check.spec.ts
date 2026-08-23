import { ConfigService } from '@nestjs/config';
import { NetworkToSurvivalCheck } from './network-to-survival.check';
import type { PlanApiClient } from './plan-api.client';
import { PlanUnreachableError } from './plan-api.errors';
import type { PlanDatabase } from './plan-database';
import { PlanServersConfig } from './plan-servers.config';

function config(values: Record<string, unknown> = {}): ConfigService {
  return {
    get: <T>(key: string): T | undefined => values[key] as T | undefined,
  } as unknown as ConfigService;
}

function serversConfig(values: Record<string, string>): PlanServersConfig {
  return new PlanServersConfig({
    get: <T>(key: string): T | undefined => values[key] as T | undefined,
  } as unknown as ConfigService);
}

function dbWith(total: number): PlanDatabase {
  return {
    networkArrivals: jest.fn(() =>
      Promise.resolve({ total, lastRegisteredAt: Date.now() }),
    ),
  } as unknown as PlanDatabase;
}

/**
 * Same double, with the spy handed back separately.
 *
 * Reading `db.networkArrivals` off the object to assert on it detaches the
 * method from its receiver, which `@typescript-eslint/unbound-method` flags —
 * and rightly so, since that is how a `this`-dependent method silently breaks.
 */
function dbWithSpy(total: number): { db: PlanDatabase; spy: jest.Mock } {
  const spy = jest.fn(() =>
    Promise.resolve({ total, lastRegisteredAt: Date.now() }),
  );
  return { db: { networkArrivals: spy } as unknown as PlanDatabase, spy };
}

/** `serverOverview` body carrying only the field this check reads. */
function overview(newPlayers: unknown): unknown {
  return {
    timestamp: 1787494648039,
    last_7_days: { new_players: newPlayers },
    numbers: {},
  };
}

function planWith(body: unknown): PlanApiClient {
  return {
    getJson: jest.fn(() => Promise.resolve(body)),
  } as unknown as PlanApiClient;
}

const ONE_BACKEND = {
  PLAN_SERVERS: 'AusTv,Survival',
  PLAN_PROXY_SERVER: 'AusTv',
};

describe('NetworkToSurvivalCheck', () => {
  describe('conversao', () => {
    it('passes at the historical rate of about 46%', async () => {
      // 43 of 93 is the shape of the real reading: Survival reported 43 new
      // players in 7 days on 2026-08-23.
      const [result] = await new NetworkToSurvivalCheck(
        planWith(overview(43)),
        dbWith(93),
        serversConfig(ONE_BACKEND),
        config(),
      ).run();

      expect(result.status).toBe('ok');
      expect(result.detail.observed).toBe(46.2);
      expect(result.detail.n).toBe(93);
    });

    it('breaches when the step gets worse', async () => {
      const [result] = await new NetworkToSurvivalCheck(
        planWith(overview(10)),
        dbWith(100),
        serversConfig(ONE_BACKEND),
        config(),
      ).run();

      expect(result.status).toBe('breached');
      expect(result.detail.observed).toBe(10);
      expect(result.detail.summary).toContain('degrau');
    });

    it('carries the denominator and the numerator together', async () => {
      const [result] = await new NetworkToSurvivalCheck(
        planWith(overview(43)),
        dbWith(93),
        serversConfig(ONE_BACKEND),
        config(),
      ).run();

      // A ratio never travels without its base.
      expect(result.detail.n).toBe(93);
      expect(result.detail.context?.chegadas_no_servidor).toBe(43);
    });

    it('honours a configured floor', async () => {
      const [result] = await new NetworkToSurvivalCheck(
        planWith(overview(43)),
        dbWith(93),
        serversConfig(ONE_BACKEND),
        config({ FUNNEL_MIN_NETWORK_TO_SERVER: 0.6 }),
      ).run();

      expect(result.status).toBe('breached');
      expect(result.detail.threshold).toBe(60);
    });
  });

  describe('escopo', () => {
    it('skips the proxy and evaluates each backend', async () => {
      const results = await new NetworkToSurvivalCheck(
        planWith(overview(43)),
        dbWith(93),
        serversConfig({
          PLAN_SERVERS: 'AusTv,Survival,Creative',
          PLAN_PROXY_SERVER: 'AusTv',
        }),
        config(),
      ).run();

      expect(results.map((r) => r.checkName)).toEqual([
        'funnel.network_to_survival:Survival',
        'funnel.network_to_survival:Creative',
      ]);
    });

    it('fetches the shared denominator once, not once per backend', async () => {
      const { db, spy } = dbWithSpy(93);

      await new NetworkToSurvivalCheck(
        planWith(overview(43)),
        db,
        serversConfig({
          PLAN_SERVERS: 'AusTv,Survival,Creative',
          PLAN_PROXY_SERVER: 'AusTv',
        }),
        config(),
      ).run();

      // One query against the game's database instead of N — spec §8 lists
      // query load on the game machine as a real risk.
      expect(spy).toHaveBeenCalledTimes(1);
    });

    it('returns nothing when no backend is configured', async () => {
      const results = await new NetworkToSurvivalCheck(
        planWith(overview(43)),
        dbWith(93),
        serversConfig({}),
        config(),
      ).run();

      expect(results).toEqual([]);
    });
  });

  describe('amostra pequena', () => {
    it('refuses to publish a ratio below the minimum sample', async () => {
      const [result] = await new NetworkToSurvivalCheck(
        planWith(overview(2)),
        dbWith(5),
        serversConfig(ONE_BACKEND),
        config(),
      ).run();

      // 2 of 5 is 40% and means nothing on a week of data.
      expect(result.status).toBe('no_data');
      expect(result.detail.observed).toBeUndefined();
      expect(result.detail.n).toBe(5);
    });
  });

  describe('numerador ausente', () => {
    it('reports no_data rather than an invented 0%', async () => {
      const [result] = await new NetworkToSurvivalCheck(
        planWith(overview('plugin.generic.unavailable')),
        dbWith(93),
        serversConfig(ONE_BACKEND),
        config(),
      ).run();

      // Treating the sentinel as zero would publish an alarming 0% conversion
      // invented out of a collection gap.
      expect(result.status).toBe('no_data');
      expect(result.detail.observed).toBeUndefined();
    });

    it('keeps a real zero as a real zero', async () => {
      const [result] = await new NetworkToSurvivalCheck(
        planWith(overview(0)),
        dbWith(93),
        serversConfig(ONE_BACKEND),
        config(),
      ).run();

      // Nobody reached the backend is a measurement, and an alarming one.
      expect(result.status).toBe('breached');
      expect(result.detail.observed).toBe(0);
    });
  });

  describe('falhas', () => {
    it('errors every backend when the denominator cannot be read', async () => {
      const db = {
        networkArrivals: jest.fn(() =>
          Promise.reject(new Error('ECONNREFUSED')),
        ),
      } as unknown as PlanDatabase;

      const results = await new NetworkToSurvivalCheck(
        planWith(overview(43)),
        db,
        serversConfig({
          PLAN_SERVERS: 'AusTv,Survival,Creative',
          PLAN_PROXY_SERVER: 'AusTv',
        }),
        config(),
      ).run();

      // Every backend loses its denominator at once, so every backend says so —
      // a silent gap for two of three would be worse than a repeated message.
      expect(results).toHaveLength(2);
      expect(results.every((r) => r.status === 'error')).toBe(true);
    });

    it('errors when Plan is unreachable for the numerator', async () => {
      const plan = {
        getJson: jest.fn(() => Promise.reject(new PlanUnreachableError('u'))),
      } as unknown as PlanApiClient;

      const [result] = await new NetworkToSurvivalCheck(
        plan,
        dbWith(93),
        serversConfig(ONE_BACKEND),
        config(),
      ).run();

      expect(result.status).toBe('error');
    });

    it('errors on an unexpected body instead of guessing', async () => {
      const [result] = await new NetworkToSurvivalCheck(
        planWith({ nada: 'aqui' }),
        dbWith(93),
        serversConfig(ONE_BACKEND),
        config(),
      ).run();

      expect(result.status).toBe('error');
      expect(result.detail.summary).toContain('timestamp');
    });
  });
});
