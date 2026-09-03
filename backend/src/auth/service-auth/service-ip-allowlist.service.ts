import { Logger } from '@nestjs/common';
import { isIP } from 'node:net';

/**
 * Shared source-IP allowlist for the API's service principals — defense in depth
 * on top of whatever the Nginx edge does.
 *
 * The API key alone must never be sufficient: a leaked key used from anywhere
 * but the host that is supposed to hold it should still be rejected. The hard
 * enforcement lives at the edge (`allow <ip>; deny all;`), but relying on that
 * config being present is a single point of failure — this enforces the same
 * allowlist a second time in the app, so the guarantee holds even if the edge
 * rule is missing or misconfigured.
 *
 * The list is exact IP addresses only. CIDR ranges are intentionally not
 * supported here — use the Nginx layer for ranges.
 *
 * When the variable is unset the allowlist is **disabled** (a no-op that allows
 * every source). Whether that is acceptable is the caller's decision, made in
 * env validation; this class only reports {@link enabled} and warns.
 *
 * For {@link isAllowed} to be trustworthy the app must read the real client IP
 * (`req.ip`) from the trusted proxy hop only — see the `trust proxy` setup in
 * `main.ts`. Without that, `req.ip`/`X-Forwarded-For` is spoofable.
 */
export abstract class ServiceIpAllowlistService {
  private readonly allowed: ReadonlySet<string>;

  /** True when a non-empty allowlist is configured and therefore enforced. */
  readonly enabled: boolean;

  /**
   * @param rawIps comma-separated address list, straight from the environment.
   * @param envVarName the variable it came from, named in errors and logs.
   * @param disabledWarning what to say when the list is empty — the consequence
   *   differs per principal, and a generic warning is one an operator skims.
   */
  protected constructor(
    rawIps: string,
    envVarName: string,
    disabledWarning: string,
    logger: Logger,
  ) {
    const normalized = rawIps
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0)
      .map((entry) => {
        const value = ServiceIpAllowlistService.normalize(entry);
        if (isIP(value) === 0) {
          throw new Error(
            `${envVarName} contains an invalid IP address: "${entry}"`,
          );
        }
        return value;
      });

    this.allowed = new Set(normalized);
    this.enabled = this.allowed.size > 0;

    if (this.enabled) {
      logger.log(
        `IP allowlist active from ${envVarName} (${this.allowed.size} address(es))`,
      );
    } else {
      logger.warn(disabledWarning);
    }
  }

  /**
   * True when `ip` may reach the guarded routes. A disabled allowlist (no
   * configured IPs) allows everything; an enabled one allows only exact matches.
   * A missing `ip` is rejected when the allowlist is enabled.
   */
  isAllowed(ip: string | undefined): boolean {
    if (!this.enabled) {
      return true;
    }
    if (!ip) {
      return false;
    }
    return this.allowed.has(ServiceIpAllowlistService.normalize(ip));
  }

  /**
   * Canonicalizes an address for comparison: lower-cased, with an IPv4-mapped
   * IPv6 form (`::ffff:1.2.3.4`, as a dual-stack socket may report) reduced to
   * the plain IPv4 so it matches an IPv4 allowlist entry.
   */
  static normalize(ip: string): string {
    const trimmed = ip.trim().toLowerCase();
    const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(trimmed);
    return mapped ? mapped[1] : trimmed;
  }

  /** RFC1918 and loopback, including their IPv4-mapped IPv6 forms. */
  static isPrivateAddress(ip: string): boolean {
    const bare = ServiceIpAllowlistService.normalize(ip);

    if (bare === '::1') {
      return true;
    }

    const octets = bare.split('.');
    if (octets.length !== 4) {
      return false;
    }
    const [a, b] = octets.map(Number);
    if (!Number.isInteger(a) || !Number.isInteger(b)) {
      return false;
    }
    return (
      a === 127 ||
      a === 10 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168)
    );
  }
}
