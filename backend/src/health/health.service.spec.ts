import { Test, TestingModule } from '@nestjs/testing';
import { PG_POOL } from '../db/database.module';
import { HealthService } from './health.service';

describe('HealthService', () => {
  const query = jest.fn();
  let service: HealthService;

  beforeEach(async () => {
    query.mockReset();
    const module: TestingModule = await Test.createTestingModule({
      providers: [HealthService, { provide: PG_POOL, useValue: { query } }],
    }).compile();

    service = module.get<HealthService>(HealthService);
  });

  it('reports database ok and overall ok when SELECT 1 succeeds', async () => {
    query.mockResolvedValue({ rows: [{ '?column?': 1 }] });

    const result = await service.check();

    expect(query).toHaveBeenCalledWith('SELECT 1');
    expect(result.components.database).toBe('ok');
    expect(result.status).toBe('ok');
  });

  it('reports database error and overall error when the query throws', async () => {
    query.mockRejectedValue(new Error('connection refused'));

    const result = await service.check();

    expect(result.components.database).toBe('error');
    expect(result.status).toBe('error');
  });
});
