import { Controller, Get, HttpCode, HttpStatus } from '@nestjs/common';
import { HealthService } from './health.service';
import type { HealthCheckResult } from './health.types';

@Controller('health')
export class HealthController {
  constructor(private readonly healthService: HealthService) {}

  @Get()
  @HttpCode(HttpStatus.OK)
  check(): Promise<HealthCheckResult> {
    return this.healthService.check();
  }
}
