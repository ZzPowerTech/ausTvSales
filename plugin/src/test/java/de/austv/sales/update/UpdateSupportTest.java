package de.austv.sales.update;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.nio.charset.StandardCharsets;
import org.junit.jupiter.api.Test;

/** Cobre a logica pura do {@link UpdateSupport}: semver, checksum, allowlist e repository. */
class UpdateSupportTest {

  @Test
  void compareSemverOrdersMajorMinorPatch() {
    assertTrue(UpdateSupport.compareSemver("1.2.0", "1.1.9") > 0);
    assertTrue(UpdateSupport.compareSemver("2.0.0", "1.9.9") > 0);
    assertTrue(UpdateSupport.compareSemver("1.0.1", "1.0.2") < 0);
    assertEquals(0, UpdateSupport.compareSemver("1.4.1", "1.4.1"));
  }

  @Test
  void compareSemverTreatsMissingPartsAsZero() {
    assertEquals(0, UpdateSupport.compareSemver("1.2", "1.2.0"));
    assertTrue(UpdateSupport.compareSemver("1.2.1", "1.2") > 0);
  }

  @Test
  void compareSemverIgnoresPreReleaseSuffix() {
    assertEquals(0, UpdateSupport.compareSemver("1.2.0-rc1", "1.2.0"));
    assertEquals(0, UpdateSupport.compareSemver("1.2.0+build.5", "1.2.0"));
  }

  @Test
  void firstTokenExtractsHashFromChecksumLine() {
    // Formato tipico do sha256sum: "<hash>  <arquivo>".
    assertEquals(
        "abc123", UpdateSupport.firstToken("abc123  austv-sales-plugin-0.2.0.jar"));
    assertEquals("deadbeef", UpdateSupport.firstToken("  deadbeef\n"));
  }

  @Test
  void firstTokenHandlesNullAndBlank() {
    assertNull(UpdateSupport.firstToken(null));
    assertNull(UpdateSupport.firstToken("   "));
  }

  @Test
  void sha256HexMatchesKnownVector() {
    // SHA-256 da string vazia.
    assertEquals(
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        UpdateSupport.sha256Hex(new byte[0]));
    // SHA-256 de "abc".
    assertEquals(
        "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
        UpdateSupport.sha256Hex("abc".getBytes(StandardCharsets.UTF_8)));
  }

  @Test
  void isAllowedHostAcceptsOnlyGitHubHosts() {
    assertTrue(UpdateSupport.isAllowedHost("api.github.com"));
    assertTrue(UpdateSupport.isAllowedHost("github.com"));
    assertTrue(UpdateSupport.isAllowedHost("release-assets.githubusercontent.com"));
    assertTrue(UpdateSupport.isAllowedHost("objects.githubusercontent.com"));
    assertTrue(UpdateSupport.isAllowedHost("API.GITHUB.COM"));
  }

  @Test
  void isAllowedHostRejectsForeignHosts() {
    assertFalse(UpdateSupport.isAllowedHost("evil.com"));
    assertFalse(UpdateSupport.isAllowedHost("githubusercontent.com.evil.com"));
    assertFalse(UpdateSupport.isAllowedHost("api.github.com.evil.com"));
    assertFalse(UpdateSupport.isAllowedHost(null));
  }

  @Test
  void isValidRepositoryRequiresOwnerSlashRepo() {
    assertTrue(UpdateSupport.isValidRepository("ZzPowerTech/ausTvSales"));
    assertFalse(UpdateSupport.isValidRepository("sem-barra"));
    assertFalse(UpdateSupport.isValidRepository("a/b c"));
    assertFalse(UpdateSupport.isValidRepository(null));
  }
}
