package de.austv.sales;

import de.austv.sales.command.SaleCommandExecutor;
import org.bukkit.plugin.java.JavaPlugin;

public final class AusTvSalesPlugin extends JavaPlugin {

  @Override
  public void onEnable() {
    var command = getCommand("austv-sales");
    if (command != null) {
      command.setExecutor(new SaleCommandExecutor(this));
    } else {
      getLogger().severe("Command 'austv-sales' not found in plugin.yml.");
    }
    getLogger().info("AusTvSales enabled.");
  }

  @Override
  public void onDisable() {
    getLogger().info("AusTvSales disabled.");
  }
}
