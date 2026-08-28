import { ConfigService } from '@nestjs/config';
import type { TutorialStore } from '../tutorial/tutorial.store';
import type { PlanApiClient } from './plan-api.client';
import { PlanUnreachableError } from './plan-api.errors';
import { PlanServersConfig } from './plan-servers.config';
import { TutorialEntryRateCheck } from './tutorial-entry-rate.check';

function config(values: Record<string, unknown> = {}): ConfigService {
  return {
    get: <T>(key: string): T | undefined => values[key] as T | undefined,
  } as unknown as ConfigService;
}

const SERVERS = new PlanServersConfig(
  config({ PLAN_SERVERS: 'AusTv,Survival', PLAN_PROXY_SERVER: 'AusTv' }),
);

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

const MS_PER_DAY = 86_400_000;

interface StoreOptions {
  entered?: number;
  /** How long ago the last successful ETL ran. Default: an hour. */
  syncAgeMs?: number | null;
  enteredThrows?: boolean;
}

function storeWith({
  entered = 0,
  syncAgeMs = 3_600_000,
  enteredThrows = false,
}: StoreOptions): TutorialStore {
  return {
    lastSuccessfulSync: jest.fn(() =>
      Promise.resolve(
        syncAgeMs === null
          ? null
          : { id: 1, ranAt: new Date(Date.now() - syncAgeMs), status: 'ok' },
      ),
    ),
    enteredSince: jest.fn(() =>
      enteredThrows
        ? Promise.reject(new Error('postgres fora do ar'))
        : Promise.resolve(entered),
    ),
  } as unknown as TutorialStore;
}

function build(
  plan: PlanApiClient,
  store: TutorialStore,
  values: Record<string, unknown> = {},
): TutorialEntryRateCheck {
  return new TutorialEntryRateCheck(plan, SERVERS, store, config(values));
}

describe('TutorialEntryRateCheck', () => {
  it('evaluates backends only, never the proxy', async () => {
    // The proxy records users, the backends record sessions (spec §2), so
    // `new_players` on a proxy is structurally empty. Evaluating it would
    // produce a permanent, false breach.
    const observations = await build(
      planWith(overview(100)),
      storeWith({ entered: 90 }),
    ).run();

    expect(observations).toHaveLength(1);
    expect(observations[0].checkName).toBe(
      'funnel.tutorial_entry_rate:Survival',
    );
  });

  describe('the verdict', () => {
    it('is ok when the rate clears the floor', async () => {
      const [observation] = await build(
        planWith(overview(100)),
        storeWith({ entered: 90 }),
      ).run();

      expect(observation.status).toBe('ok');
      expect(observation.detail.observed).toBe(90);
      // The denominator travels with the ratio, always.
      expect(observation.detail.n).toBe(100);
      expect(observation.detail.context?.entraram_no_tutorial).toBe(90);
    });

    it('is breached under the floor, and names the disaster it mirrors', async () => {
      const [observation] = await build(
        planWith(overview(100)),
        storeWith({ entered: 12 }),
      ).run();

      expect(observation.status).toBe('breached');
      // 12% is the real figure the entry rate had fallen to by april/2026.
      expect(observation.detail.observed).toBe(12);
      expect(observation.detail.threshold).toBe(70);
      expect(observation.detail.n).toBe(100);
    });

    it('honours a configured floor', async () => {
      const [observation] = await build(
        planWith(overview(100)),
        storeWith({ entered: 60 }),
        { FUNNEL_MIN_TUTORIAL_ENTRY_RATE: 0.5 },
      ).run();

      expect(observation.status).toBe('ok');
      expect(observation.detail.threshold).toBe(50);
    });
  });

  describe("a stale numerator is reported as OUR failure, not the tutorial's", () => {
    it('errors when the ETL has not succeeded within the window', async () => {
      // The trap this check is most exposed to: the denominator is fetched live
      // and the numerator is whatever the last nightly ETL wrote. A frozen
      // numerator over a growing denominator is a ratio that falls on its own —
      // it would fire this alert, blame the tutorial, and be wrong.
      const [observation] = await build(
        planWith(overview(100)),
        storeWith({ entered: 90, syncAgeMs: 9 * MS_PER_DAY }),
      ).run();

      expect(observation.status).toBe('error');
      expect(observation.detail.summary).toContain('ETL do tutorial');
      expect(observation.detail.summary).toContain('9 dia');
      // No ratio at all: publishing one from a frozen source is the mistake.
      expect(observation.detail.observed).toBeUndefined();
    });

    it('errors when the ETL has never succeeded', async () => {
      const [observation] = await build(
        planWith(overview(100)),
        storeWith({ syncAgeMs: null }),
      ).run();

      expect(observation.status).toBe('error');
      expect(observation.detail.summary).toContain('nunca rodou');
      expect(observation.detail.summary).toContain('TUTORIAL_SYNC_ENABLED');
    });

    it('uses `error` and not `no_data`, because only `error` notifies', async () => {
      // The distinction is load-bearing: `NOTIFIABLE_STATUSES` holds `error` and
      // not `no_data`, so a stopped ETL filed as `no_data` would sit in the
      // table unannounced — the exact silence this epic exists to remove.
      const [observation] = await build(
        planWith(overview(100)),
        storeWith({ syncAgeMs: 30 * MS_PER_DAY }),
      ).run();

      expect(observation.status).toBe('error');
      expect(observation.status).not.toBe('no_data');
    });

    it('does not even ask Plan when the numerator is unusable', async () => {
      // No point paying a request to a webserver inside the Minecraft process
      // for a ratio that cannot be computed.
      // The spy is held separately rather than read off the object: detaching a
      // method from its receiver is how a `this`-dependent one silently breaks,
      // and the lint rule that flags it is right to.
      const getJson = jest.fn(() => Promise.resolve(overview(100)));
      const plan = { getJson } as unknown as PlanApiClient;

      await build(plan, storeWith({ syncAgeMs: null })).run();

      expect(getJson).not.toHaveBeenCalled();
    });
  });

  describe('missing data is never a zero', () => {
    it('reports no_data when Plan did not measure arrivals', async () => {
      // Treating a missing denominator as zero would divide by it.
      const [observation] = await build(
        planWith(overview(null)),
        storeWith({ entered: 90 }),
      ).run();

      expect(observation.status).toBe('no_data');
      expect(observation.detail.observed).toBeUndefined();
    });

    it('reports no_data below the minimum sample', async () => {
      const [observation] = await build(
        planWith(overview(5)),
        storeWith({ entered: 1 }),
      ).run();

      expect(observation.status).toBe('no_data');
      // A ratio is withheld, but the base that made it unusable is published.
      expect(observation.detail.n).toBe(5);
    });

    it('reports zero entrants as a real breach, not as missing data', async () => {
      // Zero from a fresh ETL over a healthy denominator is a measurement, and
      // it is the shape of the eight-month outage.
      const [observation] = await build(
        planWith(overview(100)),
        storeWith({ entered: 0 }),
      ).run();

      expect(observation.status).toBe('breached');
      expect(observation.detail.observed).toBe(0);
      expect(observation.detail.n).toBe(100);
    });
  });

  describe('source failures', () => {
    it('errors, never ok, when Plan is unreachable', async () => {
      const plan = {
        getJson: jest.fn(() =>
          Promise.reject(new PlanUnreachableError('http://plan:25504/v1/x')),
        ),
      } as unknown as PlanApiClient;

      const [observation] = await build(plan, storeWith({ entered: 90 })).run();

      expect(observation.status).toBe('error');
    });

    it('errors when the tutorial series cannot be read', async () => {
      const [observation] = await build(
        planWith(overview(100)),
        storeWith({ enteredThrows: true }),
      ).run();

      expect(observation.status).toBe('error');
      expect(observation.detail.summary).toContain('postgres fora do ar');
    });

    it('errors when Plan answers a shape the adapter does not know', async () => {
      const [observation] = await build(
        planWith({ nao: 'e o que esperavamos' }),
        storeWith({ entered: 90 }),
      ).run();

      expect(observation.status).toBe('error');
      expect(observation.detail.summary).toContain('formato inesperado');
    });
  });

  it('returns nothing when no backend is configured', async () => {
    const check = new TutorialEntryRateCheck(
      planWith(overview(100)),
      new PlanServersConfig(config({})),
      storeWith({ entered: 90 }),
      config(),
    );

    // An empty array means "there was nothing to evaluate", which the runner
    // does not manufacture a row for.
    await expect(check.run()).resolves.toEqual([]);
  });
});
