package de.austv.sales.command;

import de.austv.sales.command.SaleCommandParser.ParseResult;
import java.util.UUID;
import org.bukkit.ChatColor;
import org.bukkit.command.Command;
import org.bukkit.command.CommandExecutor;
import org.bukkit.command.CommandSender;
import org.bukkit.plugin.Plugin;

/**
 * Bukkit-facing entry point for {@code /austv-sales}. Argument validation is fully delegated to
 * {@link SaleCommandParser}. UUID resolution, item cache lookup, SQLite fallback and async HTTPS
 * delivery to the API are wired up in Sprints 2-3.
 */
public final class SaleCommandExecutor implements CommandExecutor {

  private final Plugin plugin;

  public SaleCommandExecutor(Plugin plugin) {
    this.plugin = plugin;
  }

  @Override
  public boolean onCommand(CommandSender sender, Command command, String label, String[] args) {
    ParseResult result = SaleCommandParser.parse(args);

    if (result instanceof ParseResult.Failure failure) {
      sender.sendMessage(ChatColor.RED + failure.message());
      return true;
    }

    SaleCommandParser.ParsedSale sale = ((ParseResult.Success) result).sale();
    UUID saleId = UUID.randomUUID();

    // TODO(Sprint 2): resolve player_nick -> player_uuid via Bukkit API.
    // TODO(Sprint 2): validate item_id against the locally cached items table.
    // TODO(Sprint 2): capture purchased_at = Instant.now() and dispatch async to the API.
    // TODO(Sprint 3): on failure, persist to the SQLite fallback queue with status "pending".
    plugin
        .getLogger()
        .info(
            "Sale parsed (sale_id="
                + saleId
                + "): "
                + sale.playerNick()
                + " bought "
                + sale.qtd()
                + "x "
                + sale.itemId()
                + " for "
                + sale.totalPrice());

    sender.sendMessage(ChatColor.GREEN + "Sale registered for " + sale.playerNick() + ".");
    return true;
  }
}
