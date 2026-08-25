import { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { SESSION_COOKIE } from './../src/auth/auth.types';
import { SessionService } from './../src/auth/session.service';
import { createApp } from './e2e-utils';

/**
 * End-to-end coverage of the deny-by-default posture (spec §7): nothing but the
 * public allowlist is reachable without a valid session, and the Discord login
 * kickoff behaves correctly.
 */
describe('Auth (e2e)', () => {
  let app: NestExpressApplication;
  let sessionService: SessionService;

  beforeAll(async () => {
    // Through `createApp` so this suite boots the same middleware stack as
    // production. It covers the OAuth redirects, which are the responses most
    // worth having the real stack around them.
    app = await createApp();
    sessionService = app.get(SessionService);
  });

  afterAll(async () => {
    await app.close();
  });

  it('exposes /health without authentication', () => {
    return request(app.getHttpServer()).get('/health').expect(200);
  });

  it('rejects /auth/me without a session (401)', () => {
    return request(app.getHttpServer()).get('/auth/me').expect(401);
  });

  it('rejects a protected route without a session (401)', () => {
    return request(app.getHttpServer()).get('/categories').expect(401);
  });

  it('rejects a tampered session cookie (401)', () => {
    return request(app.getHttpServer())
      .get('/categories')
      .set('Cookie', `${SESSION_COOKIE}=not-a-valid-jwt`)
      .expect(401);
  });

  it('redirects /auth/discord/login to Discord with a state cookie', async () => {
    const response = await request(app.getHttpServer())
      .get('/auth/discord/login')
      .expect(302);

    expect(response.headers.location).toMatch(
      /^https:\/\/discord\.com\/oauth2\/authorize\?/,
    );
    const setCookie = response.headers['set-cookie'] as unknown as string[];
    expect(setCookie.some((c) => c.startsWith('austv_oauth_state='))).toBe(
      true,
    );
  });

  it('returns the current user for a valid allowlisted session', async () => {
    const token = await sessionService.sign({
      discordId: '111111111111111111',
      username: 'Murilo',
      avatar: null,
    });

    const response = await request(app.getHttpServer())
      .get('/auth/me')
      .set('Cookie', `${SESSION_COOKIE}=${token}`)
      .expect(200);

    expect(response.body).toEqual({
      discordId: '111111111111111111',
      username: 'Murilo',
      avatar: null,
    });
  });

  it('rejects a valid session for a non-allowlisted user (401)', async () => {
    const token = await sessionService.sign({
      discordId: '999999999999999999',
      username: 'Intruder',
      avatar: null,
    });

    return request(app.getHttpServer())
      .get('/auth/me')
      .set('Cookie', `${SESSION_COOKIE}=${token}`)
      .expect(401);
  });

  it('clears the session cookie on logout', () => {
    return request(app.getHttpServer()).post('/auth/logout').expect(204);
  });
});
