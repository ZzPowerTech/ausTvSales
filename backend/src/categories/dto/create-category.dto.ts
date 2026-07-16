import { Transform } from 'class-transformer';
import { IsInt, IsNotEmpty, IsOptional, IsString, Min } from 'class-validator';

export class CreateCategoryDto {
  @IsString()
  @IsNotEmpty()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  name!: string;

  // Optional ordering hint for the dashboard sidebar; defaults to 0 in the DB.
  @IsOptional()
  @IsInt()
  @Min(0)
  display_order?: number;
}
