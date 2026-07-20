import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { ConfigService } from '@nestjs/config';
import cookieParser from 'cookie-parser';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { AppModule } from './app.module';
import { validationPipeOptions } from './config/validation-pipe.config';
import { resolveTrustProxy } from './config/trust-proxy';
import { DRIZZLE, type DrizzleDB } from './db/database.module';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  const configService = app.get(ConfigService);

  // Trust only the Nginx hop so req.ip is the real client from X-Forwarded-For
  // and a forged header from a direct connection is ignored — the ingest IP
  // allowlist (ADR-0001) is only as trustworthy as this setting.
  const trustProxy = resolveTrustProxy(
    configService.get<string>('TRUST_PROXY'),
  );
  app.set('trust proxy', trustProxy);

  // Logado no boot de proposito: este valor decide de onde sai o `req.ip` que a
  // allowlist de ingest compara, e um valor errado se manifesta la na frente
  // como um 403 em trafego legitimo — sem nada no boot que aponte para ca.
  Logger.log(
    `Trust proxy: ${JSON.stringify(trustProxy)} ` +
      '(define o req.ip usado pela allowlist de ingest)',
    'Bootstrap',
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
