import { ConfigService } from '@nestjs/config';
import { IngestApiKeyService } from './ingest-api-key.service';

const KEY_A = 'a'.repeat(64);
const KEY_B = 'b'.repeat(64);

function buildService(raw: string): IngestApiKeyService {
  const config = {
    getOrThrow: jest.fn().mockReturnValue(raw),
  } as unknown as ConfigService;
  return new IngestApiKeyService(config);
}

describe('IngestApiKeyService', () => {
  it('matches the single configured key', () => {
    const service = buildService(KEY_A);
    expect(service.matches(KEY_A)).toBe(true);
  });

  it('rejects an unknown key', () => {
    const service = buildService(KEY_A);
    expect(service.matches(KEY_B)).toBe(false);
  });

  it('matches either key when two are configured (rotation window)', () => {
    const service = buildService(`${KEY_A},${KEY_B}`);
    expect(service.matches(KEY_A)).toBe(true);
    expect(service.matches(KEY_B)).toBe(true);
  });

  it('tolerates surrounding whitespace in the key list', () => {
    const service = buildService(` ${KEY_A} , ${KEY_B} `);
    expect(service.matches(KEY_A)).toBe(true);
    expect(service.matches(KEY_B)).toBe(true);
  });

  it('handles candidates of different length without crashing', () => {
    const service = buildService(KEY_A);
    // Digest comparison normalizes length, so no RangeError from timingSafeEqual.
    expect(service.matches('')).toBe(false);
    expect(service.matches('short')).toBe(false);
    expect(service.matches('x'.repeat(1000))).toBe(false);
  });

  it('throws when the configured key set is empty', () => {
    expect(() => buildService('   ,  ')).toThrow(/empty key set/);
  });
});
