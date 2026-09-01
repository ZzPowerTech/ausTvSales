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
import { FirstSpendQueryDto, RevenueQueryDto } from './dto/revenue-query.dto';
import { EconomyService } from './economy.service';
import type { EconomyRevenueReport, FirstSpendReport } from './economy.types';

/** Default cohort window for E2 when the caller gives none. */
const DEFAULT_COHORT_MONTHS = 12;

/**
 * The economy layer — E1 and E2 (story S9.1, spec §6.4).
 *
 * ## Behind the global guard, and that is the §8 requirement
 *
 * Nothing here is `@Public()`, so the deny-by-default `SessionAuthGuard` lets
 * through only the ids on `ALLOWED_DISCORD_IDS`. Spec §8 is explicit that
 * *"nome de jogador e valor de transação não aparecem no site público sob
 * nenhuma circunstância"*, and while these two routes publish **aggregates**
 * rather than per-player values, revenue by platform is still a business figure
 * that has no reason to be readable from the internet.
 *
 * ## No player identity in either response
 *
 * Both endpoints read `player_uuid` — to derive `platform` (ADR-003) and to join
 * the cohort — and publish only counts, months, platforms and money. A uuid
 * never reaches either contract.
 */
@ApiTags('Economia')
@DashboardThrottle()
@Controller('economy')
export class EconomyController {
  constructor(private readonly economy: EconomyService) {}

  @Get('revenue')
  @ApiOperation({
    summary: 'E1 — receita por plataforma e por coorte de registro',
    description:
      'Receita por plataforma sai do proprio uuid da venda (ADR-003) e **nao ' +
      'depende de ETL nenhum**. A quebra por coorte depende da dimensao de ' +
      'jogador; sem ela, `byCohort` vem `null` com o motivo, nunca uma lista ' +
      'vazia. Vendas com `historical_import` ficam fora de todo numero e sao ' +
      'republicadas em `excludedHistorical` — elas nao tem timestamp real por ' +
      'evento, entao nao podem ser atribuidas a uma janela.',
  })
  @ApiOkResponse({ description: 'Receita por plataforma e coorte.' })
  @Header('Cache-Control', 'no-store')
  revenue(@Query() query: RevenueQueryDto): Promise<EconomyRevenueReport> {
    const { from = null, to = null } = query;

    // Checked here rather than in the DTO because it is a relation between two
    // fields; class-validator would report it against one of them.
    if (from !== null && to !== null && from > to) {
      throw new BadRequestException('from must not be after to');
    }

    return this.economy.revenue(from, to);
  }

  @Get('first-spend')
  @ApiOperation({
    summary: 'E2 — tempo ate o primeiro gasto, por coorte e plataforma',
    description:
      'O denominador e a COORTE, nao os compradores: a fracao que "ja gastou" ' +
      'so significa alguma coisa contra todos os que se registraram. A metade ' +
      'de E2 que cruza gasto com **posicao no funil** vem `null` com o motivo ' +
      'por extenso — nenhuma fonte deste sistema guarda a posicao por jogador, ' +
      'e criar essa fonte alarga a superficie de dado pessoal da secao 8.',
  })
  @ApiOkResponse({ description: 'Tempo ate o primeiro gasto por coorte.' })
  @Header('Cache-Control', 'no-store')
  firstSpend(@Query() query: FirstSpendQueryDto): Promise<FirstSpendReport> {
    const to = query.to ?? currentMonth();
    const from = query.from ?? monthsBefore(to, DEFAULT_COHORT_MONTHS);

    if (from > to) {
      throw new BadRequestException('from must not be after to');
    }

    return this.economy.firstSpend(from, to);
  }
}

/** Current cohort month in America/Sao_Paulo. */
function currentMonth(): string {
  // Reuses the tutorial module's guarded formatter rather than building a
  // second one — see the note in the retention controller.
  return (toSaoPauloDay(Date.now()) ?? '1970-01').slice(0, 7);
}

/** `YYYY-MM` arithmetic that never goes through a day that could roll over. */
function monthsBefore(month: string, months: number): string {
  const [year, monthIndex] = month.split('-').map(Number);
  const zeroBased = year * 12 + (monthIndex - 1) - months;
  const targetYear = Math.floor(zeroBased / 12);
  const targetMonth = zeroBased - targetYear * 12 + 1;
  return `${String(targetYear).padStart(4, '0')}-${String(targetMonth).padStart(2, '0')}`;
}
