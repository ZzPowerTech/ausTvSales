import { ConfigService } from '@nestjs/config';
import { CollectionAliveCheck } from './collection-alive.check';
import type { PlanApiClient } from './plan-api.client';
import { PlanUnreachableError } from './plan-api.errors';
import { PlanServersConfig } from './plan-servers.config';

function serversConfig(values: Record<string, string>): PlanServersConfig {
  return new PlanServersConfig({
    get: <T>(key: string): T | undefined => values[key] as T | undefined,
  } as unknown as ConfigService);
}

/** Minimal body shaped like the real Plan response, with the two fields read. */
function overview(online: unknown, uniqueToday: unknown): unknown {
  return {
    timestamp: 1787494648039,
    last_7_days: { unique_players_day: uniqueToday },
    numbers: { online_players: online },
  };
}

function planReturning(body: unknown): PlanApiClient {
  return {
    getJson: jest.fn(() => Promise.resolve(body)),
  } as unknown as PlanApiClient;
}

const TWO_SERVERS = {
  PLAN_SERVERS: 'AusTv,Survival',
  PLAN_PROXY_SERVER: 'AusTv',
};

describe('CollectionAliveCheck', () => {
  describe('escopo', () => {
    it('skips the proxy entirely', async () => {
      const plan = planReturning(overview('8', 59));

      const results = await new CollectionAliveCheck(
        plan,
        serversConfig(TWO_SERVERS),
      ).run();

      // Proxies record users, not sessions, so every session-derived number is
      // structurally zero on one. Checking it would report a permanent outage
      // that does not exist — the exact false alarm raised by hand on
      // 2026-08-23 before a control query caught it.
      expect(results).toHaveLength(1);
      expect(results[0].checkName).toBe('plan.collection_alive:Survival');
    });

    it('emits one observation per backend', async () => {
      const plan = planReturning(overview('4', 12));

      const results = await new CollectionAliveCheck(
        plan,
        serversConfig({
          PLAN_SERVERS: 'Survival,Creative,AusTv',
          PLAN_PROXY_SERVER: 'AusTv',
        }),
      ).run();

      expect(results.map((r) => r.checkName)).toEqual([
        'plan.collection_alive:Survival',
        'plan.collection_alive:Creative',
      ]);
    });

    it('returns nothing when no server is configured', async () => {
      const plan = planReturning(overview('1', 1));

      const results = await new CollectionAliveCheck(
        plan,
        serversConfig({}),
      ).run();

      // "Nothing to evaluate" is not a verdict — the runner must not persist a
      // row claiming health for a system it never looked at.
      expect(results).toEqual([]);
    });
  });

  describe('veredito', () => {
    it('breaches when players are online but none were recorded today', async () => {
      const plan = planReturning(overview(7, 0));

      const [result] = await new CollectionAliveCheck(
        plan,
        serversConfig({ PLAN_SERVERS: 'Survival' }),
      ).run();

      // Arithmetically impossible while the recorder works, and immune to the
      // "quiet day" false positive that a raw player-count threshold would have.
      expect(result.status).toBe('breached');
      expect(result.detail.summary).toContain('coleta do Plan parou');
    });

    it('ships `n` beside the observed value on a breach', async () => {
      const plan = planReturning(overview(7, 0));

      const [result] = await new CollectionAliveCheck(
        plan,
        serversConfig({ PLAN_SERVERS: 'Survival' }),
      ).run();

      expect(result.detail.observed).toBe(0);
      expect(result.detail.n).toBe(7);
    });

    it('passes when both numbers agree that people are being recorded', async () => {
      const plan = planReturning(overview('8', 59));

      const [result] = await new CollectionAliveCheck(
        plan,
        serversConfig({ PLAN_SERVERS: 'Survival' }),
      ).run();

      expect(result.status).toBe('ok');
    });

    it('passes on an empty server — nobody online, nobody recorded', async () => {
      const plan = planReturning(overview(0, 0));

      const [result] = await new CollectionAliveCheck(
        plan,
        serversConfig({ PLAN_SERVERS: 'Survival' }),
      ).run();

      // The whole point of the contradiction signal: a genuinely idle server is
      // not an outage, and must not page anyone at 3am.
      expect(result.status).toBe('ok');
    });
  });

  describe('ausencia de dado', () => {
    it.each([
      ['numbers ausente', overview(undefined, 59)],
      ['unique_players_day ausente', overview('8', undefined)],
      ['sentinela do Plan', overview('plugin.generic.unavailable', 59)],
    ])('reports no_data when %s', async (_label, body) => {
      const plan = planReturning(body);

      const [result] = await new CollectionAliveCheck(
        plan,
        serversConfig({ PLAN_SERVERS: 'Survival' }),
      ).run();

      // Never `ok`: one side of the comparison is missing, so no comparison was
      // made. Reporting a pass here is how a collection gap becomes a clean bill
      // of health.
      expect(result.status).toBe('no_data');
    });
  });

  describe('falha de transporte e de formato', () => {
    it('turns an unreachable Plan into an error verdict, not an exception', async () => {
      const plan = {
        getJson: jest.fn(() =>
          Promise.reject(new PlanUnreachableError('http://game:25504')),
        ),
      } as unknown as PlanApiClient;

      const [result] = await new CollectionAliveCheck(
        plan,
        serversConfig({ PLAN_SERVERS: 'Survival' }),
      ).run();

      // Reaching Plan is part of what this check measures, so the failure is a
      // verdict rather than something for the runner to catch.
      expect(result.status).toBe('error');
      expect(result.detail.summary).toContain('Plan');
    });

    it('turns an unexpected body into a named error verdict', async () => {
      const plan = planReturning({ nao: 'e o que esperavamos' });

      const [result] = await new CollectionAliveCheck(
        plan,
        serversConfig({ PLAN_SERVERS: 'Survival' }),
      ).run();

      expect(result.status).toBe('error');
      // Naming the field is what tells us a Plan upgrade changed the contract,
      // instead of silently producing wrong numbers.
      expect(result.detail.summary).toContain('timestamp');
    });
  });

  describe('consulta ao Plan', () => {
    it('asks for each server by name', async () => {
      const getJson = jest.fn(() => Promise.resolve(overview('1', 1)));
      const plan = { getJson } as unknown as PlanApiClient;

      await new CollectionAliveCheck(
        plan,
        serversConfig({ PLAN_SERVERS: 'Survival' }),
      ).run();

      expect(getJson).toHaveBeenCalledWith('v1/serverOverview', {
        server: 'Survival',
      });
    });
  });
});
