package de.austv.sales.command;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertInstanceOf;
import static org.junit.jupiter.api.Assertions.assertTrue;

import de.austv.sales.command.SaleCommandParser.ParseResult;
import de.austv.sales.command.SaleCommandParser.ParsedSale;
import java.math.BigDecimal;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;

class SaleCommandParserTest {

  @Test
  @DisplayName("valid arguments produce a Success with the correctly typed values")
  void parsesValidAddCommand() {
    ParseResult result = SaleCommandParser.parse(new String[] {"add", "Murilo_", "caixaNatal2026", "9.90", "2"});

    ParseResult.Success success = assertInstanceOf(ParseResult.Success.class, result);
    ParsedSale sale = success.sale();
    assertEquals("Murilo_", sale.playerNick());
    assertEquals("caixaNatal2026", sale.itemId());
    assertEquals(new BigDecimal("9.90"), sale.totalPrice());
    assertEquals(2, sale.qtd());
  }

  @Test
  @DisplayName("total_price of exactly zero is accepted (>= 0)")
  void acceptsZeroPrice() {
    ParseResult result = SaleCommandParser.parse(new String[] {"add", "Murilo", "item1", "0", "1"});

    assertInstanceOf(ParseResult.Success.class, result);
  }

  @ParameterizedTest
  @DisplayName("nicknames outside the 3-16 [a-zA-Z0-9_] pattern are rejected")
  @ValueSource(
      strings = {
        "ab",
        "aaaaaaaaaaaaaaaaa",
        "invalid nick",
        "invalid-nick",
        "nick!",
        ""
      })
  void rejectsInvalidNick(String invalidNick) {
    ParseResult result =
        SaleCommandParser.parse(new String[] {"add", invalidNick, "item1", "10.00", "1"});

    ParseResult.Failure failure = assertInstanceOf(ParseResult.Failure.class, result);
    assertTrue(failure.message().contains("player_nick"));
  }

  @Test
  @DisplayName("blank item_id is rejected")
  void rejectsBlankItemId() {
    ParseResult result = SaleCommandParser.parse(new String[] {"add", "Murilo", "   ", "10.00", "1"});

    ParseResult.Failure failure = assertInstanceOf(ParseResult.Failure.class, result);
    assertTrue(failure.message().contains("item_id"));
  }

  @Test
  @DisplayName("negative total_price is rejected")
  void rejectsNegativePrice() {
    ParseResult result = SaleCommandParser.parse(new String[] {"add", "Murilo", "item1", "-0.01", "1"});

    ParseResult.Failure failure = assertInstanceOf(ParseResult.Failure.class, result);
    assertTrue(failure.message().contains("total_price"));
  }

  @ParameterizedTest
  @DisplayName("non-numeric total_price is rejected")
  @ValueSource(strings = {"free", "9,90", "1e", ""})
  void rejectsNonNumericPrice(String invalidPrice) {
    ParseResult result =
        SaleCommandParser.parse(new String[] {"add", "Murilo", "item1", invalidPrice, "1"});

    ParseResult.Failure failure = assertInstanceOf(ParseResult.Failure.class, result);
    assertTrue(failure.message().contains("total_price"));
  }

  @Test
  @DisplayName("zero qtd is rejected (must be >= 1)")
  void rejectsZeroQtd() {
    ParseResult result = SaleCommandParser.parse(new String[] {"add", "Murilo", "item1", "10.00", "0"});

    ParseResult.Failure failure = assertInstanceOf(ParseResult.Failure.class, result);
    assertTrue(failure.message().contains("qtd"));
  }

  @Test
  @DisplayName("negative qtd is rejected")
  void rejectsNegativeQtd() {
    ParseResult result = SaleCommandParser.parse(new String[] {"add", "Murilo", "item1", "10.00", "-3"});

    ParseResult.Failure failure = assertInstanceOf(ParseResult.Failure.class, result);
    assertTrue(failure.message().contains("qtd"));
  }

  @ParameterizedTest
  @DisplayName("non-integer qtd is rejected")
  @ValueSource(strings = {"1.5", "two", ""})
  void rejectsNonIntegerQtd(String invalidQtd) {
    ParseResult result =
        SaleCommandParser.parse(new String[] {"add", "Murilo", "item1", "10.00", invalidQtd});

    ParseResult.Failure failure = assertInstanceOf(ParseResult.Failure.class, result);
    assertTrue(failure.message().contains("qtd"));
  }

  @Test
  @DisplayName("missing arguments are rejected with a usage message")
  void rejectsMissingArguments() {
    ParseResult result = SaleCommandParser.parse(new String[] {"add", "Murilo", "item1"});

    ParseResult.Failure failure = assertInstanceOf(ParseResult.Failure.class, result);
    assertTrue(failure.message().contains("Usage"));
  }

  @Test
  @DisplayName("no arguments at all are rejected with a usage message")
  void rejectsEmptyArguments() {
    ParseResult result = SaleCommandParser.parse(new String[] {});

    ParseResult.Failure failure = assertInstanceOf(ParseResult.Failure.class, result);
    assertTrue(failure.message().contains("Usage"));
  }

  @Test
  @DisplayName("null arguments are rejected with a usage message")
  void rejectsNullArguments() {
    ParseResult result = SaleCommandParser.parse(null);

    ParseResult.Failure failure = assertInstanceOf(ParseResult.Failure.class, result);
    assertTrue(failure.message().contains("Usage"));
  }

  @Test
  @DisplayName("unknown subcommand is rejected")
  void rejectsUnknownSubcommand() {
    ParseResult result = SaleCommandParser.parse(new String[] {"remove", "Murilo", "item1", "10.00", "1"});

    ParseResult.Failure failure = assertInstanceOf(ParseResult.Failure.class, result);
    assertTrue(failure.message().contains("Unknown subcommand"));
  }

  @Test
  @DisplayName("subcommand match is case-insensitive")
  void acceptsUppercaseSubcommand() {
    ParseResult result = SaleCommandParser.parse(new String[] {"ADD", "Murilo", "item1", "10.00", "1"});

    assertInstanceOf(ParseResult.Success.class, result);
  }
}
