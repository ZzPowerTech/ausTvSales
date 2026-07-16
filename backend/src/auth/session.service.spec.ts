import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { SessionService } from './session.service';
import type { AuthUser } from './auth.types';

const SECRET = 'a-session-secret-that-is-long-enough-000000';

function buildService(nodeEnv = 'test'): SessionService {
  const config = {
    getOrThrow: jest.fn().mockReturnValue(SECRET),
    get: jest.fn().mockReturnValue(nodeEnv),
  } as unknown as ConfigService;
  return new SessionService(new JwtService(), config);
}

const USER: AuthUser = {
  discordId: '111111111111111111',
  username: 'Murilo',
  avatar: 'abc123',
};

describe('SessionService', () => {
  it('round-trips a user through sign/verify', async () => {
    const service = buildService();
    const token = await service.sign(USER);
    await expect(service.verify(token)).resolves.toEqual(USER);
  });

  it('rejects a token signed with a different secret', async () => {
    const signer = buildService();
    const token = await signer.sign(USER);

    const other = {
      getOrThrow: jest
        .fn()
        .mockReturnValue('a-completely-different-secret-000000000000'),
      get: jest.fn().mockReturnValue('test'),
    } as unknown as ConfigService;
    const verifier = new SessionService(new JwtService(), other);

    await expect(verifier.verify(token)).rejects.toBeDefined();
  });

  it('marks the cookie secure only in production', () => {
    expect(buildService('production').sessionCookieOptions().secure).toBe(true);
    expect(buildService('development').sessionCookieOptions().secure).toBe(
      false,
    );
  });

  it('sets httpOnly and lax same-site on the session cookie', () => {
    const options = buildService().sessionCookieOptions();
    expect(options.httpOnly).toBe(true);
    expect(options.sameSite).toBe('lax');
  });
});
