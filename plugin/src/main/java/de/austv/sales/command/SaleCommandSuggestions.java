package de.austv.sales.command;

import java.util.Collection;
import java.util.List;
import java.util.Locale;

/**
 * Pure suggestion engine for the {@code /austv-sales} tab completion. Has no dependency on Bukkit
 * so it can be unit tested in isolation, mirroring the split already used by {@link
 * SaleCommandParser} (pure) and {@link SaleCommandExecutor} (thin Bukkit shell).
 *
 * <p>Argument slots follow the command contract {@code add <player_nick> <item_id> <total_price>
 * <qtd>}. Bukkit hands the completer an {@code args} array whose LAST element is the token being
 * typed (empty string when the player just pressed space), so {@code args.length} is what selects
 * the slot - never {@code args.length - 1}.
 *
 * <p>{@code total_price} and {@code qtd} have no enumerable domain, so they suggest the usage
 * placeholder ({@code <total_price>} / {@code <qtd>}) purely as an inline reminder of argument
 * order. Because the placeholder goes through the same prefix filter as everything else, it shows
 * up on an empty token and disappears as soon as the operator starts typing a real value.
 *
 * <p>Every path returns a (possibly empty) list, never {@code null}: a {@code null} return makes
 * Bukkit fall back to completing online player names, which would wrongly offer nicks in the
 * {@code item_id}, {@code total_price} and {@code qtd} slots.
 */
public final class SaleCommandSuggestions {

  private static final List<String> SUBCOMMANDS = List.of("add");
  private static final List<String> TOTAL_PRICE_HINT = List.of("<total_price>");
  private static final List<String> QTD_HINT = List.of("<qtd>");

  private static final int SUBCOMMAND_SLOT = 1;
  private static final int PLAYER_NICK_SLOT = 2;
  private static final int ITEM_ID_SLOT = 3;
  private static final int TOTAL_PRICE_SLOT = 4;
  private static final int QTD_SLOT = 5;

  private SaleCommandSuggestions() {}

  /**
   * Returns the completions for the slot currently being typed.
   *
   * @param args the raw Bukkit argument array; its last element is the partial token
   * @param onlineNicks nicks of the currently connected players, for the {@code player_nick} slot
   * @param activeItemIds the locally cached active {@code item_id}s, for the {@code item_id} slot.
   *     An empty cache (API unconfigured, or first boot before the initial sync) therefore yields
   *     no suggestions - consistent with {@link SaleCommandExecutor} rejecting those commands
   *     outright, and never inventing an item that was not synced from the catalog.
   */
  public static List<String> suggest(
      String[] args, Collection<String> onlineNicks, Collection<String> activeItemIds) {
    if (args == null || args.length == 0) {
      return List.of();
    }

    String partial = args[args.length - 1];

    return switch (args.length) {
      case SUBCOMMAND_SLOT -> filterByPrefix(SUBCOMMANDS, partial);
      case PLAYER_NICK_SLOT -> forAddSubcommand(args, filterByPrefix(onlineNicks, partial));
      case ITEM_ID_SLOT -> forAddSubcommand(args, filterByPrefix(activeItemIds, partial));
      case TOTAL_PRICE_SLOT -> forAddSubcommand(args, filterByPrefix(TOTAL_PRICE_HINT, partial));
      case QTD_SLOT -> forAddSubcommand(args, filterByPrefix(QTD_HINT, partial));
      default -> List.of();
    };
  }

  /**
   * Gates the argument suggestions on {@code args[0]} actually being {@code add}. Typing an unknown
   * subcommand must not keep offering nicks/items for a command shape that {@link
   * SaleCommandParser} will reject anyway.
   */
  private static List<String> forAddSubcommand(String[] args, List<String> suggestions) {
    return SUBCOMMANDS.get(0).equalsIgnoreCase(args[0]) ? suggestions : List.of();
  }

  /**
   * Case-insensitive prefix filter, sorted for a stable ordering in the client's completion popup.
   * A blank partial matches everything, which is what makes the usage placeholders show up right
   * after the operator presses space.
   */
  private static List<String> filterByPrefix(Collection<String> candidates, String partial) {
    String prefix = partial == null ? "" : partial.toLowerCase(Locale.ROOT);
    return candidates.stream()
        .filter(candidate -> candidate != null && candidate.toLowerCase(Locale.ROOT).startsWith(prefix))
        .sorted(String.CASE_INSENSITIVE_ORDER)
        .toList();
  }
}
