package de.austv.sales.queue;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import de.austv.sales.api.SaleDelivery.Outcome;
import de.austv.sales.api.SalePayload;
import java.io.File;
import java.math.BigDecimal;
import java.time.Duration;
import java.time.Instant;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.logging.Logger;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * Exercises {@link SaleQueueWorker} against a real temporary SQLite-backed {@link SaleQueue}
 * (same fixture style as {@link SaleQueueTest}) with a fake {@link
 * SaleQueueWorker.SaleDeliverer} standing in for {@code SaleApiClient} - no Bukkit, no server,
 * no real network needed to cover the S3.3 retry/backoff/single-flight contract.
 */
class SaleQueueWorkerTest {

  private File dataFolder;
  private ScheduledExecutorService queueIo;
  private SaleQueue queue;

  @BeforeEach
  void setUp(@TempDir File tempDir) throws Exception {
    dataFolder = tempDir;
    queueIo = Executors.newSingleThreadScheduledExecutor();
    queue = new SaleQueue(dataFolder, queueIo, Logger.getLogger("SaleQueueWorkerTest"));
    await(queue.open());
  }

  @AfterEach
  void tearDown() {
    queueIo.shutdown();
    try {
      if (!queueIo.awaitTermination(5, TimeUnit.SECONDS)) {
        queueIo.shutdownNow();
      }
    } catch (InterruptedException e) {
      Thread.currentThread().interrupt();
      queueIo.shutdownNow();
    }
    queue.close();
  }

  private static <T> T await(CompletableFuture<T> future) throws Exception {
    return future.get(5, TimeUnit.SECONDS);
  }

  private static SalePayload payload(BigDecimal totalPrice) {
    return new SalePayload(
        UUID.randomUUID(),
        "caixaNatal2026",
        UUID.randomUUID(),
        "Murilo",
        totalPrice,
        2,
        Instant.parse("2026-07-17T10:00:00Z"));
  }

  private SaleQueueWorker newWorker(SaleQueueWorker.SaleDeliverer deliverer) {
    return new SaleQueueWorker(
        queue, deliverer, Logger.getLogger("SaleQueueWorkerTest"), 300, Duration.ofHours(168));
  }

  private SaleQueueWorker newWorker(
      SaleQueueWorker.SaleDeliverer deliverer,
      int batchLimit,
      long baseBackoffSeconds,
      long maxBackoffSeconds,
      Duration retention) {
    return new SaleQueueWorker(
        queue,
        deliverer,
        Logger.getLogger("SaleQueueWorkerTest"),
        batchLimit,
        baseBackoffSeconds,
        maxBackoffSeconds,
        retention);
  }

  // --- nextBackoff: pure, no fixture needed -------------------------------------------------

  @Test
  @DisplayName("nextBackoff cresce exponencialmente e satura no teto configurado")
  void nextBackoffGrowsExponentiallyThenSaturates() {
    assertEquals(5, SaleQueueWorker.nextBackoff(0, 5, 300));
    assertEquals(10, SaleQueueWorker.nextBackoff(1, 5, 300));
    assertEquals(20, SaleQueueWorker.nextBackoff(2, 5, 300));
    assertEquals(40, SaleQueueWorker.nextBackoff(3, 5, 300));
    // 5 * 2^6 = 320 > 300 -> capped at the ceiling.
    assertEquals(300, SaleQueueWorker.nextBackoff(6, 5, 300));
    // A very large attempts count must stay capped, never overflow/throw.
    assertEquals(300, SaleQueueWorker.nextBackoff(1_000, 5, 300));
  }

  @Test
  @DisplayName("nextBackoff trata attempts negativo como zero (defensivo)")
  void nextBackoffTreatsNegativeAttemptsAsZero() {
    assertEquals(5, SaleQueueWorker.nextBackoff(-3, 5, 300));
  }

  // --- run() outcome handling ----------------------------------------------------------------

  @Test
  @DisplayName("ACK marca a linha sent")
  void ackMarksRowSent() throws Exception {
    SalePayload payload = payload(new BigDecimal("50.00"));
    await(queue.enqueuePending(payload));

    newWorker(p -> Outcome.ACK).run();

    assertEquals("sent", await(queue.find(payload.saleId())).orElseThrow().status());
  }

  @Test
  @DisplayName("PERMANENT marca a linha failed_permanent e nao a deixa pending")
  void permanentMarksRowFailedPermanent() throws Exception {
    SalePayload payload = payload(new BigDecimal("50.00"));
    await(queue.enqueuePending(payload));

    newWorker(p -> Outcome.PERMANENT).run();

    assertEquals(
        "failed_permanent", await(queue.find(payload.saleId())).orElseThrow().status());
  }

  @Test
  @DisplayName("TRANSIENT mantem pending, incrementa attempts e agenda next_attempt_at com backoff")
  void transientKeepsPendingAndSchedulesBackoff() throws Exception {
    SalePayload payload = payload(new BigDecimal("50.00"));
    await(queue.enqueuePending(payload));

    Instant before = Instant.now();
    // base backoff = 1s so the test does not need to wait long / tolerate a large window.
    newWorker(p -> Outcome.TRANSIENT, 50, 1, 300, Duration.ofHours(168)).run();

    SaleQueue.Row row = await(queue.find(payload.saleId())).orElseThrow();
    assertEquals("pending", row.status());
    assertEquals(1, row.attempts());
    Instant nextAttemptAt = Instant.parse(row.nextAttemptAt());
    assertTrue(nextAttemptAt.isAfter(before));
    // Generous upper bound (base backoff was 1s) - just confirms it did not jump to the max.
    assertTrue(nextAttemptAt.isBefore(before.plusSeconds(30)));
  }

  @Test
  @DisplayName("uma linha TRANSIENT nao interrompe o processamento das demais no mesmo ciclo")
  void oneRowFailingDoesNotBlockTheRestOfTheBatch() throws Exception {
    SalePayload transientPayload = payload(new BigDecimal("1.00"));
    SalePayload ackPayload = payload(new BigDecimal("2.00"));
    await(queue.enqueuePending(transientPayload));
    await(queue.enqueuePending(ackPayload));

    newWorker(p -> p.saleId().equals(transientPayload.saleId()) ? Outcome.TRANSIENT : Outcome.ACK)
        .run();

    assertEquals("pending", await(queue.find(transientPayload.saleId())).orElseThrow().status());
    assertEquals("sent", await(queue.find(ackPayload.saleId())).orElseThrow().status());
  }

  @Test
  @DisplayName("run() tambem executa cleanupTerminal, removendo linhas terminais expiradas")
  void runAlsoCleansUpExpiredTerminalRows() throws Exception {
    SalePayload sentPayload = payload(new BigDecimal("1.00"));
    await(queue.enqueuePending(sentPayload));
    await(queue.markSent(sentPayload.saleId()));

    // Negative retention pushes the cutoff into the future, so the just-created sent row is
    // unambiguously "expired" without racing the clock.
    newWorker(p -> Outcome.ACK, 50, 1, 300, Duration.ofSeconds(-1)).run();

    assertTrue(await(queue.find(sentPayload.saleId())).isEmpty());
  }

  // --- single-flight ---------------------------------------------------------------------------

  @Test
  @DisplayName("run() concorrente e single-flight: um ciclo em andamento faz o outro ser pulado")
  void concurrentRunIsSingleFlight() throws Exception {
    SalePayload payload = payload(new BigDecimal("1.00"));
    await(queue.enqueuePending(payload));

    CountDownLatch deliveryStarted = new CountDownLatch(1);
    CountDownLatch releaseDelivery = new CountDownLatch(1);
    AtomicInteger invocationCount = new AtomicInteger();

    SaleQueueWorker.SaleDeliverer blockingDeliverer =
        p -> {
          invocationCount.incrementAndGet();
          deliveryStarted.countDown();
          try {
            assertTrue(releaseDelivery.await(5, TimeUnit.SECONDS));
          } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
          }
          return Outcome.ACK;
        };
    SaleQueueWorker worker = newWorker(blockingDeliverer);

    Thread firstCycle = new Thread(worker, "first-cycle");
    firstCycle.start();
    assertTrue(deliveryStarted.await(5, TimeUnit.SECONDS));

    // The first cycle is still blocked inside deliver(); this second, concurrent run() must be a
    // no-op (the AtomicBoolean guard skips it) rather than starting an overlapping cycle.
    worker.run();
    assertEquals(1, invocationCount.get());

    releaseDelivery.countDown();
    firstCycle.join(5000);

    assertEquals(1, invocationCount.get());
    assertEquals("sent", await(queue.find(payload.saleId())).orElseThrow().status());
  }

  @Test
  @DisplayName("apos um ciclo terminar, o proximo run() volta a processar normalmente")
  void runProcessesAgainAfterPreviousCycleFinished() throws Exception {
    SalePayload payload = payload(new BigDecimal("1.00"));
    await(queue.enqueuePending(payload));
    SaleQueueWorker worker = newWorker(p -> Outcome.ACK);

    worker.run();
    worker.run();

    assertEquals("sent", await(queue.find(payload.saleId())).orElseThrow().status());
  }
}
