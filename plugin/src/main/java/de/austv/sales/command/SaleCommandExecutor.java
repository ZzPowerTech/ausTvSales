package de.austv.sales.command;

import de.austv.sales.api.SaleApiClient;
import de.austv.sales.api.SaleDelivery.Outcome;
import de.austv.sales.api.SalePayload;
import de.austv.sales.cache.ItemCache;
import de.austv.sales.command.SaleCommandParser.ParseResult;
import de.austv.sales.command.SaleCommandParser.ParsedSale;
import de.austv.sales.queue.SaleQueue;
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
 * <p>Happy path (S2.4 + S3.2 + S3.1): resolve {@code player_nick -> player_uuid} from the Bukkit
 * cache, stamp {@code sale_id}/{@code purchased_at} locally, then follow the write-ahead strategy
 * (§2.3 of the Sprint 3 spec): the payload is persisted as {@code pending} in the SQLite fallback
 * queue BEFORE any delivery attempt, so a crash between "parsed" and "sent" never loses a sale.
 * Only after the write is durable does the executor dispatch the HTTP delivery asynchronously and
 * act on the resulting {@link Outcome}. No network or SQLite I/O ever touches the main thread.
 *
 * <p><b>Item-cache guard (S3.1, §1.3):</b> right after a successful parse - before resolving the
 * nick, building the payload, or touching the queue - the executor checks {@link
 * ItemCache#contains(String)}. An unknown/inactive {@code item_id} is rejected locally: no nick
 * resolution, no enqueue, no send. This is a deliberate, important departure from the S3.2
 * write-ahead default ("enqueue even with the API disabled"): with an empty cache (first boot
 * with no network yet, or the API disabled altogether) the plugin has no local catalog to
 * validate against, so it can never tell a legitimate item from a typo. Enqueueing anyway would
 * risk silently piling up sales the API would reject as {@code failed_permanent} once it
 * eventually processes them - worse, with the API disabled they would just sit {@code pending}
 * forever, never getting the rejection feedback the operator needs. Rejecting fast and loud here
 * is strictly safer than trusting an empty catalog. The item-cache check is therefore the first
 * line of defense; the API's own 422 (`PERMANENT`, still authoritative for whatever the cache
 * does have) is the second, for the case the cache goes briefly stale between syncs.
 */
public final class SaleCommandExecutor implements CommandExecutor {

  private static final int PRICE_ARG_INDEX = 3;

  private final Plugin plugin;
  private final SaleApiClient apiClient;
  private final SaleQueue saleQueue;
  private final ItemCache itemCache;

  /**
   * @param apiClient the delivery client, or {@code null} when the API is not configured (fail-safe:
   *     nothing is sent over the network). Note that a command only reaches the enqueue step at all
   *     if it first clears the S3.1 item-cache guard below; with the API unconfigured the cache
   *     stays empty, so those commands are rejected before any enqueue.
   * @param saleQueue the SQLite fallback queue; a sale that clears the cache guard is write-ahead
   *     persisted here before any delivery attempt.
   * @param itemCache the S3.1 local item cache; gates every command before it reaches the queue.
   */
  public SaleCommandExecutor(
      Plugin plugin, SaleApiClient apiClient, SaleQueue saleQueue, ItemCache itemCache) {
    this.plugin = plugin;
    this.apiClient = apiClient;
    this.saleQueue = saleQueue;
    this.itemCache = itemCache;
  }

  @Override
  public boolean onCommand(CommandSender sender, Command command, String label, String[] args) {
    // Permission (`austv.sales.admin`, default `op`) is declared on the command in plugin.yml, so
    // Bukkit already blocks a sender without it — sending the configured permission-message — before
    // this executor is ever called. A common player therefore cannot forge a sale through chat; no
    // duplicate manual check here (which would only risk an inconsistent message).
    ParseResult result = SaleCommandParser.parse(normalizePriceArg(args));

    if (result instanceof ParseResult.Failure failure) {
      sender.sendMessage(ChatColor.RED + failure.message());
      return true;
    }

    ParsedSale sale = ((ParseResult.Success) result).sale();

    // Item-cache guard (S3.1, §1.3): first line of defense, ahead of nick resolution and the
    // S3.2 write-ahead enqueue. See the class javadoc for why an empty/stale cache means "reject"
    // rather than "enqueue anyway" - never auto-create an item (CLAUDE.md business decision).
    if (!itemCache.contains(sale.itemId())) {
      String message =
          "item_id nao cadastrado ou inativo; verifique o catalogo (item_id="
              + sale.itemId()
              + ").";
      plugin.getLogger().warning("Venda rejeitada localmente: " + message);
      sender.sendMessage(ChatColor.RED + message);
      return true;
    }

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

    // Write-ahead (§2.3 of the Sprint 3 spec): persist as pending BEFORE any delivery is even
    // attempted, so a crash between "parsed" and "sent" can never lose the sale. Enqueue and
    // delivery both run off the main thread; the command returns as soon as the enqueue is
    // submitted to the queue's own single-thread executor.
    enqueueThenDeliver(payload);

    if (apiClient == null) {
      plugin
          .getLogger()
          .severe(
              "API nao configurada (api.base-url / api.api-key ausentes): venda "
                  + payload.saleId()
                  + " gravada como pendente na fila local, mas NAO sera enviada automaticamente.");
      sender.sendMessage(
          ChatColor.RED
              + "API nao configurada; venda gravada na fila local (sale_id="
              + payload.saleId()
              + "), nao enviada.");
      return true;
    }

    sender.sendMessage(
        ChatColor.GREEN
            + "Venda registrada para "
            + nickname
            + " (sale_id="
            + payload.saleId()
            + "); envio em andamento.");
    return true;
  }

  /**
   * Write-ahead: submits the enqueue to the SQLite queue's single-thread executor, and only once
   * that write is durable dispatches the HTTP delivery asynchronously, applying the resulting
   * {@link Outcome} back onto the queue row. If the API client is not configured the payload still
   * ends up {@code pending} - nothing is lost, there is simply nothing to dispatch yet.
   */
  private void enqueueThenDeliver(SalePayload payload) {
    saleQueue
        .enqueuePending(payload)
        .whenComplete(
            (ignored, enqueueError) -> {
              if (enqueueError != null) {
                plugin
                    .getLogger()
                    .severe(
                        "Falha ao gravar venda pendente na fila SQLite (sale_id="
                            + payload.saleId()
                            + "): "
                            + enqueueError.getMessage());
                return;
              }
              if (apiClient != null) {
                plugin
                    .getServer()
                    .getScheduler()
                    .runTaskAsynchronously(plugin, () -> attemptDelivery(payload));
              }
            });
  }

  /**
   * Runs the blocking HTTP delivery off the main thread and applies the {@link Outcome} to the
   * queue row: {@code ACK} marks it {@code sent}, {@code PERMANENT} marks it {@code
   * failed_permanent}. {@code TRANSIENT} intentionally does nothing here - the row stays {@code
   * pending} and a future worker (S3.3) retries it with backoff; this history does not loop.
   */
  private void attemptDelivery(SalePayload payload) {
    Outcome outcome = apiClient.deliver(payload);
    switch (outcome) {
      case ACK -> saleQueue.markSent(payload.saleId());
      case PERMANENT -> saleQueue.markFailedPermanent(payload.saleId());
      case TRANSIENT -> {
        // Stays pending; no retry loop in this history.
      }
    }
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
