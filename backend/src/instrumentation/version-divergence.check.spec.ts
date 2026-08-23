import type { PlanDatabase, PlanServerRow } from './plan-database';
import { VersionDivergenceCheck } from './version-divergence.check';

function server(
  name: string,
  planVersion: string | null,
  proxy = false,
): PlanServerRow {
  return { uuid: `uuid-${name}`, name, proxy, planVersion };
}

function dbReturning(rows: PlanServerRow[]): PlanDatabase {
  return {
    listServers: jest.fn(() => Promise.resolve(rows)),
  } as unknown as PlanDatabase;
}

/** The real AusTV network as of 2026-08-23: both instances on the same build. */
const AUSTV_REAL = [
  server('Survival', '5.8 build 3605'),
  server('AusTv', '5.8 build 3605', true),
];

describe('VersionDivergenceCheck', () => {
  describe('convergencia', () => {
    it('passes when every instance runs the same build', async () => {
      const [result] = await new VersionDivergenceCheck(
        dbReturning(AUSTV_REAL),
      ).run();

      expect(result.status).toBe('ok');
      expect(result.detail.summary).toContain('5.8 build 3605');
      expect(result.detail.n).toBe(2);
    });

    it('emits a single global verdict, not one per server', async () => {
      const results = await new VersionDivergenceCheck(
        dbReturning(AUSTV_REAL),
      ).run();

      // Divergence is a property of the set. Naming one instance as "the wrong
      // one" would be arbitrary — the newest is as likely to be the mistake.
      expect(results).toHaveLength(1);
      expect(results[0].checkName).toBe('plan.version_divergence');
    });
  });

  describe('divergencia', () => {
    it('breaches when builds differ', async () => {
      const [result] = await new VersionDivergenceCheck(
        dbReturning([
          server('Survival', '5.6 build 2959'),
          server('AusTv', '5.6 build 2965', true),
        ]),
      ).run();

      expect(result.status).toBe('breached');
      expect(result.detail.observed).toBe(2);
      expect(result.detail.threshold).toBe(1);
    });

    it('names which instance runs which build', async () => {
      const [result] = await new VersionDivergenceCheck(
        dbReturning([
          server('Survival', '5.6 build 2959'),
          server('AusTv', '5.6 build 2965', true),
        ]),
      ).run();

      const builds = String(result.detail.context?.builds);
      expect(builds).toContain('5.6 build 2959: Survival');
      expect(builds).toContain('5.6 build 2965: AusTv');
    });

    it('produces a stable message across cycles', async () => {
      const rows = [
        server('Zulu', '5.8 build 3605'),
        server('Alpha', '5.6 build 2959'),
        server('Mike', '5.8 build 3605'),
      ];

      const [first] = await new VersionDivergenceCheck(dbReturning(rows)).run();
      const [second] = await new VersionDivergenceCheck(
        dbReturning([...rows].reverse()),
      ).run();

      // An alert whose text reshuffles every run reads as a new incident each
      // time, which is how a channel gets muted.
      expect(first.detail.context?.builds).toBe(second.detail.context?.builds);
    });
  });

  describe('ausencia de dado', () => {
    it('reports no_data when the catalogue is empty', async () => {
      const [result] = await new VersionDivergenceCheck(dbReturning([])).run();

      // An empty catalogue is not agreement. `ok` here would pass the check
      // precisely when Plan lost track of every instance.
      expect(result.status).toBe('no_data');
      expect(result.detail.n).toBe(0);
    });

    it('reports no_data with a single instance', async () => {
      const [result] = await new VersionDivergenceCheck(
        dbReturning([server('Survival', '5.8 build 3605')]),
      ).run();

      expect(result.status).toBe('no_data');
    });

    it('treats an unrecorded version as unknown, not as matching', async () => {
      const [result] = await new VersionDivergenceCheck(
        dbReturning([
          server('Survival', '5.8 build 3605'),
          server('AusTv', null, true),
        ]),
      ).run();

      // Only one server has a version, so there is nothing to compare. Calling
      // that `ok` would claim agreement that was never established.
      expect(result.status).toBe('no_data');
      expect(result.detail.n).toBe(2);
    });
  });

  describe('falha de banco', () => {
    it('turns an unreachable database into an error verdict', async () => {
      const db = {
        listServers: jest.fn(() =>
          Promise.reject(new Error('ECONNREFUSED 198.89.99.70:3306')),
        ),
      } as unknown as PlanDatabase;

      const [result] = await new VersionDivergenceCheck(db).run();

      expect(result.status).toBe('error');
      expect(result.detail.summary).toContain('ECONNREFUSED');
    });

    it('never smooths a failure into an empty list', async () => {
      const db = {
        listServers: jest.fn(() => Promise.reject(new Error('acesso negado'))),
      } as unknown as PlanDatabase;

      const [result] = await new VersionDivergenceCheck(db).run();

      // Returning `[]` on failure would read as "no servers registered" and
      // reach the `no_data` branch, hiding a credential problem as a data gap.
      expect(result.status).not.toBe('no_data');
      expect(result.status).toBe('error');
    });
  });
});
