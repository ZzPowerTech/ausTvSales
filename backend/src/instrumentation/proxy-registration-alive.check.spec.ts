import type {
  HealthCheckRecord,
  HealthCheckStatus,
} from './health-check.types';
import { decideAlerts } from './alert-policy';
import { ConfigService } from '@nestjs/config';

import type { RegisteredPlayers, PlanDatabase } from './plan-database';
import { ProxyRegistrationAliveCheck } from './proxy-registration-alive.check';

const NOW = 1_787_500_000_000;
const HOUR = 3_600_000;

function config(values: Record<string, unknown> = {}): ConfigService {
  return {
    get: <T>(key: string): T | undefined => values[key] as T | undefined,
  } as unknown as ConfigService;
}

function dbReturning(arrivals: RegisteredPlayers): PlanDatabase {
  return {
    registeredPlayers: jest.fn(() => Promise.resolve(arrivals)),
  } as unknown as PlanDatabase;
}

/**
 * Does this verdict actually reach the channel from a clean slate?
 *
 * The defect these tests exist for lived in the *policy*, not in the status
 * name: `decideAlerts` suppresses a `no_data` with nothing open as
 * `not_notifiable`, forever. Asserting that the status is in some notifiable
 * list only restates the line above it. Driving the record through the real
 * policy is the property.
 */
function announcedFromCleanSlate(observation: {
  checkName: string;
  status: HealthCheckStatus;
}): boolean {
  const record: HealthCheckRecord = {
    id: 1,
    checkName: observation.checkName,
    status: observation.status,
    checkedAt: new Date('2026-08-30T12:00:00.000Z'),
    detail: null,
    alertedAt: null,
  };

  const decision = decideAlerts({
    observations: [record],
    lastAlert: new Map(),
    alertsInWindow: new Map(),
    maxAlertsPerWindow: 4,
    healthyStreak: new Map(),
    confirmRecoveryAfter: 2,
    reAlertAfterMs: 24 * 60 * 60 * 1000,
  });

  return decision.announce.includes(record);
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

  describe('registro mudo', () => {
    it('breaches after the configured silence', async () => {
      const [result] = await new ProxyRegistrationAliveCheck(
        dbReturning({ total: 5566, lastRegisteredAt: NOW - 30 * HOUR }),
        config(),
      ).run();

      expect(result.status).toBe('breached');
      expect(result.detail.observed).toBe(30);
      expect(result.detail.threshold).toBe(24);
      expect(result.detail.summary).toContain('coleta do Survival');
      // And says what it is NOT covering. `plan_users` holds the Survival in
      // this installation (measured 2026-08-31), so a summary that blamed the
      // proxy would send whoever is on call to the wrong system.
      expect(result.detail.summary).toContain('NAO cobre o proxy');
    });

    it('catches a three-month silence, though not the one it was built for', async () => {
      // The outage on record is the *proxy* collecting nothing from May to
      // August 2026. This check cannot see that one: `plan_users` is the
      // Survival, which kept registering 106 players in 2026-06 while the
      // verified table shows the proxy dead. What it does catch is the same
      // shape of silence on the Survival — real, and worth catching.
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

  describe('tabela de identidade vazia', () => {
    it('reports error on an empty identity table', async () => {
      const [result] = await new ProxyRegistrationAliveCheck(
        dbReturning({ total: 0, lastRegisteredAt: null }),
        config(),
      ).run();

      // Not "nobody arrived recently" — a live network with no history at all
      // means the read found the wrong database, which is §1's founding
      // disaster verbatim.
      expect(result.status).toBe('error');
      expect(result.detail.n).toBe(0);
    });

    it('files the empty table under a notifiable status', async () => {
      // The regression this pins. Filed as `no_data`, the single verdict that
      // would have named the SQLite disaster was suppressed as `not_notifiable`
      // on every cycle, forever, because nothing was ever open on the check.
      const [result] = await new ProxyRegistrationAliveCheck(
        dbReturning({ total: 0, lastRegisteredAt: null }),
        config(),
      ).run();

      expect(announcedFromCleanSlate(result)).toBe(true);
    });

    it('nao acusa banco errado quando a tabela tem linhas', async () => {
      // A armadilha que este branch escondia ate 2026-08-30. `total` e um
      // `COUNT(*)`; `lastRegisteredAt` passa pelo `toNumber`, que devolve null
      // para tabela vazia E para qualquer formato inesperado — um `Date`, uma
      // string nao numerica, um bump do driver que muda como o BIGINT chega.
      //
      // Com os dois no mesmo branch, um upgrade do mysql2 faria o canal dizer, a
      // cada quinze minutos, que "a leitura provavelmente encontrou o banco
      // errado" sobre um Plan perfeitamente saudavel — enquanto o `n` na mesma
      // mensagem dizia 5566. Mandar alguem para o sistema errado e pior que nao
      // alertar.
      const [result] = await new ProxyRegistrationAliveCheck(
        dbReturning({ total: 5566, lastRegisteredAt: null }),
        config(),
      ).run();

      // Continua sendo `error` — a data e ilegivel e isso precisa ser ouvido —
      // mas o texto nao inventa uma causa, e o `n` bate com a realidade.
      expect(result.status).toBe('error');
      expect(result.detail.n).toBe(5566);
      expect(result.detail.summary).not.toContain('banco errado');
      expect(result.detail.summary).toContain('5566');
      expect(announcedFromCleanSlate(result)).toBe(true);
    });
  });

  describe('falha de banco', () => {
    it('turns an unreachable database into an error verdict', async () => {
      const db = {
        registeredPlayers: jest.fn(() =>
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
        registeredPlayers: jest.fn(() => Promise.reject(new Error('negado'))),
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
