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
 * main thread (the executor dispatches it via {@code runTaskAsynchronously}). The response is
 * mapped to an {@link Outcome} via {@link SaleDelivery#classify(int)}, logged, and returned so the
 * caller (the SQLite fallback queue, S3.2) can act on it: {@code ACK} marks the row {@code sent},
 * {@code PERMANENT} marks it {@code failed_permanent}, and {@code TRANSIENT} leaves it {@code
 * pending} for a future retry.
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

  /**
   * Synchronously delivers the payload; safe to call only from an async task.
   *
   * @return the classified {@link Outcome}. Network failures ({@link IOException}, and an
   *     interrupted wait) are mapped to {@link Outcome#TRANSIENT} - they are retry candidates,
   *     never a reason to drop the sale.
   */
  public Outcome deliver(SalePayload payload) {
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
      Outcome outcome = SaleDelivery.classify(status);
      switch (outcome) {
        case ACK -> {
          // Any 2xx is a definitive ACK (contract §2.3). Our backend uses 201 for a fresh write and
          // 200 for an idempotent replay, but we don't over-claim "duplicate" from the status alone.
          String detail = status == 201 ? " (registrada agora)" : " (ACK idempotente)";
          logger.info(
              "Venda confirmada pela API (sale_id="
                  + payload.saleId()
                  + ", HTTP "
                  + status
                  + ")"
                  + detail
                  + ".");
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
                    + "); permanece pendente na fila para nova tentativa.");
      }
      return outcome;
    } catch (IOException e) {
      logger.severe(
          "Falha de rede ao enviar venda (sale_id="
              + payload.saleId()
              + "): "
              + e.getMessage()
              + "; permanece pendente na fila para nova tentativa.");
      return Outcome.TRANSIENT;
    } catch (InterruptedException e) {
      Thread.currentThread().interrupt();
      logger.severe(
          "Envio de venda interrompido (sale_id="
              + payload.saleId()
              + "); permanece pendente na fila para nova tentativa.");
      return Outcome.TRANSIENT;
    }
  }
}
