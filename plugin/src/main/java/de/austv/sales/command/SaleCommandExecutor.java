package de.austv.sales.command;

import de.austv.sales.api.SaleApiClient;
import de.austv.sales.api.SalePayload;
import de.austv.sales.command.SaleCommandParser.ParseResult;
import de.austv.sales.command.SaleCommandParser.ParsedSale;
import java.time.Instant;
import java.util.UUID;
import org.bukkit.ChatColor;
import org.bukkit.OfflinePlayer;
import org.bukkit.command.Command;
import org.bukkit.command.CommandExecutor;
import org.bukkit.command.CommandSender;
import org.bukkit.plugin.Plugin;

/**
 * Bukkit-facing entry point for {@code /austv-sales}. Argument validation is delegated to {@link
 * SaleCommandParser}; the {@code %price%} placeholder is normalized by {@link PriceNormalizer}
 * before parsing.
 *
 * <p>Happy path (S2.4): resolve {@code player_nick → player_uuid} from the Bukkit cache, stamp
 * {@code sale_id}/{@code purchased_at} locally and dispatch the payload asynchronously to the API —
 * no network I/O on the main thread. The item-cache validation (S3.1) and the SQLite fallback queue
 * (S3) are intentionally out of scope here; unknown items are rejected authoritatively by the API.
 */
public final class SaleCommandExecutor implements CommandExecutor {

  private static final String PERMISSION = "austv.sales.admin";
  private static final int PRICE_ARG_INDEX = 3;

  private final Plugin plugin;
  private final SaleApiClient apiClient;

  /**
   * @param apiClient the delivery client, or {@code null} when the API is not configured (fail-safe:
   *     the command still parses and validates but nothing is sent).
   */
  public SaleCommandExecutor(Plugin plugin, SaleApiClient apiClient) {
    this.plugin = plugin;
    this.apiClient = apiClient;
  }

  @Override
  public boolean onCommand(CommandSender sender, Command command, String label, String[] args) {
    // A common player must never forge a sale through chat. Console has all permissions.
    if (!sender.hasPermission(PERMISSION)) {
      sender.sendMessage(ChatColor.RED + "Voce nao tem permissao para usar este comando.");
      return true;
    }

    ParseResult result = SaleCommandParser.parse(normalizePriceArg(args));

    if (result instanceof ParseResult.Failure failure) {
      sender.sendMessage(ChatColor.RED + failure.message());
      return true;
    }

    ParsedSale sale = ((ParseResult.Success) result).sale();

    // Resolve nick -> UUID from the local cache only (non-blocking). An uncached nick is treated
    // as unresolvable: log and abort, never a blocking web lookup on the main thread.
    OfflinePlayer offlinePlayer = plugin.getServer().getOfflinePlayerIfCached(sale.playerNick());
    if (offlinePlayer == null) {
      String message =
          "Nao foi possivel resolver o UUID de '" + sale.playerNick() + "'. Venda nao enviada.";
      plugin.getLogger().warning(message);
      sender.sendMessage(ChatColor.RED + message);
      return true;
    }

    UUID playerUuid = offlinePlayer.getUniqueId();
    String nickname = offlinePlayer.getName() != null ? offlinePlayer.getName() : sale.playerNick();

    SalePayload payload =
        new SalePayload(
            UUID.randomUUID(),
            sale.itemId(),
            playerUuid,
            nickname,
            sale.totalPrice(),
            sale.qtd(),
            Instant.now());

    if (apiClient == null) {
      plugin
          .getLogger()
          .severe(
              "API nao configurada (api.base-url / api.api-key ausentes): venda "
                  + payload.saleId()
                  + " parseada mas NAO enviada.");
      sender.sendMessage(
          ChatColor.RED + "API nao configurada; venda registrada apenas no log, nao enviada.");
      return true;
    }

    dispatchAsync(payload);
    sender.sendMessage(
        ChatColor.GREEN
            + "Venda enviada para "
            + nickname
            + " (sale_id="
            + payload.saleId()
            + ").");
    return true;
  }

  /** Runs the blocking HTTP delivery off the main thread. */
  private void dispatchAsync(SalePayload payload) {
    plugin
        .getServer()
        .getScheduler()
        .runTaskAsynchronously(plugin, () -> apiClient.deliver(payload));
  }

  /**
   * Returns a copy of {@code args} with the price argument normalized (comma decimal / currency
   * symbol stripped) so it reaches the parser in a canonical form. Structurally short inputs are
   * passed through untouched for the parser to reject with its usage message.
   */
  private static String[] normalizePriceArg(String[] args) {
    if (args == null || args.length <= PRICE_ARG_INDEX) {
      return args;
    }
    String[] copy = args.clone();
    copy[PRICE_ARG_INDEX] = PriceNormalizer.normalize(copy[PRICE_ARG_INDEX]);
    return copy;
  }
}
