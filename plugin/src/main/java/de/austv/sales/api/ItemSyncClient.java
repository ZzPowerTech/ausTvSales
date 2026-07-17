package de.austv.sales.api;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.google.gson.JsonSyntaxException;
import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.net.http.HttpResponse.BodyHandlers;
import java.util.HashSet;
import java.util.Optional;
import java.util.Set;
import java.util.logging.Logger;

/**
 * Fetches the active item catalog from {@code GET {base-url}/items/sync}, authenticated with the
 * {@code X-Api-Key} header, for {@code de.austv.sales.cache.ItemCache} (S3.1) to consume.
 *
 * <p>{@link #fetchActiveItemIds()} performs blocking network I/O and MUST be called off the
 * server main thread (the {@code ItemSyncTask} dispatches it via {@code
 * runTaskTimerAsynchronously}). Any failure (non-2xx, network error, malformed response body) is
 * swallowed into {@link Optional#empty()} - the caller's job is only to decide what "no fresh
 * data" means for the cache (keep the last good set), never to propagate an exception up into a
 * scheduled Bukkit task.
 *
 * <p>JSON parsing is isolated in the pure, static {@link #parseActiveItemIds(String)} so it is
 * unit-testable without a live server or an {@link HttpClient}.
 */
public final class ItemSyncClient {

  private final SaleApiConfig config;
  private final Logger logger;
  private final HttpClient http;

  public ItemSyncClient(SaleApiConfig config, Logger logger) {
    this.config = config;
    this.logger = logger;
    this.http = HttpClient.newBuilder().connectTimeout(config.timeout()).build();
  }

  /**
   * Synchronously fetches the set of active {@code item_id}s.
   *
   * @return the active set on a 2xx response with a parseable body; {@link Optional#empty()} on
   *     any failure (the caller logs and keeps the previous cache).
   */
  public Optional<Set<String>> fetchActiveItemIds() {
    try {
      // Built inside the try: a blank/invalid itemsSyncEndpoint (e.g. the task scheduled while the
      // API config is disabled) makes URI.create / newBuilder throw IllegalArgumentException, which
      // must still resolve to Optional.empty() per this method's contract, never crash the task.
      HttpRequest request =
          HttpRequest.newBuilder(URI.create(config.itemsSyncEndpoint()))
              .header("X-Api-Key", config.apiKey())
              .timeout(config.timeout())
              .GET()
              .build();

      HttpResponse<String> response = http.send(request, BodyHandlers.ofString());
      int status = response.statusCode();
      if (status < 200 || status >= 300) {
        logger.warning("Sync de itens falhou (HTTP " + status + ").");
        return Optional.empty();
      }
      return Optional.of(parseActiveItemIds(response.body()));
    } catch (IOException e) {
      logger.warning("Falha de rede no sync de itens: " + e.getMessage());
      return Optional.empty();
    } catch (InterruptedException e) {
      Thread.currentThread().interrupt();
      logger.warning("Sync de itens interrompido.");
      return Optional.empty();
    } catch (IllegalArgumentException | JsonSyntaxException | IllegalStateException e) {
      // IllegalArgumentException: blank/invalid endpoint URI. JsonSyntaxException: malformed JSON.
      // IllegalStateException: valid JSON but not an array (e.g. the endpoint returned an error
      // object). None is a reason to crash the scheduled sync task.
      logger.warning("Resposta invalida no sync de itens: " + e.getMessage());
      return Optional.empty();
    }
  }

  /**
   * Pure parse of the {@code GET /items/sync} response body ({@code
   * [{"itemId":"...","active":true}, ...]}) into the set of {@code itemId} whose {@code active}
   * flag is {@code true}. Filters defensively even though the documented contract only ever
   * returns active items - a future backend change or a bug should not silently widen the
   * accepted item set. Malformed JSON is not caught here; it is a network-layer concern (see
   * {@link #fetchActiveItemIds()}), letting this method stay a trivial, fully testable pure
   * function.
   */
  public static Set<String> parseActiveItemIds(String json) {
    JsonArray array = JsonParser.parseString(json).getAsJsonArray();
    Set<String> result = new HashSet<>();
    for (JsonElement element : array) {
      JsonObject entry = element.getAsJsonObject();
      if (isActive(entry)) {
        JsonElement idElement = entry.get("itemId");
        if (idElement != null && !idElement.isJsonNull()) {
          result.add(idElement.getAsString());
        }
      }
    }
    return result;
  }

  private static boolean isActive(JsonObject entry) {
    JsonElement activeElement = entry.get("active");
    return activeElement != null && !activeElement.isJsonNull() && activeElement.getAsBoolean();
  }
}
