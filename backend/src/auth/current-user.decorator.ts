import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { AuthenticatedRequest } from './session-auth.guard';
import type { AuthUser } from './auth.types';

/**
 * Injects the authenticated {@link AuthUser} attached by {@link SessionAuthGuard}.
 * Only valid on guarded (non-`@Public()`) routes, where the guard guarantees the
 * user is present.
 */
export const CurrentUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AuthUser | undefined => {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    return request.user;
  },
);
