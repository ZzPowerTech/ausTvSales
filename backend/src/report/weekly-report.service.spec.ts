import type { WeeklyReportBuilder } from './weekly-report.builder';
import type { WeeklyReportPublisher } from './weekly-report.publisher';
import type { WeeklyReportStore } from './weekly-report.store';
import { WeeklyReportService, lastCompleteDay } from './weekly-report.service';
import type { WeeklyReport, WeeklyReportRecord } from './weekly-report.types';

function report(): WeeklyReport {
  return {
    from: '2026-08-25',
    to: '2026-08-31',
    generatedAt: '2026-09-01T00:00:00.000Z',
    funnel: {
      bucket: { bucket: '2026-08-25..2026-08-31', counts: [], conversions: [] },
      coverage: [],
      sources: [],
    },
    retention: {
      semantics: 'intervalo de sobrevivencia',
      from: '2026-06',
      to: '2026-08',
      cohorts: [],
      stampDays: [],
      source: {
        name: 'plan_retention',
        ok: true,
        asOf: null,
        dataThrough: null,
        rows: 0,
      },
    },
    health: {
      summary: {
        status: 'ok',
        stale: false,
        lastCheckedAt: null,
        oldestCheckedAt: null,
        total: 0,
        counts: { ok: 0, breached: 0, no_data: 0, error: 0 },
        failing: [],
        staleChecks: [],
        blindSpots: [],
        missing: [],
        schedule: { enabled: true, intervalMinutes: 15, staleAfterMinutes: 30 },
      },
    },
  };
}

function record(over: Partial<WeeklyReportRecord> = {}): WeeklyReportRecord {
  return {
    id: 1,
    generatedAt: new Date('2026-09-01T00:00:00.000Z'),
    periodFrom: '2026-08-25',
    periodTo: '2026-08-31',
    status: 'ok',
    payload: null,
    rendered: null,
    delivered: false,
    detail: null,
    ...over,
  };
}

function harness(over: { build?: jest.Mock; publish?: jest.Mock } = {}) {
  const build = over.build ?? jest.fn().mockResolvedValue(report());
  const publish = over.publish ?? jest.fn().mockResolvedValue(true);
  const publishFailure = jest.fn().mockResolvedValue(true);
  const recordSuccess = jest.fn().mockResolvedValue(record());
  const recordFailure = jest
    .fn()
    .mockResolvedValue(record({ id: 2, status: 'error' }));
  const markDelivered = jest.fn().mockResolvedValue(undefined);

  const service = new WeeklyReportService(
    { build } as unknown as WeeklyReportBuilder,
    {
      recordSuccess,
      recordFailure,
      markDelivered,
    } as unknown as WeeklyReportStore,
    { publish, publishFailure } as unknown as WeeklyReportPublisher,
  );

  return {
    service,
    build,
    publish,
    publishFailure,
    recordSuccess,
    recordFailure,
    markDelivered,
  };
}

/** Argument `index` of the first call to `mock`, typed by the caller. */
function firstArg<T>(mock: jest.Mock, index: number): T {
  const calls = mock.mock.calls as unknown[][];
  if (calls.length === 0) {
    throw new Error('mock was never called');
  }
  return calls[0][index] as T;
}

describe('lastCompleteDay', () => {
  it('is yesterday, so the newest day is never a partial one', () => {
    // Including today would make the last bucket structurally smaller than the
    // other six, and every week-over-week comparison would read as a decline —
    // wrong in the same direction every single week.
    const now = Date.parse('2026-09-01T10:00:00-03:00');
    expect(lastCompleteDay(now)).toBe('2026-08-31');
  });
});

describe('WeeklyReportService', () => {
  describe('a successful run', () => {
    it('persists BEFORE delivering, then stamps the delivery', async () => {
      const h = harness();
      const order: string[] = [];
      h.recordSuccess.mockImplementation(() => {
        order.push('persist');
        return Promise.resolve(record());
      });
      h.publish.mockImplementation(() => {
        order.push('publish');
        return Promise.resolve(true);
      });

      const result = await h.service.run('2026-08-31');

      // The order is load-bearing: a Discord outage must cost the message, not
      // the content.
      expect(order).toEqual(['persist', 'publish']);
      expect(h.markDelivered).toHaveBeenCalledWith(1);
      expect(result.delivered).toBe(true);
    });

    it('keeps the stored report when delivery fails, unstamped', async () => {
      const h = harness({ publish: jest.fn().mockResolvedValue(false) });

      const result = await h.service.run('2026-08-31');

      expect(h.recordSuccess).toHaveBeenCalled();
      expect(h.markDelivered).not.toHaveBeenCalled();
      expect(result.delivered).toBe(false);
      expect(result.status).toBe('ok');
    });

    it('stores exactly the text it sends', async () => {
      const h = harness();

      await h.service.run('2026-08-31');

      const stored = firstArg<{ rendered: string }>(h.recordSuccess, 0);
      const sent = firstArg<string>(h.publish, 1);
      expect(stored.rendered).toBe(sent);
    });
  });

  describe('a failed run is still a run', () => {
    it('persists an error row and announces the failure in the channel', async () => {
      // Criterion 3: a weekly report that simply stops arriving is
      // indistinguishable from a quiet week.
      const h = harness({
        build: jest.fn().mockRejectedValue(new Error('boom')),
      });

      const result = await h.service.run('2026-08-31');

      expect(h.recordFailure).toHaveBeenCalledWith(
        expect.objectContaining({
          periodFrom: '2026-08-25',
          periodTo: '2026-08-31',
        }),
      );
      expect(h.publishFailure).toHaveBeenCalled();
      expect(h.publish).not.toHaveBeenCalled();
      expect(result.status).toBe('error');
    });

    it('never puts the upstream message in the channel or the row', async () => {
      const h = harness({
        build: jest
          .fn()
          .mockRejectedValue(
            new Error("Access denied for user 'plan_ro'@'10.0.0.5'"),
          ),
      });

      await h.service.run('2026-08-31');

      const stored = firstArg<{ detail: string; rendered: string }>(
        h.recordFailure,
        0,
      );
      const sent = firstArg<string>(h.publishFailure, 1);
      for (const text of [stored.detail, stored.rendered, sent]) {
        expect(text).not.toContain('10.0.0.5');
        expect(text).not.toContain('plan_ro');
      }
    });
  });
});
