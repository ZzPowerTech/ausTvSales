import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';

/**
 * Partial update for an item. `item_id` is intentionally absent: it is the
 * opaque business key and immutable after creation (spec §3). Deactivation is
 * done through `active = false`, never a physical delete, because historical
 * sales reference the item.
 */
export class UpdateItemDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  display_name?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  category_id?: number;

  @IsOptional()
  @IsBoolean()
  active?: boolean;
}
