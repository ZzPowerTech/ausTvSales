import { BadRequestException } from '@nestjs/common';
import { RetentionController } from './retention.controller';
import type { RetentionService } from './retention.service';

function serviceStub(): {
  service: RetentionService;
  report: jest.Mock;
} {
  const report = jest.fn().mockResolvedValue({});
  return { service: { report } as unknown as RetentionService, report };
}

describe('RetentionController', () => {
  it('defaults to the last twelve cohort months when no window is given', async () => {
    const { service, report } = serviceStub();
    jest
      .spyOn(Date, 'now')
      .mockReturnValue(Date.parse('2026-09-01T10:00:00-03:00'));

    await new RetentionController(service).cohorts({});

    expect(report).toHaveBeenCalledWith('2025-09', '2026-09', 'all');
    jest.restoreAllMocks();
  });

  it('walks the year boundary backwards without touching Date arithmetic', async () => {
    const { service, report } = serviceStub();

    await new RetentionController(service).cohorts({ to: '2026-02' });

    expect(report).toHaveBeenCalledWith('2025-02', '2026-02', 'all');
  });

  it('rejects an inverted window rather than returning an empty report', () => {
    // An empty report would be indistinguishable from a period with no players,
    // which is the confusion this whole epic exists to remove. The check runs
    // before the service is reached, so it throws rather than rejecting.
    const { service, report } = serviceStub();

    expect(() =>
      new RetentionController(service).cohorts({
        from: '2026-08',
        to: '2026-01',
      }),
    ).toThrow(BadRequestException);
    expect(report).not.toHaveBeenCalled();
  });

  it('passes the platform filter through', async () => {
    const { service, report } = serviceStub();

    await new RetentionController(service).cohorts({
      from: '2026-01',
      to: '2026-01',
      platform: 'bedrock',
    });

    expect(report).toHaveBeenCalledWith('2026-01', '2026-01', 'bedrock');
  });
});
