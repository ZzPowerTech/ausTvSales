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

  describe('nao cobra nada da maquina do jogo', () => {
    /**
     * The property: one cycle of this check costs the game machine nothing.
     *
     * It used to be asserted as `NetworkToSurvivalCheck.length === 1`, which
     * tested the wrong thing in both directions. It failed on any second
     * collaborator that was not a client or a pool — a Logger, a clock — with a
     * message about network calls, sending whoever debugged it to look for
     * something that was not there. And it passed if `run()` started reaching
     * the Plan through a module-level singleton, a static, or a bare `fetch`,
     * because none of those change the constructor's arity.
     *
     * What replaces it observes the call actually happening. What is *not*
     * asserted here, because the type system already does it: that no
     * `PlanDatabase` is injected. Adding one as a required dependency breaks
     * every construction in this file at compile time, which is a harder guard
     * than any runtime spy.
     */
    it('nao faz nenhuma chamada HTTP durante o ciclo', async () => {
      // `PlanApiClient` reaches the Plan through the global `fetch`, so this
      // catches the regression by ANY route — an injected client, a singleton,
      // or a bare `fetch()` written into `run()`. Same pattern the
      // `discord-alerter` spec uses.
      const realFetch = global.fetch;
      const fetchMock = jest.fn();
      global.fetch = fetchMock;

      try {
        await new NetworkToSurvivalCheck(serversConfig(ONE_BACKEND)).run();
        expect(fetchMock).not.toHaveBeenCalled();
      } finally {
        global.fetch = realFetch;
      }
    });

    it('le apenas `backends()` do unico colaborador que recebe', async () => {
      // Records what `run()` reads off its collaborator. Methods are handed
      // back bound to the raw target, so the object's own internal `this`
      // access does not count as the check touching it — what the assertion
      // sees is exactly the surface `run()` used.
      const touched: string[] = [];
      const target = serversConfig(ONE_BACKEND);
      const recorded = new Proxy(target, {
        get(object, property, receiver) {
          if (typeof property === 'string') {
            touched.push(property);
          }
          const value = Reflect.get(object, property, receiver) as unknown;
          return typeof value === 'function'
            ? (value as (...args: unknown[]) => unknown).bind(object)
            : value;
        },
      });

      await new NetworkToSurvivalCheck(recorded).run();

      expect([...new Set(touched)]).toEqual(['backends']);
    });

    it('resolve mesmo com fetch e o relogio indisponiveis', async () => {
      // The strongest statement of "this answer does not depend on anything
      // outside the process": make the two ways out of it throw, and the check
      // still produces its verdicts.
      const realFetch = global.fetch;
      global.fetch = () => {
        throw new Error('a rede nao deveria ser tocada neste check');
      };

      try {
        const observations = await new NetworkToSurvivalCheck(
          serversConfig(ONE_BACKEND),
        ).run();

        expect(observations).toHaveLength(1);
        expect(observations[0].status).toBe('no_data');
      } finally {
        global.fetch = realFetch;
      }
    });
  });
});
