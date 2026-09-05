import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  Logger,
  UnauthorizedException,
  applyDecorators,
  UseGuards,
} from '@nestjs/common';
import { ApiResponse } from '@nestjs/swagger';
import { DashboardThrottle } from '../config/throttling';
import type { AuthenticatedRequest } from './session-auth.guard';
import { STAFF_SCOPE, StaffScopeService } from './staff-scope.service';

/**
 * Requires the authenticated user to hold {@link STAFF_SCOPE}.
 *
 * ## It runs after the global guard, and depends on that
 *
 * `SessionAuthGuard` is an `APP_GUARD`, so it has already verified the session
 * and attached `request.user` by the time this runs. What that leaves here is
 * only the authorization question.
 *
 * The **401** branch below is therefore unreachable through the HTTP stack
 * today, and is not dead code: it is what stops this guard from silently
 * becoming a no-op if it is ever applied to a route that is also `@Public()`.
 * Without it, `user` would be `undefined`, `isStaff(undefined)` would have to be
 * written somehow, and the natural spelling of that mistake grants access. A
 * guard whose failure mode is "allow" is worse than no guard, because it reads
 * like one.
 */
@Injectable()
export class StaffScopeGuard implements CanActivate {
  private readonly logger = new Logger(StaffScopeGuard.name);

  constructor(private readonly staffScope: StaffScopeService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const user = request.user;

    if (!user) throw new UnauthorizedException();

    if (!this.staffScope.isStaff(user.discordId)) {
      // Logged, because a refused staff action is an operational event: the
      // person on the other side sees a 403 and asks why, and the answer has to
      // exist somewhere other than in their memory.
      this.logger.warn(
        `Refused ${request.method} ${request.url}: ${user.discordId} is signed in but not staff`,
      );
      throw new ForbiddenException(
        `Esta acao exige o escopo de staff \`${STAFF_SCOPE}\` ` +
          '(configurado em STAFF_DISCORD_IDS).',
      );
    }
    return true;
  }
}

/**
 * Everything a staff-only dashboard route needs, in one decorator.
 *
 * Bundled for the reason `@BotAuth()` and `DashboardThrottle()` are bundled, and
 * the reason is not tidiness: the combinations that compile and protect nothing
 * are the ones a hurried edit produces. Here it is applying the guard without a
 * rate limit — a mutating route reachable with a leaked session cookie, at
 * whatever speed the network allows.
 *
 * `@ApiResponse(403)` is part of the bundle because the status only exists on
 * these routes, and a consumer reading the contract should learn about it before
 * meeting it.
 */
export function StaffOnly(): ReturnType<typeof applyDecorators> {
  return applyDecorators(
    UseGuards(StaffScopeGuard),
    DashboardThrottle(),
    ApiResponse({
      status: 403,
      description:
        'Sessao valida, mas o usuario nao esta no escopo de staff. Distinto do ' +
        '401, que e sessao ausente ou invalida.',
    }),
  );
}
