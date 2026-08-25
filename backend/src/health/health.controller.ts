import { Controller, Get, HttpCode, HttpStatus } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '../auth/public.decorator';
import { HealthService } from './health.service';
import type { HealthCheckResult } from './health.types';

@ApiTags('Saude do processo')
@Controller('health')
export class HealthController {
  constructor(private readonly healthService: HealthService) {}

  // Liveness/readiness probe for the container and Nginx — must stay reachable
  // without credentials (spec §7, S1.4 explicit public allowlist).
  @Public()
  @ApiOperation({
    summary: 'Liveness do proprio processo',
    description:
      'Responde se ESTA API esta de pe — nao diz nada sobre a coleta de dados ' +
      'da rede de jogo. Publica porque o Nginx e o container precisam alcanca-la ' +
      'sem credencial.',
    security: [],
  })
  @Get()
  @HttpCode(HttpStatus.OK)
  check(): Promise<HealthCheckResult> {
    return this.healthService.check();
  }
}
