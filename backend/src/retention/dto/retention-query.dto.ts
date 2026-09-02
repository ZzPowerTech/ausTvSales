import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, Matches } from 'class-validator';
import { PLATFORM_VALUES } from '../../instrumentation/platform';

/** `YYYY-MM`, the grain of a cohort. */
export const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

/**
 * Query for a cohort-retention report (story S8.2).
 *
 * The window is expressed in **months**, not days, because a cohort *is* a
 * month: accepting a day range would invite a request for half of March and
 * force a choice between silently widening it and returning a partial cohort,
 * and a partial cohort published as a whole one is the smaller-denominator bug
 * the funnel already shipped once.
 *
 * The pattern anchors both ends and constrains the month to `01`–`12`, so an
 * impossible month is refused here rather than producing an empty report that
 * looks like a data outage.
 */
export class RetentionQueryDto {
  @ApiPropertyOptional({
    example: '2025-09',
    description: 'Primeiro mes de coorte, em America/Sao_Paulo.',
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

  @ApiPropertyOptional({
    enum: PLATFORM_VALUES,
    default: 'all',
    description:
      'Plataforma, derivada do UUID (ADR-003). `all` devolve **uma linha por ' +
      'plataforma**, nunca a soma: o motivo da segmentacao existir e que ' +
      'bedrock e java se comportam diferente, e somar esconderia exatamente ' +
      'isso.',
  })
  @IsOptional()
  @IsIn(PLATFORM_VALUES, {
    message: `platform must be one of: ${PLATFORM_VALUES.join(', ')}`,
  })
  platform?: (typeof PLATFORM_VALUES)[number];
}
