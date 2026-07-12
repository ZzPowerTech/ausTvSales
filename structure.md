# structure.md — austv-sales

> Árvore de código-fonte. Regenerável — atualizar sempre que a arquitetura mudar
> significativamente (nova pasta de topo, novo módulo, novo serviço).

```
austv-sales/
├── .claude/                        # Config do Claude Code (settings, worktrees gitignored)
├── .github/workflows/              # CI por stack (dispara por pasta tocada)
│   ├── backend-ci.yml              #   backend/**  → npm ci + lint + test (Node 22)
│   ├── frontend-ci.yml             #   frontend/** → npm ci + lint + test headless (Node 22)
│   └── plugin-ci.yml               #   plugin/**   → gradlew build test (Temurin 21)
├── .specs/                         # Specs, design docs e sprints
│   ├── project/PROJECT.md          # Spec aprovado — fonte de verdade do escopo
│   └── sprints/                    # Plano de 6 sprints (Fase 3 Scrum)
├── plugin/                         # Plugin Java (Paper 1.21.4, Gradle 8.10.2, Java 21)
│   └── src/
│       ├── main/java/de/austv/sales/
│       │   ├── AusTvSalesPlugin.java           # JavaPlugin (onEnable/onDisable)
│       │   └── command/
│       │       ├── SaleCommandParser.java      # Parser puro — validação testável sem Bukkit
│       │       └── SaleCommandExecutor.java    # Esqueleto Bukkit (integrações: Sprints 2-3)
│       └── test/.../SaleCommandParserTest.java # 24 testes JUnit 5
├── backend/                        # API NestJS (PostgreSQL entra na S1.2)
│   └── src/
│       ├── config/                 # env.validation + ValidationPipe global (testados)
│       ├── health/                 # GET /health (preparado p/ status do banco)
│       └── sales/dto/              # CreateSaleDto — contrato do plugin, testado campo a campo
├── frontend/                       # Dashboard Angular 19 (standalone + Signals)
│   └── src/app/core/
│       ├── models/sale.model.ts    # Modelo Sale alinhado ao schema do spec
│       └── services/api.service.ts # ApiService (base URL via environment)
├── CLAUDE.md                       # Contexto e convenções do projeto
├── README.md                       # Visão geral
├── structure.md                    # Este arquivo
└── .gitignore
```

Telas do dashboard (Sprints 4-5), banco/migrations (S1.2) e integração plugin→API
(Sprints 2-3) ainda não implementados — apenas scaffolding com testes e CI.
