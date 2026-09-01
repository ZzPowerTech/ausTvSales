import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, Matches } from 'class-validator';
import { DATE_PATTERN } from '../../analytics/dto/period-query.dto';
import { MONTH_PATTERN } from '../../retention/dto/retention-query.dto';

/**
 * Window for the revenue report (story S9.1, E1).
 *
 * Days, not months, because the window applies to `purchased_at` and a campaign
 * is measured in days. Unset means "everything" — which is a legitimate question
 * for revenue (unlike for the funnel, where an unbounded window would widen a
 * scan on the game machine; `sales` is our own table).
 */
export class RevenueQueryDto {
  @ApiPropertyOptional({
    example: '2026-03-01',
    description: 'Primeiro dia da janela, em America/Sao_Paulo.',
  })
  @IsOptional()
  @Matches(DATE_PATTERN, { message: 'from must be a YYYY-MM-DD date' })
  from?: string;

  @ApiPropertyOptional({
    example: '2026-03-31',
    description: 'Ultimo dia da janela, inclusive.',
  })
  @IsOptional()
  @Matches(DATE_PATTERN, { message: 'to must be a YYYY-MM-DD date' })
  to?: string;
}

/**
 * Cohort window for the first-spend report (story S9.1, E2).
 *
 * Months, because a cohort **is** a month — the same reasoning as
 * `RetentionQueryDto`, and the same pattern is reused rather than restated.
 */
export class FirstSpendQueryDto {
  @ApiPropertyOptional({
    example: '2026-01',
    description: 'Primeiro mes de coorte.',
  })
  @IsOptional()
  @Matches(MONTH_PATTERN, { message: 'from must be a YYYY-MM month' })
  from?: string;

  @ApiPropertyOptional({
    example: '2026-08',
    description: 'Ultimo mes de coorte, inclusive.',
  })
  @IsOptional()
  @Matches(MONTH_PATTERN, { message: 'to must be a YYYY-MM month' })
  to?: string;
}
