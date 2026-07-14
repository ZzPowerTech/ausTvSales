import { Inject, Injectable, Logger } from '@nestjs/common';
import { Pool } from 'pg';
import { PG_POOL } from '../db/database.module';
import { ComponentStatus, HealthCheckResult } from './health.types';

@Injectable()
export class HealthService {
  private readonly logger = new Logger(HealthService.name);

  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async check(): Promise<HealthCheckResult> {
    const components = {
      database: await this.checkDatabase(),
    };
    const status = Object.values(components).includes('error') ? 'error' : 'ok';

    return { status, components };
  }

  private async checkDatabase(): Promise<ComponentStatus> {
    try {
      await this.pool.query('SELECT 1');
      return 'ok';
    } catch (error) {
      // Log for diagnostics; the response intentionally omits the error detail
      // so /health never leaks connection internals (CWE-209).
      this.logger.error(
        'Database health check failed',
        error instanceof Error ? error.stack : String(error),
      );
      return 'error';
    }
  }
}
