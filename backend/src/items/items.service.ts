import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { asc, eq } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDB } from '../db/database.module';
import { categories, items, type Item } from '../db/schema';
import { CreateItemDto } from './dto/create-item.dto';
import { UpdateItemDto } from './dto/update-item.dto';

@Injectable()
export class ItemsService {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDB) {}

  async create(dto: CreateItemDto): Promise<Item> {
    await this.assertCategoryExists(dto.category_id);
    await this.assertItemIdAvailable(dto.item_id);

    const [created] = await this.db
      .insert(items)
      .values({
        itemId: dto.item_id,
        displayName: dto.display_name,
        categoryId: dto.category_id,
        active: dto.active,
      })
      .returning();
    return created;
  }

  findAll(): Promise<Item[]> {
    return this.db.select().from(items).orderBy(asc(items.itemId));
  }

  async findOne(id: number): Promise<Item> {
    const [item] = await this.db
      .select()
      .from(items)
      .where(eq(items.id, id))
      .limit(1);
    if (!item) {
      throw new NotFoundException(`Item ${id} not found`);
    }
    return item;
  }

  async update(id: number, dto: UpdateItemDto): Promise<Item> {
    if (
      dto.display_name === undefined &&
      dto.category_id === undefined &&
      dto.active === undefined
    ) {
      throw new BadRequestException('No fields to update');
    }
    await this.findOne(id);

    if (dto.category_id !== undefined) {
      await this.assertCategoryExists(dto.category_id);
    }

    const [updated] = await this.db
      .update(items)
      .set({
        ...(dto.display_name !== undefined
          ? { displayName: dto.display_name }
          : {}),
        ...(dto.category_id !== undefined
          ? { categoryId: dto.category_id }
          : {}),
        ...(dto.active !== undefined ? { active: dto.active } : {}),
      })
      .where(eq(items.id, id))
      .returning();
    return updated;
  }

  /**
   * An item must reference an existing category (spec S1.6: 422 when the
   * category does not exist). We reject before touching the FK so the client
   * gets a clear validation error instead of a raw constraint violation.
   */
  private async assertCategoryExists(categoryId: number): Promise<void> {
    const [category] = await this.db
      .select({ id: categories.id })
      .from(categories)
      .where(eq(categories.id, categoryId))
      .limit(1);
    if (!category) {
      throw new UnprocessableEntityException(
        `Category ${categoryId} does not exist`,
      );
    }
  }

  private async assertItemIdAvailable(itemId: string): Promise<void> {
    const [existing] = await this.db
      .select({ id: items.id })
      .from(items)
      .where(eq(items.itemId, itemId))
      .limit(1);
    if (existing) {
      throw new ConflictException(`item_id "${itemId}" already exists`);
    }
  }
}
