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
    enteredBetween: jest.fn(() =>
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
    it('errors after ONE missed night, not after a whole window', async () => {
      // The tolerance is sized to the ETL's period, and getting that wrong is
      // the defect the first version of this check shipped with. Allowing the
      // source to age a full 7 days let the ratio decay almost to zero — and
      // fire, blaming the tutorial — before the guard ever closed. The nightly
      // cron leaves the series ~24h old at worst, so 36h names one missed night.
      const [observation] = await build(
        planWith(overview(100)),
        storeWith({ entered: 90, syncAgeMs: 40 * 3_600_000 }),
      ).run();

      expect(observation.status).toBe('error');
      expect(observation.detail.summary).toContain('ETL do tutorial');
      expect(observation.detail.summary).toContain('40h');
      // No ratio at all: publishing one from a frozen source is the mistake.
      expect(observation.detail.observed).toBeUndefined();
    });

    it('does NOT publish a decayed ratio at four days stale', async () => {
      // The exact scenario the review reproduced against the first version: the
      // ETL has been dead four nights, the tutorial is perfectly healthy, and
      // the check published `breached` at 50% citing the eight-month outage.
      // The alert was real, the blame was wrong, and the tolerance was why.
      const [observation] = await build(
        planWith(overview(100)),
        storeWith({ entered: 50, syncAgeMs: 4 * MS_PER_DAY }),
      ).run();

      expect(observation.status).toBe('error');
      expect(observation.status).not.toBe('breached');
      expect(observation.detail.summary).not.toContain('8 meses');
    });

    it('accepts a normal overnight age', async () => {
      // A 25-hour-old series is what a healthy nightly cron looks like just
      // before the next run. Refusing it would make the check permanently mute.
      const [observation] = await build(
        planWith(overview(100)),
        storeWith({ entered: 90, syncAgeMs: 25 * 3_600_000 }),
      ).run();

      expect(observation.status).toBe('ok');
    });

    it('refuses when the clocks disagree, instead of trusting a negative age', async () => {
      // `ranAt` is stamped by Postgres and compared against this process's
      // clock, and `CLAUDE.md` puts the database on a shared instance. A future
      // `ranAt` makes the age negative, which passes every `>` test and switches
      // the freshness gate off completely — the check would then publish a ratio
      // from an arbitrarily stale source.
      const [observation] = await build(
        planWith(overview(100)),
        storeWith({ entered: 50, syncAgeMs: -5 * MS_PER_DAY }),
      ).run();

      expect(observation.status).toBe('error');
      expect(observation.status).not.toBe('breached');
      expect(observation.detail.summary).toContain('FUTURO');
      expect(observation.detail.summary).toContain('NTP');
    });

    it('honours a configured tolerance', async () => {
      const [observation] = await build(
        planWith(overview(100)),
        storeWith({ entered: 90, syncAgeMs: 40 * 3_600_000 }),
        { TUTORIAL_MAX_SYNC_AGE_HOURS: 72 },
      ).run();

      expect(observation.status).toBe('ok');
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

  describe('the two sides are counted over the same span', () => {
    it('asks for a CLOSED seven-day range, not an open one', async () => {
      // The open `>= fromDay` counted eight calendar days against a seven-day
      // denominator — a systematic +14% on the numerator, in the direction that
      // HIDES a breach: a true 62% published as ~71% and reported `ok`.
      const enteredBetween = jest.fn(() => Promise.resolve(90));
      const store = {
        lastSuccessfulSync: jest.fn(() =>
          Promise.resolve({ id: 1, ranAt: new Date(), status: 'ok' }),
        ),
        enteredBetween,
      } as unknown as TutorialStore;

      await build(planWith(overview(100)), store).run();

      const [from, to] = enteredBetween.mock.calls[0] as unknown as [
        string,
        string,
      ];
      const spanDays =
        (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) /
          MS_PER_DAY +
        1;
      // Both ends inclusive, so the span is exactly the window.
      expect(spanDays).toBe(7);
    });

    it('names the population skew instead of publishing a tidy 130%', async () => {
      // The numerator is network-wide and the denominator is per-server, so the
      // ratio can exceed 100%. Printing "130% entraram no tutorial" as if it
      // were a clean reading is the kind of number this project has been burned
      // by three times. Still `ok` — entry is plainly not collapsing.
      const [observation] = await build(
        planWith(overview(100)),
        storeWith({ entered: 130 }),
      ).run();

      expect(observation.status).toBe('ok');
      expect(observation.detail.summary).toContain('acima de 100%');
      expect(observation.detail.summary).toContain('mesma populacao');
      // The raw numbers still travel, so the reader can judge for themselves.
      expect(observation.detail.n).toBe(100);
      expect(observation.detail.context?.entraram_no_tutorial).toBe(130);
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
