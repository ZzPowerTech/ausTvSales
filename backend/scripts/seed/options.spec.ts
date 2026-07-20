import { parseSeedOptions, SeedOptionsError } from './options';

describe('parseSeedOptions', () => {
  it('aplica os padroes documentados quando nada e passado', () => {
    const options = parseSeedOptions([]);
    expect(options.count).toBe(50_000);
    expect(options.playerCount).toBe(500);
    expect(options.seed).toBe('austv');
    expect(options.historicalRatio).toBe(0.1);
  });

  it('le a janela em America/Sao_Paulo com --to inclusivo como dia', () => {
    const options = parseSeedOptions(['--from=2026-01-01', '--to=2026-07-20']);

    expect(options.from.toISOString()).toBe('2026-01-01T03:00:00.000Z');
    // A janela e semiaberta: o instante final e o inicio do dia seguinte, senao
    // uma venda no ultimo dia pedido cairia silenciosamente fora do dataset.
    expect(options.to.toISOString()).toBe('2026-07-21T03:00:00.000Z');
  });

  it('rejeita data fora do formato YYYY-MM-DD', () => {
    expect(() => parseSeedOptions(['--from=01/01/2026'])).toThrow(
      SeedOptionsError,
    );
  });

  it('rejeita janela invertida', () => {
    expect(() =>
      parseSeedOptions(['--from=2026-07-20', '--to=2026-01-01']),
    ).toThrow(/anterior/);
  });

  it('rejeita count nao positivo', () => {
    expect(() => parseSeedOptions(['--count=0'])).toThrow(/inteiro/);
    expect(() => parseSeedOptions(['--count=abc'])).toThrow(/inteiro/);
  });

  it('rejeita historical-ratio fora de 0..1', () => {
    expect(() => parseSeedOptions(['--historical-ratio=1.5'])).toThrow(
      /entre 0 e 1/,
    );
    expect(() => parseSeedOptions(['--historical-ratio=-0.1'])).toThrow(
      /entre 0 e 1/,
    );
  });

  it('rejeita flag desconhecida em vez de ignorar silenciosamente', () => {
    // Um --cout=50000 digitado errado precisa falhar, nao gerar 50k linhas
    // com o padrao e deixar o operador achando que pediu outra coisa.
    expect(() => parseSeedOptions(['--cout=10'])).toThrow(/desconhecida/);
  });

  it('rejeita flag sem valor', () => {
    expect(() => parseSeedOptions(['--count'])).toThrow(/precisa de um valor/);
  });
});
