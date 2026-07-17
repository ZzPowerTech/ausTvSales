package de.austv.sales.update;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import de.austv.sales.AusTvSalesPlugin;
import java.io.File;
import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.net.http.HttpResponse.BodyHandler;
import java.net.http.HttpResponse.BodyHandlers;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.time.Duration;
import java.util.Map;

/**
 * Checa os GitHub Releases do plugin e, havendo versao nova estavel, baixa o jar para a pasta de
 * update do servidor. O Paper aplica o jar da pasta de update <em>durante o boot, antes de carregar
 * os plugins</em> (mecanismo nativo), substituindo o jar instalado que tenha o mesmo nome de
 * arquivo. Por isso o download precisa terminar <em>antes</em> do proximo boot para que a nova
 * versao ja suba aplicada.
 *
 * <p>A estrategia usa duas janelas complementares:
 *
 * <ul>
 *   <li>{@link #stageOnShutdown} (principal): no {@code onDisable}, imediatamente antes do servidor
 *       reiniciar, a checagem roda de forma <em>bloqueante e com orcamento de tempo</em>. Se ha
 *       versao nova, o jar ja fica na pasta de update e o Paper o aplica no boot seguinte — a nova
 *       versao sobe aplicada nesse mesmo restart, sem exigir um segundo reinicio.
 *   <li>{@link #runAsync} (rede de seguranca): no {@code onEnable}, roda de forma assincrona sem
 *       bloquear o startup. Cobre o caso de o servidor ter caido sem {@code onDisable} limpo (a
 *       janela de shutdown nao rodou), garantindo que a atualizacao seja preparada assim mesmo — ela
 *       sera aplicada no restart seguinte.
 * </ul>
 *
 * <p>Qualquer falha de rede ou parsing e apenas registrada no log, deixando o servidor subir/descer
 * normalmente. As APIs do Bukkit que dependem de estado do servidor (pasta de update, arquivo do
 * plugin, config) sao lidas na main thread em {@link #runAsync()} / {@link #stageOnShutdown} e
 * passadas prontas para a tarefa em background.
 *
 * <p>Seguranca: as requisicoes so seguem hosts do GitHub (allowlist em {@link #isAllowedHost}), com
 * redirects seguidos manualmente e revalidados a cada hop; e o jar baixado so e gravado apos validar
 * seu SHA-256 contra o asset {@code .sha256} publicado no mesmo release.
 */
public final class UpdateChecker {

  private static final String API_HOST = "api.github.com";
  private static final String TAG_PREFIX = "plugin-v";
  private static final String USER_AGENT = "austv-sales-updater";
  private static final String API_VERSION = "2022-11-28";
  private static final Duration CONNECT_TIMEOUT = Duration.ofSeconds(10);
  private static final Duration REQUEST_TIMEOUT = Duration.ofSeconds(30);
  private static final int MAX_REDIRECTS = 5;
  private static final String SHUTDOWN_THREAD_NAME = "austv-sales-update-shutdown";

  private final AusTvSalesPlugin plugin;
  private final HttpClient http;

  public UpdateChecker(AusTvSalesPlugin plugin) {
    this.plugin = plugin;
    this.http =
        HttpClient.newBuilder()
            .connectTimeout(CONNECT_TIMEOUT)
            // Redirects sao seguidos manualmente para revalidar o host a cada hop.
            .followRedirects(HttpClient.Redirect.NEVER)
            .build();
  }

  /**
   * Le a config e o estado do servidor na main thread e agenda a checagem numa thread assincrona,
   * sem bloquear o boot. Rede de seguranca do {@link #stageOnShutdown}: cobre o caso de o servidor
   * ter caido sem {@code onDisable} limpo, preparando a atualizacao para o restart seguinte.
   */
  public void runAsync() {
    Job job = buildJob();
    if (job == null) {
      return;
    }
    plugin.getServer().getScheduler().runTaskAsynchronously(plugin, () -> check(job));
  }

  /**
   * Roda a checagem de forma <em>bloqueante</em> durante o {@code onDisable}, para que o jar novo ja
   * esteja na pasta de update antes do proximo boot — assim o Paper o aplica nesse mesmo restart.
   *
   * <p>Como o scheduler do Bukkit ja esta sendo desligado no shutdown, a tarefa roda numa thread
   * daemon dedicada e o metodo espera por ela ate {@code budget}. Se estourar o orcamento, apenas
   * registra no log e retorna: o shutdown nunca fica pendurado, e a thread daemon nao segura a saida
   * da JVM (a atualizacao sera preparada no boot seguinte via {@link #runAsync}).
   *
   * @param budget tempo maximo que o shutdown pode esperar pela checagem terminar
   */
  public void stageOnShutdown(Duration budget) {
    long budgetMillis = budget.toMillis();
    if (budgetMillis <= 0) {
      // Orcamento zerado/negativo = admin optou por nao segurar o shutdown; pula a checagem
      // (evita tambem o join(0), que bloquearia indefinidamente). Cai na rede de seguranca do boot.
      plugin
          .getLogger()
          .info("auto-update.shutdown-timeout-seconds <= 0; checagem no shutdown desativada.");
      return;
    }
    Job job = buildJob();
    if (job == null) {
      return;
    }
    Thread worker = new Thread(() -> check(job), SHUTDOWN_THREAD_NAME);
    worker.setDaemon(true);
    worker.start();
    try {
      worker.join(budgetMillis);
    } catch (InterruptedException e) {
      Thread.currentThread().interrupt();
      return;
    }
    if (worker.isAlive()) {
      plugin
          .getLogger()
          .warning(
              "Checagem de atualizacao no shutdown excedeu "
                  + budget.toSeconds()
                  + "s; seguindo com o desligamento (sera preparada no proximo boot).");
    }
  }

  /**
   * Le a config e o estado do servidor na main thread e monta o snapshot imutavel usado pela tarefa
   * em background — que nunca toca APIs do Bukkit. Retorna {@code null} quando o auto-update esta
   * desativado.
   */
  private Job buildJob() {
    var config = plugin.getConfig();
    if (!config.getBoolean("auto-update.enabled", true)) {
      plugin.getLogger().info("Auto-update desativado (auto-update.enabled: false).");
      return null;
    }
    return new Job(
        config.getString("auto-update.repository", ""),
        config.getBoolean("auto-update.notify-only", false),
        plugin.getPluginMeta().getVersion(),
        plugin.getServer().getUpdateFolderFile(),
        plugin.getPluginFile().getName());
  }

  private void check(Job job) {
    try {
      if (!UpdateSupport.isValidRepository(job.repository())) {
        plugin.getLogger().warning("auto-update.repository invalido; checagem cancelada.");
        return;
      }

      Release latest = fetchLatestPluginRelease(job.repository());
      if (latest == null) {
        plugin.getLogger().info("Nenhum release plugin-v* estavel encontrado; nada a atualizar.");
        return;
      }

      if (UpdateSupport.compareSemver(latest.version(), job.currentVersion()) <= 0) {
        plugin.getLogger().info("Plugin ja esta na ultima versao (" + job.currentVersion() + ").");
        return;
      }

      plugin
          .getLogger()
          .info(
              "Versao nova disponivel: "
                  + latest.version()
                  + " (atual: "
                  + job.currentVersion()
                  + ").");

      if (job.notifyOnly()) {
        plugin.getLogger().info("notify-only ativo: atualizacao nao sera baixada automaticamente.");
        return;
      }

      downloadAndStage(latest, job.updateFolder(), job.installedJarName());
    } catch (Exception e) {
      // Nunca propaga: auto-update e best-effort e jamais deve derrubar o boot.
      plugin.getLogger().warning("Falha ao checar atualizacao: " + e.getMessage());
    }
  }

  /**
   * Busca a lista de releases e retorna o de maior versao com tag {@code plugin-v*}, ignorando
   * drafts e prereleases (RC/beta nao sao aplicados automaticamente).
   */
  private Release fetchLatestPluginRelease(String repository)
      throws IOException, InterruptedException {
    URI uri = URI.create("https://" + API_HOST + "/repos/" + repository + "/releases?per_page=30");
    HttpResponse<String> response = sendAllowlisted(apiRequest(uri), BodyHandlers.ofString());
    if (response.statusCode() != 200) {
      plugin
          .getLogger()
          .warning("GitHub respondeu " + response.statusCode() + " ao listar releases.");
      return null;
    }

    JsonArray releases = JsonParser.parseString(response.body()).getAsJsonArray();
    Release best = null;
    for (JsonElement element : releases) {
      JsonObject release = element.getAsJsonObject();
      if (getBool(release, "draft") || getBool(release, "prerelease")) {
        continue;
      }
      String tag = optString(release, "tag_name");
      if (tag == null || !tag.startsWith(TAG_PREFIX)) {
        continue;
      }
      String version = tag.substring(TAG_PREFIX.length());
      if (best != null && UpdateSupport.compareSemver(version, best.version()) <= 0) {
        continue;
      }

      String jarUrl = null;
      String shaUrl = null;
      for (JsonElement assetElement : release.getAsJsonArray("assets")) {
        JsonObject asset = assetElement.getAsJsonObject();
        String name = optString(asset, "name");
        String url = optString(asset, "url");
        if (name == null || url == null) {
          continue;
        }
        if (name.endsWith(".sha256")) {
          shaUrl = url;
        } else if (name.endsWith(".jar")) {
          jarUrl = url;
        }
      }
      if (jarUrl != null && shaUrl != null) {
        best = new Release(version, jarUrl, shaUrl);
      }
    }
    return best;
  }

  /** Baixa o jar, valida o checksum e o grava na pasta de update do servidor. */
  private void downloadAndStage(Release release, File updateFolder, String installedJarName)
      throws IOException, InterruptedException {
    HttpResponse<byte[]> jarResponse =
        sendAllowlisted(assetRequest(release.jarUrl()), BodyHandlers.ofByteArray());
    if (jarResponse.statusCode() != 200) {
      plugin.getLogger().warning("Download do jar falhou (HTTP " + jarResponse.statusCode() + ").");
      return;
    }
    byte[] jarBytes = jarResponse.body();

    HttpResponse<String> shaResponse =
        sendAllowlisted(assetRequest(release.shaUrl()), BodyHandlers.ofString());
    if (shaResponse.statusCode() != 200) {
      plugin
          .getLogger()
          .warning("Download do checksum falhou (HTTP " + shaResponse.statusCode() + ").");
      return;
    }

    String expected = UpdateSupport.firstToken(shaResponse.body());
    String actual = UpdateSupport.sha256Hex(jarBytes);
    if (expected == null || !expected.equalsIgnoreCase(actual)) {
      plugin.getLogger().warning("Checksum nao confere; atualizacao abortada por seguranca.");
      return;
    }

    Path updateDir = updateFolder.toPath();
    Files.createDirectories(updateDir);
    // Mesmo nome do jar instalado: e como o Paper casa o update com o plugin em execucao.
    Path target = updateDir.resolve(installedJarName);
    Path temp = Files.createTempFile(updateDir, "austv-sales-", ".jar.part");
    try {
      Files.write(temp, jarBytes);
      Files.move(temp, target, StandardCopyOption.REPLACE_EXISTING);
    } finally {
      Files.deleteIfExists(temp);
    }
    plugin
        .getLogger()
        .info("Atualizacao " + release.version() + " baixada e preparada. Sera aplicada no proximo boot.");
  }

  private HttpRequest apiRequest(URI uri) {
    requireApiHost(uri);
    return HttpRequest.newBuilder(uri)
        .header("User-Agent", USER_AGENT)
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", API_VERSION)
        .timeout(REQUEST_TIMEOUT)
        .GET()
        .build();
  }

  private HttpRequest assetRequest(String apiAssetUrl) {
    URI uri = URI.create(apiAssetUrl);
    requireApiHost(uri);
    return HttpRequest.newBuilder(uri)
        .header("User-Agent", USER_AGENT)
        .header("Accept", "application/octet-stream")
        .header("X-GitHub-Api-Version", API_VERSION)
        .timeout(REQUEST_TIMEOUT)
        .GET()
        .build();
  }

  /**
   * Envia a requisicao seguindo redirects manualmente e revalidando o host de cada hop contra a
   * allowlist do GitHub — a garantia que o {@code followRedirects} automatico nao oferece.
   */
  private <T> HttpResponse<T> sendAllowlisted(HttpRequest request, BodyHandler<T> handler)
      throws IOException, InterruptedException {
    HttpRequest current = request;
    for (int hop = 0; hop <= MAX_REDIRECTS; hop++) {
      requireAllowedHost(current.uri());
      HttpResponse<T> response = http.send(current, handler);
      int status = response.statusCode();
      if (status == 301 || status == 302 || status == 303 || status == 307 || status == 308) {
        String location = response.headers().firstValue("Location").orElse(null);
        if (location == null) {
          return response;
        }
        current = redirectRequest(current, current.uri().resolve(location));
        continue;
      }
      return response;
    }
    throw new IOException("Excesso de redirects no auto-update.");
  }

  private HttpRequest redirectRequest(HttpRequest original, URI next) {
    HttpRequest.Builder builder = HttpRequest.newBuilder(next).timeout(REQUEST_TIMEOUT).GET();
    for (Map.Entry<String, java.util.List<String>> header : original.headers().map().entrySet()) {
      for (String value : header.getValue()) {
        builder.header(header.getKey(), value);
      }
    }
    return builder.build();
  }

  /** Exige host exatamente {@value #API_HOST} sobre HTTPS (ponto de partida das requisicoes). */
  private static void requireApiHost(URI uri) {
    if (!API_HOST.equalsIgnoreCase(uri.getHost()) || !"https".equalsIgnoreCase(uri.getScheme())) {
      throw new SecurityException("URL fora da allowlist do auto-update: " + uri);
    }
  }

  /** Exige que o host (inclusive apos redirect) pertenca ao GitHub, sobre HTTPS. */
  private static void requireAllowedHost(URI uri) {
    if (!"https".equalsIgnoreCase(uri.getScheme()) || !UpdateSupport.isAllowedHost(uri.getHost())) {
      throw new SecurityException("Host fora da allowlist do auto-update: " + uri.getHost());
    }
  }

  private static boolean getBool(JsonObject object, String key) {
    JsonElement element = object.get(key);
    return element != null && !element.isJsonNull() && element.getAsBoolean();
  }

  private static String optString(JsonObject object, String key) {
    JsonElement element = object.get(key);
    return (element == null || element.isJsonNull()) ? null : element.getAsString();
  }

  /** Dados minimos de um release do plugin. */
  private record Release(String version, String jarUrl, String shaUrl) {}

  /** Snapshot capturado na main thread para uso seguro na tarefa assincrona. */
  private record Job(
      String repository,
      boolean notifyOnly,
      String currentVersion,
      File updateFolder,
      String installedJarName) {}
}
