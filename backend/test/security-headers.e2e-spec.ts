import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { createAuthenticatedApp } from './e2e-utils';

/**
 * The security headers of S7.2, asserted on a real HTTP response.
 *
 * The unit test next to `security-headers.config.ts` proves the options object
 * is shaped correctly; it cannot prove Helmet is actually mounted, nor that it
 * is mounted in a position where its headers survive to the wire. Those two are
 * the failure modes worth a real request: middleware registered after `listen`,
 * or registered on a different app instance than the one under test.
 */
describe('Security headers (e2e)', () => {
  let app: INestApplication<App>;

  beforeAll(async () => {
    ({ app } = await createAuthenticatedApp());
  });

  afterAll(async () => {
    await app.close();
  });

  it('locks the CSP down on a response a browser could render', async () => {
    const response = await request(app.getHttpServer()).get('/health');

    const csp = response.headers['content-security-policy'];
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("base-uri 'none'");
    expect(csp).toContain("form-action 'none'");
  });

  it('sets nosniff, deny-framing and no-referrer', async () => {
    const response = await request(app.getHttpServer()).get('/health');

    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['x-frame-options']).toBe('DENY');
    expect(response.headers['referrer-policy']).toBe('no-referrer');
  });

  it('stops advertising Express', async () => {
    const response = await request(app.getHttpServer()).get('/health');

    expect(response.headers['x-powered-by']).toBeUndefined();
  });

  it('still sets the headers on a 401, which is where a probe lands first', async () => {
    // The deny-by-default guard rejects before any controller runs, so this is
    // the response an unauthenticated scanner actually receives. Headers set by
    // middleware must already be on it.
    const response = await request(app.getHttpServer()).get(
      '/analytics/items/caixaNatal2026/series',
    );

    expect(response.status).toBe(401);
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['content-security-policy']).toContain(
      "default-src 'none'",
    );
  });
});
