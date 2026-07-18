/**
 * A catalog item, as the API returns it.
 *
 * `itemId` is the opaque business key (e.g. `caixaNatal2026`) and is
 * **immutable after creation** — historical sales reference it by foreign key.
 * `id` is the surrogate key used in URLs.
 */
export interface Item {
  id: number;
  itemId: string;
  displayName: string;
  categoryId: number;
  active: boolean;
}

/** Payload for creating an item (snake_case, per `CreateItemDto`). */
export interface CreateItemPayload {
  item_id: string;
  display_name: string;
  category_id: number;
  active?: boolean;
}

/** Partial update. `item_id` is absent by design: the backend rejects it. */
export interface UpdateItemPayload {
  display_name?: string;
  category_id?: number;
  active?: boolean;
}

/**
 * Validation mirror of `ITEM_ID_PATTERN` in the backend's `CreateItemDto`.
 * Kept identical on purpose so the form rejects a bad id before the round-trip;
 * the backend stays the authority.
 */
export const ITEM_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
