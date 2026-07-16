import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
} from 'class-validator';

/** Opaque item identifier: letters, digits, `_` and `-` only — no spaces. */
export const ITEM_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

export class CreateItemDto {
  // Opaque business key (e.g. "caixaNatal2026"). Unique and immutable after
  // creation — historical sales reference it (spec §3, §4).
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  @Matches(ITEM_ID_PATTERN, {
    message:
      'item_id must be an opaque identifier: letters, digits, "_" or "-", no spaces',
  })
  item_id!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  display_name!: string;

  @IsInt()
  @Min(1)
  category_id!: number;

  @IsOptional()
  @IsBoolean()
  active?: boolean;
}
