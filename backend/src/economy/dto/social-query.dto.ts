import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, Matches, Max, Min } from 'class-validator';
import { MONTH_PATTERN } from '../../retention/dto/retention-query.dto';

/** Cohort window for E3. Months, because a cohort is a month. */
export class SocialContactQueryDto {
  @ApiPropertyOptional({ example: '2026-01' })
  @IsOptional()
  @Matches(MONTH_PATTERN, { message: 'from must be a YYYY-MM month' })
  from?: string;

  @ApiPropertyOptional({ example: '2026-08' })
  @IsOptional()
  @Matches(MONTH_PATTERN, { message: 'to must be a YYYY-MM month' })
  to?: string;
}

/** Enough history for a pattern; short enough that a mark still means something. */
export const DEFAULT_FEED_WINDOW_DAYS = 30;
export const MAX_FEED_WINDOW_DAYS = 366;
export const DEFAULT_FEED_LIMIT = 50;
export const MAX_FEED_LIMIT = 200;

/**
 * Window and page size for E4.
 *
 * The window is capped because the anomaly marks are computed over it: a
 * caller asking for ten years would dilute every percentile until nothing is
 * ever an outlier, which fails silently rather than loudly.
 */
export class PaymentsFeedQueryDto {
  @ApiPropertyOptional({
    minimum: 1,
    maximum: MAX_FEED_WINDOW_DAYS,
    default: DEFAULT_FEED_WINDOW_DAYS,
    description:
      'Dias de historico sobre os quais as marcas de anomalia sao calculadas.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_FEED_WINDOW_DAYS)
  days?: number;

  @ApiPropertyOptional({
    minimum: 1,
    maximum: MAX_FEED_LIMIT,
    default: DEFAULT_FEED_LIMIT,
    description:
      'Quantos pagamentos exibir. As marcas continuam sendo calculadas sobre ' +
      'a JANELA INTEIRA, nunca sobre a pagina — uma marca que mudasse de ' +
      'significado com o tamanho da pagina nao serviria para moderar nada.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_FEED_LIMIT)
  limit?: number;
}
