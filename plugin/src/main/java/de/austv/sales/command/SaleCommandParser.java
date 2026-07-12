package de.austv.sales.command;

import java.math.BigDecimal;
import java.util.regex.Pattern;

/**
 * Pure parser/validator for the {@code austv-sales add} command arguments. Has no dependency on
 * Bukkit so it can be unit tested in isolation.
 */
public final class SaleCommandParser {

  private static final Pattern NICK_PATTERN = Pattern.compile("^[a-zA-Z0-9_]{3,16}$");
  private static final String ADD_SUBCOMMAND = "add";
  private static final int EXPECTED_ADD_ARG_COUNT = 5;

  private SaleCommandParser() {}

  public sealed interface ParseResult permits ParseResult.Success, ParseResult.Failure {

    record Success(ParsedSale sale) implements ParseResult {}

    record Failure(String message) implements ParseResult {}
  }

  public record ParsedSale(String playerNick, String itemId, BigDecimal totalPrice, int qtd) {}

  public static ParseResult parse(String[] args) {
    if (args == null || args.length == 0) {
      return new ParseResult.Failure(
          "Missing subcommand. Usage: /austv-sales add <player_nick> <item_id> <total_price> <qtd>");
    }

    if (!ADD_SUBCOMMAND.equalsIgnoreCase(args[0])) {
      return new ParseResult.Failure("Unknown subcommand '" + args[0] + "'. Expected: add");
    }

    if (args.length != EXPECTED_ADD_ARG_COUNT) {
      return new ParseResult.Failure(
          "Invalid number of arguments. Usage: /austv-sales add <player_nick> <item_id> <total_price> <qtd>");
    }

    String playerNick = args[1];
    String itemId = args[2];
    String rawTotalPrice = args[3];
    String rawQtd = args[4];

    if (!NICK_PATTERN.matcher(playerNick).matches()) {
      return new ParseResult.Failure(
          "Invalid player_nick '"
              + playerNick
              + "'. Must be 3-16 characters (letters, digits, underscore).");
    }

    if (itemId.isBlank()) {
      return new ParseResult.Failure("item_id must not be empty.");
    }

    BigDecimal totalPrice;
    try {
      totalPrice = new BigDecimal(rawTotalPrice);
    } catch (NumberFormatException e) {
      return new ParseResult.Failure(
          "Invalid total_price '" + rawTotalPrice + "'. Must be a decimal number.");
    }

    if (totalPrice.compareTo(BigDecimal.ZERO) <= 0) {
      return new ParseResult.Failure("total_price must be > 0, got " + totalPrice + ".");
    }

    int qtd;
    try {
      qtd = Integer.parseInt(rawQtd);
    } catch (NumberFormatException e) {
      return new ParseResult.Failure("Invalid qtd '" + rawQtd + "'. Must be an integer.");
    }

    if (qtd < 1) {
      return new ParseResult.Failure("qtd must be >= 1, got " + qtd + ".");
    }

    return new ParseResult.Success(new ParsedSale(playerNick, itemId, totalPrice, qtd));
  }
}
