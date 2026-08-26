# CLAUDE.md — austv-sales

Contexto e convenções deste repositório para qualquer sessão do Claude Code.

## O que é este projeto

Sistema de eventos de venda de itens por cash do servidor AusTV. Substitui os contadores
acumulados do MyCommand (`otherdb.yml` + MySQL) por eventos com timestamp real, permitindo
análise temporal, ranking de compradores e apuração financeira (o sistema atual não guarda preço).

Spec completo (decisões de negócio, entidades, contrato do comando, critérios de aceite):
[`.specs/project/PROJECT.md`](.specs/project/PROJECT.md).

## Fora de escopo (não implementar aqui)

- Automação de saldo via webhook da Central Cart — projeto futuro, separado.
- Qualquer alteração no MyCommand além de remover os dois comandos antigos do reward do Genesis.

## Stack e arquitetura

| Camada | Tecnologia | Pasta |
|---|---|---|
| Plugin | Java (Paper 1.21.x) + sqlite-jdbc (fila de fallback) | `plugin/` |
| Backend | NestJS + PostgreSQL (instância compartilhada com AusTV Finance) | `backend/` |
| Frontend | Angular (Signals) | `frontend/` |

Deploy: container isolado na VPS original do servidor AusTV, atrás de Nginx — **não** roda na máquina
dedicada do servidor de jogo.

## Decisões de negócio já fechadas (não reabrir sem o Murilo)

- `item_id` é opaco por item (ex: `caixaNatal2026`) — sem decomposição family+season.
- Categorias cadastradas manualmente via dashboard, nunca auto-criadas por comando.
- Preço vem do placeholder `%price%` do Genesis, já resolvido — plugin não recalcula valor.
- `player_uuid` é a chave de agregação; `nickname` é snapshot histórico por evento.
- `purchased_at` é capturado no plugin (`Instant.now()`), nunca recebido como argumento externo.
- Fallback de fila é SQLite local no plugin, com `sale_id` gerado no plugin (idempotência).
- Migração histórica é única, marcada com `historical_import = true`, sem timestamp granular
  fictício (não deve poluir gráfico de série temporal).
- `total_price` dos eventos históricos migrados = preço unitário atual × qtd (decisão de
  2026-07-12: preços não costumam mudar), via mapa `item_id → preço` fornecido ao script.
- Comunicação plugin→API **precisa** de autenticação (API key ou mTLS) — bloqueante, validado
  pelo `cybersecurity-validator` antes de qualquer merge.

Lista completa em [`.specs/project/PROJECT.md`](.specs/project/PROJECT.md) seção 3.

## Convenções

- Código em inglês; comunicação e commits explicativos em português quando fizer sentido.
- Commits: Conventional Commits (`feat:`, `fix:`, `chore:`, `docs:`, etc).
- Nunca alterar `main`, `dev` ou `prod` diretamente — sempre via branch + PR.
- Google Style Guide para Java e TypeScript.
- Timezone: America/Sao_Paulo. Datas em `YYYY-MM-DD`.
- Git worktrees de feature/fix sempre em `.claude/.worktrees/<branch>` (gitignored).
- 1 PR = 1 responsabilidade lógica, funcional e deployável por si só.

## Segurança (bloqueante)

- Endpoint de recebimento de vendas exige autenticação forte + rate limiting.
- Validar NTP sincronizado entre VPS do jogo e VPS da API antes de confiar em `purchased_at`.
- Idempotência real no backend via constraint de unicidade em `sale_id` (evita duplicar venda
  no reprocessamento da fila SQLite).
- Cadastro manual de item/categoria no dashboard exige autenticação/autorização — nunca endpoint
  público.

## Subagents relevantes para este repo

| Área | Subagent |
|---|---|
| Plugin Java | `gamedev-plugin-specialist` + `backend-specialist` |
| API NestJS | `backend-specialist` |
| Dashboard Angular | `frontend-specialist` |
| Schema PostgreSQL | `database-specialist` |
| CI/CD, deploy VPS | `devops-specialist` |
| Autenticação plugin→API | `devops-specialist` + `cybersecurity-validator` |

## Estado atual

Sprints 1–5 entregues (fundação + ingestão + resiliência do plugin + administração de catálogo +
visualização: navegação de análise, ranking top 5 e gráfico de série temporal).

**Próximo: Sprint 6** — migração histórica, cutover dos rewards do Genesis e validação final de
segurança. Fecha o MVP (CA7, CA8, CA9). Plano em
[`.specs/sprints/sprint-06.md`](.specs/sprints/sprint-06.md); issues #27–#30 abertas.

### Épico paralelo: AusTV Admin (analytics de retenção)

Projeto separado, especificado neste repo em `.specs/features/austv-admin/`. Documentos canônicos:

- [`spec.md`](.specs/features/austv-admin/spec.md) — spec v2 (ADRs 001–008, funil de 4 degraus,
  camada de economia, superfície de ataque, risco de rede aceito pelo dono)
- [`austv-admin-sprints.md`](.specs/sprints/austv-admin-sprints.md) — 19 histórias, Sprint 6 → 12
- [`HANDOFF.md`](.specs/features/austv-admin/HANDOFF.md) — números verificados da investigação de
  retenção, perguntas em aberto e os erros de método a não repetir

**Convenção de numeração (decidida em 2026-08-21):** as sprints do AusTV Admin e do `ausTvSales`
colidem na faixa 6. Os documentos **não** são renumerados; a separação é por milestone
(`AusTV Admin S6` vs `ausTvSales S6`) e por label prefixada (`admin:sprint-6` vs `sales:sprint-6`).

**Entregues:** AusTV Admin **S6** (checks de saúde + alerta no Discord, 6 de 7 checks — o sétimo
não tem fonte e virou a S8.0) e **S7** (módulo `health` expondo os checks, módulo `metrics` com
client do Plan, cache de TTL por endpoint e degradação honesta). Detalhe de cada história, com o
que ficou de fora e por quê, no plano de sprints.

**Próxima: Sprint 8** — fonte de dados do tutorial (S8.0), funil de 4 degraus (S8.1) e retenção por
coorte (S8.2). A S8 está em **18 SP** contra 13 de capacidade; a S8.2 é a história marcada
`[CORTE]` e move para a S9 se preciso.

**Em aberto, e vale mais que sprint:**

- **[#157](https://github.com/ZzPowerTech/ausTvSales/issues/157) — perda de venda em silêncio.**
  Um 429 faz o plugin marcar a venda como permanentemente falha. Descoberto na S7; é dado perdido,
  não incômodo.
- **Probe externo de uptime.** O critério 2 da S7.1 pede endpoint "para uso externo" e o 3 exige
  JWT — um monitor não faz OAuth. Ficou sob a sessão; a saída recomendada é heartbeat, não
  endpoint. Decisão do dono.
- **Os três limiares da S6.3 seguem sem calibração** contra o baseline (chute conservador, marcado
  como tal no `.env.example`). Enquanto isso, o alerta é ruído em potencial.

Precedência: este sistema **mede**; não conserta. As correções do funil de onboarding vêm na
frente.
