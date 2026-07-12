# AusTV Sales Dashboard (`austv-sales`)

Sistema de eventos de venda de itens por cash (caixas, passes, pets, fly etc.) do servidor
AusTV, substituindo os contadores acumulados do MyCommand por registros granulares no tempo —
permitindo análise por item/período, ranking de compradores e apuração financeira real.

> Status: Fase 1 (SDD) concluída — spec aprovado, em preparação para quebra em sprints.

## Visão geral

- **Plugin (Java/Paper)** registra cada venda via comando (`austv-sales add ...`), com fila de
  fallback local (SQLite) para garantir entrega mesmo com a API indisponível.
- **Backend (NestJS + PostgreSQL)** recebe, valida e persiste os eventos, reaproveitando a
  instância Postgres do AusTV Finance.
- **Frontend (Angular)** exibe dashboard por categoria, ranking de top compradores por item e
  gráfico de vendas com granularidade real de evento.

Escopo, decisões de negócio e critérios de aceite completos: [`.specs/project/PROJECT.md`](.specs/project/PROJECT.md).

## Estrutura do repositório

```
austv-sales/
├── plugin/       # Plugin Java (Paper 1.21.x) — comando + fila SQLite
├── backend/      # API NestJS + PostgreSQL
├── frontend/     # Dashboard Angular
├── .specs/       # Specs, design e tasks (tlc-spec-driven)
└── .claude/      # Configuração do Claude Code para este projeto
```

Detalhamento vivo da árvore de código: [`structure.md`](structure.md).

## Stack

| Camada | Tecnologia |
|---|---|
| Plugin | Java (Paper 1.21.x), sqlite-jdbc |
| Backend | NestJS + PostgreSQL |
| Frontend | Angular (Signals) |
| Deploy | Container isolado na VPS (`weissmurillo.de`), atrás de Nginx |

## Fora de escopo

Automação de entrada de saldo via webhook da Central Cart — projeto separado, spec própria no futuro.

## Desenvolvimento

Este projeto segue o fluxo `dev-workflow` (Second Brain + specs + sprints + subagents
especializados). Convenções de código, commits e branches estão documentadas em
[`CLAUDE.md`](CLAUDE.md).
