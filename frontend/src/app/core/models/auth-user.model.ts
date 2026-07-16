/** Authenticated dashboard user, as returned by `GET /auth/me`. */
export interface AuthUser {
  discordId: string;
  username: string;
  avatar: string | null;
}
