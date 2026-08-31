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
/** Matches `DEFAULT_MAX_ALERTS_PER_WINDOW` in the runner. */
const MAX_PER_WINDOW = 4;

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

/** Count delivered messages by status, the way the store's query does. */
function tally(
  sent: ReadonlyArray<{ status: HealthCheckStatus }>,
): Map<HealthCheckStatus, number> {
  const counts = new Map<HealthCheckStatus, number>();
  for (const message of sent) {
    counts.set(message.status, (counts.get(message.status) ?? 0) + 1);
  }
  return counts;
}

/** What the channel heard from `checkName` this window, by status. */
function heard(
  checkName: string,
  counts: Partial<Record<HealthCheckStatus, number>>,
): Map<string, Map<HealthCheckStatus, number>> {
  return new Map([
    [
      checkName,
      new Map(Object.entries(counts) as Array<[HealthCheckStatus, number]>),
    ],
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
    alertsInWindow: new Map(),
    maxAlertsPerWindow: MAX_PER_WINDOW,
    healthyStreak: new Map(),
    // Deliberately the production default rather than 1: a helper that turned
    // the hysteresis off would let every other test pass while the shipped
    // configuration behaved differently.
    confirmRecoveryAfter: CONFIRM_RECOVERY,
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
      const check = HealthCheckName.ProxyRegistrationAlive;
      let announcements = 0;
      let lastAlert: LastAlert = {
        status: 'breached',
        at: new Date(NOW.getTime() - 90 * 24 * HOURS),
      };

      // Um ciclo a cada 15 minutos por 3 dias.
      for (let cycle = 0; cycle < 3 * 24 * 4; cycle++) {
        const at = new Date(NOW.getTime() + cycle * 15 * MINUTES);
        const decision = decideAlerts({
          observations: [{ ...observation(check, 'breached'), checkedAt: at }],
          lastAlert: new Map([[check, lastAlert]]),
          alertsInWindow: new Map(),
          maxAlertsPerWindow: MAX_PER_WINDOW,
          healthyStreak: new Map(),
          confirmRecoveryAfter: CONFIRM_RECOVERY,
          reAlertAfterMs: RE_ALERT_AFTER,
        });
        if (decision.announce.length > 0) {
          announcements++;
          lastAlert = { status: 'breached', at };
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

    it('trata no_data apos falha anunciada como sinal perdido, na hora', () => {
      // Nao e recuperacao: o check nao voltou ao normal, ele parou de poder ser
      // medido. Colocar isso no mesmo balde de `recovered` fazia o alerter
      // publicar um embed verde "normalizado" sobre uma perda de coleta — o
      // falso all-clear que o ADR-006 existe para impedir.
      //
      // E sai na hora, sem esperar a janela: perder a medicao e uma piora, e
      // piora fura a janela. Quem limita a oscilacao aqui e o orcamento de
      // mensagens, nao o adiamento deste aviso.
      const record = observation(HealthCheckName.TutorialEntryRate, 'no_data');

      const decision = decide({
        observations: [record],
        lastAlert: told(record.checkName, 'breached', 2),
      });

      expect(decision.recovered).toEqual([]);
      expect(decision.announce).toEqual([]);
      expect(decision.lostSignal).toEqual([record]);
    });

    it('nao repete o sinal perdido quando ele so piora de novo para o mesmo', () => {
      const record = observation(HealthCheckName.TutorialEntryRate, 'no_data');

      const decision = decide({
        observations: [record],
        lastAlert: told(record.checkName, 'no_data', 1),
      });

      expect(decision.lostSignal).toEqual([]);
      expect(decision.suppressed).toEqual([{ record, reason: 'grouped' }]);
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
      // Any check that is NOT an accepted blind spot: those are suppressed
      // before the routing rules this test is about ever run.
      const back = observation(HealthCheckName.ProxyRegistrationAlive, 'ok');
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
    function replayDetailed(
      check: string,
      cycles: ReadonlyArray<{ at: string; status: HealthCheckStatus }>,
    ): Array<{ label: string; at: number }> {
      let lastAlert: LastAlert | null = null;
      let okStreak = 0;
      /** Every message delivered, for recomputing the per-status budget. */
      const delivered: Array<{ at: Date; status: HealthCheckStatus }> = [];
      const messages: Array<{ label: string; at: number }> = [];

      for (const cycle of cycles) {
        const at = new Date(cycle.at);
        const record = { ...observation(check, cycle.status), checkedAt: at };
        okStreak = cycle.status === 'ok' ? okStreak + 1 : 0;

        const decision = decideAlerts({
          observations: [record],
          lastAlert: new Map([[check, lastAlert]]),
          alertsInWindow: new Map([
            [
              check,
              tally(
                delivered.filter(
                  (sent) => at.getTime() - sent.at.getTime() < RE_ALERT_AFTER,
                ),
              ),
            ],
          ]),
          maxAlertsPerWindow: MAX_PER_WINDOW,
          healthyStreak: new Map([[check, okStreak]]),
          confirmRecoveryAfter: CONFIRM_RECOVERY,
          reAlertAfterMs: RE_ALERT_AFTER,
        });

        // O runner so carimba `alerted_at` no que o alerter entregou — inclusive
        // o aviso de silenciamento.
        const sent = [
          ...decision.announce.map((r) => ({ record: r, label: r.status })),
          ...decision.recovered.map((r) => ({ record: r, label: r.status })),
          ...decision.lostSignal.map((r) => ({ record: r, label: r.status })),
          ...decision.flapping.map((r) => ({
            record: r,
            label: `flapping:${r.status}`,
          })),
        ];
        for (const message of sent) {
          messages.push({ label: message.label, at: at.getTime() });
          delivered.push({ at, status: message.record.status });
          lastAlert = { status: message.record.status, at };
        }
      }

      return messages;
    }

    function replay(
      check: string,
      cycles: ReadonlyArray<{ at: string; status: HealthCheckStatus }>,
    ): string[] {
      return replayDetailed(check, cycles).map((message) => message.label);
    }

    /**
     * Longest stretch, in ms, during which the channel heard nothing about a
     * check that was producing observations the whole time.
     */
    function longestSilence(
      check: string,
      cycles: ReadonlyArray<{ at: string; status: HealthCheckStatus }>,
    ): number {
      const at = replayDetailed(check, cycles).map((message) => message.at);
      let longest = 0;
      let previous = new Date(cycles[0].at).getTime();
      for (const sentAt of at) {
        longest = Math.max(longest, sentAt - previous);
        previous = sentAt;
      }
      const end = new Date(cycles[cycles.length - 1].at).getTime();
      return Math.max(longest, end - previous);
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

      // Duas: a entrada na falha e a piora para "nao da mais para medir". A
      // volta para `breached` e uma melhora e espera a janela; a ida seguinte
      // para `no_data` ja nao e piora, porque e disso que o canal foi avisado.
      expect(replay(check, cycles)).toEqual(['breached', 'no_data']);
    });

    it('deixa o error furar a janela uma vez, e so uma', () => {
      // Chegar em `error` significa que a fonte sumiu, nao que ela leu mal — e o
      // apagao de tres meses do ADR-006. Nao pode esperar um dia atras de um
      // problema menor. Mas tambem nao pode virar um laco: voltar de `error`
      // para `breached` e uma melhora, e melhora nao fura janela.
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

    it('cobre uma semana de oscilacao breached/ok com 5 mensagens por dia', () => {
      // O buraco que a regra de transicao NAO fecha, e a razao de o orcamento
      // existir. `breached, ok, ok` repetindo confirma uma recuperacao a cada
      // tres ciclos, entrega o all-clear, e com isso a quebra seguinte volta a
      // ser "incidente novo" — 64 mensagens por dia, para sempre.
      const check = HealthCheckName.OfflineAccountShare;
      const cycles: Array<{ at: string; status: HealthCheckStatus }> = [];
      const CYCLES_PER_WEEK = 7 * 24 * 4;
      for (let i = 0; i < CYCLES_PER_WEEK; i++) {
        cycles.push({
          at: new Date(NOW.getTime() + i * 15 * MINUTES).toISOString(),
          status: i % 3 === 0 ? 'breached' : 'ok',
        });
      }

      const messages = replay(check, cycles);

      // Sem orcamento seriam 448 mensagens na semana — 64 por dia, para sempre.
      // Com ele, 27: menos de quatro por dia, que e o teto pedido.
      expect(messages).toHaveLength(27);
      // E o canal nunca fica uma janela inteira sem noticia deste check enquanto
      // ele oscila: ou sai uma mensagem de verdade, ou sai o aviso cinza. Um
      // mute sem aviso seria indistinguivel de um check saudavel.
      expect(longestSilence(check, cycles)).toBeLessThanOrEqual(RE_ALERT_AFTER);
    });

    it('nunca fica uma janela inteira calado sobre um check que oscila', () => {
      // A garantia central do orcamento, medida ponta a ponta em varias formas
      // de oscilacao. Duas versoes anteriores calavam um check por 22 horas.
      const shapes: Array<[string, (i: number) => HealthCheckStatus]> = [
        ['breached/ok', (i) => (i % 3 === 0 ? 'breached' : 'ok')],
        ['breached/error', (i) => (i % 2 === 0 ? 'breached' : 'error')],
        ['breached/no_data', (i) => (i % 2 === 0 ? 'breached' : 'no_data')],
        [
          'todos',
          (i) =>
            (['breached', 'error', 'ok', 'ok', 'breached', 'no_data'] as const)[
              i % 6
            ],
        ],
      ];

      for (const [name, statusAt] of shapes) {
        const cycles: Array<{ at: string; status: HealthCheckStatus }> = [];
        for (let i = 0; i < 7 * 24 * 4; i++) {
          cycles.push({
            at: new Date(NOW.getTime() + i * 15 * MINUTES).toISOString(),
            status: statusAt(i),
          });
        }

        expect([
          name,
          longestSilence(HealthCheckName.CollectionAlive, cycles) <=
            RE_ALERT_AFTER,
        ]).toEqual([name, true]);
      }
    });

    it('nunca deixa um verde ser a ultima palavra sobre um check ainda quebrado', () => {
      // O mecanismo por tras da regra, isolado. Uma versao anterior deixava a
      // recuperacao furar o orcamento; ela entao ganhava a corrida para ser a
      // ULTIMA mensagem, e o canal ficava segurando um "normalizado" sobre um
      // check que quebrava a cada tres ciclos — seguido de 22 horas de silencio,
      // porque as falhas seguintes estavam caladas pelo orcamento.
      //
      // Falso all-clear e a unica coisa que esta camada nao pode produzir, entao
      // a recuperacao e orcada como todo o resto.
      const record = observation(HealthCheckName.OfflineAccountShare, 'ok');

      const decision = decide({
        observations: [record],
        lastAlert: told(record.checkName, 'breached', 1),
        healthyStreak: confirmed(record.checkName),
        alertsInWindow: heard(record.checkName, { breached: 3, ok: 3 }),
      });

      expect(decision.recovered).toEqual([]);
      expect(decision.flapping).toEqual([]);
      expect(decision.suppressed).toEqual([{ record, reason: 'flapping' }]);
    });

    it('nunca carimba o aviso de silenciamento com ok', () => {
      // O aviso e carimbado com o status do proprio veredito. Um aviso carimbado
      // `ok` limparia o `open`: o canal passaria a segurar um all-clear que
      // ninguem deu, e a recuperacao que espera o orcamento nunca mais seria
      // reconhecida como recuperacao.
      const record = observation(HealthCheckName.OfflineAccountShare, 'ok');

      const decision = decide({
        observations: [record],
        lastAlert: told(record.checkName, 'breached', 1),
        healthyStreak: confirmed(record.checkName),
        alertsInWindow: heard(record.checkName, { breached: 2, ok: 2 }),
      });

      expect(decision.flapping).toEqual([]);
      expect(decision.suppressed).toEqual([{ record, reason: 'flapping' }]);
    });

    it('deixa passar a morte da fonte mesmo com o orcamento estourado', () => {
      // O modo de falha que a primeira versao do orcamento criou: o check
      // oscilava, gastava o orcamento, e entao a fonte MORRIA — e o `error`
      // ficava 45 horas sem sair, porque o orcamento contava tudo junto. O canal
      // passava dois dias com um aviso cinza dizendo "calibre o limiar" sobre um
      // servidor que tinha sumido.
      //
      // `error` e um status que o canal nao ouviu nesta janela, e status nao
      // ouvido nunca e barrado.
      const check = HealthCheckName.CollectionAlive;
      const cycles: Array<{ at: string; status: HealthCheckStatus }> = [];
      for (let i = 0; i < 40; i++) {
        cycles.push({
          at: new Date(NOW.getTime() + i * 15 * MINUTES).toISOString(),
          status: i % 3 === 0 ? 'breached' : 'ok',
        });
      }
      // A fonte morre e nao volta.
      const deathIndex = cycles.length;
      for (let i = 0; i < 8; i++) {
        cycles.push({
          at: new Date(
            NOW.getTime() + (deathIndex + i) * 15 * MINUTES,
          ).toISOString(),
          status: 'error',
        });
      }

      const messages = replay(check, cycles);

      // O `error` sai, e sai no primeiro ciclo em que aparece.
      expect(messages).toContain('error');
      expect(messages.filter((m) => m === 'error')).toHaveLength(1);
      expect(messages[messages.length - 1]).toBe('error');
    });

    it('entrega a recuperacao depois que a oscilacao passa e a janela rola', () => {
      // O outro modo de falha que o orcamento ja criou: o check oscilava,
      // gastava o orcamento, e entao ficava REALMENTE bom — e o all-clear nunca
      // saia. Agora a recuperacao tambem e orcada, entao ela espera; o que a
      // salva de esperar para sempre e o passe livre do `heardThis === 0`. Assim
      // que os `ok` da propria oscilacao envelhecem para fora da janela, uma
      // recuperacao confirmada volta a ser noticia e sai.
      const check = HealthCheckName.OfflineAccountShare;
      const cycles: Array<{ at: string; status: HealthCheckStatus }> = [];
      const at = (i: number) =>
        new Date(NOW.getTime() + i * 15 * MINUTES).toISOString();

      // Dez horas oscilando...
      for (let i = 0; i < 40; i++) {
        cycles.push({ at: at(i), status: i % 3 === 0 ? 'breached' : 'ok' });
      }
      // ...e entao saudavel de verdade, por mais de uma janela inteira.
      for (let i = 40; i < 150; i++) {
        cycles.push({ at: at(i), status: 'ok' });
      }

      const messages = replay(check, cycles);

      // A ultima palavra sobre um check que esta bem e "esta bem" — e ela chega
      // sozinha, sem ninguem ir olhar.
      expect(messages[messages.length - 1]).toBe('ok');
      // E o teste so vale se o check estiver mesmo saudavel no fim: sem os 110
      // ciclos `ok`, a ultima mensagem seria o aviso de silenciamento.
      expect(cycles[cycles.length - 1].status).toBe('ok');
    });

    it('nao gasta orcamento com um apagao continuo', () => {
      // O outro extremo, e o caso central do ADR-006: o orcamento nao pode
      // encurtar a vida de um alerta que ja e raro. Uma semana quebrada sem
      // parar sao sete lembretes, um por dia, exatamente como antes de existir
      // orcamento nenhum.
      const check = HealthCheckName.ProxyRegistrationAlive;
      const cycles: Array<{ at: string; status: HealthCheckStatus }> = [];
      for (let i = 0; i < 7 * 24 * 4; i++) {
        cycles.push({
          at: new Date(NOW.getTime() + i * 15 * MINUTES).toISOString(),
          status: 'breached',
        });
      }

      expect(replay(check, cycles)).toEqual(Array(7).fill('breached'));
    });

    it('mantem o error limitado mesmo depois de a janela rolar', () => {
      // A versao anterior deste teste rodava 5 horas dentro de uma janela de 24
      // e por isso nao podia falhar, e ainda assertava so um teto frouxo. O
      // ponto e o que acontece DEPOIS que a janela vence e o `lastAlert` volta a
      // ser `breached`: o desvio do `error` rearma. Ele rearma mesmo — o limite
      // real e o orcamento, e a sequencia exata fica fixada aqui.
      const check = HealthCheckName.CollectionAlive;
      const cycles: Array<{ at: string; status: HealthCheckStatus }> = [];
      for (let i = 0; i < 3 * 24 * 4; i++) {
        cycles.push({
          at: new Date(NOW.getTime() + i * 15 * MINUTES).toISOString(),
          status: i % 2 === 0 ? 'breached' : 'error',
        });
      }

      // Dia 1: entra em falha e piora para `error`. Depois cala — voltar de
      // `error` para `breached` e melhora, e melhora nao fura janela. O que o
      // canal ouve a cada janela que rola e o lembrete do estado que o proprio
      // canal esta segurando, `error`, e nao a oscilacao por baixo dele.
      expect(replay(check, cycles)).toEqual([
        'breached',
        'error',
        'error',
        'error',
      ]);
    });

    it('barra a repeticao mas nunca o que o canal ainda nao ouviu', () => {
      // O coracao da regra do orcamento, isolado: mesmo com o orcamento
      // estourado varias vezes, um status novo passa.
      const repetido = observation(HealthCheckName.OrphanInstance, 'breached');
      const novo = observation(HealthCheckName.OrphanInstance, 'error');
      const gasto = heard(repetido.checkName, { breached: 9 });
      // O canal ouviu um all-clear ha uma hora, entao nao ha problema aberto: as
      // duas falhas abaixo entram direto no orcamento, sem passar pela janela.
      const ouviuHaPouco = told(repetido.checkName, 'ok', 1);

      expect(
        decide({
          observations: [repetido],
          lastAlert: ouviuHaPouco,
          alertsInWindow: gasto,
        }).suppressed,
      ).toEqual([{ record: repetido, reason: 'flapping' }]);

      expect(
        decide({
          observations: [novo],
          lastAlert: ouviuHaPouco,
          alertsInWindow: gasto,
        }).announce,
      ).toEqual([novo]);
    });

    it('avisa do silenciamento quando a janela inteira passou calada', () => {
      // A garantia esta escrita em termos do que o canal vive, nao de um contador
      // cruzando um valor exato: um check nunca passa uma janela inteira sem
      // mensagem enquanto esta acima do orcamento. Duas versoes anteriores
      // disparavam o aviso em `heardAny === max` exato, e qualquer registro que
      // tomasse o passe livre pulava por cima desse ponto sem nunca testa-lo —
      // o check era calado sem que nada fosse dito.
      const record = observation(HealthCheckName.OrphanInstance, 'breached');
      const gasto = heard(record.checkName, { breached: 9 });

      const calouUmDia = decide({
        observations: [record],
        lastAlert: told(record.checkName, 'ok', 25),
        alertsInWindow: gasto,
      });
      const falouHaPouco = decide({
        observations: [record],
        lastAlert: told(record.checkName, 'ok', 1),
        alertsInWindow: gasto,
      });

      expect(calouUmDia.flapping).toEqual([record]);
      expect(falouHaPouco.flapping).toEqual([]);
      expect(falouHaPouco.suppressed).toEqual([{ record, reason: 'flapping' }]);
    });

    it('nao pode ser pulado por um registro que tomou o passe livre', () => {
      // A sequencia exata que furava as duas versoes anteriores: um status ainda
      // nao ouvido chega justamente com o contador no teto, passa livre, e o
      // contador vai para teto+1 sem nunca ter testado a igualdade. Dai em
      // diante tudo era suprimido, para sempre, sem aviso nenhum.
      const record = observation(HealthCheckName.CollectionAlive, 'error');

      const decision = decide({
        observations: [record],
        // Contador ja passou do teto, e faz mais de uma janela que o canal nao
        // ouve nada deste check. `error` ja foi ouvido, entao nao ha passe livre.
        lastAlert: told(record.checkName, 'error', 30),
        alertsInWindow: heard(record.checkName, {
          breached: 3,
          no_data: 1,
          error: 1,
        }),
      });

      expect(decision.flapping).toEqual([record]);
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

  describe('ponto cego aceito', () => {
    /**
     * The scoped name of the one check in `ACCEPTED_BLIND_SPOTS`.
     *
     * `funnel.network_to_survival` returns `no_data` on every cycle and can
     * never return `ok`, because the source for its denominator does not exist.
     * Every rule below this line assumes a non-`ok` state eventually clears.
     */
    const BLIND = `${HealthCheckName.NetworkToSurvival}:Survival`;

    it('nao alerta com o canal limpo', () => {
      const decision = decide({
        observations: [observation(BLIND, 'no_data')],
      });

      expect(decision.announce).toEqual([]);
      expect(decision.lostSignal).toEqual([]);
      expect(decision.suppressed[0].reason).toBe('accepted_blind_spot');
    });

    it('nao alerta com um `breached` aberto — piora nao fura a janela', () => {
      // Without the guard: SEVERITY['no_data'] (2) > SEVERITY['breached'] (1),
      // so this took the "the problem got worse, never waits" path and was
      // delivered immediately.
      const decision = decide({
        observations: [observation(BLIND, 'no_data')],
        lastAlert: told(BLIND, 'breached', 1),
      });

      expect(decision.lostSignal).toEqual([]);
      expect(decision.announce).toEqual([]);
      expect(decision.suppressed[0].reason).toBe('accepted_blind_spot');
    });

    it('nao alerta com um `error` aberto e a janela de re-alerta vencida', () => {
      // The forever-loop this guard exists for. With an open `error`, equal or
      // lesser severity fell through to `repeat`, which delivers as soon as
      // `reAlertAfterMs` has passed — and then again every window, for as long
      // as the process runs, because the exit is an `ok` record that this check
      // can no longer produce.
      const decision = decide({
        observations: [observation(BLIND, 'no_data')],
        lastAlert: told(BLIND, 'error', 48),
      });

      expect(decision.lostSignal).toEqual([]);
      expect(decision.suppressed[0].reason).toBe('accepted_blind_spot');
    });

    it('nao gasta orcamento nem emite o aviso cinza de mute', () => {
      // A muted check still emits the grey "vai ficar quieto" notice once per
      // window, which for a permanent blind spot would be the same daily
      // message wearing a different colour.
      const decision = decide({
        observations: [observation(BLIND, 'no_data')],
        lastAlert: told(BLIND, 'error', 48),
        alertsInWindow: heard(BLIND, { no_data: MAX_PER_WINDOW }),
      });

      expect(decision.flapping).toEqual([]);
      expect(decision.suppressed[0].reason).toBe('accepted_blind_spot');
    });

    it('nao silencia os outros checks do mesmo lote', () => {
      // The guard is per record. A blind spot must not become a way to lose a
      // real failure that happened to be evaluated in the same cycle.
      const outro = `${HealthCheckName.CollectionAlive}:Survival`;
      const decision = decide({
        observations: [
          observation(BLIND, 'no_data'),
          observation(outro, 'breached'),
        ],
      });

      expect(decision.announce.map((r) => r.checkName)).toEqual([outro]);
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
      // Not an accepted blind spot — see the note in the recovery test above.
      const healthy = observation(HealthCheckName.OfflineAccountShare, 'ok');

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
