package de.austv.sales.api;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import java.math.BigDecimal;
import java.time.Instant;
import java.util.UUID;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

/** Cobre a serializacao pura do payload de venda para o contrato snake_case do backend. */
class SaleJsonTest {

  private static final UUID SALE_ID = UUID.fromString("3fa85f64-5717-4562-b3fc-2c963f66afa6");
  private static final UUID PLAYER_UUID =
      UUID.fromString("9c858901-8a57-4791-81fe-4c455b099bc9");
  private static final Instant PURCHASED_AT = Instant.parse("2026-07-12T10:30:00.000Z");

  private static JsonObject parse(SalePayload payload) {
    return JsonParser.parseString(SaleJson.toJson(payload)).getAsJsonObject();
  }

  private static SalePayload payload(BigDecimal totalPrice, int qtd) {
    return new SalePayload(
        SALE_ID, "caixaNatal2026", PLAYER_UUID, "Murilo", totalPrice, qtd, PURCHASED_AT);
  }

  @Test
  @DisplayName("emite todos os campos do contrato em snake_case")
  void emitsSnakeCaseContractFields() {
    JsonObject json = parse(payload(new BigDecimal("19.90"), 2));

    assertEquals("3fa85f64-5717-4562-b3fc-2c963f66afa6", json.get("sale_id").getAsString());
    assertEquals("caixaNatal2026", json.get("item_id").getAsString());
    assertEquals("9c858901-8a57-4791-81fe-4c455b099bc9", json.get("player_uuid").getAsString());
    assertEquals("Murilo", json.get("nickname_at_purchase").getAsString());
    assertEquals(2, json.get("qtd").getAsInt());
  }

  @Test
  @DisplayName("purchased_at e serializado como instante ISO-8601")
  void serializesPurchasedAtAsIso8601() {
    JsonObject json = parse(payload(new BigDecimal("19.90"), 1));

    assertEquals("2026-07-12T10:30:00Z", json.get("purchased_at").getAsString());
  }

  @Test
  @DisplayName("total_price sai sempre com exatamente duas casas decimais")
  void totalPriceAlwaysTwoDecimals() {
    // Uma casa -> completa para duas.
    assertEquals("9.90", parse(payload(new BigDecimal("9.9"), 1)).get("total_price").getAsString());
    // Inteiro -> duas casas.
    assertEquals("10.00", parse(payload(new BigDecimal("10"), 1)).get("total_price").getAsString());
    // Ja com duas casas -> preservado.
    assertEquals(
        "19.90", parse(payload(new BigDecimal("19.90"), 1)).get("total_price").getAsString());
  }

  @Test
  @DisplayName("total_price com mais de duas casas e arredondado (HALF_UP) para duas")
  void totalPriceRoundsToTwoDecimals() {
    assertEquals(
        "10.00", parse(payload(new BigDecimal("9.999"), 1)).get("total_price").getAsString());
    assertEquals(
        "19.99", parse(payload(new BigDecimal("19.994"), 1)).get("total_price").getAsString());
  }

  @Test
  @DisplayName("total_price e um numero JSON (nao string)")
  void totalPriceIsANumber() {
    JsonObject json = parse(payload(new BigDecimal("19.90"), 1));

    assertTrue(json.get("total_price").getAsJsonPrimitive().isNumber());
    assertEquals(0, json.get("total_price").getAsBigDecimal().compareTo(new BigDecimal("19.90")));
  }
}
