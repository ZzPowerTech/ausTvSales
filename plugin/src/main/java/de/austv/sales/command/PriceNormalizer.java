package de.austv.sales.command;

/**
 * Defensive, pure normalization of the {@code %price%} placeholder value coming from Genesis before
 * it reaches {@link SaleCommandParser}.
 *
 * <p>The placeholder is resolved by Genesis and may arrive in a locale-dependent shape — a currency
 * symbol/prefix ({@code R$ 9,90}), a decimal comma ({@code 9,90}) or a grouped amount ({@code
 * 1.234,56} or {@code 1,234.56}). This normalizer strips everything that is not a digit, separator
 * or sign, then reduces it to a plain {@code BigDecimal}-parseable string with a {@code '.'} decimal
 * separator. Assumption: the <b>last</b> occurring separator is the decimal separator (the standard
 * heuristic that handles both {@code 1.234,56} and {@code 1,234.56}); any earlier separators are
 * grouping and dropped. Anything the parser still finds invalid (e.g. empty, non-numeric) is
 * rejected downstream — this only normalizes, it does not validate.
 *
 * <p>The parser's own tests keep rejecting raw {@code "9,90"} because normalization happens before
 * the parser, never inside it.
 */
public final class PriceNormalizer {

  private PriceNormalizer() {}

  /**
   * Normalizes a raw price token. A {@code null} input is returned as an empty string so the parser
   * reports it as a non-numeric price rather than throwing.
   */
  public static String normalize(String raw) {
    if (raw == null) {
      return "";
    }

    boolean negative = raw.trim().startsWith("-");

    // Keep only digits and the two possible separators.
    StringBuilder cleaned = new StringBuilder();
    for (int i = 0; i < raw.length(); i++) {
      char c = raw.charAt(i);
      if (Character.isDigit(c) || c == '.' || c == ',') {
        cleaned.append(c);
      }
    }
    if (cleaned.length() == 0) {
      return raw.trim();
    }

    int lastDot = cleaned.lastIndexOf(".");
    int lastComma = cleaned.lastIndexOf(",");
    int decimalPos = Math.max(lastDot, lastComma);

    StringBuilder out = new StringBuilder();
    for (int i = 0; i < cleaned.length(); i++) {
      char c = cleaned.charAt(i);
      if (c == '.' || c == ',') {
        // Only the last separator survives, as the decimal point; earlier ones are grouping.
        if (i == decimalPos) {
          out.append('.');
        }
      } else {
        out.append(c);
      }
    }

    String result = out.toString();
    return negative ? "-" + result : result;
  }
}
