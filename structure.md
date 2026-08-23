# structure.md — austv-sales

> Árvore de código-fonte. Regenerável — atualizar sempre que a arquitetura mudar
> significativamente (nova pasta de topo, novo módulo, novo serviço).
>
> Última regeneração: 2026-08-21 (Sprints 1–5 entregues).

```
austv-sales/
├── .claude/                        # Config do Claude Code (settings, launch; worktrees gitignored)
├── .github/workflows/              # CI por stack (dispara por pasta tocada) + release
│   ├── backend-ci.yml              #   backend/**  → npm ci + lint + test + e2e (Node 22 + Postgres)
│   ├── frontend-ci.yml             #   frontend/** → npm ci + lint + test headless (Node 22)
│   ├── plugin-ci.yml               #   plugin/**   → gradlew build test (Temurin 21)
│   ├── backend-release.yml         #   imagem Docker da API por tag
│   ├── frontend-release.yml        #   imagem Docker do dashboard por tag
│   ├── plugin-release.yml          #   JAR do plugin por tag (re-disparável via workflow_dispatch)
│   └── release-please.yml          #   versionamento automatizado por Conventional Commits
├── .specs/                         # Specs, design docs, ADRs e sprints
│   ├── project/PROJECT.md          # Spec aprovado — fonte de verdade do escopo
│   ├── decisions/                  # ADRs (auth plugin→API, permissões, biblioteca de gráfico, NTP)
│   ├── features/                   # Design de implementação por sprint/feature
│   │   └── austv-admin/HANDOFF.md  #   Épico separado (analytics de retenção) — ver avisos no topo
│   └── sprints/                    # Plano de 6 sprints (Fase 3 Scrum)
├── plugin/                         # Plugin Java (Paper 1.21.x, Gradle, Java 21)
│   └── src/
│       ├── main/java/de/austv/sales/
│       │   ├── AusTvSalesPlugin.java   # JavaPlugin (onEnable/onDisable)
│       │   ├── api/                    # Cliente HTTP da API: payload, JSON, config, entrega, sync de itens
│       │   ├── cache/                  # ItemCache + ItemSyncTask (catálogo local, valida antes de enviar)
│       │   ├── command/                # Parser puro, executor Bukkit, tab complete, normalização de preço
│       │   ├── queue/                  # SaleQueue (SQLite) + SaleQueueWorker (reenvio idempotente)
│       │   └── update/                 # UpdateChecker
│       ├── main/resources/             # config.yml + plugin.yml
│       └── test/java/de/austv/sales/   # JUnit 5 — cobre api, cache, command, queue, update
├── backend/                        # API NestJS + PostgreSQL (Drizzle)
│   ├── docker-compose.yml          # PostgreSQL 16 local para desenvolvimento
│   ├── Dockerfile                  # Imagem de produção
│   ├── docs/nginx-ingest.md        # Exposição do endpoint de ingestão atrás do Nginx
│   ├── drizzle.config.ts           # Config do drizzle-kit (schema → migrations SQL)
│   ├── drizzle/                    # Migrations SQL versionadas (geradas, revisáveis)
│   ├── scripts/                    # seed-sales.ts + scripts/seed/ (gerador de vendas sintéticas — S5.0)
│   ├── test/                       # Suítes e2e (analytics, auth, catálogo, schema, health, seed)
│   └── src/
│       ├── config/                 # env.validation, ValidationPipe global, trust proxy
│       ├── db/                     # schema.ts (tabelas do spec §4) + DatabaseModule (Drizzle/pg)
│       ├── health/                 # GET /health — SELECT 1 real no Postgres
│       ├── auth/                   # Sessão do dashboard: Discord OAuth, allowlist, guard (ADR-0002)
│       ├── ingest/                 # Proteção do endpoint do plugin: API key, IP allowlist, throttle
│       ├── categories/             # CRUD de categorias (cadastro manual, autenticado)
│       ├── items/                  # CRUD de itens + endpoint de sync consumido pelo plugin
│       ├── sales/                  # POST /sales idempotente (contrato do plugin)
│       └── analytics/              # Leitura agregada: top compradores e série temporal (S5.1)
├── frontend/                       # Dashboard Angular (standalone + Signals)
│   ├── Dockerfile / nginx.conf     # Build estático servido por Nginx
│   └── src/
│       ├── styles/_tokens.scss     # Tokens de design
│       └── app/
│           ├── core/
│           │   ├── guards/         # authGuard
│           │   ├── interceptors/   # credentials + tratamento de erro de auth
│           │   ├── models/         # Sale/Item/Category/AuthUser/Analytics
│           │   ├── services/       # api, auth, categories, items, analytics
│           │   └── utils/          # period, currency
│           └── features/
│               ├── login/          # Tela de login (Discord OAuth)
│               ├── dashboard/      # Shell + sidenav
│               ├── catalog/        # Cadastro de categorias e itens (Sprint 4)
│               └── analytics/      # Página de categoria + top 5 + sales-series-chart (Sprint 5)
├── ops/                            # Operação e diagnóstico (AusTV Admin) — não vai para build
│   └── baseline/                   # "Antes" congelado da campanha de unban (S6.0)
│       ├── README.md               #   como ler cada número e suas limitações
│       ├── scripts/                #   austv-diagnostico{,2}.ps1 — leitura offline do clone
│       └── 2026-08-19/             #   saída da execução, uma pasta por snapshot
├── CLAUDE.md                       # Contexto e convenções do projeto
├── README.md                       # Visão geral
├── structure.md                    # Este arquivo
├── LICENSE                         # MIT
└── release-please-config.json      # Versionamento por pacote (plugin/backend/frontend)
```

Sprints 1–5 entregues: fundação e schema, ingestão autenticada, resiliência do plugin (cache +
fila SQLite + worker), administração de catálogo no dashboard e visualização (navegação por
categoria, ranking top 5, gráfico de série temporal).

Pendente do MVP: Sprint 6 — migração histórica, cutover dos rewards do Genesis e validação final
de segurança (issues #27–#30).
