package de.austv.sales.cache;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.Set;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

/**
 * Cobre o cache local de itens (S3.1): comeca vazio, troca atomica em {@code replaceAll} e
 * preserva o ultimo cache valido quando {@code markSyncFailed} e chamado.
 */
class ItemCacheTest {

  @Test
  @DisplayName("cache comeca vazio: nenhum item e reconhecido antes do primeiro sync")
  void startsEmpty() {
    ItemCache cache = new ItemCache();

    assertFalse(cache.contains("caixaNatal2026"));
    assertFalse(cache.lastSyncOk());
    assertNull(cache.lastSyncAt());
  }

  @Test
  @DisplayName("replaceAll popula o cache e marca lastSyncOk=true com lastSyncAt preenchido")
  void replaceAllPopulatesCache() {
    ItemCache cache = new ItemCache();

    cache.replaceAll(Set.of("caixaNatal2026", "rankVip"));

    assertTrue(cache.contains("caixaNatal2026"));
    assertTrue(cache.contains("rankVip"));
    assertFalse(cache.contains("itemInexistente"));
    assertTrue(cache.lastSyncOk());
    assertNotNull(cache.lastSyncAt());
  }

  @Test
  @DisplayName("replaceAll troca o conjunto inteiro atomicamente (nao acumula itens antigos)")
  void replaceAllSwapsAtomically() {
    ItemCache cache = new ItemCache();
    cache.replaceAll(Set.of("a", "b"));

    cache.replaceAll(Set.of("c"));

    assertFalse(cache.contains("a"));
    assertFalse(cache.contains("b"));
    assertTrue(cache.contains("c"));
  }

  @Test
  @DisplayName("markSyncFailed mantem o ultimo cache valido e marca lastSyncOk=false")
  void markSyncFailedKeepsLastCache() {
    ItemCache cache = new ItemCache();
    cache.replaceAll(Set.of("a", "b"));

    cache.markSyncFailed();

    assertTrue(cache.contains("a"));
    assertTrue(cache.contains("b"));
    assertFalse(cache.lastSyncOk());
    assertNotNull(cache.lastSyncAt());
  }

  @Test
  @DisplayName("markSyncFailed antes de qualquer sync bem-sucedido mantem o cache vazio")
  void markSyncFailedOnEmptyCacheStaysEmpty() {
    ItemCache cache = new ItemCache();

    cache.markSyncFailed();

    assertFalse(cache.contains("qualquerItem"));
    assertFalse(cache.lastSyncOk());
  }

  @Test
  @DisplayName("contains(null) nao lanca excecao e retorna false")
  void containsNullIsSafe() {
    assertFalse(new ItemCache().contains(null));
  }

  @Test
  @DisplayName("size reflete o tamanho do ultimo cache populado")
  void sizeReflectsCurrentCache() {
    ItemCache cache = new ItemCache();
    assertEquals(0, cache.size());

    cache.replaceAll(Set.of("a", "b", "c"));

    assertEquals(3, cache.size());
  }
}
