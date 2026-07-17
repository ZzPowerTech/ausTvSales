package de.austv.sales.api;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

/** Cobre a resolucao de endpoint/timeout e o gate fail-safe de {@link SaleApiConfig}. */
class SaleApiConfigTest {

  @Test
  @DisplayName("base-url e api-key validos habilitam o envio e derivam o endpoint /sales")
  void enablesWithValidConfig() {
    SaleApiConfig config = SaleApiConfig.of("https://sales.austv.net/api", "k", 5000);

    assertTrue(config.enabled());
    assertEquals("https://sales.austv.net/api/sales", config.salesEndpoint());
    assertEquals("k", config.apiKey());
  }

  @Test
  @DisplayName("barra final na base-url e tolerada (sem barra dupla)")
  void toleratesTrailingSlash() {
    assertEquals(
        "https://sales.austv.net/api/sales",
        SaleApiConfig.of("https://sales.austv.net/api/", "k", 5000).salesEndpoint());
  }

  @Test
  @DisplayName("base-url ou api-key ausente desabilita (fail-safe)")
  void disablesWhenMissing() {
    assertFalse(SaleApiConfig.of("", "k", 5000).enabled());
    assertFalse(SaleApiConfig.of("https://sales.austv.net/api", "", 5000).enabled());
    assertFalse(SaleApiConfig.of("  ", "  ", 5000).enabled());
  }

  @Test
  @DisplayName("base-url invalida desabilita em vez de estourar depois no envio")
  void disablesWhenBaseUrlInvalid() {
    assertFalse(SaleApiConfig.of("sales.austv.net", "k", 5000).enabled()); // sem schema
    assertFalse(SaleApiConfig.of("http://exemplo com espaco", "k", 5000).enabled());
    assertFalse(SaleApiConfig.of("ftp://sales.austv.net", "k", 5000).enabled()); // schema errado
    assertEquals("", SaleApiConfig.of("sales.austv.net", "k", 5000).salesEndpoint());
  }

  @Test
  @DisplayName("timeout invalido cai no default de 5s")
  void fallsBackToDefaultTimeout() {
    assertEquals(5000, SaleApiConfig.of("https://x.y/api", "k", 0).timeout().toMillis());
    assertEquals(5000, SaleApiConfig.of("https://x.y/api", "k", -1).timeout().toMillis());
    assertEquals(1500, SaleApiConfig.of("https://x.y/api", "k", 1500).timeout().toMillis());
  }
}
