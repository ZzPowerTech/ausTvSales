package de.austv.sales.api;

import static org.junit.jupiter.api.Assertions.assertEquals;

import de.austv.sales.api.SaleDelivery.Outcome;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;

/** Cobre o mapeamento puro de status code -> outcome, conforme o contrato §2.3. */
class SaleDeliveryTest {

  @ParameterizedTest
  @DisplayName("2xx e ACK (gravado ou ja existia)")
  @ValueSource(ints = {200, 201, 202, 204, 299})
  void twoHundredsAreAck(int status) {
    assertEquals(Outcome.ACK, SaleDelivery.classify(status));
  }

  @ParameterizedTest
  @DisplayName("4xx e erro permanente (422 item, 400 payload, 401 auth) — nao reenfileira")
  @ValueSource(ints = {400, 401, 403, 404, 422, 429, 499})
  void fourHundredsArePermanent(int status) {
    assertEquals(Outcome.PERMANENT, SaleDelivery.classify(status));
  }

  @ParameterizedTest
  @DisplayName("5xx e transitorio — candidato a fila na Sprint 3")
  @ValueSource(ints = {500, 502, 503, 504})
  void fiveHundredsAreTransient(int status) {
    assertEquals(Outcome.TRANSIENT, SaleDelivery.classify(status));
  }

  @ParameterizedTest
  @DisplayName("codigos fora de 2xx/4xx (ex.: 1xx, 3xx, 0) caem em transitorio por seguranca")
  @ValueSource(ints = {0, 100, 301, 308})
  void unexpectedCodesAreTransient(int status) {
    assertEquals(Outcome.TRANSIENT, SaleDelivery.classify(status));
  }
}
