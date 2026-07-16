import { ConfigService } from '@nestjs/config';
import { AllowlistService } from './allowlist.service';

function buildService(raw: string): AllowlistService {
  const config = {
    getOrThrow: jest.fn().mockReturnValue(raw),
  } as unknown as ConfigService;
  return new AllowlistService(config);
}

describe('AllowlistService', () => {
  it('allows ids present in the list', () => {
    const service = buildService('111111111111111111,222222222222222222');
    expect(service.isAllowed('111111111111111111')).toBe(true);
    expect(service.isAllowed('222222222222222222')).toBe(true);
  });

  it('denies ids not in the list', () => {
    const service = buildService('111111111111111111,222222222222222222');
    expect(service.isAllowed('999999999999999999')).toBe(false);
  });

  it('tolerates surrounding whitespace in the list', () => {
    const service = buildService(' 111111111111111111 , 222222222222222222 ');
    expect(service.isAllowed('111111111111111111')).toBe(true);
  });
});
