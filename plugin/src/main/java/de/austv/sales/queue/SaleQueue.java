package de.austv.sales.queue;

import de.austv.sales.api.SalePayload;
import java.io.File;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;
import java.time.Duration;
import java.time.Instant;
import java.time.format.DateTimeFormatter;
import java.time.format.DateTimeFormatterBuilder;
import java.util.Optional;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ScheduledExecutorService;
import java.util.logging.Level;
import java.util.logging.Logger;

/**
 * SQLite-backed fallback queue for sale events (S3.2), implementing the write-ahead strategy
 * approved in {@code .specs/features/sprint-03-resilience/spec.md} §2.3: every sale is persisted
 * as {@code pending} BEFORE an API delivery is attempted, so a crash mid-send never loses a sale -
 * the worst case is a duplicate send, which the backend's {@code sale_id} idempotency absorbs.
 *
 * <p>All JDBC I/O (open, enqueue, status updates, cleanup) runs on a single-thread {@code
 * queue-io} {@link ScheduledExecutorService} owned by the caller ({@link
 * de.austv.sales.AusTvSalesPlugin}) and passed in here. Serializing every write through one thread
 * removes the need for explicit locking and avoids {@code SQLITE_BUSY} under concurrent access;
 * WAL mode still allows concurrent readers if that is ever needed. Every public method returns
 * immediately with a {@link CompletableFuture} - callers (the main thread included) never block on
 * SQLite I/O.
 */
public final class SaleQueue {

  /** Row is freshly enqueued, not yet acknowledged by the API. */
  public static final String STATUS_PENDING = "pending";

  /** Row was accepted by the API (2xx ACK); terminal. */
  public static final String STATUS_SENT = "sent";

  /** Row was rejected by the API in a way retrying cannot fix (4xx); terminal. */
  public static final String STATUS_FAILED_PERMANENT = "failed_permanent";

  private static final String TABLE_DDL =
      "CREATE TABLE IF NOT EXISTS sale_queue ("
          + "sale_id TEXT PRIMARY KEY,"
          + "item_id TEXT NOT NULL,"
          + "player_uuid TEXT NOT NULL,"
          + "nickname_at_purchase TEXT NOT NULL,"
          + "total_price TEXT NOT NULL,"
          + "qtd INTEGER NOT NULL,"
          + "purchased_at TEXT NOT NULL,"
          + "status TEXT NOT NULL DEFAULT 'pending',"
          + "attempts INTEGER NOT NULL DEFAULT 0,"
          + "created_at TEXT NOT NULL,"
          + "last_attempt_at TEXT,"
          + "next_attempt_at TEXT"
          + ")";

  private static final String INDEX_DDL =
      "CREATE INDEX IF NOT EXISTS idx_sale_queue_status ON sale_queue(status, next_attempt_at)";

  /**
   * Fixed-width instant format for every stored/compared timestamp. {@link Instant#toString()} uses
   * variable fractional precision (e.g. {@code .9Z} vs {@code .10Z}), so SQLite's lexicographic TEXT
   * comparison would not match chronological order - breaking {@code cleanupTerminal}'s {@code
   * created_at < cutoff} and the S3.3 worker's {@code ORDER BY created_at} / {@code next_attempt_at
   * <= now}. Always emitting 3 fractional digits ({@code appendInstant(3)}) makes the strings
   * fixed-width, so lexicographic order equals time order.
   */
  private static final DateTimeFormatter TIMESTAMP_FORMAT =
      new DateTimeFormatterBuilder().appendInstant(3).toFormatter();

  private final ScheduledExecutorService queueIo;
  private final Logger logger;
  private final String jdbcUrl;

  /** Only ever touched from the {@code queue-io} thread - never read/written from elsewhere. */
  private Connection connection;

  public SaleQueue(File dataFolder, ScheduledExecutorService queueIo, Logger logger) {
    this.queueIo = queueIo;
    this.logger = logger;
    this.jdbcUrl = "jdbc:sqlite:" + new File(dataFolder, "sales-queue.db").getAbsolutePath();
  }

  /**
   * Opens the SQLite connection, switches on WAL + a busy timeout, and creates the schema if it
   * does not exist yet. Meant to be awaited once during {@code onEnable} (the plugin should not
   * accept commands before the queue is ready), so the returned future is expected to be joined
   * on the caller side rather than left fire-and-forget.
   */
  public CompletableFuture<Void> open() {
    return runIo(
        "open",
        () -> {
          connection = DriverManager.getConnection(jdbcUrl);
          try (Statement statement = connection.createStatement()) {
            statement.execute("PRAGMA journal_mode=WAL");
            statement.execute("PRAGMA busy_timeout=5000");
            statement.execute(TABLE_DDL);
            statement.execute(INDEX_DDL);
          }
        });
  }

  /**
   * Write-ahead insert: persists the payload as {@code pending} before any delivery attempt.
   * Idempotent on {@code sale_id} (the executor always generates a fresh UUID, but a retried
   * enqueue - e.g. a double-submit - must not fail or duplicate the row).
   *
   * <p>{@code total_price} is stored via {@link java.math.BigDecimal#toPlainString()}, never as a
   * SQLite {@code REAL}, so the decimal value is never subject to floating point rounding.
   */
  public CompletableFuture<Void> enqueuePending(SalePayload payload) {
    return runIo(
        "enqueue sale_id=" + payload.saleId(),
        () -> {
          String sql =
              "INSERT INTO sale_queue (sale_id, item_id, player_uuid, nickname_at_purchase, "
                  + "total_price, qtd, purchased_at, status, attempts, created_at) "
                  + "VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?) "
                  + "ON CONFLICT(sale_id) DO NOTHING";
          try (PreparedStatement statement = connection.prepareStatement(sql)) {
            statement.setString(1, payload.saleId().toString());
            statement.setString(2, payload.itemId());
            statement.setString(3, payload.playerUuid().toString());
            statement.setString(4, payload.nicknameAtPurchase());
            statement.setString(5, payload.totalPrice().toPlainString());
            statement.setInt(6, payload.qtd());
            // purchased_at keeps Instant#toString() for an exact round-trip when the S3.3 worker
            // reconstructs and re-sends the payload - it is payload data, never a sort/compare key.
            statement.setString(7, payload.purchasedAt().toString());
            statement.setString(8, formatTimestamp(Instant.now()));
            statement.executeUpdate();
          }
        });
  }

  /** Marks a row {@code sent} after a 2xx ACK from the API. Terminal - the worker stops here. */
  public CompletableFuture<Void> markSent(UUID saleId) {
    return updateStatus(saleId, STATUS_SENT);
  }

  /** Marks a row {@code failed_permanent} after a 4xx from the API. Terminal - never retried. */
  public CompletableFuture<Void> markFailedPermanent(UUID saleId) {
    return updateStatus(saleId, STATUS_FAILED_PERMANENT);
  }

  private CompletableFuture<Void> updateStatus(UUID saleId, String status) {
    return runIo(
        "mark " + status + " sale_id=" + saleId,
        () -> {
          String sql = "UPDATE sale_queue SET status = ?, last_attempt_at = ? WHERE sale_id = ?";
          try (PreparedStatement statement = connection.prepareStatement(sql)) {
            statement.setString(1, status);
            statement.setString(2, formatTimestamp(Instant.now()));
            statement.setString(3, saleId.toString());
            statement.executeUpdate();
          }
        });
  }

  /**
   * Records a transient-failure attempt: bumps {@code attempts}, stamps {@code last_attempt_at},
   * and schedules {@code next_attempt_at} for a future retry. The row stays {@code pending} - only
   * the S3.3 worker acts on {@code next_attempt_at}; this history is prepared so that worker has
   * nothing left to add to the schema.
   */
  public CompletableFuture<Void> bumpTransient(UUID saleId, Instant nextAttemptAt) {
    return runIo(
        "bump transient sale_id=" + saleId,
        () -> {
          String sql =
              "UPDATE sale_queue SET attempts = attempts + 1, last_attempt_at = ?, "
                  + "next_attempt_at = ? WHERE sale_id = ?";
          try (PreparedStatement statement = connection.prepareStatement(sql)) {
            statement.setString(1, formatTimestamp(Instant.now()));
            statement.setString(2, formatTimestamp(nextAttemptAt));
            statement.setString(3, saleId.toString());
            statement.executeUpdate();
          }
        });
  }

  /**
   * Looks up a single row by {@code sale_id}. Mainly a testing/inspection hook today; the S3.3
   * worker will add its own batch {@code SELECT} for the retry loop.
   */
  public CompletableFuture<Optional<Row>> find(UUID saleId) {
    CompletableFuture<Optional<Row>> future = new CompletableFuture<>();
    queueIo.execute(
        () -> {
          String sql = "SELECT * FROM sale_queue WHERE sale_id = ?";
          try (PreparedStatement statement = connection.prepareStatement(sql)) {
            statement.setString(1, saleId.toString());
            try (ResultSet resultSet = statement.executeQuery()) {
              future.complete(resultSet.next() ? Optional.of(mapRow(resultSet)) : Optional.empty());
            }
          } catch (Exception e) {
            logSevere("find sale_id=" + saleId, e);
            future.completeExceptionally(e);
          }
        });
    return future;
  }

  /**
   * Deletes terminal rows ({@code sent} / {@code failed_permanent}) older than {@code retention},
   * keeping the queue from growing without bound (§2.5). Ready for the S3.3 worker to call once
   * per cycle; this history does not schedule it - S3.2 only wires the schema and the method.
   *
   * @return a future with the number of deleted rows.
   */
  public CompletableFuture<Integer> cleanupTerminal(Duration retention) {
    CompletableFuture<Integer> future = new CompletableFuture<>();
    queueIo.execute(
        () -> {
          String sql =
              "DELETE FROM sale_queue WHERE status IN ('sent', 'failed_permanent') "
                  + "AND created_at < ?";
          try (PreparedStatement statement = connection.prepareStatement(sql)) {
            statement.setString(1, formatTimestamp(Instant.now().minus(retention)));
            future.complete(statement.executeUpdate());
          } catch (Exception e) {
            logSevere("cleanup terminal rows", e);
            future.completeExceptionally(e);
          }
        });
    return future;
  }

  /**
   * Closes the underlying JDBC connection. MUST be called only after the {@code queue-io}
   * executor has been shut down and drained (see {@code AusTvSalesPlugin#onDisable}) - closing the
   * connection while a queued task is still running on {@code queue-io} would fail that task.
   */
  public void close() {
    if (connection == null) {
      return;
    }
    try {
      connection.close();
    } catch (SQLException e) {
      logger.warning("[queue] Falha ao fechar conexao SQLite: " + e.getMessage());
    }
  }

  private static Row mapRow(ResultSet resultSet) throws SQLException {
    return new Row(
        resultSet.getString("sale_id"),
        resultSet.getString("item_id"),
        resultSet.getString("player_uuid"),
        resultSet.getString("nickname_at_purchase"),
        resultSet.getString("total_price"),
        resultSet.getInt("qtd"),
        resultSet.getString("purchased_at"),
        resultSet.getString("status"),
        resultSet.getInt("attempts"),
        resultSet.getString("created_at"),
        resultSet.getString("last_attempt_at"),
        resultSet.getString("next_attempt_at"));
  }

  /**
   * Submits a write-only SQL action to {@code queue-io} and completes the future when it runs.
   * Catches every exception (not just {@link SQLException}): a {@code null} connection, an NPE or any
   * runtime failure must still complete the future exceptionally and be logged, never leave a caller
   * hanging or let the single {@code queue-io} thread die silently on an uncaught throwable.
   */
  private CompletableFuture<Void> runIo(String opName, SqlAction action) {
    CompletableFuture<Void> future = new CompletableFuture<>();
    queueIo.execute(
        () -> {
          try {
            action.run();
            future.complete(null);
          } catch (Exception e) {
            logSevere(opName, e);
            future.completeExceptionally(e);
          }
        });
    return future;
  }

  /** Failure of last-resort per §2.4: SQLite I/O errors are logged loud and clear, with the trace. */
  private void logSevere(String opName, Exception e) {
    logger.log(Level.SEVERE, "[queue] Falha de I/O no SQLite (" + opName + ")", e);
  }

  /** Fixed-width instant string for storage/comparison; {@code null} maps to {@code null}. */
  private static String formatTimestamp(Instant instant) {
    return instant == null ? null : TIMESTAMP_FORMAT.format(instant);
  }

  @FunctionalInterface
  private interface SqlAction {
    void run() throws SQLException;
  }

  /** Snapshot of a {@code sale_queue} row, exposed as raw TEXT columns (no reparsing). */
  public record Row(
      String saleId,
      String itemId,
      String playerUuid,
      String nicknameAtPurchase,
      String totalPrice,
      int qtd,
      String purchasedAt,
      String status,
      int attempts,
      String createdAt,
      String lastAttemptAt,
      String nextAttemptAt) {}
}
