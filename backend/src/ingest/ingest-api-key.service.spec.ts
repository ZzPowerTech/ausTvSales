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
  it('matches the single configured key', async () => {
    const service = buildService(KEY_A);
    await expect(service.matches(KEY_A)).resolves.toBe(true);
  });

  it('rejects an unknown key', async () => {
    const service = buildService(KEY_A);
    await expect(service.matches(KEY_B)).resolves.toBe(false);
  });

  it('matches either key when two are configured (rotation window)', async () => {
    const service = buildService(`${KEY_A},${KEY_B}`);
    await expect(service.matches(KEY_A)).resolves.toBe(true);
    await expect(service.matches(KEY_B)).resolves.toBe(true);
  });

  it('tolerates surrounding whitespace in the key list', async () => {
    const service = buildService(` ${KEY_A} , ${KEY_B} `);
    await expect(service.matches(KEY_A)).resolves.toBe(true);
    await expect(service.matches(KEY_B)).resolves.toBe(true);
  });

  it('handles candidates of different length without crashing', async () => {
    const service = buildService(KEY_A);
    // Derived digests have a fixed length, so no RangeError from timingSafeEqual.
    await expect(service.matches('')).resolves.toBe(false);
    await expect(service.matches('short')).resolves.toBe(false);
    await expect(service.matches('x'.repeat(1000))).resolves.toBe(false);
  });

  it('throws when the configured key set is empty', () => {
    expect(() => buildService('   ,  ')).toThrow(/empty key set/);
  });
});
