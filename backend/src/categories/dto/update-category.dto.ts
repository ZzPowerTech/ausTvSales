import { Transform } from 'class-transformer';
import { IsInt, IsNotEmpty, IsOptional, IsString, Min } from 'class-validator';

/**
 * Partial update for a category. Every field is optional, but at least one is
 * required (enforced in the service) so a no-op PATCH is rejected explicitly.
 */
export class UpdateCategoryDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  name?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  display_order?: number;
}
