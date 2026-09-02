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
  // Optional in every environment, validated only for shape when present — and
  // that is now a **known gap**, not a deliberate staging. The original comment
  // here said the scheduler did not exist yet and that the slice shipping it
  // would promote this to required-in-production. `HealthCheckScheduler` shipped,
  // and has been running in production since at least 2026-08-26; the promotion
  // never happened.
  //
  // So production can boot with checks measuring, persisting, and never saying
  // anything, and the only signal is one `logger.warn` from DiscordAlerter at
  // boot. That is the ADR-006 failure with an easy-to-miss receipt. Treat the
  // variable as mandatory by hand until a `@ValidateIf` on
  // NODE_ENV=production && HEALTH_CHECK_ENABLED makes it so.
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

  // Quantos vereditos `ok` consecutivos uma recuperacao precisa antes de virar
  // um "normalizado" no canal. A falha continua sendo anunciada no primeiro
  // ciclo; so o all-clear espera confirmacao, porque um all-clear errado e pior
  // que um all-clear atrasado.
  //
  // Qualquer valor daqui vale: o runner usa este numero como janela da propria
  // consulta de sequencia, e a consulta le exatamente essa quantidade de linhas
  // do check, sem corte por tempo. Um teto escondido no store — a versao
  // anterior ignorava linhas com mais de 7 dias — tornaria a recuperacao
  // inalcancavel para qualquer par (intervalo x limiar) que passasse do
  // horizonte, e os dois sao configuraveis ate valores que passam.
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(20)
  HEALTH_ALERT_CONFIRM_RECOVERY?: number;

  // Quantas vezes um check pode se REPETIR por janela de reenvio. Ao estourar,
  // para de repetir; se a janela inteira for passar calada, a proxima
  // observacao que nao seja `ok` sai como aviso de silenciamento. E o freio que nao depende de a regra de transicao ter
  // previsto o formato da oscilacao — a regra ja errou duas vezes nisso.
  //
  // Nao barra um status que o canal ainda nao ouviu nesta janela: barrar isso
  // foi como uma versao anterior deste teto segurou a morte de uma fonte por 45
  // horas. Recuperacao confirmada e barrada um slot antes das demais — sem
  // isso ela ganha a corrida para ser a ultima mensagem e o canal fica
  // segurando um verde sobre um check ainda quebrado. REDUZ esse caso, nao o
  // elimina (o passe do status-nao-ouvido e avaliado antes do limite), e e
  // inerte para os valores 1 e 2. O mesmo passe libera a recuperacao quando os
  // `ok` da propria oscilacao saem da janela; a espera aparece no log como
  // `segurados_por_orcamento`.
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(50)
  HEALTH_ALERT_MAX_PER_WINDOW?: number;

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
  // Calibrado em 2026-08-29 contra a leitura de producao de 2026-08-26 (nivel
  // real ~51%): o padrao de 0.65 deixa folga acima do nivel medido. O valor
  // anterior, 0.5, caia exatamente em cima dele e oscilava a cada jogador.
  // As tres leituras sao janelas de 7 dias tomadas em 105 minutos e se sobrepoem
  // quase inteiras — elas fixam o NIVEL, nao a estabilidade ao longo do tempo.
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

  // ⚠️ INERTE desde 2026-08-31, e mantida de proposito.
  //
  // `funnel.network_to_survival` nao calcula mais razao nenhuma: o denominador
  // (`plan_users`) e a mesma populacao do numerador (`serverOverview` do
  // Survival), medido no dia. Nenhum codigo le esta variavel hoje.
  //
  // Ela fica aqui para documentar o caminho de volta: quando existir fonte de
  // chegadas no proxy, o check volta e este limiar volta a valer com ele — e
  // continua PRECISANDO de calibracao, porque 0.3 e margem conservadora abaixo
  // do historico (~0,46) e nunca foi medida. Apagar a chave agora significaria
  // reescrever essa decisao do zero depois, sem o registro de que 0.3 era chute.
  //
  // ⚠️ O que NAO e motivo, e chegou a estar escrito aqui: "remover quebraria um
  // deploy existente". Nao quebraria. O `validateEnv`, no fim deste arquivo,
  // chama `validateSync` sem `whitelist` e sem `forbidNonWhitelisted`, entao
  // variavel de ambiente sem campo declarado e simplesmente ignorada, nunca
  // erro de boot. Fica registrado porque a afirmacao era checavel em trinta
  // segundos, doze linhas abaixo, e mesmo assim passou.
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1)
  FUNNEL_MIN_NETWORK_TO_SERVER?: number;

  // Abaixo desta quantidade de chegadas na janela, nenhuma razao e publicada —
  // razao sobre amostra pequena e ruido lido como tendencia. Lida hoje pelo
  // `funnel.tutorial_entry_rate`; era compartilhada com o
  // `funnel.network_to_survival` ate ele parar de publicar razao.
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

  // How stale the tutorial series may be before the entry-rate check refuses to
  // publish a ratio. Sized to the **ETL's period**, not to the comparison
  // window: the numerator freezes while the window advances, so the ratio decays
  // from the very first missed run. The nightly cron leaves the series at most
  // ~24h old, so 36h names one missed night — which is the right moment, since
  // every hour past it makes the ratio more wrong.
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(720)
  TUTORIAL_MAX_SYNC_AGE_HOURS?: number;

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

  // --- Retencao por coorte (AusTV Admin S8.2, secao 6.2) ---
  //
  // Este bloco NAO tem credencial nova. A historia foi planejada como o unico
  // ponto autorizado a fazer SQL direto no Plan (excecao 1 do ADR-002), e ler o
  // corpo do `/v1/retention` em 2026-08-29 dispensou a excecao: coorte sai de
  // `registerDate` e plataforma sai do `playerUUID` (ADR-003). O modulo usa o
  // `PLAN_BASE_URL` que ja existe.

  // Tamanho de coorte abaixo do qual a linha vem MARCADA (`belowMinimum`),
  // nunca escondida. Esconder amostra pequena e o mesmo erro de omitir o `n`:
  // sobra so a coorte que por acaso ficou grande, e ruido vira tendencia.
  // 30 e um chute conservador, marcado como tal — nao foi medido contra esta
  // populacao.
  @IsOptional()
  @IsInt()
  @Min(1)
  RETENTION_MIN_COHORT_SIZE?: number;

  // Fracao da populacao inteira que, caida num mesmo dia de `lastSeenDate`,
  // caracteriza aquele dia como CARIMBO DE IMPORTACAO em vez de comportamento
  // de jogador. Mecanismo, nao data: o `HANDOFF.md` registra que coortes ate
  // 2025-08 dao D1/D7/D30 de 100% por causa da unificacao de 2026-08-20, e
  // registra tambem por que a fronteira de 2025-08 nao pode virar constante
  // ("ajuste empirico, nao mecanismo").
  //
  // ⚠️ NAO CALIBRADO, no mesmo sentido dos tres limiares da S6.3: 0.10 foi
  // escolhido por estar obviamente fora de comportamento organico, nao por ter
  // sido medido contra esta populacao. A primeira leitura de producao e o que
  // transforma isso em calibracao — e a evidencia necessaria (`stampDays`, com
  // dia, share e base) sai na propria resposta.
  // O piso e 0.01 e nao 0 de proposito: em 0 todo dia vira carimbo, toda coorte
  // fica 100% contaminada e o relatorio inteiro sai em branco. A guarda espelhada
  // existe para o `CONTAMINATION_MAX` (`stamped > 0`, com teste); esta faltava.
  @IsOptional()
  @IsNumber()
  @Min(0.01)
  @Max(1)
  RETENTION_STAMP_DAY_MIN_SHARE?: number;

  // Populacao minima para o detector de carimbo opinar. Em vinte jogadores um
  // unico dia e trivialmente 10% da amostra, e chamar isso de importacao
  // suprimiria coortes reais na forca do ruido.
  @IsOptional()
  @IsInt()
  @Min(1)
  RETENTION_STAMP_DAY_MIN_POPULATION?: number;

  // Fracao de uma coorte caida em dia de carimbo acima da qual os D1/D7/D30
  // dela saem `null` COM o motivo e a evidencia — nunca os ~100% que o carimbo
  // produz, e nunca em silencio. Tambem nao calibrado.
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1)
  RETENTION_COHORT_CONTAMINATION_MAX?: number;

  // TTL do cache do payload do `/v1/retention`, em segundos. A secao 8 do spec
  // lista "cache com TTL por endpoint" como MITIGACAO, nao como otimizacao: sem
  // ele, uma aba de dashboard pode puxar as 5565 linhas 120 vezes por janela da
  // maquina do jogo, porque e isso que o throttle de dashboard permite.
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(86_400)
  RETENTION_CACHE_TTL_SECONDS?: number;
  // --- Relatorio semanal no Discord (AusTV Admin S9.2) ---

  // Webhook do canal onde o relatorio semanal e publicado. DELIBERADAMENTE
  // separado do `DISCORD_ALERT_WEBHOOK_URL`, e sem fallback para ele: o alerta
  // pagina ("quebrou, olha agora") e o relatorio e leitura de rotina. Misturar
  // os dois dilui o canal de alerta ate ninguem mais ler — que e exatamente
  // como um canal do Discord vira mudo, e este epico ja tem uma historia sobre
  // isso. Sem webhook, o relatorio ainda e gerado e persistido, e o boot avisa.
  @IsOptional()
  @IsUrl(
    { protocols: ['https'], require_protocol: true },
    { message: 'DISCORD_REPORT_WEBHOOK_URL must be an https URL' },
  )
  DISCORD_REPORT_WEBHOOK_URL?: string;

  // Chave geral do relatorio semanal. Desligada por padrao. Desligada, o boot
  // avisa em frase inteira: o modo de falha de um relatorio desligado e
  // SILENCIO, e silencio e o que este epico existe para tornar impossivel de
  // confundir com boa noticia.
  @IsOptional()
  @IsBoolean()
  WEEKLY_REPORT_ENABLED?: boolean;

  // Quando o relatorio e gerado, em cron, no fuso America/Sao_Paulo. Padrao:
  // segunda-feira as 09:00 BRT — relatorio que chega quando ninguem esta lendo
  // e relatorio que ninguem le. Expressao invalida deixa o job SEM agendar e
  // diz isso; nunca cai no padrao.
  @IsOptional()
  @MinLength(1, { message: 'WEEKLY_REPORT_CRON must not be empty when set' })
  WEEKLY_REPORT_CRON?: string;

  // --- Dimensao de jogador (AusTV Admin S9.1, ADR-008) ---
  //
  // Sem credencial nova: o ETL le o mesmo `/v1/retention` da S8.2 pelo
  // `PLAN_BASE_URL` que ja existe. O que ele traz para o PostgreSQL e a data de
  // registro por jogador, que e o eixo de COORTE da camada de economia — o
  // ADR-008 proibe cruzar `sales` (aqui) com o Plan (la) em memoria.

  // Chave geral do ETL. Desligado, a receita por PLATAFORMA continua saindo
  // (ela deriva do proprio uuid da venda, ADR-003), mas toda leitura por coorte
  // reporta `never_synced` e o tempo ate o primeiro gasto nao sai.
  //
  // ⚠️ Desligado por padrao, e o boot avisa em frase inteira. Em 2026-09-01 a
  // validacao de producao descobriu que o ETL do tutorial (S8.0) estava no repo
  // ha meses e nunca fora configurado na VPS — duas variaveis separavam dois
  // degraus do funil de jamais terem produzido numero. Este job tem a mesma
  // forma.
  @IsOptional()
  @IsBoolean()
  PLAYER_DIMENSION_SYNC_ENABLED?: boolean;

  // Quando o ETL roda, em cron, no fuso America/Sao_Paulo. Padrao 03:30 — meia
  // hora depois do ETL do tutorial, para dois jobs que alcancam a maquina do
  // jogo nao comecarem juntos. Expressao invalida deixa o job SEM agendar e diz
  // isso; nunca cai no padrao.
  @IsOptional()
  @MinLength(1, {
    message: 'PLAYER_DIMENSION_SYNC_CRON must not be empty when set',
  })
  PLAYER_DIMENSION_SYNC_CRON?: string;

  // --- PlayerPoints, somente leitura (AusTV Admin S9.1, ADR-007) ---
  //
  // Banco DIFERENTE do MySQL do Plan, e a distincao importa: a excecao 2 do
  // ADR-002 governa o schema do Plan, e este e outro plugin, autorizado pelo
  // ADR-007 ("leitura direta de schema de plugin e acoplamento aceito apenas
  // onde o schema e trivial e estavel" — seis colunas que nao se mexeram).
  //
  // ⚠️ O usuario tem de ser READ-ONLY e DEDICADO. O usuario dos plugins e
  // exatamente o que NAO se deve reusar: as credenciais dele estao em texto
  // plano em quatro configs de plugin no servidor do jogo.
  //
  // ⚠️ A tabela de origem NAO TEM INDICE NENHUM. Toda leitura e full table scan
  // no MySQL que o servidor de Minecraft usa. Por isso o ETL e noturno, opt-in,
  // e mede o proprio tempo dentro da query.

  @IsOptional()
  @MinLength(1, { message: 'PLAYERPOINTS_DB_HOST must not be empty when set' })
  PLAYERPOINTS_DB_HOST?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(65_535)
  PLAYERPOINTS_DB_PORT?: number;

  @IsOptional()
  @MinLength(1, { message: 'PLAYERPOINTS_DB_NAME must not be empty when set' })
  PLAYERPOINTS_DB_NAME?: string;

  @IsOptional()
  @MinLength(1, { message: 'PLAYERPOINTS_DB_USER must not be empty when set' })
  PLAYERPOINTS_DB_USER?: string;

  // Nunca logada.
  @IsOptional()
  PLAYERPOINTS_DB_PASSWORD?: string;

  // Nome da tabela de transacoes. Configuravel porque o PlayerPoints permite
  // prefixo — e validado por charset porque nome de tabela e IDENTIFICADOR, nao
  // parametro: ele e interpolado na query, e interpolacao e onde injecao mora.
  // O valor vem do nosso proprio .env, entao isto nao e a ultima linha de
  // defesa; e a que faz "alguem colou a coisa errada" falhar no boot em vez de
  // as 03:45.
  @IsOptional()
  @Matches(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/, {
    message:
      'PLAYERPOINTS_TABLE must be a plain SQL identifier (letters, digits, underscore)',
  })
  PLAYERPOINTS_TABLE?: string;

  // Chave geral do ETL de pagamentos. Desligado e o estado SEGURO: este e o
  // unico job do sistema que poe uma query no banco que o servidor de Minecraft
  // esta usando. Desligado, E3 e E4 reportam `never_synced`, nunca zero.
  @IsOptional()
  @IsBoolean()
  PAYMENTS_SYNC_ENABLED?: boolean;

  // Quando o ETL roda, em cron, America/Sao_Paulo. Padrao 03:45 — 15 minutos
  // depois da dimensao de jogador e 45 depois do ETL do tutorial. O escalonamento
  // nao e sobre carga (sao poucos milhares de linhas); e sobre nao ter tres jobs
  // alcancando a maquina do jogo no mesmo instante.
  @IsOptional()
  @MinLength(1, { message: 'PAYMENTS_SYNC_CRON must not be empty when set' })
  PAYMENTS_SYNC_CRON?: string;

  // --- E3: contato social nos primeiros minutos (S9.1) ---

  // Quantos minutos depois do registro contam como "os primeiros minutos".
  // ⚠️ NAO CALIBRADO. O spec diz "primeiros minutos" sem numero; 60 e um chute.
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(1_440)
  ECONOMY_SOCIAL_CONTACT_MINUTES?: number;

  // Valor que marca um pagamento como o passo `10tutorial` (`/pagar <nick> 100`).
  // A separacao entre tutorial e interacao espontanea e por ASSINATURA DE VALOR,
  // que e heuristica e vem rotulada como tal no payload: o log registra valor,
  // nao intencao.
  @IsOptional()
  @IsInt()
  @Min(1)
  ECONOMY_TUTORIAL_PAYMENT_AMOUNT?: number;

  // --- E4: limiares do feed de moderacao (S9.1) ---
  //
  // ⚠️ OS QUATRO SAO CHUTES NAO CALIBRADOS, na mesma prateleira dos tres da
  // S6.3. Eles saem no payload de proposito, para poderem ser julgados sem ler
  // o codigo — marcar e sinalizacao, nunca acusacao, e uma marca cujo limiar
  // ninguem consegue ver pede confianca cega.

  // Repeticoes do mesmo par emissor->receptor na janela que ligam a marca.
  @IsOptional()
  @IsInt()
  @Min(2)
  ECONOMY_FEED_REPEATED_PAIR_MIN?: number;

  // Receptores distintos de um mesmo emissor na janela que ligam a marca.
  @IsOptional()
  @IsInt()
  @Min(2)
  ECONOMY_FEED_FUNDING_MANY_MIN?: number;

  // Idade maxima da conta, em dias, para "conta nova recebendo alto".
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(90)
  ECONOMY_FEED_NEW_ACCOUNT_DAYS?: number;

  // Pagamentos minimos na janela para a marca de valor atipico existir. Um p95
  // sobre quatro observacoes e o maximo de quatro observacoes, e marcar isso
  // sinalizaria o maior pagamento comum de um mes tranquilo como anomalia.
  @IsOptional()
  @IsInt()
  @Min(1)
  ECONOMY_FEED_MIN_WINDOW_FOR_OUTLIER?: number;

  // --- Posicao no tutorial por jogador (AusTV Admin S9.3, secao 6.4 E2) ---
  //
  // ⚠️ SWITCH PROPRIO, separado do TUTORIAL_SYNC_ENABLED, e a separacao e o
  // ponto. A serie diaria e agregada em `(dia, plataforma)` e nao carrega
  // identidade de jogador; isto grava UMA LINHA POR JOGADOR, com uuid.
  //
  // E o alargamento da superficie de dado pessoal que a secao 8 do spec governa.
  // O dono autorizou a capacidade em 2026-09-02 — o switch e o que faz ligar
  // virar ato deliberado, em vez de um deploy comecar a gravar linha de jogador
  // porque a versao mudou.
  //
  // Desligado, o `/economy/first-spend` publica `byFunnelPosition: null` com o
  // motivo. A outra metade de E2 (tempo ate o primeiro gasto) nao depende disto.
  @IsOptional()
  @IsBoolean()
  TUTORIAL_POSITION_ENABLED?: boolean;

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
