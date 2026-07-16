import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { AllowlistService } from './allowlist.service';
import { AuthController } from './auth.controller';
import { DiscordOAuthService } from './discord-oauth.service';
import { SessionAuthGuard } from './session-auth.guard';
import { SessionService } from './session.service';

/**
 * Discord-based dashboard authentication (spec §7). Registers
 * {@link SessionAuthGuard} as a global guard (APP_GUARD): every route is
 * protected by default and opts out with `@Public()`.
 */
@Module({
  imports: [JwtModule.register({})],
  controllers: [AuthController],
  providers: [
    DiscordOAuthService,
    SessionService,
    AllowlistService,
    {
      provide: APP_GUARD,
      useClass: SessionAuthGuard,
    },
  ],
})
export class AuthModule {}
