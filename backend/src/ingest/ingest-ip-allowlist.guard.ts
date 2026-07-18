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
        `Rejected ingest request ${request.method} ${request.originalUrl} from ${ip ?? 'unknown'}: source IP not in allowlist`,
      );
      throw new ForbiddenException();
    }

    return true;
  }
}
