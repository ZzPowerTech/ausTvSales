# backend — austv-sales

API NestJS (Node 22) do sistema de vendas por cash do AusTV. Persistência em
PostgreSQL via [Drizzle ORM](https://orm.drizzle.team) (schema type-safe + migrations
SQL versionadas e revisáveis).

## Stack

- **NestJS 11** + TypeScript (Google Style)
- **PostgreSQL 16** — em produção reaproveita a instância do AusTV Finance (database/usuário dedicados)
- **Drizzle ORM 0.45** + `drizzle-kit` para geração/aplicação de migrations
- **Jest** — testes unitários (`*.spec.ts` em `src/`) e e2e (`test/*.e2e-spec.ts`, exigem Postgres real)

## Setup de desenvolvimento

```bash
# 1. dependências
npm install

# 2. variáveis de ambiente
cp .env.example .env        # ajuste DATABASE_URL se necessário

# 3. banco local (PostgreSQL 16 em container)
docker compose up -d

# 4. aplicar migrations
npm run db:migrate

# 5. subir a API
npm run start:dev           # http://localhost:3000/health
```

`GET /health` retorna `{ status, components: { database } }` — `database: "ok"` quando o
`SELECT 1` no Postgres responde, `"error"` caso contrário.

## Autenticação (login por Discord)

O painel é de acesso restrito: **todas** as rotas exigem uma sessão autenticada por
padrão (guard global _deny-by-default_), exceto `GET /health` e as rotas de login
(`@Public()`). O login é feito via **Discord OAuth2** e liberado apenas para os IDs
listados em `ALLOWED_DISCORD_IDS` (dois usuários). A sessão vive num cookie httpOnly
assinado (JWT); nenhum token trafega para o JavaScript do frontend.

Rotas:

| Rota | Descrição |
|---|---|
| `GET /auth/discord/login` | Inicia o fluxo OAuth (redirect para o Discord) |
| `GET /auth/discord/callback` | Callback do Discord: valida `state`, checa allowlist, cria a sessão |
| `POST /auth/logout` | Limpa o cookie de sessão |
| `GET /auth/me` | Retorna o usuário autenticado (rota protegida) |

Variáveis de ambiente (ver [`.env.example`](.env.example)) — **obrigatórias para o boot**:

| Variável | O que é |
|---|---|
| `DISCORD_CLIENT_ID` / `DISCORD_CLIENT_SECRET` | Credenciais do app no Discord Developer Portal |
| `DISCORD_REDIRECT_URI` | URL pública do callback (ex: `https://sales.austv.net/api/auth/discord/callback`) — cadastrar no app do Discord |
| `ALLOWED_DISCORD_IDS` | IDs (snowflakes) autorizados, separados por vírgula (dois usuários) |
| `SESSION_JWT_SECRET` | Segredo para assinar o JWT de sessão (mín. 32 chars) |
| `FRONTEND_BASE_URL` | Base do dashboard para os redirects (`/` em produção; dev: `http://localhost:4200`) |
| `CORS_ORIGIN` | Origem permitida para CORS com credenciais (apenas dev cross-origin) |

> **Deploy:** o backend **não sobe** sem essas variáveis (validação de ambiente no boot).
> Configure os segredos de produção fora do repositório antes de fazer deploy.

## Banco de dados (Drizzle)

| Comando | O que faz |
|---|---|
| `npm run db:generate` | Gera uma nova migration SQL em `drizzle/` a partir de `src/db/schema.ts` |
| `npm run db:migrate` | Aplica as migrations pendentes (idempotente — controla via `drizzle.__drizzle_migrations`) |

- Schema: [`src/db/schema.ts`](src/db/schema.ts) — 4 tabelas do spec §4 (`categories`, `items`, `players`, `sales`).
- Migrations geradas: `drizzle/*.sql` — **versionadas e revisáveis** (não editar à mão; regenerar via `db:generate`).
- Injeção no Nest: `DatabaseModule` (`@Global`) provê os tokens `DRIZZLE` (instância type-safe) e `PG_POOL` (pool `pg`), e fecha o pool no shutdown.

> **Fluxo forward-only:** o `drizzle-kit` gera apenas migrations de avanço. Para recomeçar em
> dev, `docker compose down -v` recria o volume do Postgres do zero. Rollback granular não é usado.

## Testes

```bash
npm test          # unitários (sem banco)
npm run test:e2e  # e2e — requer Postgres no ar + migrations aplicadas
```

O CI (`.github/workflows/backend-ci.yml`) sobe um serviço `postgres:16`, roda `db:migrate`
e então os testes e2e (schema + health) contra o banco real.
