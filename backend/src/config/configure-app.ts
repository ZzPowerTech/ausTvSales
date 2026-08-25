import { Logger, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { securityHeadersOptions } from './security-headers.config';
import { resolveTrustProxy } from './trust-proxy';
import { validationPipeOptions } from './validation-pipe.config';

/**
 * Everything between "the Nest app exists" and "it can serve a request".
 *
 * ## Why this is a function and not five lines in `main.ts`
 *
 * It used to be five lines in `main.ts`, and the e2e helper had its own
 * hand-copied subset. The two drifted, which is the only outcome a hand-copied
 * subset ever has: the test suite was proving the behaviour of an app that was
 * not the one being deployed, and the first thing to fall through the gap was
 * the security-headers middleware — invisible to every e2e test until somebody
 * went looking.
 *
 * So the boot sequence lives here, once, and both `main.ts` and the e2e harness
 * call it. Adding middleware means editing one place, and the tests cannot
 * silently stop covering it.
 *
 * ## Order is part of the contract
 *
 * 1. **Trust proxy** first. It is a setting rather than middleware, but it
 *    decides what `req.ip` means for everything after it, including the ingest
 *    allowlist (ADR-0001).
 * 2. **Helmet before CORS.** The `cors` middleware answers a preflight `OPTIONS`
 *    with a 204 and never calls `next()`, so anything registered after it never
 *    runs for preflights. The security impact is close to nil — a preflight is
 *    never rendered — but there is no cost to being ahead of it, and "some
 *    responses have the headers" is a worse invariant to reason about than "all
 *    of them do".
 * 3. **CORS**, then the cookie parser, then the validation pipe.
 *
 * Migrations are deliberately **not** here. They are a deploy step that belongs
 * to the real boot in `main.ts`; the e2e suites run them themselves against the
 * test database.
 */
export function configureApp(
  app: NestExpressApplication,
  config: ConfigService,
): void {
  // Trust only the Nginx hop so req.ip is the real client from X-Forwarded-For
  // and a forged header from a direct connection is ignored — the ingest IP
  // allowlist (ADR-0001) is only as trustworthy as this setting.
  const trustProxy = resolveTrustProxy(config.get<string>('TRUST_PROXY'));
  app.set('trust proxy', trustProxy);

  // Logado de proposito: este valor decide de onde sai o `req.ip` que a
  // allowlist de ingest compara, e um valor errado se manifesta la na frente
  // como um 403 em trafego legitimo — sem nada no boot que aponte para ca.
  Logger.log(
    `Trust proxy: ${JSON.stringify(trustProxy)} ` +
      '(define o req.ip usado pela allowlist de ingest)',
    'Bootstrap',
  );

  // Cabecalhos de seguranca da resposta (S7.2). Antes do CORS — ver a nota de
  // ordem no doc desta funcao.
  app.use(helmet(securityHeadersOptions()));

  // CORS com credenciais so quando ha origem cross-site configurada (dev: o
  // Angular dev server em outra porta). Em producao frontend e API dividem a
  // origem sales.austv.net, entao CORS_ORIGIN fica vazio e CORS desligado.
  const corsOrigin = config.get<string>('CORS_ORIGIN');
  if (corsOrigin) {
    app.enableCors({ origin: corsOrigin, credentials: true });
  }

  // Sessao de dashboard vive em cookie httpOnly assinado — precisamos ler cookies.
  app.use(cookieParser());

  app.useGlobalPipes(new ValidationPipe(validationPipeOptions));
}
