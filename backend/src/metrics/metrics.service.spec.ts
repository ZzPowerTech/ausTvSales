import { NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PlanApiClient } from '../instrumentation/plan-api.client';
import { PlanUnreachableError } from '../instrumentation/plan-api.errors';
import { PlanServersConfig } from '../instrumentation/plan-servers.config';
import { MetricsService } from './metrics.service';
import { PlanCache } from './plan-cache';

/** Trimmed real payload of `/v1/serverOverview?server=Survival` (2026-08-23). */
const SERVER_OVERVIEW = {
  timestamp: 1787494648039,
  last_7_days: {
    new_players: 43,
    unique_players: 237,
    new_players_retention: 25,
    new_players_retention_perc: '58.14%',
  },
  numbers: {
    online_players: '8',
    sessions: 138965,
    total_players: 5540,
    last_peak_date: 1787427319373,
  },
};

/** Trimmed real payload of `/v1/onlineOverview?server=Survival` (2026-08-25). */
const ONLINE_OVERVIEW = {
  timestamp: 1787692872298,
  numbers: {
    new_players_7d: 36,
    unique_players_7d: 230,
    sessions_7d: 1588,
    playtime_7d: 3833062041,
    session_length_7d_avg: 2413767,
    new_players_retention_7d: 24,
  },
};

const T0 = new Date('2026-08-25T12:00:00.000Z');

/** `T0` plus an offset, for moving past a TTL without touching the clock. */
function at(msAfterT0: number): Date {
  return new Date(T0.getTime() + msAfterT0);
}

function build(getJson: jest.Mock) {
  // `satisfies Pick<...>` rather than a bare cast: the service touches only
  // these members, and pinning them means adding a dependency fails here at
  // compile time instead of compiling into a fake that no longer resembles the
  // real collaborator.
  const plan = { getJson } satisfies Pick<PlanApiClient, 'getJson'>;

  const servers = {
    all: () => [
      { name: 'AusTv', proxy: true },
      { name: 'Survival', proxy: false },
    ],
  } satisfies Pick<PlanServersConfig, 'all'>;

  const config = {
    get: (key: string) => (key === 'PLAN_CACHE_TTL_SERVER_SECONDS' ? 60 : 900),
  };

  return new MetricsService(
    plan as unknown as PlanApiClient,
    servers as unknown as PlanServersConfig,
    new PlanCache(),
    config as unknown as ConfigService,
  );
}

describe('MetricsService', () => {
  describe('configuredServers', () => {
    it('reports the proxy flag, which is not decoration', () => {
      // Proxy records users, backends record sessions (spec §2). A
      // session-derived metric is structurally empty on a proxy, and ignoring
      // that produced a false incident hypothesis on 2026-08-23.
      const { servers } = build(jest.fn()).configuredServers();

      expect(servers).toEqual([
        { name: 'AusTv', proxy: true },
        { name: 'Survival', proxy: false },
      ]);
    });
  });

  describe('serverOverview', () => {
    it('normalises the real payload into the contract', async () => {
      const getJson = jest.fn().mockResolvedValue(SERVER_OVERVIEW);

      const { body, degraded } =
        await build(getJson).serverOverview('Survival');

      expect(degraded).toBe(false);
      expect(body.data).toEqual({
        server: 'Survival',
        observedAt: new Date(1787494648039).toISOString(),
        onlinePlayers: 8,
        totalPlayers: 5540,
        totalSessions: 138965,
        lastPeakAt: new Date(1787427319373).toISOString(),
        newPlayers7d: 43,
        uniquePlayers7d: 237,
        newPlayerRetention7d: { value: 25, n: 43 },
      });
    });

    it('never lets a Plan field name reach the contract', async () => {
      // ADR-002: the JSON API is the stable surface *for us*. A consumer that
      // grew to depend on `new_players_7d` would break on a Plan upgrade nobody
      // here controls.
      const getJson = jest.fn().mockResolvedValue(SERVER_OVERVIEW);

      const { body } = await build(getJson).serverOverview('Survival');
      const serialised = JSON.stringify(body);

      expect(serialised).not.toContain('new_players');
      expect(serialised).not.toContain('last_7_days');
      expect(serialised).not.toContain('58.14');
    });

    it('asks Plan with the configured spelling, not the caller’s', async () => {
      // Plan's `?server=` is case sensitive: forwarding `survival` where the
      // instance is `Survival` earns a 403 that would look like an outage here.
      const getJson = jest.fn().mockResolvedValue(SERVER_OVERVIEW);

      const { body } = await build(getJson).serverOverview('sURVIVAL');

      expect(getJson).toHaveBeenCalledWith('/v1/serverOverview', {
        server: 'Survival',
      });
      expect(body.data?.server).toBe('Survival');
    });

    it('refuses a server outside PLAN_SERVERS without contacting Plan', async () => {
      // Forwarding an arbitrary name would let a caller probe the Plan instance
      // for server names through this API.
      const getJson = jest.fn();

      await expect(
        build(getJson).serverOverview('NaoExiste'),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(getJson).not.toHaveBeenCalled();
    });

    it('serves the cached value inside the TTL without touching Plan', async () => {
      // The cache is protection, not optimisation: every uncached read is an
      // HTTP request to a webserver inside the Minecraft process.
      const getJson = jest.fn().mockResolvedValue(SERVER_OVERVIEW);
      const service = build(getJson);

      await service.serverOverview('Survival');
      const { body } = await service.serverOverview('Survival');

      expect(getJson).toHaveBeenCalledTimes(1);
      expect(body.freshness.stale).toBe(false);
      expect(body.data?.onlinePlayers).toBe(8);
    });

    it('degrades to the stale value when Plan falls over', async () => {
      const getJson = jest
        .fn()
        .mockResolvedValueOnce(SERVER_OVERVIEW)
        .mockRejectedValue(new PlanUnreachableError('http://x/v1/y'));
      const service = build(getJson);
      await service.serverOverview('Survival', T0);

      // Past the 60s TTL, so the second read refetches and fails. The clock is
      // a parameter rather than `useFakeTimers`, which also mocks `setTimeout`
      // and would hang against the transport's own retry backoff.
      const { body, degraded } = await service.serverOverview(
        'Survival',
        at(120_000),
      );

      expect(degraded).toBe(true);
      expect(body.freshness.stale).toBe(true);
      // The value survives — a usable old reading beats an empty page.
      expect(body.data?.onlinePlayers).toBe(8);
      expect(body.freshness.ageSeconds).toBe(120);
      // Classified, not the raw message: that one names the Plan host.
      expect(body.freshness.reason).toBe('unreachable');
    });

    it('never publishes the Plan host or an upstream body in `reason`', async () => {
      // The raw message is `Plan inalcancavel em http://<host>:<port>/v1/...`,
      // and other failures in the taxonomy quote up to 200 characters of Plan's
      // own response — typically an HTML login page when auth is misconfigured.
      // Behind the session that is not an open disclosure, but internal topology
      // and unfiltered upstream content have no reason to reach a browser.
      const getJson = jest
        .fn()
        .mockRejectedValue(
          new PlanUnreachableError(
            'http://198.51.100.7:25504/v1/serverOverview',
          ),
        );

      const { body } = await build(getJson).serverOverview('Survival');

      expect(body.freshness.reason).toBe('unreachable');
      expect(JSON.stringify(body)).not.toContain('198.51.100.7');
      expect(JSON.stringify(body)).not.toContain('25504');
    });

    it('distinguishes a contract change from an outage', async () => {
      // Different causes, different fixes: one is an incident on the game VPS,
      // the other is a Plan upgrade that changed a payload we parse.
      const getJson = jest.fn().mockResolvedValue({ unexpected: true });

      const { body } = await build(getJson).serverOverview('Survival');

      expect(body.freshness.reason).toBe('contract_mismatch');
    });

    it('does not invent a timestamp for a server that never peaked', async () => {
      // `toNumber` maps Plan's sentinels to null, but a literal 0 is a finite
      // number and would render as 1970-01-01 — an invented timestamp in a
      // module whose premise is not inventing values.
      const getJson = jest.fn().mockResolvedValue({
        ...SERVER_OVERVIEW,
        numbers: { ...SERVER_OVERVIEW.numbers, last_peak_date: 0 },
      });

      const { body } = await build(getJson).serverOverview('Survival');

      expect(body.data?.lastPeakAt).toBeNull();
    });

    it('answers null data — never zeros — when there is nothing cached', async () => {
      // "We could not ask" and "the answer is zero" are different facts, and
      // this epic exists because eight months of the first were read as the
      // second.
      const getJson = jest
        .fn()
        .mockRejectedValue(new PlanUnreachableError('http://x/v1/y'));

      const { body, degraded } =
        await build(getJson).serverOverview('Survival');

      expect(degraded).toBe(true);
      expect(body.data).toBeNull();
      // Nothing was served, so there is nothing to be stale about.
      expect(body.freshness.stale).toBe(false);
      expect(body.freshness.fetchedAt).toBeNull();
    });

    it('treats an unrecognised response as a failure, not as data', async () => {
      // A contract change must degrade like an outage. Publishing a half-parsed
      // body is how a silent schema drift becomes a wrong number on a dashboard.
      const getJson = jest.fn().mockResolvedValue({ unexpected: true });

      const { body, degraded } =
        await build(getJson).serverOverview('Survival');

      expect(degraded).toBe(true);
      expect(body.data).toBeNull();
      expect(body.freshness.reason).toBe('contract_mismatch');
    });
  });

  describe('serverActivity', () => {
    it('keeps the base beside every ratio', async () => {
      // The contract does not publish a percentage without its base — the rule
      // that three wrong conclusions in this project were traced to.
      const getJson = jest.fn().mockResolvedValue(ONLINE_OVERVIEW);

      const { body } = await build(getJson).serverActivity('Survival');

      expect(body.data?.last7d.newPlayerRetention).toEqual({
        value: 24,
        n: 36,
      });
    });

    it('uses its own cache entry, so the two TTLs cannot collide', async () => {
      // `serverOverview` carries a live player count worth refetching;
      // `onlineOverview` is 30-day aggregates that barely move. Sharing an entry
      // would force one of the two to be wrong.
      const getJson = jest
        .fn()
        .mockResolvedValueOnce(SERVER_OVERVIEW)
        .mockResolvedValueOnce(ONLINE_OVERVIEW);
      const service = build(getJson);

      await service.serverOverview('Survival');
      const { body } = await service.serverActivity('Survival');

      expect(getJson).toHaveBeenCalledTimes(2);
      expect(getJson).toHaveBeenLastCalledWith('/v1/onlineOverview', {
        server: 'Survival',
      });
      expect(body.data?.last7d.sessions).toBe(1588);
    });

    it('carries durations in milliseconds, with the unit in the name', async () => {
      const getJson = jest.fn().mockResolvedValue(ONLINE_OVERVIEW);

      const { body } = await build(getJson).serverActivity('Survival');

      expect(body.data?.last7d.playtimeMs).toBe(3833062041);
      expect(body.data?.last7d.sessionLengthAvgMs).toBe(2413767);
    });

    it('reports an unmeasured window as null across the board', async () => {
      const getJson = jest
        .fn()
        .mockResolvedValue({ timestamp: 1, numbers: {} });

      const { body } = await build(getJson).serverActivity('Survival');

      expect(body.data?.last30d).toEqual({
        newPlayers: null,
        uniquePlayers: null,
        sessions: null,
        playtimeMs: null,
        sessionLengthAvgMs: null,
        newPlayerRetention: { value: null, n: null },
      });
    });
  });
});
