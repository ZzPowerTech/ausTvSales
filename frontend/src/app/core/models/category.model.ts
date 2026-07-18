/**
 * A catalog category, as the API returns it.
 *
 * Field names mirror the backend response verbatim (Drizzle camelCases the
 * columns on the way out) — no client-side renaming, so a mismatch surfaces at
 * the boundary instead of being silently papered over.
 */
export interface Category {
  id: number;
  name: string;
  displayOrder: number;
}

/** Payload for creating a category. `display_order` is snake_case per the DTO. */
export interface CreateCategoryPayload {
  name: string;
  display_order?: number;
}

/** Payload for renaming or repositioning a single category. */
export interface UpdateCategoryPayload {
  name?: string;
  display_order?: number;
}
