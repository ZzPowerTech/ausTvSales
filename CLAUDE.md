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
quatro degraus — desde 2026-08-31 o degrau vazio é o **`rede`**, não o `survival`. **O `[CORTE]` foi exercido:** a S8.2 (retenção por coorte) moveu para a S9 —
não por capacidade, mas por três pré-requisitos abertos, o primeiro deles ler o `/v1/retention`
antes de abrir a exceção 1 do ADR-002.

**Os três pré-requisitos eram o mesmo, e ele caiu em 2026-08-29.** A leitura foi feita: a S8.2 não
precisa da exceção 1, não precisa de SQL e não precisa do `DESCRIBE plan_sessions`. Está
destravada; o que ela carrega agora é uma ressalva de rótulo, não um bloqueio. Detalhe no plano de
sprints.

**AusTV Admin S9 — entregue em 2026-09-02.** As três histórias em `main`: retenção por coorte
(S8.2, PR #183), relatório semanal no Discord (S9.2, PR #184) e a camada de economia (S9.1, PRs
#185 e #186). 18 SP contra 13 de capacidade, sem exercer o `[CORTE]` — mas **isso não é
velocidade**: a S8.2 chegou destravada e o que ela pedia era código, não investigação, e a S9.1
encolheu no caminho (ver abaixo).

Suíte: **72 suítes, 901 testes** unitários, mais 5 arquivos de e2e novos contra Postgres real.

**O que a Sprint 9 mede agora, e o que cada número exige do ambiente:**

| leitura | rota | precisa de |
|---|---|---|
| Retenção D1/D7/D30 por coorte × plataforma | `GET /retention/cohorts` | só o `PLAN_BASE_URL` que já existe |
| Receita por plataforma | `GET /economy/revenue` | **nada** — a plataforma sai do uuid da venda (ADR-003) |
| Receita por coorte, tempo até o 1º gasto | as mesmas duas rotas | `PLAYER_DIMENSION_SYNC_ENABLED` |
| Contato social (E3), feed de moderação (E4), série de chegadas (R1) | `/economy/social-contact`, `/economy/payments/feed`, `/economy/account-creations` | conta **read-only nova** no MySQL do PlayerPoints + `PAYMENTS_SYNC_ENABLED` |
| Relatório semanal no Discord | cron + `POST /reports/weekly/run` | `WEEKLY_REPORT_ENABLED` + `DISCORD_REPORT_WEBHOOK_URL` |

**Decisões da S9 que não se reabre sem o dono:**

- **🔒 A exceção 1 do ADR-002 foi FECHADA em 2026-09-02** pelo dono. A S8.2 saiu do
  `/v1/retention` — sem SQL, sem MySQL, sem credencial nova — e a exceção não autorizava mais
  nada. `plan_user_info` e `plan_sessions` voltam à regra geral do ADR-002. **`plan_users`
  continua acessível pela exceção 2**, que é outra autorização: fechar a 1 não mexe no funil nem
  nos checks de saúde. Reabrir, se um dia for preciso publicar retorno-no-dia-N, exige exceção
  nova e justificada por escrito.
- **A retenção publica INTERVALO DE SOBREVIVÊNCIA, não retorno no dia N**, e o rótulo viaja no
  campo `semantics` de toda resposta. As duas leituras são perguntas diferentes.
- **✅ A metade de E2 que cruza gasto com posição no funil foi entregue em 2026-09-02**
  (PR [#190](https://github.com/ZzPowerTech/ausTvSales/pull/190)), depois de o dono autorizar a
  expansão de dado pessoal que ela exige. O `tutorial_daily` continua agregado em
  `(dia, plataforma)` — a decisão da S8.0 não foi revertida; o que entrou foi uma **segunda**
  tabela, `tutorial_player_position`, atrás de `TUTORIAL_POSITION_ENABLED` e escrita por um
  caminho separado no ETL (`readPosition`, não `readContribution`), justamente para que a
  ampliação de pegada fique visível no ponto de chamada. `/economy/first-spend` publica
  `byFunnelPosition` (três grupos) e `byFurthestStep` (um por passo — é este que responde "quem
  trava no passo 03"), com denominador igual a **todo mundo naquela posição**, não a quem
  comprou. **Enquanto a variável não for ligada na VPS o bloco sai `null` com o motivo**, nunca
  uma lista de zeros.
- **A direção do pagamento é inferida, não confirmada.** Que `receiver` seja a conta creditada é
  a leitura natural do schema do PlayerPoints e nunca foi conferida contra um pagamento
  conhecido. Se estiver invertida, a marca `funding_many` aponta para quem **recebeu** de muitos.
  O caveat viaja no payload do feed; confirmar custa um comando no jogo.

**Próxima: Sprint 10** — sugestões (modelo, corpus e bot). Sem gate: a S6.1 foi cancelada e a S10
não depende mais de nada da S6.

**Em aberto, e vale mais que sprint:**

- **🔴 A primeira calibração de produção da retenção, em 2026-09-02, achou um defeito de
  mecanismo — não um limiar a ajustar.** A leitura de `2024-06..2025-08` (a região que a janela
  padrão de 12 meses nunca alcançava, e por isso a leitura anterior **não** tinha exercitado o
  detector) devolveu **45 coortes**, `5580/5580` linhas lidas sem descarte. O detector de
  carimbo achou **zero** dias e o artefato está lá assim mesmo: 21 coortes suprimidas por
  implausibilidade, e das 24 publicadas **23 publicaram 100% em D1, D7 e D30 ao mesmo tempo**.
  **O que separava os dois grupos não era o dado:** toda suprimida tinha ≥20 jogadores, toda
  publicada tinha ≤19 — a divisão cai exatamente sobre o piso de tamanho do guarda, que portanto
  decidiu os 45 casos sozinho.
  **Corrigido:** veredito herdado por vizinhança (`contaminated_span`). Uma coorte pequena demais
  para julgar é suprimida quando mostra a mesma forma de ~100% **e** registra dentro de uma
  **corrida** de meses contaminados — lacunas incluídas, porque 2024-09 a 2025-01 são cinco meses
  sem uma única coorte de 20 e quinze coortes a 100%. Só o requisito de **tamanho** é relaxado:
  curva real dentro da corrida continua publicando. A inferência tem motivo próprio (separado do
  `implausible_survival`, que julga por evidência direta) e as corridas saem em
  `contaminatedSpans`; a detecção roda sobre o payload inteiro e a janela é aplicada depois,
  senão pedir só a lacuna faria a evidência sumir.
  **A corrida é crescida, e isso veio do review:** a primeira versão era `[min, max]`, que
  invocava continuidade como justificativa sem testar continuidade em lugar nenhum — duas
  importações com um ano de distância viravam uma faixa de um ano. Duas paredes param uma
  corrida: um **mês limpo** (coortes julgáveis que passaram e nenhuma reprovada própria — uma
  coorte saudável de 200 pessoas é evidência *contra* a escrita) e uma **lacuna maior que seis
  meses**. E a string de motivo dizia que *todas* as julgáveis do intervalo tinham sido
  reprovadas, o que o código nunca checava e em produção é falso — `2025-08 / java_offline`
  passa dentro de um mês confirmado. Diz "21 de 22" agora, com a base contada. A leitura inteira
  está fixada em `retention-production-shape.spec.ts`.
  **O buraco deixado de propósito:** coorte pequena a 100% **fora** de intervalo provado
  continua publicando — onze jogadores que ficam não provam nada sozinhos, que é a razão de o
  piso existir.
  **✅ E o segundo achado da mesma leitura foi fechado no mesmo dia, pelo dono ("marcar por
  medida"):** `belowMinimum` olhava o tamanho da **coorte**, não a base do **horizonte**, então
  `2026-08 / bedrock` (43 jogadores) publicava `D30: 0%` sobre `n: 5` sem marca nenhuma. A marca
  passou a existir por medida, contra a base daquele horizonte; a de coorte continua, porque
  responde outra pergunta. As bases de uma coorte divergem por construção — a maturidade é
  filtrada por jogador —, então uma marca só ao lado de três percentuais erra em dois, do mesmo
  jeito que um `n` só erraria. Marcar e não suprimir, porque amostra pequena suprimida é
  invisível. **Nenhum teste pegava isto porque nenhuma fixture tinha bases divergentes por
  horizonte** — todas maturavam os jogadores juntos.
- **✅ As duas leituras foram feitas em 2026-08-29, e destravaram a S8.2.** O `/v1/retention`
  devolve 5565 linhas com `playerUUID`, `registerDate`, `lastSeenDate`, `playtime` e
  `timeDifference` — coorte e plataforma saem daí, então **a premissa da exceção 1 do ADR-002
  caiu** e o `DESCRIBE plan_sessions` deixou de importar. O `/v1/networkMetadata` lista as
  instâncias mas **não traz `plan_version`**: a exceção 2 fica de pé para o `version_divergence`,
  com justificativa reescrita.
  **A exceção 1 ficou sem justificativa nenhuma e ninguém a fechou** — fechar é decisão do dono.
  **A ressalva que a S8.2 tem de carregar:** `lastSeenDate` mede intervalo de sobrevivência, não
  retorno no dia N. Publicar é aceitável; publicar sem o rótulo é o erro de denominador de novo.
- **✅ O rótulo de rede foi consertado em 2026-08-31 — e o que sobrou é a falta da fonte.**
  O `plan_users` deste banco não tem a rede: o proxy (`AusTv`, `is_proxy=1`) está no catálogo com
  **zero** jogadores em `plan_user_info`, só o Survival tem (5575 de 5638), e as contagens mensais
  da tabela são **exatamente** a coluna `survival` dos números verificados do `HANDOFF.md` — 682,
  641, 727, 374, 258, 192, 1, 106, os oito meses sem diferença. A profundidade, aliás, é boa:
  `coversFrom` = **2024-06-02**, 26 meses; a alegação de "3 dias" apontava um problema real e o
  descreveu com a palavra errada.
  **O que foi feito:** o degrau `rede` do funil saiu `null` com motivo e a **mesma contagem passou
  a alimentar o degrau `survival`**, que até então não tinha fonte — os dois trocaram de lugar, sem
  que nenhuma contagem mudasse, e a conversão `rede → survival` deixou de ser Survival ÷ Survival
  perto de 100%. A procedência viaja no payload, porque a identidade Survival de `plan_users` é
  coincidência medida, não garantia de schema. O `funnel.network_to_survival` parou de dividir uma
  população por ela mesma e devolve `no_data` com o motivo, sem tocar no banco nem no Plan.
  **Achado na revisão do próprio PR e corrigido nele:** `no_data` sozinho não bastava. Um check que
  devolve `no_data` **para sempre** quebra os dois consumidores de veredito, que assumem que estado
  não-`ok` se resolve — com um alerta aberto no canal o `decideAlerts` re-anunciava **um por dia,
  eternamente**, e o `resolveStatus` fixava o `/health/instrumentation` em `degraded`, onde um
  segundo check piorando já não movia nada. Saiu daí o conceito de **`ACCEPTED_BLIND_SPOTS`**:
  silencia **só o veredito pelo qual o check foi aceito** (`no_data`), fica fora do agregado, e é
  publicado por nome em `blindSpots` e como flag por linha em `/health/instrumentation/checks` —
  fora do veredito, não do payload. A régua para entrar está no código e é dura: *nenhuma fonte
  alcançável responde à pergunta*, nunca "o check é barulhento".
  **Uma segunda rodada de review apertou os três pontos que o mecanismo abria:** suprimir pelo nome
  sozinho engoliria um `breached` real de um membro futuro — agora qualquer status inesperado é
  anunciado, e é assim que a contradição aparece; os vereditos suprimidos passaram a ter campo
  próprio no resumo de ciclo (`blindSpotHeld` / `pontos_cegos=`), porque dentro do total genérico o
  número é ilegível; e a listagem por check ganhou a flag, já que `no_data` permanente e `no_data` de
  janela vazia tinham exatamente a mesma cara.
  **O que sobra, e é do dono:** os ~54% deixaram de ser vigiados — não é rebaixamento de sinal, é o
  reconhecimento de que nunca houve sinal —, e restaurá-los exige uma **fonte de chegadas no
  proxy** que nem a API nem o banco autorizado hoje têm. E o
  `plan.proxy_registration_alive` tem o mesmo defeito de rótulo: lê `plan_users`, logo **não cobre
  o apagão do proxy** que lhe deu origem. Os sumários dele passaram a dizer isso; **renomear o
  identificador persistido é decisão do dono**, porque partiria o histórico do check.
  **✅ Validado em produção em 2026-09-01** (`backend-v0.15.2`): o degrau `rede` sai `null` com
  motivo, a conversão `rede → survival` sai `null` em vez de ~100%, o `survival` traz **687**,
  `coversFrom` confirma **2024-06-02**, e o `/health/instrumentation` publica `blindSpots` com o
  check fora de `counts` e de `failing` — com o agregado ainda indo a `down` por um `error` de
  outro check, que era a propriedade a não perder. E o ciclo real de 03:50:24 fechou o terceiro:
  `no_data=1 · anunciados=0 · entregues=0 · pontos_cegos=1` — o ponto cego não paginou o canal, e o
  contador diz que foi pelo ramo `accepted_blind_spot`, não por acaso.
  **🔴 E a validação derrubou uma alegação minha:** eu disse que a segunda metade do DoD da S8
  (`~100%` de entrada no tutorial, `694/682`) era *calculável, só não rodada*. Rodou: **não é
  calculável em produção**, porque o `tutorial_daily` está `never_synced` — o **ETL da S8.0 não
  está configurado na VPS** (`TUTORIAL_PLAYERDATA_DIR` vazio, `TUTORIAL_SYNC_ENABLED=false`).
  Dois dos quatro degraus do funil nunca produziram dado em produção, e o
  `funnel.tutorial_entry_rate` está em `error` por isso. É o padrão da auditoria de 2026-08-27 pela
  terceira vez — só que desta vez o ambiente foi tocado, então a lacuna apareceu.
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
  reabre a porta (64/dia; 448 por semana, medido sem o teto). O teto não depende de prever o
  formato.

  O teto conta **repetição**, e só. Um status que o canal não ouviu nesta janela passa sempre —
  barrá-lo foi como a primeira versão do teto segurou a morte de uma fonte por 45 horas, deixando
  um aviso cinza dizendo "calibre o limiar" como última palavra sobre um servidor que tinha
  sumido. Recuperação confirmada **é** barrada, um slot antes das demais, e
  por outro motivo: solta, ela ganha a corrida para ser a última mensagem, e o canal fica
  segurando um "normalizado" sobre um check que quebra a cada três ciclos — falso all-clear, a
  única coisa que esta camada não pode produzir. Reservar o último slot para um problema **reduz** esse
  caso — não o elimina, porque o passe do status-não-ouvido é avaliado antes do limite, e
  é inerte para teto 1 ou 2. O passe do status-não-ouvido a libera quando os
  `ok` da própria oscilação saem da janela, e a espera aparece no log como
  `segurados_por_orcamento`. Os três casos estão fixados em teste. Ao estourar, o check recebe um aviso de que vai ficar quieto — mute sem
  aviso é indistinguível de check saudável.

  Medido: a oscilação que dava **448** mensagens por semana passa a dar **27**, e o canal nunca
  passa uma janela inteira sem notícia de um check que oscila — ou sai uma mensagem de verdade,
  ou sai o aviso cinza. Quatro formatos de oscilação diferentes estão fixados em teste.
  Duas ressalvas medidas: o aviso cinza não pode ser carimbado `ok` — seria lido como
  all-clear —, então uma sequência de `ok` na fronteira estica o silêncio por esses
  ciclos; e do lado da recuperação o custo chega a ~23h com o canal segurando um `breached`
  sobre um check já saudável, sem nada dito durante a espera. Aparece no log como
  `segurados_por_orcamento`.

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
- **Um dos três limiares da S6.3 segue sem calibração** contra o baseline (chute conservador,
  marcado como tal no `.env.example`). O share offline foi calibrado pela produção — ver o item
  acima. O terceiro, `FUNNEL_MIN_NETWORK_TO_SERVER`, ficou **inerte** em 2026-08-31: o check que o
  lia parou de publicar razão. A variável continua aceita pela validação para não quebrar um `.env`
  já implantado, e volta a precisar de calibração no dia em que existir fonte de rede. Enquanto o
  que sobra for chute, o alerta é ruído em potencial, que é como um canal do Discord vira mudo.
- **Probe externo de uptime.** O critério 2 da S7.1 pede endpoint "para uso externo" e o 3 exige
  JWT — um monitor não faz OAuth. Ficou sob a sessão; a saída recomendada é heartbeat, não
  endpoint. Decisão do dono.
- **A S12 continua estourada em 18 SP** (38% acima da capacidade), e dividi-la em duas é, segundo o
  plano de sprints, a única decisão de escopo que resta ao dono. Decidir antes de abrir o worktree
  dela.

Precedência: este sistema **mede**; não conserta. As correções do funil de onboarding vêm na
frente.
