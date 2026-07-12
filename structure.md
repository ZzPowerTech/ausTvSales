# structure.md — austv-sales

> Árvore de código-fonte. Regenerável — atualizar sempre que a arquitetura mudar
> significativamente (nova pasta de topo, novo módulo, novo serviço).

```
austv-sales/
├── .claude/                # Config do Claude Code (agents, settings, worktrees)
├── .specs/                 # Specs, design docs e tasks (tlc-spec-driven)
│   └── project/
│       └── PROJECT.md      # Spec aprovado — fonte de verdade do escopo
├── plugin/                 # Plugin Java (Paper 1.21.x)
│                            # - CommandExecutor (austv-sales add)
│                            # - fila de fallback SQLite (sqlite-jdbc)
│                            # - worker de reenvio assíncrono
├── backend/                # API NestJS + PostgreSQL
│                            # - módulo sales (recebimento idempotente por sale_id)
│                            # - módulo items / categories (CRUD autenticado)
│                            # - módulo players (resolução de nickname)
├── frontend/                # Dashboard Angular (Signals)
│                            # - sidebar dinâmica por categoria
│                            # - ranking top 5 compradores por item
│                            # - gráfico de série temporal de vendas
├── CLAUDE.md                # Contexto e convenções do projeto
├── README.md                 # Visão geral
├── structure.md               # Este arquivo
└── .gitignore
```

Ainda não há código implementado — estrutura reflete o planejamento do spec (Fase 1 SDD).
