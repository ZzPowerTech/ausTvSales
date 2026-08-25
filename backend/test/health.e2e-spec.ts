import { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { createApp } from './e2e-utils';

describe('HealthController (e2e)', () => {
  let app: NestExpressApplication;

  beforeEach(async () => {
    // Through `createApp` so the probe is exercised on the same middleware
    // stack that serves it in production.
    app = await createApp();
  });

  it('/health (GET) returns status ok', () => {
    return request(app.getHttpServer())
      .get('/health')
      .expect(200)
      .expect((response: { body: { status: string } }) => {
        expect(response.body.status).toBe('ok');
      });
  });

  afterEach(async () => {
    await app.close();
  });
});
