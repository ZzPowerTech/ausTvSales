import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, timingSafeEqual } from 'node:crypto';

/**
 * Holds the set of API keys accepted from the game-server plugin (ADR-0001) and
 * validates a candidate key in constant time.
 *
 * `INGEST_API_KEYS` is a comma-separated list so a key rotation can run with a
 * short dual-key window (old + new accepted at once) with no downtime — see the
 * rotation runbook in ADR-0001.
 *
 * Timing-safe comparison: `crypto.timingSafeEqual` throws when the two buffers
 * differ in length, and that length check would itself leak timing/length of the
 * stored key. To avoid both problems we compare the SHA-256 digests of the
 * candidate and each stored key: digests are always 32 bytes, so the comparison
 * is genuinely constant-time regardless of the candidate's length and never
 * throws. SHA-256 collision resistance makes digest equality equivalent to key
 * equality for any practical attacker.
 */
@Injectable()
export class IngestApiKeyService {
  private readonly logger = new Logger(IngestApiKeyService.name);
  private readonly keyDigests: readonly Buffer[];

  constructor(config: ConfigService) {
    const raw = config.getOrThrow<string>('INGEST_API_KEYS');
    this.keyDigests = raw
      .split(',')
      .map((key) => key.trim())
      .filter((key) => key.length > 0)
      .map((key) => IngestApiKeyService.digest(key));

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
  matches(candidate: string): boolean {
    const candidateDigest = IngestApiKeyService.digest(candidate);
    let matched = false;
    for (const keyDigest of this.keyDigests) {
      if (timingSafeEqual(candidateDigest, keyDigest)) {
        matched = true;
      }
    }
    return matched;
  }

  private static digest(value: string): Buffer {
    return createHash('sha256').update(value, 'utf8').digest();
  }
}
