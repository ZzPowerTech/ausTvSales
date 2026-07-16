# Spec técnica — Sprint 2: Ingestão de vendas autenticada + comando do plugin

> Fase 4 (design de implementação) — derivado de [`sprint-02.md`](../../sprints/sprint-02.md)
> Data: 2026-07-16
> Pré-requisito satisfeito: [ADR-0001](../../decisions/ADR-0001-auth-plugin-api.md) aceito (API key + IP allowlist + rate limiting)
> Objetivo: transformar as histórias S2.1–S2.4 em decisões de implementação prontas para PR, incorporando o estado real do código pós-Sprint 1.

---

## 0. Estado herdado da Sprint 1 (o que já existe e condiciona o design)

- **Guard global de sessão** (`SessionAuthGuard`, registrado no `AuthModule`): *deny-by-default* por cookie `httpOnly`; rotas públicas usam `@Public()`. O plugin **não tem sessão** → o endpoint de ingest precisa de tratamento próprio (ver §1).
- **`CreateSaleDto`** já existe em `backend/src/sales/dto/`, mas **sem `nickname_at_purchase`** — lacuna a corrigir na S2.2.
- **`GET /items`** existe (`ItemsController`), porém atrás do guard de sessão e devolvendo o `Item` completo — **não reusável** pelo plugin; a S2.3 cria variante enxuta protegida por API key.
- **Schema `sales`** já tem PK `id` (UUID do cliente) + `check` de `qtd > 0` e `total_price > 0` — a idempotência e a defesa de integridade estão na camada de dados.
- **Env vars** validadas por `class-validator` em `config/env.validation.ts` — novas chaves seguem esse padrão.
- **Plugin** já tem scaffolding: `AusTvSalesPlugin`, `SaleCommandParser` (puro, 24 testes), `SaleCommandExecutor` (esqueleto), `config.yml`, `plugin.yml` (comando `austv-sales`, permissão `austv.sales.admin` default `op`), update checker. A S2.4 preenche o executor + cliente HTTP.
- **Sem `@nestjs/throttler`** ainda — a S2.1 adiciona a camada de app do rate limiting.

---

## 1. S2.1 — Autenticação plugin→API + rate limiting

### 1.1 Composição de guards (decisão central)

O ingest **não pode** passar pelo `SessionAuthGuard`. Duas rotas do plugin (`POST /sales`, `GET /items/sync`) formam um grupo "ingest". Design:

- Marcar as rotas de ingest com `@Public()` para **escapar** do guard de sessão global.
- Aplicar um **`IngestApiKeyGuard` dedicado** via `@UseGuards(IngestApiKeyGuard)` no controller de ingest (não global) — assim `@Public()` **não** deixa a rota aberta; ela troca a autenticação de sessão pela de API key.
- Para evitar erro de "esqueci de aplicar o guard e a rota ficou pública", criar um **decorator composto** `@IngestAuth()` = `applyDecorators(Public(), UseGuards(IngestApiKeyGuard))`. Toda rota de ingest usa só esse decorator.

### 1.2 `IngestApiKeyGuard`

- Lê o header `X-Api-Key` (fallback `Authorization: Bearer <key>` opcional).
- Compara em **tempo constante** (`crypto.timingSafeEqual`, igual ao guard de sessão) contra o conjunto de chaves aceitas.
- **Suporte a rotação (dupla-chave):** env `INGEST_API_KEYS` = lista separada por vírgula; a comparação constante roda contra cada chave (curto-circuito só após checar todas para não vazar timing). MVP pode ter 1 chave; a lista permite a janela de rotação do ADR sem downtime.
- Falha (ausente/ inválida) → **401**, log com IP de origem (`X-Forwarded-For` atrás do Nginx) e rota, **sem** vazar qual parte falhou.

### 1.3 Env vars novas (`env.validation.ts`)

```
INGEST_API_KEYS   # obrigatória em prod; regex: hex de >=32 chars, 1+ separados por vírgula
```
Gerada por `openssl rand -hex 32`. Nunca commitada; injetada como secret no deploy.

### 1.4 Rate limiting (camada de app)

- Adicionar `@nestjs/throttler`; aplicar **só** ao grupo de ingest (não ao dashboard, que tem outro perfil de uso).
- Ponto de partida do ADR: ~10 req/s com burst pequeno → **429** ao estourar. Números finais calibrados aqui com base no volume real de vendas (baixo — é 1 req por compra).
- O Nginx (`limit_req` + `allow <ip do jogo>; deny all;`) é a borda; o throttler é defesa se alguém furar o proxy. A config do Nginx vive no repo de infra/VPS (fora deste repo) — **documentar** o trecho no PR, não versionar aqui.

### 1.5 Fatiamento do PR (S2.1)

Entrega: `IngestApiKeyGuard` + `@IngestAuth()` + throttler + **rota stub protegida** (ex.: `POST /sales` respondendo 501/echo). A lógica de negócio vem na S2.2 por cima do guard já mergeado. Revisão do `cybersecurity-validator` registrada no PR (bloqueante).

---

## 2. S2.2 — `POST /sales` idempotente com validação de catálogo

### 2.1 Corrigir o DTO (lacuna)

Adicionar ao `CreateSaleDto`:
```ts
@IsString() @IsNotEmpty()
nickname_at_purchase!: string;
```
Manter o resto (snake_case do contrato do plugin, `total_price` decimal 2 casas > 0, `qtd` ≥ 1, `purchased_at` ISO-8601, `sale_id`/`player_uuid` UUID).

### 2.2 Fluxo do serviço (transação única)

1. Buscar `item_id` na tabela `items`. **Inexistente ou `active = false` → 422**, log claro, **sem** criar player nem sale (CA2). *Item inativo = permanente (4xx), não reenfileirar.*
2. **Upsert de `players`** por `player_uuid`: cria se não existe; se o `nickname_at_purchase` difere do `last_known_nickname`, atualiza nick + `updated_at`. (O nick do evento é snapshot histórico; o do player é "mais recente" para exibição.)
3. **Insert em `sales`** com `ON CONFLICT (id) DO NOTHING` → reenvio do mesmo `sale_id` **não duplica** (2xx idempotente; a constraint da S1.2 é a última defesa). `created_at` do banco; `purchased_at` do payload.
4. Responder **2xx** (200 em conflito idempotente, 201 em criação — ou 200 sempre, decidir e documentar).

### 2.3 Contrato de status codes (insumo direto do worker do Sprint 3)

| Código | Significado | Ação do plugin |
|---|---|---|
| **2xx** | ACK definitivo (gravado ou já existia) | marcar `sent`, não reenfileirar |
| **4xx** (422 item, 400 payload, 401 auth) | erro **permanente** | **não** reenfileirar; logar para investigação |
| **5xx** / timeout / sem rede | **transitório** | reenfileirar (fila SQLite chega na S3) |

Documentar essa tabela no README do backend — o worker da S3 depende dela.

### 2.4 Testes e2e

sucesso; duplicata (mesmo `sale_id` 2x → 1 linha); item desconhecido → 422 sem player criado; item inativo → 422; payload malformado → 400; nick novo atualiza player, nick igual não faz UPDATE desnecessário.

---

## 3. S2.3 — `GET /items/sync` para o cache do plugin

- Nova rota **enxuta**, protegida por `@IngestAuth()` (mesma API key da S2.1), separada do `GET /items` do dashboard.
- Retorna **apenas itens ativos**, campos mínimos: `{ itemId, active }` (ou só a lista de `itemId` ativos). O plugin valida `item_id` localmente antes de aceitar o comando — zero rede por venda.
- **Estratégia de sincronização (decidir e documentar no PR):** resposta completa barata (catálogo pequeno) é suficiente para o MVP; `ETag`/`If-None-Match` ou `?since=updated_at` fica como otimização. Recomendação: resposta completa + `Cache-Control` curto; polling do plugin a cada N minutos.

---

## 4. S2.4 — Plugin Paper: comando `austv-sales add` (caminho feliz)

### 4.1 Já pronto (não refazer)

`SaleCommandParser` (validação pura testável) e o esqueleto do executor existem. A S2.4 **preenche**, não recria.

### 4.2 A implementar

- **Config** (`config.yml`): bloco `api:` com `base-url`, `api-key` (nunca commitado — placeholder no repo), `timeout-ms`, `sync-interval` (para S3/S2.3). Lido no `onEnable`; validar presença da key ou desabilitar o envio com log de erro.
- **`SaleCommandExecutor`** (caminho feliz):
  1. Restrito a console/`austv.sales.admin` (default `op`) — jogador comum não forja venda via chat (já no `plugin.yml`).
  2. Parse via `SaleCommandParser`; argumento inválido (preço não numérico, `qtd < 1`) → rejeita com log, nada enviado.
  3. **Normalizar `total_price`** vindo do `%price%` do Genesis (possível vírgula decimal / símbolo de moeda) — testar com valor real no servidor de teste (risco do sprint).
  4. Resolver `player_nick → player_uuid` via Bukkit (`getOfflinePlayer`/cache); não resolvível → erro logado, evento **não** enviado.
  5. `purchased_at = Instant.now()` e `sale_id = UUID.randomUUID()` **no executor** — nunca de argumento.
  6. **Envio assíncrono** (`BukkitRunnable.runTaskAsynchronously`) via `java.net.http.HttpClient` HTTPS com header `X-Api-Key` — **zero I/O de rede na main thread**.
- **Falha nesta fase** (timeout/5xx/sem rede): log de erro explícito marcado `// TODO Sprint 3 (queue)` — **sem** fila ainda.
- **Cache de itens:** validação local completa é da **S3.1**; na S2.4, se o cache existir o plugin loga, mas a rejeição definitiva de item desconhecido é sempre da API.

### 4.3 Teste manual documentado

comando no servidor Paper de teste → conferir linha em `sales` no Postgres com `purchased_at` correto. Registrar o passo-a-passo no PR (parte do critério de aceite).

---

## 5. Ordem de execução recomendada (dependências)

```
S2.1 (guard ingest + throttler + rota stub)     ← bloqueante; nada de ingest sem isto
  └─ S2.2 (POST /sales idempotente)              ← coração; contrato de status codes
  └─ S2.3 (GET /items/sync)                       ← pode ir em paralelo à S2.2 (mesmo guard)
        └─ S2.4 (plugin: comando + HTTP client)   ← consome S2.2 e S2.3
```

- **S2.1 primeiro e sozinho** (revisão de segurança bloqueante).
- **S2.2 e S2.3 em paralelo** depois — ambas dependem só do guard da S2.1, não uma da outra.
- **S2.4 por último** — precisa dos dois endpoints prontos para o teste de ponta a ponta.
- **1 história = 1 PR** (convenção do projeto). S2.4 pode ser 1 PR grande; se apertar, fatiar em "scaffolding + parser wiring" e "HTTP client + envio", mas mantendo cada PR deployável.

## 6. Subagents por história

| História | Subagent(s) |
|---|---|
| S2.1 | `devops-specialist` + `backend-specialist` · revisão `cybersecurity-validator` |
| S2.2 | `backend-specialist` (+ `database-specialist` no upsert/idempotência) |
| S2.3 | `backend-specialist` |
| S2.4 | `gamedev-plugin-specialist` + `backend-specialist` |

## 7. Riscos (herdados + novos deste design)

| Risco | Mitigação |
|---|---|
| `@Public()` na rota de ingest deixar a rota aberta se o `IngestApiKeyGuard` não for aplicado | Decorator composto `@IngestAuth()` — impossível marcar público sem aplicar o guard |
| `%price%` do Genesis em formato inesperado | Normalização + teste com valor real (S2.4) |
| Vendas perdidas se a API cair (sem fila) | Aceitável: cutover só no Sprint 6, após a fila (Sprint 3) |
| Timing leak na comparação de múltiplas keys | Comparar contra todas as chaves antes de retornar; `timingSafeEqual` por chave |
| Semântica de erro mal definida quebrar o worker da S3 | Tabela de status codes é critério de aceite explícito (§2.3) |

## 8. Definition of Done (espelha `sprint-02.md`)

- Todo código via PR revisado, CI verde (backend + plugin).
- Nenhum endpoint novo acessível sem autenticação; revisão de segurança da S2.1 no PR.
- Demo ponta a ponta: cadastrar item (Sprint 1) → comando no Paper de teste → linha em `sales` com `purchased_at` correto.
- Reenvio manual do mesmo payload não duplica venda.
- Contrato 2xx/4xx/5xx documentado no README do backend.
</content>
</invoke>
