import { decideAlerts, type AlertPolicyInput } from './alert-policy';
import {
  HealthCheckName,
  type HealthCheckRecord,
  type HealthCheckStatus,
} from './health-check.types';

const NOW = new Date('2026-08-22T12:00:00.000Z');
const HOURS = 60 * 60 * 1000;
const RE_ALERT_AFTER = 24 * HOURS;

let nextId = 1;

function observation(
  checkName: string,
  status: HealthCheckStatus,
): HealthCheckRecord {
  return {
    id: nextId++,
    checkName,
    status,
    checkedAt: NOW,
    detail: { summary: `verdito ${status}` },
    alertedAt: null,
  };
}

function decide(overrides: Partial<AlertPolicyInput>) {
  return decideAlerts({
    observations: [],
    previousStatus: new Map(),
    lastAlertAt: new Map(),
    now: NOW,
    reAlertAfterMs: RE_ALERT_AFTER,
    ...overrides,
  });
}

describe('decideAlerts', () => {
  beforeEach(() => {
    nextId = 1;
  });

  describe('entrada em falha', () => {
    it('anuncia a primeira falha de um check que nunca rodou', () => {
      const record = observation(HealthCheckName.CollectionAlive, 'breached');

      const decision = decide({ observations: [record] });

      expect(decision.announce).toEqual([record]);
      expect(decision.suppressed).toEqual([]);
    });

    it('anuncia a transicao de ok para breached', () => {
      const record = observation(HealthCheckName.TutorialEntryRate, 'breached');

      const decision = decide({
        observations: [record],
        previousStatus: new Map([[record.checkName, 'ok']]),
      });

      expect(decision.announce).toEqual([record]);
    });

    it('anuncia a transicao de no_data para breached', () => {
      const record = observation(HealthCheckName.NetworkToSurvival, 'breached');

      const decision = decide({
        observations: [record],
        previousStatus: new Map([[record.checkName, 'no_data']]),
      });

      expect(decision.announce).toEqual([record]);
    });

    it('anuncia a mudanca de breached para error como evento novo', () => {
      // "a taxa do tutorial esta baixa" e "nao conseguimos falar com o Plan" sao
      // problemas diferentes; o segundo nao pode se esconder atras do primeiro.
      const record = observation(HealthCheckName.TutorialEntryRate, 'error');

      const decision = decide({
        observations: [record],
        previousStatus: new Map([[record.checkName, 'breached']]),
        lastAlertAt: new Map([
          [record.checkName, new Date(NOW.getTime() - 1 * HOURS)],
        ]),
      });

      expect(decision.announce).toEqual([record]);
    });
  });

  describe('agrupamento', () => {
    it('segura a repeticao dentro da janela de reenvio', () => {
      const record = observation(HealthCheckName.CollectionAlive, 'breached');

      const decision = decide({
        observations: [record],
        previousStatus: new Map([[record.checkName, 'breached']]),
        lastAlertAt: new Map([
          [record.checkName, new Date(NOW.getTime() - 1 * HOURS)],
        ]),
      });

      expect(decision.announce).toEqual([]);
      expect(decision.suppressed).toEqual([{ record, reason: 'grouped' }]);
    });

    it('reenvia depois de a janela vencer', () => {
      const record = observation(HealthCheckName.CollectionAlive, 'breached');

      const decision = decide({
        observations: [record],
        previousStatus: new Map([[record.checkName, 'breached']]),
        lastAlertAt: new Map([
          [record.checkName, new Date(NOW.getTime() - 25 * HOURS)],
        ]),
      });

      expect(decision.announce).toEqual([record]);
    });

    it('reenvia exatamente no limite da janela', () => {
      const record = observation(HealthCheckName.CollectionAlive, 'breached');

      const decision = decide({
        observations: [record],
        previousStatus: new Map([[record.checkName, 'breached']]),
        lastAlertAt: new Map([
          [record.checkName, new Date(NOW.getTime() - RE_ALERT_AFTER)],
        ]),
      });

      expect(decision.announce).toEqual([record]);
    });

    it('nao deixa um apagao de tres meses virar um alerta por ciclo', () => {
      // O cenario real: o Plan do proxy ficou morto de maio a agosto/2026. Um
      // alerta a cada ciclo treinaria a equipe a ignorar o canal, que e o
      // silencio do ADR-006 de novo, so que com barulho.
      const record = observation(
        HealthCheckName.ProxyRegistrationAlive,
        'breached',
      );
      let announcements = 0;
      let lastAlert = new Date(NOW.getTime() - 90 * 24 * HOURS);

      // Um ciclo a cada 15 minutos por 3 dias.
      for (let cycle = 0; cycle < 3 * 24 * 4; cycle++) {
        const now = new Date(NOW.getTime() + cycle * 15 * 60 * 1000);
        const decision = decideAlerts({
          observations: [record],
          previousStatus: new Map([[record.checkName, 'breached']]),
          lastAlertAt: new Map([[record.checkName, lastAlert]]),
          now,
          reAlertAfterMs: RE_ALERT_AFTER,
        });
        if (decision.announce.length > 0) {
          announcements++;
          lastAlert = now;
        }
      }

      // Um lembrete por dia, nao 288.
      expect(announcements).toBe(3);
    });
  });

  describe('entrega que falhou antes', () => {
    it('reenvia quando a falha anterior nunca chegou a ser anunciada', () => {
      // lastAlertAt nulo com status de falha repetido significa que a entrega
      // falhou (webhook fora do ar). Ficar quieto perderia o alerta de vez.
      const record = observation(HealthCheckName.OrphanInstance, 'breached');

      const decision = decide({
        observations: [record],
        previousStatus: new Map([[record.checkName, 'breached']]),
        lastAlertAt: new Map([[record.checkName, null]]),
      });

      expect(decision.announce).toEqual([record]);
    });
  });

  describe('recuperacao', () => {
    it('avisa quando um check anunciado volta a ok', () => {
      const record = observation(HealthCheckName.CollectionAlive, 'ok');

      const decision = decide({
        observations: [record],
        previousStatus: new Map([[record.checkName, 'breached']]),
        lastAlertAt: new Map([
          [record.checkName, new Date(NOW.getTime() - 2 * HOURS)],
        ]),
      });

      expect(decision.recovered).toEqual([record]);
      expect(decision.announce).toEqual([]);
    });

    it('nao avisa recuperacao de falha que ninguem chegou a ouvir', () => {
      const record = observation(HealthCheckName.CollectionAlive, 'ok');

      const decision = decide({
        observations: [record],
        previousStatus: new Map([[record.checkName, 'breached']]),
        lastAlertAt: new Map([[record.checkName, null]]),
      });

      expect(decision.recovered).toEqual([]);
      expect(decision.suppressed).toEqual([
        { record, reason: 'not_notifiable' },
      ]);
    });

    it('nao inventa recuperacao para um check sempre saudavel', () => {
      const record = observation(HealthCheckName.OrphanInstance, 'ok');

      const decision = decide({
        observations: [record],
        previousStatus: new Map([[record.checkName, 'ok']]),
      });

      expect(decision.recovered).toEqual([]);
    });

    it('trata no_data apos falha anunciada como recuperacao de alerta, nao como falha', () => {
      const record = observation(HealthCheckName.TutorialEntryRate, 'no_data');

      const decision = decide({
        observations: [record],
        previousStatus: new Map([[record.checkName, 'breached']]),
        lastAlertAt: new Map([
          [record.checkName, new Date(NOW.getTime() - 2 * HOURS)],
        ]),
      });

      expect(decision.announce).toEqual([]);
      expect(decision.recovered).toEqual([record]);
    });
  });

  describe('sem dados', () => {
    it('nao alerta por no_data — ausencia de base nao e falha', () => {
      // "Sem dados" e diferente de zero: uma razao sem base nao e um numero
      // baixo, e um numero nao medido. Alertar aqui produziria ruido.
      const record = observation(HealthCheckName.TutorialEntryRate, 'no_data');

      const decision = decide({
        observations: [record],
        previousStatus: new Map([[record.checkName, 'ok']]),
      });

      expect(decision.announce).toEqual([]);
      expect(decision.suppressed).toEqual([
        { record, reason: 'not_notifiable' },
      ]);
    });
  });

  describe('lote misto', () => {
    it('separa anuncio, recuperacao e supressao numa unica decisao', () => {
      const failing = observation(HealthCheckName.CollectionAlive, 'breached');
      const recovering = observation(HealthCheckName.OrphanInstance, 'ok');
      const grouped = observation(
        HealthCheckName.VersionDivergence,
        'breached',
      );
      const healthy = observation(HealthCheckName.NetworkToSurvival, 'ok');

      const decision = decide({
        observations: [failing, recovering, grouped, healthy],
        previousStatus: new Map([
          [recovering.checkName, 'breached'],
          [grouped.checkName, 'breached'],
          [healthy.checkName, 'ok'],
        ]),
        lastAlertAt: new Map([
          [recovering.checkName, new Date(NOW.getTime() - 3 * HOURS)],
          [grouped.checkName, new Date(NOW.getTime() - 3 * HOURS)],
        ]),
      });

      expect(decision.announce).toEqual([failing]);
      expect(decision.recovered).toEqual([recovering]);
      expect(decision.suppressed).toEqual([
        { record: grouped, reason: 'grouped' },
        { record: healthy, reason: 'not_notifiable' },
      ]);
    });

    it('mantem checks com escopo por servidor independentes entre si', () => {
      const survival = observation(
        'plan.collection_alive:survival',
        'breached',
      );
      const proxy = observation('plan.collection_alive:proxy', 'breached');

      const decision = decide({
        observations: [survival, proxy],
        previousStatus: new Map([[proxy.checkName, 'breached']]),
        lastAlertAt: new Map([
          [proxy.checkName, new Date(NOW.getTime() - 1 * HOURS)],
        ]),
      });

      // O survival e novidade e sai; o proxy ja foi anunciado e fica agrupado.
      expect(decision.announce).toEqual([survival]);
      expect(decision.suppressed).toEqual([
        { record: proxy, reason: 'grouped' },
      ]);
    });
  });
});
