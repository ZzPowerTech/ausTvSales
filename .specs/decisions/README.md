# Decisões de Arquitetura (ADRs) — austv-sales

Registro de decisões técnicas relevantes e notas de operação (runbooks de
verificação). Cada ADR é imutável depois de aceito; mudanças de rumo geram um
novo ADR que substitui (`Substitui: ADR-XXXX`) o anterior.

## Índice

| # | Título | Status |
|---|---|---|
| [ADR-0001](ADR-0001-auth-plugin-api.md) | Autenticação plugin→API (API key vs mTLS) | Aceito (2026-07-16) |
| [ADR-0002](ADR-0002-permissoes-dashboard.md) | Modelo de permissões do dashboard (admin único) | Aceito (2026-07-18) |
| [ADR-0003](ADR-0003-biblioteca-grafico.md) | Biblioteca de gráfico do dashboard (Chart.js vs ECharts) | Proposto (2026-07-20) |
| [S1.7](S1.7-verificacao-ntp.md) | Verificação de NTP nas duas VPS (runbook) | Verificado — sincronizado nas duas VPS |

## Convenção de status

- **Proposto** — escrito, aguardando aprovação.
- **Aceito** — aprovado; vale como decisão vigente.
- **Substituído** — trocado por um ADR posterior (link no cabeçalho).
