import { plainToInstance } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsOptional,
  IsUrl,
  Matches,
  Max,
  Min,
  MinLength,
  ValidateIf,
  validateSync,
} from 'class-validator';

export enum Environment {
  Development = 'development',
  Production = 'production',
  Test = 'test',
}

export class EnvironmentVariables {
  @IsEnum(Environment)
  NODE_ENV: Environment = Environment.Development;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(65535)
  PORT?: number;

  // PostgreSQL connection string (shared instance with AusTV Finance —
  // uses a dedicated database/user for austv-sales, spec §8).
  @Matches(/^postgres(ql)?:\/\/.+/, {
    message:
      'DATABASE_URL must be a postgres:// or postgresql:// connection string',
  })
  DATABASE_URL!: string;

  // --- Discord OAuth2 (dashboard human login, restricted to two users) ---

  // Discord application credentials (Developer Portal → OAuth2).
  @Matches(/^\S+$/, { message: 'DISCORD_CLIENT_ID must be set' })
  DISCORD_CLIENT_ID!: string;

  @MinLength(1, { message: 'DISCORD_CLIENT_SECRET must be set' })
  DISCORD_CLIENT_SECRET!: string;

  // Public callback URL registered in the Discord app, e.g.
  // https://sales.austv.net/api/auth/discord/callback
  @IsUrl(
    { require_tld: false, require_protocol: true },
    { message: 'DISCORD_REDIRECT_URI must be an absolute URL' },
  )
  DISCORD_REDIRECT_URI!: string;

  // Comma-separated Discord user IDs (snowflakes) allowed to sign in. The
  // business rule is exactly two people; the allowlist is the enforcement.
  @Matches(/^\s*\d{17,20}\s*(,\s*\d{17,20}\s*)*$/, {
    message:
      'ALLOWED_DISCORD_IDS must be a comma-separated list of Discord user IDs',
  })
  ALLOWED_DISCORD_IDS!: string;

  // Secret used to sign the session JWT stored in the httpOnly cookie.
  @MinLength(32, {
    message: 'SESSION_JWT_SECRET must be at least 32 characters',
  })
  SESSION_JWT_SECRET!: string;

  // Base URL of the dashboard SPA. Same-origin path in production (served under
  // sales.austv.net, so '/'), or an absolute URL (e.g. http://localhost:4200)
  // in development. Login redirects are resolved against it.
  @IsOptional()
  FRONTEND_BASE_URL?: string;

  // Allowed browser origin for CORS with credentials (dev cross-origin between
  // the Angular dev server and the API). Unset in production (same origin).
  @IsOptional()
  CORS_ORIGIN?: string;

  // --- Ingest auth (game-server plugin → API, ADR-0001 / S2.1) ---

  // Comma-separated list of accepted ingest API keys. Each key is 64 hex chars
  // (32 bytes from `openssl rand -hex 32`). The list supports the ADR-0001
  // dual-key rotation window (old + new accepted at once); a single key is the
  // common case. Required in every environment (fail-closed): the ingest
  // endpoint is a public attack surface (spec §7) and must never boot without a
  // configured key set — mirroring the other required secrets above. Injected
  // as a deploy secret, never committed.
  @Matches(/^\s*[0-9a-fA-F]{64}\s*(,\s*[0-9a-fA-F]{64}\s*)*$/, {
    message:
      'INGEST_API_KEYS must be a comma-separated list of 64-char hex keys (openssl rand -hex 32)',
  })
  INGEST_API_KEYS!: string;

  // Comma-separated list of exact source IPs allowed to reach the ingest routes
  // (ADR-0001, defense in depth over the Nginx `allow/deny` edge rule): a leaked
  // API key must not be enough to submit sales from anywhere but the game VPS.
  // Required in production (fail-closed); optional in dev/test so local runs are
  // not blocked (unset there disables the app-level allowlist). Exact IPs only —
  // use Nginx for CIDR ranges. Per-IP well-formedness is enforced at boot by
  // IngestIpAllowlistService; this rule only checks the comma-separated shape.
  @ValidateIf(
    (o: EnvironmentVariables) =>
      o.NODE_ENV === Environment.Production ||
      o.INGEST_ALLOWED_IPS !== undefined,
  )
  // Token charset excludes ',' so the alternation is unambiguous (no
  // backtracking blowup — CodeQL js/redos); it also rejects stray commas.
  @Matches(/^\s*[^\s,]+\s*(,\s*[^\s,]+\s*)*$/, {
    message:
      'INGEST_ALLOWED_IPS must be a comma-separated list of IP addresses (required in production)',
  })
  INGEST_ALLOWED_IPS?: string;

  // Express `trust proxy` setting, applied in main.ts so `req.ip` reflects the
  // real client from the Nginx-supplied X-Forwarded-For (and a header forged by a
  // direct client is ignored). A number = trust that many hops; otherwise a
  // preset ('loopback') or a comma-separated list of trusted proxy IPs/subnets.
  // Defaults to 'loopback' when unset. Must match how Nginx reaches the container.
  @IsOptional()
  TRUST_PROXY?: string;
}

export function validateEnv(
  config: Record<string, unknown>,
): EnvironmentVariables {
  const validatedConfig = plainToInstance(EnvironmentVariables, config, {
    enableImplicitConversion: true,
  });

  const errors = validateSync(validatedConfig, {
    skipMissingProperties: false,
  });

  if (errors.length > 0) {
    const details = errors
      .map(
        (error) =>
          `${error.property}: ${Object.values(error.constraints ?? {}).join(', ')}`,
      )
      .join('; ');
    throw new Error(`Invalid environment configuration — ${details}`);
  }

  return validatedConfig;
}
