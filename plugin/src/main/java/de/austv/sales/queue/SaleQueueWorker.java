package de.austv.sales.queue;

import de.austv.sales.api.SaleDelivery.Outcome;
import de.austv.sales.api.SalePayload;
import java.math.BigDecimal;
import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.logging.Level;
import java.util.logging.Logger;

/**
 * S3.3 periodic retry worker for the {@link SaleQueue} SQLite fallback: finds every {@code
 * pending} row that is due, replays it through a {@link SaleDeliverer}, and applies the resulting
 * {@link Outcome} back onto the row.
 *
 * <p><b>Why a dedicated thread, not {@code queue-io} (deadlock risk not covered by the spec):</b>
 * {@code .specs/features/sprint-03-resilience/spec.md} §3.1 suggests running this worker "on the
 * same single-thread {@code queue-io} executor". Taken literally that deadlocks: every {@link
 * SaleQueue} method is {@link java.util.concurrent.CompletableFuture}-based and submits its SQL
 * action to {@code queue-io}, completing the future only once that submitted action actually runs
 * on that thread. If this worker's {@link #run()} itself executed ON {@code queue-io} and then
 * blocked with {@code .get()} on one of those futures (as it must, to read the batch and apply
 * outcomes sequentially), it would be waiting for a task that can only ever run on the very thread
 * it is currently occupying - a permanent self-deadlock, not a transient stall.
 *
 * <p>The fix that preserves the spec's actual guarantees: this class is plain {@link Runnable},
 * free of any {@code queue-io} affinity. The plugin schedules it on its own, separate,
 * single-thread {@link java.util.concurrent.ScheduledExecutorService} (see {@code
 * AusTvSalesPlugin}). From there it freely calls the async {@link SaleQueue} methods and blocks on
 * their futures - the actual SQLite reads/writes still only ever happen, serialized, on {@code
 * queue-io}, so the "one thread owns all SQLite I/O" property from §2.4 of the spec is intact;
 * only the worker's own control flow moved to a second thread.
 *
 * <p><b>Single-flight:</b> the spec's "no overlapping cycles" guarantee came for free from running
 * on a single-thread executor. Since the worker's own scheduling thread is now separate from {@code
 * queue-io}, that property is reproduced explicitly with an {@link AtomicBoolean} guard: if a cycle
 * is still in flight when the next tick fires (e.g. a slow API or a large backlog), {@link #run()}
 * skips that tick outright rather than starting a second, overlapping cycle.
 *
 * <p>Delivery is injected as {@link SaleDeliverer} rather than a concrete {@code SaleApiClient} so
 * this class can be unit-tested (real SQLite via a temp file, fake delivery) with no Bukkit/server
 * dependency at all; production wiring passes {@code apiClient::deliver}.
 */
public final class SaleQueueWorker implements Runnable {

  /** Base delay (seconds) before the first retry of a transient failure. */
  static final long DEFAULT_BASE_BACKOFF_SECONDS = 5;

  private static final int DEFAULT_BATCH_LIMIT = 50;

  /**
   * Ceiling on how long the worker waits for any single {@link SaleQueue} future before giving up
   * on the whole cycle. A stuck {@code queue-io} thread must never hang this worker's own thread
   * forever - the next scheduled tick will simply try again.
   */
  private static final Duration IO_TIMEOUT = Duration.ofSeconds(15);

  /** Delivers a payload and reports the outcome. Production wiring: {@code apiClient::deliver}. */
  @FunctionalInterface
  public interface SaleDeliverer {
    Outcome deliver(SalePayload payload);
  }

  private final SaleQueue saleQueue;
  private final SaleDeliverer deliverer;
  private final Logger logger;
  private final int batchLimit;
  private final long baseBackoffSeconds;
  private final long maxBackoffSeconds;
  private final Duration retention;
  private final AtomicBoolean running = new AtomicBoolean(false);

  /**
   * @param maxBackoffSeconds cap for {@link #nextBackoff(int, long, long)}, from {@code
   *     queue.max-backoff-seconds}.
   * @param retention how long terminal rows ({@code sent}/{@code failed_permanent}) survive before
   *     {@link SaleQueue#cleanupTerminal(Duration)} deletes them, from {@code
   *     queue.retention-hours}.
   */
  public SaleQueueWorker(
      SaleQueue saleQueue,
      SaleDeliverer deliverer,
      Logger logger,
      long maxBackoffSeconds,
      Duration retention) {
    this(
        saleQueue,
        deliverer,
        logger,
        DEFAULT_BATCH_LIMIT,
        DEFAULT_BASE_BACKOFF_SECONDS,
        maxBackoffSeconds,
        retention);
  }

  /** Full constructor with every knob exposed, mainly so tests can shrink the batch/backoff. */
  SaleQueueWorker(
      SaleQueue saleQueue,
      SaleDeliverer deliverer,
      Logger logger,
      int batchLimit,
      long baseBackoffSeconds,
      long maxBackoffSeconds,
      Duration retention) {
    this.saleQueue = saleQueue;
    this.deliverer = deliverer;
    this.logger = logger;
    this.batchLimit = batchLimit;
    this.baseBackoffSeconds = baseBackoffSeconds;
    this.maxBackoffSeconds = maxBackoffSeconds;
    this.retention = retention;
  }

  @Override
  public void run() {
    if (!running.compareAndSet(false, true)) {
      logger.fine("[queue] Ciclo anterior do worker ainda em andamento; pulando este ciclo.");
      return;
    }
    try {
      runCycle();
    } catch (InterruptedException e) {
      Thread.currentThread().interrupt();
      logger.warning("[queue] Ciclo do worker interrompido; sera retomado no proximo tick.");
    } catch (Exception e) {
      logger.log(Level.SEVERE, "[queue] Falha inesperada no ciclo do worker de reenvio.", e);
    } finally {
      running.set(false);
    }
  }

  private void runCycle() throws Exception {
    List<SaleQueue.Row> due = await(saleQueue.findPendingDue(batchLimit));

    int resent = 0;
    int permanent = 0;
    int stillPending = 0;
    for (SaleQueue.Row row : due) {
      try {
        switch (processRow(row)) {
          case ACK -> resent++;
          case PERMANENT -> permanent++;
          case TRANSIENT -> stillPending++;
        }
      } catch (InterruptedException e) {
        Thread.currentThread().interrupt();
        logger.warning(
            "[queue] Interrompido processando sale_id=" + row.saleId() + "; ciclo abortado.");
        return;
      } catch (Exception e) {
        logger.log(
            Level.SEVERE,
            "[queue] Erro processando sale_id=" + row.saleId() + " no ciclo do worker.",
            e);
      }
    }

    int cleaned = await(saleQueue.cleanupTerminal(retention));
    if (cleaned > 0) {
      logger.fine("[queue] Limpeza removeu " + cleaned + " linha(s) terminal(is) expirada(s).");
    }

    // Metrics per §3.3: only log when there was actual work, so an idle queue never pollutes the
    // log; an empty cycle is `fine`, not `info`.
    if (resent > 0 || permanent > 0 || stillPending > 0) {
      logger.info(
          "[queue] ciclo: "
              + resent
              + " reenviados, "
              + permanent
              + " permanentes, "
              + stillPending
              + " ainda pending");
    } else {
      logger.fine("[queue] ciclo vazio, nada a reenviar.");
    }
  }

  /**
   * Reconstructs the payload, delivers it, and applies the resulting {@link Outcome} to the row.
   */
  private Outcome processRow(SaleQueue.Row row) throws Exception {
    UUID saleId = UUID.fromString(row.saleId());
    SalePayload payload = toPayload(row, saleId);
    Outcome outcome = deliverer.deliver(payload);
    switch (outcome) {
      case ACK -> await(saleQueue.markSent(saleId));
      case PERMANENT -> {
        await(saleQueue.markFailedPermanent(saleId));
        logger.warning(
            "[queue] Venda "
                + saleId
                + " marcada failed_permanent pelo worker de reenvio; nao sera mais reenviada.");
      }
      case TRANSIENT -> {
        long backoffSeconds = nextBackoff(row.attempts(), baseBackoffSeconds, maxBackoffSeconds);
        await(saleQueue.bumpTransient(saleId, Instant.now().plusSeconds(backoffSeconds)));
      }
    }
    return outcome;
  }

  private static SalePayload toPayload(SaleQueue.Row row, UUID saleId) {
    return new SalePayload(
        saleId,
        row.itemId(),
        UUID.fromString(row.playerUuid()),
        row.nicknameAtPurchase(),
        new BigDecimal(row.totalPrice()),
        row.qtd(),
        Instant.parse(row.purchasedAt()));
  }

  private static <T> T await(CompletableFuture<T> future) throws Exception {
    return future.get(IO_TIMEOUT.toSeconds(), TimeUnit.SECONDS);
  }

  /**
   * Pure exponential backoff, capped: {@code min(base * 2^attempts, max)}. Static and side-effect
   * free so it is unit-testable with no SQLite/network fixture at all - just growth and saturation.
   * {@code attempts} below zero is defensively treated as zero.
   */
  static long nextBackoff(int attempts, long baseSeconds, long maxSeconds) {
    int safeAttempts = Math.max(0, attempts);
    // Math.pow on a double never overflows to a Java exception (it saturates to Double.POSITIVE_
    // INFINITY for a large exponent), and Math.min against maxSeconds always brings it back into
    // range before the final narrowing cast - so this stays correct for any attempts count without
    // needing to cap the exponent itself.
    double exponential = baseSeconds * Math.pow(2, safeAttempts);
    return (long) Math.min(exponential, (double) maxSeconds);
  }
}
