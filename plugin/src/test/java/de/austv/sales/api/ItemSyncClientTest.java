package de.austv.sales.api;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonSyntaxException;
import java.util.Set;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

/**
 * Cobre o parse puro de {@code GET /items/sync} ({@link ItemSyncClient#parseActiveItemIds}), sem
 * rede - a parte testável sem um servidor real, conforme o escopo da S3.1.
 */
class ItemSyncClientTest {

  @Test
  @DisplayName("extrai apenas os itemId com active=true, filtrando os inativos")
  void filtersOnlyActiveItems() {
    String json =
        "[{\"itemId\":\"caixaNatal2026\",\"active\":true},"
            + "{\"itemId\":\"itemDescontinuado\",\"active\":false}]";

    Set<String> result = ItemSyncClient.parseActiveItemIds(json);

    assertEquals(Set.of("caixaNatal2026"), result);
  }

  @Test
  @DisplayName("lista vazia produz conjunto vazio")
  void emptyArrayYieldsEmptySet() {
    assertTrue(ItemSyncClient.parseActiveItemIds("[]").isEmpty());
  }

  @Test
  @DisplayName("JSON malformado lanca excecao (tratada pelo chamador em fetchActiveItemIds)")
  void malformedJsonThrows() {
    assertThrows(JsonSyntaxException.class, () -> ItemSyncClient.parseActiveItemIds("{not json"));
  }

  @Test
  @DisplayName("JSON valido porem nao-array lanca excecao (tratada pelo chamador)")
  void nonArrayJsonThrows() {
    assertThrows(
        IllegalStateException.class,
        () -> ItemSyncClient.parseActiveItemIds("{\"itemId\":\"caixaNatal2026\"}"));
  }

  @Test
  @DisplayName("entrada sem campo active e tratada como inativa (filtro defensivo)")
  void missingActiveFieldIsTreatedAsInactive() {
    Set<String> result = ItemSyncClient.parseActiveItemIds("[{\"itemId\":\"a\"}]");

    assertTrue(result.isEmpty());
  }

  @Test
  @DisplayName("entrada sem campo itemId e ignorada mesmo se active=true")
  void missingItemIdFieldIsIgnored() {
    Set<String> result = ItemSyncClient.parseActiveItemIds("[{\"active\":true}]");

    assertTrue(result.isEmpty());
  }

  @Test
  @DisplayName("varios itens ativos e inativos misturados: so os ativos sobrevivem")
  void mixedActiveAndInactiveEntries() {
    String json =
        "[{\"itemId\":\"a\",\"active\":true},"
            + "{\"itemId\":\"b\",\"active\":false},"
            + "{\"itemId\":\"c\",\"active\":true}]";

    assertEquals(Set.of("a", "c"), ItemSyncClient.parseActiveItemIds(json));
  }
}
