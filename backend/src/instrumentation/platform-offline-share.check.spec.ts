import { ConfigService } from '@nestjs/config';
import type { PlanApiClient } from './plan-api.client';
import { PlanUnreachableError } from './plan-api.errors';
import { PlanServersConfig } from './plan-servers.config';
import { PlatformOfflineShareCheck } from './platform-offline-share.check';

const NOW = 1_787_500_000_000;
const DAY = 86_400_000;

const OFFLINE = 'a1b2c3d4-e5f6-3789-abcd-ef0123456789';
const PREMIUM = 'a1b2c3d4-e5f6-4789-abcd-ef0123456789';
const BEDROCK = '00000000-0000-0000-0009-01f4a3b2c1d0';

function serversConfig(values: Record<string, string>): PlanServersConfig {
  return new PlanServersConfig({
    get: <T>(key: string): T | undefined => values[key] as T | undefined,
  } as unknown as ConfigService);
}

function config(values: Record<string, unknown> = {}): ConfigService {
  return {
    get: <T>(key: string): T | undefined => values[key] as T | undefined,
  } as unknown as ConfigService;
}

/** `playersTable` envelope, shaped like the real one. */
function table(players: Array<{ uuid: string; daysAgo: number }>): unknown {
  return {
    timestamp: NOW,
    players: players.map((player) => ({
      playerUUID: player.uuid,
      playerName: 'REDACTED',
      registered: NOW - player.daysAgo * DAY,
      sessionCount: 1,
    })),
  };
}

function planReturning(body: unknown): PlanApiClient {
  return {
    getJson: jest.fn(() => Promise.resolve(body)),
  } as unknown as PlanApiClient;
}

/** Enough arrivals to clear the default minimum sample. */
function arrivals(offline: number, others: number, daysAgo = 1) {
  return [
    ...Array.from({ length: offline }, () => ({ uuid: OFFLINE, daysAgo })),
    ...Array.from({ length: others }, () => ({ uuid: PREMIUM, daysAgo })),
  ];
}

const ONE_BACKEND = { PLAN_SERVERS: 'Survival' };

describe('PlatformOfflineShareCheck', () => {
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(NOW);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('janela temporal', () => {
    it('counts only arrivals inside the window', async () => {
      const plan = planReturning(
        table([
          ...arrivals(2, 18, 1),
          // All-time stock that must not enter the calculation.
          ...Array.from({ length: 500 }, () => ({
            uuid: OFFLINE,
            daysAgo: 400,
          })),
        ]),
      );

      const [result] = await new PlatformOfflineShareCheck(
        plan,
        serversConfig(ONE_BACKEND),
        config(),
      ).run();

      // The all-time mix is not the current mix — that trap already cost this
      // project one wrong conclusion, and `n` proves the window was applied.
      expect(result.detail.n).toBe(20);
      expect(result.detail.observed).toBe(10);
    });

    it('honours a configured window', async () => {
      const plan = planReturning(
        table([...arrivals(5, 15, 20), ...arrivals(0, 25, 1)]),
      );

      const [result] = await new PlatformOfflineShareCheck(
        plan,
        serversConfig(ONE_BACKEND),
        config({ PLATFORM_OFFLINE_WINDOW_DAYS: 30 }),
      ).run();

      expect(result.detail.n).toBe(45);
    });
  });

  describe('amostra pequena', () => {
    it('refuses to publish a percentage below the minimum sample', async () => {
      const plan = planReturning(table(arrivals(2, 1)));

      const [result] = await new PlatformOfflineShareCheck(
        plan,
        serversConfig(ONE_BACKEND),
        config(),
      ).run();

      // 2 of 3 is 67% and means nothing. The rule is `n` beside every
      // percentage; this refuses the percentage when `n` cannot support it.
      expect(result.status).toBe('no_data');
      expect(result.detail.observed).toBeUndefined();
      expect(result.detail.n).toBe(3);
    });

    it('publishes once the sample clears the minimum', async () => {
      const plan = planReturning(table(arrivals(2, 18)));

      const [result] = await new PlatformOfflineShareCheck(
        plan,
        serversConfig(ONE_BACKEND),
        config(),
      ).run();

      expect(result.status).toBe('ok');
      expect(result.detail.n).toBe(20);
    });
  });

  describe('veredito', () => {
    it('breaches when the offline share passes the ceiling', async () => {
      const plan = planReturning(table(arrivals(18, 2)));

      const [result] = await new PlatformOfflineShareCheck(
        plan,
        serversConfig(ONE_BACKEND),
        config(),
      ).run();

      expect(result.status).toBe('breached');
      expect(result.detail.observed).toBe(90);
      expect(result.detail.summary).toContain('trafego de bot');
    });

    it('passes below the ceiling', async () => {
      const plan = planReturning(table(arrivals(4, 16)));

      const [result] = await new PlatformOfflineShareCheck(
        plan,
        serversConfig(ONE_BACKEND),
        config(),
      ).run();

      expect(result.status).toBe('ok');
      expect(result.detail.observed).toBe(20);
    });

    it('breaks the window down by platform in the context', async () => {
      const plan = planReturning(
        table([
          ...Array.from({ length: 5 }, () => ({ uuid: OFFLINE, daysAgo: 1 })),
          ...Array.from({ length: 10 }, () => ({ uuid: BEDROCK, daysAgo: 1 })),
          ...Array.from({ length: 8 }, () => ({ uuid: PREMIUM, daysAgo: 1 })),
        ]),
      );

      const [result] = await new PlatformOfflineShareCheck(
        plan,
        serversConfig(ONE_BACKEND),
        config(),
      ).run();

      expect(result.detail.context).toMatchObject({
        offline: 5,
        bedrock: 10,
        java_premium: 8,
        desconhecido: 0,
      });
    });

    it('counts an unrecognised uuid separately, never as offline', async () => {
      const plan = planReturning(
        table([
          ...Array.from({ length: 20 }, () => ({ uuid: PREMIUM, daysAgo: 1 })),
          ...Array.from({ length: 5 }, () => ({ uuid: 'lixo', daysAgo: 1 })),
        ]),
      );

      const [result] = await new PlatformOfflineShareCheck(
        plan,
        serversConfig(ONE_BACKEND),
        config(),
      ).run();

      // Folding malformed input into `offline` would manufacture exactly the
      // bot signal this check exists to detect.
      expect(result.detail.context?.desconhecido).toBe(5);
      expect(result.detail.observed).toBe(0);
    });
  });

  describe('escopo', () => {
    it('skips the proxy', async () => {
      const plan = planReturning(table(arrivals(2, 18)));

      const results = await new PlatformOfflineShareCheck(
        plan,
        serversConfig({
          PLAN_SERVERS: 'AusTv,Survival',
          PLAN_PROXY_SERVER: 'AusTv',
        }),
        config(),
      ).run();

      expect(results).toHaveLength(1);
      expect(results[0].checkName).toBe(
        'platform.offline_account_share:Survival',
      );
    });
  });

  describe('falhas', () => {
    it('turns an unreachable Plan into an error verdict', async () => {
      const plan = {
        getJson: jest.fn(() => Promise.reject(new PlanUnreachableError('u'))),
      } as unknown as PlanApiClient;

      const [result] = await new PlatformOfflineShareCheck(
        plan,
        serversConfig(ONE_BACKEND),
        config(),
      ).run();

      expect(result.status).toBe('error');
    });

    it('errors instead of reporting a healthy 0% when `players` is missing', async () => {
      const plan = planReturning({ timestamp: NOW });

      const [result] = await new PlatformOfflineShareCheck(
        plan,
        serversConfig(ONE_BACKEND),
        config(),
      ).run();

      // Computing a share over an empty list would read as a clean 0%, which is
      // the invented measurement the epic exists to prevent.
      expect(result.status).toBe('error');
      expect(result.detail.summary).toContain('players');
    });

    it('ignores a player row without a usable registered timestamp', async () => {
      const plan = planReturning({
        timestamp: NOW,
        players: [
          { playerUUID: OFFLINE, registered: 'ontem' },
          ...Array.from({ length: 20 }, () => ({
            playerUUID: PREMIUM,
            registered: NOW - DAY,
          })),
        ],
      });

      const [result] = await new PlatformOfflineShareCheck(
        plan,
        serversConfig(ONE_BACKEND),
        config(),
      ).run();

      expect(result.detail.n).toBe(20);
      expect(result.detail.observed).toBe(0);
    });
  });
});
