package de.austv.sales.queue;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import de.austv.sales.api.SalePayload;
import java.io.File;
import java.math.BigDecimal;
import java.time.Duration;
import java.time.Instant;
import java.util.Optional;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.logging.Logger;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * Exercises {@link SaleQueue} against a real temporary SQLite file (sqlite-jdbc is on the test
 * classpath as {@code testImplementation}, see build.gradle.kts - the driver itself is {@code
 * compileOnly} in main, provided by Paper via {@code libraries:} at runtime).
 *
 * <p>Covers the write-ahead contract (§2.3 of the Sprint 3 spec): enqueue persists a pending row
 * with an exact {@code BigDecimal} {@code total_price} (never a floating point {@code REAL}),
 * status transitions on {@code markSent}/{@code markFailedPermanent}/{@code bumpTransient}, and
 * pending rows survive reopening the same on-disk file (a plugin restart).
 */
class SaleQueueTest {

  private File dataFolder;
  private ScheduledExecutorService queueIo;
  private SaleQueue queue;

  @BeforeEach
  void setUp(@TempDir File tempDir) throws Exception {
    dataFolder = tempDir;
    queue = openQueue();
  }

  @AfterEach
  void tearDown() {
    shutdownExecutor();
  }

  private SaleQueue openQueue() throws Exception {
    queueIo = Executors.newSingleThreadScheduledExecutor();
    SaleQueue newQueue = new SaleQueue(dataFolder, queueIo, Logger.getLogger("SaleQueueTest"));
    await(newQueue.open());
    return newQueue;
  }

  private void shutdownExecutor() {
    queueIo.shutdown();
    try {
      queueIo.awaitTermination(5, TimeUnit.SECONDS);
    } catch (InterruptedException e) {
      Thread.currentThread().interrupt();
    }
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

  @Test
  @DisplayName("enqueue grava pending com total_price exato (BigDecimal string, nunca REAL)")
  void enqueuePersistsPendingWithExactTotalPrice() throws Exception {
    SalePayload payload = payload(new BigDecimal("199.999"));

    await(queue.enqueuePending(payload));

    SaleQueue.Row row = await(queue.find(payload.saleId())).orElseThrow();
    assertEquals("pending", row.status());
    assertEquals("199.999", row.totalPrice());
    assertEquals(payload.itemId(), row.itemId());
    assertEquals(payload.playerUuid().toString(), row.playerUuid());
    assertEquals(payload.nicknameAtPurchase(), row.nicknameAtPurchase());
    assertEquals(payload.qtd(), row.qtd());
    assertEquals(0, row.attempts());
  }

  @Test
  @DisplayName("enqueue e idempotente no mesmo sale_id (double-submit nao duplica nem falha)")
  void enqueueIsIdempotentOnSaleId() throws Exception {
    SalePayload payload = payload(new BigDecimal("10.00"));

    await(queue.enqueuePending(payload));
    await(queue.enqueuePending(payload));

    Optional<SaleQueue.Row> row = await(queue.find(payload.saleId()));
    assertTrue(row.isPresent());
    assertEquals("pending", row.get().status());
  }

  @Test
  @DisplayName("markSent transiciona pending -> sent")
  void markSentTransitionsStatus() throws Exception {
    SalePayload payload = payload(new BigDecimal("50.00"));
    await(queue.enqueuePending(payload));

    await(queue.markSent(payload.saleId()));

    assertEquals("sent", await(queue.find(payload.saleId())).orElseThrow().status());
  }

  @Test
  @DisplayName("markFailedPermanent transiciona pending -> failed_permanent")
  void markFailedPermanentTransitionsStatus() throws Exception {
    SalePayload payload = payload(new BigDecimal("50.00"));
    await(queue.enqueuePending(payload));

    await(queue.markFailedPermanent(payload.saleId()));

    assertEquals(
        "failed_permanent", await(queue.find(payload.saleId())).orElseThrow().status());
  }

  @Test
  @DisplayName("bumpTransient incrementa attempts, mantem pending, e grava next_attempt_at")
  void bumpTransientIncrementsAttemptsAndStaysPending() throws Exception {
    SalePayload payload = payload(new BigDecimal("50.00"));
    await(queue.enqueuePending(payload));

    Instant nextAttempt = Instant.parse("2026-07-17T10:05:00Z");
    await(queue.bumpTransient(payload.saleId(), nextAttempt));
    await(queue.bumpTransient(payload.saleId(), nextAttempt));

    SaleQueue.Row row = await(queue.find(payload.saleId())).orElseThrow();
    assertEquals("pending", row.status());
    assertEquals(2, row.attempts());
    assertEquals(nextAttempt.toString(), row.nextAttemptAt());
  }

  @Test
  @DisplayName("reabrir o mesmo arquivo apos 'restart' preserva as linhas pending")
  void reopeningSameFilePreservesPendingRows() throws Exception {
    SalePayload payload = payload(new BigDecimal("77.77"));
    await(queue.enqueuePending(payload));

    // Simulates a plugin restart: close this connection/executor, then open a fresh SaleQueue
    // against the same on-disk file.
    queue.close();
    shutdownExecutor();

    queue = openQueue();

    SaleQueue.Row row = await(queue.find(payload.saleId())).orElseThrow();
    assertEquals("pending", row.status());
    assertEquals("77.77", row.totalPrice());
  }

  @Test
  @DisplayName("cleanupTerminal remove sent/failed_permanent antigos, mas preserva pending")
  void cleanupTerminalRemovesOldTerminalRowsOnly() throws Exception {
    SalePayload sentPayload = payload(new BigDecimal("1.00"));
    SalePayload pendingPayload = payload(new BigDecimal("2.00"));
    await(queue.enqueuePending(sentPayload));
    await(queue.enqueuePending(pendingPayload));
    await(queue.markSent(sentPayload.saleId()));

    // Negative retention pushes the cutoff slightly into the future, so both rows (created a
    // moment ago) are unambiguously "older than retention" without racing the clock.
    int deleted = await(queue.cleanupTerminal(Duration.ofSeconds(-1)));

    assertEquals(1, deleted);
    assertTrue(await(queue.find(sentPayload.saleId())).isEmpty());
    assertTrue(await(queue.find(pendingPayload.saleId())).isPresent());
  }
}
