package de.austv.sales;

import de.austv.sales.api.ItemSyncClient;
import de.austv.sales.api.SaleApiClient;
import de.austv.sales.api.SaleApiConfig;
import de.austv.sales.cache.ItemCache;
import de.austv.sales.cache.ItemSyncTask;
import de.austv.sales.command.SaleCommandExecutor;
import de.austv.sales.queue.SaleQueue;
import de.austv.sales.update.UpdateChecker;
import java.io.File;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ThreadFactory;
import java.util.concurrent.TimeUnit;
import org.bukkit.plugin.java.JavaPlugin;

public final class AusTvSalesPlugin extends JavaPlugin {

  private static final String QUEUE_IO_THREAD_NAME = "austv-sales-queue-io";
  private static final long QUEUE_IO_SHUTDOWN_TIMEOUT_SECONDS = 5;
  private static final long UPDATE_SHUTDOWN_TIMEOUT_SECONDS_DEFAULT = 20;

  private ScheduledExecutorService queueIo;
  private SaleQueue saleQueue;
  private ItemCache itemCache;

  @Override
  public void onEnable() {
    saveDefaultConfig();

    SaleApiConfig apiConfig = buildApiConfig();
    SaleApiClient apiClient = buildApiClient(apiConfig);

    queueIo = Executors.newSingleThreadScheduledExecutor(queueIoThreadFactory());
    saleQueue = new SaleQueue(getDataFolder(), queueIo, getLogger());
    // The queue must be ready (schema created/migrated) before the first command can enqueue -
    // this is a one-time, short-lived block during boot, same category as saveDefaultConfig().
    // If it fails we fail fast: without a durable queue the write-ahead guarantee is void, so we
    // disable the plugin rather than register a command that would report "recorded" while
    // silently persisting nothing.
    try {
      saleQueue.open().get(10, TimeUnit.SECONDS);
      getLogger().info("Fila de fallback SQLite pronta (sales-queue.db).");
    } catch (Exception e) {
      if (e instanceof InterruptedException) {
        Thread.currentThread().interrupt();
      }
      getLogger()
          .log(
              java.util.logging.Level.SEVERE,
              "Falha ao abrir/migrar a fila de fallback SQLite; desabilitando o plugin para nao "
                  + "aceitar vendas sem persistencia garantida.",
              e);
      getServer().getPluginManager().disablePlugin(this);
      return;
    }

    itemCache = new ItemCache();
    startItemSync(apiConfig);

    var command = getCommand("austv-sales");
    if (command != null) {
      command.setExecutor(new SaleCommandExecutor(this, apiClient, saleQueue, itemCache));
    } else {
      getLogger().severe("Command 'austv-sales' not found in plugin.yml.");
    }

    new UpdateChecker(this).runAsync();

    getLogger().info("AusTvSales enabled.");
  }

  /**
   * Schedules the S3.1 {@link ItemSyncTask} when the API is configured, period = {@code
   * api.sync-interval} minutes (reused as-is - not duplicated as a separate {@code items:} key,
   * per §1.5 of the Sprint 3 spec). When the API is disabled, {@link #itemCache} simply stays
   * empty for the whole session: every {@code /austv-sales} command is then rejected locally by
   * {@link SaleCommandExecutor} (§1.4 of the spec) - severe-logged here so the operator sees the
   * consequence immediately, not just as a stream of per-command warnings later.
   */
  private void startItemSync(SaleApiConfig apiConfig) {
    if (!apiConfig.enabled()) {
      getLogger()
          .severe(
              "Sync do cache de itens desabilitado (API nao configurada): o cache permanece "
                  + "vazio e TODO comando /austv-sales sera rejeitado localmente ate api.base-url "
                  + "/ api.api-key serem configurados.");
      return;
    }

    ItemSyncClient itemSyncClient = new ItemSyncClient(apiConfig, getLogger());
    long syncIntervalMinutes = getConfig().getLong("api.sync-interval", 5);
    ItemSyncTask.schedule(this, itemSyncClient, itemCache, syncIntervalMinutes);
    getLogger()
        .info(
            "Sync do cache de itens agendado (intervalo: "
                + syncIntervalMinutes
                + " min, minimo efetivo 1 min).");
  }

  /** Names the single {@code queue-io} thread for readable thread dumps/logs. */
  private static ThreadFactory queueIoThreadFactory() {
    return runnable -> {
      Thread thread = new Thread(runnable, QUEUE_IO_THREAD_NAME);
      thread.setDaemon(true);
      return thread;
    };
  }

  /** Reads the {@code api:} block from {@code config.yml} into a resolved {@link SaleApiConfig}. */
  private SaleApiConfig buildApiConfig() {
    var config = getConfig();
    return SaleApiConfig.of(
        config.getString("api.base-url", ""),
        config.getString("api.api-key", ""),
        config.getLong("api.timeout-ms", 5000));
  }

  /**
   * Builds the delivery client from an already-resolved {@link SaleApiConfig}. If {@code
   * base-url} or {@code api-key} are missing (or invalid) the config is disabled and the client is
   * skipped (fail-safe): the command still parses and validates, but nothing is sent — and the
   * server keeps running.
   *
   * @return a ready {@link SaleApiClient}, or {@code null} when the API is not configured.
   */
  private SaleApiClient buildApiClient(SaleApiConfig apiConfig) {
    if (!apiConfig.enabled()) {
      getLogger()
          .severe(
              "API de vendas nao configurada (api.base-url / api.api-key ausentes ou base-url "
                  + "invalida em config.yml): envio DESABILITADO. Sem sync de catalogo, o cache de "
                  + "itens fica vazio e todo comando /austv-sales sera rejeitado localmente (ver log "
                  + "do sync abaixo).");
      return null;
    }

    getLogger().info("API de vendas configurada: envio habilitado para " + apiConfig.salesEndpoint() + ".");
    return new SaleApiClient(apiConfig, getLogger());
  }

  @Override
  public void onDisable() {
    stageUpdateBeforeRestart();
    shutdownQueue();
    getLogger().info("AusTvSales disabled.");
  }

  /**
   * Baixa e prepara (na pasta de update) uma eventual versao nova ANTES do servidor reiniciar, de
   * forma que o Paper a aplique ja no proximo boot — assim a nova versao sobe aplicada nesse mesmo
   * restart, sem exigir um segundo reinicio. Bloqueia o shutdown por no maximo {@code
   * auto-update.shutdown-timeout-seconds} (padrao {@value #UPDATE_SHUTDOWN_TIMEOUT_SECONDS_DEFAULT}s)
   * e nunca propaga erro: auto-update e best-effort e jamais deve travar o desligamento.
   */
  private void stageUpdateBeforeRestart() {
    try {
      long timeoutSeconds =
          getConfig()
              .getLong(
                  "auto-update.shutdown-timeout-seconds",
                  UPDATE_SHUTDOWN_TIMEOUT_SECONDS_DEFAULT);
      new UpdateChecker(this).stageOnShutdown(java.time.Duration.ofSeconds(timeoutSeconds));
    } catch (Exception e) {
      getLogger()
          .log(
              java.util.logging.Level.WARNING,
              "Falha ao preparar atualizacao no shutdown.",
              e);
    }
  }

  /**
   * Stops accepting new {@code queue-io} work, waits briefly for the in-flight task (if any) to
   * finish, and only then closes the SQLite connection - closing it while a task is still running
   * on {@code queue-io} would fail that task mid-write.
   */
  private void shutdownQueue() {
    if (queueIo != null) {
      queueIo.shutdown();
      try {
        if (!queueIo.awaitTermination(QUEUE_IO_SHUTDOWN_TIMEOUT_SECONDS, TimeUnit.SECONDS)) {
          getLogger().warning("queue-io nao encerrou a tempo; forcando shutdown.");
          queueIo.shutdownNow();
        }
      } catch (InterruptedException e) {
        Thread.currentThread().interrupt();
        queueIo.shutdownNow();
      }
    }
    if (saleQueue != null) {
      saleQueue.close();
    }
  }

  /**
   * Expoe o jar deste plugin para o {@link UpdateChecker} nomear o download com o mesmo nome de
   * arquivo, condicao para o Paper aplicar o update no proximo restart. {@code getFile()} e
   * protegido em {@link JavaPlugin}, dai o acessor publico.
   */
  public File getPluginFile() {
    return getFile();
  }
}
