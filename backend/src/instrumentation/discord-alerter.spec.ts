import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AlertDecision } from './alert-policy';
import { DiscordAlerter, escapeMarkdown } from './discord-alerter';
import {
  HealthCheckName,
  type HealthCheckRecord,
  type HealthCheckStatus,
} from './health-check.types';

const WEBHOOK = 'https://discord.com/api/webhooks/123/super-secret-token';

interface DiscordPayload {
  content: string;
  embeds: {
    title: string;
    description?: string;
    color: number;
    fields: { name: string; value: string }[];
  }[];
  allowed_mentions: { parse: string[] };
}

let nextId = 1;

function record(
  checkName: string,
  status: HealthCheckStatus,
  detail: HealthCheckRecord['detail'] = { summary: 'detalhe' },
): HealthCheckRecord {
  return {
    id: nextId++,
    checkName,
    status,
    checkedAt: new Date('2026-08-22T12:00:00.000Z'),
    detail,
    alertedAt: null,
  };
}

function decision(overrides: Partial<AlertDecision> = {}): AlertDecision {
  return {
    announce: [],
    recovered: [],
    lostSignal: [],
    suppressed: [],
    ...overrides,
  };
}

/**
 * No default parameter on purpose: `buildAlerter(undefined)` would silently fall
 * back to the configured webhook and quietly turn every "disabled" test into a
 * test of the enabled path.
 */
function buildAlerter(webhookUrl: string | undefined): DiscordAlerter {
  const config = {
    get: jest.fn().mockReturnValue(webhookUrl),
  } as unknown as ConfigService;
  return new DiscordAlerter(config);
}

/** Alerter with a working webhook — the common case. */
function buildEnabled(): DiscordAlerter {
  return buildAlerter(WEBHOOK);
}

function okResponse(): Response {
  return { ok: true, status: 204 } as Response;
}

describe('DiscordAlerter', () => {
  let fetchMock: jest.Mock;

  beforeEach(() => {
    nextId = 1;
    fetchMock = jest.fn();
    global.fetch = fetchMock;
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  type FetchCall = [string, { body: string }];

  function sentPayload(call = 0): DiscordPayload {
    const calls = fetchMock.mock.calls as FetchCall[];
    return JSON.parse(calls[call][1].body) as DiscordPayload;
  }

  /**
   * What Discord counts against its 6000-character aggregate limit: titles,
   * descriptions, field names and field values summed over *all* embeds of the
   * message. Recomputed here from the wire payload instead of imported, so the
   * test would still catch the module agreeing with itself about a wrong sum.
   */
  function aggregateChars(payload: DiscordPayload): number {
    return payload.embeds.reduce(
      (total, embed) =>
        total +
        embed.title.length +
        (embed.description?.length ?? 0) +
        embed.fields.reduce(
          (sum, field) => sum + field.name.length + field.value.length,
          0,
        ),
      0,
    );
  }

  /** One `error` observation as `runChecks` builds it when a source is down. */
  function blackoutRecords(
    count: number,
    reasonChars = 400,
  ): HealthCheckRecord[] {
    return Array.from({ length: count }, (_, index) =>
      record(`plan.collection_alive:s${index}`, 'error', {
        summary: `Check lancou excecao: ${'x'.repeat(reasonChars)}`,
      }),
    );
  }

  describe('configuracao', () => {
    it('fica desabilitado sem webhook e avisa alto no boot', () => {
      const alerter = buildAlerter(undefined);
      const warn = jest.spyOn(Logger.prototype, 'warn');

      alerter.onModuleInit();

      expect(alerter.enabled).toBe(false);
      // Um sistema de saude que nao consegue alertar e exatamente a falha que o
      // ADR-006 existe para prevenir — nao pode ser descoberto meses depois.
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('NENHUM alerta'),
      );
    });

    it('trata webhook em branco como ausente', () => {
      expect(buildAlerter('   ').enabled).toBe(false);
    });

    it('nao entrega nada, mas registra, quando desabilitado', async () => {
      const alerter = buildAlerter(undefined);

      const ids = await alerter.publish(
        decision({
          announce: [record(HealthCheckName.CollectionAlive, 'breached')],
        }),
      );

      expect(ids).toEqual([]);
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('entrega', () => {
    it('nao chama o Discord quando nao ha nada a dizer', async () => {
      const ids = await buildEnabled().publish(decision());

      expect(ids).toEqual([]);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('envia falhas e recuperacoes numa unica mensagem', async () => {
      fetchMock.mockResolvedValue(okResponse());
      const failing = record(HealthCheckName.CollectionAlive, 'breached');
      const recovered = record(HealthCheckName.OrphanInstance, 'ok');

      const ids = await buildEnabled().publish(
        decision({ announce: [failing], recovered: [recovered] }),
      );

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(ids).toEqual([failing.id, recovered.id]);
      expect(sentPayload().embeds).toHaveLength(2);
    });

    it('posta no webhook configurado com content-type json', async () => {
      fetchMock.mockResolvedValue(okResponse());

      await buildEnabled().publish(
        decision({
          announce: [record(HealthCheckName.CollectionAlive, 'breached')],
        }),
      );

      const [url, init] = fetchMock.mock.calls[0] as [
        string,
        { method: string; headers: Record<string, string> },
      ];
      expect(url).toBe(WEBHOOK);
      expect(init.method).toBe('POST');
      expect(init.headers['content-type']).toBe('application/json');
    });
  });

  describe('falha de entrega', () => {
    it('nao marca nada como anunciado quando o Discord recusa', async () => {
      fetchMock.mockResolvedValue({ ok: false, status: 500 });

      const ids = await buildEnabled().publish(
        decision({
          announce: [record(HealthCheckName.CollectionAlive, 'breached')],
        }),
      );

      // Devolver [] deixa a linha sem carimbo, e o proximo ciclo tenta de novo.
      expect(ids).toEqual([]);
    });

    it('nao propaga excecao de rede para o chamador', async () => {
      fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));

      // O scheduler precisa seguir rodando mesmo com o Discord fora do ar.
      await expect(
        buildEnabled().publish(
          decision({
            announce: [record(HealthCheckName.CollectionAlive, 'breached')],
          }),
        ),
      ).resolves.toEqual([]);
    });

    it('nunca escreve a URL do webhook no log de erro', async () => {
      const error = jest.spyOn(Logger.prototype, 'error');
      fetchMock.mockResolvedValue({ ok: false, status: 403 });

      await buildEnabled().publish(
        decision({
          announce: [record(HealthCheckName.CollectionAlive, 'breached')],
        }),
      );

      // A URL e a credencial: quem a tem posta no canal.
      for (const call of error.mock.calls) {
        expect(JSON.stringify(call)).not.toContain('super-secret-token');
      }
    });

    it('tenta de novo uma vez em 429 e entrega', async () => {
      fetchMock
        .mockResolvedValueOnce({
          ok: false,
          status: 429,
          headers: { get: () => '0.01' },
          json: () => Promise.resolve({}),
        })
        .mockResolvedValueOnce(okResponse());

      const failing = record(HealthCheckName.CollectionAlive, 'breached');
      const ids = await buildEnabled().publish(
        decision({ announce: [failing] }),
      );

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(ids).toEqual([failing.id]);
    });

    it('desiste depois da unica retentativa de 429', async () => {
      fetchMock.mockResolvedValue({
        ok: false,
        status: 429,
        headers: { get: () => '0.01' },
        json: () => Promise.resolve({}),
      });

      const ids = await buildEnabled().publish(
        decision({
          announce: [record(HealthCheckName.CollectionAlive, 'breached')],
        }),
      );

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(ids).toEqual([]);
    });
  });

  describe('seguranca do conteudo', () => {
    it('desarma toda mencao via allowed_mentions', async () => {
      fetchMock.mockResolvedValue(okResponse());

      await buildEnabled().publish(
        decision({
          announce: [
            record(HealthCheckName.CollectionAlive, 'breached', {
              summary: '@everyone servidor caiu',
            }),
          ],
        }),
      );

      expect(sentPayload().allowed_mentions).toEqual({ parse: [] });
    });

    it('escapa markdown vindo do detalhe do check', async () => {
      fetchMock.mockResolvedValue(okResponse());

      await buildEnabled().publish(
        decision({
          announce: [
            record(HealthCheckName.CollectionAlive, 'breached', {
              summary: '||spoiler|| e **negrito**',
            }),
          ],
        }),
      );

      const value = sentPayload().embeds[0].fields[0].value;
      // Sem escape, um nome de servidor conseguiria esconder o resto do alerta
      // atras de um spoiler ou de um bloco de codigo.
      expect(value).not.toContain('||spoiler||');
      expect(value).toContain('\\|\\|spoiler');
    });

    it('trunca valor de campo no limite do Discord', async () => {
      fetchMock.mockResolvedValue(okResponse());

      await buildEnabled().publish(
        decision({
          announce: [
            record(HealthCheckName.CollectionAlive, 'breached', {
              summary: 'x'.repeat(5000),
            }),
          ],
        }),
      );

      expect(
        sentPayload().embeds[0].fields[0].value.length,
      ).toBeLessThanOrEqual(1024);
    });
  });

  describe('conteudo da mensagem', () => {
    it('mostra o n ao lado da razao observada', async () => {
      fetchMock.mockResolvedValue(okResponse());

      await buildEnabled().publish(
        decision({
          announce: [
            record(HealthCheckName.TutorialEntryRate, 'breached', {
              summary: 'taxa de entrada abaixo do piso',
              observed: 0.12,
              threshold: 0.7,
              n: 87,
            }),
          ],
        }),
      );

      const value = sentPayload().embeds[0].fields[0].value;
      // Nenhum percentual sai sem a base — e o alerta e o pior lugar para
      // quebrar essa regra, porque alguem esta prestes a agir sobre o numero.
      expect(value).toContain('n=87');
      expect(value).toContain('0.12');
    });

    it('diz explicitamente quando o n nao esta disponivel', async () => {
      fetchMock.mockResolvedValue(okResponse());

      await buildEnabled().publish(
        decision({
          announce: [
            record(HealthCheckName.NetworkToSurvival, 'breached', {
              summary: 'desvio da media',
              observed: 0.39,
            }),
          ],
        }),
      );

      expect(sentPayload().embeds[0].fields[0].value).toContain(
        'n indisponivel',
      );
    });

    it('separa o nome do check do servidor no titulo do campo', async () => {
      fetchMock.mockResolvedValue(okResponse());

      await buildEnabled().publish(
        decision({
          announce: [record('plan.collection_alive:survival', 'breached')],
        }),
      );

      expect(sentPayload().embeds[0].fields[0].name).toContain('survival');
    });

    it('avisa quando ha mais checks do que cabem na mensagem', async () => {
      fetchMock.mockResolvedValue(okResponse());
      const many = Array.from({ length: 30 }, (_, index) =>
        record(`plan.collection_alive:s${index}`, 'breached'),
      );

      await buildEnabled().publish(decision({ announce: many }));

      const payload = sentPayload();
      expect(payload.embeds[0].fields).toHaveLength(25);
      // Truncar em silencio leria como "era so isso" quando nao era.
      expect(payload.content).toContain('nao exibido');
    });

    it('mantem no titulo a contagem real, mesmo truncando os campos', async () => {
      fetchMock.mockResolvedValue(okResponse());
      const many = Array.from({ length: 30 }, (_, index) =>
        record(`plan.collection_alive:s${index}`, 'breached'),
      );

      await buildEnabled().publish(decision({ announce: many }));

      expect(sentPayload().embeds[0].title).toContain('30 check(s) em falha');
    });

    it('NAO devolve como entregue o que foi truncado da mensagem', async () => {
      fetchMock.mockResolvedValue(okResponse());
      const many = Array.from({ length: 30 }, (_, index) =>
        record(`plan.collection_alive:s${index}`, 'breached'),
      );

      const delivered = await buildEnabled().publish(
        decision({ announce: many }),
      );

      // Regressao: o chamador carimba `alerted_at` no que devolvemos aqui.
      // Devolver os 30 marcava 5 checks como anunciados sem que ninguem os
      // tivesse visto, e a politica os agrupava (silenciava) pela janela
      // inteira de re-alerta. O que nao coube fica sem carimbo de proposito.
      expect(delivered).toHaveLength(25);
      expect(delivered).toEqual(many.slice(0, 25).map((r) => r.id));
    });
  });

  describe('sinal perdido (no_data apos falha)', () => {
    it('nao pinta de verde nem chama de normalizado', async () => {
      fetchMock.mockResolvedValue(okResponse());
      const gone = record('plan.collection_alive:survival', 'no_data');

      await buildEnabled().publish(decision({ lostSignal: [gone] }));

      const embed = sentPayload().embeds[0];
      // Verde + "normalizado" sobre uma perda de coleta e um falso all-clear:
      // o check nao melhorou, so deixou de poder ser medido.
      expect(embed.title).not.toContain('normalizado');
      expect(embed.title).toContain('sem dados');
      expect(embed.description).toContain('NAO e recuperacao');
      expect(embed.color).not.toBe(0x2e8b57);
    });

    it('entrega o id do check sem dados para o carimbo', async () => {
      fetchMock.mockResolvedValue(okResponse());
      const gone = record('plan.collection_alive:survival', 'no_data');

      const delivered = await buildEnabled().publish(
        decision({ lostSignal: [gone] }),
      );

      expect(delivered).toEqual([gone.id]);
    });

    it('conta o sinal perdido no resumo', async () => {
      fetchMock.mockResolvedValue(okResponse());
      const gone = record('plan.collection_alive:survival', 'no_data');

      await buildEnabled().publish(decision({ lostSignal: [gone] }));

      expect(sentPayload().content).toContain('1 sem dados');
    });
  });

  describe('orcamento agregado de 6000 caracteres', () => {
    it('cabe no limite agregado no apagao que gera 25 erros longos', async () => {
      fetchMock.mockResolvedValue(okResponse());

      // O cenario real: a VPS do Plan some, `runChecks` transforma cada excecao
      // numa observacao `error` com a mensagem da excecao, e os 25 campos por
      // embed passam folgado dos 6000 somados. O Discord responde 400, o
      // alerter desiste, e o proximo ciclo remonta o mesmo payload — silencio
      // permanente exatamente no maior apagao possivel.
      await buildEnabled().publish(decision({ announce: blackoutRecords(25) }));

      expect(aggregateChars(sentPayload())).toBeLessThanOrEqual(6000);
    });

    it('cabe no limite agregado com os tres baldes cheios', async () => {
      fetchMock.mockResolvedValue(okResponse());

      // O teto de 25 campos por balde da falsa seguranca: sao tres baldes, e
      // 3 x 25 campos e estruturalmente permitido.
      await buildEnabled().publish(
        decision({
          announce: blackoutRecords(25),
          recovered: blackoutRecords(25),
          lostSignal: blackoutRecords(25),
        }),
      );

      expect(aggregateChars(sentPayload())).toBeLessThanOrEqual(6000);
    });

    it('devolve so os ids que couberam de fato', async () => {
      fetchMock.mockResolvedValue(okResponse());
      const many = blackoutRecords(25);

      const delivered = await buildEnabled().publish(
        decision({ announce: many }),
      );

      // Mesma regra do corte de 25 campos: carimbar `alerted_at` em algo que
      // nao foi exibido faz a politica agrupar o check, e ele some do canal por
      // uma janela inteira de re-alerta.
      const shown = sentPayload().embeds[0].fields.length;
      expect(shown).toBeLessThan(25);
      expect(delivered).toHaveLength(shown);
      expect(delivered).toEqual(many.slice(0, shown).map((r) => r.id));
    });

    it('conta o corte do orcamento no aviso de nao exibido', async () => {
      fetchMock.mockResolvedValue(okResponse());
      const many = blackoutRecords(25);

      await buildEnabled().publish(decision({ announce: many }));

      const payload = sentPayload();
      const hidden = 25 - payload.embeds[0].fields.length;
      // Truncamento em silencio e lido como "era so isso".
      expect(payload.content).toContain(
        `${hidden} nao exibido(s) por limite do Discord`,
      );
    });

    it('mantem no titulo a contagem real do balde cortado', async () => {
      fetchMock.mockResolvedValue(okResponse());

      await buildEnabled().publish(decision({ announce: blackoutRecords(25) }));

      expect(sentPayload().embeds[0].title).toContain('25 check(s)');
    });

    it('corta recuperacao antes de falha', async () => {
      fetchMock.mockResolvedValue(okResponse());
      const failing = blackoutRecords(10, 300);
      const recovered = Array.from({ length: 10 }, (_, index) =>
        record(`plan.orphan_instance:r${index}`, 'ok', {
          summary: 'z'.repeat(300),
        }),
      );

      const delivered = await buildEnabled().publish(
        decision({ announce: failing, recovered }),
      );

      const payload = sentPayload();
      // Noticia boa espera um ciclo; a falha ativa e a razao de a mensagem
      // existir.
      expect(payload.embeds[0].fields).toHaveLength(10);
      expect(payload.embeds[1].fields.length).toBeLessThan(10);
      expect(delivered).toEqual(
        expect.arrayContaining(failing.map((r) => r.id)),
      );
    });

    it('nao deixa o payload passar dos 6000 nem com detalhe gigante', async () => {
      fetchMock.mockResolvedValue(okResponse());
      const huge = Array.from({ length: 25 }, (_, index) =>
        record(`plan.collection_alive:s${index}`, 'error', {
          summary: 'x'.repeat(5000),
        }),
      );

      const delivered = await buildEnabled().publish(
        decision({ announce: huge }),
      );

      expect(aggregateChars(sentPayload())).toBeLessThanOrEqual(6000);
      expect(delivered.length).toBeGreaterThan(0);
    });

    it('preserva allowed_mentions e escape mesmo cortando campos', async () => {
      fetchMock.mockResolvedValue(okResponse());
      const many = Array.from({ length: 25 }, (_, index) =>
        record(`plan.collection_alive:s${index}`, 'error', {
          summary: `@everyone ||spoiler|| ${'x'.repeat(400)}`,
        }),
      );

      await buildEnabled().publish(decision({ announce: many }));

      const payload = sentPayload();
      expect(payload.allowed_mentions).toEqual({ parse: [] });
      expect(payload.embeds[0].fields[0].value).not.toContain('||spoiler||');
    });
  });

  describe('recusa do payload (HTTP 400)', () => {
    it('nao carimba nada e diz no log que nao entregou', async () => {
      const error = jest.spyOn(Logger.prototype, 'error');
      fetchMock.mockResolvedValue({ ok: false, status: 400 });

      const ids = await buildEnabled().publish(
        decision({
          announce: [record(HealthCheckName.CollectionAlive, 'breached')],
        }),
      );

      expect(ids).toEqual([]);
      // `publish` devolvendo [] sozinho e indistinguivel de "nao havia nada a
      // dizer" para quem le o log.
      const logged = JSON.stringify(error.mock.calls);
      expect(logged).toContain('NAO entregue');
      expect(logged).toContain('400');
      expect(logged).not.toContain('super-secret-token');
    });

    it('nao tenta de novo no mesmo ciclo', async () => {
      fetchMock.mockResolvedValue({ ok: false, status: 400 });

      await buildEnabled().publish(
        decision({
          announce: [record(HealthCheckName.CollectionAlive, 'breached')],
        }),
      );

      // O 400 nao e transitorio: a mesma decisao remonta o mesmo payload.
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });

  describe('escapeMarkdown', () => {
    it('escapa os metacaracteres do Discord', () => {
      expect(escapeMarkdown('a*b_c~d`e|f')).toBe('a\\*b\\_c\\~d\\`e\\|f');
    });

    it('deixa texto comum intacto', () => {
      expect(escapeMarkdown('servidor survival sem sessao')).toBe(
        'servidor survival sem sessao',
      );
    });
  });
});
