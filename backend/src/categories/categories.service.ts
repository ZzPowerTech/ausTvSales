import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, asc, eq, ne, sql } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDB } from '../db/database.module';
import { categories, type Category } from '../db/schema';
import { CreateCategoryDto } from './dto/create-category.dto';
import { UpdateCategoryDto } from './dto/update-category.dto';

@Injectable()
export class CategoriesService {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDB) {}

  async create(dto: CreateCategoryDto): Promise<Category> {
    await this.assertNameAvailable(dto.name);

    const [created] = await this.db
      .insert(categories)
      .values({ name: dto.name, displayOrder: dto.display_order })
      .returning();
    return created;
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
      throw new ConflictException('No fields to update');
    }
    // Surface a clean 404 before attempting the write.
    await this.findOne(id);

    if (dto.name !== undefined) {
      await this.assertNameAvailable(dto.name, id);
    }

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
  }

  /**
   * Enforce the business rule that category names are unique case-insensitively
   * (spec S1.5: avoid duplicate categories created by a typo). `excludeId` skips
   * the row being updated so a category can keep its own name.
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
      throw new ConflictException(`Category name "${name}" already exists`);
    }
  }
}
