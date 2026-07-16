import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { validationPipeOptions } from './../src/config/validation-pipe.config';
import { SESSION_COOKIE } from './../src/auth/auth.types';
import { SessionService } from './../src/auth/session.service';

/** An allowlisted Discord id (matches the test/CI `ALLOWED_DISCORD_IDS`). */
export const TEST_DISCORD_ID = '111111111111111111';

export interface E2eContext {
  app: INestApplication<App>;
  /** `Cookie` header value carrying a valid session for an allowlisted user. */
  authCookie: string;
}

/** Boot the full app the same way `main.ts` does and mint an auth cookie. */
export async function createAuthenticatedApp(): Promise<E2eContext> {
  const moduleFixture = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();

  const app = moduleFixture.createNestApplication<INestApplication<App>>();
  app.use(cookieParser());
  app.useGlobalPipes(new ValidationPipe(validationPipeOptions));
  await app.init();

  const token = await app.get(SessionService).sign({
    discordId: TEST_DISCORD_ID,
    username: 'Test Operator',
    avatar: null,
  });

  return { app, authCookie: `${SESSION_COOKIE}=${token}` };
}
