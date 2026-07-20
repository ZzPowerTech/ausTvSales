import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  Logger,
} from '@nestjs/common';
import type { Request } from 'express';
import { IngestIpAllowlistService } from './ingest-ip-allowlist.service';

/**
 * Source-IP allowlist guard for the plugin→API ingest routes (ADR-0001, defense
 * in depth). Applied by `@IngestAuth()` BEFORE the API-key guard, so a request
 * from an unlisted IP is rejected without the key ever being evaluated — a leaked
 * key is useless off the game-server VPS.
 *
 * The client IP comes from `request.ip`, which is only trustworthy because the
 * app sets `trust proxy` to the Nginx hop (see `main.ts`): Express then derives
 * `req.ip` from the proxy-supplied `X-Forwarded-For` and ignores a header forged
 * by a client connecting directly. A rejected request answers `403 Forbidden`
 * (the caller is not allowed to reach this route, regardless of credentials);
 * the plugin's status contract treats 4xx as permanent, so a genuinely unlisted
 * source is not retried in a loop — a misconfiguration surfaces immediately in
 * the go-live check rather than silently draining the queue.
 */
@Injectable()
export class IngestIpAllowlistGuard implements CanActivate {
  private readonly logger = new Logger(IngestIpAllowlistGuard.name);

  constructor(private readonly allowlist: IngestIpAllowlistService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const ip = request.ip;

    if (!this.allowlist.isAllowed(ip)) {
      this.logger.warn(
        `Rejected ingest request ${request.method} ${request.originalUrl} from ${ip ?? 'unknown'}: source IP not in allowlist${IngestIpAllowlistGuard.proxyHint(ip)}`,
      );
      throw new ForbiddenException();
    }

    return true;
  }

  /**
   * A private/loopback address here almost never means "a foreign caller was
   * blocked" — it means the app is reading the proxy hop instead of the real
   * client, i.e. `trust proxy` does not match how the proxy reaches this
   * process. That is a config mistake whose symptom is legitimate traffic being
   * refused, so the log points at it directly instead of leaving the operator to
   * recognise a bridge-gateway address on their own.
   */
  private static proxyHint(ip: string | undefined): string {
    if (!ip || !IngestIpAllowlistGuard.isPrivateAddress(ip)) {
      return '';
    }
    return (
      ' — endereco privado/loopback: provavelmente o proxy, nao o cliente real.' +
      ' Verifique TRUST_PROXY (logado no boot) e se o proxy envia X-Forwarded-For'
    );
  }

  /** RFC1918 and loopback, including their IPv4-mapped IPv6 forms. */
  private static isPrivateAddress(ip: string): boolean {
    const value = ip.trim().toLowerCase();
    const bare = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(value)?.[1] ?? value;

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
