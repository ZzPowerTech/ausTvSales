import { Test, TestingModule } from '@nestjs/testing';
import { HealthService } from './health.service';

describe('HealthService', () => {
  let service: HealthService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [HealthService],
    }).compile();

    service = module.get<HealthService>(HealthService);
  });

  it('reports overall status ok when no component is in error', () => {
    const result = service.check();

    expect(result.status).toBe('ok');
  });

  it('reports the database component as not configured yet', () => {
    const result = service.check();

    expect(result.components.database).toBe('not_configured');
  });
});
