package de.austv.sales;

import de.austv.sales.api.ItemSyncClient;
import de.austv.sales.api.SaleApiClient;
import de.austv.sales.api.SaleApiConfig;
import de.austv.sales.cache.ItemCache;
import de.austv.sales.cache.ItemSyncTask;
import de.austv.sales.command.SaleCommandExecutor;
import de.austv.sales.command.SaleCommandTabCompleter;
import de.austv.sales.queue.SaleQueue;
import de.austv.sales.queue.SaleQueueWorker;
import de.austv.sales.update.UpdateChecker;
import java.io.File;
import java.time.Duration;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ThreadFactory;
import java.util.concurrent.TimeUnit;
import org.bukkit.plugin.java.JavaPlugin;

public final class AusTvSalesPlugin extends JavaPlugin {

  private static final String QUEUE_IO_THREAD_NAME = "austv-sales-queue-io";
  private static final String QUEUE_WORKER_THREAD_NAME = "austv-sales-queue-worker";
  private static final long QUEUE_IO_SHUTDOWN_TIMEOUT_SECONDS = 5;
  private static final long QUEUE_WORKER_SHUTDOWN_TIMEOUT_SECONDS = 5;
  private static final long UPDATE_SHUTDOWN_TIMEOUT_SECONDS_DEFAULT = 20;

  private ScheduledExecutorService queueIo;
  private ScheduledExecutorService queueWorkerIo;
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
    startQueueWorker(apiClient);

    var command = getCommand("austv-sales");
    if (command != null) {
      command.setExecutor(new SaleCommandExecutor(this, apiClient, saleQueue, itemCache));
      command.setTabCompleter(new SaleCommandTabCompleter(this, itemCache));
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

  /**
   * Schedules the S3.3 {@link SaleQueueWorker} on its own, separate single-thread executor - never
   * on {@link #queueIo} itself. See {@link SaleQueueWorker}'s class javadoc for why: the worker
   * blocks on {@link SaleQueue}'s {@code CompletableFuture}s, and running it ON {@code queue-io}
   * would deadlock (waiting on a future that can only complete on the very thread it occupies).
   *
   * <p>Only scheduled when {@code apiClient != null} (consistent with the S3.1 sync guard): with
   * no configured API there is nowhere to (re)deliver to, so a worker would just spin reading
   * {@code pending} rows it can never advance.
   */
  private void startQueueWorker(SaleApiClient apiClient) {
    if (apiClient == null) {
      getLogger()
          .warning(
              "Worker de reenvio da fila NAO agendado (API nao configurada): vendas ficarao "
                  + "pendentes na fila local ate api.base-url / api.api-key serem configurados e o "
                  + "plugin ser reiniciado.");
      return;
    }

    var config = getConfig();
    long workerIntervalSeconds = Math.max(1, config.getLong("queue.worker-interval-seconds", 30));
    long maxBackoffSeconds = Math.max(1, config.getLong("queue.max-backoff-seconds", 300));
    long retentionHours = Math.max(1, config.getLong("queue.retention-hours", 168));

    SaleQueueWorker worker =
        new SaleQueueWorker(
            saleQueue,
            apiClient::deliver,
            getLogger(),
            maxBackoffSeconds,
            Duration.ofHours(retentionHours));

    queueWorkerIo = Executors.newSingleThreadScheduledExecutor(queueWorkerThreadFactory());
    // Initial delay 0: a restart's leftover `pending` rows (survival, §3.2) are reprocessed by the
    // very first cycle rather than waiting a full interval.
    queueWorkerIo.scheduleAtFixedRate(worker, 0, workerIntervalSeconds, TimeUnit.SECONDS);
    getLogger()
        .info(
            "Worker de reenvio da fila agendado (intervalo: "
                + workerIntervalSeconds
                + "s, max-backoff: "
                + maxBackoffSeconds
                + "s, retencao: "
                + retentionHours
                + "h).");
  }

  /** Names the single {@code queue-io} thread for readable thread dumps/logs. */
  private static ThreadFactory queueIoThreadFactory() {
    return runnable -> {
      Thread thread = new Thread(runnable, QUEUE_IO_THREAD_NAME);
      thread.setDaemon(true);
      return thread;
    };
  }

  /** Names the single {@code queue-worker} thread for readable thread dumps/logs. */
  private static ThreadFactory queueWorkerThreadFactory() {
    return runnable -> {
      Thread thread = new Thread(runnable, QUEUE_WORKER_THREAD_NAME);
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
   * Shuts down, in order: the queue worker first, then {@code queue-io}, then the SQLite
   * connection. The worker MUST stop before {@code queue-io} does - it is mid-cycle calling
   * {@code .get()} on {@code queue-io} futures, and shutting {@code queue-io} down first would cut
   * an in-flight delivery/status-update off mid-write. Only once both executors have drained is it
   * safe to close the connection - closing it while either still has a task running would fail
   * that task.
   */
  private void shutdownQueue() {
    shutdownExecutor(queueWorkerIo, QUEUE_WORKER_SHUTDOWN_TIMEOUT_SECONDS, "queue-worker");
    shutdownExecutor(queueIo, QUEUE_IO_SHUTDOWN_TIMEOUT_SECONDS, "queue-io");
    if (saleQueue != null) {
      saleQueue.close();
    }
  }

  /**
   * Stops accepting new work on {@code executor}, waits briefly for any in-flight task to finish,
   * and forces a shutdown if it does not drain in time. Shared by both the {@code queue-io} and
   * {@code queue-worker} executors so their shutdown ordering (see {@link #shutdownQueue()}) stays
   * a matter of call order, not duplicated logic.
   */
  private void shutdownExecutor(
      ScheduledExecutorService executor, long timeoutSeconds, String name) {
    if (executor == null) {
      return;
    }
    executor.shutdown();
    try {
      if (!executor.awaitTermination(timeoutSeconds, TimeUnit.SECONDS)) {
        getLogger().warning(name + " nao encerrou a tempo; forcando shutdown.");
        executor.shutdownNow();
        // Await again after shutdownNow: shutdownQueue() closes the SQLite connection right after
        // this returns, and SaleQueue.close() requires the executor to have fully drained. Return
        // only once the thread actually stopped - or log loud if it still refuses to, since then a
        // close could race an in-flight write.
        if (!executor.awaitTermination(timeoutSeconds, TimeUnit.SECONDS)) {
          getLogger()
              .severe(
                  name
                      + " nao encerrou nem apos shutdownNow; a conexao SQLite pode ser fechada com "
                      + "uma escrita em curso.");
        }
      }
    } catch (InterruptedException e) {
      Thread.currentThread().interrupt();
      executor.shutdownNow();
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
