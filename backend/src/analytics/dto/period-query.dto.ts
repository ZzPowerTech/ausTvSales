import { IsOptional, Matches } from 'class-validator';

/** `YYYY-MM-DD` — the only date shape the analytics endpoints accept. */
export const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Shared period filter for every analytics read (spec S5.1 §2.2).
 *
 * `from`/`to` are calendar dates in **America/Sao_Paulo**, both optional, read
 * as the half-open interval `[from 00:00, to+1d 00:00)`. Omitting both means all
 * history. The relational check (`from <= to`) lives in the service so all three
 * routes answer `400` identically — see `AnalyticsService.periodBounds`.
 *
 * `@IsDateString` is deliberately avoided: it accepts full ISO timestamps, which
 * would let a caller smuggle a time and a timezone past the São Paulo rule.
 */
export class PeriodQueryDto {
  @IsOptional()
  @Matches(DATE_PATTERN, { message: 'from must be a YYYY-MM-DD date' })
  from?: string;

  @IsOptional()
  @Matches(DATE_PATTERN, { message: 'to must be a YYYY-MM-DD date' })
  to?: string;
}
