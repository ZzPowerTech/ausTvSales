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

## Ingestão de vendas (plugin → API)

O plugin do servidor de jogo envia cada venda para `POST /sales`. Esse grupo de rotas
(ingest) **não** usa a sessão de dashboard: autentica por **API key** (ADR-0001), via
o decorator `@IngestAuth()` (`@Public()` para escapar do guard de sessão + `IngestApiKeyGuard`
+ rate limiting). Detalhes:

- **Header:** `X-Api-Key: <key>` (fallback `Authorization: Bearer <key>`).
- **`INGEST_API_KEYS`** (obrigatória no boot): lista separada por vírgula de chaves de
  64 hex (`openssl rand -hex 32`). Múltiplas chaves permitem a janela de rotação
  dupla-chave sem downtime (ver ADR-0001). Nunca commitar o valor real.
- **Comparação em tempo constante** (`crypto.timingSafeEqual` sobre digests SHA-256, sem
  short-circuit entre chaves) — não vaza qual/quantas chaves casaram nem o tamanho.
- **Rate limiting** (`@nestjs/throttler`) aplicado só ao grupo de ingest: ~10 req/s
  (calibrável em `src/ingest/ingest.throttle.ts`) → `429` ao estourar.
- **Allowlist de IP no app** (`IngestIpAllowlistGuard`, defesa em profundidade sobre o Nginx):
  primeiro guard do `@IngestAuth()`, roda **antes** da checagem de key — uma chave vazada é inútil
  fora do IP da VPS do jogo. `INGEST_ALLOWED_IPS` = lista de IPs exatos (obrigatória em produção,
  opcional em dev; vazio = desabilitada). IP de origem lido de `req.ip`, confiável porque o app
  fixa `trust proxy` no hop do Nginx (`TRUST_PROXY`, `main.ts`) — assim um `X-Forwarded-For` forjado
  por conexão direta é ignorado. Fora da allowlist → **403**.
- **Borda no Nginx:** `allow <ip da VPS do jogo>; deny all;` + `limit_req` no `location` do ingest.
  A allowlist do app é a **segunda linha** caso a regra do Nginx falte/esteja errada. Trecho de
  referência versionado em [`docs/nginx-ingest.md`](docs/nginx-ingest.md).

### `POST /sales` — persistência idempotente (S2.2)

Fluxo numa transação única (`SalesService`):

1. **Validação de catálogo:** busca o `item_id` em `items`. Item inexistente **ou** inativo
   (`active = false`) → **422**, sem criar player nem venda (item inativo é erro permanente).
2. **Upsert de player** por `player_uuid`: cria se novo; se o `nickname_at_purchase` mudou,
   atualiza `last_known_nickname` + `updated_at` — o nick igual não dispara UPDATE.
3. **Insert em `sales`** com `ON CONFLICT (id) DO NOTHING`: reenviar o mesmo `sale_id` não
   duplica. `purchased_at` vem do payload; `created_at` é carimbado pelo banco.

Status de sucesso: **201 Created** quando a venda é gravada agora; **200 OK** quando o
`sale_id` já existia (reenvio idempotente). Ambos são 2xx (ACK) — a distinção é só
observabilidade; o plugin trata os dois igual.

### Contrato de status codes (insumo do worker do Sprint 3)

O worker da fila SQLite decide reenfileirar ou não **pela classe do status HTTP**:

| Código | Significado | Ação do plugin/worker |
|---|---|---|
| **2xx** (201 gravada, 200 já existia) | ACK definitivo | marcar `sent`, **não** reenfileirar |
| **4xx** (422 item inexistente/inativo, 400 payload inválido, 401 auth) | erro **permanente** | **não** reenfileirar; logar para investigação |
| **5xx** / timeout / sem rede | **transitório** | reenfileirar (fila SQLite chega na S3) |

> Regra de ouro do worker: só reenfileira 5xx/timeout. Qualquer resposta HTTP definitiva
> (2xx ou 4xx) encerra a tentativa daquele `sale_id`.

### Rotas de ingest

| Rota | Auth | Descrição |
|---|---|---|
| `POST /sales` | `@IngestAuth()` | Recebe uma venda do plugin (persistência idempotente na S2.2). |
| `GET /items/sync` | `@IngestAuth()` | Catálogo enxuto para o cache local do plugin (S2.3). |

**`GET /items/sync` (S2.3)** — separado do `GET /items` do dashboard (que é session-guarded
e devolve o `Item` completo). Serve **apenas itens ativos** (`active = true`) numa projeção
mínima, para o plugin validar `item_id` localmente antes de aceitar o comando de venda — **zero
rede por venda**.

- **Resposta:** array ordenado por `itemId` de `{ itemId, active }` (sempre `active: true`; o
  campo é mantido explícito para deixar o contrato claro e absorver uma futura variação sem
  quebrar o cliente). Ex.:
  ```json
  [ { "itemId": "caixaNatal2026", "active": true }, { "itemId": "vipGold", "active": true } ]
  ```
- **Estratégia de sync (decisão MVP):** o catálogo é pequeno, então devolvemos a lista ativa
  **completa** a cada requisição + `Cache-Control: private, max-age=60` (+ `Vary: X-Api-Key,
  Authorization`). É **`private`** de propósito: a rota é protegida por API key, então caches
  compartilhados/proxies não podem armazenar e servir o catálogo a um chamador não autenticado —
  o TTL de 60s vale só para o cliente do próprio plugin. O plugin faz *polling* a cada N minutos
  (`sync-interval`, S2.4). `ETag`/`If-None-Match` e delta via `?since=updated_at` ficam como
  otimização futura — desnecessários neste volume.
- **Convivência com `GET /items/:id`:** `ItemsSyncController` é registrado **antes** de
  `ItemsController` no módulo, para a rota estática `/items/sync` casar antes da rota param
  `/items/:id` (cujo `ParseIntPipe` rejeitaria `"sync"`).

## Administração do catálogo (dashboard)

Rotas protegidas pela sessão do dashboard (guard global) — consumidas pelas telas do
Sprint 4. Categoria e item **nunca** são apagados fisicamente: vendas históricas os
referenciam por chave estrangeira.

| Rota | O que faz |
|---|---|
| `POST/GET/PATCH /categories` | CRUD de categorias (S1.5) |
| `PATCH /categories/reorder` | Reordenação atômica da sidebar (S4.0) |
| `POST/GET/PATCH /items` | CRUD de itens (S1.6); `item_id` é imutável após a criação |

**Unicidade de nome de categoria (S4.0)** — garantida em duas camadas:

1. `CategoriesService.assertNameAvailable` pré-checa e devolve um 409 com mensagem
   legível (é a proteção contra typo que o usuário vê no formulário).
2. O índice único funcional `categories_name_lower_unique` (`lower(name)`) é a garantia
   real: o par checa-depois-insere é uma corrida, e o índice fecha essa janela. Uma
   violação `23505` é traduzida para o **mesmo 409**, nunca um 500.

**`PATCH /categories/reorder` (S4.0)** — recebe o conjunto **completo** de ids na ordem
desejada e grava `display_order` por posição, dentro de **uma transação**.

```jsonc
// PATCH /categories/reorder
{ "order": [3, 1, 2] }   // → 200, Category[] já reordenado
```

- **Por que o conjunto completo:** um cliente defasado (segunda aba que nunca viu uma
  categoria nova) falha com **400** em vez de gravar uma ordem com buracos.
- **Por que transacional:** uma falha no meio deixa a ordem anterior intacta, então o
  dashboard pode reordenar otimisticamente e reverter para um estado coerente.
- **Convivência com `PATCH /categories/:id`:** `@Patch('reorder')` é declarado **antes**
  de `@Patch(':id')` no controller — mesma armadilha de `/items/sync` vs `/items/:id`
  (o `ParseIntPipe` do `:id` rejeitaria `"reorder"`). Coberto por teste e2e.

## Análise de vendas (dashboard)

Leituras agregadas para as telas de visualização (S5.1), atrás da **sessão do dashboard**
(guard global — módulo `analytics` separado de `sales`, que é o caminho de escrita do plugin
com API key). `:id` de categoria é inteiro; `:itemId` é a chave de negócio opaca (texto).

| Rota | O que faz |
|---|---|
| `GET /analytics/categories/:id/items` | Itens da categoria com contagem, quantidade e receita no período |
| `GET /analytics/items/:itemId/top-buyers` | Top compradores por receita (`limit`, padrão 5) |
| `GET /analytics/items/:itemId/series` | Série temporal por bucket (`day`\|`week`\|`month`, padrão `day`) |

**Período** (`?from=&to=`, `YYYY-MM-DD`, opcionais) — datas em **America/Sao_Paulo**, janela
semiaberta `[from 00:00, to+1d 00:00)`. Omitir ambos = toda a história. `from > to` → **400**
igual nas três rotas. Categoria/item inexistente → **404**; período sem vendas → **200** com
zeros/array vazio (não é erro).

**Regra do `historical_import`** (spec §2.4) — a migração histórica conta para apuração mas
não tem timestamp real por evento:

| Agregação | Linhas históricas |
|---|---|
| Totais por item / receita | **incluídas** |
| Top compradores | **incluídas** |
| Série temporal | **excluídas** — vêm no campo `excludedHistorical` como baseline, nunca como ponto datado (CA7) |

**Duas armadilhas fechadas por teste e2e:**

- **Fuso (§2.3):** o bucket usa `date_trunc(bucket, purchased_at AT TIME ZONE 'America/Sao_Paulo')`.
  Sem o `AT TIME ZONE`, uma venda às 21h BRT cairia no bucket do dia seguinte em UTC e o pico de
  lançamento de crate apareceria partido em dois dias.
- **Dinheiro (§2.5):** `SUM(total_price)` trafega como **string** de ponta a ponta; o driver `pg`
  devolve `numeric` como string e um `parseFloat` no meio reintroduziria o erro de ponto flutuante
  que a coluna `numeric(12,2)` existe para evitar.

Janela ampla demais na série (> 366 buckets) → **400** (§2.8): protege o gráfico e é um vetor de
DoS barato mesmo atrás de sessão.

> **Índices (S5.1):** o top-N filtra por `item_id` + período e agrupa por `player_uuid`.
> `sales_item_purchased_at_idx (item_id, purchased_at)` atende o filtro; `sales_player_item_idx`
> tem `player_uuid` como coluna líder e **não** serve a esse acesso. O `EXPLAIN` sobre o dataset
> de 50k (S5.0) confirma o plano; um índice de cobertura, se necessário, é débito documentado —
> não migration de última hora.

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

## Gerador de vendas sintéticas (S5.0)

Ferramenta **de desenvolvimento** para popular `sales` com volume realista — necessária para
demonstrar as telas da Sprint 5 e para medir as agregações da S5.1 com `EXPLAIN` sobre dados
reais em vez de tabela vazia.

```bash
# dataset de ~50k vendas usado na DoD da Sprint 5
SEED_ALLOW=true npm run seed:sales -- --count=50000 --from=2026-01-01 --to=2026-07-20
```

| Flag | Padrão | O que faz |
|---|---|---|
| `--count` | `50000` | Total de vendas geradas |
| `--from` / `--to` | últimos 180 dias | Janela em `America/Sao_Paulo`; `--to` é **inclusivo como dia** |
| `--seed` | `austv` | Semente do PRNG. Mesma seed = mesmo dataset; seed nova = dataset disjunto |
| `--players` | `500` | Tamanho do pool de jogadores sintéticos |
| `--historical-ratio` | `0.1` | Fração de linhas com `historical_import = true` |

**Guardas (o script aborta com exit 1, sem perguntar):**

- `NODE_ENV=production`;
- `SEED_ALLOW` diferente de `true` — opt-in explícito, ausente de qualquer `.env` versionado;
- host do `DATABASE_URL` listado em `SEED_FORBIDDEN_HOSTS`.

Prompt de confirmação seria inútil aqui: o dano acontece justamente quando o script roda dentro
de um pipeline, onde não há ninguém para responder.

**Propriedades que o dataset garante** (spec [S5.0](../.specs/features/sprint-05-dashboard-analytics/spec.md#1-s50--gerador-de-vendas-sintéticas)):

- **Idempotente** — `sale_id` é derivado de `<seed>:<índice>`, então re-rodar o mesmo comando é
  no-op via `ON CONFLICT DO NOTHING`. Dá para somar volume trocando só `--seed`.
- **Determinístico** — nenhum `Math.random()`; dois `EXPLAIN` só são comparáveis se as linhas
  embaixo forem idênticas.
- **Troca de nickname** — ~20% dos jogadores renomeiam dentro da janela, com
  `nickname_at_purchase` congelado no nick da época. É o que permite provar o CA4 na tela
  (ranking mostra `last_known_nickname`), e não só em teste unitário.
- **`historical_import` num único instante** anterior à janela, espelhando a migração da
  Sprint 6 — inventar granularidade falsa é exatamente o que o CA7 proíbe.
- **Distribuição enviesada** por item e por jogador; um dataset uniforme renderiza um gráfico
  plano e faz a demo do CA5 não provar nada.

O código vive em `scripts/` e é excluído do `tsconfig.build.json` — **nunca vai para o `dist/`**
da imagem de produção.

## Testes

```bash
npm test          # unitários (sem banco) — inclui as regras do gerador em scripts/seed/
npm run test:e2e  # e2e — requer Postgres no ar + migrations aplicadas
```

O CI (`.github/workflows/backend-ci.yml`) sobe um serviço `postgres:16`, roda `db:migrate`
e então os testes e2e (schema + health) contra o banco real.
