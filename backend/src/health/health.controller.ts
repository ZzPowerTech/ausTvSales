import { Controller, Get, HttpCode, HttpStatus } from '@nestjs/common';
import { Public } from '../auth/public.decorator';
import { HealthService } from './health.service';
import type { HealthCheckResult } from './health.types';

@Controller('health')
export class HealthController {
  constructor(private readonly healthService: HealthService) {}

  // Liveness/readiness probe for the container and Nginx — must stay reachable
  // without credentials (spec §7, S1.4 explicit public allowlist).
  @Public()
  @Get()
  @HttpCode(HttpStatus.OK)
  check(): Promise<HealthCheckResult> {
    return this.healthService.check();
  }
}
