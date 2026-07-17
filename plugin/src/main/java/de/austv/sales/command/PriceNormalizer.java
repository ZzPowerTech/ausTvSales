package de.austv.sales.command;

/**
 * Defensive, pure normalization of the {@code %price%} placeholder value coming from Genesis before
 * it reaches {@link SaleCommandParser}.
 *
 * <p>The placeholder is resolved by Genesis and may arrive in a locale-dependent shape — a currency
 * symbol/prefix ({@code R$ 9,90}), a decimal comma ({@code 9,90}) or a grouped amount ({@code
 * 1.234,56} or {@code 1,234.56}). This normalizer strips everything that is not a digit, separator
 * or a leading sign, then reduces it to a plain {@code BigDecimal}-parseable string with a {@code
 * '.'} decimal separator. Anything the parser still finds invalid (e.g. empty, non-numeric) is
 * rejected downstream — this only normalizes, it does not validate.
 *
 * <p>Deciding which separator is the decimal one (see {@link #decimalSeparatorIndex}):
 *
 * <ul>
 *   <li>both {@code '.'} and {@code ','} present → the <b>last-occurring</b> one is the decimal
 *       separator, the other is grouping ({@code 1.234,56} and {@code 1,234.56} → {@code 1234.56});
 *   <li>a single separator type appearing more than once → all grouping ({@code 1.234.567});
 *   <li>a single separator appearing once, followed by exactly 3 digits → grouping, <b>not</b>
 *       decimal ({@code 1.234} / {@code 1,234} are 1234, not 1.234) — for money, 3 trailing digits
 *       after a lone separator means thousands grouping;
 *   <li>otherwise (a lone separator followed by 1–2 digits) → decimal ({@code 9,90} → {@code 9.90}).
 * </ul>
 *
 * <p>A leading {@code '-'} is preserved; any other {@code '-'} is dropped as noise (prices are
 * validated {@code > 0} by the parser anyway). Normalization happens before the parser, so the
 * parser's own tests keep rejecting raw {@code "9,90"}.
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

    String trimmed = raw.trim();
    boolean negative = trimmed.startsWith("-");

    // Keep only digits and the two possible separators.
    StringBuilder cleaned = new StringBuilder();
    for (int i = 0; i < trimmed.length(); i++) {
      char c = trimmed.charAt(i);
      if (Character.isDigit(c) || c == '.' || c == ',') {
        cleaned.append(c);
      }
    }
    if (cleaned.length() == 0) {
      return trimmed;
    }

    int decimalPos = decimalSeparatorIndex(cleaned);

    StringBuilder out = new StringBuilder();
    for (int i = 0; i < cleaned.length(); i++) {
      char c = cleaned.charAt(i);
      if (c == '.' || c == ',') {
        // The decimal separator becomes '.'; every other separator is grouping and dropped.
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

  /**
   * Index (within {@code cleaned}, digits and separators only) of the character acting as the
   * decimal separator, or {@code -1} when the value has no decimal part (a plain or grouped
   * integer). See the class Javadoc for the rules.
   */
  private static int decimalSeparatorIndex(CharSequence cleaned) {
    int lastDot = lastIndexOf(cleaned, '.');
    int lastComma = lastIndexOf(cleaned, ',');

    if (lastDot >= 0 && lastComma >= 0) {
      return Math.max(lastDot, lastComma);
    }

    int sepPos = Math.max(lastDot, lastComma); // -1 when there is no separator at all
    if (sepPos < 0) {
      return -1;
    }

    char sep = cleaned.charAt(sepPos);
    int digitsAfter = cleaned.length() - sepPos - 1;
    if (count(cleaned, sep) > 1 || digitsAfter == 3) {
      return -1; // repeated separator, or 3 trailing digits → grouping, no decimal part
    }
    return sepPos;
  }

  private static int lastIndexOf(CharSequence s, char target) {
    for (int i = s.length() - 1; i >= 0; i--) {
      if (s.charAt(i) == target) {
        return i;
      }
    }
    return -1;
  }

  private static int count(CharSequence s, char target) {
    int n = 0;
    for (int i = 0; i < s.length(); i++) {
      if (s.charAt(i) == target) {
        n++;
      }
    }
    return n;
  }
}
