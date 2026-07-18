import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { isIP } from 'node:net';

/**
 * App-level source-IP allowlist for the plugin→API ingest routes (ADR-0001,
 * defense in depth on top of the Nginx `allow/deny` edge rule).
 *
 * The API key alone must never be sufficient to submit sales: a leaked key used
 * from anywhere but the game-server VPS should still be rejected. The hard
 * enforcement lives at the Nginx edge (`allow <ip>; deny all;`), but relying on
 * that config being present is a single point of failure — this service enforces
 * the same allowlist a second time in the app, so the guarantee holds even if the
 * edge rule is missing/misconfigured.
 *
 * `INGEST_ALLOWED_IPS` is a comma-separated list of exact IP addresses (the game
 * VPS has a fixed IP per ADR-0001). CIDR ranges are intentionally not supported
 * here — use the Nginx layer for ranges. When the variable is unset the allowlist
 * is DISABLED (a no-op that allows every source): required in production by env
 * validation, optional in dev/test so local runs are not blocked.
 *
 * For {@link #isAllowed} to be trustworthy the app must read the real client IP
 * (`req.ip`) from the trusted proxy hop only — see the `trust proxy` setup in
 * `main.ts`. Without that, `req.ip`/`X-Forwarded-For` is spoofable.
 */
@Injectable()
export class IngestIpAllowlistService {
  private readonly logger = new Logger(IngestIpAllowlistService.name);
  private readonly allowed: ReadonlySet<string>;

  /** True when a non-empty allowlist is configured and therefore enforced. */
  readonly enabled: boolean;

  constructor(config: ConfigService) {
    const raw = config.get<string>('INGEST_ALLOWED_IPS') ?? '';
    const normalized = raw
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0)
      .map((entry) => {
        const value = IngestIpAllowlistService.normalize(entry);
        if (isIP(value) === 0) {
          throw new Error(
            `INGEST_ALLOWED_IPS contains an invalid IP address: "${entry}"`,
          );
        }
        return value;
      });

    this.allowed = new Set(normalized);
    this.enabled = this.allowed.size > 0;

    if (this.enabled) {
      this.logger.log(
        `Ingest IP allowlist active (${this.allowed.size} address(es))`,
      );
    } else {
      this.logger.warn(
        'INGEST_ALLOWED_IPS not set — ingest IP allowlist DISABLED; the ingest ' +
          'endpoint is protected by the API key and the Nginx edge rule only. ' +
          'Set INGEST_ALLOWED_IPS in production for defense in depth.',
      );
    }
  }

  /**
   * True when `ip` may reach the ingest routes. A disabled allowlist (no
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
    return this.allowed.has(IngestIpAllowlistService.normalize(ip));
  }

  /**
   * Canonicalizes an address for comparison: lower-cased, with an IPv4-mapped
   * IPv6 form (`::ffff:1.2.3.4`, as a dual-stack socket may report) reduced to
   * the plain IPv4 so it matches an IPv4 allowlist entry.
   */
  private static normalize(ip: string): string {
    const trimmed = ip.trim().toLowerCase();
    const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(trimmed);
    return mapped ? mapped[1] : trimmed;
  }
}
