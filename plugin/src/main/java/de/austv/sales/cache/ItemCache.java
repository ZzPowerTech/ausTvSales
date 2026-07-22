package de.austv.sales.cache;

import java.time.Instant;
import java.util.Set;

/**
 * Thread-safe local cache of active {@code item_id}s, refreshed periodically by {@code
 * ItemSyncTask} from {@code GET /items/sync} (S3.1).
 *
 * <p>Implementation is copy-on-write: the active set is held in a single {@code volatile}
 * immutable reference, swapped atomically on every successful sync. Reads on the command path
 * ({@link #contains(String)}) never take a lock. The cache starts empty - before the first sync
 * completes (or when the API is not configured at all) every {@code item_id} is treated as
 * unknown, which is the safe default given the business rule "never auto-create an item".
 *
 * <p>{@link #lastSyncOk()} and {@link #lastSyncAt()} are diagnostic only; a failed sync
 * ({@link #markSyncFailed()}) deliberately keeps the previous active set intact rather than
 * clearing it, so a transient API outage does not lock out every command that was working a
 * minute ago.
 */
public final class ItemCache {

  private volatile Set<String> activeItemIds = Set.of();
  private volatile boolean lastSyncOk;
  private volatile Instant lastSyncAt;

  /** True when {@code itemId} is in the last successfully synced active set. */
  public boolean contains(String itemId) {
    return itemId != null && activeItemIds.contains(itemId);
  }

  /**
   * The last successfully synced active set, for callers that need to enumerate rather than test a
   * single id (tab completion). Always immutable - both {@code Set.of()} and {@code Set.copyOf} in
   * {@link #replaceAll(Set)} produce unmodifiable sets - so no defensive copy is needed here, and
   * the read is a single lock-free volatile access on the command path.
   */
  public Set<String> activeItemIds() {
    return activeItemIds;
  }

  /**
   * Atomically replaces the active set after a successful sync. Defensively copies {@code active}
   * into an immutable {@link Set} so the caller's mutable collection (if any) can't leak into the
   * cache and be mutated after the fact.
   */
  public void replaceAll(Set<String> active) {
    activeItemIds = Set.copyOf(active);
    lastSyncOk = true;
    lastSyncAt = Instant.now();
  }

  /**
   * Records a failed sync attempt (network error, timeout, non-2xx, malformed response). The
   * previous active set is intentionally left untouched - per §1.4 of the Sprint 3 spec, a sync
   * failure must never zero out an otherwise-good cache.
   */
  public void markSyncFailed() {
    lastSyncOk = false;
    lastSyncAt = Instant.now();
  }

  /** Diagnostic: whether the most recent sync attempt succeeded. */
  public boolean lastSyncOk() {
    return lastSyncOk;
  }

  /** Diagnostic: when the most recent sync attempt (success or failure) happened, or {@code null}. */
  public Instant lastSyncAt() {
    return lastSyncAt;
  }

  /** Number of active items currently cached; useful for log messages. */
  public int size() {
    return activeItemIds.size();
  }
}
