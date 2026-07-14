import {
  Global,
  Inject,
  Logger,
  Module,
  OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from './schema';

/** Injection token for the raw pg connection pool. */
export const PG_POOL = Symbol('PG_POOL');

/** Injection token for the Drizzle database instance. */
export const DRIZZLE = Symbol('DRIZZLE');

/** Typed Drizzle instance bound to the austv-sales schema. */
export type DrizzleDB = ReturnType<typeof drizzle<typeof schema>>;

@Global()
@Module({
  providers: [
    {
      provide: PG_POOL,
      inject: [ConfigService],
      useFactory: (config: ConfigService): Pool =>
        new Pool({
          connectionString: config.getOrThrow<string>('DATABASE_URL'),
          // Bound waits so a bad/unreachable DB fails fast instead of hanging,
          // and idle connections are reclaimed instead of leaking.
          connectionTimeoutMillis: 30_000,
          idleTimeoutMillis: 30_000,
        }),
    },
    {
      provide: DRIZZLE,
      inject: [PG_POOL],
      useFactory: (pool: Pool): DrizzleDB => drizzle(pool, { schema }),
    },
  ],
  exports: [PG_POOL, DRIZZLE],
})
export class DatabaseModule implements OnModuleDestroy {
  private readonly logger = new Logger(DatabaseModule.name);

  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async onModuleDestroy(): Promise<void> {
    this.logger.log('Closing database connection pool');
    await this.pool.end();
  }
}
