import { ConfigService } from '@nestjs/config';
import type { PlanApiClient } from '../instrumentation/plan-api.client';
import {
  PlanNotConfiguredError,
  PlanUnreachableError,
} from '../instrumentation/plan-api.errors';
import { PlanCache } from '../metrics/plan-cache';
import { RetentionService } from './retention.service';
import { RETENTION_SEMANTICS } from './retention.types';

const UUID_PREMIUM = (i: number) =>
  `11111111-1111-4111-8111-${String(i).padStart(12, '0')}`;
const UUID_BEDROCK = (i: number) =>
  `00000000-0000-0000-0009-${String(i).padStart(12, '0')}`;

function config(values: Record<string, unknown> = {}): ConfigService {
  return {
    get: <T>(key: string): T | undefined => values[key] as T | undefined,
  } as unknown as ConfigService;
}

function planStub(over: Partial<PlanApiClient>): PlanApiClient {
  return {
    configured: true,
    getJson: () => Promise.resolve([]),
    ...over,
  } as unknown as PlanApiClient;
}

/**
 * A real `PlanCache`, not a stub.
 *
 * It is a pure in-memory class with no I/O of its own, so using the real one
 * costs nothing and means these tests exercise the code path production takes —
 * including the single-flight and the stale fallback. A fresh instance per test
 * keeps them independent.
 */
function cache(): PlanCache {
  return new PlanCache();
}

function row(uuid: string, registeredDay: string, lastSeenDay: string) {
  return {
    playerUUID: uuid,
    registerDate: Date.parse(`${registeredDay}T12:00:00-03:00`),
    lastSeenDate: Date.parse(`${lastSeenDay}T12:00:00-03:00`),
  };
}

describe('RetentionService', () => {
  describe('degradation — never a report of zeroes', () => {
    it('reports not_configured without asking Plan', async () => {
      const getJson = jest.fn();
      const service = new RetentionService(
        planStub({ configured: false, getJson }),
        cache(),
        config(),
      );

      const report = await service.report('2026-01', '2026-08');

      expect(getJson).not.toHaveBeenCalled();
      expect(report.source).toMatchObject({
        ok: false,
        failure: 'not_configured',
        dataThrough: null,
      });
      // The empty array must never be read as "no cohorts exist"; the source
      // state is where a consumer finds out which it is.
      expect(report.cohorts).toEqual([]);
    });

    it('reports unreachable when Plan does not answer', async () => {
      const service = new RetentionService(
        planStub({
          getJson: () =>
            Promise.reject(
              new PlanUnreachableError('http://plan/v1/retention'),
            ),
        }),
        cache(),
        config(),
      );

      const report = await service.report('2026-01', '2026-08');

      expect(report.source).toMatchObject({
        ok: false,
        failure: 'unreachable',
      });
      expect(report.cohorts).toEqual([]);
    });

    it('keeps not_configured apart from unreachable when the client throws it', async () => {
      const service = new RetentionService(
        planStub({
          configured: true,
          getJson: () => Promise.reject(new PlanNotConfiguredError()),
        }),
        cache(),
        config(),
      );

      const report = await service.report('2026-01', '2026-08');

      expect(report.source.failure).toBe('not_configured');
    });

    it('reports contract_mismatch when the payload changed shape', async () => {
      const service = new RetentionService(
        planStub({ getJson: () => Promise.resolve([{ nope: 1 }]) }),
        cache(),
        config(),
      );

      const report = await service.report('2026-01', '2026-08');

      expect(report.source).toMatchObject({
        ok: false,
        failure: 'contract_mismatch',
      });
    });

    it('never leaks the upstream message into the response', async () => {
      const service = new RetentionService(
        planStub({
          getJson: () =>
            Promise.reject(
              new PlanUnreachableError('http://10.0.0.5:25504/v1/retention'),
            ),
        }),
        cache(),
        config(),
      );

      const report = await service.report('2026-01', '2026-08');

      const body = JSON.stringify(report);
      expect(body).not.toContain('10.0.0.5');
      // Widened past one sample host: the rule is that NO upstream identifier
      // reaches a body, and the narrow assertion passed for months while the
      // semantics string shipped an upstream table name in every response.
      for (const identifier of [
        'plan_sessions',
        'plan_user_info',
        'plan_users',
        '25504',
      ]) {
        expect(body).not.toContain(identifier);
      }
    });

    it('keeps every upstream identifier out of a SUCCESSFUL body too', async () => {
      const service = new RetentionService(
        planStub({
          getJson: () =>
            Promise.resolve([row(UUID_PREMIUM(1), '2026-01-10', '2026-02-10')]),
        }),
        cache(),
        config(),
      );

      const body = JSON.stringify(await service.report('2026-01', '2026-01'));

      for (const identifier of ['plan_sessions', 'plan_user_info']) {
        expect(body).not.toContain(identifier);
      }
    });
  });

  describe('the label travels with the number', () => {
    it('publishes the survival-interval semantics on every report', async () => {
      const service = new RetentionService(
        planStub({ getJson: () => Promise.resolve([]) }),
        cache(),
        config(),
      );

      const report = await service.report('2026-01', '2026-08');

      expect(report.semantics).toBe(RETENTION_SEMANTICS);
      expect(report.semantics).toContain('nao retorno no dia N');
    });
  });

  describe('reading a payload', () => {
    const payload = [
      ...Array.from({ length: 40 }, (_, i) =>
        row(UUID_PREMIUM(i), '2026-01-10', '2026-04-01'),
      ),
      ...Array.from({ length: 10 }, (_, i) =>
        row(UUID_BEDROCK(i), '2026-01-10', '2026-01-11'),
      ),
      ...Array.from({ length: 20 }, (_, i) =>
        row(UUID_PREMIUM(500 + i), '2026-03-10', '2026-03-12'),
      ),
    ];

    it('returns one row per cohort and platform, with the base and rows read', async () => {
      const service = new RetentionService(
        planStub({ getJson: () => Promise.resolve(payload) }),
        cache(),
        config(),
      );

      const report = await service.report('2026-01', '2026-03');

      expect(report.source).toMatchObject({ ok: true, rows: 70 });
      expect(report.source.dataThrough).toBe('2026-04-01');
      expect(report.cohorts.map((c) => [c.cohort, c.platform, c.size])).toEqual(
        [
          ['2026-01', 'bedrock', 10],
          ['2026-01', 'java_premium', 40],
          ['2026-03', 'java_premium', 20],
        ],
      );
    });

    it('filters to one platform without summing the others into it', async () => {
      const service = new RetentionService(
        planStub({ getJson: () => Promise.resolve(payload) }),
        cache(),
        config(),
      );

      const report = await service.report('2026-01', '2026-03', 'bedrock');

      expect(report.cohorts).toHaveLength(1);
      expect(report.cohorts[0]).toMatchObject({
        platform: 'bedrock',
        size: 10,
      });
    });

    it('restricts the rendered cohorts to the window', async () => {
      const service = new RetentionService(
        planStub({ getJson: () => Promise.resolve(payload) }),
        cache(),
        config(),
      );

      const report = await service.report('2026-03', '2026-03');

      expect(report.cohorts.map((c) => c.cohort)).toEqual(['2026-03']);
    });

    it('detects stamp days over the WHOLE payload, not over the window', async () => {
      // The stamp lives in a cohort outside the requested window. Detecting it
      // only inside the window would leave the contaminated cohort looking
      // clean whenever the caller happened to ask for a narrow range.
      const stamped = Array.from({ length: 300 }, (_, i) =>
        row(UUID_PREMIUM(i), '2025-02-10', '2026-08-20'),
      );
      const inWindow = Array.from({ length: 100 }, (_, i) =>
        row(UUID_PREMIUM(700 + i), '2026-05-10', '2026-08-20'),
      );

      const service = new RetentionService(
        planStub({ getJson: () => Promise.resolve([...stamped, ...inWindow]) }),
        cache(),
        config({ RETENTION_STAMP_DAY_MIN_POPULATION: 200 }),
      );

      const report = await service.report('2026-05', '2026-05');

      expect(report.stampDays.map((s) => s.day)).toEqual(['2026-08-20']);
      expect(report.cohorts[0].contamination.suspect).toBe(true);
      for (const measure of report.cohorts[0].measures) {
        expect(measure.percent).toBeNull();
        expect(measure).toMatchObject({ reason: 'import_artifact' });
      }
    });

    it('publishes what it parsed beside what it read', async () => {
      // `rows` is the pre-filter total. Publishing only that would advertise
      // 5.565 next to cohorts summing 3.565, with no way to notice — the same
      // family as the `n` rule: the published base has to be the base the
      // numbers came from.
      const service = new RetentionService(
        planStub({
          getJson: () =>
            Promise.resolve([
              row(UUID_PREMIUM(1), '2026-01-10', '2026-02-10'),
              { playerUUID: 'nao-e-uuid', registerDate: 1, lastSeenDate: 2 },
            ]),
        }),
        cache(),
        config(),
      );

      const report = await service.report('2026-01', '2026-01');

      expect(report.source).toMatchObject({
        rows: 2,
        parsed: 1,
        dropped: 1,
      });
    });

    it('says so when the window falls outside what the source covers', async () => {
      // An empty list beside `source.ok: true` is otherwise indistinguishable
      // from "nobody registered in that period" — a measurement never made.
      const service = new RetentionService(
        planStub({ getJson: () => Promise.resolve(payload) }),
        cache(),
        config(),
      );

      const report = await service.report('2023-01', '2023-12');

      expect(report.cohorts).toEqual([]);
      expect(report.source.ok).toBe(true);
      expect(report.coverageWarning).toContain('fora do que a fonte cobre');
      expect(report.source.dataFrom).toBe('2026-01-10');
    });

    it('does not cry coverage for a genuinely empty month inside coverage', async () => {
      const service = new RetentionService(
        planStub({ getJson: () => Promise.resolve(payload) }),
        cache(),
        config(),
      );

      const report = await service.report('2026-02', '2026-02');

      expect(report.cohorts).toEqual([]);
      expect(report.coverageWarning).toBeUndefined();
    });

    it('serves the previous payload marked stale when Plan goes down', async () => {
      // Spec section 8 asks for the cache as a mitigation. Serving the last good
      // payload beats serving nothing — but only because the mark travels with
      // it, so nobody reads month-old cohorts as today's.
      const getJson = jest
        .fn()
        .mockResolvedValueOnce(payload)
        .mockRejectedValue(new PlanUnreachableError('http://plan/x'));
      const shared = cache();

      const service = new RetentionService(
        planStub({ getJson }),
        shared,
        config({ RETENTION_CACHE_TTL_SECONDS: 0.001 }),
      );

      await service.report('2026-01', '2026-03');
      await new Promise((resolve) => setTimeout(resolve, 5));
      const second = await service.report('2026-01', '2026-03');

      expect(second.source.ok).toBe(true);
      expect(second.source.stale).toBe(true);
      expect(second.cohorts.length).toBeGreaterThan(0);
    });

    it('publishes the configured minimum so a consumer can explain the mark', async () => {
      const service = new RetentionService(
        planStub({ getJson: () => Promise.resolve(payload) }),
        cache(),
        config({ RETENTION_MIN_COHORT_SIZE: 25 }),
      );

      const report = await service.report('2026-01', '2026-03');

      expect(report.minimumCohortSize).toBe(25);
      expect(
        report.cohorts.find((c) => c.platform === 'bedrock')?.belowMinimum,
      ).toBe(true);
      expect(
        report.cohorts.find(
          (c) => c.cohort === '2026-01' && c.platform === 'java_premium',
        )?.belowMinimum,
      ).toBe(false);
    });

    it('asks Plan exactly once per report', async () => {
      const getJson = jest.fn().mockResolvedValue(payload);
      const service = new RetentionService(
        planStub({ getJson }),
        cache(),
        config(),
      );

      await service.report('2026-01', '2026-03');
      // Twice, and the second one is served from cache without touching Plan —
      // spec section 8 asks for the TTL cache as a mitigation, not a nicety.
      await service.report('2026-01', '2026-03');

      expect(getJson).toHaveBeenCalledTimes(1);
      expect(getJson).toHaveBeenCalledWith('/v1/retention');
    });
  });

  describe('no player data reaches the contract', () => {
    it('drops the uuid after deriving the platform', async () => {
      const service = new RetentionService(
        planStub({
          getJson: () =>
            Promise.resolve([row(UUID_PREMIUM(7), '2026-01-10', '2026-02-10')]),
        }),
        cache(),
        config(),
      );

      const report = await service.report('2026-01', '2026-01');

      expect(JSON.stringify(report)).not.toContain(UUID_PREMIUM(7));
      expect(report.cohorts[0].platform).toBe('java_premium');
    });
  });
});
