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

**AusTV Admin S7 — entregue.** Módulo `health` expondo os checks, módulo `metrics` com client do
Plan, cache de TTL por endpoint e degradação honesta. 13 de 13 SP, DoD cumprido.

**AusTV Admin S6 — histórias entregues, DoD com itens em aberto.** Os **7** checks da §6.1 estão
implementados e alertando — o sétimo entrou em 2026-08-28 pela S8.0, que lhe construiu a fonte —,
mas **o critério 4 da S6.3 nunca foi cumprido**: ninguém derrubou uma instância de propósito para
provar que o alerta chega. Ver o bloco abaixo — a distinção importa mais que a contagem de SP.

> **Auditoria de 2026-08-27:**
> [`S6-VERIFICACAO.md`](.specs/features/austv-admin/S6-VERIFICACAO.md). Duas histórias fecharam com
> o **mesmo tipo** de lacuna, e não é coincidência: a S6.2b entregou os scripts de auditoria sem
> nunca rodá-los, e a S6.3 entregou a camada de alerta sem nunca dispará-la. Nos dois casos o que
> sobrou é o passo que exige tocar um ambiente real — e é o passo que separa "parece funcionar" de
> "funciona".

**AusTV Admin S8 — S8.0 e S8.1 entregues; S8.2 não iniciada.** A fonte do tutorial existe
([ADR-0004](.specs/decisions/ADR-0004-fonte-dados-tutorial.md): ETL noturno sobre
`Quests/playerdata`), o 7º check da §6.1 fechou o conjunto, e o módulo `funnel` publica três dos
quatro degraus. **O `[CORTE]` foi exercido:** a S8.2 (retenção por coorte) move para a S9 — não por
capacidade, mas porque tem três pré-requisitos abertos, e o primeiro é ler o `/v1/retention` antes
de abrir a exceção 1 do ADR-002. Detalhe no plano de sprints.

**Próxima: Sprint 9** — módulo `economy` (S9.1) e relatório periódico no Discord (S9.2), mais a
S8.2 se os pré-requisitos dela forem resolvidos.

**Em aberto, e vale mais que sprint:**

- **Duas leituras de minutos destravam a S8.2, e ninguém as fez.** `curl` no `/v1/retention` (pode
  **eliminar** a exceção 1 do ADR-002 inteira — e não olhar antes de abrir uma exceção é
  literalmente o erro que já custou a exceção 2) e `DESCRIBE plan_sessions` (nenhuma coluna dessa
  tabela está registrada em lugar nenhum). Exigem acesso à produção.
- **`plan_users` tem dias de profundidade, não meses.** O histórico do proxy não veio na unificação
  de 2026-08-20, então o degrau de rede do funil só fala do presente e a primeira coorte de D30 só
  existe em **2026-09-19**. O funil já trata isso — bucket sem cobertura sai `null`, nunca zero —
  mas nenhum número histórico de rede vai aparecer até lá.

- **O alerta de saúde CHEGA — comprovado em 2026-08-26.** Alertas reais do
  `platform.offline_account_share` foram observados no canal: `breached`, recuperação e o `n` ao
  lado do percentual, funcionando em produção. A camada deixou de ser construção sobre algo que
  ninguém verificou.
  **Agrupamento não entra nessa lista:** supressão só é observável sabendo que um ciclo produziu
  falha e nenhuma mensagem saiu, e os ciclos entre 19:54 e 21:24 nunca foram registrados. Três
  mensagens entregues não são evidência de supressão.
  **Falta metade do critério 4:** o caminho **`error`** — fonte que *morre*, não limiar que estoura.
  É outro código e é o que cobre o apagão de três meses. Teste: parar o Plan por um ciclo.
- **A oscilação dos alertas foi corrigida em código em 2026-08-29 — ainda não observada em
  produção.** 51,5% (n=33) → 50,0% (n=32) → 51,6% (n=31) em duas horas: com n≈32 um único jogador
  virava o alerta, e o limiar de 0,5 caía em cima do valor real. Duas correções, no mesmo PR:
  - o limiar foi **calibrado para 0,65** usando essa própria leitura (nível real ~51% — as três
    leituras são janelas de 7 dias tomadas em 105 minutos, então fixam o nível, não a estabilidade).
    É isto que silencia a sequência de 2026-08-26: a 0,65 nenhuma das três leituras estoura.
    O custo está registrado no `.env.example` — a faixa 0,55–0,65 fica cega de propósito;
  - a política passou a decidir contra **o que o canal foi informado por último**, não contra a
    linha anterior da tabela, com histerese de 2 ciclos no all-clear. A falha sai no primeiro
    ciclo; só a recuperação espera. Piora (`breached` → `no_data` → `error`) fura a janela;
    melhora sem chegar a `ok` espera.

  **E um teto por cima de tudo isso** (`HEALTH_ALERT_MAX_PER_WINDOW`, padrão 4): a regra de
  transição raciocina sobre formatos de oscilação e já errou duas vezes nisso — a primeira versão
  deixava `breached` ↔ `no_data` mandar uma mensagem por ciclo para sempre; a segunda ainda deixava
  `breached` → `ok` → `breached` passar, porque uma recuperação confirmada e entregue legitimamente
  reabre a porta (64/dia por aritmética; o teste fixa o resultado **com** o teto, em 6/dia). O teto
  não depende de prever o formato.

  O teto conta **repetição**, e só. Um status que o canal não ouviu nesta janela e uma recuperação
  confirmada passam sempre — barrar esses dois foi como a primeira versão do teto segurou um
  `error` por 45 horas e um all-clear para sempre, deixando um aviso cinza dizendo "calibre o
  limiar" como última palavra sobre um servidor que tinha sumido. Os dois casos estão fixados em
  teste. Ao estourar, o check recebe um aviso de que vai ficar quieto — mute sem aviso é
  indistinguível de check saudável — repetido uma vez por janela enquanto a oscilação durar.

  O que a política **não** faz: se a recuperação se sustentar e for entregue, a quebra seguinte é
  incidente novo e sai. Isso é correto. É por isso que a calibração é a metade que fecha o caso de
  2026-08-26 — as duas juntas, não a política sozinha.
- **A auditoria de rede da S6.2b nunca foi rodada.** Os scripts, o runbook e o template estão em
  `ops/audit/`; **nenhum relatório preenchido existe**, e o produto da história é o registro, não o
  script. Fechar isso e ler a whitelist do Plan (item abaixo) são a mesma tarefa.
- **O webserver do Plan não tem autenticação** (`authRequired: false`, medido 2026-08-26), e a
  whitelist de IP é o único controle **conhecido** na porta 25504.
  ✅ **A whitelist foi lida pelo dono em 2026-08-28 e está adequada** — era a verificação urgente
  antes do unban all, e fechou.
  **O que sobra:** o `ufw` estava inativo em 2026-08-21 e **não foi reverificado**, e a §11 3b1 do
  spec é explícita — *filtro de aplicação nunca substitui filtro de rede*. Uma whitelist boa numa
  porta sem filtro de rede é uma camada, não as duas que a §8 pede. A superfície de **escrita**
  (`POST /v1/saveGroupPermissions`) também segue não sondada. Detalhe no `HANDOFF.md`.
- **[#157](https://github.com/ZzPowerTech/ausTvSales/issues/157) — perda de venda em silêncio.**
  Um 429 faz o plugin marcar a venda como permanentemente falha. Descoberto na S7; é dado perdido,
  não incômodo.
- **Dois dos três limiares da S6.3 seguem sem calibração** contra o baseline (chute conservador,
  marcado como tal no `.env.example`). O terceiro, o share offline, foi calibrado pela produção —
  ver o item acima. Enquanto os outros dois forem chute, o alerta é ruído em potencial, que é como
  um canal do Discord vira mudo.
- **Probe externo de uptime.** O critério 2 da S7.1 pede endpoint "para uso externo" e o 3 exige
  JWT — um monitor não faz OAuth. Ficou sob a sessão; a saída recomendada é heartbeat, não
  endpoint. Decisão do dono.
- **A S12 continua estourada em 18 SP** (38% acima da capacidade), e dividi-la em duas é, segundo o
  plano de sprints, a única decisão de escopo que resta ao dono. Decidir antes de abrir o worktree
  dela.

Precedência: este sistema **mede**; não conserta. As correções do funil de onboarding vêm na
frente.
