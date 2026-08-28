import { plainToInstance } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsNumber,
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

  // --- Instrumentation health alerts (AusTV Admin S6.3, ADR-006) ---

  // Discord webhook that receives the instrumentation-health alerts. The URL is
  // itself the credential — anyone holding it can post to the channel — so it is
  // injected as a deploy secret and never logged, not even redacted.
  //
  // Optional in every environment **for now**, and validated only for shape when
  // present. Making it required in production here would be a deploy-ordering
  // trap: this slice ships the alerter, but nothing schedules a check yet, so the
  // container would refuse to boot for no gain. The slice that starts the
  // scheduler is the one that must promote this to required-in-production —
  // running checks that silently cannot alert is exactly the ADR-006 failure.
  // Until then, DiscordAlerter warns loudly at boot when it is unset.
  @IsOptional()
  @IsUrl(
    { require_tld: true, require_protocol: true, protocols: ['https'] },
    { message: 'DISCORD_ALERT_WEBHOOK_URL must be an absolute https URL' },
  )
  DISCORD_ALERT_WEBHOOK_URL?: string;

  // How long a check must stay in the same failing state before it is announced
  // again. Guards against a months-long outage producing one message per cycle,
  // which trains the team to mute the channel — ADR-006's silence with noise.
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(720)
  HEALTH_ALERT_REALERT_HOURS?: number;

  // --- Plan JSON API (AusTV Admin S6.3, ADR-001/ADR-002) ---

  // Base URL of the Plan webserver, e.g. http://198.89.99.229:25504. Per ADR-001
  // the NestJS API consumes Plan over the network from the sales VPS, so this is
  // deliberately not a loopback address; spec §8 requires the port to be
  // firewalled to this VPS plus Plan's own IP whitelist.
  //
  // `require_tld: false` because the target is addressed by IP today, not by a
  // hostname. Optional for now, for the same deploy-ordering reason as the
  // webhook above: nothing schedules a check yet. The slice that starts the
  // scheduler must promote this to required-in-production — checks that cannot
  // reach their source would report `error` forever.
  @IsOptional()
  @IsUrl(
    {
      require_tld: false,
      require_protocol: true,
      protocols: ['http', 'https'],
    },
    { message: 'PLAN_BASE_URL must be an absolute http(s) URL' },
  )
  PLAN_BASE_URL?: string;

  // Credential for the Plan webserver, sent as a bearer token. Never logged.
  // Absent is legitimate while Plan's auth scheme is still being confirmed
  // against the live instance.
  @IsOptional()
  @MinLength(1, { message: 'PLAN_API_TOKEN must not be empty when set' })
  PLAN_API_TOKEN?: string;

  // Per-request timeout against Plan. Covers connect *and* body read. Kept well
  // under any scheduler interval so a stalled Plan cannot pile requests up.
  @IsOptional()
  @IsInt()
  @Min(1_000)
  @Max(60_000)
  PLAN_TIMEOUT_MS?: number;

  // Retries for *transient* failures only (5xx, 429, network). An auth rejection
  // or a 404 is never retried — see plan-api.errors.ts. Small on purpose:
  // retrying a genuinely dead Plan only delays the alert it should produce.
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(5)
  PLAN_RETRIES?: number;

  // --- Cache do client de metricas (S7.2) ---
  //
  // TTL POR ENDPOINT, e a diferenca entre os dois e a razao de o cache existir:
  // toda leitura sem cache vira uma requisicao HTTP para um webserver que roda
  // dentro do processo do Minecraft, na maquina onde os jogadores estao (secao 8
  // do spec: "query pesada afeta o jogo").
  //
  // `serverOverview` carrega `online_players`, que muda de minuto a minuto.
  @IsOptional()
  @IsInt()
  @Min(5)
  @Max(3_600)
  PLAN_CACHE_TTL_SERVER_SECONDS?: number;

  // `onlineOverview` sao agregados de 24h/7d/30d que mal se mexem dentro de uma
  // hora. Refazer isso todo minuto e pagar o servidor de jogo por um numero que
  // nao mudou.
  @IsOptional()
  @IsInt()
  @Min(60)
  @Max(86_400)
  PLAN_CACHE_TTL_ACTIVITY_SECONDS?: number;

  // Names of the Plan instances the checks evaluate, comma-separated, exactly as
  // Plan spells them (`?server=` is case-sensitive). Example: `AusTv,Survival`.
  //
  // The DECLARED inventory — what the deploy says should exist — never a
  // discovery of what Plan actually runs. A server missing from here is
  // invisible to every check that iterates the list; `plan.orphan_instance`
  // covers that case by reconciling this list against the observed one.
  @IsOptional()
  @Matches(/^\s*[^\s,]+\s*(,\s*[^\s,]+\s*)*$/, {
    message: 'PLAN_SERVERS must be a comma-separated list of Plan server names',
  })
  PLAN_SERVERS?: string;

  // Which name in PLAN_SERVERS is the network proxy. It is excluded from
  // session-derived checks: the proxy records users and the backends record
  // sessions (spec section 2), so a session metric is structurally zero on it and
  // checking it would report a permanent outage that does not exist.
  @IsOptional()
  @MinLength(1, { message: 'PLAN_PROXY_SERVER must not be empty when set' })
  PLAN_PROXY_SERVER?: string;

  // --- Agendamento dos checks (AusTV Admin S6.3, ADR-006) ---

  // Master switch for the instrumentation-health cycle. Off by default so no
  // environment starts polling a game VPS by surprise, and announced loudly at
  // boot when off — a health layer that silently does not run manufactures
  // exactly the confidence ADR-006 exists to destroy.
  @IsOptional()
  @IsBoolean()
  HEALTH_CHECK_ENABLED?: boolean;

  // Minutes between cycles. The lower bound is not arbitrary: each cycle issues
  // one request per configured server against the Plan on the game machine, and
  // spec section 8 lists "query pesada afeta o jogo" as a real risk.
  @IsOptional()
  @IsInt()
  @Min(5)
  @Max(1_440)
  HEALTH_CHECK_INTERVAL_MINUTES?: number;

  // --- MySQL do Plan, somente leitura (ADR-002 excecao 2, S6.3) ---
  //
  // Usado por UM modulo isolado (PlanDatabase) e por DUAS tabelas
  // (`plan_servers` e `plan_users`). Qualquer outra exige nova excecao numerada
  // no spec.
  //
  // A justificativa alegada desta excecao caiu em 2026-08-26 — o endpoint de
  // lista existe e e `/v1/networkMetadata`. Ela continua de pe porque ninguem
  // leu o corpo dele; ver o docblock de `plan-database.ts`.
  //
  // O usuario tem de ser read-only e dedicado — nunca o usuario dos plugins.

  @IsOptional()
  @MinLength(1, { message: 'PLAN_DB_HOST must not be empty when set' })
  PLAN_DB_HOST?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(65_535)
  PLAN_DB_PORT?: number;

  @IsOptional()
  @MinLength(1, { message: 'PLAN_DB_NAME must not be empty when set' })
  PLAN_DB_NAME?: string;

  @IsOptional()
  @MinLength(1, { message: 'PLAN_DB_USER must not be empty when set' })
  PLAN_DB_USER?: string;

  // Nunca logada. Opcional para permitir socket/auth externa, mas na pratica
  // sempre definida junto com as demais.
  @IsOptional()
  PLAN_DB_PASSWORD?: string;

  // --- Check de share de conta offline (S6.3, secao 6.1) ---

  // Janela em dias sobre `registered`. O check mede CHEGADAS na janela, nunca o
  // estoque: o mix all-time (59,2% bedrock) nao e o mix atual, e um numero de
  // plataforma sem janela explicita nao significa nada.
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(90)
  PLATFORM_OFFLINE_WINDOW_DAYS?: number;

  // Teto da fracao de java_offline entre as chegadas da janela, de 0 a 1.
  // PRECISA ser calibrado contra o baseline antes de ser levado a serio — o
  // padrao de 0.5 e um chute conservador, nao uma medida.
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1)
  PLATFORM_OFFLINE_SHARE_MAX?: number;

  // Abaixo disso o percentual nao e publicado: com poucas chegadas o share
  // oscila demais e ruido vira tendencia.
  @IsOptional()
  @IsInt()
  @Min(1)
  PLATFORM_OFFLINE_MIN_SAMPLE?: number;

  // Horas de silencio em `plan_users.registered` antes de alertar que a rede
  // parou de registrar. O gatilho e TEMPO desde a ultima chegada, nunca
  // quantidade: limiar de contagem dispararia numa noite parada de verdade e
  // treinaria o time a silenciar o canal.
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(720)
  PROXY_REGISTRATION_MAX_SILENCE_HOURS?: number;

  // Piso da conversao rede -> servidor, de 0 a 1. Historicamente ~0,46 (54% de
  // quem conecta na rede nunca chega ao survival). PRECISA de calibracao: 0.3 e
  // margem conservadora abaixo do historico, nao uma medida.
  //
  // A janela e fixa em 7 dias e NAO e configuravel: o Plan so oferece
  // `last_7_days` neste endpoint, e uma janela ajustavel deixaria alguem
  // comparar numerador de 30 dias com denominador de 7.
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1)
  FUNNEL_MIN_NETWORK_TO_SERVER?: number;

  // Abaixo desta quantidade de chegadas de rede na janela, nenhuma conversao e
  // publicada — razao sobre amostra pequena e ruido lido como tendencia.
  @IsOptional()
  @IsInt()
  @Min(1)
  FUNNEL_MIN_SAMPLE?: number;

  // --- Tutorial data source (AusTV Admin S8.0, ADR-0004) ---

  // Directory holding the Quests plugin's per-player progress files
  // (`Quests/playerdata/<uuid>.yml`). Plan collects nothing about the tutorial,
  // so this is the only source for two of the four funnel steps of spec §6.2 and
  // for the seventh check of §6.1.
  //
  // The files live on the game machine; how they become readable from this VPS
  // (rsync, read-only mount) is an operations decision that ADR-0004 recommends
  // but does not settle. Unset is legitimate: the sync then records an `error`
  // run, writes nothing, and the check reports `no_data` — never a zero, which
  // would be indistinguishable from the outage it is looking for.
  @IsOptional()
  @MinLength(1, {
    message: 'TUTORIAL_PLAYERDATA_DIR must not be empty when set',
  })
  TUTORIAL_PLAYERDATA_DIR?: string;

  // Directory of the tutorial quest definitions (`Quests/quests/tutorial`). Its
  // file names ARE the list of quest ids that count as tutorial steps — read
  // rather than hardcoded, because the tutorial has already grown `-2`/`-3`
  // branches that a frozen list would stop counting in silence.
  @IsOptional()
  @MinLength(1, { message: 'TUTORIAL_QUESTS_DIR must not be empty when set' })
  TUTORIAL_QUESTS_DIR?: string;

  // Quest id that marks the tutorial as finished. `33tutorial` in the 2026-08-19
  // baseline, where it had 148 completions — the number `HANDOFF.md` reports.
  // Configurable because the tutorial's shape is a business fact that changes,
  // and the id in force is stored with every run so the count stays auditable.
  @IsOptional()
  @MinLength(1, {
    message: 'TUTORIAL_FINAL_QUEST_ID must not be empty when set',
  })
  TUTORIAL_FINAL_QUEST_ID?: string;

  // Floor on `tutorial entrants / server arrivals` over the 7-day window, 0..1.
  // §6.1 proposes 70%. **An uncalibrated guess**, exactly like the three from
  // S6.3: the historical rate was ~100% before dec/2025 and 12% at its worst, so
  // 70% sits in a wide gap — but a wide gap is not a calibration, and
  // `ops/baseline/` is what would turn it into one.
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1)
  FUNNEL_MIN_TUTORIAL_ENTRY_RATE?: number;

  // Master switch for the nightly rebuild. Off by default so no environment
  // starts walking the game machine's files by accident. When off, the boot
  // warns: a job that silently does not run leaves a series that looks current
  // and is frozen — the same false confidence ADR-006 exists to destroy.
  @IsOptional()
  @IsBoolean()
  TUTORIAL_SYNC_ENABLED?: boolean;

  // When the rebuild runs, as a cron expression in America/Sao_Paulo. Criterion
  // 2 of S8.0 says "fora do pico", and off-peak is a statement about the clock —
  // which is why this is a cron and not an interval like the health checks.
  // A malformed expression leaves the job unscheduled and says so; it never
  // falls back to the default hour, because running at an hour nobody chose is
  // how a 20.000-file walk lands in peak.
  @IsOptional()
  @MinLength(1, { message: 'TUTORIAL_SYNC_CRON must not be empty when set' })
  TUTORIAL_SYNC_CRON?: string;

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
