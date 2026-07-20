# Plano de Sprints — AusTV Sales Dashboard

> Fase 3 (Scrum) — derivado de [`.specs/project/PROJECT.md`](../project/PROJECT.md)
> Data: 2026-07-11
> Duração de sprint: **1 semana** (padrão AusTV)
> Estimativa: **Story Points** (Fibonacci: 1, 2, 3, 5, 8), calibrados para desenvolvimento solo assistido por subagents. Velocidade alvo: ~13 SP/sprint.

---

## Épicos

| Épico | Descrição | Sprints |
|---|---|---|
| **E1 — Fundação de dados e API base** | Scaffolding NestJS, schema PostgreSQL, CRUD de catálogo (categorias/itens) protegido por auth | Sprint 1 |
| **E2 — Ingestão de vendas** | Endpoint autenticado de recebimento de vendas com idempotência, rate limiting e validação de catálogo | Sprint 2 |
| **E3 — Plugin Java (Paper 1.21.x)** | Comando `austv-sales add`, cache de itens, fila SQLite de fallback e worker de reenvio | Sprints 2–3 |
| **E4 — Dashboard: administração de catálogo** | Auth do dashboard + telas de cadastro manual de categoria e item | Sprint 4 |
| **E5 — Dashboard: visualização** | Sidebar por categoria, ranking top 5 por item, gráfico de série temporal | Sprint 5 |
| **E6 — Migração e cutover** | Migração histórica única, atualização dos rewards do Genesis, validação de segurança final e go-live | Sprint 6 |
| **E7 — Segurança e operação (transversal)** | Spike de auth plugin→API, NTP, deploy em container, validação `cybersecurity-validator` | Sprints 1, 2 e 6 |

## Ordem dos sprints e racional de dependências

```
Sprint 1  Fundação: schema + API de catálogo + decisões de segurança (auth, NTP)
   │        └─ schema e cadastro de itens/categorias precisam existir antes de
   │           qualquer venda poder ser aceita; auth admin antes de expor CRUD
Sprint 2  Ingestão: auth plugin→API + POST /sales idempotente + comando do plugin (caminho feliz)
   │        └─ auth plugin→API é bloqueante antes de qualquer merge que exponha o endpoint
Sprint 3  Resiliência do plugin: cache de itens + fila SQLite + worker de reenvio
   │        └─ depende do endpoint idempotente do Sprint 2 para o reprocessamento ser seguro
Sprint 4  Dashboard admin: login + cadastro de categoria/item
   │        └─ cadastro manual deve estar operacional antes do cutover (critério de aceite)
Sprint 5  Dashboard visualização: sidebar, ranking top 5, gráfico temporal
   │        └─ depende dos endpoints de leitura e de dados de venda para validar
Sprint 6  Migração histórica + cutover no Genesis + validação de segurança + go-live
            └─ só faz sentido com todo o pipeline funcionando de ponta a ponta
```

## Mapa história → critério de aceite (seção 6 do spec)

| # | Critério de aceite (MVP) | Histórias que cobrem |
|---|---|---|
| CA1 | Plugin registra venda via comando, com fallback SQLite testável | S2.4, S3.2, S3.3, S3.4 |
| CA2 | API rejeita `item_id` desconhecido com log claro, sem registro fantasma | S2.2 (e S3.1 no lado do plugin) |
| CA3 | Sidebar por categoria dinâmica (tabela `categories`) | S5.2 |
| CA4 | Por item, top 5 jogadores com mais compras (nickname atual) | S5.1, S5.3 |
| CA5 | Gráfico de vendas por item ao longo do tempo, granularidade de evento | S5.1, S5.4 |
| CA6 | Cadastro manual de item/categoria funcional antes de aceitar vendas | S1.4, S1.5, S1.6, S4.0, S4.1, S4.2, S4.3 |
| CA7 | Migração histórica única, `historical_import = true`, fora da série temporal | S6.1 (+ regra de exclusão em S5.1/S5.4) |
| CA8 | Comunicação plugin→API autenticada, validada pelo `cybersecurity-validator` | S1.3 (spike), S2.1, S6.3 (validação final) |
| CA9 | Comandos antigos do MyCommand removidos dos rewards do Genesis | S6.2 |

## Pendências da seção 9 do spec → histórias explícitas

| Pendência | História | Sprint |
|---|---|---|
| Mecanismo exato de auth plugin→API (API key vs mTLS) | **S1.3 (spike)** — decisão registrada em ADR | 1 |
| Confirmar NTP sincronizado nas duas VPS | **S1.7 (tarefa ops)** + re-checagem em S6.3 | 1 e 6 |
| Desenhar tela de cadastro (permissões, fluxo) | **S4.1** — decisão registrada em [ADR-0002](../decisions/ADR-0002-permissoes-dashboard.md) ✅ + S4.2/S4.3 | 4 |

## Backlog priorizado (visão macro)

| Prioridade | Item | Justificativa de valor |
|---|---|---|
| 1 | Schema + catálogo com auth (Sprint 1) | Pré-requisito técnico de tudo; sem itens cadastrados nenhuma venda é aceita |
| 2 | Ingestão autenticada + comando (Sprint 2) | Coração do produto: começar a capturar eventos com timestamp real o quanto antes |
| 3 | Resiliência do plugin (Sprint 3) | Sem fila de fallback, queda da API = perda de venda (dado irrecuperável) |
| 4 | Cadastro no dashboard (Sprint 4) | Operacionaliza o catálogo sem depender de SQL manual; pré-condição do cutover |
| 5 | Visualização (Sprint 5) | O valor de negócio visível (análise temporal, ranking, receita) |
| 6 | Migração + cutover (Sprint 6) | Traz o histórico e desliga o sistema antigo com segurança validada |

## Arquivos

- [sprint-01.md](sprint-01.md) — Fundação: schema, API de catálogo e decisões de segurança
- [sprint-02.md](sprint-02.md) — Ingestão de vendas autenticada + comando do plugin
- [sprint-03.md](sprint-03.md) — Resiliência do plugin: cache, fila SQLite e reenvio
- [sprint-04.md](sprint-04.md) — Dashboard: administração de catálogo *(escopo revisado em 2026-07-18)*
- [sprint-05.md](sprint-05.md) — Dashboard: visualização (sidebar, ranking, gráfico) *(escopo revisado em 2026-07-20)*
- [sprint-06.md](sprint-06.md) — Migração histórica, cutover e go-live

## Convenções deste plano

- **1 história = no máximo 1 PR.** Cada PR é uma responsabilidade lógica, funcional e deployável por si só.
- Spikes não geram PR de código (geram ADR em `.specs/decisions/` ou doc equivalente).
- Código e identificadores em inglês; commits em Conventional Commits.
- Branches de trabalho em `.claude/.worktrees/<branch>`; nunca commitar direto em `main`/`dev`/`prod`.
