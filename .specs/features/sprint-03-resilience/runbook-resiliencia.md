# Runbook — Teste de resiliência ponta a ponta (S3.4)

> Sprint 3 — Resiliência do plugin · deriva do §4 do [spec de design](spec.md)
> Objetivo: **provar o CA1 do MVP** — venda registrada com a API no ar **e** com a API fora do ar
> (fila SQLite + reenvio automático), **sem perdas e sem duplicatas** — antes do cutover.
> Este runbook é **reproduzível** e será reusado na validação de go-live (S6.3).

---

## 0. O que este teste prova

| Garantia | Como é provada aqui |
|---|---|
| **Nada perdido** (write-ahead, S3.2) | Vendas feitas com a API desligada aparecem como `pending` no SQLite |
| **Entrega automática** (worker, S3.3) | Ao religar a API, o worker migra `pending → sent` e grava em `sales` sozinho |
| **Nada duplicado** (idempotência, S2.2) | `COUNT(*) == COUNT(DISTINCT id)` em `sales`; reenvio do mesmo `sale_id` não duplica |
| **Sobrevive a restart** (S3.2/S3.3) | Reiniciar o servidor no meio do teste não perde nem duplica nenhuma venda |
| **Validação local de item** (cache, S3.1) | `item_id` fora do catálogo é rejeitado no comando, sem enfileirar |

---

## 1. Pré-requisitos do ambiente de teste

- Servidor **Paper 1.21.x** de teste com o `AusTvSales` instalado (jar do build do plugin), **fora**
  do servidor de produção.
- Backend `austv-sales` acessível (NestJS) apontando para um **Postgres de teste** (nunca o de produção).
- Pelo menos **um item cadastrado e ativo** no catálogo (via dashboard/endpoint da S1) — anote o `item_id`
  (exemplo abaixo: `caixaNatal2026`).
- **NTP sincronizado** nas duas VPS (já validado na S1.7; recheca em S6.3).
- Ferramentas de inspeção: `sqlite3` (no host do servidor de jogo) e `psql` (no host da API).
- Um jogador conhecido pelo servidor (nick resolvível via cache do Bukkit) — ex.: `Murilo`.

### 1.1 Config de teste (`plugins/AusTvSales/config.yml`)

Ajuste para feedback rápido durante o teste (valores de produção são mais folgados):

```yaml
api:
  base-url: "https://sales-teste.austv.example"   # API de teste
  api-key: "<chave de teste>"                       # injetada via secret, nunca commitada
  timeout-ms: 5000
  sync-interval: 1        # sync do cache de itens a cada 1 min

queue:
  worker-interval-seconds: 10   # worker reprocessa a cada 10s (rapido para o teste)
  max-backoff-seconds: 30       # teto de backoff curto para nao esperar minutos
  retention-hours: 168          # manter; nao interfere no teste
```

Reinicie o servidor após ajustar o config. No boot, confirme no log:

```
[AusTvSales] Fila de fallback SQLite pronta (sales-queue.db).
[AusTvSales] Cache de itens sincronizado: N item(ns) ativo(s).
[AusTvSales] Worker de reenvio da fila agendado (intervalo: 10s, max-backoff: 30s, retencao: 168h).
```

> Se aparecer `desabilitando o plugin` no boot, a fila SQLite não abriu — resolva antes de continuar
> (permissão de escrita na pasta de dados do plugin). Se aparecer `Worker de reenvio da fila NAO
> agendado (API nao configurada)`, faltou `api.base-url`/`api.api-key`.

### 1.2 Comandos de inspeção (deixe dois terminais abertos)

**SQLite (host do jogo)** — estado da fila local:
```bash
sqlite3 plugins/AusTvSales/sales-queue.db \
  "SELECT status, COUNT(*) FROM sale_queue GROUP BY status;"
```

**Postgres (host da API)** — vendas persistidas e checagem de duplicatas:
```bash
psql "$DATABASE_URL" -c \
  "SELECT COUNT(*) AS total, COUNT(DISTINCT id) AS distintos FROM sales;"
```

O comando do jogo (console ou operador):
```
/austv-sales add <player_nick> <item_id> <total_price> <qtd>
# ex.: /austv-sales add Murilo caixaNatal2026 19.90 1
```

### 1.3 Reset entre execuções (opcional, ambiente de teste)

```bash
# Parar o servidor de jogo antes de mexer no SQLite.
rm -f plugins/AusTvSales/sales-queue.db*        # zera a fila local
psql "$DATABASE_URL" -c "TRUNCATE sales, players CASCADE;"   # zera as vendas de teste
```

---

## 2. Roteiro

> Anote a contagem de comandos executados em cada fase — a asserção final compara com `sales`.
> Convenção: use quantidades distintas por fase para facilitar a conferência (ex.: 3, depois 5).

### Fase 1 — API no ar (caminho feliz)

1. Garanta a API no ar e o item no cache (log `Cache de itens sincronizado`).
2. Execute **3** vendas válidas:
   ```
   /austv-sales add Murilo caixaNatal2026 19.90 1
   /austv-sales add Murilo caixaNatal2026 19.90 2
   /austv-sales add Murilo caixaNatal2026 49.90 1
   ```
   Cada comando deve responder `Venda registrada ... envio em andamento`.
3. Verifique:
   - **Postgres:** `total == 3` e `distintos == 3`.
   - **SQLite:** as 3 linhas terminam `sent` (o worker/executor confirmou). Nenhum `pending` residual:
     ```
     sent|3
     ```

✅ **Fase 1 OK:** venda com a API no ar chega ao Postgres; a fila local marca `sent`.

### Fase 2 — API desligada (fallback write-ahead)

1. **Derrube a API** (pare o container/serviço do backend, ou bloqueie a rota). Confirme que o
   endpoint não responde.
2. Execute **5** vendas válidas (mesmo formato). Observações importantes:
   - O servidor de jogo **não pode travar nem engasgar** — o comando responde imediatamente
     (`envio em andamento`); todo I/O é fora da main thread.
   - No log aparece a falha transitória do envio (`Falha transitoria`/`Falha de rede ... permanece
     pendente na fila`).
3. Verifique:
   - **SQLite:** 5 novas linhas `pending` (além das 3 `sent` da Fase 1):
     ```
     pending|5
     sent|3
     ```
   - **Postgres:** ainda `total == 3` (as 5 novas **não** chegaram — estão retidas localmente).

✅ **Fase 2 OK:** com a API fora, nenhuma venda é perdida; todas ficam `pending` no SQLite.

### Fase 3 — Restart do plugin no meio (sobrevivência)

> Faz a Fase 3 **antes** de religar a API, para provar que os `pending` sobrevivem ao restart.

1. Com as 5 vendas `pending` e a **API ainda desligada**, **reinicie o servidor de jogo**
   (stop/start — exercita `onDisable` → `onEnable`).
2. No boot, confirme `Fila de fallback SQLite pronta` e `Worker de reenvio da fila agendado`.
3. Verifique **SQLite:** ainda `pending|5` e `sent|3` — nada perdido no restart. O worker vai tentar
   reenviar e, como a API segue fora, mantém `pending` com backoff (log `[queue] ciclo: 0 reenviados,
   0 permanentes, 5 ainda pending`).

✅ **Fase 3 OK:** `pending` gravados antes do restart persistem e voltam a ser processados no boot.

### Fase 4 — API religada (reenvio automático)

1. **Religue a API.** Não execute nenhum comando novo — deixe o worker agir sozinho.
2. Aguarde 1–2 ciclos do worker (~10–20s). Observe o log:
   ```
   [queue] ciclo: 5 reenviados, 0 permanentes, 0 ainda pending
   ```
3. Verifique:
   - **SQLite:** `pending|0`; as 5 viraram `sent` (`sent|8` no total).
   - **Postgres:** `total == 8` e `distintos == 8`.

✅ **Fase 4 OK:** o worker entregou sozinho tudo que estava retido, sem intervenção.

---

## 3. Asserção final (critério de aceite CA1)

Total de comandos executados no roteiro: **3 (Fase 1) + 5 (Fase 2) = 8**.

```bash
# Postgres: contagem bate e nao ha duplicatas
psql "$DATABASE_URL" -c \
  "SELECT COUNT(*) AS total, COUNT(DISTINCT id) AS distintos FROM sales;"
# Esperado: total = 8, distintos = 8

# SQLite: nada preso em pending; tudo terminal
sqlite3 plugins/AusTvSales/sales-queue.db \
  "SELECT status, COUNT(*) FROM sale_queue GROUP BY status;"
# Esperado: sent = 8 (nenhum pending, nenhum failed_permanent)
```

**Passa se, e somente se:**
- `total == distintos == 8` em `sales` (**zero duplicatas, zero perdas**);
- `pending == 0` no SQLite (**nada preso na fila**);
- nenhuma venda em `failed_permanent` (nesta bateria de itens válidos).

---

## 4. Cenários negativos complementares (rápidos, opcionais)

| Cenário | Passos | Esperado |
|---|---|---|
| **Item desconhecido rejeitado localmente (CA2/S3.1)** | `/austv-sales add Murilo itemInexistente 10 1` com cache populado | Rejeição imediata `item_id nao cadastrado ou inativo`; **nada** enfileirado (SQLite inalterado), **nada** enviado |
| **4xx = permanente (não reenfileira)** | Envie um `item_id` que a API conhece no cache mas rejeita como inativo (422) com a API no ar | Linha vira `failed_permanent`, com log `marcada failed_permanent`; worker **não** insiste |
| **Argumento inválido** | `/austv-sales add Murilo caixaNatal2026 abc 1` | Rejeição de parse; nada enfileirado nem enviado |
| **Duplicata idempotente** | Reprocessar a mesma fila duas vezes (ex.: reiniciar durante um ciclo) | `sales` não duplica (`total == distintos`); constraint de `id` como última defesa |

---

## 5. Sinais de log de referência

| Momento | Log esperado |
|---|---|
| Boot | `Fila de fallback SQLite pronta (sales-queue.db).` |
| Boot | `Cache de itens sincronizado: N item(ns) ativo(s).` |
| Boot | `Worker de reenvio da fila agendado (...).` |
| Venda aceita | `Venda registrada para <nick> (sale_id=...); envio em andamento.` |
| API fora | `Falha transitoria ao enviar venda (...); permanece pendente na fila para nova tentativa.` |
| Item fora do cache | `Venda rejeitada localmente: item_id nao cadastrado ou inativo ...` |
| Ciclo do worker | `[queue] ciclo: X reenviados, Y permanentes, Z ainda pending` |
| 4xx no reenvio | `Venda <sale_id> marcada failed_permanent pelo worker de reenvio; nao sera mais reenviada.` |

---

## 6. Troubleshooting

- **`pending` não migra para `sent` com a API no ar:** confira `api.base-url`/`api.api-key`, e se a
  chave é aceita (401 no log = credencial). Um 401 é 4xx → o worker marca `failed_permanent`, não
  `pending`; nesse caso corrija a credencial e reenfileire manualmente (ou refaça o teste com reset).
- **Servidor engasga ao enviar:** não deveria — se acontecer, é bug de I/O na main thread; capture o
  thread dump e abra história. O design garante envio/SQLite fora da main thread.
- **`failed_permanent` inesperado com item válido:** verifique se o item está **ativo** no catálogo e
  se o `item_id` do comando bate exatamente (case-sensitive, opaco por item — sem normalização).
- **Duplicatas em `sales`:** não deveria ocorrer (idempotência por `id`); se ocorrer, verifique se a
  constraint de unicidade da S1.2 está presente no schema do Postgres de teste.

---

## 7. Reuso no go-live (S6.3)

Este roteiro é o mesmo que valida a resiliência antes do cutover de produção (S6.3), com duas
diferenças: usar o **catálogo real** de itens e voltar os valores de `queue.*` para os de produção
(`worker-interval-seconds` e `max-backoff-seconds` maiores). A asserção final (§3) é idêntica.
</content>
