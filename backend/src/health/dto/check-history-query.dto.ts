import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';

/** Enough to see a few days of a 15-minute cycle without paging. */
export const DEFAULT_HISTORY_LIMIT = 50;

/** Ceiling, so one request cannot pull an unbounded append-only table. */
export const MAX_HISTORY_LIMIT = 500;

/** Query for the history of a single check (story S7.1, issue #110). */
export class CheckHistoryQueryDto {
  // Query strings arrive as text and the validation pipe does not enable
  // implicit conversion, so coerce explicitly before @IsInt runs — same pattern
  // as `TopBuyersQueryDto`.
  @ApiPropertyOptional({
    minimum: 1,
    maximum: MAX_HISTORY_LIMIT,
    default: DEFAULT_HISTORY_LIMIT,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_HISTORY_LIMIT)
  limit?: number;
}
