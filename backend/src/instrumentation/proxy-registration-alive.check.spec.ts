import { ConfigService } from '@nestjs/config';
import type { NetworkArrivals, PlanDatabase } from './plan-database';
import { ProxyRegistrationAliveCheck } from './proxy-registration-alive.check';

const NOW = 1_787_500_000_000;
const HOUR = 3_600_000;

function config(values: Record<string, unknown> = {}): ConfigService {
  return {
    get: <T>(key: string): T | undefined => values[key] as T | undefined,
  } as unknown as ConfigService;
}

function dbReturning(arrivals: NetworkArrivals): PlanDatabase {
  return {
    networkArrivals: jest.fn(() => Promise.resolve(arrivals)),
  } as unknown as PlanDatabase;
}

describe('ProxyRegistrationAliveCheck', () => {
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(NOW);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('rede viva', () => {
    it('passes when someone registered recently', async () => {
      // The real reading on 2026-08-23: 5566 players, last one minutes ago.
      const [result] = await new ProxyRegistrationAliveCheck(
        dbReturning({ total: 5566, lastRegisteredAt: NOW - 2 * HOUR }),
        config(),
      ).run();

      expect(result.status).toBe('ok');
      expect(result.detail.observed).toBe(2);
      expect(result.detail.n).toBe(5566);
    });

    it('emits a single global verdict', async () => {
      const results = await new ProxyRegistrationAliveCheck(
        dbReturning({ total: 5566, lastRegisteredAt: NOW - HOUR }),
        config(),
      ).run();

      expect(results).toHaveLength(1);
      expect(results[0].checkName).toBe('plan.proxy_registration_alive');
    });

    it('passes right at the threshold', async () => {
      const [result] = await new ProxyRegistrationAliveCheck(
        dbReturning({ total: 100, lastRegisteredAt: NOW - 24 * HOUR }),
        config(),
      ).run();

      // Strictly greater breaches, so exactly 24h is still fine — a boundary
      // that flaps every cycle would be noise, not signal.
      expect(result.status).toBe('ok');
    });
  });

  describe('rede muda', () => {
    it('breaches after the configured silence', async () => {
      const [result] = await new ProxyRegistrationAliveCheck(
        dbReturning({ total: 5566, lastRegisteredAt: NOW - 30 * HOUR }),
        config(),
      ).run();

      expect(result.status).toBe('breached');
      expect(result.detail.observed).toBe(30);
      expect(result.detail.threshold).toBe(24);
      expect(result.detail.summary).toContain('coleta do proxy');
    });

    it('catches the three-month outage this check exists for', async () => {
      // May to August 2026: the proxy stopped collecting and nobody noticed.
      const [result] = await new ProxyRegistrationAliveCheck(
        dbReturning({ total: 5566, lastRegisteredAt: NOW - 90 * 24 * HOUR }),
        config(),
      ).run();

      expect(result.status).toBe('breached');
      expect(result.detail.observed).toBe(2160);
    });

    it('honours a configured threshold', async () => {
      const [result] = await new ProxyRegistrationAliveCheck(
        dbReturning({ total: 5566, lastRegisteredAt: NOW - 7 * HOUR }),
        config({ PROXY_REGISTRATION_MAX_SILENCE_HOURS: 6 }),
      ).run();

      expect(result.status).toBe('breached');
      expect(result.detail.threshold).toBe(6);
    });

    it('reports the timestamp of the last registration', async () => {
      const last = NOW - 30 * HOUR;
      const [result] = await new ProxyRegistrationAliveCheck(
        dbReturning({ total: 5566, lastRegisteredAt: last }),
        config(),
      ).run();

      expect(result.detail.context?.ultimo_registro).toBe(
        new Date(last).toISOString(),
      );
    });
  });

  describe('sinal de silencio, nao de contagem', () => {
    it('passes on a quiet network as long as the last arrival is recent', async () => {
      const [result] = await new ProxyRegistrationAliveCheck(
        dbReturning({ total: 3, lastRegisteredAt: NOW - HOUR }),
        config(),
      ).run();

      // A count threshold would fire on a genuinely quiet night and train the
      // team to mute the channel. Elapsed silence cannot be explained away by
      // low traffic.
      expect(result.status).toBe('ok');
    });
  });

  describe('ausencia de dado', () => {
    it('reports no_data on an empty identity table', async () => {
      const [result] = await new ProxyRegistrationAliveCheck(
        dbReturning({ total: 0, lastRegisteredAt: null }),
        config(),
      ).run();

      // Not "nobody arrived recently" — a live network with no history at all
      // means the read found the wrong database.
      expect(result.status).toBe('no_data');
      expect(result.detail.n).toBe(0);
    });
  });

  describe('falha de banco', () => {
    it('turns an unreachable database into an error verdict', async () => {
      const db = {
        networkArrivals: jest.fn(() =>
          Promise.reject(new Error('ECONNREFUSED')),
        ),
      } as unknown as PlanDatabase;

      const [result] = await new ProxyRegistrationAliveCheck(
        db,
        config(),
      ).run();

      expect(result.status).toBe('error');
      expect(result.detail.summary).toContain('ECONNREFUSED');
    });

    it('never degrades a failure into a passing verdict', async () => {
      const db = {
        networkArrivals: jest.fn(() => Promise.reject(new Error('negado'))),
      } as unknown as PlanDatabase;

      const [result] = await new ProxyRegistrationAliveCheck(
        db,
        config(),
      ).run();

      expect(result.status).not.toBe('ok');
      expect(result.status).not.toBe('no_data');
    });
  });
});
