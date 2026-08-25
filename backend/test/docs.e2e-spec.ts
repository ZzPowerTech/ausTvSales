import { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { createAuthenticatedApp } from './e2e-utils';

/** The slice of an OpenAPI path item these assertions read. */
interface PathItem {
  get?: { security?: unknown[] };
  post?: { security?: unknown[] };
}

/**
 * OpenAPI docs (AusTV Admin S7, issues #110/#111).
 *
 * Every assertion here exists because the docs routes are **not** Nest routes.
 * `SwaggerModule.setup()` mounts Express handlers below the Nest router, so
 * `APP_GUARD` does not see them and none of the deny-by-default coverage in
 * `auth.e2e-spec.ts` says anything about this surface. If the middleware in
 * `docs-session.middleware.ts` were removed, every other test in this repo would
 * still pass.
 */
describe('OpenAPI docs (e2e)', () => {
  let app: NestExpressApplication;
  let authCookie: string;

  beforeAll(async () => {
    ({ app, authCookie } = await createAuthenticatedApp());
  });

  afterAll(async () => {
    await app.close();
  });

  const http = () => request(app.getHttpServer());

  describe('without a session', () => {
    it('refuses the UI', async () => {
      const response = await http().get('/docs');

      expect(response.status).toBe(401);
    });

    it('refuses the raw specification', async () => {
      // The one that would actually hurt: the JSON is the complete route
      // inventory, ingest surface included.
      const response = await http().get('/docs/json');

      expect(response.status).toBe(401);
      expect(response.body).not.toHaveProperty('paths');
    });

    it('refuses the YAML specification', async () => {
      expect((await http().get('/docs/yaml')).status).toBe(401);
    });

    it('refuses a tampered session cookie', async () => {
      const response = await http()
        .get('/docs/json')
        .set('Cookie', 'austv_session=not-a-valid-jwt');

      expect(response.status).toBe(401);
    });

    it('refuses every asset path Swagger registers, not just the three obvious ones', async () => {
      // Swagger registers twelve handlers under the prefix, and the three easy
      // ones to forget are the static-asset mount, the trailing-slash variant
      // and a duplicated `docs/docs/swagger-ui-init.js`. A future version that
      // prefixed assets differently would escape the mount, and every other test
      // in this file would still pass.
      const paths = [
        '/docs/',
        '/docs/index.html',
        '/docs/swagger-ui-bundle.js',
        '/docs/swagger-ui.css',
        '/docs/swagger-ui-init.js',
        '/docs/docs/swagger-ui-init.js',
      ];

      // Sequential, not `Promise.all`. Each `request()` call binds its own
      // ephemeral listener on the same http.Server, and six of them racing at
      // once produces ECONNRESET rather than an answer — a flaky red that says
      // nothing about the mount this case is here to check.
      const statuses: Array<[string, number]> = [];
      for (const path of paths) {
        statuses.push([path, (await http().get(path)).status]);
      }

      expect(statuses).toEqual(paths.map((path) => [path, 401]));
    });

    it('refuses the case-insensitive variants Express also routes', async () => {
      // Express matches paths case-insensitively by default, so `/DOCS` reaches
      // the same handlers. The mount is equally case-insensitive, so this is not
      // a bypass — but it is the first thing anyone asks, and an untested
      // assumption is how the first thing anyone asks becomes the answer.
      expect((await http().get('/DOCS')).status).toBe(401);
      expect((await http().get('/docs/JSON')).status).toBe(401);
    });

    it('does not serve the spec at Swagger default sibling paths', async () => {
      // `/docs-json` and `/docs-yaml` are Nest's defaults and are siblings of
      // `/docs`, not children — a mount on `/docs` would never have covered
      // them. Moving them under the prefix is what makes one guard enough, and
      // a 404 here is the proof that they moved.
      expect((await http().get('/docs-json')).status).toBe(404);
      expect((await http().get('/docs-yaml')).status).toBe(404);
    });
  });

  describe('with a session', () => {
    it('serves a specification that describes the real routes', async () => {
      const response = await http()
        .get('/docs/json')
        .set('Cookie', authCookie)
        .expect(200);

      const body = response.body as {
        openapi: string;
        info: { title: string; version: string };
        paths: Record<string, unknown>;
      };

      expect(body.openapi).toMatch(/^3\./);
      expect(body.info.title).toBe('AusTV Admin API');
      // Two routes from two different modules, so the document is proven to come
      // from route exploration rather than from a hand-written stub.
      expect(body.paths).toHaveProperty('/health');
      expect(body.paths).toHaveProperty('/analytics/items/{itemId}/series');
    });

    it('marks the public routes as public and everything else as session-guarded', async () => {
      // The document declares a global session requirement, so a public route
      // that forgets to override it is described as needing a cookie it does not
      // need — and `info.description` would be making a claim the paths deny.
      const response = await http()
        .get('/docs/json')
        .set('Cookie', authCookie)
        .expect(200);

      const paths = (response.body as { paths: Record<string, PathItem> })
        .paths;

      expect(paths['/health'].get?.security).toEqual([]);
      expect(paths['/auth/discord/login'].get?.security).toEqual([]);
      expect(paths['/auth/discord/callback'].get?.security).toEqual([]);
      expect(paths['/auth/logout'].post?.security).toEqual([]);

      // Guarded routes inherit the global requirement: no `security` of their own.
      expect(paths['/auth/me'].get?.security).toBeUndefined();
      expect(
        paths['/analytics/items/{itemId}/series'].get?.security,
      ).toBeUndefined();
      // The instrumentation reads (S7.1) are guarded too, and the fact that
      // `/health` right next to them is public is exactly why they are asserted
      // here by name rather than assumed from the prefix.
      expect(paths['/health/instrumentation'].get?.security).toBeUndefined();
      expect(
        paths['/health/instrumentation/checks'].get?.security,
      ).toBeUndefined();
      expect(
        paths['/health/instrumentation/checks/{name}/history'].get?.security,
      ).toBeUndefined();
    });

    it('documents the ingest routes under the API key, not the session', async () => {
      // They are `@Public()` to the session guard but far from open: IP
      // allowlist plus a shared key. Describing them as cookie-authenticated or
      // as anonymous would both be wrong, in opposite directions.
      const response = await http()
        .get('/docs/json')
        .set('Cookie', authCookie)
        .expect(200);

      const paths = (response.body as { paths: Record<string, PathItem> })
        .paths;

      // As duas rotas de ingest, nao so a mais obvia: uma rota nova adicionada
      // sem `@IngestAuth()` cai no requisito global de sessao e e documentada
      // errada, sem nada ficar vermelho.
      expect(paths['/sales'].post?.security).toEqual([
        { 'ingest-api-key': [] },
      ]);
      expect(paths['/items/sync'].get?.security).toEqual([
        { 'ingest-api-key': [] },
      ]);
    });

    it('serves the UI under a CSP that lets it actually render', async () => {
      const response = await http()
        .get('/docs')
        .set('Cookie', authCookie)
        .expect(200);

      // Asserted whole, not by `toContain`. The option type helmet exposes is a
      // `Record<string, ...>`, so a typo in a directive name compiles fine and
      // is emitted verbatim; equality here is the only thing that catches it —
      // and it also catches a relaxation slipped in by reordering.
      expect(response.headers['content-security-policy']).toBe(
        [
          "default-src 'none'",
          "script-src 'self'",
          "style-src 'self' 'unsafe-inline'",
          "img-src 'self' data:",
          "connect-src 'self'",
          "base-uri 'none'",
          "form-action 'none'",
          "frame-ancestors 'none'",
        ].join(';'),
      );
    });

    it('leaves the strict policy in place everywhere else', async () => {
      const response = await http().get('/health').expect(200);

      expect(response.headers['content-security-policy']).toContain(
        "default-src 'none'",
      );
    });
  });
});
