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
import { ItemsSyncController } from './items-sync.controller';
import { ItemsService, type ItemSyncEntry } from './items.service';

const KEY = 'a'.repeat(64);

// Simulates the DB-filtered result: the service returns active items only, so an
// inactive item (e.g. `caixaPascoa2025`) is absent from what the endpoint serves.
const ACTIVE_ONLY: ItemSyncEntry[] = [
  { itemId: 'caixaNatal2026', active: true },
  { itemId: 'vipGold', active: true },
];

describe('ItemsSyncController (GET /items/sync)', () => {
  let app: INestApplication<App>;
  const findActiveForSync = jest.fn();

  beforeAll(async () => {
    const configStub = {
      getOrThrow: jest.fn().mockReturnValue(KEY),
    } as unknown as ConfigService;

    const moduleRef = await Test.createTestingModule({
      imports: [ThrottlerModule.forRoot(ingestThrottlerOptions)],
      controllers: [ItemsSyncController],
      providers: [
        IngestApiKeyGuard,
        {
          provide: IngestApiKeyService,
          useValue: new IngestApiKeyService(configStub),
        },
        { provide: ItemsService, useValue: { findActiveForSync } },
      ],
    }).compile();

    app = moduleRef.createNestApplication<INestApplication<App>>();
    app.useGlobalPipes(new ValidationPipe(validationPipeOptions));
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    findActiveForSync.mockReset();
  });

  const http = () => request(app.getHttpServer());

  it('rejects the request without an API key (401 — ingest guard, not session)', async () => {
    await http().get('/items/sync').expect(401);
    expect(findActiveForSync).not.toHaveBeenCalled();
  });

  it('rejects a wrong API key (401)', async () => {
    await http()
      .get('/items/sync')
      .set('X-Api-Key', 'b'.repeat(64))
      .expect(401);
    expect(findActiveForSync).not.toHaveBeenCalled();
  });

  it('returns the lean active-only catalog for a valid key', async () => {
    findActiveForSync.mockResolvedValue(ACTIVE_ONLY);

    const res = await http()
      .get('/items/sync')
      .set('X-Api-Key', KEY)
      .expect(200);

    expect(res.body).toEqual(ACTIVE_ONLY);
    // Lean shape: exactly { itemId, active }, nothing else leaks to the cache.
    for (const entry of res.body as ItemSyncEntry[]) {
      expect(Object.keys(entry).sort()).toEqual(['active', 'itemId']);
      expect(entry.active).toBe(true);
    }
  });

  it('does not include inactive items in the payload', async () => {
    // The service returns only active rows; the inactive one never appears.
    findActiveForSync.mockResolvedValue(ACTIVE_ONLY);

    const res = await http()
      .get('/items/sync')
      .set('X-Api-Key', KEY)
      .expect(200);

    const ids = (res.body as ItemSyncEntry[]).map((e) => e.itemId);
    expect(ids).not.toContain('caixaPascoa2025');
  });

  it('sends a short Cache-Control for cheap plugin polling', async () => {
    findActiveForSync.mockResolvedValue(ACTIVE_ONLY);

    const res = await http()
      .get('/items/sync')
      .set('X-Api-Key', KEY)
      .expect(200);

    expect(res.headers['cache-control']).toContain('max-age=60');
  });
});
