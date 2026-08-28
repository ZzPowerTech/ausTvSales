import {
  BadRequestException,
  Controller,
  Get,
  Header,
  Query,
} from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { DashboardThrottle } from '../config/throttling';
import { FunnelQueryDto } from './dto/funnel-query.dto';
import { FunnelService, type FunnelSeries } from './funnel.service';
import { toSaoPauloDay } from '../tutorial/tutorial-day';
import { FunnelGranularity } from './funnel.types';

/** Default window when the caller gives none: the last 30 days. */
const DEFAULT_WINDOW_DAYS = 30;
const MS_PER_DAY = 86_400_000;

/**
 * The four-step funnel (story S8.1, spec §6.2).
 *
 * ## Every percentage arrives with its base
 *
 * Not a convention here — a property of the shape. `Conversion` carries
 * `percent` and `n` as a pair that is set or null together, so a response that
 * published a ratio without its denominator is unrepresentable rather than
 * merely discouraged. The project produced "queda de 96%" and "48 chegadas/mês"
 * over bases nobody could check; this is the fix for that class of number.
 *
 * ## "Sem dados" is a value, not an absence
 *
 * Every count is nullable and every null carries a reason. A step with no source
 * reads as `null` plus an explanation, never as `0` — and `sources` reports each
 * underlying store separately, so a caller can tell a database outage from an
 * empty period.
 *
 * The `survival` step has no daily source yet and says so in every bucket. That
 * is the step whose discovery started the epic, so it is stated loudly rather
 * than quietly omitted.
 *
 * ## No player data
 *
 * Counts and dates only. The network step reads uuids to derive `platform`
 * (ADR-003) and discards them inside the aggregation — nothing identifying
 * reaches this contract, and spec §8 keeps it that way.
 */
@ApiTags('Funil')
@DashboardThrottle()
@Controller('funnel')
export class FunnelController {
  constructor(private readonly funnel: FunnelService) {}

  @Get('daily')
  @ApiOperation({
    summary: 'Funil de 4 degraus, por dia',
    description:
      'Serie diaria de `rede -> survival -> tutorial_entrou -> ' +
      'tutorial_concluiu`. Todo percentual vem com a base ao lado; todo degrau ' +
      'sem fonte vem `null` com o motivo, nunca zero.',
  })
  @ApiOkResponse({ description: 'Serie diaria do funil.' })
  @Header('Cache-Control', 'no-store')
  daily(@Query() query: FunnelQueryDto): Promise<FunnelSeries> {
    return this.read(FunnelGranularity.Daily, query);
  }

  @Get('monthly')
  @ApiOperation({
    summary: 'Funil de 4 degraus, por mes',
    description:
      'Mesma serie agregada por mes. A janela maxima e a mesma **em dias** ' +
      '(366), entao um pedido longo devolve no maximo 13 meses e a resposta ' +
      'marca `truncated: true`.',
  })
  @ApiOkResponse({ description: 'Serie mensal do funil.' })
  @Header('Cache-Control', 'no-store')
  monthly(@Query() query: FunnelQueryDto): Promise<FunnelSeries> {
    return this.read(FunnelGranularity.Monthly, query);
  }

  private read(
    granularity: FunnelGranularity,
    query: FunnelQueryDto,
  ): Promise<FunnelSeries> {
    const to = query.to ?? today();
    const from =
      query.from ??
      daysBefore(
        to,
        granularity === FunnelGranularity.Monthly ? 365 : DEFAULT_WINDOW_DAYS,
      );

    // `DATE_PATTERN` checks the *shape*, so `2026-01-45` and `2026-02-30` get
    // through it. Two different bad outcomes follow, and both are closed here:
    //
    // - `2026-01-45` parses to `NaN`, reaches the driver, and comes back a query
    //   error — which the service labels `query_failed` and publishes as a source
    //   outage. A client typo would read as the game database being down, in a
    //   system whose whole premise is that a failure signal means something.
    // - `2026-02-30` **parses fine**, silently rolling to 2026-03-02. The window
    //   shifts, `truncated` stays false, and a date that does not exist is echoed
    //   back in the envelope. Seven of these exist per year.
    //
    // The round-trip catches both: a real date renders back as itself.
    for (const [field, value] of [
      ['from', from],
      ['to', to],
    ] as const) {
      if (toSaoPauloDay(Date.parse(atMidday(value))) !== value) {
        throw new BadRequestException(`${field} is not a real calendar date`);
      }
    }

    // Checked here rather than in the DTO because it is a relation between two
    // fields, and class-validator would report it against one of them — which
    // reads as "your `from` is malformed" when both are perfectly well formed.
    if (from > to) {
      throw new BadRequestException('from must not be after to');
    }

    return this.funnel.series(granularity, from, to, query.platform ?? 'all');
  }
}

/** Midday anchor — same fixed offset as the service; see its note there. */
function atMidday(day: string): string {
  return `${day}T12:00:00-03:00`;
}

/** Today in America/Sao_Paulo, as `YYYY-MM-DD`. */
function today(): string {
  return toSaoPauloDay(Date.now()) ?? '1970-01-01';
}

function daysBefore(day: string, days: number): string {
  const anchor = Date.parse(atMidday(day)) - days * MS_PER_DAY;
  return toSaoPauloDay(anchor) ?? day;
}
