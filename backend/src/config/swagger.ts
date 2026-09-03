import { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';
import { AllowlistService } from '../auth/allowlist.service';
import { SESSION_COOKIE } from '../auth/auth.types';
import { createDocsSessionMiddleware } from '../auth/docs-session.middleware';
import { SessionService } from '../auth/session.service';
import {
  BOT_SECURITY_SCHEME,
  INGEST_SECURITY_SCHEME,
  SESSION_SECURITY_SCHEME,
} from './swagger.constants';

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
 * Every entry was checked against the shipped assets rather than copied from a
 * snippet. `'unsafe-inline'` appears for **styles only**: the template has two
 * inline `<style>` blocks but loads all three of its scripts as separate files
 * from this origin, so `script-src` stays at `'self'` — which is the half that
 * matters, and the half most snippets on the internet give away. No `font-src`,
 * because `swagger-ui.css` declares no `@font-face`; no `worker-src`/`blob:`,
 * because the bundle constructs no `Worker`. All the icons are inline `data:`
 * SVGs, which is what `img-src` covers.
 *
 * Typed from helmet's own signature, which pins the *values* but not the
 * directive names — the option type is a `Record<string, ...>`, so `scrpit-src`
 * would still compile and be emitted verbatim. The guard that actually catches
 * that is the e2e assertion on the whole header string, which is why it is an
 * equality check and not a `toContain`.
 */
type CspDirectives = NonNullable<
  NonNullable<Parameters<typeof helmet.contentSecurityPolicy>[0]>['directives']
>;

const DOCS_CSP_DIRECTIVES: CspDirectives = {
  'default-src': ["'none'"],
  'script-src': ["'self'"],
  'style-src': ["'self'", "'unsafe-inline'"],
  'img-src': ["'self'", 'data:'],
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
 * **The same gap applies to `ThrottlerGuard`**, and it is the one thing this
 * slice makes harder for the next. When the throttling slice of S7.2 lands, it
 * will be a Nest guard and it will not see `/docs/*` either — so any rate control
 * for this surface has to be Express-level, mounted next to the session
 * middleware below. Left unrated, each request with a garbage cookie costs a JWT
 * verify, and this would be the one route family in the API with no limit.
 *
 * ## One prefix, on purpose
 *
 * `jsonDocumentUrl` and `yamlDocumentUrl` are moved under `${DOCS_PATH}/` rather
 * than left at Nest's defaults of `/docs-json` and `/docs-yaml`. Those defaults
 * are *siblings* of `/docs`, not children, so `app.use('/docs', ...)` would not
 * cover them and the raw specification would have been served unauthenticated
 * next to a protected UI.
 *
 * The prefix covers more than the three obvious routes: Swagger also registers a
 * duplicated `${DOCS_PATH}/docs/swagger-ui-init.js` and mounts the whole
 * `swagger-ui-dist` folder as static assets. Both sit under the mount, and the
 * e2e suite asserts it — a future version that prefixed assets differently would
 * otherwise escape the check in silence.
 *
 * ## Yes, in production too
 *
 * There is no env kill switch, and that is a decision rather than an oversight.
 * The docs are behind the same session as the dashboard and the same two-person
 * allowlist (`ALLOWED_DISCORD_IDS`), so the audience is identical to the one
 * that can already read every response the API produces. A flag would add a
 * configuration that is wrong in one of its two positions and would tempt
 * somebody to disable the docs instead of protecting them.
 *
 * ## No `@nestjs/swagger` CLI plugin
 *
 * The plugin infers `@ApiProperty` from TypeScript types at build time. It is
 * the upstream recommendation and it was still rejected here: it runs in the
 * `nest build` pipeline and **not** under ts-jest, so the document the tests see
 * would differ from the one production serves. This project already has a rule
 * about not confusing two different things for one, and documentation that is
 * only correct in one of the two builds is exactly that.
 *
 * The cost is stated rather than hidden: the DTOs written before S7 carry no
 * `@ApiProperty` yet, so their schemas are empty objects in this document. The
 * S7 modules are annotated as they are written; annotating the earlier ones is
 * its own piece of work, not a passenger on this one.
 */
export function setupSwagger(app: NestExpressApplication): void {
  // Same services the global guard uses. Resolved from the container rather than
  // reimplemented — one answer to "is this session valid", not two.
  const middleware = createDocsSessionMiddleware(
    app.get(SessionService),
    app.get(AllowlistService),
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
        'instrumentacao da rede de jogo (AusTV Admin). A sessao e o requisito ' +
        'padrao; as rotas que fogem dele dizem isso na propria operacao.',
    )
    .setVersion(API_DOC_VERSION)
    .addCookieAuth(
      SESSION_COOKIE,
      {
        type: 'apiKey',
        in: 'cookie',
        name: SESSION_COOKIE,
        description:
          'Cookie httpOnly emitido pelo login via Discord. Nao e possivel ' +
          'preenche-lo aqui — faca login no dashboard e o browser o envia sozinho.',
      },
      SESSION_SECURITY_SCHEME,
    )
    .addApiKey(
      {
        type: 'apiKey',
        in: 'header',
        name: 'X-Api-Key',
        description:
          'Chave compartilhada do plugin do servidor de jogo (ADR-0001). Vale ' +
          'apenas para as rotas de ingest, e somente a partir dos IPs da ' +
          'allowlist — a chave sozinha nao abre nada de fora da VPS do jogo, e ' +
          'um IP de fora leva 403, nao 401. Aceita tambem como ' +
          '`Authorization: Bearer <chave>`, que o OpenAPI nao tem como declarar ' +
          'junto do header no mesmo esquema.',
      },
      INGEST_SECURITY_SCHEME,
    )
    .addApiKey(
      {
        type: 'apiKey',
        in: 'header',
        name: 'X-Api-Key',
        description:
          'Chave compartilhada do bot do Discord (S10.2). Vale apenas para as ' +
          'rotas de sugestao, e somente a partir dos IPs da allowlist do bot — ' +
          'que em producao e o loopback, porque o bot roda na mesma VPS. Uma ' +
          'chamada vinda de fora, via Nginx, carrega o IP real do cliente e ' +
          'leva 403. Chave distinta da de ingest de proposito: sao dois ' +
          'principais, e um vazamento nao pode virar o outro.',
      },
      BOT_SECURITY_SCHEME,
    )
    // Requisito global: quem nao declarar o proprio esquema exige sessao. Sem
    // isto o documento nao distingue rota protegida de rota publica, e a
    // descricao acima viraria mentira.
    .addSecurityRequirements(SESSION_SECURITY_SCHEME)
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
      // Read-only "try it out". Every write route here is session-authorized, so
      // the page would otherwise hand an operator a one-click path to inserting
      // catalog rows in production while they are reading documentation. The
      // dashboard is where writes belong; this is where they are described.
      supportedSubmitMethods: ['get'],
    },
  });
}
