import { decideAlerts, type AlertPolicyInput } from './alert-policy';
import {
  HealthCheckName,
  type HealthCheckRecord,
  type HealthCheckStatus,
  type LastAlert,
} from './health-check.types';

const NOW = new Date('2026-08-22T12:00:00.000Z');
const HOURS = 60 * 60 * 1000;
const MINUTES = 60 * 1000;
const RE_ALERT_AFTER = 24 * HOURS;
/** Matches `DEFAULT_CONFIRM_RECOVERY` in the runner. */
const CONFIRM_RECOVERY = 2;

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

/** What the channel was last told about `checkName`, `hoursAgo` hours back. */
function told(
  checkName: string,
  status: HealthCheckStatus,
  hoursAgo: number,
): Map<string, LastAlert> {
  return new Map([
    [checkName, { status, at: new Date(NOW.getTime() - hoursAgo * HOURS) }],
  ]);
}

/** A streak that satisfies {@link CONFIRM_RECOVERY} for one check. */
function confirmed(checkName: string): Map<string, number> {
  return new Map([[checkName, CONFIRM_RECOVERY]]);
}

function decide(overrides: Partial<AlertPolicyInput>) {
  return decideAlerts({
    observations: [],
    lastAlert: new Map(),
    healthyStreak: new Map(),
    // Deliberately the production default rather than 1: a helper that turned
    // the hysteresis off would let every other test pass while the shipped
    // configuration behaved differently.
    confirmRecoveryAfter: CONFIRM_RECOVERY,
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
    it('anuncia a primeira falha de um check que nunca falou nada', () => {
      const record = observation(HealthCheckName.CollectionAlive, 'breached');

      const decision = decide({ observations: [record] });

      expect(decision.announce).toEqual([record]);
      expect(decision.suppressed).toEqual([]);
    });

    it('anuncia a falha de um check cujo ultimo recado foi um all-clear', () => {
      const record = observation(HealthCheckName.TutorialEntryRate, 'breached');

      const decision = decide({
        observations: [record],
        lastAlert: told(record.checkName, 'ok', 5),
      });

      expect(decision.announce).toEqual([record]);
    });

    it('anuncia a mudanca de breached para error como evento novo', () => {
      // "a taxa do tutorial esta baixa" e "nao conseguimos falar com o Plan" sao
      // problemas diferentes; o segundo nao pode se esconder atras do primeiro.
      const record = observation(HealthCheckName.TutorialEntryRate, 'error');

      const decision = decide({
        observations: [record],
        lastAlert: told(record.checkName, 'breached', 1),
      });

      expect(decision.announce).toEqual([record]);
    });
  });

  describe('agrupamento', () => {
    it('segura a repeticao dentro da janela de reenvio', () => {
      const record = observation(HealthCheckName.CollectionAlive, 'breached');

      const decision = decide({
        observations: [record],
        lastAlert: told(record.checkName, 'breached', 1),
      });

      expect(decision.announce).toEqual([]);
      expect(decision.suppressed).toEqual([{ record, reason: 'grouped' }]);
    });

    it('reenvia depois de a janela vencer', () => {
      const record = observation(HealthCheckName.CollectionAlive, 'breached');

      const decision = decide({
        observations: [record],
        lastAlert: told(record.checkName, 'breached', 25),
      });

      expect(decision.announce).toEqual([record]);
    });

    it('reenvia exatamente no limite da janela', () => {
      const record = observation(HealthCheckName.CollectionAlive, 'breached');

      const decision = decide({
        observations: [record],
        lastAlert: told(record.checkName, 'breached', 24),
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
      let lastAlert: LastAlert = {
        status: 'breached',
        at: new Date(NOW.getTime() - 90 * 24 * HOURS),
      };

      // Um ciclo a cada 15 minutos por 3 dias.
      for (let cycle = 0; cycle < 3 * 24 * 4; cycle++) {
        const now = new Date(NOW.getTime() + cycle * 15 * MINUTES);
        const decision = decideAlerts({
          observations: [record],
          lastAlert: new Map([[record.checkName, lastAlert]]),
          healthyStreak: new Map(),
          confirmRecoveryAfter: CONFIRM_RECOVERY,
          now,
          reAlertAfterMs: RE_ALERT_AFTER,
        });
        if (decision.announce.length > 0) {
          announcements++;
          lastAlert = { status: 'breached', at: now };
        }
      }

      // Um lembrete por dia, nao 288.
      expect(announcements).toBe(3);
    });
  });

  describe('entrega que falhou antes', () => {
    it('reenvia quando a falha anterior nunca chegou a ser anunciada', () => {
      // Sem `lastAlert` e com falha, a entrega anterior falhou (webhook fora do
      // ar) ou nunca houve uma. Ficar quieto perderia o alerta de vez.
      const record = observation(HealthCheckName.OrphanInstance, 'breached');

      const decision = decide({
        observations: [record],
        lastAlert: new Map([[record.checkName, null]]),
      });

      expect(decision.announce).toEqual([record]);
    });
  });

  describe('recuperacao', () => {
    it('avisa quando um check anunciado volta a ok e se mantem', () => {
      const record = observation(HealthCheckName.CollectionAlive, 'ok');

      const decision = decide({
        observations: [record],
        lastAlert: told(record.checkName, 'breached', 2),
        healthyStreak: confirmed(record.checkName),
      });

      expect(decision.recovered).toEqual([record]);
      expect(decision.announce).toEqual([]);
    });

    it('nao avisa recuperacao de falha que ninguem chegou a ouvir', () => {
      const record = observation(HealthCheckName.CollectionAlive, 'ok');

      const decision = decide({
        observations: [record],
        lastAlert: new Map([[record.checkName, null]]),
        healthyStreak: confirmed(record.checkName),
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
        healthyStreak: new Map([[record.checkName, 50]]),
      });

      expect(decision.recovered).toEqual([]);
    });

    it('nao repete o all-clear no ciclo seguinte', () => {
      // O ultimo recado ja foi "normalizado"; nao ha nada em aberto para fechar.
      const record = observation(HealthCheckName.CollectionAlive, 'ok');

      const decision = decide({
        observations: [record],
        lastAlert: told(record.checkName, 'ok', 1),
        healthyStreak: new Map([[record.checkName, 9]]),
      });

      expect(decision.recovered).toEqual([]);
      expect(decision.suppressed).toEqual([
        { record, reason: 'not_notifiable' },
      ]);
    });

    it('nunca trata no_data apos falha anunciada como recuperacao', () => {
      // Nao e recuperacao: o check nao voltou ao normal, ele parou de poder ser
      // medido. Colocar isso no mesmo balde de `recovered` fazia o alerter
      // publicar um embed verde "normalizado" sobre uma perda de coleta — o
      // falso all-clear que o ADR-006 existe para impedir. Essa propriedade vale
      // dentro e fora da janela de reenvio; o que a janela decide e apenas
      // QUANDO o canal ouve, nunca se a perda vira um all-clear.
      const record = observation(HealthCheckName.TutorialEntryRate, 'no_data');

      const dentro = decide({
        observations: [record],
        lastAlert: told(record.checkName, 'breached', 2),
      });

      expect(dentro.recovered).toEqual([]);
      expect(dentro.announce).toEqual([]);
      expect(dentro.suppressed).toEqual([{ record, reason: 'grouped' }]);

      const fora = decide({
        observations: [record],
        lastAlert: told(record.checkName, 'breached', 25),
      });

      expect(fora.recovered).toEqual([]);
      expect(fora.lostSignal).toEqual([record]);
    });

    it('nao repete o sinal perdido a cada ciclo', () => {
      const record = observation(HealthCheckName.TutorialEntryRate, 'no_data');

      const decision = decide({
        observations: [record],
        lastAlert: told(record.checkName, 'no_data', 1),
      });

      expect(decision.lostSignal).toEqual([]);
      expect(decision.suppressed).toEqual([{ record, reason: 'grouped' }]);
    });

    it('lembra do sinal perdido quando a janela vence', () => {
      const record = observation(HealthCheckName.TutorialEntryRate, 'no_data');

      const decision = decide({
        observations: [record],
        lastAlert: told(record.checkName, 'no_data', 25),
      });

      expect(decision.lostSignal).toEqual([record]);
    });

    it('separa recuperacao real de sinal perdido no mesmo ciclo', () => {
      const back = observation(HealthCheckName.NetworkToSurvival, 'ok');
      const gone = observation(HealthCheckName.OrphanInstance, 'no_data');

      const decision = decide({
        observations: [back, gone],
        lastAlert: new Map([
          ...told(back.checkName, 'breached', 2),
          // Fora da janela, para que a perda de sinal saia neste ciclo em vez de
          // ficar agrupada — o ponto do teste e o roteamento, nao o tempo.
          ...told(gone.checkName, 'breached', 25),
        ]),
        healthyStreak: confirmed(back.checkName),
      });

      expect(decision.recovered).toEqual([back]);
      expect(decision.lostSignal).toEqual([gone]);
    });
  });

  describe('histerese da recuperacao', () => {
    it('segura o all-clear que ainda nao se sustentou', () => {
      const record = observation(HealthCheckName.OfflineAccountShare, 'ok');

      const decision = decide({
        observations: [record],
        lastAlert: told(record.checkName, 'breached', 1),
        healthyStreak: new Map([[record.checkName, 1]]),
      });

      expect(decision.recovered).toEqual([]);
      expect(decision.suppressed).toEqual([
        { record, reason: 'recovery_unconfirmed' },
      ]);
    });

    it('nao trata uma sequencia sem leitura como saudavel', () => {
      // `healthyStreak` ausente significa "nenhum ok consecutivo conhecido".
      // O default tem de ser 0, nao 1: contar um ciclo que ninguem contou seria
      // ler ausencia de dado como dado bom, que e o erro raiz do projeto.
      const record = observation(HealthCheckName.OfflineAccountShare, 'ok');

      const decision = decide({
        observations: [record],
        lastAlert: told(record.checkName, 'breached', 1),
        healthyStreak: new Map(),
        confirmRecoveryAfter: 1,
      });

      expect(decision.recovered).toEqual([]);
      expect(decision.suppressed).toEqual([
        { record, reason: 'recovery_unconfirmed' },
      ]);
    });

    /**
     * Replays a sequence through the policy the way the runner does, stamping
     * `lastAlert` only from what the alerter would have delivered.
     *
     * Returns the statuses that reached the channel, in order.
     */
    function replay(
      check: string,
      cycles: ReadonlyArray<{ at: string; status: HealthCheckStatus }>,
    ): HealthCheckStatus[] {
      let lastAlert: LastAlert | null = null;
      let okStreak = 0;
      const messages: HealthCheckStatus[] = [];

      for (const cycle of cycles) {
        const now = new Date(cycle.at);
        const record = { ...observation(check, cycle.status), checkedAt: now };
        okStreak = cycle.status === 'ok' ? okStreak + 1 : 0;

        const decision = decideAlerts({
          observations: [record],
          lastAlert: new Map([[check, lastAlert]]),
          healthyStreak: new Map([[check, okStreak]]),
          confirmRecoveryAfter: CONFIRM_RECOVERY,
          now,
          reAlertAfterMs: RE_ALERT_AFTER,
        });

        // O runner so carimba `alerted_at` no que o alerter entregou.
        for (const sent of [
          ...decision.announce,
          ...decision.recovered,
          ...decision.lostSignal,
        ]) {
          messages.push(sent.status);
          lastAlert = { status: sent.status, at: now };
        }
      }

      return messages;
    }

    it('colapsa uma re-quebra logo apos um all-clear que nao se sustentou', () => {
      // ATENCAO ao que este teste prova e ao que NAO prova.
      //
      // Ele NAO e a reconstrucao da producao de 2026-08-26. Aquele dia teve tres
      // mensagens as 19:39, 19:54 e 21:24, e os seis ciclos entre 19:54 e 21:24
      // nao foram registrados. Se tiverem sido `ok` — o mais provavel, ja que a
      // politica antiga teria anunciado qualquer `breached` ali —, a recuperacao
      // se confirmaria as 20:09 e a quebra das 21:24 seria incidente novo, que
      // sai. O que de fato cala aquela sequencia e a calibracao do limiar para
      // 0.65, com a qual nenhuma das tres leituras estoura.
      //
      // O que este teste prova e o mecanismo: uma recuperacao que nao se
      // sustentou nao fecha o incidente, e a quebra seguinte e agrupada.
      const check = HealthCheckName.OfflineAccountShare;

      const messages = replay(check, [
        { at: '2026-08-26T22:39:00.000Z', status: 'breached' },
        { at: '2026-08-26T22:54:00.000Z', status: 'ok' },
        { at: '2026-08-26T23:09:00.000Z', status: 'breached' },
      ]);

      expect(messages).toEqual(['breached']);
    });

    it('deixa passar a quebra que vem depois de um all-clear entregue', () => {
      // O outro lado da moeda, e e o comportamento correto: um check que ficou
      // comprovadamente bem por horas e entao quebrou e noticia, nao ruido.
      const check = HealthCheckName.OfflineAccountShare;

      const messages = replay(check, [
        { at: '2026-08-26T22:39:00.000Z', status: 'breached' },
        { at: '2026-08-26T22:54:00.000Z', status: 'ok' },
        { at: '2026-08-26T23:09:00.000Z', status: 'ok' },
        { at: '2026-08-27T00:24:00.000Z', status: 'breached' },
      ]);

      expect(messages).toEqual(['breached', 'ok', 'breached']);
    });

    it('nao deixa a troca de tipo de falha virar uma mensagem por ciclo', () => {
      // O modo de falha que a versao anterior desta politica tinha: toda troca
      // de estado com falha anunciava na hora, entao um check oscilando entre
      // dois estados ruins mandava 96 mensagens por dia, para sempre. O
      // `platform.offline_account_share` fica exatamente nessa fronteira quando
      // as chegadas rondam o `PLATFORM_OFFLINE_MIN_SAMPLE`.
      const check = HealthCheckName.OfflineAccountShare;
      const cycles: Array<{ at: string; status: HealthCheckStatus }> = [];
      for (let i = 0; i < 20; i++) {
        cycles.push({
          at: new Date(NOW.getTime() + i * 15 * MINUTES).toISOString(),
          status: i % 2 === 0 ? 'breached' : 'no_data',
        });
      }

      // Uma mensagem: a entrada na falha. O resto cabe na janela de reenvio.
      expect(replay(check, cycles)).toEqual(['breached']);
    });

    it('deixa o error furar a janela uma vez, e so uma', () => {
      // Chegar em `error` significa que a fonte sumiu, nao que ela leu mal — e o
      // apagao de tres meses do ADR-006. Nao pode esperar um dia atras de um
      // problema menor. Mas tambem nao pode virar um laco.
      const check = HealthCheckName.CollectionAlive;
      const cycles: Array<{ at: string; status: HealthCheckStatus }> = [];
      for (let i = 0; i < 20; i++) {
        cycles.push({
          at: new Date(NOW.getTime() + i * 15 * MINUTES).toISOString(),
          status: i % 2 === 0 ? 'breached' : 'error',
        });
      }

      expect(replay(check, cycles)).toEqual(['breached', 'error']);
    });

    it('anuncia a falha no primeiro ciclo — a histerese e so da recuperacao', () => {
      // Um apagao real nao pode esperar confirmacao.
      const record = observation(HealthCheckName.CollectionAlive, 'error');

      const decision = decide({ observations: [record] });

      expect(decision.announce).toEqual([record]);
    });
  });

  describe('sem dados', () => {
    it('nao alerta por no_data — ausencia de base nao e falha', () => {
      // "Sem dados" e diferente de zero: uma razao sem base nao e um numero
      // baixo, e um numero nao medido. Alertar aqui produziria ruido.
      const record = observation(HealthCheckName.TutorialEntryRate, 'no_data');

      const decision = decide({
        observations: [record],
        lastAlert: told(record.checkName, 'ok', 3),
      });

      expect(decision.announce).toEqual([]);
      expect(decision.lostSignal).toEqual([]);
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
        lastAlert: new Map([
          ...told(recovering.checkName, 'breached', 3),
          ...told(grouped.checkName, 'breached', 3),
        ]),
        healthyStreak: confirmed(recovering.checkName),
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
        lastAlert: told(proxy.checkName, 'breached', 1),
      });

      // O survival e novidade e sai; o proxy ja foi anunciado e fica agrupado.
      expect(decision.announce).toEqual([survival]);
      expect(decision.suppressed).toEqual([
        { record: proxy, reason: 'grouped' },
      ]);
    });
  });
});
