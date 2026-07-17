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
import { SalesService } from './sales.service';

const KEY = 'a'.repeat(64);

const VALID_PAYLOAD = {
  sale_id: '11111111-1111-4111-8111-111111111111',
  item_id: 'caixaNatal2026',
  player_uuid: '22222222-2222-4222-8222-222222222222',
  nickname_at_purchase: 'Murilo',
  total_price: 10.5,
  qtd: 1,
  purchased_at: '2026-07-16T12:00:00.000Z',
};

describe('SalesController (ingest)', () => {
  let app: INestApplication<App>;
  const record = jest.fn();

  beforeAll(async () => {
    const configStub = {
      getOrThrow: jest.fn().mockReturnValue(KEY),
    } as unknown as ConfigService;

    const moduleRef = await Test.createTestingModule({
      imports: [ThrottlerModule.forRoot(ingestThrottlerOptions)],
      controllers: [SalesController],
      providers: [
        IngestApiKeyGuard,
        { provide: SalesService, useValue: { record } },
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

  beforeEach(() => record.mockReset());

  const http = () => request(app.getHttpServer());
  const authed = () => http().post('/sales').set('X-Api-Key', KEY);

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

  it('returns 201 with an ack body when the sale is newly recorded', async () => {
    record.mockResolvedValue({ saleId: VALID_PAYLOAD.sale_id, created: true });

    await authed()
      .send(VALID_PAYLOAD)
      .expect(201)
      .expect({ sale_id: VALID_PAYLOAD.sale_id, status: 'recorded' });
  });

  it('returns 200 on an idempotent replay (already recorded)', async () => {
    record.mockResolvedValue({ saleId: VALID_PAYLOAD.sale_id, created: false });

    await authed()
      .send(VALID_PAYLOAD)
      .expect(200)
      .expect({ sale_id: VALID_PAYLOAD.sale_id, status: 'duplicate' });
  });

  it('validates the payload before the service (400 on qtd < 1)', async () => {
    await authed()
      .send({ ...VALID_PAYLOAD, qtd: 0 })
      .expect(400);
    expect(record).not.toHaveBeenCalled();
  });

  it('rejects a payload missing nickname_at_purchase (400 — S2.2 DTO fix)', async () => {
    const withoutNick: Record<string, unknown> = { ...VALID_PAYLOAD };
    delete withoutNick.nickname_at_purchase;
    await authed().send(withoutNick).expect(400);
    expect(record).not.toHaveBeenCalled();
  });
});
