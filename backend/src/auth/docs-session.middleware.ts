import { Logger } from '@nestjs/common';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { AllowlistService } from './allowlist.service';
import { SESSION_COOKIE } from './auth.types';
import { SessionService } from './session.service';

/**
 * Session check for routes that Nest's router never sees.
 *
 * ## Why this exists at all, given `SessionAuthGuard`
 *
 * `SwaggerModule.setup()` does not register a Nest route. It calls the HTTP
 * adapter directly, which mounts plain Express handlers **outside** the Nest
 * router — so `APP_GUARD` never runs for them. The whole deny-by-default posture
 * of spec §7 simply does not reach `/docs`, and a reader who assumes otherwise
 * would leave the API's full route inventory readable by anyone who can reach
 * the port.
 *
 * That is why the docs are protected by middleware instead of by the guard, and
 * why this file sits next to the guard rather than next to the Swagger wiring:
 * it is an authentication decision, and it belongs where the other one is.
 *
 * ## It reuses the services, never the logic
 *
 * Verification and the allowlist come from the same {@link SessionService} and
 * {@link AllowlistService} the guard uses. Nothing about the token is decided
 * here. A second implementation of "is this session valid" is how two answers to
 * that question end up in one codebase, and the weaker one is always the one
 * that gets found.
 */
export function createDocsSessionMiddleware(
  session: SessionService,
  allowlist: AllowlistService,
): RequestHandler {
  const logger = new Logger('DocsSession');

  return (request: Request, response: Response, next: NextFunction): void => {
    const cookies = (request.cookies ?? {}) as Record<string, string>;
    const token = cookies[SESSION_COOKIE];

    if (!token) {
      deny(response);
      return;
    }

    // `then(onFulfilled, onRejected)` rather than `.then(...).catch(...)`: a
    // trailing catch would also swallow anything thrown by the allowlist lookup
    // or by `next()`, and report a downstream fault to the operator as
    // "invalid session". The rejection handler here only ever sees `verify`.
    session.verify(token).then(
      (user) => {
        if (!allowlist.isAllowed(user.discordId)) {
          logger.warn(
            `Rejected ${request.method} ${request.originalUrl}: user ${user.discordId} not on allowlist`,
          );
          deny(response);
          return;
        }
        next();
      },
      () => {
        logger.warn(
          `Rejected ${request.method} ${request.originalUrl}: invalid session`,
        );
        deny(response);
      },
    );
  };
}

/**
 * Answer 401 with the same shape Nest's `UnauthorizedException` produces.
 *
 * Matching it matters more than it looks: the dashboard has one global handler
 * for 401 (S4.1) and it keys on this body. A bespoke error here would make the
 * docs route the single place in the API where a expired session does not send
 * the operator back to the login screen.
 */
function deny(response: Response): void {
  response.status(401).json({ message: 'Unauthorized', statusCode: 401 });
}
