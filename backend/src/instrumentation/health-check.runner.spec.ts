import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AlertDecision } from './alert-policy';
import type { DiscordAlerter } from './discord-alerter';
import type { HealthCheck } from './health-check.contract';
import { HealthCheckRunner } from './health-check.runner';
import type {
  HealthCheckObservation,
  HealthCheckStore,
} from './health-check.store';
import {
  HealthCheckName,
  type HealthCheckRecord,
  type HealthCheckStatus,
} from './health-check.types';

/** Order in which the runner touched the store — the ordering is load-bearing. */
let calls: string[];

function observation(
  checkName: string,
  status: HealthCheckStatus = 'ok',
): HealthCheckObservation {
  return { checkName, status, detail: { summary: 'teste' } };
}

function asRecord(
  observation: HealthCheckObservation,
  id: number,
): HealthCheckRecord {
  return {
    id,
    checkName: observation.checkName,
    status: observation.status,
    checkedAt: new Date('2026-08-23T12:00:00Z'),
    detail: observation.detail,
    alertedAt: null,
  };
}

interface StoreStub {
  store: HealthCheckStore;
  record: jest.Mock;
  lastAlert: jest.Mock;
  alertsInWindow: jest.Mock<Promise<Map<HealthCheckStatus, number>>, unknown[]>;
  /** Typed: an untyped mock let a `Map` stand in for the `number` it returns. */
  healthyStreak: jest.Mock<Promise<number>, unknown[]>;
  markAlerted: jest.Mock;
}

function buildStore(): StoreStub {
  const record = jest.fn((observations: HealthCheckObservation[]) => {
    calls.push('record');
    return Promise.resolve(observations.map(asRecord));
  });
  const lastAlert = jest.fn(() => {
    calls.push('lastAlert');
    return Promise.resolve(null);
  });
  const alertsInWindow = jest.fn(() => {
    calls.push('alertsInWindow');
    return Promise.resolve(new Map<HealthCheckStatus, number>());
  });
  const healthyStreak = jest.fn(() => {
    calls.push('healthyStreak');
    return Promise.resolve(0);
  });
  const markAlerted = jest.fn((ids: number[]) => {
    calls.push('markAlerted');
    return Promise.resolve(ids.length);
  });

  return {
    store: {
      record,
      lastAlert,
      alertsInWindow,
      healthyStreak,
      markAlerted,
    } as unknown as HealthCheckStore,
    record,
    lastAlert,
    alertsInWindow,
    healthyStreak,
    markAlerted,
  };
}

function buildAlerter(delivered: number[] = []): {
  alerter: DiscordAlerter;
  publish: jest.Mock;
} {
  const publish = jest.fn(() => {
    calls.push('publish');
    return Promise.resolve(delivered);
  });
  return { alerter: { publish } as unknown as DiscordAlerter, publish };
}

function config(values: Record<string, unknown> = {}): ConfigService {
  return {
    get: <T>(key: string): T | undefined => values[key] as T | undefined,
  } as unknown as ConfigService;
}

function fakeCheck(
  name: string,
  run: () => Promise<HealthCheckObservation[]>,
): HealthCheck {
  return { name: name as HealthCheckName, run };
}

/**
 * First argument of the first recorded call, through a declared tuple type.
 *
 * `jest.Mock` without generics types `mock.calls` as `any[]`; indexing it
 * directly would silently disable type checking on every assertion built from
 * the result.
 */
function firstArg<T>(mock: jest.Mock): T {
  return (mock.mock.calls as unknown as Array<[T]>)[0][0];
}

describe('HealthCheckRunner', () => {
  beforeEach(() => {
    calls = [];
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('ordering', () => {
    it('reads the alert state AFTER persisting the new verdicts', async () => {
      const store = buildStore();
      const { alerter } = buildAlerter();
      const check = fakeCheck(HealthCheckName.OrphanInstance, () =>
        Promise.resolve([observation('plan.orphan_instance', 'breached')]),
      );

      await new HealthCheckRunner(store.store, alerter, config(), [
        check,
      ]).runAll();

      // `healthyStreak` has to include the verdict this cycle just wrote — the
      // question is "has it been ok for two cycles *including this one*". And
      // `lastAlert` reads rows that only ever get stamped after delivery, so it
      // cannot be polluted by the insert.
      expect(calls.indexOf('record')).toBeLessThan(calls.indexOf('lastAlert'));
      expect(calls.indexOf('record')).toBeLessThan(
        calls.indexOf('healthyStreak'),
      );
    });

    it('stamps alerted_at only after the alerter reports delivery', async () => {
      const store = buildStore();
      const { alerter } = buildAlerter([1]);
      const check = fakeCheck(HealthCheckName.OrphanInstance, () =>
        Promise.resolve([observation('plan.orphan_instance', 'breached')]),
      );

      await new HealthCheckRunner(store.store, alerter, config(), [
        check,
      ]).runAll();

      // Stamping before the webhook succeeds would suppress the retry and lose
      // the alert permanently.
      expect(calls.indexOf('publish')).toBeLessThan(
        calls.indexOf('markAlerted'),
      );
    });

    it('passes exactly the delivered ids to markAlerted', async () => {
      const store = buildStore();
      const { alerter } = buildAlerter([2]);
      const check = fakeCheck(HealthCheckName.OrphanInstance, () =>
        Promise.resolve([
          observation('a', 'breached'),
          observation('b', 'breached'),
        ]),
      );

      await new HealthCheckRunner(store.store, alerter, config(), [
        check,
      ]).runAll();

      expect(store.markAlerted).toHaveBeenCalledWith([2]);
    });
  });

  describe('isolamento de falha de check', () => {
    it('turns a thrown check into an error observation', async () => {
      const store = buildStore();
      const { alerter } = buildAlerter();
      const boom = fakeCheck(HealthCheckName.CollectionAlive, () =>
        Promise.reject(new Error('Plan inalcancavel')),
      );

      const summary = await new HealthCheckRunner(
        store.store,
        alerter,
        config(),
        [boom],
      ).runAll();

      expect(summary.byStatus.error).toBe(1);
      const recorded = firstArg<HealthCheckObservation[]>(store.record);
      expect(recorded[0].status).toBe('error');
      expect(recorded[0].detail.summary).toContain('Plan inalcancavel');
    });

    it('keeps running the other checks after one throws', async () => {
      const store = buildStore();
      const { alerter } = buildAlerter();
      const boom = fakeCheck(HealthCheckName.CollectionAlive, () =>
        Promise.reject(new Error('falhou')),
      );
      const fine = fakeCheck(HealthCheckName.OrphanInstance, () =>
        Promise.resolve([observation('plan.orphan_instance', 'ok')]),
      );

      // One broken check must never silence the other six — that would be the
      // blindness this epic exists to remove.
      const summary = await new HealthCheckRunner(
        store.store,
        alerter,
        config(),
        [boom, fine],
      ).runAll();

      expect(summary.observations).toBe(2);
      expect(summary.byStatus.error).toBe(1);
      expect(summary.byStatus.ok).toBe(1);
    });

    it('records a check that returns no observations without inventing a row', async () => {
      const store = buildStore();
      const { alerter } = buildAlerter();
      const empty = fakeCheck(HealthCheckName.OrphanInstance, () =>
        Promise.resolve([]),
      );

      const summary = await new HealthCheckRunner(
        store.store,
        alerter,
        config(),
        [empty],
      ).runAll();

      // "Nothing to evaluate" is not a verdict. Manufacturing an `ok` here would
      // be exactly the invented measurement the contract forbids.
      expect(summary.observations).toBe(0);
      expect(store.record).not.toHaveBeenCalled();
    });
  });

  describe('guarda de ciclo sobreposto', () => {
    it('stands down when a previous cycle is still running', async () => {
      const store = buildStore();
      const { alerter } = buildAlerter();
      let release!: () => void;
      const slow = fakeCheck(
        HealthCheckName.CollectionAlive,
        () =>
          new Promise((resolve) => {
            release = () => resolve([observation('slow', 'ok')]);
          }),
      );
      const runner = new HealthCheckRunner(store.store, alerter, config(), [
        slow,
      ]);

      const first = runner.runAll();
      const second = await runner.runAll();

      expect(second.ran).toBe(false);
      expect(second.observations).toBe(0);

      release();
      await first;
    });

    it('releases the guard even when the cycle throws', async () => {
      const store = buildStore();
      store.record.mockRejectedValueOnce(new Error('banco fora'));
      const { alerter } = buildAlerter();
      const check = fakeCheck(HealthCheckName.OrphanInstance, () =>
        Promise.resolve([observation('x', 'ok')]),
      );
      const runner = new HealthCheckRunner(store.store, alerter, config(), [
        check,
      ]);

      await expect(runner.runAll()).rejects.toThrow('banco fora');

      // A stuck flag would silence every future cycle — the worst possible
      // outcome for a system whose job is to notice silence.
      const after = await runner.runAll();
      expect(after.ran).toBe(true);
    });
  });

  describe('resumo', () => {
    it('tallies every status and reports what was delivered', async () => {
      const store = buildStore();
      const { alerter, publish } = buildAlerter([1, 2]);
      const check = fakeCheck(HealthCheckName.CollectionAlive, () =>
        Promise.resolve([
          observation('a', 'breached'),
          observation('b', 'error'),
          observation('c', 'no_data'),
          observation('d', 'ok'),
        ]),
      );

      const summary = await new HealthCheckRunner(
        store.store,
        alerter,
        config(),
        [check],
      ).runAll();

      expect(summary.ran).toBe(true);
      expect(summary.observations).toBe(4);
      expect(summary.byStatus).toEqual({
        ok: 1,
        breached: 1,
        no_data: 1,
        error: 1,
      });
      expect(summary.alerted).toBe(2);

      const decision = firstArg<AlertDecision>(publish);
      // Com `lastAlert` vazio, so `breached` e `error` viram mensagem: um `ok`
      // nao tem nada para fechar e um `no_data` nao tem falha aberta atras dele.
      expect(decision.announce).toHaveLength(2);
    });
  });

  describe('recuperacoes seguras', () => {
    it('conta as recuperacoes seguradas separado do resto da supressao', async () => {
      // O numero que o docblock de `recovery_unconfirmed` chama de "o numero a
      // observar" precisa existir em algum lugar observavel. Um
      // `HEALTH_ALERT_CONFIRM_RECOVERY` alto demais nunca deixa um all-clear
      // sair, e sem este campo isso nao aparece em lugar nenhum.
      const store = buildStore();
      store.lastAlert.mockResolvedValue({
        status: 'breached',
        at: new Date('2026-08-22T10:00:00.000Z'),
      });
      store.healthyStreak.mockResolvedValue(1);
      const { alerter } = buildAlerter();
      const check = fakeCheck(HealthCheckName.OrphanInstance, () =>
        Promise.resolve([observation('a', 'ok')]),
      );

      const summary = await new HealthCheckRunner(
        store.store,
        alerter,
        config(),
        [check],
      ).runAll();

      expect(summary.recoveryHeld).toBe(1);
      expect(summary.recovered).toBe(0);
    });

    it('pede a sequencia com a janela igual ao limiar configurado', async () => {
      // Uma janela menor que o limiar satura abaixo dele, e a recuperacao morre
      // de fome para sempre — com o `lastAlert` preso numa falha ja resolvida.
      const store = buildStore();
      const { alerter } = buildAlerter();
      const check = fakeCheck(HealthCheckName.OrphanInstance, () =>
        Promise.resolve([observation('a', 'ok')]),
      );

      await new HealthCheckRunner(
        store.store,
        alerter,
        config({ HEALTH_ALERT_CONFIRM_RECOVERY: 7 }),
        [check],
      ).runAll();

      expect(store.healthyStreak).toHaveBeenCalledWith('a', 7);
    });

    it('leva o teto de mensagens configurado ate a politica', () => {
      // Sem isto, `HEALTH_ALERT_MAX_PER_WINDOW` podia ser lido, guardado e nunca
      // usado, e o teste que existia passaria igual — ele so checava que o
      // alerter tinha sido chamado.
      const store = buildStore();
      store.alertsInWindow.mockResolvedValue(
        new Map<HealthCheckStatus, number>([['breached', 9]]),
      );
      const { alerter, publish } = buildAlerter();
      const check = fakeCheck(HealthCheckName.OrphanInstance, () =>
        Promise.resolve([observation('a', 'breached')]),
      );

      return new HealthCheckRunner(
        store.store,
        alerter,
        config({ HEALTH_ALERT_MAX_PER_WINDOW: 3 }),
        [check],
      )
        .runAll()
        .then(() => {
          // 9 mensagens ja ouvidas, teto 3: passou do teto e do proprio aviso,
          // entao nada sai. Com o teto ignorado, sairia.
          const decision = firstArg<AlertDecision>(publish);
          expect(decision.announce).toEqual([]);
          expect(decision.flapping).toEqual([]);
          expect(decision.suppressed).toEqual([
            expect.objectContaining({ reason: 'flapping' }),
          ]);
        });
    });

    it('conta o orcamento na mesma janela do reenvio', () => {
      const store = buildStore();
      const { alerter } = buildAlerter();
      const check = fakeCheck(HealthCheckName.OrphanInstance, () =>
        Promise.resolve([observation('a', 'breached')]),
      );

      return new HealthCheckRunner(
        store.store,
        alerter,
        config({ HEALTH_ALERT_REALERT_HOURS: 3 }),
        [check],
      )
        .runAll()
        .then(() => {
          expect(store.alertsInWindow).toHaveBeenCalledWith('a', 3 * 3_600_000);
        });
    });
  });

  describe('nome de check repetido no mesmo ciclo', () => {
    it('descarta a segunda observacao e grita', () => {
      // Duas linhas com o mesmo `check_name` num ciclo sao sempre erro de
      // configuracao (nome repetido em PLAN_SERVERS) e corrompem tres coisas de
      // uma vez: o desempate do `latestAll`, a contagem da sequencia saudavel, e
      // o orcamento — que pularia de dois em dois e poderia passar direto pelo
      // ponto em que o aviso de silenciamento sai, calando o check sem avisar.
      const store = buildStore();
      const { alerter } = buildAlerter();
      const error = jest
        .spyOn(Logger.prototype, 'error')
        .mockImplementation(() => undefined);
      const check = fakeCheck(HealthCheckName.CollectionAlive, () =>
        Promise.resolve([
          observation('plan.collection_alive:survival', 'breached'),
          observation('plan.collection_alive:survival', 'ok'),
        ]),
      );

      return new HealthCheckRunner(store.store, alerter, config(), [check])
        .runAll()
        .then((summary) => {
          expect(summary.observations).toBe(1);
          expect(error).toHaveBeenCalledWith(
            expect.stringContaining('duas observacoes no mesmo ciclo'),
          );
          error.mockRestore();
        });
    });
  });

  describe('configuracao de re-alerta', () => {
    it('converts HEALTH_ALERT_REALERT_HOURS into the policy window', async () => {
      const store = buildStore();
      const { alerter, publish } = buildAlerter();
      const check = fakeCheck(HealthCheckName.OrphanInstance, () =>
        Promise.resolve([observation('a', 'breached')]),
      );

      await new HealthCheckRunner(
        store.store,
        alerter,
        config({ HEALTH_ALERT_REALERT_HOURS: 3 }),
        [check],
      ).runAll();

      expect(publish).toHaveBeenCalled();
    });
  });
});
