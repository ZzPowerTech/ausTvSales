import { decideAlerts } from './alert-policy';
import type {
  HealthCheckRecord,
  HealthCheckStatus,
} from './health-check.types';
import { ConfigService } from '@nestjs/config';

import { OrphanInstanceCheck } from './orphan-instance.check';
import type { PlanDatabase, PlanServerRow } from './plan-database';
import { PlanServersConfig } from './plan-servers.config';

function row(name: string, proxy = false): PlanServerRow {
  return {
    uuid: `uuid-${name}`,
    name,
    proxy,
    planVersion: '5.8 build 3605',
  };
}

function dbReturning(rows: PlanServerRow[]): PlanDatabase {
  return {
    listServers: jest.fn(() => Promise.resolve(rows)),
  } as unknown as PlanDatabase;
}

function serversConfig(values: Record<string, string>): PlanServersConfig {
  return new PlanServersConfig({
    get: <T>(key: string): T | undefined => values[key] as T | undefined,
  } as unknown as ConfigService);
}

/** The real AusTV network as of 2026-08-23. */
const REAL_CATALOGUE = [row('Survival'), row('AusTv', true)];
const REAL_CONFIG = {
  PLAN_SERVERS: 'AusTv,Survival',
  PLAN_PROXY_SERVER: 'AusTv',
};

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

describe('OrphanInstanceCheck', () => {
  describe('listas em acordo', () => {
    it('passes when the catalogue matches the configuration', async () => {
      const [result] = await new OrphanInstanceCheck(
        dbReturning(REAL_CATALOGUE),
        serversConfig(REAL_CONFIG),
      ).run();

      expect(result.status).toBe('ok');
      expect(result.detail.n).toBe(2);
    });

    it('emits one global verdict, not one per server', async () => {
      const results = await new OrphanInstanceCheck(
        dbReturning(REAL_CATALOGUE),
        serversConfig(REAL_CONFIG),
      ).run();

      expect(results).toHaveLength(1);
      expect(results[0].checkName).toBe('plan.orphan_instance');
    });

    it('does not care about ordering between the two lists', async () => {
      const [result] = await new OrphanInstanceCheck(
        dbReturning([row('AusTv', true), row('Survival')]),
        serversConfig({ ...REAL_CONFIG, PLAN_SERVERS: 'Survival,AusTv' }),
      ).run();

      expect(result.status).toBe('ok');
    });
  });

  describe('instancia que ninguem observa', () => {
    it('breaches on a server Plan knows and nobody configured', async () => {
      const [result] = await new OrphanInstanceCheck(
        dbReturning([...REAL_CATALOGUE, row('Creative')]),
        serversConfig(REAL_CONFIG),
      ).run();

      // This is the SQLite disaster in miniature: an instance reporting to Plan
      // that no check ever looks at, invisible because nothing compared the
      // catalogue against the configuration.
      expect(result.status).toBe('breached');
      expect(result.detail.summary).toContain('Creative');
      expect(result.detail.summary).toContain('ninguem esta observando');
    });

    it('counts every drift in `observed`, with the catalogue as `n`', async () => {
      const [result] = await new OrphanInstanceCheck(
        dbReturning([...REAL_CATALOGUE, row('Creative'), row('Lobby')]),
        serversConfig(REAL_CONFIG),
      ).run();

      expect(result.detail.observed).toBe(2);
      expect(result.detail.threshold).toBe(0);
      expect(result.detail.n).toBe(4);
    });
  });

  describe('configurado mas desconhecido', () => {
    it('breaches on a configured name Plan does not know', async () => {
      const [result] = await new OrphanInstanceCheck(
        dbReturning(REAL_CATALOGUE),
        serversConfig({
          ...REAL_CONFIG,
          PLAN_SERVERS: 'AusTv,Survival,Skyblock',
        }),
      ).run();

      // Every check scoped to that name is querying something that cannot
      // resolve — it would fail silently, one server at a time.
      expect(result.status).toBe('breached');
      expect(result.detail.summary).toContain('Skyblock');
      expect(result.detail.summary).toContain('nao conhece');
    });

    it('catches a casing mismatch, which would break every scoped check', async () => {
      const [result] = await new OrphanInstanceCheck(
        dbReturning(REAL_CATALOGUE),
        serversConfig({
          PLAN_SERVERS: 'austv,survival',
          PLAN_PROXY_SERVER: 'austv',
        }),
      ).run();

      // `?server=` is case-sensitive, so `survival` is not `Survival`. Surfacing
      // it here beats discovering it as a mysterious 403 three checks later.
      expect(result.status).toBe('breached');
      expect(result.detail.observed).toBe(4);
    });

    it('reports both directions of drift in the same verdict', async () => {
      const [result] = await new OrphanInstanceCheck(
        dbReturning([row('Survival'), row('Creative')]),
        serversConfig({ PLAN_SERVERS: 'Survival,Skyblock' }),
      ).run();

      expect(String(result.detail.context?.nao_observadas)).toContain(
        'Creative',
      );
      expect(String(result.detail.context?.nao_registradas)).toContain(
        'Skyblock',
      );
    });
  });

  describe('catalogo vazio', () => {
    it('reports error when the catalogue is empty', async () => {
      const [result] = await new OrphanInstanceCheck(
        dbReturning([]),
        serversConfig(REAL_CONFIG),
      ).run();

      // An empty catalogue is the loudest version of this problem, not a pass —
      // and `no_data` would file the loudest version under the one status that
      // never reaches Discord.
      expect(result.status).toBe('error');
    });

    it('files the empty catalogue under a notifiable status', async () => {
      // The regression this pins. `decideAlerts` suppresses a `no_data` as
      // `not_notifiable` while nothing is open on the check, so a `plan_servers`
      // that empties from a clean state produced a row every fifteen minutes and
      // never one message.
      const [result] = await new OrphanInstanceCheck(
        dbReturning([]),
        serversConfig(REAL_CONFIG),
      ).run();

      expect(announcedFromCleanSlate(result)).toBe(true);
    });
  });

  describe('ausencia de dado', () => {
    it('reports no_data when nothing is configured to compare against', async () => {
      const [result] = await new OrphanInstanceCheck(
        dbReturning(REAL_CATALOGUE),
        serversConfig({}),
      ).run();

      // Stays `no_data`: nothing failed, our own configuration is unset. An
      // unconfigured staging box must not page the channel every re-alert
      // window — the same call `InstrumentationHealthService` makes for
      // `missing` checks.
      expect(result.status).toBe('no_data');
      expect(result.detail.n).toBe(2);
    });
  });

  describe('falha de banco', () => {
    it('turns an unreachable database into an error verdict', async () => {
      const db = {
        listServers: jest.fn(() => Promise.reject(new Error('ECONNREFUSED'))),
      } as unknown as PlanDatabase;

      const [result] = await new OrphanInstanceCheck(
        db,
        serversConfig(REAL_CONFIG),
      ).run();

      expect(result.status).toBe('error');
      expect(result.detail.summary).toContain('ECONNREFUSED');
    });

    it('never degrades a failure into a passing verdict', async () => {
      const db = {
        listServers: jest.fn(() => Promise.reject(new Error('acesso negado'))),
      } as unknown as PlanDatabase;

      const [result] = await new OrphanInstanceCheck(
        db,
        serversConfig(REAL_CONFIG),
      ).run();

      expect(result.status).not.toBe('ok');
      expect(result.status).not.toBe('no_data');
    });
  });
});
