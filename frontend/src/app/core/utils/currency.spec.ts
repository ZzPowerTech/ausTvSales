import { formatBRL } from './currency';

// `toContain` em vez de igualdade estrita: o Intl separa "R$" do valor com um
// espaço não separável, e fixá-lo no teste amarraria o spec a um detalhe de ICU.
describe('formatBRL', () => {
  it('formata a string numeric(12,2) da API como BRL', () => {
    const formatted = formatBRL('1440.00');
    expect(formatted).toContain('R$');
    expect(formatted).toContain('1.440,00');
  });

  it('preserva os centavos exatos da string', () => {
    expect(formatBRL('0.30')).toContain('0,30');
  });

  it('aceita um number já na fronteira de exibição (tick de gráfico)', () => {
    expect(formatBRL(150)).toContain('150,00');
  });
});
