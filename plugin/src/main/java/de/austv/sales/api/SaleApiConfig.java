package de.austv.sales.api;

import java.time.Duration;

/**
 * Resolved configuration of the sales API endpoint, read from {@code config.yml} on enable.
 *
 * <p>The endpoint is derived once from {@code base-url} (trailing slash tolerated). A config is only
 * {@linkplain #enabled() enabled} when both {@code base-url} and {@code api-key} are present — a
 * missing key must fail safe (no send) rather than bring the server down.
 */
public final class SaleApiConfig {

  private final String salesEndpoint;
  private final String apiKey;
  private final Duration timeout;
  private final boolean enabled;

  private SaleApiConfig(String salesEndpoint, String apiKey, Duration timeout, boolean enabled) {
    this.salesEndpoint = salesEndpoint;
    this.apiKey = apiKey;
    this.timeout = timeout;
    this.enabled = enabled;
  }

  /**
   * Builds a config from raw config values. Blank {@code base-url} or {@code apiKey} yields a
   * disabled config (the caller logs and skips network delivery).
   */
  public static SaleApiConfig of(String baseUrl, String apiKey, long timeoutMs) {
    boolean enabled = isPresent(baseUrl) && isPresent(apiKey);
    String endpoint = enabled ? trimTrailingSlash(baseUrl.trim()) + "/sales" : "";
    Duration timeout = Duration.ofMillis(timeoutMs > 0 ? timeoutMs : 5000);
    return new SaleApiConfig(endpoint, enabled ? apiKey.trim() : "", timeout, enabled);
  }

  private static boolean isPresent(String value) {
    return value != null && !value.isBlank();
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

  public String apiKey() {
    return apiKey;
  }

  public Duration timeout() {
    return timeout;
  }
}
