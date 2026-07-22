package de.austv.sales.command;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.List;
import java.util.Set;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;

class SaleCommandSuggestionsTest {

  private static final List<String> ONLINE = List.of("Murilo", "Zezinho", "murinho");
  private static final Set<String> ITEMS = Set.of("caixaNatal2026", "caixaPascoa2026", "vip30d");

  private static List<String> suggest(String... args) {
    return SaleCommandSuggestions.suggest(args, ONLINE, ITEMS);
  }

  @Test
  @DisplayName("empty first token suggests the only subcommand")
  void suggestsSubcommand() {
    assertEquals(List.of("add"), suggest(""));
  }

  @Test
  @DisplayName("player_nick slot suggests online players, case-insensitively and sorted")
  void suggestsOnlineNicks() {
    assertEquals(List.of("Murilo", "murinho"), suggest("add", "mur"));
  }

  @Test
  @DisplayName("item_id slot suggests the cached active items filtered by prefix")
  void suggestsCachedItems() {
    assertEquals(List.of("caixaNatal2026", "caixaPascoa2026"), suggest("add", "Murilo", "caixa"));
  }

  @Test
  @DisplayName("an empty item cache yields no item suggestions instead of inventing ids")
  void emptyCacheSuggestsNothing() {
    assertEquals(List.of(), SaleCommandSuggestions.suggest(new String[] {"add", "Murilo", ""}, ONLINE, Set.of()));
  }

  @Test
  @DisplayName("total_price and qtd show the usage placeholder on an empty token")
  void showsUsagePlaceholders() {
    assertEquals(List.of("<total_price>"), suggest("add", "Murilo", "vip30d", ""));
    assertEquals(List.of("<qtd>"), suggest("add", "Murilo", "vip30d", "9.90", ""));
  }

  @Test
  @DisplayName("the placeholder disappears once a real value is being typed")
  void placeholderVanishesWhileTyping() {
    assertEquals(List.of(), suggest("add", "Murilo", "vip30d", "9."));
    assertEquals(List.of(), suggest("add", "Murilo", "vip30d", "9.90", "2"));
  }

  @Test
  @DisplayName("an unknown subcommand stops suggesting arguments for a shape the parser rejects")
  void unknownSubcommandSuggestsNothing() {
    assertEquals(List.of(), suggest("remove", ""));
    assertEquals(List.of(), suggest("remove", "Murilo", ""));
  }

  @Test
  @DisplayName("the subcommand match is case-insensitive, like the parser's")
  void subcommandMatchIsCaseInsensitive() {
    assertEquals(List.of("Murilo", "murinho"), suggest("ADD", "mur"));
  }

  @Test
  @DisplayName("arguments past qtd suggest nothing")
  void stopsAfterQtd() {
    assertEquals(List.of(), suggest("add", "Murilo", "vip30d", "9.90", "2", ""));
  }

  @ParameterizedTest
  @DisplayName("never returns null, so Bukkit never falls back to completing player names")
  @ValueSource(ints = {1, 2, 3, 4, 5, 6})
  void neverReturnsNull(int argCount) {
    String[] args = new String[argCount];
    java.util.Arrays.fill(args, "zzz");

    assertTrue(SaleCommandSuggestions.suggest(args, ONLINE, ITEMS) != null);
  }

  @Test
  @DisplayName("null or empty args are handled without blowing up")
  void handlesDegenerateArgs() {
    assertEquals(List.of(), SaleCommandSuggestions.suggest(null, ONLINE, ITEMS));
    assertEquals(List.of(), SaleCommandSuggestions.suggest(new String[] {}, ONLINE, ITEMS));
  }
}
