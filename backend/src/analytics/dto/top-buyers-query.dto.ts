import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';
import { PeriodQueryDto } from './period-query.dto';

/** Default ranking size — CA4 asks for the top 5. */
export const DEFAULT_TOP_BUYERS_LIMIT = 5;

/**
 * Top-buyers query (spec S5.1 §2.1). Inherits the period filter and adds an
 * optional `limit`, capped so a caller cannot ask for an unbounded ranking.
 */
export class TopBuyersQueryDto extends PeriodQueryDto {
  // Query strings arrive as text; the validation pipe does not enable implicit
  // conversion, so coerce explicitly before @IsInt runs.
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number;
}
