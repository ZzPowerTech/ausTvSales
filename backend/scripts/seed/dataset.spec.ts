import { buildDataset, type SeedOptions } from './dataset';
import { parseLocalDate } from './options';

const ITEMS = [
  'caixaNatal2026',
  'caixaHalloween2025',
  'passeTemporada',
  'kitFerramentas',
];

function options(overrides: Partial<SeedOptions> = {}): SeedOptions {
  return {
    count: 2_000,
    from: parseLocalDate('2026-01-01', 'from'),
    to: parseLocalDate('2026-07-01', 'to'),
    seed: 'test-seed',
    historicalRatio: 0.1,
    playerCount: 50,
    ...overrides,
  };
}

describe('buildDataset', () => {
  it('gera exatamente a quantidade pedida', () => {
    expect(buildDataset(options({ count: 137 }), ITEMS).sales).toHaveLength(
      137,
    );
  });

  it('e deterministico: mesma seed produz exatamente o mesmo dataset', () => {
    expect(buildDataset(options(), ITEMS)).toEqual(
      buildDataset(options(), ITEMS),
    );
  });

  it('produz um dataset disjunto quando a seed muda', () => {
    const a = buildDataset(options(), ITEMS).sales.map((sale) => sale.id);
    const b = buildDataset(options({ seed: 'outra' }), ITEMS).sales.map(
      (sale) => sale.id,
    );
    expect(a.some((id) => b.includes(id))).toBe(false);
  });

  it('nao repete sale_id dentro do mesmo dataset', () => {
    const { sales } = buildDataset(options(), ITEMS);
    expect(new Set(sales.map((sale) => sale.id)).size).toBe(sales.length);
  });

  it('respeita os invariantes que o POST /sales garantiria', () => {
    const { sales, players } = buildDataset(options(), ITEMS);
    const knownPlayers = new Set(players.map((player) => player.uuid));

    for (const sale of sales) {
      expect(ITEMS).toContain(sale.itemId);
      expect(sale.qtd).toBeGreaterThan(0);
      expect(Number(sale.totalPrice)).toBeGreaterThan(0);
      // Dinheiro sempre com 2 casas — nunca notacao cientifica ou float cru.
      expect(sale.totalPrice).toMatch(/^\d+\.\d{2}$/);
      // Todo player referenciado precisa existir: a FK sales.player_uuid.
      expect(knownPlayers.has(sale.playerUuid)).toBe(true);
    }
  });

  it('aborta quando nao ha item ativo no catalogo', () => {
    expect(() => buildDataset(options(), [])).toThrow(/item ativo/);
  });

  describe('historical_import (CA7)', () => {
    it('respeita a proporcao pedida', () => {
      const { sales } = buildDataset(
        options({ count: 1_000, historicalRatio: 0.25 }),
        ITEMS,
      );
      expect(sales.filter((sale) => sale.historicalImport)).toHaveLength(250);
    });

    it('concentra todo o historico num unico instante anterior a janela', () => {
      const opts = options();
      const { sales } = buildDataset(opts, ITEMS);
      const historicalInstants = new Set(
        sales
          .filter((sale) => sale.historicalImport)
          .map((sale) => sale.purchasedAt.getTime()),
      );

      // Um unico instante: a migracao real nao tem timestamp por evento, e
      // inventar granularidade falsa e exatamente o que o CA7 proibe.
      expect(historicalInstants.size).toBe(1);
      expect([...historicalInstants][0]).toBeLessThan(opts.from.getTime());
    });

    it('mantem as vendas nao-historicas dentro da janela', () => {
      const opts = options();
      const recent = buildDataset(opts, ITEMS).sales.filter(
        (sale) => !sale.historicalImport,
      );

      expect(recent.length).toBeGreaterThan(0);
      for (const sale of recent) {
        expect(sale.purchasedAt.getTime()).toBeGreaterThanOrEqual(
          opts.from.getTime(),
        );
        expect(sale.purchasedAt.getTime()).toBeLessThan(opts.to.getTime());
      }
    });

    it('permite gerar zero linhas historicas', () => {
      const { sales } = buildDataset(options({ historicalRatio: 0 }), ITEMS);
      expect(sales.some((sale) => sale.historicalImport)).toBe(false);
    });
  });

  describe('troca de nickname (CA4)', () => {
    it('gera pelo menos um jogador cujo nick de compra difere do atual', () => {
      const { sales, players } = buildDataset(options(), ITEMS);
      const currentByUuid = new Map(
        players.map((player) => [player.uuid, player.lastKnownNickname]),
      );

      const drifted = sales.filter(
        (sale) =>
          currentByUuid.get(sale.playerUuid) !== sale.nicknameAtPurchase,
      );

      // Sem isso o CA4 so pode ser verificado em teste unitario, nunca na tela.
      expect(drifted.length).toBeGreaterThan(0);
    });

    it('usa o nick vigente na data da compra, em ordem cronologica', () => {
      const { sales } = buildDataset(options(), ITEMS);
      const byPlayer = new Map<string, typeof sales>();
      for (const sale of sales) {
        byPlayer.set(sale.playerUuid, [
          ...(byPlayer.get(sale.playerUuid) ?? []),
          sale,
        ]);
      }

      /** `AusTV_0007` → 1, `AusTV_0007_v2` → 2. */
      const version = (nick: string): number =>
        Number(/_v(\d+)$/.exec(nick)?.[1] ?? 1);

      for (const playerSales of byPlayer.values()) {
        const versions = [...playerSales]
          .sort((a, b) => a.purchasedAt.getTime() - b.purchasedAt.getTime())
          .map((sale) => version(sale.nicknameAtPurchase));

        // O nick so anda para frente no tempo: uma venda mais antiga nunca pode
        // carregar um nick posterior ao de uma venda mais nova.
        expect(versions).toEqual([...versions].sort((a, b) => a - b));
      }
    });

    it('o historico anterior a janela carrega o primeiro nick conhecido', () => {
      const { sales } = buildDataset(options(), ITEMS);
      const historical = sales.filter((sale) => sale.historicalImport);

      for (const sale of historical) {
        expect(sale.nicknameAtPurchase).toMatch(/^AusTV_\d{4}$/);
      }
    });
  });

  it('enviesa a distribuicao de itens (nao uniforme)', () => {
    const { sales } = buildDataset(options({ count: 4_000 }), ITEMS);
    const counts = ITEMS.map(
      (itemId) => sales.filter((sale) => sale.itemId === itemId).length,
    ).sort((a, b) => b - a);

    // Um dataset uniforme esconde exatamente os picos que o CA5 quer mostrar.
    expect(counts[0]).toBeGreaterThan(counts[counts.length - 1] * 1.5);
  });
});
