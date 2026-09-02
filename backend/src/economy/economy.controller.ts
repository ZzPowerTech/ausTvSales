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
import {
  DEFAULT_FEED_LIMIT,
  DEFAULT_FEED_WINDOW_DAYS,
  PaymentsFeedQueryDto,
  SocialContactQueryDto,
} from './dto/social-query.dto';
import {
  AccountCreationsService,
  type AccountCreationsReport,
} from './account-creations.service';
import { EconomyService } from './economy.service';
import { PaymentsFeedService } from './payments-feed.service';
import { SocialService } from './social.service';
import type { EconomyRevenueReport, FirstSpendReport } from './economy.types';
import type { PaymentsFeedReport, SocialContactReport } from './social.types';

/** Default cohort window for E2 when the caller gives none. */
const DEFAULT_COHORT_MONTHS = 12;

/** Default window for the arrivals series: a year of daily points. */
const DEFAULT_CREATIONS_WINDOW_DAYS = 365;
const MS_PER_DAY = 86_400_000;

/**
 * The economy layer — E1, E2, E3, E4 and the R1 arrivals series (story S9.1,
 * spec §6.4).
 *
 * ## Behind the global guard, and that is the §8 requirement
 *
 * Nothing here is `@Public()`, so the deny-by-default `SessionAuthGuard` lets
 * through only the ids on `ALLOWED_DISCORD_IDS`. Spec §8 is explicit that
 * *"nome de jogador e valor de transação não aparecem no site público sob
 * nenhuma circunstância"*, and the payments feed publishes exactly that pair —
 * so the absence of a decorator is not a convention here, it is the control.
 *
 * ## What each route does and does not carry
 *
 * `revenue`, `first-spend`, `social-contact` and `account-creations` publish
 * **aggregates only**: counts, months, platforms, money and days. They read
 * `player_uuid` to derive `platform` (ADR-003) and to join the cohort, and drop
 * it inside the aggregation.
 *
 * `payments/feed` is the exception, and it is deliberate: E4 is a moderation
 * tool, so it publishes **per-player uuids and transaction amounts**. Spec §6.4
 * bounds that to "nenhum dado pessoal além de UUID e valor", which it respects —
 * no nickname, no IP. It is the reason this controller must never gain a
 * `@Public()` route, and the reason a future reader should check this paragraph
 * before relaxing anything here.
 *
 * ⚠️ An earlier version of this docblock said "E1 and E2", "these two routes"
 * and "a uuid never reaches either contract". All three were true when written
 * and none survived the social slice.
 */
@ApiTags('Economia')
@DashboardThrottle()
@Controller('economy')
export class EconomyController {
  constructor(
    private readonly economy: EconomyService,
    private readonly social: SocialService,
    private readonly paymentsFeed: PaymentsFeedService,
    private readonly accountCreations: AccountCreationsService,
  ) {}

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

  @Get('social-contact')
  @ApiOperation({
    summary: 'E3 — contato social nos primeiros minutos, e o D7 desse grupo',
    description:
      'Pagamento entre jogadores e registro de contato social real. Tres ' +
      'grupos: quem teve interacao espontanea, quem so teve o pagamento do ' +
      'passo `10tutorial` (separado por ASSINATURA DE VALOR, que e heuristica ' +
      'e vem rotulada como tal) e quem nao teve nenhum. O D7 e **intervalo de ' +
      'sobrevivencia**, nao retorno no setimo dia, e o rotulo viaja no payload. ' +
      'A amostra e pequena por construcao (R4: ~3 pagamentos/dia) — por isso ' +
      'todo grupo publica o `n` ao lado do percentual.',
  })
  @ApiOkResponse({ description: 'Contato social por grupo.' })
  @Header('Cache-Control', 'no-store')
  socialContact(
    @Query() query: SocialContactQueryDto,
  ): Promise<SocialContactReport> {
    const to = query.to ?? currentMonth();
    const from = query.from ?? monthsBefore(to, DEFAULT_COHORT_MONTHS);

    if (from > to) {
      throw new BadRequestException('from must not be after to');
    }

    return this.social.contact(from, to);
  }

  @Get('account-creations')
  @ApiOperation({
    summary: 'R1 — serie de criacao de conta, para reconciliar o funil',
    description:
      'Sinal de chegada **independente do Plan**: o PlayerPoints escreveu uma ' +
      'linha `SET` para cada conta criada durante todo o apagao do proxy de ' +
      'mai-jul/2026, que o funil nao cobre. Nao e um degrau do funil e o ' +
      'campo `caveat` diz por que: conta contas, nao chegadas.',
  })
  @ApiOkResponse({ description: 'Serie diaria de criacao de conta.' })
  @Header('Cache-Control', 'no-store')
  accountCreationsRoute(
    @Query() query: RevenueQueryDto,
  ): Promise<AccountCreationsReport> {
    const to = query.to ?? today();
    const from = query.from ?? daysBefore(to, DEFAULT_CREATIONS_WINDOW_DAYS);

    if (from > to) {
      throw new BadRequestException('from must not be after to');
    }

    return this.accountCreations.series(from, to);
  }

  @Get('payments/feed')
  @ApiOperation({
    summary: 'E4 — feed de pagamentos com marcacao de anomalia (admin)',
    description:
      'Ferramenta de moderacao, nao metrica. Cada marca publica o que foi ' +
      'observado e contra que limiar, porque **marcar e sinalizacao, nunca ' +
      'acusacao automatica** — a decisao e humana. As marcas sao calculadas ' +
      'sobre a JANELA inteira, nunca sobre a pagina. Os quatro limiares sao ' +
      'chutes nao calibrados e vem no payload para poderem ser julgados.',
  })
  @ApiOkResponse({ description: 'Feed de pagamentos.' })
  @Header('Cache-Control', 'no-store')
  paymentsFeedRoute(
    @Query() query: PaymentsFeedQueryDto,
  ): Promise<PaymentsFeedReport> {
    return this.paymentsFeed.feed(
      query.days ?? DEFAULT_FEED_WINDOW_DAYS,
      query.limit ?? DEFAULT_FEED_LIMIT,
    );
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

/** Today in America/Sao_Paulo. */
function today(): string {
  return toSaoPauloDay(Date.now()) ?? '1970-01-01';
}

/** `YYYY-MM-DD`, `days` earlier, anchored at midday to dodge any DST edge. */
function daysBefore(day: string, days: number): string {
  const anchor = Date.parse(`${day}T12:00:00-03:00`) - days * MS_PER_DAY;
  return toSaoPauloDay(anchor) ?? day;
}
