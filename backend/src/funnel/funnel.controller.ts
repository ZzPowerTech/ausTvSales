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
      'Mesma serie agregada por mes. A janela maxima e a mesma — 366 dias — ' +
      'entao um pedido longo devolve ate 13 meses.',
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

    // Checked here rather than in the DTO because it is a relation between two
    // fields, and class-validator would report it against one of them — which
    // reads as "your `from` is malformed" when both are perfectly well formed.
    if (from > to) {
      throw new BadRequestException('from must not be after to');
    }

    return this.funnel.series(granularity, from, to, query.platform ?? 'all');
  }
}

/** Today in America/Sao_Paulo, as `YYYY-MM-DD`. */
function today(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

function daysBefore(day: string, days: number): string {
  const anchor = Date.parse(`${day}T12:00:00-03:00`) - days * MS_PER_DAY;
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(anchor));
}
