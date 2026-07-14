package de.austv.sales.update;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import de.austv.sales.AusTvSalesPlugin;
import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.net.http.HttpResponse.BodyHandlers;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.security.MessageDigest;
import java.time.Duration;
import java.util.HexFormat;
import java.util.Locale;

/**
 * Checa os GitHub Releases do plugin no boot e, havendo versao nova, baixa o jar para a pasta de
 * update do servidor. O Paper aplica o jar automaticamente no proximo restart (mecanismo nativo da
 * pasta de update), substituindo o jar instalado que tenha o mesmo nome de arquivo.
 *
 * <p>Toda a operacao roda de forma assincrona e nunca bloqueia o startup: qualquer falha de rede ou
 * parsing e apenas registrada no log, deixando o servidor subir normalmente.
 *
 * <p>Seguranca: as requisicoes so sao feitas contra {@value #API_HOST} (host allowlist), e o jar
 * baixado so e gravado na pasta de update apos validar seu SHA-256 contra o asset {@code .sha256}
 * publicado no mesmo release.
 */
public final class UpdateChecker {

  private static final String API_HOST = "api.github.com";
  private static final String TAG_PREFIX = "plugin-v";
  private static final String USER_AGENT = "austv-sales-updater";
  private static final String API_VERSION = "2022-11-28";
  private static final Duration CONNECT_TIMEOUT = Duration.ofSeconds(10);
  private static final Duration REQUEST_TIMEOUT = Duration.ofSeconds(30);

  private final AusTvSalesPlugin plugin;
  private final HttpClient http;

  public UpdateChecker(AusTvSalesPlugin plugin) {
    this.plugin = plugin;
    this.http =
        HttpClient.newBuilder()
            .connectTimeout(CONNECT_TIMEOUT)
            .followRedirects(HttpClient.Redirect.NORMAL)
            .build();
  }

  /** Agenda a checagem numa thread assincrona do servidor, sem bloquear o boot. */
  public void runAsync() {
    if (!plugin.getConfig().getBoolean("auto-update.enabled", true)) {
      plugin.getLogger().info("Auto-update desativado (auto-update.enabled: false).");
      return;
    }
    plugin.getServer().getScheduler().runTaskAsynchronously(plugin, this::check);
  }

  private void check() {
    try {
      String repository = plugin.getConfig().getString("auto-update.repository", "");
      if (!isValidRepository(repository)) {
        plugin.getLogger().warning("auto-update.repository invalido; checagem cancelada.");
        return;
      }

      String currentVersion = plugin.getPluginMeta().getVersion();
      Release latest = fetchLatestPluginRelease(repository);
      if (latest == null) {
        plugin.getLogger().info("Nenhum release plugin-v* encontrado; nada a atualizar.");
        return;
      }

      if (compareSemver(latest.version(), currentVersion) <= 0) {
        plugin.getLogger().info("Plugin ja esta na ultima versao (" + currentVersion + ").");
        return;
      }

      plugin
          .getLogger()
          .info("Versao nova disponivel: " + latest.version() + " (atual: " + currentVersion + ").");

      if (plugin.getConfig().getBoolean("auto-update.notify-only", false)) {
        plugin.getLogger().info("notify-only ativo: atualizacao nao sera baixada automaticamente.");
        return;
      }

      downloadAndStage(latest);
    } catch (Exception e) {
      // Nunca propaga: auto-update e best-effort e jamais deve derrubar o boot.
      plugin.getLogger().warning("Falha ao checar atualizacao: " + e.getMessage());
    }
  }

  /** Busca a lista de releases e retorna o de maior versao com tag {@code plugin-v*}. */
  private Release fetchLatestPluginRelease(String repository)
      throws IOException, InterruptedException {
    URI uri = URI.create("https://" + API_HOST + "/repos/" + repository + "/releases?per_page=30");
    HttpResponse<String> response = send(apiRequest(uri), BodyHandlers.ofString());
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
      if (release.has("draft") && release.get("draft").getAsBoolean()) {
        continue;
      }
      String tag = optString(release, "tag_name");
      if (tag == null || !tag.startsWith(TAG_PREFIX)) {
        continue;
      }
      String version = tag.substring(TAG_PREFIX.length());
      if (best != null && compareSemver(version, best.version()) <= 0) {
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
  private void downloadAndStage(Release release) throws IOException, InterruptedException {
    HttpResponse<byte[]> jarResponse =
        send(assetRequest(release.jarUrl()), BodyHandlers.ofByteArray());
    if (jarResponse.statusCode() != 200) {
      plugin.getLogger().warning("Download do jar falhou (HTTP " + jarResponse.statusCode() + ").");
      return;
    }
    byte[] jarBytes = jarResponse.body();

    HttpResponse<String> shaResponse =
        send(assetRequest(release.shaUrl()), BodyHandlers.ofString());
    if (shaResponse.statusCode() != 200) {
      plugin
          .getLogger()
          .warning("Download do checksum falhou (HTTP " + shaResponse.statusCode() + ").");
      return;
    }

    String expected = firstToken(shaResponse.body());
    String actual = sha256Hex(jarBytes);
    if (expected == null || !expected.equalsIgnoreCase(actual)) {
      plugin.getLogger().warning("Checksum nao confere; atualizacao abortada por seguranca.");
      return;
    }

    Path updateFolder = plugin.getServer().getUpdateFolderFile().toPath();
    Files.createDirectories(updateFolder);
    // Mesmo nome do jar instalado: e como o Paper casa o update com o plugin em execucao.
    Path target = updateFolder.resolve(plugin.getPluginFile().getName());
    Path temp = Files.createTempFile(updateFolder, "austv-sales-", ".jar.part");
    try {
      Files.write(temp, jarBytes);
      Files.move(temp, target, StandardCopyOption.REPLACE_EXISTING);
    } finally {
      Files.deleteIfExists(temp);
    }
    plugin
        .getLogger()
        .info("Atualizacao " + release.version() + " baixada. Sera aplicada no proximo restart.");
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

  private <T> HttpResponse<T> send(HttpRequest request, HttpResponse.BodyHandler<T> handler)
      throws IOException, InterruptedException {
    return http.send(request, handler);
  }

  /** Garante que a URL aponta para o host allowlisted da API do GitHub, sobre HTTPS. */
  private static void requireApiHost(URI uri) {
    if (!API_HOST.equalsIgnoreCase(uri.getHost()) || !"https".equalsIgnoreCase(uri.getScheme())) {
      throw new SecurityException("URL fora da allowlist do auto-update: " + uri);
    }
  }

  private static boolean isValidRepository(String repository) {
    return repository != null && repository.matches("[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+");
  }

  private static String optString(JsonObject object, String key) {
    JsonElement element = object.get(key);
    return (element == null || element.isJsonNull()) ? null : element.getAsString();
  }

  private static String firstToken(String content) {
    if (content == null) {
      return null;
    }
    String trimmed = content.trim();
    if (trimmed.isEmpty()) {
      return null;
    }
    return trimmed.split("\\s+", 2)[0];
  }

  private static String sha256Hex(byte[] data) {
    try {
      MessageDigest digest = MessageDigest.getInstance("SHA-256");
      return HexFormat.of().formatHex(digest.digest(data));
    } catch (Exception e) {
      throw new IllegalStateException("SHA-256 indisponivel na JVM.", e);
    }
  }

  /**
   * Compara duas versoes semver "X.Y.Z". Retorna negativo se {@code a < b}, zero se iguais, positivo
   * se {@code a > b}. Sufixos de pre-release sao ignorados.
   */
  private static int compareSemver(String a, String b) {
    int[] va = parse(a);
    int[] vb = parse(b);
    for (int i = 0; i < 3; i++) {
      int cmp = Integer.compare(va[i], vb[i]);
      if (cmp != 0) {
        return cmp;
      }
    }
    return 0;
  }

  private static int[] parse(String version) {
    String core = version.toLowerCase(Locale.ROOT).split("[-+]", 2)[0];
    String[] parts = core.split("\\.");
    int[] out = new int[3];
    for (int i = 0; i < 3 && i < parts.length; i++) {
      try {
        out[i] = Integer.parseInt(parts[i].trim());
      } catch (NumberFormatException ignored) {
        out[i] = 0;
      }
    }
    return out;
  }

  /** Dados minimos de um release do plugin. */
  private record Release(String version, String jarUrl, String shaUrl) {}
}
