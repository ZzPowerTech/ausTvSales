import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomBytes, scrypt, scryptSync, timingSafeEqual } from 'node:crypto';

/**
 * scrypt cost parameters (OWASP baseline: N=2^17 targets interactive human
 * logins; the ingest path authenticates on every request from a single trusted
 * VPS, so N=2^14 keeps latency in the tens of milliseconds while still making
 * offline brute force of a leaked digest far more expensive than a plain hash).
 */
const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1 } as const;
const SCRYPT_KEYLEN = 32;
const SCRYPT_SALT_BYTES = 16;

/**
 * Holds the set of API keys accepted from the game-server plugin (ADR-0001) and
 * validates a candidate key in constant time.
 *
 * `INGEST_API_KEYS` is a comma-separated list so a key rotation can run with a
 * short dual-key window (old + new accepted at once) with no downtime — see the
 * rotation runbook in ADR-0001.
 *
 * Keys are stored only as scrypt digests, derived with a random per-boot salt:
 * the digests never leave process memory, so the salt does not need to be
 * persisted, and a memory dump yields nothing directly reusable. scrypt (a
 * memory-hard KDF) rather than a bare SHA-256 also keeps offline brute force
 * expensive should a digest ever leak.
 *
 * Timing-safe comparison: `crypto.timingSafeEqual` throws when the two buffers
 * differ in length, and that length check would itself leak timing/length of
 * the stored key. Derived digests are always {@link SCRYPT_KEYLEN} bytes, so
 * the comparison is genuinely constant-time regardless of the candidate's
 * length and never throws.
 *
 * CPU-cost note: the per-request scrypt derivation runs async (libuv thread
 * pool, event loop never blocked) and only for requests that already passed the
 * `IngestIpAllowlistGuard`, so arbitrary internet clients cannot drive this
 * code path (see `@IngestAuth()` ordering).
 */
@Injectable()
export class IngestApiKeyService {
  private readonly logger = new Logger(IngestApiKeyService.name);
  private readonly salt: Buffer;
  private readonly keyDigests: readonly Buffer[];

  constructor(config: ConfigService) {
    const raw = config.getOrThrow<string>('INGEST_API_KEYS');
    this.salt = randomBytes(SCRYPT_SALT_BYTES);
    this.keyDigests = raw
      .split(',')
      .map((key) => key.trim())
      .filter((key) => key.length > 0)
      .map((key) => scryptSync(key, this.salt, SCRYPT_KEYLEN, SCRYPT_PARAMS));

    // Env validation already enforces at least one well-formed key; this is a
    // defensive backstop so the guard never boots with an empty accepted set.
    if (this.keyDigests.length === 0) {
      throw new Error('INGEST_API_KEYS resolved to an empty key set');
    }
    this.logger.log(
      `Ingest API key auth ready (${this.keyDigests.length} key(s) accepted)`,
    );
  }

  /**
   * Constant-time membership test of `candidate` against every accepted key.
   *
   * The loop deliberately checks *all* keys before returning (no short-circuit
   * on the first match) so the time spent does not reveal which key — or how
   * many keys — matched.
   */
  async matches(candidate: string): Promise<boolean> {
    const candidateDigest = await this.derive(candidate);
    let matched = false;
    for (const keyDigest of this.keyDigests) {
      if (timingSafeEqual(candidateDigest, keyDigest)) {
        matched = true;
      }
    }
    return matched;
  }

  private derive(value: string): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      scrypt(value, this.salt, SCRYPT_KEYLEN, SCRYPT_PARAMS, (err, derived) =>
        err ? reject(err) : resolve(derived),
      );
    });
  }
}
