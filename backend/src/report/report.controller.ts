import {
  Controller,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  ParseIntPipe,
  Post,
  Query,
} from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  DashboardThrottle,
  ManualRunThrottle,
  MANUAL_RUN_THROTTLE_LIMIT,
} from '../config/throttling';
import { RecentReportsQueryDto } from './dto/recent-reports-query.dto';
import { WeeklyReportService } from './weekly-report.service';
import type { WeeklyReportRecord } from './weekly-report.types';

/**
 * Reading and triggering the weekly report (story S9.2).
 *
 * ## Behind the global guard
 *
 * Nothing here is `@Public()`, so `SessionAuthGuard` denies by default and only
 * the ids on `ALLOWED_DISCORD_IDS` get through. Worth stating rather than
 * assuming: the manual-run route causes an outbound message to a Discord
 * channel, and an unauthenticated caller who could fire it would own the
 * channel's noise floor.
 *
 * ## Why a manual trigger exists at all
 *
 * The story's Definition of Done is *"um relatório real gerado e conferido à
 * mão"*. Waiting for a Monday to satisfy that would make the check itself a
 * weekly-cadence activity, and the epic's own history says the checks that only
 * happen on a schedule are the ones that never happen.
 */
@ApiTags('Relatorios')
@Controller('reports')
export class ReportController {
  constructor(private readonly reports: WeeklyReportService) {}

  @Get('weekly/latest')
  @DashboardThrottle()
  @ApiOperation({
    summary: 'O relatorio semanal mais recente, qualquer que seja o estado',
    description:
      'Inclui os runs com `status: error` — um run que falhou tambem e ' +
      'noticia, e esconde-lo faria "o job quebrou" parecer "a semana foi ' +
      'tranquila".',
  })
  @ApiOkResponse({ description: 'Ultimo relatorio gerado.' })
  @Header('Cache-Control', 'no-store')
  async latest(): Promise<WeeklyReportRecord> {
    const record = await this.reports.latest();
    if (record === null) {
      // 404 rather than an empty object: "nenhum relatorio foi gerado ainda" is
      // a real and important state, and an empty 200 would read as a report
      // with nothing in it.
      throw new NotFoundException('nenhum relatorio semanal foi gerado ainda');
    }
    return record;
  }

  @Get('weekly')
  @DashboardThrottle()
  @ApiOperation({
    summary: 'Relatorios semanais recentes, do mais novo para o mais velho',
  })
  @ApiOkResponse({ description: 'Relatorios recentes.' })
  @Header('Cache-Control', 'no-store')
  recent(@Query() query: RecentReportsQueryDto): Promise<WeeklyReportRecord[]> {
    return this.reports.recent(query.limit ?? 10);
  }

  @Get('weekly/:id')
  @DashboardThrottle()
  @ApiOperation({ summary: 'Um relatorio semanal pelo id' })
  @ApiOkResponse({ description: 'O relatorio pedido.' })
  @Header('Cache-Control', 'no-store')
  async byId(
    @Param('id', ParseIntPipe) id: number,
  ): Promise<WeeklyReportRecord> {
    const record = await this.reports.byId(id);
    if (record === null) {
      throw new NotFoundException(`relatorio ${id} nao existe`);
    }
    return record;
  }

  @Post('weekly/run')
  // `ManualRunThrottle` and not a bare `@Throttle`: the guard is not global in
  // this app, so the decorator alone is metadata that enforces nothing — which
  // is what shipped here first, on the one route with outbound side effects.
  @ManualRunThrottle()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Gera, persiste e entrega um relatorio semanal agora',
    description:
      'Faz exatamente o que o job agendado faz, inclusive publicar no canal — ' +
      'e o que atende o DoD da historia ("um relatorio real gerado e ' +
      `conferido a mao"). Limitado a ${MANUAL_RUN_THROTTLE_LIMIT} execucoes por ` +
      'hora, porque cada uma consulta o Plan na maquina do jogo e manda uma ' +
      'mensagem no Discord.',
  })
  @Header('Cache-Control', 'no-store')
  run(): Promise<WeeklyReportRecord> {
    return this.reports.run();
  }
}
