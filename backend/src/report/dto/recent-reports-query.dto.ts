import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';

/** Enough to see a quarter of weekly runs without paging. */
export const DEFAULT_REPORT_LIMIT = 10;

/** Ceiling, so one request cannot pull an unbounded append-only table. */
export const MAX_REPORT_LIMIT = 100;

/** Query for the recent weekly reports (story S9.2). */
export class RecentReportsQueryDto {
  // Query strings arrive as text and the validation pipe does not enable
  // implicit conversion, so coerce explicitly before @IsInt runs — the same
  // pattern `CheckHistoryQueryDto` established.
  @ApiPropertyOptional({
    minimum: 1,
    maximum: MAX_REPORT_LIMIT,
    default: DEFAULT_REPORT_LIMIT,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_REPORT_LIMIT)
  limit?: number;
}
