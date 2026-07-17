package de.austv.sales;

import de.austv.sales.api.SaleApiClient;
import de.austv.sales.api.SaleApiConfig;
import de.austv.sales.command.SaleCommandExecutor;
import de.austv.sales.update.UpdateChecker;
import java.io.File;
import org.bukkit.plugin.java.JavaPlugin;

public final class AusTvSalesPlugin extends JavaPlugin {

  @Override
  public void onEnable() {
    saveDefaultConfig();

    SaleApiClient apiClient = buildApiClient();

    var command = getCommand("austv-sales");
    if (command != null) {
      command.setExecutor(new SaleCommandExecutor(this, apiClient));
    } else {
      getLogger().severe("Command 'austv-sales' not found in plugin.yml.");
    }

    new UpdateChecker(this).runAsync();

    getLogger().info("AusTvSales enabled.");
  }

  /**
   * Reads the {@code api:} block from {@code config.yml} and builds the delivery client. If {@code
   * base-url} or {@code api-key} are missing the client is disabled (fail-safe): the command still
   * parses and validates, but nothing is sent — and the server keeps running.
   *
   * @return a ready {@link SaleApiClient}, or {@code null} when the API is not configured.
   */
  private SaleApiClient buildApiClient() {
    var config = getConfig();
    SaleApiConfig apiConfig =
        SaleApiConfig.of(
            config.getString("api.base-url", ""),
            config.getString("api.api-key", ""),
            config.getLong("api.timeout-ms", 5000));

    if (!apiConfig.enabled()) {
      getLogger()
          .severe(
              "API de vendas nao configurada (api.base-url / api.api-key ausentes ou base-url "
                  + "invalida em config.yml): envio DESABILITADO. Vendas serao apenas parseadas e "
                  + "logadas.");
      return null;
    }

    getLogger().info("API de vendas configurada: envio habilitado para " + apiConfig.salesEndpoint() + ".");
    return new SaleApiClient(apiConfig, getLogger());
  }

  @Override
  public void onDisable() {
    getLogger().info("AusTvSales disabled.");
  }

  /**
   * Expoe o jar deste plugin para o {@link UpdateChecker} nomear o download com o mesmo nome de
   * arquivo, condicao para o Paper aplicar o update no proximo restart. {@code getFile()} e
   * protegido em {@link JavaPlugin}, dai o acessor publico.
   */
  public File getPluginFile() {
    return getFile();
  }
}
