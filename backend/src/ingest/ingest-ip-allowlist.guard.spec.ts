import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { IngestIpAllowlistGuard } from './ingest-ip-allowlist.guard';
import { IngestIpAllowlistService } from './ingest-ip-allowlist.service';

function buildContext(ip: string | undefined): ExecutionContext {
  const request = { ip, method: 'POST', originalUrl: '/sales' };
  return {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => undefined,
    getClass: () => undefined,
  } as unknown as ExecutionContext;
}

function buildGuard(allowed: boolean): IngestIpAllowlistGuard {
  const allowlist = {
    isAllowed: jest.fn().mockReturnValue(allowed),
  } as unknown as IngestIpAllowlistService;
  return new IngestIpAllowlistGuard(allowlist);
}

describe('IngestIpAllowlistGuard', () => {
  it('accepts a request whose source IP the allowlist permits', () => {
    const guard = buildGuard(true);
    expect(guard.canActivate(buildContext('203.0.113.10'))).toBe(true);
  });

  it('rejects a request from a non-allowlisted IP (403)', () => {
    const guard = buildGuard(false);
    expect(() => guard.canActivate(buildContext('192.0.2.1'))).toThrow(
      ForbiddenException,
    );
  });

  it('passes req.ip through to the allowlist service', () => {
    const isAllowed = jest.fn().mockReturnValue(true);
    const allowlist = { isAllowed } as unknown as IngestIpAllowlistService;
    const guard = new IngestIpAllowlistGuard(allowlist);

    guard.canActivate(buildContext('203.0.113.10'));

    expect(isAllowed).toHaveBeenCalledWith('203.0.113.10');
  });
});
