import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AuthModule } from './auth/auth.module';
import { CategoriesModule } from './categories/categories.module';
import { validateEnv } from './config/env.validation';
import { DatabaseModule } from './db/database.module';
import { HealthModule } from './health/health.module';
import { ItemsModule } from './items/items.module';

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
    CategoriesModule,
    ItemsModule,
  ],
})
export class AppModule {}
