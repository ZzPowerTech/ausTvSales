import type { PlanApiClient } from '../instrumentation/plan-api.client';
import { PlanUnreachableError } from '../instrumentation/plan-api.errors';
import type {
  DimensionSyncRecord,
  PlayerDimensionStore,
} from './player-dimension.store';
import { PlayerDimensionSyncService } from './player-dimension.sync.service';

const PREMIUM = (i: number) =>
  `11111111-1111-4111-8111-${String(i).padStart(12, '0')}`;
const BEDROCK = (i: number) =>
  `00000000-0000-0000-0009-${String(i).padStart(12, '0')}`;

function row(uuid: string) {
  return {
    playerUUID: uuid,
    registerDate: Date.parse('2026-03-10T12:00:00-03:00'),
    lastSeenDate: Date.parse('2026-04-10T12:00:00-03:00'),
  };
}

function harness(
  over: {
    getJson?: jest.Mock;
    configured?: boolean;
    lastSuccessfulSync?: DimensionSyncRecord | null;
    upsert?: jest.Mock;
  } = {},
) {
  const upsert =
    over.upsert ??
    jest.fn().mockImplementation((rows: unknown[]) => rows.length);
  const recordSuccess = jest.fn().mockResolvedValue(undefined);
  const recordFailure = jest.fn().mockResolvedValue(undefined);
  const lastSuccessfulSync = jest
    .fn()
    .mockResolvedValue(over.lastSuccessfulSync ?? null);

  const service = new PlayerDimensionSyncService(
    {
      configured: over.configured ?? true,
      getJson: over.getJson ?? jest.fn().mockResolvedValue([]),
    } as unknown as PlanApiClient,
    {
      upsert,
      recordSuccess,
      recordFailure,
      lastSuccessfulSync,
    } as unknown as PlayerDimensionStore,
  );

  return { service, upsert, recordSuccess, recordFailure };
}

/** First argument of the first call, typed by the caller. */
function firstArg<T>(mock: jest.Mock): T {
  const calls = mock.mock.calls as unknown[][];
  if (calls.length === 0) {
    throw new Error('mock was never called');
  }
  return calls[0][0] as T;
}

/** A previous run that read `rows` lines. */
function previous(rows: number): DimensionSyncRecord {
  return {
    id: 1,
    ranAt: new Date('2026-08-31T03:30:00.000Z'),
    status: 'ok',
    rowsRead: rows,
    rowsWritten: rows,
    rowsDropped: 0,
    durationMs: 900,
    detail: null,
  };
}

describe('PlayerDimensionSyncService', () => {
  describe('a successful run', () => {
    it('upserts one row per player, with the platform derived from the uuid', async () => {
      const payload = [row(PREMIUM(1)), row(BEDROCK(2))];
      const h = harness({
        getJson: jest.fn().mockResolvedValue(payload),
      });

      const result = await h.service.sync();

      expect(result.status).toBe('ok');
      const written = firstArg<{ uuid: string; platform: string }[]>(h.upsert);
      expect(written.map((r) => r.platform)).toEqual([
        'java_premium',
        'bedrock',
      ]);
    });

    it('records the run duration, because the DoD asks for a timing', async () => {
      const h = harness({
        getJson: jest.fn().mockResolvedValue([row(PREMIUM(1))]),
      });

      await h.service.sync();

      const recorded = firstArg<{
        durationMs: number;
        rowsRead: number;
        rowsWritten: number;
      }>(h.recordSuccess);
      expect(recorded.rowsRead).toBe(1);
      expect(recorded.rowsWritten).toBe(1);
      expect(typeof recorded.durationMs).toBe('number');
    });

    it('is idempotent — the same payload twice writes the same rows', async () => {
      const payload = [row(PREMIUM(1)), row(PREMIUM(2))];
      const h = harness({ getJson: jest.fn().mockResolvedValue(payload) });

      await h.service.sync();
      await h.service.sync();

      const calls = h.upsert.mock.calls as unknown[][];
      const first = calls[0][0] as { uuid: string }[];
      const second = calls[1][0] as { uuid: string }[];
      expect(second.map((r) => r.uuid)).toEqual(first.map((r) => r.uuid));
    });
  });

  describe('the floor rules', () => {
    it('refuses an empty payload and keeps the previous dimension', async () => {
      const h = harness({
        getJson: jest.fn().mockResolvedValue([]),
        lastSuccessfulSync: previous(5000),
      });

      const result = await h.service.sync();

      expect(result.status).toBe('error');
      expect(h.upsert).not.toHaveBeenCalled();
      expect(h.recordFailure).toHaveBeenCalled();
    });

    it('refuses a payload that collapsed against the last successful run', async () => {
      // This is the rule that matters: a 30% payload upserts without error and
      // leaves half the rows frozen next to half refreshed, which is worse to
      // reason about than a whole stale dimension.
      const payload = Array.from({ length: 1000 }, (_, i) => row(PREMIUM(i)));
      const h = harness({
        getJson: jest.fn().mockResolvedValue(payload),
        lastSuccessfulSync: previous(5000),
      });

      const result = await h.service.sync();

      expect(result.status).toBe('error');
      expect(result.detail).toContain('1000 linhas contra 5000');
      expect(h.upsert).not.toHaveBeenCalled();
    });

    it('accepts a payload that only shrank a little', async () => {
      const payload = Array.from({ length: 4800 }, (_, i) => row(PREMIUM(i)));
      const h = harness({
        getJson: jest.fn().mockResolvedValue(payload),
        lastSuccessfulSync: previous(5000),
      });

      expect((await h.service.sync()).status).toBe('ok');
      expect(h.upsert).toHaveBeenCalled();
    });

    it('accepts the very first run, which has nothing to compare against', async () => {
      const h = harness({
        getJson: jest.fn().mockResolvedValue([row(PREMIUM(1))]),
        lastSuccessfulSync: null,
      });

      expect((await h.service.sync()).status).toBe('ok');
    });
  });

  describe('failures never take the previous dimension down', () => {
    it('records an error when Plan is unconfigured, without asking', async () => {
      const getJson = jest.fn();
      const h = harness({ configured: false, getJson });

      const result = await h.service.sync();

      expect(result.status).toBe('error');
      expect(getJson).not.toHaveBeenCalled();
      expect(h.upsert).not.toHaveBeenCalled();
    });

    it('records an error when Plan is unreachable', async () => {
      const h = harness({
        getJson: jest
          .fn()
          .mockRejectedValue(new PlanUnreachableError('http://plan/x')),
      });

      expect((await h.service.sync()).status).toBe('error');
      expect(h.upsert).not.toHaveBeenCalled();
    });

    it('records an error when the payload changed shape', async () => {
      const h = harness({
        getJson: jest.fn().mockResolvedValue([{ nope: 1 }]),
      });

      const result = await h.service.sync();

      expect(result.status).toBe('error');
      expect(result.detail).toContain('contrato');
    });

    it('never puts the upstream message in the persisted detail', async () => {
      const h = harness({
        getJson: jest
          .fn()
          .mockRejectedValue(
            new PlanUnreachableError('http://10.0.0.5:25504/v1/retention'),
          ),
      });

      await h.service.sync();

      const recorded = firstArg<{ detail: string }>(h.recordFailure);
      expect(recorded.detail).not.toContain('10.0.0.5');
    });

    it('records an error when the write itself fails', async () => {
      const h = harness({
        getJson: jest.fn().mockResolvedValue([row(PREMIUM(1))]),
        upsert: jest.fn().mockRejectedValue(new Error('deadlock detected')),
      });

      const result = await h.service.sync();

      expect(result.status).toBe('error');
      expect(h.recordFailure).toHaveBeenCalled();
    });
  });
});
