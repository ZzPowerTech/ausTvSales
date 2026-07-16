import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AuthUser } from './auth.types';

const DISCORD_AUTHORIZE_URL = 'https://discord.com/oauth2/authorize';
const DISCORD_TOKEN_URL = 'https://discord.com/api/oauth2/token';
const DISCORD_USER_URL = 'https://discord.com/api/users/@me';
// `identify` is the minimum scope: we only need the user id + display fields.
const DISCORD_SCOPE = 'identify';

interface DiscordTokenResponse {
  access_token?: string;
  token_type?: string;
}

interface DiscordUserResponse {
  id?: string;
  username?: string;
  global_name?: string | null;
  avatar?: string | null;
}

/**
 * Thin Discord OAuth2 client (authorization code flow). Kept dependency-free —
 * uses global `fetch` — so the auth path has no third-party OAuth library to
 * audit. Secrets come from config; nothing is logged.
 */
@Injectable()
export class DiscordOAuthService {
  private readonly logger = new Logger(DiscordOAuthService.name);
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly redirectUri: string;

  constructor(config: ConfigService) {
    this.clientId = config.getOrThrow<string>('DISCORD_CLIENT_ID');
    this.clientSecret = config.getOrThrow<string>('DISCORD_CLIENT_SECRET');
    this.redirectUri = config.getOrThrow<string>('DISCORD_REDIRECT_URI');
  }

  /** Build the Discord consent URL the browser is redirected to on login. */
  buildAuthorizeUrl(state: string): string {
    const params = new URLSearchParams({
      client_id: this.clientId,
      redirect_uri: this.redirectUri,
      response_type: 'code',
      scope: DISCORD_SCOPE,
      state,
      // No `prompt` override: Discord shows consent only on first authorization
      // and skips it afterwards (the "automatic login" feel) without the
      // `prompt=none` failure mode that returns `consent_required` for a
      // first-time user instead of an authorization code.
    });
    return `${DISCORD_AUTHORIZE_URL}?${params.toString()}`;
  }

  /**
   * Exchange an authorization code for the user's Discord profile. Throws
   * {@link UnauthorizedException} on any failure — the caller maps that to a
   * denied login without leaking the underlying reason to the browser.
   */
  async fetchUser(code: string): Promise<AuthUser> {
    const accessToken = await this.exchangeCode(code);

    const response = await fetch(DISCORD_USER_URL, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!response.ok) {
      this.logger.warn(
        `Discord /users/@me failed with status ${response.status}`,
      );
      throw new UnauthorizedException();
    }
    const user = (await response.json()) as DiscordUserResponse;
    if (!user.id || !user.username) {
      throw new UnauthorizedException();
    }
    return {
      discordId: user.id,
      username: user.global_name ?? user.username,
      avatar: user.avatar ?? null,
    };
  }

  private async exchangeCode(code: string): Promise<string> {
    const body = new URLSearchParams({
      client_id: this.clientId,
      client_secret: this.clientSecret,
      grant_type: 'authorization_code',
      code,
      redirect_uri: this.redirectUri,
    });

    const response = await fetch(DISCORD_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    if (!response.ok) {
      this.logger.warn(
        `Discord token exchange failed with status ${response.status}`,
      );
      throw new UnauthorizedException();
    }
    const token = (await response.json()) as DiscordTokenResponse;
    if (!token.access_token) {
      throw new UnauthorizedException();
    }
    return token.access_token;
  }
}
