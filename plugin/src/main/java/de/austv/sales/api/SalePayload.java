package de.austv.sales.api;

import java.math.BigDecimal;
import java.time.Instant;
import java.util.UUID;

/**
 * Immutable representation of a sale event ready to be sent to the API. Mirrors the backend {@code
 * CreateSaleDto} contract (snake_case on the wire, see {@link SaleJson}).
 *
 * <p>{@code saleId} and {@code purchasedAt} are always generated in the executor ({@code
 * UUID.randomUUID()} / {@code Instant.now()}), never taken from a command argument.
 */
public record SalePayload(
    UUID saleId,
    String itemId,
    UUID playerUuid,
    String nicknameAtPurchase,
    BigDecimal totalPrice,
    int qtd,
    Instant purchasedAt) {}
