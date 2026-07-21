import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { IngestApiKeyGuard } from './ingest-api-key.guard';
import { IngestApiKeyService } from './ingest-api-key.service';

const KEY_A = 'a'.repeat(64);
const KEY_B = 'b'.repeat(64);

function buildService(raw: string): IngestApiKeyService {
  const config = {
    getOrThrow: jest.fn().mockReturnValue(raw),
  } as unknown as ConfigService;
  return new IngestApiKeyService(config);
}

function buildContext(headers: Record<string, string>): ExecutionContext {
  const request = {
    headers,
    method: 'POST',
    originalUrl: '/sales',
    ip: '203.0.113.7',
    socket: { remoteAddress: '203.0.113.7' },
  };
  return {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => undefined,
    getClass: () => undefined,
  } as unknown as ExecutionContext;
}

function buildGuard(raw: string): IngestApiKeyGuard {
  return new IngestApiKeyGuard(buildService(raw));
}

describe('IngestApiKeyGuard', () => {
  it('accepts a request carrying a valid X-Api-Key', async () => {
    const guard = buildGuard(KEY_A);
    await expect(
      guard.canActivate(buildContext({ 'x-api-key': KEY_A })),
    ).resolves.toBe(true);
  });

  it('accepts the second key during a rotation window', async () => {
    const guard = buildGuard(`${KEY_A},${KEY_B}`);
    await expect(
      guard.canActivate(buildContext({ 'x-api-key': KEY_B })),
    ).resolves.toBe(true);
  });

  it('accepts a valid key via Authorization: Bearer fallback', async () => {
    const guard = buildGuard(KEY_A);
    await expect(
      guard.canActivate(buildContext({ authorization: `Bearer ${KEY_A}` })),
    ).resolves.toBe(true);
  });

  it('accepts a case-insensitive Bearer scheme with extra whitespace', async () => {
    const guard = buildGuard(KEY_A);
    await expect(
      guard.canActivate(
        buildContext({ authorization: `  bearer   ${KEY_A}  ` }),
      ),
    ).resolves.toBe(true);
  });

  it('rejects an Authorization header with a scheme but no token (401)', async () => {
    const guard = buildGuard(KEY_A);
    await expect(
      guard.canActivate(buildContext({ authorization: 'Bearer   ' })),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('rejects a non-Bearer Authorization scheme (401)', async () => {
    const guard = buildGuard(KEY_A);
    await expect(
      guard.canActivate(buildContext({ authorization: `Basic ${KEY_A}` })),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('rejects a request with no credential (401)', async () => {
    const guard = buildGuard(KEY_A);
    await expect(guard.canActivate(buildContext({}))).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('rejects a request with an invalid key (401)', async () => {
    const guard = buildGuard(KEY_A);
    await expect(
      guard.canActivate(buildContext({ 'x-api-key': KEY_B })),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('rejects a key of a different length without crashing (401)', async () => {
    const guard = buildGuard(KEY_A);
    await expect(
      guard.canActivate(buildContext({ 'x-api-key': 'short' })),
    ).rejects.toThrow(UnauthorizedException);
  });
});
