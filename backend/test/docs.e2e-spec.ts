import { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { createAuthenticatedApp } from './e2e-utils';

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

    it('serves the UI under a CSP that lets it actually render', async () => {
      const response = await http()
        .get('/docs')
        .set('Cookie', authCookie)
        .expect(200);

      const csp = response.headers['content-security-policy'];
      // The global policy is `default-src 'none'`, which renders the page blank.
      // The path-scoped policy has to win here — and only here.
      expect(csp).toContain("script-src 'self'");
      expect(csp).toContain("style-src 'self' 'unsafe-inline'");
      // Scripts stay same-origin: the template loads three script *files*, so
      // there is no reason to grant inline execution alongside the styles.
      expect(csp).not.toContain("script-src 'self' 'unsafe-inline'");
    });

    it('leaves the strict policy in place everywhere else', async () => {
      const response = await http().get('/health').expect(200);

      expect(response.headers['content-security-policy']).toContain(
        "default-src 'none'",
      );
    });
  });
});
