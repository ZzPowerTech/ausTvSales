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
  it('accepts a request carrying a valid X-Api-Key', () => {
    const guard = buildGuard(KEY_A);
    expect(guard.canActivate(buildContext({ 'x-api-key': KEY_A }))).toBe(true);
  });

  it('accepts the second key during a rotation window', () => {
    const guard = buildGuard(`${KEY_A},${KEY_B}`);
    expect(guard.canActivate(buildContext({ 'x-api-key': KEY_B }))).toBe(true);
  });

  it('accepts a valid key via Authorization: Bearer fallback', () => {
    const guard = buildGuard(KEY_A);
    expect(
      guard.canActivate(buildContext({ authorization: `Bearer ${KEY_A}` })),
    ).toBe(true);
  });

  it('rejects a request with no credential (401)', () => {
    const guard = buildGuard(KEY_A);
    expect(() => guard.canActivate(buildContext({}))).toThrow(
      UnauthorizedException,
    );
  });

  it('rejects a request with an invalid key (401)', () => {
    const guard = buildGuard(KEY_A);
    expect(() =>
      guard.canActivate(buildContext({ 'x-api-key': KEY_B })),
    ).toThrow(UnauthorizedException);
  });

  it('rejects a key of a different length without crashing (401)', () => {
    const guard = buildGuard(KEY_A);
    expect(() =>
      guard.canActivate(buildContext({ 'x-api-key': 'short' })),
    ).toThrow(UnauthorizedException);
  });
});
