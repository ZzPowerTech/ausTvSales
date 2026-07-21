import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import { IngestApiKeyService } from './ingest-api-key.service';

/**
 * Dedicated guard for the plugin→API ingest routes (ADR-0001, spec S2.1).
 *
 * Distinct from the dashboard's `SessionAuthGuard`: the game-server plugin has
 * no user session, it authenticates with a shared API key. Reads `X-Api-Key`
 * (falling back to `Authorization: Bearer <key>`) and validates it in constant
 * time via {@link IngestApiKeyService}.
 *
 * A missing or invalid key is answered with a bare `401` — the log records the
 * origin IP and route for auditing, but the response never reveals whether the
 * header was absent, malformed, or simply wrong.
 */
@Injectable()
export class IngestApiKeyGuard implements CanActivate {
  private readonly logger = new Logger(IngestApiKeyGuard.name);

  constructor(private readonly apiKeys: IngestApiKeyService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    const key = this.extractKey(request);

    if (key === null || !(await this.apiKeys.matches(key))) {
      this.logger.warn(
        `Rejected ingest request ${request.method} ${request.originalUrl} from ${IngestApiKeyGuard.clientIp(request)}: missing or invalid API key`,
      );
      throw new UnauthorizedException();
    }

    return true;
  }

  private extractKey(request: Request): string | null {
    const apiKeyHeader = request.headers['x-api-key'];
    if (typeof apiKeyHeader === 'string' && apiKeyHeader.length > 0) {
      return apiKeyHeader;
    }

    // Optional fallback transport allowed by ADR-0001. Parsed with plain
    // string operations — this header is attacker-controlled, so no regex with
    // backtracking potential may touch it (CodeQL js/polynomial-redos).
    const authorization = request.headers['authorization'];
    if (typeof authorization === 'string') {
      const trimmed = authorization.trim();
      const scheme = trimmed.slice(0, 6);
      const separator = trimmed.charAt(6);
      if (scheme.toLowerCase() === 'bearer' && /^\s$/.test(separator)) {
        const token = trimmed.slice(7).trim();
        if (token.length > 0) {
          return token;
        }
      }
    }

    return null;
  }

  /**
   * Origin IP for the audit log. The API sits behind Nginx, so the real client
   * address arrives in `X-Forwarded-For` (first hop); fall back to the socket
   * address for direct connections.
   */
  private static clientIp(request: Request): string {
    const forwarded = request.headers['x-forwarded-for'];
    if (typeof forwarded === 'string' && forwarded.length > 0) {
      return forwarded.split(',')[0].trim();
    }
    if (Array.isArray(forwarded) && forwarded.length > 0) {
      return forwarded[0].trim();
    }
    return request.ip ?? request.socket?.remoteAddress ?? 'unknown';
  }
}
