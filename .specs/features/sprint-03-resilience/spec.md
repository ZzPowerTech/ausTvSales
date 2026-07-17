# Spec técnica — Sprint 3: Resiliência do plugin (cache de itens, fila SQLite e reenvio)

> Fase 4 (design de implementação) — derivado de [`sprint-03.md`](../../sprints/sprint-03.md)
> Data: 2026-07-17
> Pré-requisitos satisfeitos:
> - `POST /sales` idempotente + **contrato de status codes** documentado (S2.2, PR #56 mergeado) — ver `backend/README.md` §"Contrato de status codes".
> - `GET /items/sync` enxuto protegido por API key (S2.3, PR #54 mergeado).
> - Comando `austv-sales add` com envio autenticado assíncrono (S2.4, PR #59 mergeado).
> Objetivo: transformar as histórias S3.1–S3.4 em decisões de implementação prontas para PR, incorporando o estado real do código pós-Sprint 2.

---

## 0. Estado herdado da Sprint 2 (o que já existe e condiciona o design)

Grande parte da fundação da resiliência **já está no lugar** — a Sprint 2 deixou ganchos explícitos. O trabalho da Sprint 3 é preencher, não recriar.

- **Classificação de resultado já existe:** `SaleDelivery.Outcome { ACK, PERMANENT, TRANSIENT }` + `SaleDelivery.classify(int)` (`plugin/.../api/SaleDelivery.java`) já implementam o contrato §2.3 da S2.2. **A decisão de reenfileirar já está tomada em código** — falta apenas *agir* sobre ela.
- **`SaleApiClient.deliver(SalePayload)` hoje retorna `void`** e apenas loga o resultado (com marcador `// TODO Sprint 3 (queue)` nos ramos `TRANSIENT` e nas exceções `IOException`/`InterruptedException`). Precisa passar a **retornar o `Outcome`** para o chamador decidir enfileirar. `IOException`/`InterruptedException` mapeiam para `TRANSIENT`.
- **`SaleCommandExecutor.dispatchAsync()`** hoje é fire-and-forget (`runTaskAsynchronously(plugin, () -> apiClient.deliver(payload))`). O caminho de enfileiramento se pluga aqui.
- **`SaleApiConfig`** deriva só `salesEndpoint()` a partir de `base-url`. A S3.1 precisa de `itemsSyncEndpoint()` (`{base-url}/items/sync`) reutilizando a mesma validação `http(s)`/fail-safe já existente.
- **`sqlite-jdbc:3.47.1.0` já está no `build.gradle.kts`** como `implementation` — porém **o jar do plugin não é shaded** (não há `shadowJar` nem nó `libraries:` no `plugin.yml`). Em runtime o Paper **não** teria o driver no classpath. **Bloqueante da S3.2** resolver o empacotamento (ver §2.1).
- **`config.yml` já tem `api.sync-interval: 5`** (minutos, reservado para este sprint) e `api.timeout-ms`. A S3 adiciona chaves de fila/worker/retenção (ver §2.2 e §3.2).
- **`GET /items/sync`** devolve `ItemSyncEntry[] = { itemId, active }` (só itens ativos) com `Cache-Control: private, max-age=60` e exige header `X-Api-Key`. O cache do plugin consome exatamente esse contrato.
- **Idempotência do backend** garantida por `ON CONFLICT (id) DO NOTHING` + constraint de unicidade em `sales.id` (S1.2/S2.2): o reenvio do **mesmo `sale_id`** nunca duplica — base de segurança de todo o worker da S3.
- **`SalePayload`** (record: `saleId, itemId, playerUuid, nicknameAtPurchase, totalPrice(BigDecimal), qtd, purchasedAt(Instant)`) é a unidade a persistir na fila. `SaleJson` já serializa para o contrato snake_case da API.

---

## 1. S3.1 — Cache local de itens com sincronização periódica

### 1.1 Componentes

- **`ItemCache`** (novo, `plugin/.../cache/`): estrutura thread-safe do conjunto de `itemId` ativos. Implementação: `volatile Set<String>` imutável trocado atomicamente a cada sync (copy-on-write — leituras sem lock no caminho do comando; escrita substitui a referência inteira). Guarda também um `lastSyncOk` (boolean) e `lastSyncAt` para diagnóstico.
- **`ItemSyncClient`** (novo, `plugin/.../api/`): faz `GET {base-url}/items/sync` com `X-Api-Key`, parseia `ItemSyncEntry[]` (Gson, já disponível), devolve o `Set<String>` dos `itemId` (todos ativos por contrato — filtrar `active == true` por robustez). Reusa o `HttpClient`/timeout do `SaleApiConfig`.
- **`ItemSyncTask`**: `BukkitRunnable.runTaskTimerAsynchronously` agendada no `onEnable`, período = `api.sync-interval` minutos (mínimo defensivo de 1 min). **Roda fora da main thread.**

### 1.2 Endpoint no `SaleApiConfig`

Adicionar `itemsSyncEndpoint()` (`{base-url}/items/sync`), derivado no mesmo `of(...)` que já monta `salesEndpoint()`, sob a mesma validação `http(s)`. Config desabilitada ⇒ sem sync (o comando cai no comportamento de "cache vazio", §1.4).

### 1.3 Integração no executor (validação local)

No `SaleCommandExecutor`, **antes** de resolver o nick e montar o payload:

- `if (!itemCache.contains(sale.itemId()))` → **rejeita, loga warning, não envia e não enfileira**. Mensagem clara ao sender ("item_id não cadastrado ou inativo; verifique o catálogo"). Decisão de negócio (CLAUDE.md): **nunca auto-criar item**.
- A rejeição definitiva de item continua sendo da API (422 `PERMANENT`); o cache é a **defesa local barata** que evita enfileirar algo que a API rejeitaria de qualquer forma.

### 1.4 Comportamento de borda (critérios de aceite)

| Situação | Comportamento | Log |
|---|---|---|
| Sync no `onEnable` OK | Cache populado antes do primeiro comando (best-effort; sync é async, ver nota) | `info`: N itens carregados |
| Falha de sync (timeout/5xx/rede) | **Mantém o último cache válido**, não zera | `warning` |
| Cache vazio (primeiro boot sem rede) | Comando **rejeitado** com mensagem orientando verificar conectividade/cadastro | `warning` |
| API desabilitada em `config.yml` | Cache permanece vazio ⇒ todo comando rejeitado localmente com log claro | `severe` no enable |

> **Nota de corrida (boot):** como o sync é assíncrono, um comando disparado nos primeiros ms pode ver o cache ainda vazio. Aceitável e coberto pela regra "cache vazio ⇒ rejeita com log"; o operador reexecuta após o primeiro ciclo. Não bloquear a main thread esperando o primeiro sync.

### 1.5 Config nova

```yaml
items:
  # Intervalo de sincronizacao do cache (minutos). Reusa api.sync-interval se ausente.
  sync-interval: 5
```
Manter compatibilidade com `api.sync-interval` já existente (ler o novo, cair no antigo como fallback, ou simplesmente promover `api.sync-interval` para este uso — **decidir no PR e documentar**; recomendação: reusar `api.sync-interval` para não duplicar chave).

---

## 2. S3.2 — Fila de fallback em SQLite

### 2.1 Empacotamento do driver (BLOQUEANTE — resolver primeiro)

`sqlite-jdbc` precisa estar no classpath de runtime do Paper. Duas opções:

1. **`plugin.yml` `libraries:`** (Paper baixa do Maven Central no primeiro boot):
   ```yaml
   libraries:
     - org.xerial:sqlite-jdbc:3.47.1.0
   ```
   Prós: jar do plugin pequeno; sem shading. Contra: exige rede no primeiro boot (mitigado: o servidor de jogo tem saída de rede; o driver fica em cache local depois).
2. **`shadowJar`** (Gradle Shadow, relocando `org.sqlite`): jar autossuficiente, offline. Contra: jar maior, plugin de build extra.

**Recomendação:** opção **1 (`libraries:`)** — mais simples, idiomática em Paper 1.21, e o driver é pequeno. Trocar a dependência de `implementation` para `compileOnly` (o Paper fornece em runtime via `libraries:`). Documentar no PR. Se o ambiente de deploy não tolerar download no boot, cair para `shadowJar`.

### 2.2 Schema SQLite

Arquivo `sales-queue.db` na pasta de dados do plugin (`getDataFolder()`), **modo WAL** (`PRAGMA journal_mode=WAL`), `PRAGMA busy_timeout`.

```sql
CREATE TABLE IF NOT EXISTS sale_queue (
  sale_id              TEXT PRIMARY KEY,          -- UUID gerado no executor (idempotência)
  item_id              TEXT NOT NULL,
  player_uuid          TEXT NOT NULL,
  nickname_at_purchase TEXT NOT NULL,
  total_price          TEXT NOT NULL,             -- BigDecimal como string (nunca float)
  qtd                  INTEGER NOT NULL,
  purchased_at         TEXT NOT NULL,             -- ISO-8601 (Instant do momento do comando)
  status               TEXT NOT NULL DEFAULT 'pending', -- pending | sent | failed_permanent
  attempts             INTEGER NOT NULL DEFAULT 0,
  created_at           TEXT NOT NULL,             -- quando entrou na fila
  last_attempt_at      TEXT,
  next_attempt_at      TEXT                       -- backoff: worker so tenta apos este instante
);
CREATE INDEX IF NOT EXISTS idx_sale_queue_status ON sale_queue(status, next_attempt_at);
```

- `total_price` como **TEXT** (string do `BigDecimal`) — nunca `REAL`, para não perder precisão decimal.
- `status` restrito a `pending`/`sent`/`failed_permanent`. `sent` e `failed_permanent` são terminais.

### 2.3 Estratégia de escrita — **write-ahead (decisão de design)**

`sprint-03.md` (S3.2) descreve "falha transitória → grava pending". Há duas leituras:

- **(A) Enfileirar-só-em-falha:** envia primeiro; grava `pending` apenas se `TRANSIENT`. Simples, mas há uma **janela de perda**: se o plugin cair *depois* de montar o payload e *antes* de persistir a falha, a venda some — e "o dado é irrecuperável".
- **(B) Write-ahead (recomendada):** grava `pending` **antes** de tentar enviar; marca `sent` no ACK; `failed_permanent` no 4xx; mantém `pending` com backoff no transiente. Toda venda toca o SQLite local (rápido, WAL) — custo desprezível e garante *nada perdido* mesmo com crash no meio do envio. A idempotência (mesmo `sale_id`) neutraliza o risco de "gravei, mandei, caí antes de marcar sent, reenvio" — a API deduplica.

**Recomendação: (B) write-ahead.** É a única que honra literalmente "nunca perder uma venda" da S3.2 incluindo o cenário de crash. Impacto no fluxo S2.4: o executor deixa de "enviar direto" e passa a "enfileirar → acionar tentativa imediata". Marcar esta escolha para ratificação do Murilo no PR (é decisão de implementação, não reabertura de decisão de negócio).

### 2.4 Serialização de acesso (evitar lock/corrupção)

- **Um único `ScheduledExecutorService` de thread única** (`queue-io`) dono de **todo** I/O do SQLite: enqueue, updates de status, cleanup e o worker (§3). Como é thread única, escritas nunca concorrem — dispensa lock explícito e evita `SQLITE_BUSY`. WAL permite leituras concorrentes se necessário no futuro.
- O caminho do comando **não** bloqueia a main thread: o executor submete o enqueue a esse `queue-io` (fora da main thread) e retorna imediatamente ao sender.
- Falha de escrita no SQLite (último recurso) → `logger.severe` explícito: é o pior caso, precisa ser gritante no log.

### 2.5 Retenção

`sent` (e `failed_permanent`) são limpos após retenção configurável para a fila não crescer sem limite:

```yaml
queue:
  # Retencao de eventos terminais (sent/failed_permanent) antes da limpeza, em horas.
  retention-hours: 168      # 7 dias
  # Intervalo do worker de reenvio, em segundos.
  worker-interval-seconds: 30
  # Backoff maximo entre tentativas de um mesmo evento, em segundos.
  max-backoff-seconds: 300
```

Cleanup roda no mesmo `queue-io` (ex.: uma vez por ciclo do worker, deletando terminais mais velhos que `retention-hours`).

### 2.6 Critério testável (S3.2)

Desligar a API → executar comando → verificar linha `pending` no SQLite (com `sale_id`, `total_price` string exata, `purchased_at` do momento do comando).

---

## 3. S3.3 — Worker de reprocessamento da fila

### 3.1 Execução

- Task periódica no **mesmo `queue-io` de thread única** (via `scheduleAtFixedRate`, período = `queue.worker-interval-seconds`). Thread única ⇒ **sem execução concorrente/sobreposta** por construção (atende "worker não sobrepõe execução anterior" sem `AtomicBoolean`).
- Cada ciclo: `SELECT * FROM sale_queue WHERE status='pending' AND (next_attempt_at IS NULL OR next_attempt_at <= now) ORDER BY created_at ASC LIMIT <batch>`.
- Para cada linha: reconstrói `SalePayload` (mesmo `sale_id`), chama `SaleApiClient.deliver(payload)` (agora retornando `Outcome`) e aplica:

| `Outcome` | Ação na fila |
|---|---|
| `ACK` (2xx) | `status='sent'`, `last_attempt_at=now` |
| `PERMANENT` (4xx) | `status='failed_permanent'`, `logger.warning` com corpo da resposta (não tenta para sempre) |
| `TRANSIENT` (5xx/timeout/IO) | `attempts++`, `next_attempt_at = now + backoff(attempts)`, permanece `pending` |

- **Backoff exponencial** limitado por `max-backoff-seconds`: `min(base * 2^attempts, max)` (base p.ex. 5s), com jitter opcional.
- **Idempotência:** o reenvio usa o `sale_id` original ⇒ a API trata como upsert (200 idempotente). Marcar `sent` **somente** após ACK 2xx.

### 3.2 Sobrevivência a restart

Nada especial: os `pending` estão no SQLite. No `onEnable`, o `queue-io` é criado e a task periódica agendada; o primeiro ciclo já reprocessa o que existia antes do restart. Cobre "restart do plugin no meio → nada perdido nem duplicado" (idempotência fecha o "nem duplicado").

### 3.3 Métricas de visibilidade

Ao fim de cada ciclo, `logger.info` só quando houve trabalho: `"[queue] ciclo: X reenviados, Y ainda pending, Z permanentes"`. Evitar poluir o log quando a fila está vazia (log em nível `fine` nesse caso).

### 3.4 Shutdown limpo

No `onDisable`: `queue-io.shutdown()` + `awaitTermination` curto, e fechar a conexão SQLite. Garante que um ciclo em andamento não seja cortado no meio de um update.

---

## 4. S3.4 — Teste integrado de resiliência ponta a ponta (runbook)

Entrega: **runbook versionado** + correções pequenas que couberem no PR (bugs maiores viram histórias novas).

- Local do runbook: `.specs/features/sprint-03-resilience/runbook-resiliencia.md` (reusado na validação de go-live S6.3).
- Roteiro (executado e registrado):
  1. **API no ar:** N comandos → N linhas em `sales` (Postgres); fila SQLite sem `pending` residual (todas `sent`).
  2. **API desligada + M comandos:** todas as vendas viram `pending` no SQLite; servidor de jogo **não trava** (zero I/O bloqueante na main thread).
  3. **API religada:** worker entrega todas; `status` migra `pending → sent`.
  4. **Restart do plugin no meio** (entre 2 e 3): `pending` persistidos sobrevivem e são reprocessados no boot.
- **Asserção final:** `COUNT(*)` em `sales` no Postgres **==** número de comandos executados (zero duplicatas, zero perdas). Conferir também ausência de `pending` órfão e ausência de linha duplicada por `sale_id`.

---

## 5. Ordem de execução recomendada (dependências)

```
S3.2 (empacotamento sqlite + schema + SaleQueue + write-ahead no executor)
  │     ← inclui tornar SaleApiClient.deliver() retornar Outcome (refactor base)
  ├─ S3.1 (cache de itens)          ← independente da fila; pode ir em paralelo à S3.2
  └─ S3.3 (worker)                  ← depende do SaleQueue e do deliver()->Outcome da S3.2
        └─ S3.4 (runbook e2e)       ← precisa de S3.1+S3.2+S3.3 no ar para o teste completo
```

- **S3.2 primeiro** (ou em paralelo com S3.1): resolve o empacotamento do driver e o refactor de `deliver()->Outcome`, base do worker.
- **S3.1 em paralelo** — toca só o executor/cache, não depende da fila.
- **S3.3 depois da S3.2** — consome `SaleQueue` e o `Outcome`.
- **S3.4 por último** — teste de ponta a ponta com tudo montado.
- **1 história = 1 PR** (convenção do projeto). O refactor `deliver()->Outcome` vai junto do PR da S3.2 (é pré-condição dela); S3.3 assume esse contrato já mergeado.

## 6. Subagents por história

| História | Subagent(s) |
|---|---|
| S3.1 | `gamedev-plugin-specialist` |
| S3.2 | `gamedev-plugin-specialist` + `backend-specialist` (schema/idempotência) |
| S3.3 | `gamedev-plugin-specialist` |
| S3.4 | `gamedev-plugin-specialist` + `backend-specialist` |

## 7. Riscos (herdados + novos deste design)

| Risco | Mitigação |
|---|---|
| Driver SQLite ausente no classpath do Paper em runtime | §2.1 resolve o empacotamento **antes** de qualquer código de fila (bloqueante da S3.2) |
| Duplicidade sutil (evento enviado, ACK perdido, reenvio) | Cenário coberto pela idempotência da S2.2 (`ON CONFLICT DO NOTHING` + mesmo `sale_id`) + teste explícito da S3.4 |
| Corrupção/lock do SQLite com escrita concorrente | Executor **de thread única** serializa todo I/O; WAL + `busy_timeout` como defesa extra |
| I/O (rede/SQLite) vazar para a main thread | Enqueue e worker no `queue-io`; envio HTTP em async; revisão verifica zero I/O na main thread |
| Janela de perda com "enfileirar-só-em-falha" | Recomendação **write-ahead** (§2.3): grava `pending` antes de enviar |
| Precisão decimal de `total_price` na fila | Persistir `BigDecimal` como **TEXT**, nunca `REAL` |
| Backoff que nunca desiste em 4xx | Worker marca `failed_permanent` em 4xx (regra de ouro: só 5xx/timeout reenfileira) |
| Fila cresce indefinidamente | Retenção configurável + cleanup de terminais por ciclo (§2.5) |
| Relógio do servidor de jogo errado contamina `purchased_at` enfileirado | NTP já verificado na S1.7; `purchased_at` é o do momento do comando (correto por design) |

## 8. Definition of Done (espelha `sprint-03.md`)

- Todo código via PR revisado, CI verde (plugin).
- **CA1 do MVP demonstrado:** venda registrada com API no ar **e** com API fora do ar (fila + reenvio), sem duplicatas — provado pelo runbook da S3.4.
- **Nenhum I/O (rede ou SQLite) na main thread** — verificado em revisão.
- Comportamentos de erro (4xx `PERMANENT` vs 5xx/timeout `TRANSIENT`) consistentes com o contrato §2.3 da S2.2.
- Runbook de resiliência versionado em `.specs/features/sprint-03-resilience/`.
- Plugin roda 24h+ no servidor de teste sem leak de memória/timer aparente no log (thread única encerrada no `onDisable`).
