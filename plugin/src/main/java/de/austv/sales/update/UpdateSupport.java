package de.austv.sales.update;

import java.security.MessageDigest;
import java.util.HexFormat;
import java.util.Locale;

/**
 * Funcoes puras do auto-update (semver, checksum, allowlist, validacao de repositorio), isoladas de
 * qualquer dependencia do Bukkit ou de rede para permitir teste unitario sem um servidor.
 */
final class UpdateSupport {

  private UpdateSupport() {}

  /** Aceita apenas hosts do GitHub: api.github.com, github.com e *.githubusercontent.com. */
  static boolean isAllowedHost(String host) {
    if (host == null) {
      return false;
    }
    String h = host.toLowerCase(Locale.ROOT);
    return h.equals("api.github.com")
        || h.equals("github.com")
        || h.endsWith(".githubusercontent.com");
  }

  /** Valida o formato {@code owner/repo} do repositorio configurado. */
  static boolean isValidRepository(String repository) {
    return repository != null && repository.matches("[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+");
  }

  /** Primeiro token de uma linha de checksum ("&lt;hash&gt;  &lt;arquivo&gt;"), ou {@code null}. */
  static String firstToken(String content) {
    if (content == null) {
      return null;
    }
    String trimmed = content.trim();
    if (trimmed.isEmpty()) {
      return null;
    }
    return trimmed.split("\\s+", 2)[0];
  }

  /** SHA-256 dos bytes, em hexadecimal minusculo. */
  static String sha256Hex(byte[] data) {
    try {
      MessageDigest digest = MessageDigest.getInstance("SHA-256");
      return HexFormat.of().formatHex(digest.digest(data));
    } catch (Exception e) {
      throw new IllegalStateException("SHA-256 indisponivel na JVM.", e);
    }
  }

  /**
   * Compara duas versoes semver "X.Y.Z". Retorna negativo se {@code a < b}, zero se iguais, positivo
   * se {@code a > b}. Partes ausentes contam como zero e sufixos de pre-release sao ignorados.
   */
  static int compareSemver(String a, String b) {
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
}
