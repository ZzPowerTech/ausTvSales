package de.austv.sales.api;

import java.net.URI;
import java.net.URISyntaxException;
import java.time.Duration;

/**
 * Resolved configuration of the sales API endpoint, read from {@code config.yml} on enable.
 *
 * <p>The endpoint is derived once from {@code base-url} (trailing slash tolerated). A config is only
 * {@linkplain #enabled() enabled} when both {@code base-url} and {@code api-key} are present <b>and</b>
 * {@code base-url} is a valid {@code http(s)} URI — a missing key or a malformed URL must fail safe
 * (no send) rather than let {@code URI.create} throw later and crash the async delivery with an
 * unclassified stacktrace.
 */
public final class SaleApiConfig {

  private final String salesEndpoint;
  private final String itemsSyncEndpoint;
  private final String apiKey;
  private final Duration timeout;
  private final boolean enabled;

  private SaleApiConfig(
      String salesEndpoint,
      String itemsSyncEndpoint,
      String apiKey,
      Duration timeout,
      boolean enabled) {
    this.salesEndpoint = salesEndpoint;
    this.itemsSyncEndpoint = itemsSyncEndpoint;
    this.apiKey = apiKey;
    this.timeout = timeout;
    this.enabled = enabled;
  }

  /**
   * Builds a config from raw config values. A blank {@code base-url}/{@code apiKey}, or a {@code
   * base-url} that is not a valid {@code http(s)} URI, yields a disabled config (the caller logs and
   * skips network delivery). When disabled, {@link #itemsSyncEndpoint()} is also empty, so the
   * S3.1 item-cache sync task is skipped by the caller and the cache stays empty (see {@code
   * de.austv.sales.cache.ItemCache}).
   */
  public static SaleApiConfig of(String baseUrl, String apiKey, long timeoutMs) {
    Duration timeout = Duration.ofMillis(timeoutMs > 0 ? timeoutMs : 5000);
    if (!isPresent(baseUrl) || !isPresent(apiKey)) {
      return new SaleApiConfig("", "", "", timeout, false);
    }

    String trimmedBase = trimTrailingSlash(baseUrl.trim());
    String salesEndpoint = trimmedBase + "/sales";
    String itemsSyncEndpoint = trimmedBase + "/items/sync";
    // Both endpoints share the same base-url, so validating one validates the other; kept as a
    // single check to mirror the pre-S3.1 fail-safe gate exactly.
    if (!isValidHttpUri(salesEndpoint)) {
      return new SaleApiConfig("", "", "", timeout, false);
    }
    return new SaleApiConfig(salesEndpoint, itemsSyncEndpoint, apiKey.trim(), timeout, true);
  }

  private static boolean isPresent(String value) {
    return value != null && !value.isBlank();
  }

  /** True only for a syntactically valid {@code http(s)} URI with a host (fail-safe gate). */
  private static boolean isValidHttpUri(String value) {
    try {
      URI uri = new URI(value);
      String scheme = uri.getScheme();
      return uri.getHost() != null
          && scheme != null
          && (scheme.equalsIgnoreCase("http") || scheme.equalsIgnoreCase("https"));
    } catch (URISyntaxException e) {
      return false;
    }
  }

  private static String trimTrailingSlash(String value) {
    String result = value;
    while (result.endsWith("/")) {
      result = result.substring(0, result.length() - 1);
    }
    return result;
  }

  public boolean enabled() {
    return enabled;
  }

  public String salesEndpoint() {
    return salesEndpoint;
  }

  /** {@code {base-url}/items/sync}, used by the S3.1 item-cache sync. Empty when disabled. */
  public String itemsSyncEndpoint() {
    return itemsSyncEndpoint;
  }

  public String apiKey() {
    return apiKey;
  }

  public Duration timeout() {
    return timeout;
  }
}
