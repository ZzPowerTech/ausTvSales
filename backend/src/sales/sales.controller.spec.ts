import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { ThrottlerModule } from '@nestjs/throttler';
import request from 'supertest';
import { App } from 'supertest/types';
import { validationPipeOptions } from '../config/validation-pipe.config';
import { IngestApiKeyGuard } from '../ingest/ingest-api-key.guard';
import { IngestApiKeyService } from '../ingest/ingest-api-key.service';
import { ingestThrottlerOptions } from '../ingest/ingest.throttle';
import { SalesController } from './sales.controller';

const KEY = 'a'.repeat(64);

const VALID_PAYLOAD = {
  sale_id: '11111111-1111-4111-8111-111111111111',
  item_id: 'caixaNatal2026',
  player_uuid: '22222222-2222-4222-8222-222222222222',
  total_price: 10.5,
  qtd: 1,
  purchased_at: '2026-07-16T12:00:00.000Z',
};

describe('SalesController (ingest stub)', () => {
  let app: INestApplication<App>;

  beforeAll(async () => {
    const configStub = {
      getOrThrow: jest.fn().mockReturnValue(KEY),
    } as unknown as ConfigService;

    const moduleRef = await Test.createTestingModule({
      imports: [ThrottlerModule.forRoot(ingestThrottlerOptions)],
      controllers: [SalesController],
      providers: [
        IngestApiKeyGuard,
        {
          provide: IngestApiKeyService,
          useValue: new IngestApiKeyService(configStub),
        },
      ],
    }).compile();

    app = moduleRef.createNestApplication<INestApplication<App>>();
    app.useGlobalPipes(new ValidationPipe(validationPipeOptions));
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  const http = () => request(app.getHttpServer());

  it('rejects POST /sales without an API key (401 — ingest guard, not session)', () => {
    return http().post('/sales').send(VALID_PAYLOAD).expect(401);
  });

  it('rejects POST /sales with a wrong API key (401)', () => {
    return http()
      .post('/sales')
      .set('X-Api-Key', 'b'.repeat(64))
      .send(VALID_PAYLOAD)
      .expect(401);
  });

  it('returns 501 for an authenticated request (stub — S2.2 pending)', () => {
    return http()
      .post('/sales')
      .set('X-Api-Key', KEY)
      .send(VALID_PAYLOAD)
      .expect(501);
  });

  it('validates the payload before the stub (400 on malformed body)', () => {
    return http()
      .post('/sales')
      .set('X-Api-Key', KEY)
      .send({ ...VALID_PAYLOAD, qtd: 0 })
      .expect(400);
  });
});
