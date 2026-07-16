import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AllowlistService } from './allowlist.service';
import { SESSION_COOKIE, type AuthUser } from './auth.types';
import { SessionAuthGuard } from './session-auth.guard';
import { SessionService } from './session.service';

const USER: AuthUser = {
  discordId: '111111111111111111',
  username: 'Murilo',
  avatar: null,
};

function buildContext(cookies: Record<string, string>): ExecutionContext {
  const request = { cookies, method: 'GET', url: '/categories' };
  return {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => undefined,
    getClass: () => undefined,
  } as unknown as ExecutionContext;
}

function buildGuard(options: {
  isPublic?: boolean;
  verify?: jest.Mock;
  isAllowed?: jest.Mock;
}): SessionAuthGuard {
  const reflector = {
    getAllAndOverride: jest.fn().mockReturnValue(options.isPublic ?? false),
  } as unknown as Reflector;
  const sessionService = {
    verify: options.verify ?? jest.fn().mockResolvedValue(USER),
  } as unknown as SessionService;
  const allowlist = {
    isAllowed: options.isAllowed ?? jest.fn().mockReturnValue(true),
  } as unknown as AllowlistService;
  return new SessionAuthGuard(reflector, sessionService, allowlist);
}

describe('SessionAuthGuard', () => {
  it('allows public routes without a cookie', async () => {
    const guard = buildGuard({ isPublic: true });
    await expect(guard.canActivate(buildContext({}))).resolves.toBe(true);
  });

  it('allows a valid session for an allowlisted user', async () => {
    const guard = buildGuard({});
    await expect(
      guard.canActivate(buildContext({ [SESSION_COOKIE]: 'valid-token' })),
    ).resolves.toBe(true);
  });

  it('rejects a request with no session cookie', async () => {
    const guard = buildGuard({});
    await expect(guard.canActivate(buildContext({}))).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('rejects an invalid/expired session', async () => {
    const guard = buildGuard({
      verify: jest.fn().mockRejectedValue(new Error('bad token')),
    });
    await expect(
      guard.canActivate(buildContext({ [SESSION_COOKIE]: 'tampered' })),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('rejects a valid session whose user is no longer allowlisted', async () => {
    const guard = buildGuard({ isAllowed: jest.fn().mockReturnValue(false) });
    await expect(
      guard.canActivate(buildContext({ [SESSION_COOKIE]: 'valid-token' })),
    ).rejects.toThrow(UnauthorizedException);
  });
});
