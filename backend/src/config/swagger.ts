import { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';
import { AllowlistService } from '../auth/allowlist.service';
import { SESSION_COOKIE } from '../auth/auth.types';
import { createDocsSessionMiddleware } from '../auth/docs-session.middleware';
import { SessionService } from '../auth/session.service';

/**
 * Where the docs live. Everything Swagger serves hangs under this one prefix —
 * see {@link setupSwagger} for why that is load-bearing and not tidiness.
 */
export const DOCS_PATH = 'docs';

/**
 * Version of the **contract**, not of the deployed artifact.
 *
 * Deliberately not the `package.json` version: that one is bumped by
 * release-please on every merge, so tying the two together would announce a new
 * API version on a commit that only changed a comment. This moves when the
 * contract moves.
 */
export const API_DOC_VERSION = '1.0';

/**
 * CSP for the docs page only.
 *
 * The global policy is `default-src 'none'`, which renders Swagger UI as a blank
 * page. The fix is this narrower policy mounted **after** the global one, so it
 * wins by `setHeader` on this path and nowhere else — never a relaxation of the
 * global policy that every other route depends on.
 *
 * `'unsafe-inline'` appears for **styles only**. The Swagger UI template ships
 * two inline `<style>` blocks, but all three of its scripts are separate files
 * served from this same origin, so `script-src` stays at `'self'` — which is the
 * half that matters, and the half most snippets on the internet give away.
 */
const DOCS_CSP_DIRECTIVES: Record<string, string[]> = {
  'default-src': ["'none'"],
  'script-src': ["'self'"],
  'style-src': ["'self'", "'unsafe-inline'"],
  'img-src': ["'self'", 'data:'],
  'font-src': ["'self'", 'data:'],
  'connect-src': ["'self'"],
  'base-uri': ["'none'"],
  'form-action': ["'none'"],
  'frame-ancestors': ["'none'"],
};

/**
 * Mount the OpenAPI document and Swagger UI (AusTV Admin S7, issues #110/#111).
 *
 * ## The docs are behind the session, and that took a middleware
 *
 * `SwaggerModule.setup()` does not create a Nest route — it mounts Express
 * handlers straight on the adapter, **below** the Nest router. `APP_GUARD` never
 * runs for them, so the deny-by-default posture of spec §7 does not reach here
 * on its own. Without {@link createDocsSessionMiddleware} the complete route
 * inventory of this API, including the ingest surface, would be readable by
 * anyone who can reach the port.
 *
 * ## One prefix, on purpose
 *
 * `jsonDocumentUrl` and `yamlDocumentUrl` are moved under `${DOCS_PATH}/` rather
 * than left at Nest's defaults of `/docs-json` and `/docs-yaml`. Those defaults
 * are *siblings* of `/docs`, not children, so `app.use('/docs', ...)` would not
 * cover them and the raw specification would have been served unauthenticated
 * next to a protected UI. Keeping everything under one prefix means one mount
 * point protects all of it, and adding a Swagger route later cannot silently
 * escape the check.
 *
 * ## No `@nestjs/swagger` CLI plugin
 *
 * The plugin infers `@ApiProperty` from TypeScript types at build time. It is
 * the upstream recommendation and it was still rejected here: it runs in the
 * `nest build` pipeline and **not** under ts-jest, so the document the tests see
 * would differ from the one production serves. This project already has a rule
 * about not confusing two different things for one, and documentation that is
 * only correct in one of the two builds is exactly that. Properties are declared
 * explicitly instead, one decorator at a time, where somebody chose them.
 */
export function setupSwagger(app: INestApplication): void {
  // Same services the global guard uses. Resolved from the container rather than
  // reimplemented — one answer to "is this session valid", not two.
  const middleware = createDocsSessionMiddleware(
    app.get(SessionService, { strict: false }),
    app.get(AllowlistService, { strict: false }),
  );

  // Auth first, then the relaxed CSP: an unauthenticated request must be turned
  // away before anything about the docs page is decided for it.
  app.use(`/${DOCS_PATH}`, middleware);
  app.use(
    `/${DOCS_PATH}`,
    helmet.contentSecurityPolicy({
      useDefaults: false,
      directives: DOCS_CSP_DIRECTIVES,
    }),
  );

  const config = new DocumentBuilder()
    .setTitle('AusTV Admin API')
    .setDescription(
      'API do dashboard AusTV: vendas por cash (ausTvSales) e saude da ' +
        'instrumentacao da rede de jogo (AusTV Admin). Toda rota exige sessao, ' +
        'exceto as marcadas como publicas.',
    )
    .setVersion(API_DOC_VERSION)
    .addCookieAuth(SESSION_COOKIE, {
      type: 'apiKey',
      in: 'cookie',
      name: SESSION_COOKIE,
      description:
        'Cookie httpOnly emitido pelo login via Discord. Nao e possivel ' +
        'preenche-lo aqui — faca login no dashboard e o browser o envia sozinho.',
    })
    .build();

  const document = SwaggerModule.createDocument(app, config);

  SwaggerModule.setup(DOCS_PATH, app, document, {
    jsonDocumentUrl: `${DOCS_PATH}/json`,
    yamlDocumentUrl: `${DOCS_PATH}/yaml`,
    swaggerOptions: {
      // Sorted so a diff of the docs page reflects a contract change rather than
      // a reordering of controller registration.
      operationsSorter: 'alpha',
      tagsSorter: 'alpha',
      persistAuthorization: true,
    },
  });
}
