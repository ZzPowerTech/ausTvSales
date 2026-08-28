import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, Matches } from 'class-validator';
import { DATE_PATTERN } from '../../analytics/dto/period-query.dto';
import { Platform } from '../../instrumentation/platform';

/** Accepted `platform` values. `all` sums every platform. */
export const PLATFORM_VALUES = [
  'all',
  Platform.Bedrock,
  Platform.JavaOffline,
  Platform.JavaPremium,
  Platform.Unknown,
] as const;

/**
 * Query for a funnel series (story S8.1).
 *
 * `from`/`to` are calendar dates in **America/Sao_Paulo**, reusing the pattern
 * the analytics endpoints established. `@IsDateString` is deliberately avoided
 * there and here: it accepts full ISO timestamps, which would let a caller
 * smuggle a time and a timezone past the São Paulo rule.
 *
 * `platform` is an allowlist rather than a free string. Not for injection — the
 * value never reaches SQL as text — but because a typo would otherwise filter to
 * a platform nobody has and return an empty funnel that looks like a collapse.
 */
export class FunnelQueryDto {
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

  @ApiPropertyOptional({
    enum: PLATFORM_VALUES,
    default: 'all',
    description:
      'Plataforma, derivada do UUID (ADR-003). `all` soma todas. Um valor ' +
      'invalido e recusado em vez de filtrar para uma plataforma inexistente, ' +
      'o que devolveria um funil vazio parecido com um colapso.',
  })
  @IsOptional()
  @IsIn(PLATFORM_VALUES, {
    message: `platform must be one of: ${PLATFORM_VALUES.join(', ')}`,
  })
  platform?: (typeof PLATFORM_VALUES)[number];
}
