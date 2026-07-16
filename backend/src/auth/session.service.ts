import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import type { CookieOptions } from 'express';
import { Environment } from '../config/env.validation';
import type { AuthUser, SessionClaims } from './auth.types';

/** Session lifetime — long enough that returning users stay signed in. */
const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days

@Injectable()
export class SessionService {
  private readonly secret: string;
  private readonly isProduction: boolean;

  constructor(
    private readonly jwt: JwtService,
    config: ConfigService,
  ) {
    this.secret = config.getOrThrow<string>('SESSION_JWT_SECRET');
    this.isProduction =
      config.get<Environment>('NODE_ENV') === Environment.Production;
  }

  async sign(user: AuthUser): Promise<string> {
    const claims: SessionClaims = {
      sub: user.discordId,
      username: user.username,
      avatar: user.avatar,
    };
    return this.jwt.signAsync(claims, {
      secret: this.secret,
      expiresIn: SESSION_TTL_SECONDS,
    });
  }

  async verify(token: string): Promise<AuthUser> {
    const claims = await this.jwt.verifyAsync<SessionClaims>(token, {
      secret: this.secret,
    });
    return {
      discordId: claims.sub,
      username: claims.username,
      avatar: claims.avatar,
    };
  }

  /**
   * Cookie flags for the session. httpOnly (no JS access, CWE-1004), `secure`
   * in production (HTTPS-only), and `sameSite=lax` so the cookie survives the
   * top-level redirect back from Discord while still blocking cross-site POSTs.
   */
  sessionCookieOptions(): CookieOptions {
    return {
      httpOnly: true,
      secure: this.isProduction,
      sameSite: 'lax',
      path: '/',
      maxAge: SESSION_TTL_SECONDS * 1000,
    };
  }

  /** Same flags without maxAge — used to clear the cookie on logout. */
  clearCookieOptions(): CookieOptions {
    return {
      httpOnly: true,
      secure: this.isProduction,
      sameSite: 'lax',
      path: '/',
    };
  }
}
