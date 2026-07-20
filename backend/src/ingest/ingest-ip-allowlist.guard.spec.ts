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

  describe('proxy misconfiguration hint', () => {
    /** Capture the warning the guard emits while rejecting. */
    function warningFor(ip: string | undefined): string {
      const guard = buildGuard(false);
      const warn = jest
        .spyOn(
          (guard as unknown as { logger: { warn: (m: string) => void } })
            .logger,
          'warn',
        )
        .mockImplementation(() => undefined);

      expect(() => guard.canActivate(buildContext(ip))).toThrow(
        ForbiddenException,
      );
      return warn.mock.calls[0][0];
    }

    it('points at TRUST_PROXY when the rejected IP is a Docker bridge gateway', () => {
      // The exact address from the 2026-07-19 incident: `trust proxy` was
      // 'loopback' while Nginx reached the container over the bridge, so the
      // app compared the gateway instead of the game VPS.
      const message = warningFor('::ffff:172.27.0.1');

      expect(message).toContain('172.27.0.1');
      expect(message).toContain('TRUST_PROXY');
      expect(message).toContain('X-Forwarded-For');
    });

    it.each([
      ['127.0.0.1', 'loopback'],
      ['::1', 'IPv6 loopback'],
      ['10.1.2.3', 'RFC1918 /8'],
      ['192.168.0.5', 'RFC1918 /16'],
      ['172.31.255.254', 'top of the RFC1918 /12'],
    ])('hints for %s (%s)', (ip) => {
      expect(warningFor(ip)).toContain('TRUST_PROXY');
    });

    it.each([
      ['203.0.113.10', 'public'],
      ['172.32.0.1', 'just outside the RFC1918 /12'],
      ['172.15.0.1', 'just below the RFC1918 /12'],
      ['8.8.8.8', 'public resolver'],
    ])('stays quiet for %s (%s)', (ip) => {
      // A genuinely foreign caller is the case the allowlist exists for —
      // suggesting a config fix there would send the operator chasing a ghost.
      const message = warningFor(ip);
      expect(message).toContain('source IP not in allowlist');
      expect(message).not.toContain('TRUST_PROXY');
    });

    it('stays quiet when there is no IP at all', () => {
      expect(warningFor(undefined)).not.toContain('TRUST_PROXY');
    });
  });
});
