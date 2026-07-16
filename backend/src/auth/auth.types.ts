/** Authenticated dashboard user, derived from the Discord profile. */
export interface AuthUser {
  /** Discord user id (snowflake) — stable identity key. */
  discordId: string;
  /** Current Discord username, for display only. */
  username: string;
  /** Discord avatar hash, or null when the user has no custom avatar. */
  avatar: string | null;
}

/** Claims stored in the session JWT (kept minimal). */
export interface SessionClaims {
  sub: string;
  username: string;
  avatar: string | null;
}

/** Name of the httpOnly cookie carrying the session JWT. */
export const SESSION_COOKIE = 'austv_session';

/** Short-lived cookie holding the OAuth `state` for CSRF protection. */
export const OAUTH_STATE_COOKIE = 'austv_oauth_state';
