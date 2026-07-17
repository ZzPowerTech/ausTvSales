package de.austv.sales.cache;

import de.austv.sales.api.ItemSyncClient;
import java.util.Optional;
import java.util.Set;
import java.util.logging.Logger;
import org.bukkit.plugin.Plugin;
import org.bukkit.scheduler.BukkitRunnable;

/**
 * Periodic S3.1 refresh of {@link ItemCache} from {@link ItemSyncClient}. Scheduled on {@code
 * onEnable} via {@link BukkitRunnable#runTaskTimerAsynchronously}, so every run - including the
 * first - happens off the main thread; a command fired in the first few milliseconds of boot can
 * see an empty cache and gets rejected (accepted trade-off documented in the spec, §1.4 "nota de
 * corrida").
 */
public final class ItemSyncTask extends BukkitRunnable {

  private static final long TICKS_PER_MINUTE = 20L * 60L;
  private static final long MIN_INTERVAL_MINUTES = 1L;

  private final ItemSyncClient client;
  private final ItemCache cache;
  private final Logger logger;

  ItemSyncTask(ItemSyncClient client, ItemCache cache, Logger logger) {
    this.client = client;
    this.cache = cache;
    this.logger = logger;
  }

  @Override
  public void run() {
    Optional<Set<String>> active = client.fetchActiveItemIds();
    if (active.isPresent()) {
      cache.replaceAll(active.get());
      logger.info("Cache de itens sincronizado: " + active.get().size() + " item(ns) ativo(s).");
    } else {
      cache.markSyncFailed();
      logger.warning(
          "Falha ao sincronizar cache de itens; mantendo o ultimo cache valido ("
              + cache.size()
              + " item(ns)).");
    }
  }

  /**
   * Builds and schedules the task: period = {@code syncIntervalMinutes} (defensive minimum of 1
   * minute), converted to ticks. First run fires immediately (delay {@code 0}) so the cache is
   * populated as early as possible without blocking the main thread for it.
   */
  public static ItemSyncTask schedule(
      Plugin plugin, ItemSyncClient client, ItemCache cache, long syncIntervalMinutes) {
    long minutes = Math.max(MIN_INTERVAL_MINUTES, syncIntervalMinutes);
    long periodTicks = minutes * TICKS_PER_MINUTE;
    ItemSyncTask task = new ItemSyncTask(client, cache, plugin.getLogger());
    task.runTaskTimerAsynchronously(plugin, 0L, periodTicks);
    return task;
  }
}
