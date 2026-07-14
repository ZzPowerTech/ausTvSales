import { Test, TestingModule } from '@nestjs/testing';
import { HealthController } from './health.controller';
import { HealthService } from './health.service';

describe('HealthController', () => {
  let controller: HealthController;
  const check = jest.fn();

  beforeEach(async () => {
    check.mockReset();
    const module: TestingModule = await Test.createTestingModule({
      controllers: [HealthController],
      providers: [{ provide: HealthService, useValue: { check } }],
    }).compile();

    controller = module.get<HealthController>(HealthController);
  });

  it('is defined', () => {
    expect(controller).toBeDefined();
  });

  it('delegates to HealthService and returns its result', async () => {
    const expected = {
      status: 'ok' as const,
      components: { database: 'ok' as const },
    };
    check.mockResolvedValue(expected);

    await expect(controller.check()).resolves.toEqual(expected);
    expect(check).toHaveBeenCalledTimes(1);
  });
});
