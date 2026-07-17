package de.austv.sales.command;

import static org.junit.jupiter.api.Assertions.assertEquals;

import java.math.BigDecimal;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

/**
 * Cobre a normalizacao pura do {@code %price%} do Genesis. O resultado deve ser sempre
 * parseavel por {@link SaleCommandParser} (i.e. um {@link BigDecimal} valido) quando a entrada
 * representa um numero.
 */
class PriceNormalizerTest {

  private static void assertNormalizesTo(String expected, String raw) {
    String normalized = PriceNormalizer.normalize(raw);
    assertEquals(expected, normalized);
    // Garantia extra: o resultado e um BigDecimal valido (contrato com o parser).
    new BigDecimal(normalized);
  }

  @Test
  @DisplayName("numero ja canonico com ponto e mantido")
  void keepsCanonicalDotDecimal() {
    assertNormalizesTo("9.90", "9.90");
    assertNormalizesTo("1234.56", "1234.56");
  }

  @Test
  @DisplayName("virgula decimal vira ponto")
  void convertsCommaDecimalToDot() {
    assertNormalizesTo("9.90", "9,90");
    assertNormalizesTo("0.99", "0,99");
  }

  @Test
  @DisplayName("simbolo de moeda e espacos sao removidos")
  void stripsCurrencySymbolAndSpaces() {
    assertNormalizesTo("9.90", "R$ 9,90");
    assertNormalizesTo("19.90", "R$19.90");
    assertNormalizesTo("5.00", " 5.00 ");
  }

  @Test
  @DisplayName("formato brasileiro com ponto de milhar e virgula decimal")
  void handlesBrazilianGrouping() {
    assertNormalizesTo("1234.56", "1.234,56");
    assertNormalizesTo("1234567.89", "1.234.567,89");
  }

  @Test
  @DisplayName("formato ingles com virgula de milhar e ponto decimal")
  void handlesEnglishGrouping() {
    assertNormalizesTo("1234.56", "1,234.56");
    assertNormalizesTo("1234567.89", "1,234,567.89");
  }

  @Test
  @DisplayName("inteiro com separador de milhar (sem decimal) nao vira decimal")
  void treatsLoneThousandsSeparatorAsGrouping() {
    // Separador unico seguido de exatamente 3 digitos = agrupamento de milhar, nao decimal.
    assertNormalizesTo("1234", "1.234"); // BR
    assertNormalizesTo("1234", "1,234"); // EN
    assertNormalizesTo("1234", "R$ 1.234");
    assertNormalizesTo("1234567", "1.234.567"); // multiplos separadores = agrupamento
  }

  @Test
  @DisplayName("valor negativo preserva o sinal")
  void preservesNegativeSign() {
    assertEquals("-9.90", PriceNormalizer.normalize("-9,90"));
    assertEquals("-1234.56", PriceNormalizer.normalize("-R$ 1.234,56"));
  }

  @Test
  @DisplayName("inteiro sem separador decimal e mantido")
  void keepsPlainInteger() {
    assertNormalizesTo("10", "10");
    assertNormalizesTo("10", "R$ 10");
  }

  @Test
  @DisplayName("null vira string vazia (parser reporta como preco invalido)")
  void nullBecomesEmptyString() {
    assertEquals("", PriceNormalizer.normalize(null));
  }

  @Test
  @DisplayName("entrada sem digitos e devolvida trimada para o parser rejeitar")
  void nonNumericPassesThroughForParserToReject() {
    assertEquals("free", PriceNormalizer.normalize(" free "));
  }
}
