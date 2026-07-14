package de.austv.sales;

import de.austv.sales.command.SaleCommandExecutor;
import de.austv.sales.update.UpdateChecker;
import java.io.File;
import org.bukkit.plugin.java.JavaPlugin;

public final class AusTvSalesPlugin extends JavaPlugin {

  @Override
  public void onEnable() {
    saveDefaultConfig();

    var command = getCommand("austv-sales");
    if (command != null) {
      command.setExecutor(new SaleCommandExecutor(this));
    } else {
      getLogger().severe("Command 'austv-sales' not found in plugin.yml.");
    }

    new UpdateChecker(this).runAsync();

    getLogger().info("AusTvSales enabled.");
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
