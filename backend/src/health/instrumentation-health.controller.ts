import {
  Controller,
  Get,
  Header,
  Param,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiOkResponse,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import { dashboardThrottle } from '../config/throttling';
import {
  CheckHistoryQueryDto,
  DEFAULT_HISTORY_LIMIT,
} from './dto/check-history-query.dto';
import { CheckNameParamDto } from './dto/check-name-param.dto';
import {
  HealthCheckHistoryDto,
  HealthCheckListDto,
  InstrumentationSummaryDto,
} from './dto/instrumentation-health.dto';
import { InstrumentationHealthService } from './instrumentation-health.service';

/**
 * `no-store` on every route here.
 *
 * A cached health answer is worse than no answer: it speaks with confidence
 * about a moment that has passed, which is the shape of every failure this epic
 * exists to remove. Repeated per route because `@Header` is a method decorator —
 * Nest has no class-level form.
 */
const NO_STORE = () => Header('Cache-Control', 'no-store');

/**
 * On-demand read of the instrumentation-health verdicts (story S7.1, #110).
 *
 * ## Under the session, including the aggregate
 *
 * Nothing here is `@Public()`, so the global `SessionAuthGuard` answers 401 to
 * anything without a valid session — criterion 3 of the story, and the same
 * deny-by-default posture as the rest of the API.
 *
 * That does collide with criterion 2, which calls {@link summary} an endpoint
 * "para uso externo (uptime check)": an uptime monitor cannot complete a Discord
 * OAuth flow, so in practice it needs a session cookie minted by hand. The
 * collision is recorded rather than resolved by opening a hole — a public
 * endpoint that reports whether the game network is being measured is free
 * reconnaissance, and inventing a second credential scheme is a decision for the
 * owner, not a side effect of this story. The shape is machine-friendly
 * regardless, so it costs nothing to keep it closed until that decision exists.
 *
 * ## Rate limited, and the reason is not abuse
 *
 * The dashboard profile is applied here (`ThrottlerGuard` + `@Throttle`). It is
 * generous enough that an operator never meets it; what it bounds is a leaked
 * session cookie, and a runaway polling loop in the frontend — which would turn
 * into load on the Plan behind the cache, on the machine that runs the game.
 *
 * ## Read-only, deliberately
 *
 * There is no route to trigger a cycle. One cycle is an HTTP request per
 * configured server against the Plan on the game VPS, and spec §8 lists "query
 * pesada afeta o jogo" as a real risk. A button that hammers the game server is
 * not an ops convenience just because it has a login in front of it.
 *
 * ## No player data
 *
 * Verdicts carry server names, windows and build ids. `detail.context` is
 * contractually limited to those — see `HealthCheckDetail` — so criterion 3's
 * "nenhum dado de jogador" holds by the shape of what is stored, not by
 * filtering on the way out.
 *
 * That last clause is the load-bearing one, and it cuts both ways: **nothing is
 * filtered here.** `HealthCheckRunner` writes the message of an escaped
 * exception straight into `detail.summary`, so a `PlanApiError` can carry the
 * Plan host, and a pg error can carry connection detail. Behind the session and
 * the two-person allowlist that is acceptable and is the more useful behaviour —
 * an operator debugging a dead check wants the real reason. It stops being
 * acceptable the moment any of this is served to a wider audience, and that is
 * the change that would have to add the filter.
 */
@ApiTags('Saude da instrumentacao')
@UseGuards(ThrottlerGuard)
@Throttle(dashboardThrottle)
@ApiResponse({
  status: 429,
  description:
    'Limite de taxa das leituras de dashboard excedido (ver dashboardThrottle).',
})
@Controller('health/instrumentation')
export class InstrumentationHealthController {
  constructor(private readonly health: InstrumentationHealthService) {}

  @Get()
  @ApiOperation({
    summary: 'Veredito agregado da camada de saude',
    description:
      'Responde `unknown` quando nada nunca rodou e `down` quando o ciclo nao ' +
      'esta vivo — agendamento desligado ou ultimo veredito velho demais. ' +
      '`ok` nunca e a resposta padrao na ausencia de mas noticias: foi assim ' +
      'que tres meses de proxy morto pareceram saude.',
  })
  @ApiOkResponse({ type: InstrumentationSummaryDto })
  @NO_STORE()
  summary(): Promise<InstrumentationSummaryDto> {
    return this.health.summary();
  }

  @Get('checks')
  @ApiOperation({
    summary: 'Veredito atual de cada check',
    description:
      'Uma linha por check, sempre a mais recente, ordenada por nome. Nenhum ' +
      'dado de jogador: `detail.context` carrega nome de servidor, janela e ' +
      'id de build.',
  })
  @ApiOkResponse({ type: HealthCheckListDto })
  @NO_STORE()
  checks(): Promise<HealthCheckListDto> {
    return this.health.checks();
  }

  @Get('checks/:name/history')
  @ApiOperation({
    summary: 'Historico de um check, do mais novo para o mais velho',
    description:
      'A tabela e append-only justamente para isto: o ADR-006 existe porque ' +
      'ninguem conseguia responder "desde quando isso esta quebrado?", e o ' +
      'estado atual sozinho continua sem responder.',
  })
  @ApiOkResponse({ type: HealthCheckHistoryDto })
  @NO_STORE()
  history(
    @Param() { name }: CheckNameParamDto,
    @Query() { limit }: CheckHistoryQueryDto,
  ): Promise<HealthCheckHistoryDto> {
    return this.health.history(name, limit ?? DEFAULT_HISTORY_LIMIT);
  }
}
