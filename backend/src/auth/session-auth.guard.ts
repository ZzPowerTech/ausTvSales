import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { AllowlistService } from './allowlist.service';
import { SESSION_COOKIE, type AuthUser } from './auth.types';
import { IS_PUBLIC_KEY } from './public.decorator';
import { SessionService } from './session.service';

/** Express request augmented with the authenticated user. */
export interface AuthenticatedRequest extends Request {
  user?: AuthUser;
}

/**
 * Global authentication guard (spec §7). Deny-by-default: a request reaches a
 * controller only if the route is `@Public()` or it carries a valid session
 * cookie whose Discord id is still on the allowlist. Re-checking the allowlist
 * on every request means revoking access is as simple as removing an id from
 * `ALLOWED_DISCORD_IDS` — existing sessions stop working immediately.
 */
@Injectable()
export class SessionAuthGuard implements CanActivate {
  private readonly logger = new Logger(SessionAuthGuard.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly sessionService: SessionService,
    private readonly allowlist: AllowlistService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) {
      return true;
    }

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const token = this.extractToken(request);
    if (!token) {
      throw new UnauthorizedException();
    }

    let user: AuthUser;
    try {
      user = await this.sessionService.verify(token);
    } catch {
      this.logger.warn(
        `Rejected request ${request.method} ${request.url}: invalid session`,
      );
      throw new UnauthorizedException();
    }

    if (!this.allowlist.isAllowed(user.discordId)) {
      this.logger.warn(
        `Rejected request ${request.method} ${request.url}: user ${user.discordId} not on allowlist`,
      );
      throw new UnauthorizedException();
    }

    request.user = user;
    return true;
  }

  private extractToken(request: AuthenticatedRequest): string | null {
    const cookies = (request.cookies ?? {}) as Record<string, string>;
    return cookies[SESSION_COOKIE] ?? null;
  }
}
