import {
  Controller,
  Get,
  Header,
  HttpException,
  HttpStatus,
  Param,
} from '@nestjs/common';
import {
  ApiOkResponse,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { DashboardThrottle } from '../config/throttling';
import { ServerNameParamDto } from './dto/server-name-param.dto';
import type {
  ConfiguredServersDto,
  ServerActivityResponseDto,
  ServerOverviewResponseDto,
} from './dto/metrics.dto';
import {
  ConfiguredServersDto as ConfiguredServersSchema,
  ServerActivityResponseDto as ServerActivitySchema,
  ServerOverviewResponseDto as ServerOverviewSchema,
} from './dto/metrics.dto';
import { MetricsService, type MetricsRead } from './metrics.service';

/**
 * Normalised reads of the game network (story S7.2, issue #111).
 *
 * ## Degradation is a status code AND a body, never a silence
 *
 * When Plan cannot be reached the response is **503**, and the body is the same
 * envelope a 200 carries. Criterion 3 of the story asks for exactly that: an
 * explicit body with the last cached value marked stale, and never an invented
 * zero.
 *
 * The two degraded cases differ only in `data`:
 *
 * | situation | status | `data` | `freshness.stale` |
 * |---|---|---|---|
 * | served from cache, inside TTL | 200 | value | false |
 * | fetched from Plan | 200 | value | false |
 * | Plan failed, previous value exists | **503** | value | **true** |
 * | Plan failed, nothing cached | **503** | **null** | false |
 *
 * A 503 carrying usable data looks odd until the two audiences are separated: a
 * monitor sees a degraded service, and a human still gets the last known reading
 * with the age it actually has. Changing the shape between the two would force a
 * consumer to parse two contracts, and would tempt it to discard a perfectly
 * usable stale value in favour of an empty page.
 *
 * `freshness.stale` is `false` in the last row on purpose. There is nothing to be
 * stale about — no value was served. `data: null` is the whole message.
 *
 * ## No player data
 *
 * Everything here is aggregate: counts, durations and timestamps for a server.
 * No uuid, no nickname, no IP. That is a property of the endpoints consumed
 * (`serverOverview` and `onlineOverview` are server-level), not of a filter
 * applied on the way out — `/v1/playersTable` and `/v1/player` are deliberately
 * not among them.
 */
@ApiTags('Metricas da rede')
@DashboardThrottle()
@Controller('metrics')
export class MetricsController {
  constructor(private readonly metrics: MetricsService) {}

  @Get('servers')
  @ApiOperation({
    summary: 'Instancias do Plan que esta API le',
    description:
      'Configuracao, nao descoberta: o Plan nao expoe catalogo de servidores ' +
      '(`/v1/servers` e `/v1/networkOverview` respondem 404). Um servidor ' +
      'ausente daqui e erro de deploy, nao lacuna silenciosa.',
  })
  @ApiOkResponse({ type: ConfiguredServersSchema })
  @Header('Cache-Control', 'no-store')
  servers(): ConfiguredServersDto {
    return this.metrics.configuredServers();
  }

  @Get('servers/:server')
  @ApiOperation({
    summary: 'Visao pontual de um servidor',
    description:
      'Jogadores online agora, totais historicos e a janela de 7 dias. Todo ' +
      'numero pode vir `null`, que significa "o Plan nao informou" — nunca ' +
      'zero, que significaria "medimos, e deu zero".',
  })
  @ApiOkResponse({ type: ServerOverviewSchema })
  @ApiResponse({
    status: 404,
    description: 'Nome fora de `PLAN_SERVERS`; nenhuma requisicao sai daqui.',
  })
  @ApiResponse({
    status: 503,
    type: ServerOverviewSchema,
    description:
      'Plan inalcancavel. Corpo com o mesmo formato: ultimo valor marcado ' +
      '`stale`, ou `data: null` quando nao ha valor guardado.',
  })
  @Header('Cache-Control', 'no-store')
  async serverOverview(
    @Param() { server }: ServerNameParamDto,
  ): Promise<ServerOverviewResponseDto> {
    return unwrap(await this.metrics.serverOverview(server));
  }

  @Get('servers/:server/activity')
  @ApiOperation({
    summary: 'Atividade de um servidor em 24h, 7d e 30d',
    description:
      'Chegadas, jogadores unicos, sessoes, playtime e retencao de novatos. ' +
      'Toda razao vem com a base ao lado (`value` e `n`) — o contrato nao ' +
      'publica percentual sem base.',
  })
  @ApiOkResponse({ type: ServerActivitySchema })
  @ApiResponse({
    status: 404,
    description: 'Nome fora de `PLAN_SERVERS`; nenhuma requisicao sai daqui.',
  })
  @ApiResponse({
    status: 503,
    type: ServerActivitySchema,
    description:
      'Plan inalcancavel. Corpo com o mesmo formato: ultimo valor marcado ' +
      '`stale`, ou `data: null` quando nao ha valor guardado.',
  })
  @Header('Cache-Control', 'no-store')
  async serverActivity(
    @Param() { server }: ServerNameParamDto,
  ): Promise<ServerActivityResponseDto> {
    return unwrap(await this.metrics.serverActivity(server));
  }
}

/**
 * Return the body, or raise it as a 503 carrying the very same body.
 *
 * `HttpException` with an object sends it verbatim, which is what keeps the
 * degraded response the same shape as the healthy one. A
 * `ServiceUnavailableException` would wrap it in `{statusCode, message}` and
 * break that.
 */
function unwrap<T>(read: MetricsRead<T>): T {
  if (read.degraded) {
    throw new HttpException(
      read.body as Record<string, unknown>,
      HttpStatus.SERVICE_UNAVAILABLE,
    );
  }
  return read.body;
}
