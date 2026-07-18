import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, asc, eq, ne, sql } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDB } from '../db/database.module';
import { categories, type Category } from '../db/schema';
import { CreateCategoryDto } from './dto/create-category.dto';
import { ReorderCategoriesDto } from './dto/reorder-categories.dto';
import { UpdateCategoryDto } from './dto/update-category.dto';

/** Postgres `unique_violation` — raised by `categories_name_lower_unique`. */
const PG_UNIQUE_VIOLATION = '23505';

/**
 * True when the driver error is a unique-constraint violation. The pre-check in
 * {@link CategoriesService.assertNameAvailable} handles the normal path; this
 * covers the race where two writes pass the check before either commits.
 */
function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === PG_UNIQUE_VIOLATION
  );
}

/**
 * The 409 raised both by the friendly pre-check and by the driver-level
 * violation, so a racing caller gets the same answer as a sequential one.
 */
function duplicateName(name?: string): ConflictException {
  return new ConflictException(
    name === undefined
      ? 'Category name already exists'
      : `Category name "${name}" already exists`,
  );
}

@Injectable()
export class CategoriesService {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDB) {}

  async create(dto: CreateCategoryDto): Promise<Category> {
    await this.assertNameAvailable(dto.name);

    try {
      const [created] = await this.db
        .insert(categories)
        .values({ name: dto.name, displayOrder: dto.display_order })
        .returning();
      return created;
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw duplicateName(dto.name);
      }
      throw error;
    }
  }

  findAll(): Promise<Category[]> {
    // Sidebar order: explicit display_order first, then alphabetical as a
    // deterministic tie-breaker.
    return this.db
      .select()
      .from(categories)
      .orderBy(asc(categories.displayOrder), asc(categories.name));
  }

  async findOne(id: number): Promise<Category> {
    const [category] = await this.db
      .select()
      .from(categories)
      .where(eq(categories.id, id))
      .limit(1);
    if (!category) {
      throw new NotFoundException(`Category ${id} not found`);
    }
    return category;
  }

  async update(id: number, dto: UpdateCategoryDto): Promise<Category> {
    if (dto.name === undefined && dto.display_order === undefined) {
      throw new BadRequestException('No fields to update');
    }
    // Surface a clean 404 before attempting the write.
    await this.findOne(id);

    if (dto.name !== undefined) {
      await this.assertNameAvailable(dto.name, id);
    }

    try {
      const [updated] = await this.db
        .update(categories)
        .set({
          ...(dto.name !== undefined ? { name: dto.name } : {}),
          ...(dto.display_order !== undefined
            ? { displayOrder: dto.display_order }
            : {}),
        })
        .where(eq(categories.id, id))
        .returning();
      return updated;
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw duplicateName(dto.name);
      }
      throw error;
    }
  }

  /**
   * Rewrite `display_order` from the given id sequence, atomically (spec S4.0).
   *
   * The whole operation runs in one transaction — including the validation read
   * — so a concurrent create cannot slip between "these are the ids" and "this
   * is the new order". Either the sidebar ends up exactly as requested, or it is
   * left untouched.
   */
  async reorder(dto: ReorderCategoriesDto): Promise<Category[]> {
    return this.db.transaction(async (tx) => {
      const existing = await tx.select({ id: categories.id }).from(categories);
      const existingIds = new Set(existing.map((row) => row.id));

      // Demand the complete set: a client working from a stale list (a second
      // tab that never saw a new category) must fail loudly rather than write
      // an order with gaps.
      const unknown = dto.order.filter((id) => !existingIds.has(id));
      if (unknown.length > 0) {
        throw new BadRequestException(
          `Unknown category ids: ${unknown.join(', ')}`,
        );
      }
      if (dto.order.length !== existingIds.size) {
        throw new BadRequestException(
          `Expected all ${existingIds.size} category ids, received ${dto.order.length}`,
        );
      }

      for (const [index, id] of dto.order.entries()) {
        await tx
          .update(categories)
          .set({ displayOrder: index })
          .where(eq(categories.id, id));
      }

      return tx
        .select()
        .from(categories)
        .orderBy(asc(categories.displayOrder), asc(categories.name));
    });
  }

  /**
   * Enforce the business rule that category names are unique case-insensitively
   * (spec S1.5: avoid duplicate categories created by a typo). `excludeId` skips
   * the row being updated so a category can keep its own name.
   *
   * This is the *friendly* path. The `categories_name_lower_unique` index (S4.0)
   * is what actually guarantees it — see {@link isUniqueViolation}.
   */
  private async assertNameAvailable(
    name: string,
    excludeId?: number,
  ): Promise<void> {
    const nameMatches = sql`lower(${categories.name}) = lower(${name})`;
    const [existing] = await this.db
      .select({ id: categories.id })
      .from(categories)
      .where(
        excludeId === undefined
          ? nameMatches
          : and(nameMatches, ne(categories.id, excludeId)),
      )
      .limit(1);
    if (existing) {
      throw duplicateName(name);
    }
  }
}
