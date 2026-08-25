import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { ConfigService } from '@nestjs/config';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { AppModule } from './app.module';
import { configureApp } from './config/configure-app';
import { DRIZZLE, type DrizzleDB } from './db/database.module';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  const configService = app.get(ConfigService);

  // Aplica migrations pendentes no boot. O drizzle-kit (CLI) e devDependency e
  // nao vai na imagem de producao, entao usamos o migrator do drizzle-orm sobre
  // a pool ja configurada. E idempotente: aplica apenas o que falta no journal.
  const db = app.get<DrizzleDB>(DRIZZLE);
  await migrate(db, { migrationsFolder: './drizzle' });
  Logger.log('Migrations verificadas/aplicadas', 'Bootstrap');

  // Trust proxy, cabecalhos de seguranca, CORS, cookies e o ValidationPipe —
  // numa funcao unica que o harness e2e tambem chama, para que a suite nunca
  // teste um app diferente do que sobe aqui.
  configureApp(app, configService);

  const port = configService.get<number>('PORT') ?? 3000;
  await app.listen(port);
}

void bootstrap();
