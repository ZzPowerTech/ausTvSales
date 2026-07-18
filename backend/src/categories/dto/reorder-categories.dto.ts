import { ArrayNotEmpty, ArrayUnique, IsArray, IsInt, Min } from 'class-validator';

/**
 * Atomic reordering of the sidebar (spec S4.0).
 *
 * The client sends the **complete** set of category ids in the desired order and
 * the server assigns `display_order` by position, inside one transaction. Two
 * design consequences worth keeping:
 *
 * - Sending the whole set (rather than a single "move this one") means a stale
 *   client — a second tab that never saw a newly created category — fails with a
 *   400 instead of silently writing an order with holes in it.
 * - Being transactional means a failure mid-way leaves the previous order fully
 *   intact, so the dashboard can optimistically reorder and roll back cleanly.
 */
export class ReorderCategoriesDto {
  @IsArray()
  @ArrayNotEmpty()
  @ArrayUnique()
  @IsInt({ each: true })
  @Min(1, { each: true })
  order!: number[];
}
