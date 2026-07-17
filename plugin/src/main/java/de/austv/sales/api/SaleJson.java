package de.austv.sales.api;

import com.google.gson.JsonObject;
import java.math.BigDecimal;
import java.math.RoundingMode;

/**
 * Pure serialization of a {@link SalePayload} into the JSON body expected by {@code POST /sales}.
 *
 * <p>Field names are snake_case to match the backend {@code CreateSaleDto}. String escaping is
 * delegated to Gson (provided by Paper at runtime; {@code compileOnly} here). {@code purchased_at}
 * is emitted as an ISO-8601 instant and {@code total_price} is always normalized to exactly two
 * decimal places — the backend rejects more than two — regardless of the incoming scale.
 */
public final class SaleJson {

  private SaleJson() {}

  /** Builds the request body JSON for the given payload. */
  public static String toJson(SalePayload payload) {
    BigDecimal price = payload.totalPrice().setScale(2, RoundingMode.HALF_UP);

    JsonObject json = new JsonObject();
    json.addProperty("sale_id", payload.saleId().toString());
    json.addProperty("item_id", payload.itemId());
    json.addProperty("player_uuid", payload.playerUuid().toString());
    json.addProperty("nickname_at_purchase", payload.nicknameAtPurchase());
    json.addProperty("total_price", price);
    json.addProperty("qtd", payload.qtd());
    // Instant.toString() is ISO-8601 (e.g. 2026-07-12T10:30:00.000Z), accepted by @IsISO8601.
    json.addProperty("purchased_at", payload.purchasedAt().toString());
    return json.toString();
  }
}
