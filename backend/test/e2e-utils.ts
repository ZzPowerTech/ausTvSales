import { ConfigService } from '@nestjs/config';
import { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { AppModule } from './../src/app.module';
import { configureApp } from './../src/config/configure-app';
import { SESSION_COOKIE } from './../src/auth/auth.types';
import { SessionService } from './../src/auth/session.service';

/** An allowlisted Discord id (matches the test/CI `ALLOWED_DISCORD_IDS`). */
export const TEST_DISCORD_ID = '111111111111111111';

export interface E2eContext {
  app: NestExpressApplication;
  /** `Cookie` header value carrying a valid session for an allowlisted user. */
  authCookie: string;
}

/**
 * Boot the app through the same `configureApp` as `main.ts`.
 *
 * The shared call is the point. This helper used to re-list the middleware by
 * hand, which meant the suite was exercising an app that merely resembled the
 * deployed one — and the resemblance had already broken in three places before
 * anyone noticed. Anything that has to hold in production is now covered here by
 * construction rather than by remembering to copy a line.
 */
export async function createApp(): Promise<NestExpressApplication> {
  const moduleFixture = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();

  const app = moduleFixture.createNestApplication<NestExpressApplication>();
  configureApp(app, moduleFixture.get(ConfigService));
  await app.init();

  return app;
}

/** {@link createApp}, plus a signed session cookie for an allowlisted user. */
export async function createAuthenticatedApp(): Promise<E2eContext> {
  const app = await createApp();

  const token = await app.get(SessionService).sign({
    discordId: TEST_DISCORD_ID,
    username: 'Test Operator',
    avatar: null,
  });

  return { app, authCookie: `${SESSION_COOKIE}=${token}` };
}
