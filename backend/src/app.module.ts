import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AnalyticsModule } from './analytics/analytics.module';
import { AuthModule } from './auth/auth.module';
import { CategoriesModule } from './categories/categories.module';
import { validateEnv } from './config/env.validation';
import { DatabaseModule } from './db/database.module';
import { HealthModule } from './health/health.module';
import { InstrumentationModule } from './instrumentation/instrumentation.module';
import { ItemsModule } from './items/items.module';
import { SalesModule } from './sales/sales.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validate: validateEnv,
    }),
    DatabaseModule,
    // AuthModule registers the global deny-by-default guard, so it must be in
    // place before any feature module exposes a route.
    AuthModule,
    HealthModule,
    // Instrumentation health (AusTV Admin S6.3): watches whether the *game
    // network measurement* is still happening. Not to be confused with
    // HealthModule above, which is this process's own liveness probe.
    InstrumentationModule,
    CategoriesModule,
    ItemsModule,
    SalesModule,
    AnalyticsModule,
  ],
})
export class AppModule {}
