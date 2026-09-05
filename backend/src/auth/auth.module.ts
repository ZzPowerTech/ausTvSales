import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { AllowlistService } from './allowlist.service';
import { AuthController } from './auth.controller';
import { DiscordOAuthService } from './discord-oauth.service';
import { SessionAuthGuard } from './session-auth.guard';
import { SessionService } from './session.service';
import { StaffScopeGuard } from './staff-scope.guard';
import { StaffScopeService } from './staff-scope.service';

/**
 * Discord-based dashboard authentication (spec §7). Registers
 * {@link SessionAuthGuard} as a global guard (APP_GUARD): every route is
 * protected by default and opts out with `@Public()`.
 *
 * `StaffScopeService` and `StaffScopeGuard` are exported rather than global
 * (S11.1): "is signed in" is the app-wide default and belongs in an APP_GUARD;
 * "is staff" is a property of a handful of mutating routes and belongs at those
 * routes, where a reader can see it. A second global guard would also have to
 * carry its own opt-out metadata, and an opt-out is precisely the thing this
 * check must not have.
 */
@Module({
  imports: [JwtModule.register({})],
  controllers: [AuthController],
  providers: [
    DiscordOAuthService,
    SessionService,
    AllowlistService,
    StaffScopeService,
    StaffScopeGuard,
    {
      provide: APP_GUARD,
      useClass: SessionAuthGuard,
    },
  ],
  exports: [StaffScopeService, StaffScopeGuard],
})
export class AuthModule {}
