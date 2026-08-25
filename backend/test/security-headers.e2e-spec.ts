import { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { createApp } from './e2e-utils';

/**
 * The security headers of S7.2, asserted on a real HTTP response.
 *
 * The unit test next to `security-headers.config.ts` proves the options object
 * is shaped correctly; it cannot prove Helmet is actually mounted, nor that it
 * is mounted where its headers survive to the wire. Those are the failure modes
 * worth a real request: middleware registered on a different app instance than
 * the one under test, or registered behind something that terminates first.
 */
describe('Security headers (e2e)', () => {
  let app: NestExpressApplication;

  beforeAll(async () => {
    app = await createApp();
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

  it('sets nosniff, deny-framing, no-referrer and same-origin CORP', async () => {
    const response = await request(app.getHttpServer()).get('/health');

    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['x-frame-options']).toBe('DENY');
    expect(response.headers['referrer-policy']).toBe('no-referrer');
    expect(response.headers['cross-origin-resource-policy']).toBe(
      'same-origin',
    );
  });

  it('commits to HTTPS for a year, without preload', async () => {
    const response = await request(app.getHttpServer()).get('/health');

    expect(response.headers['strict-transport-security']).toBe(
      'max-age=31536000; includeSubDomains',
    );
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

  it('covers the HTML 404 the whole policy was written for', async () => {
    // There is no global exception filter, so an unmatched route falls through
    // to Express's `finalhandler`, which answers with `text/html` echoing the
    // path back. That rendered response is the exact scenario the CSP exists to
    // neutralise, and it is the one that would otherwise never be tested.
    const response = await request(app.getHttpServer()).get(
      '/definitely-not-a-route',
    );

    expect(response.status).toBe(404);
    expect(response.headers['content-security-policy']).toContain(
      "default-src 'none'",
    );
    expect(response.headers['x-content-type-options']).toBe('nosniff');
  });
});
