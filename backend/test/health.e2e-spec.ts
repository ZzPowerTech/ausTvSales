import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { validationPipeOptions } from './../src/config/validation-pipe.config';

describe('HealthController (e2e)', () => {
  let app: INestApplication<App>;

  beforeEach(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(new ValidationPipe(validationPipeOptions));
    await app.init();
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
