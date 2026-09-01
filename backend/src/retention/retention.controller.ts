import {
  BadRequestException,
  Controller,
  Get,
  Header,
  Query,
} from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { DashboardThrottle } from '../config/throttling';
import { toSaoPauloDay } from '../tutorial/tutorial-day';
import { RetentionQueryDto } from './dto/retention-query.dto';
import { RetentionService } from './retention.service';
import type { RetentionReport } from './retention.types';

/** Default window when the caller gives none: the last 13 cohort months. */
const DEFAULT_WINDOW_MONTHS = 12;

/**
 * Cohort retention by month × platform (story S8.2, spec §6.2).
 *
 * ## Behind the global guard, like everything that is not `@Public()`
 *
 * `SessionAuthGuard` is registered as an `APP_GUARD` and denies by default, so
 * this route is reachable only by the two Discord ids on `ALLOWED_DISCORD_IDS`.
 * That is worth stating rather than assuming: retention by platform is a
 * business number, and the absence of a decorator is what keeps it private.
 *
 * ## No player data leaves here
 *
 * Counts, months and platforms. The uuid of each row is read once to derive
 * `platform` (ADR-003) and dropped inside the aggregation — spec §8 keeps player
 * identity out of this contract.
 *
 * ## Every percentage arrives with its base, and the base is per horizon
 *
 * `RetentionMeasure` carries `percent`, `n` and `survived` as a set that exists
 * or does not exist together, so a ratio without its denominator is
 * unrepresentable. The `n` differs between D1, D7 and D30 of the same cohort,
 * because a player registered last week has had the opportunity to survive one
 * day and not thirty — printing one cohort-level `n` beside three percentages
 * would be wrong for two of them.
 */
@ApiTags('Retencao')
@DashboardThrottle()
@Controller('retention')
export class RetentionController {
  constructor(private readonly retention: RetentionService) {}

  @Get('cohorts')
  @ApiOperation({
    summary: 'Retencao D1/D7/D30 por coorte mensal e plataforma',
    description:
      'Intervalo de sobrevivencia, **nao** retorno no dia N — o campo ' +
      '`semantics` da resposta traz o rotulo por extenso, e ele e parte do ' +
      'contrato. Coortes pequenas vem marcadas (`belowMinimum`), nunca ' +
      'escondidas; coortes contaminadas por carimbo de importacao vem com ' +
      '`percent: null` e o motivo, nunca com os ~100% que o carimbo produz.',
  })
  @ApiOkResponse({ description: 'Coortes de retencao.' })
  @Header('Cache-Control', 'no-store')
  cohorts(@Query() query: RetentionQueryDto): Promise<RetentionReport> {
    const to = query.to ?? currentMonth();
    const from = query.from ?? monthsBefore(to, DEFAULT_WINDOW_MONTHS);

    // Checked here rather than in the DTO because it is a relation between two
    // fields; class-validator would report it against one of them, which reads
    // as "your `from` is malformed" when both are perfectly well formed.
    if (from > to) {
      throw new BadRequestException('from must not be after to');
    }

    return this.retention.report(from, to, query.platform ?? 'all');
  }
}

/**
 * Current cohort month in America/Sao_Paulo.
 *
 * Note there is no window cap here, unlike the funnel. The funnel's cap protects
 * the game machine from a widening SQL scan; this module issues **one** request
 * for the whole payload regardless of the window, and the window only decides
 * which cohorts are rendered. A cap would cost the caller reach and protect
 * nothing.
 */
function currentMonth(): string {
  // Reuses the tutorial module's formatter rather than building a second one:
  // that one is guarded at load against a `small-icu` Node, and a private
  // `year + month` formatter here would be the one place in the codebase that
  // silently renders `09/2026` on such a runtime.
  return (toSaoPauloDay(Date.now()) ?? '1970-01').slice(0, 7);
}

/** `YYYY-MM` arithmetic that does not go through Date, so no day rolls over. */
function monthsBefore(month: string, months: number): string {
  const [year, monthIndex] = month.split('-').map(Number);
  const zeroBased = year * 12 + (monthIndex - 1) - months;
  const targetYear = Math.floor(zeroBased / 12);
  const targetMonth = zeroBased - targetYear * 12 + 1;
  return `${String(targetYear).padStart(4, '0')}-${String(targetMonth).padStart(2, '0')}`;
}
