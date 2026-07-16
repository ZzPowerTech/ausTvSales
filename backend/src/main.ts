import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import cookieParser from 'cookie-parser';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { AppModule } from './app.module';
import { validationPipeOptions } from './config/validation-pipe.config';
import { DRIZZLE, type DrizzleDB } from './db/database.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const configService = app.get(ConfigService);

  // Aplica migrations pendentes no boot. O drizzle-kit (CLI) e devDependency e
  // nao vai na imagem de producao, entao usamos o migrator do drizzle-orm sobre
  // a pool ja configurada. E idempotente: aplica apenas o que falta no journal.
  const db = app.get<DrizzleDB>(DRIZZLE);
  await migrate(db, { migrationsFolder: './drizzle' });
  Logger.log('Migrations verificadas/aplicadas', 'Bootstrap');

  // Sessao de dashboard vive em cookie httpOnly assinado — precisamos ler cookies.
  app.use(cookieParser());

  // CORS com credenciais so quando ha origem cross-site configurada (dev: o
  // Angular dev server em outra porta). Em producao frontend e API dividem a
  // origem sales.austv.net, entao CORS_ORIGIN fica vazio e CORS desligado.
  const corsOrigin = configService.get<string>('CORS_ORIGIN');
  if (corsOrigin) {
    app.enableCors({ origin: corsOrigin, credentials: true });
  }

  app.useGlobalPipes(new ValidationPipe(validationPipeOptions));

  const port = configService.get<number>('PORT') ?? 3000;
  await app.listen(port);
}

void bootstrap();
