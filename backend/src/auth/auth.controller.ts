import { randomBytes } from 'node:crypto';
import { Controller, Get, Logger, Post, Query, Req, Res } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request, Response } from 'express';
import { AllowlistService } from './allowlist.service';
import {
  OAUTH_STATE_COOKIE,
  SESSION_COOKIE,
  type AuthUser,
} from './auth.types';
import { CurrentUser } from './current-user.decorator';
import { DiscordOAuthService } from './discord-oauth.service';
import { Public } from './public.decorator';
import { SessionService } from './session.service';

/** Lifetime of the CSRF `state` cookie: the OAuth round-trip is quick. */
const STATE_TTL_MS = 10 * 60 * 1000;

@Controller('auth')
export class AuthController {
  private readonly logger = new Logger(AuthController.name);
  private readonly frontendBase: string;

  constructor(
    private readonly discord: DiscordOAuthService,
    private readonly session: SessionService,
    private readonly allowlist: AllowlistService,
    config: ConfigService,
  ) {
    this.frontendBase = config.get<string>('FRONTEND_BASE_URL') ?? '/';
  }

  /** Start the Discord OAuth flow: set a CSRF state cookie and redirect. */
  @Public()
  @Get('discord/login')
  login(@Res() res: Response): void {
    const state = randomBytes(32).toString('hex');
    res.cookie(OAUTH_STATE_COOKIE, state, {
      httpOnly: true,
      secure: this.session.sessionCookieOptions().secure,
      sameSite: 'lax',
      path: '/',
      maxAge: STATE_TTL_MS,
    });
    res.redirect(this.discord.buildAuthorizeUrl(state));
  }

  /** OAuth callback: validate state, resolve the user, gate on the allowlist. */
  @Public()
  @Get('discord/callback')
  async callback(
    @Query('code') code: string | undefined,
    @Query('state') state: string | undefined,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const cookies = (req.cookies ?? {}) as Record<string, string>;
    const expectedState = cookies[OAUTH_STATE_COOKIE];
    // Consume the one-time state cookie regardless of outcome.
    res.clearCookie(OAUTH_STATE_COOKIE, { path: '/' });

    if (!code || !state || !expectedState || state !== expectedState) {
      this.logger.warn(
        'Discord callback rejected: missing or mismatched state',
      );
      return this.redirectDenied(res, 'invalid_request');
    }

    let user: AuthUser;
    try {
      user = await this.discord.fetchUser(code);
    } catch {
      return this.redirectDenied(res, 'oauth_failed');
    }

    if (!this.allowlist.isAllowed(user.discordId)) {
      this.logger.warn(
        `Login denied for Discord user ${user.discordId} (not on allowlist)`,
      );
      return this.redirectDenied(res, 'access_denied');
    }

    const token = await this.session.sign(user);
    res.cookie(SESSION_COOKIE, token, this.session.sessionCookieOptions());
    this.logger.log(`Login succeeded for Discord user ${user.discordId}`);
    res.redirect(this.resolve('/'));
  }

  /** Clear the session cookie. Public so it always succeeds, even if expired. */
  @Public()
  @Post('logout')
  logout(@Res() res: Response): void {
    res.clearCookie(SESSION_COOKIE, this.session.clearCookieOptions());
    res.status(204).end();
  }

  /** Return the authenticated user (guarded route). */
  @Get('me')
  me(@CurrentUser() user: AuthUser): AuthUser {
    return user;
  }

  private redirectDenied(res: Response, reason: string): void {
    res.redirect(this.resolve(`/login?error=${reason}`));
  }

  /** Resolve an app path against the configured frontend base URL. */
  private resolve(pathWithQuery: string): string {
    if (/^https?:\/\//.test(this.frontendBase)) {
      return new URL(pathWithQuery, this.frontendBase).toString();
    }
    const base = this.frontendBase.replace(/\/$/, '');
    return `${base}${pathWithQuery}`;
  }
}
