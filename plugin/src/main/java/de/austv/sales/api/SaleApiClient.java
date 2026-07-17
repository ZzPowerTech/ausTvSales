package de.austv.sales.api;

import de.austv.sales.api.SaleDelivery.Outcome;
import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.net.http.HttpResponse.BodyHandlers;
import java.nio.charset.StandardCharsets;
import java.util.logging.Logger;

/**
 * Sends a {@link SalePayload} to {@code POST {base-url}/sales} authenticated with the {@code
 * X-Api-Key} header over the configured {@link java.net.http.HttpClient}.
 *
 * <p>{@link #deliver(SalePayload)} performs blocking network I/O and MUST be called off the server
 * main thread (the executor dispatches it via {@code runTaskAsynchronously}). The response is mapped
 * to a {@link Outcome} via {@link SaleDelivery#classify(int)} and logged; transient failures
 * (5xx / timeout / IOException) are logged with a {@code // TODO Sprint 3 (queue)} marker but not
 * yet re-enqueued.
 */
public final class SaleApiClient {

  private final SaleApiConfig config;
  private final Logger logger;
  private final HttpClient http;

  public SaleApiClient(SaleApiConfig config, Logger logger) {
    this.config = config;
    this.logger = logger;
    this.http = HttpClient.newBuilder().connectTimeout(config.timeout()).build();
  }

  /** Synchronously delivers the payload; safe to call only from an async task. */
  public void deliver(SalePayload payload) {
    String body = SaleJson.toJson(payload);
    HttpRequest request =
        HttpRequest.newBuilder(URI.create(config.salesEndpoint()))
            .header("Content-Type", "application/json")
            .header("X-Api-Key", config.apiKey())
            .timeout(config.timeout())
            .POST(HttpRequest.BodyPublishers.ofString(body, StandardCharsets.UTF_8))
            .build();

    try {
      HttpResponse<String> response = http.send(request, BodyHandlers.ofString());
      int status = response.statusCode();
      switch (SaleDelivery.classify(status)) {
        case ACK -> {
          String kind = status == 201 ? "recorded" : "duplicate/idempotent";
          logger.info(
              "Venda confirmada pela API (sale_id="
                  + payload.saleId()
                  + ", HTTP "
                  + status
                  + ", "
                  + kind
                  + ").");
        }
        case PERMANENT ->
            logger.warning(
                "Venda rejeitada de forma permanente (sale_id="
                    + payload.saleId()
                    + ", HTTP "
                    + status
                    + "): "
                    + response.body()
                    + " — nao sera reenfileirada.");
        case TRANSIENT ->
            logger.severe(
                "Falha transitoria ao enviar venda (sale_id="
                    + payload.saleId()
                    + ", HTTP "
                    + status
                    + "). // TODO Sprint 3 (queue)");
      }
    } catch (IOException e) {
      logger.severe(
          "Falha de rede ao enviar venda (sale_id="
              + payload.saleId()
              + "): "
              + e.getMessage()
              + ". // TODO Sprint 3 (queue)");
    } catch (InterruptedException e) {
      Thread.currentThread().interrupt();
      logger.severe(
          "Envio de venda interrompido (sale_id="
              + payload.saleId()
              + "). // TODO Sprint 3 (queue)");
    }
  }
}
