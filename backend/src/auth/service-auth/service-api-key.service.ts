import { Logger } from '@nestjs/common';
import { randomBytes, scrypt, scryptSync, timingSafeEqual } from 'node:crypto';

/**
 * scrypt cost parameters (OWASP baseline: N=2^17 targets interactive human
 * logins; a service principal authenticates on every request from a single
 * trusted host, so N=2^14 keeps latency in the tens of milliseconds while still
 * making offline brute force of a leaked digest far more expensive than a plain
 * hash).
 */
const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1 } as const;
const SCRYPT_KEYLEN = 32;
const SCRYPT_SALT_BYTES = 16;

/**
 * Shared API-key check for the API's **service principals** — callers that have
 * no user session and authenticate with a shared key: the game-server plugin
 * (ADR-0001) and the Discord bot (story S10.2).
 *
 * ## Why this is one class and not two
 *
 * It was two, briefly. The second principal arrived with the bot, and copying
 * sixty lines of scrypt-and-timing-safe-comparison would have created a second
 * place for a security bug to be fixed in one and not the other. The parts that
 * differ between principals — which environment variable, what the log says —
 * are constructor arguments; the parts that must never differ are here.
 *
 * ## The properties this class exists to hold
 *
 * The key list is comma-separated so a rotation can run with a short dual-key
 * window (old + new accepted at once) and no downtime.
 *
 * Keys are stored only as scrypt digests, derived with a random per-boot salt:
 * the digests never leave process memory, so the salt does not need to be
 * persisted, and a memory dump yields nothing directly reusable. scrypt (a
 * memory-hard KDF) rather than a bare SHA-256 also keeps offline brute force
 * expensive should a digest ever leak.
 *
 * Timing-safe comparison: `crypto.timingSafeEqual` throws when the two buffers
 * differ in length, and that length check would itself leak the stored key's
 * length. Derived digests are always {@link SCRYPT_KEYLEN} bytes, so the
 * comparison is genuinely constant-time regardless of the candidate's length and
 * never throws.
 *
 * CPU-cost note: the per-request scrypt derivation runs async (libuv thread
 * pool, event loop never blocked) and, by the guard ordering every principal
 * uses, only for requests that already passed their IP allowlist — so arbitrary
 * internet clients cannot drive this code path.
 */
export abstract class ServiceApiKeyService {
  private readonly salt: Buffer;
  private readonly keyDigests: readonly Buffer[];

  /**
   * @param rawKeys comma-separated key list, straight from the environment.
   * @param envVarName the variable it came from — used in the error and the
   *   boot log, so a misconfiguration names the variable the operator must fix.
   * @param logger the subclass's own logger, so boot lines carry the concrete
   *   principal's name rather than this base class's.
   */
  protected constructor(rawKeys: string, envVarName: string, logger: Logger) {
    this.salt = randomBytes(SCRYPT_SALT_BYTES);
    this.keyDigests = rawKeys
      .split(',')
      .map((key) => key.trim())
      .filter((key) => key.length > 0)
      .map((key) => scryptSync(key, this.salt, SCRYPT_KEYLEN, SCRYPT_PARAMS));

    // Env validation already enforces at least one well-formed key; this is a
    // defensive backstop so a guard never boots with an empty accepted set —
    // which would reject everything, or (worse, in a future refactor) nothing.
    if (this.keyDigests.length === 0) {
      throw new Error(`${envVarName} resolved to an empty key set`);
    }
    logger.log(
      `API key auth ready (${this.keyDigests.length} key(s) accepted from ${envVarName})`,
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
