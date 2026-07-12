import { Injectable } from '@nestjs/common';
import { HealthCheckResult } from './health.types';

@Injectable()
export class HealthService {
  check(): HealthCheckResult {
    const components = this.checkComponents();
    const status = Object.values(components).includes('error') ? 'error' : 'ok';

    return { status, components };
  }

  private checkComponents(): HealthCheckResult['components'] {
    return {
      database: 'not_configured',
    };
  }
}
