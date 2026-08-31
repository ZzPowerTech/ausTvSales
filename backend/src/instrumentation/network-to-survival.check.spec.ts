import { ConfigService } from '@nestjs/config';
import {
  NetworkToSurvivalCheck,
  RATIO_STRUCTURALLY_BLIND,
} from './network-to-survival.check';
import { PlanServersConfig } from './plan-servers.config';
import { HealthCheckName } from './health-check.types';

function serversConfig(values: Record<string, string>): PlanServersConfig {
  return new PlanServersConfig({
    get: <T>(key: string): T | undefined => values[key] as T | undefined,
  } as unknown as ConfigService);
}

const ONE_BACKEND = {
  PLAN_SERVERS: 'AusTv,Survival',
  PLAN_PROXY_SERVER: 'AusTv',
};

const TWO_BACKENDS = {
  PLAN_SERVERS: 'AusTv,Survival,Creative',
  PLAN_PROXY_SERVER: 'AusTv',
};

/**
 * The check that used to publish a conversion, and now publishes why it cannot.
 *
 * These tests replace a suite that asserted the arithmetic of a ratio whose two
 * sides were the same population — `plan_users` is the Survival, measured
 * 2026-08-31, and the numerator came from `serverOverview` on that same server.
 * Every one of those cases passed, and the check they were pinning would have
 * reported `ok` with the whole network gone.
 *
 * So what is pinned here is the opposite property: **this check never claims
 * health, and never claims a number.** That is the invariant that has to survive
 * the next person who reaches for a plausible denominator.
 */
describe('NetworkToSurvivalCheck', () => {
  it('never reports ok — the ratio it was built for has no denominator', async () => {
    const observations = await new NetworkToSurvivalCheck(
      serversConfig(ONE_BACKEND),
    ).run();

    expect(observations).toHaveLength(1);
    expect(observations[0].status).toBe('no_data');
  });

  it('publishes no percentage and no base', async () => {
    const [observation] = await new NetworkToSurvivalCheck(
      serversConfig(ONE_BACKEND),
    ).run();

    // The project rule is that no percentage is published without its base.
    // With no denominator there is no base either, so both are absent — rather
    // than a `0` standing in for a measurement nobody took.
    expect(observation.detail.observed).toBeUndefined();
    expect(observation.detail.n).toBeUndefined();
    expect(observation.detail.threshold).toBeUndefined();
  });

  it('says why, naming the two sides that were the same population', async () => {
    const [observation] = await new NetworkToSurvivalCheck(
      serversConfig(ONE_BACKEND),
    ).run();

    expect(observation.detail.summary).toBe(RATIO_STRUCTURALLY_BLIND);
    // A reader of the Discord channel or of `/health/instrumentation` has to be
    // able to act on this without opening the source, so the reason names the
    // table and the endpoint rather than saying "sem fonte".
    expect(observation.detail.summary).toContain('plan_users');
    expect(observation.detail.summary).toContain('serverOverview');
  });

  it('keeps the persisted name it had while it published a ratio', async () => {
    const [observation] = await new NetworkToSurvivalCheck(
      serversConfig(ONE_BACKEND),
    ).run();

    // Not cosmetic: the store keys history on this string, and the alert policy
    // decides against what the channel was last told about this exact name.
    // Renaming would split one series into two and reset that memory.
    expect(observation.checkName).toBe(
      `${HealthCheckName.NetworkToSurvival}:Survival`,
    );
  });

  it('still emits one observation per backend', async () => {
    const observations = await new NetworkToSurvivalCheck(
      serversConfig(TWO_BACKENDS),
    ).run();

    expect(observations.map((observation) => observation.checkName)).toEqual([
      `${HealthCheckName.NetworkToSurvival}:Survival`,
      `${HealthCheckName.NetworkToSurvival}:Creative`,
    ]);
    expect(
      observations.every((observation) => observation.status === 'no_data'),
    ).toBe(true);
  });

  it('emits nothing when no backend is configured', async () => {
    const observations = await new NetworkToSurvivalCheck(
      serversConfig({ PLAN_SERVERS: '', PLAN_PROXY_SERVER: 'AusTv' }),
    ).run();

    expect(observations).toEqual([]);
  });

  it('touches neither the Plan API nor the game database', () => {
    // The constructor takes one collaborator, and that is the assertion: there
    // is no client and no pool to call. A cycle that asked the game machine for
    // a constant would be paying for nothing, every fifteen minutes, forever.
    expect(NetworkToSurvivalCheck.length).toBe(1);
  });
});
