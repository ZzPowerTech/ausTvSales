package de.austv.sales.api;

/**
 * Pure mapping of an HTTP status code to the plugin-side delivery outcome, following the status
 * contract in {@code .specs/features/sprint-02-ingest/spec.md} §2.3:
 *
 * <ul>
 *   <li><b>2xx</b> → {@link Outcome#ACK}: the sale was recorded (or already existed); do not retry.
 *   <li><b>4xx</b> (422 unknown/inactive item, 400 malformed payload, 401 auth) → {@link
 *       Outcome#PERMANENT}: a client error that retrying cannot fix; log, do not re-enqueue.
 *   <li><b>5xx</b> and everything else (timeout / IOException, handled by the caller) → {@link
 *       Outcome#TRANSIENT}: retry candidate for the SQLite queue arriving in Sprint 3.
 * </ul>
 */
public final class SaleDelivery {

  private SaleDelivery() {}

  /** Where a delivery attempt landed, per the §2.3 status contract. */
  public enum Outcome {
    ACK,
    PERMANENT,
    TRANSIENT
  }

  /** Classifies an HTTP status code. Non-4xx, non-2xx codes are treated as transient. */
  public static Outcome classify(int statusCode) {
    if (statusCode >= 200 && statusCode < 300) {
      return Outcome.ACK;
    }
    if (statusCode >= 400 && statusCode < 500) {
      return Outcome.PERMANENT;
    }
    return Outcome.TRANSIENT;
  }
}
