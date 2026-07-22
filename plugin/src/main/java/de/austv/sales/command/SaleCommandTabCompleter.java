package de.austv.sales.command;

import de.austv.sales.cache.ItemCache;
import java.util.List;
import org.bukkit.command.Command;
import org.bukkit.command.CommandSender;
import org.bukkit.command.TabCompleter;
import org.bukkit.entity.Player;
import org.bukkit.plugin.Plugin;

/**
 * Bukkit-facing tab completion for {@code /austv-sales}. Keeps only the Bukkit lookups (online
 * players, item cache) and delegates every decision to {@link SaleCommandSuggestions}, the same
 * split {@link SaleCommandExecutor} uses with {@link SaleCommandParser}.
 *
 * <p>Like the executor, this class does no permission check of its own: {@code
 * PluginCommand#tabComplete} already returns an empty list for a sender that fails the
 * {@code austv.sales.admin} test declared in {@code plugin.yml}, so the active catalog is never
 * enumerable by a common player.
 *
 * <p>Runs on the main thread on every keystroke, so both sources are O(1)-ish reads: {@link
 * ItemCache#activeItemIds()} is a lock-free volatile read of an immutable set, and the online
 * player list is already in memory. No network, no SQLite - same rule as the command path.
 */
public final class SaleCommandTabCompleter implements TabCompleter {

  private final Plugin plugin;
  private final ItemCache itemCache;

  public SaleCommandTabCompleter(Plugin plugin, ItemCache itemCache) {
    this.plugin = plugin;
    this.itemCache = itemCache;
  }

  @Override
  public List<String> onTabComplete(
      CommandSender sender, Command command, String alias, String[] args) {
    return SaleCommandSuggestions.suggest(args, onlineNicks(), itemCache.activeItemIds());
  }

  /**
   * Nicks of every connected player, deliberately without a {@code canSee} filter: this is an
   * admin-only command and an operator must still be able to register a sale for a vanished player.
   */
  private List<String> onlineNicks() {
    return plugin.getServer().getOnlinePlayers().stream().map(Player::getName).toList();
  }
}
