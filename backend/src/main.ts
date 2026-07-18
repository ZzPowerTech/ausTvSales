import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { ConfigService } from '@nestjs/config';
import cookieParser from 'cookie-parser';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { AppModule } from './app.module';
import { validationPipeOptions } from './config/validation-pipe.config';
import { DRIZZLE, type DrizzleDB } from './db/database.module';

/**
 * Parses the `TRUST_PROXY` env into an Express `trust proxy` value: a bare
 * integer becomes the hop count; anything else ('loopback', an IP, a
 * comma-separated list of trusted proxies) is passed through as-is. Defaults to
 * 'loopback'. This governs how `req.ip` is derived from `X-Forwarded-For`, which
 * the ingest IP allowlist relies on being trustworthy (ADR-0001).
 */
function resolveTrustProxy(raw: string | undefined): string | number {
  const value = (raw ?? 'loopback').trim();
  return /^\d+$/.test(value) ? Number(value) : value;
}

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  const configService = app.get(ConfigService);

  // Trust only the Nginx hop so req.ip is the real client from X-Forwarded-For
  // and a forged header from a direct connection is ignored — the ingest IP
  // allowlist (ADR-0001) is only as trustworthy as this setting.
  app.set(
    'trust proxy',
    resolveTrustProxy(configService.get<string>('TRUST_PROXY')),
  );

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
