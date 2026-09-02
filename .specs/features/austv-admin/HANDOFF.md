# AusTV Admin — HANDOFF

> Para retomar em sessão nova (Claude Code, dentro de `ausTvSales`).
> Última atualização: 2026-08-21 · Origem: sessão de investigação de retenção do AusTV.

## Documentos canônicos (já estão no repo)

| arquivo | o que é |
|---|---|
| [`.specs/features/austv-admin/spec.md`](spec.md) | Spec v2 aprovado tecnicamente — ADRs, requisitos por camada, entidades, superfície de ataque, critérios de aceite |
| [`.specs/sprints/austv-admin-sprints.md`](../../sprints/austv-admin-sprints.md) | 19 histórias, Sprint 6 → 12, **105 SP**, com DoD e grafo de dependências |
| `CLAUDE.md` / `structure.md` | contexto do repo — ambos atualizados em 2026-08-21 |

**Leia o spec antes de qualquer coisa.** Ele contém o "porquê" de decisões que parecem arbitrárias
fora de contexto.

> **Procedência (2026-08-21):** o spec e o plano de sprints não estavam versionados — foram
> recuperados do Google Drive (pasta `Austv`) e commitados neste dia. Os cinco scripts de
> diagnóstico listados no fim deste documento **continuam ausentes** e bloqueiam a S6.0.
>
> **Corpus de sugestões (2026-08-22): encerrado.** O `Ticket-Bot` foi lido e não tem sistema de
> sugestões. O "Carlito" é o **Carl-bot**, bot público de terceiros — nunca foi software da equipe.
> As sugestões não são recuperáveis do banco dele, e **o dono decidiu que perder os registros
> antigos é aceitável**. A `S6.1` foi **cancelada**; a S6 caiu de 22 para 17 SP e o épico de
> sugestões perdeu seu gate. `BackEnd-TicketBot` e `FrontEnd-Ticket` estão fora de uso desde
> nov/2025 e foram descartados. Detalhe no bloco da S6.1, no plano de sprints.

---

## ⚠️ Erros já cometidos — não repetir

**Cinco** afirmações foram feitas com confiança e estavam **erradas**. Todas pela mesma causa raiz.

**1. "O colapso de aquisição começou em dezembro/2025."** Falso. A série usada vinha do
`Quests/playerdata` e media **quem entrou no tutorial**, não quem chegou. Em dezembro o tutorial
parou de capturar novatos (de ~100% para 12% de taxa de entrada); a aquisição só caiu em
**fevereiro/2026**.

**2. "48 chegadas/mês, impossível medir antes de 6 meses."** Falso. Os 48 eram entradas no
tutorial. Chegadas reais: **~190–250/mês**. Medir antes/depois de uma correção leva 2–4 semanas.

**3. "Queda de 96%."** Contaminado pela mesma série. A queda real (nov/2025 → ago/2026) é de
**−72%**.

**4. "O corpus de ~3.028 sugestões está no bot Carlito, é só exportar."** Falso em duas camadas,
descoberto em 2026-08-22. Primeiro: o `austv-minecraft/Ticket-Bot`, tido como o Carlito, **não tem
sistema de sugestões** — o domínio dele é ticket, e as quatro coleções do Mongo não guardam
sugestão, voto nem reação. Depois, ao perguntar: **o Carlito é um bot de terceiros**, não é
software da equipe. Ou seja, a história foi escrita, estimada em 5 SP e marcada como PR 0
bloqueante sobre um sistema que a equipe **não escreveu e não controla**. A estimativa de 3.028 não
tem origem rastreável — e nunca terá, porque o acervo não sai do banco do fornecedor. A história
foi **cancelada** em 2026-08-22, com a perda dos registros antigos aceita pelo dono.

**5. "O Plan não expõe lista de servidores."** Falso, descoberto em 2026-08-26. Os dois nomes
tentados — `/v1/servers` e `/v1/networkOverview` — estavam errados; o endpoint documentado é
**`/v1/networkMetadata`**. A conclusão errada virou a justificativa da **exceção 2 do ADR-002**, que
autorizou ler `plan_servers` por SQL direto. Contexto na seção
[A lista autoritativa de endpoints do Plan](#-a-lista-autoritativa-de-endpoints-do-plan-foi-encontrada-2026-08-26).

> **Lição de método, aplicável a tudo:** série derivada de plugin mede o comportamento **daquele
> plugin**, não a realidade. Confirmar com uma segunda fonte independente antes de tratar qualquer
> série como métrica de negócio.
>
> O erro 4 é a mesma raiz noutra roupa: uma história inteira foi escrita, estimada e marcada como
> **PR 0 bloqueante** sobre um repositório que ninguém tinha aberto. Antes de estimar trabalho
> sobre um sistema, **ler o sistema** — o custo de abrir o repo é de minutos, e teria evitado um
> gate de épico apontando para o lugar errado.

---

## Números verificados (3 fontes cruzadas)

| mês | rede (Plan-proxy) | survival (Plan) | contas (PlayerPoints `SET`) | tutorial (Quests) | bedrock % |
|---|---|---|---|---|---|
| 2025-11 | 1403 | 682 | — | 694 | — |
| 2025-12 | 1259 | 641 | — | 290 | — |
| 2026-01 | 1177 | 727 | 34 | 200 | 29% |
| 2026-02 | 645 | 374 | 355 | 87 | 43% |
| 2026-03 | 445 | 258 | 250 | 56 | 35% |
| 2026-04 | 360 | 192 | 183 | 23 | 35% |
| 2026-05 | 1 | 1 | 1 | — | manutenção |
| 2026-06 | *(Plan morto)* | 106 | 94 | 26 | 28% |
| 2026-07 | *(Plan morto)* | — | 249 | 0 | 23% |
| 2026-08 | 8 *(quebrado)* | — | 130 (21d) | 0 | 27% |

Fatos derivados:

- **54% de quem conecta na rede nunca chega ao survival** — degrau anterior ao tutorial, nunca
  medido antes
- Conversão rede→survival por plataforma: **bedrock 71,5% · java_premium 61,8% · java_offline
  39,3%** (offline pior pode ser tráfego de bot — não confirmado)
- Retenção (base enviesada, 11.525): D1 30,1% · D7 21,7% · D30 15,4%. **Piso real sobre todas as
  chegadas: D1 ≈ 7%**
- Tutorial: 33 passos lineares, **148 conclusões em 49.302 jogadores históricos (0,3%)**. Gap
  Bedrock aparece só em passos com argumento livre ou interação espacial; comando de uma palavra
  tem gap **zero**
- Mix de plataforma **all-time** (59,2% bedrock) ≠ mix atual. Sempre citar a janela

---

## ADRs (resumo — detalhe no spec)

| # | decisão | motivo em uma linha |
|---|---|---|
| 001 | Plan upstream consumido pela **API JSON `/v1/*`**, sem fork nem fusão de repo | `ausTvSales` é MIT, Plan é LGPL-3.0; bancos e frontends incompatíveis |
| 002 | NestJS fala com `/v1/*`, **nunca** com tabelas do Plan | schema interno muda entre versões; exceção única e isolada: coorte histórica |
| 003 | `platform` derivada do **UUID**, sem plugin | `00000000-0000-0000-0009-%` = bedrock; `SUBSTRING(uuid,15,1)` = 3 offline / 4 premium. 100% de acerto em 49.302 arquivos |
| 004 | `ausTvSales` continua MIT e intocado pela LGPL | nenhum arquivo do Plan entra no monorepo — item de checklist de PR |
| 005 | **Um único MySQL** para toda a rede do Plan | requisito do Plan; sem isso não há visão de rede nem tempo por servidor |
| 006 | O sistema precisa **detectar a própria cegueira** | todo desastre encontrado foi silencioso por meses |
| 007 | Economia vem de **banco via ETL**, não de plugin | **zero Java na v1**; tabela de origem sem índice, nada roda ao vivo no MySQL do jogo |
| 008 | **PostgreSQL é o armazém analítico**; fontes são ETL | não existe JOIN entre MySQL e Postgres |

**R3 (resolvido):** não existe join entre `playerpoints_transaction_log` e `ausTvSales`. Escopo é
**analytics apenas**. Gasto vem do `ausTvSales`; social (`PAY_*`) vem do PlayerPoints. Nenhuma
alteração de plugin.

---

## Estado e ordem

**A Sprint 5 do `ausTvSales` está entregue** (ranking, série temporal — PRs #97–#103). As sprints do
AusTV Admin começam na **6** e reaproveitam os componentes de gráfico da S5, que portanto já estão
prontos — isso **encolhe** a S12.

**Precedência de negócio:** as correções do funil de onboarding rodam em paralelo e vêm na frente.
Este sistema **mede**; não conserta.

Ordem inegociável, hoje reduzida a um item: ~~`S6.1` (corpus) antes de todo o épico de
sugestões~~ — **caiu em 2026-08-22** com o cancelamento da S6.1; a S10 não depende mais da S6 ·
~~`S6.2` (banco único) antes de `S6.3`~~ — **caiu em 2026-08-23**: os bancos foram unificados pelo
dono em **2026-08-20**, então a S6.3 não tem gate · **UI (`S12`) por último** — o único
pré-requisito que sobrou. Cada sprint tem uma história marcada `[CORTE]`, a primeira a sair sob
pressão — **exceto a S6, que ficou sem nenhuma** quando a S6.1 saiu (e que, a 12 SP contra 13 de
capacidade, não precisa mais de uma).

**Desbalanço da S6 — RESOLVIDO em 2026-08-23:** com 13 SP/sprint planejados, a **S6 caiu de 22 para
17 SP** com o cancelamento da S6.1, e de **17 para 12** quando a S6.2 foi reconhecida como concluída
(o dono unificou os bancos em **2026-08-20**, antes de a história ser aberta). A S6 é sprint de data
— tem prazo externo, o unban — mas agora também cabe na capacidade. A **S12 segue em 18 SP** e é o
**único estouro restante**. Total do plano: **95 SP**.

> **Cuidado ao medir a velocidade da S6:** dos 10 SP que saíram da sprint, **nenhum foi executado**.
> Cinco eram trabalho inexistente (S6.1, corpus que não existe) e cinco eram trabalho já feito
> (S6.2). Ler isso como velocidade de entrega superestima a capacidade real em quase 2×. O único SP
> de código entregue na S6 até agora está na S6.3.

### Numeração das sprints — RESOLVIDO em 2026-08-21

O plano numera as sprints do AusTV Admin de **6 a 12**. O `ausTvSales` **já tem** um Sprint 6
próprio (`.specs/sprints/sprint-06.md` — migração histórica, cutover no Genesis, go-live), com as
issues **#27, #28, #29 e #30 abertas** desde 2026-07-13.

**Decisão do Murilo: não renumerar.** A numeração dos documentos fica como está, e a separação
acontece nos metadados do GitHub:

| eixo | AusTV Admin | ausTvSales |
|---|---|---|
| milestone | `AusTV Admin S6` … `AusTV Admin S12` | `ausTvSales S6` |
| label de sprint | `admin:sprint-6` … `admin:sprint-12` | `sales:sprint-6` |

Motivo: o spec e o plano se referenciam por `S6.1`, `S6.2b`, `S9.1` em dezenas de pontos — inclusive
a §10b do spec, que cita a `S6.2b` nominalmente. Renumerar quebraria todas essas referências
cruzadas para resolver um problema que é só de organização no GitHub.

### Issues no GitHub

**Ainda não foram criadas** — a ferramenta falhou no fim da sessão de investigação. O plano de
sprints tem tudo que é preciso: 19 histórias com título, critérios de aceite, estimativa, branch
sugerida e dependências. Mapeamento: sprint → milestone, história → issue, labels
`admin:sprint-N`, `epic:*`, `type:*`, `blocker`.

> **Armadilha conhecida (do vault):** `gh` no PowerShell corrompe acento quando recebe string por
> pipe. Gravar o corpo em arquivo UTF-8 sem BOM e usar `gh issue create --body-file`.

---

## ⚠️ Bloqueio descoberto na implementação da S6.3 (2026-08-23)

**O check de "taxa de entrada no tutorial" não tem fonte de dados.** Descoberto ao desenhar o port
do Plan para os 7 checks da §6.1.

Dos sete checks, seis têm origem definida; um não tem:

| check | fonte | situação |
|---|---|---|
| Coleta viva por servidor | `/v1/sessions`, `/v1/serverOverview` | ✅ |
| Registro vivo no proxy | `/v1/graph?type=uniqueAndNew` | ✅ |
| Instância órfã | `/v1/serverOverview` | ✅ |
| Versões divergentes | `/v1/serverOverview` | ✅ |
| Conversão rede → survival | `/v1/sessions` por servidor | ✅ |
| Share de conta offline | `/v1/playersTable` + ADR-003 (UUID) | ✅ |
| **Taxa de entrada no tutorial** | — | ❌ **não existe** |

**Por quê:** o Plan não coleta nada do tutorial. Os números de tutorial deste documento vieram de
ler `Quests/playerdata/*.yml` **na máquina do game**, com os scripts do baseline. Esses arquivos
não são alcançáveis pela API, não estão no MySQL do Plan e não estão no PostgreSQL do `ausTvSales`.

**O que isso torna inexequível como está escrito:**

- Critério da S6.3: *"alerta de taxa de entrada no tutorial testado com valor forçado"*
- Degrau `tutorial_entrou` do funil de 4 degraus da §6.2 — e portanto parte da **S8.1**
- O check que teria evitado o desastre de 8 meses (§6.1) é justamente este

**As opções, para o dono decidir:**

| # | opção | custo | o que perde |
|---|---|---|---|
| 1 | ETL noturno lendo `Quests/playerdata` na máquina do game | novo ETL de arquivo (não de banco); precisa de acesso ao FS da máquina do game | nada — é a fonte real |
| 2 | Usar os proxies do Essentials (`kit prot` = 02tutorial, `home` ≥1 = 05tutorial) via ETL | mais barato; a fonte já é lida pelos scripts do baseline | são **proxies** — kit/home obtidos por outra via inflam o número (registrado no README do baseline) |
| 3 | Entregar 6 dos 7 checks na S6.3 e mover o do tutorial para a sprint que criar a fonte | zero agora | o épico fica sem o check que cobre o desastre mais longo já ocorrido |
| 4 | Instrumentar o tutorial na origem (plugin/comando) | contraria o ADR-007 (**zero Java na v1**) | reabre decisão fechada |

**Recomendação:** opção 3 agora — não segurar a S6.3 inteira por um check —, com a opção 1 aberta
como história própria. A opção 2 é tentadora e é a que eu **não** recomendaria sem registro: trocar
a métrica pela proxy sem rotular seria repetir a classe de erro que este documento inteiro existe
para impedir.

### ✅ DECIDIDO em 2026-08-23 — opção 3

**Decisão do dono:** entregar os 6 checks com fonte e abrir história própria para a fonte do
tutorial.

- A **S6.3 fechou com 6 de 7 checks**, escopo reduzido explicitamente e não por omissão.
- Nasceu a **S8.0 — Fonte de dados do tutorial** (5 SP, `feat/tutorial-data-source`), na Sprint 8,
  porque o degrau `tutorial_entrou` da S8.1 depende da mesma fonte.
- A escolha entre as opções 1, 2 e 4 é a **primeira tarefa da S8.0**, não uma decisão tomada agora.
- O critério 5 da S6.3 (*alerta de tutorial testado com valor forçado*) foi **movido** para a S8.0,
  não descartado.

**Custo registrado, não escondido:** o total do plano voltou de 95 para **100 SP**. A S8.0 não é
escopo novo — é escopo que sempre esteve na S6.3 e mudou de lugar quando se descobriu que não tinha
fonte. E a S8 passou de 13 para **18 SP**, virando o segundo estouro ao lado da S12.

**O que fica sem cobertura enquanto isso:** o desastre mais longo já registrado neste servidor — o
tutorial parou de capturar novatos em dez/2025 e a taxa caiu de ~100% para 12% ao longo de 8 meses
— segue **sem alerta automático**. Foi um trade-off aceito com esse fato à vista.

> **Atualizado em 2026-08-23:** os seis checks com fonte estão **implementados e mergeados**. O
> sétimo virou a S8.0.
>
> **Atualizado em 2026-08-28: o sétimo entrou.** A S8.0 construiu a fonte
> ([ADR-0004](../../decisions/ADR-0004-fonte-dados-tutorial.md): ETL noturno lendo
> `Quests/playerdata`), e `funnel.tutorial_entry_rate` está no registro. O parágrafo acima — "segue
> **sem alerta automático**" — **deixou de valer** para o desastre de 8 meses.
>
> O que **continua** valendo, e é outra coisa: nenhum destes sete alertas foi visto chegando num
> canal real. O critério 4 da S6.3 segue aberto.

## Estado da S6.3 em 2026-08-23 — o que está pronto e o que trava

**Entregue e mergeado** (PRs #127, #128, #131, #135, #137, #139, #140, #141):

| peça | o que faz |
|---|---|
| `health_checks` + `HealthCheckStore` | persistência append-only dos vereditos, com histórico |
| `alert-policy` | decide o que anuncia, agrupa repetição, separa recuperação de perda de sinal |
| `DiscordAlerter` | entrega no canal; menção inerte, markdown escapado, webhook nunca logado |
| `PlanApiClient` | transporte `/v1/*` com taxonomia de erro em 4 classes |
| `plan-server-overview` | adapter do `serverOverview`, com **payload real** de produção como fixture |
| `HealthCheckRunner` | executa, persiste, decide, anuncia; guarda de ciclo sobreposto |
| `CollectionAliveCheck` | **1 dos 7 checks** — coleta viva por backend |
| `HealthCheckScheduler` | agendamento por intervalo, opt-in, com carência no boot |

`main` verde: 33 suites, 296 testes, build e lint limpos.

### O que impede declarar a S6.3 concluída

> **Esta seção é um retrato de 2026-08-23** e várias linhas dela envelheceram: os seis checks com
> fonte foram implementados desde então, e a "decisão pendente do dono" sobre a exceção 2 foi
> tomada no mesmo dia. As anotações de 2026-08-26 nas linhas abaixo são a exceção, e estão datadas.

**1. Seis dos sete checks da §6.1 não existem.** Três deles **não têm fonte de dado**:

| check | situação | o que falta |
|---|---|---|
| `plan.collection_alive` | ✅ pronto | — |
| `funnel.network_to_survival` | construível já | `serverOverview` de dois servidores |
| `plan.proxy_registration_alive` | bloqueado | shape de `/v1/graph?type=uniqueAndNew` |
| `platform.offline_account_share` | bloqueado | shape de `/v1/playersTable` |
| `plan.orphan_instance` | ~~**sem fonte**~~ — **implementado**; premissa corrigida em 2026-08-26 | ~~Plan não expõe lista de servidores — `/v1/servers` e `/v1/networkOverview` dão 404~~ — **falso, os nomes estavam errados.** O endpoint é **`/v1/networkMetadata`**, descrito como lista de servidores. E o check **como construído** não usa recência por servidor: ele reconcilia duas LISTAS (`plan_servers` × `PLAN_SERVERS`), e o docblock dele diz que recência exigiria `plan_sessions`, fora da exceção 2. Ou seja, uma lista de servidores plausivelmente basta — falta ler o corpo para confirmar |
| `plan.version_divergence` | **implementado** sobre a exceção 2 | `plan_version` por instância. **É aqui que a pergunta aberta se concentra**: a descrição do `/v1/networkMetadata` promete lista de servidores e não diz nada sobre versão. Sem ler o corpo, este é o check que impede fechar a exceção 2 |
| `funnel.tutorial_entry_rate` | **sem fonte** | Plan não coleta nada de tutorial (bloco anterior deste documento) |

**Decisão pendente do dono:** abrir uma segunda exceção documentada ao ADR-002 (SQL read-only sobre
`plan_servers`, como já existe para coorte) destravaria `orphan_instance` e `version_divergence` de
uma vez. A alternativa é aceitar 4 de 7 checks e registrar os 3 como fora de alcance da v1.

**2. O critério 4 da S6.3 não foi cumprido** — *"verificado derrubando uma instância de propósito"*.
Exige ligar o agendamento num ambiente real com webhook configurado. Nada disso está em produção.

**3. O critério 5** — *"alerta de taxa de entrada no tutorial testado com valor forçado"* — é
inexequível enquanto o check não tiver fonte.

### ⚠️ `/v1/serverOverview` está deprecado — e o sucessor ainda não serve (2026-08-25)

Descoberto durante a S7.2, ao sondar o Plan de produção. O console do jogo respondeu:

```
[15:51:38 WARN] [plan]: Webserver: Deprecated endpoint /v1/serverOverview was called.
Endpoint /v1/datapoint should be used instead.
```

**Não migrar ainda.** O `/v1/datapoint` existe, mas os datapoints implementados não cobrem nada
do que este projeto consome. Do changelog do Plan:

> Implemented datapoints PLAYTIME, AFK_TIME, AFK_TIME_PERCENTAGE, WORLD_PIE, SERVER_PIE,
> MOST_PLAYED_GAME_MODE, MOST_PLAYED_WORLD

Nenhum deles dá `new_players`, `unique_players`, `sessions` ou retenção — que é exatamente o que
`serverOverview` e `onlineOverview` fornecem, e o que os checks da S6.3 e o módulo `metrics` da
S7.2 precisam. Migrar agora seria trocar um endpoint que funciona por um que não tem os campos.

Confirmado por requisição: `/v1/datapoint` sem parâmetro responde
`{"error":"type is required","status":400}`. Os valores válidos de `type` **não foram
observados** — e não saem da documentação: o
[Javadoc do Plan](https://plan-player-analytics.github.io/Plan/api/index.html) documenta a **API
Java do plugin**, não os endpoints HTTP. ~~A lista autoritativa fica no `/docs` do próprio webserver
(`http://198.89.99.70:25504/docs`), que ninguém consultou ainda.~~ — **consultada em 2026-08-26**,
e o resultado desmentiu duas coisas registradas neste documento. Ver a seção da lista autoritativa
mais abaixo.

**Duas armadilhas de leitura registradas:**

1. O changelog lista como deprecados o `/v1/sessionsOverview` e o `/v1/network/sessionsOverview`
   — **não** os dois que usamos. O aviso do console veio de uma versão diferente da citada no PR.
   Ou seja, a lista de deprecados do changelog **não é** a lista completa; a fonte autoritativa é o
   aviso da instância viva.
2. O changelog menciona permissões web `data.network`, `data.server` e `data.player` para o
   `/v1/datapoint`. Hoje os `/v1/*` **não têm autenticação nenhuma** (verificado em 2026-08-23:
   parâmetro faltando dá 400, servidor inválido dá 403, nunca 401). Se a migração vier acompanhada
   dessas permissões, o `PLAN_API_TOKEN` — hoje palpite defensivo — vira requisito, e o client
   passa a precisar de credencial que ninguém provisionou.

**Decisão da S7.2:** continuar em `serverOverview`/`onlineOverview`, concentrar os caminhos num
único ponto do `PlanApiClient` para que a migração futura seja uma linha, e reabrir quando o
`/v1/datapoint` publicar os datapoints de chegada, sessão e retenção.

### Payload de `/v1/onlineOverview` observado (2026-08-25)

Colhido do Survival de produção. Não tem UUID, nickname nem IP — só contagens agregadas.

Formato relevante para quem escrever o parser:

- **Tipos misturados na mesma seção.** `new_players_7d` é número JSON; `new_players_retention_7d_perc`
  é a string `"66.67%"`; `sessions_30d_trend` é o objeto `{text, direction, reversed}`.
- **`n` está disponível ao lado de todo percentual.** `new_players_retention_7d: 24` com
  `new_players_7d: 36` dá os 66,67%. A regra do projeto — nenhum percentual sem base — é
  satisfeita por esta fonte sem cálculo extra.
- Os mesmos sentinelas de "sem dado" do `serverOverview` valem aqui: `toNumber()` de
  `plan-server-overview.ts` já os trata e **deve ser reusado**, nunca reimplementado.

---

### Fatos de infraestrutura apurados em 2026-08-23 (não relitigar)

- **A VPS alcança o Plan.** `curl` da VPS para `198.89.99.70:25504/v1/serverOverview` devolve `400`,
  igual ao localhost. **ADR-001 está de pé.**
- **Não há autenticação nos `/v1/*`.** Parâmetro faltando dá `400`; nome de servidor inválido dá
  `403`; nunca `401`. O `Authorization: Bearer` do client é palpite defensivo, não requisito.
  > **Complicado em 2026-08-26:** o OpenAPI mostra que a autenticação é **chave de configuração**
  > (`/v1/whoami` diz se está ligada) e que o esquema é **cookie de sessão**, não bearer. E no mesmo
  > dia todo endpoint passou a responder `403` para uma origem. O fato de 23/08 descrevia 23/08.
  >
  > **CONFIRMADO horas depois, por leitura direta:** `/v1/whoami` da VPS devolve
  > `{"authRequired":false,…}` (corpo truncado no terminal; só este campo foi lido). A autenticação
  > **está desligada**.
  >
  > A conclusão de 23/08 estava certa; **o raciocínio dela, não**. "Nunca `401`" não implica
  > ausência de autenticação — uma auth por cookie recusa com `403`, que é o que este mesmo Plan
  > devolve. Estava certo por sorte, e agora está certo por medida.
  >
  > Consequência prática: o `Authorization: Bearer` do nosso client é config morta contra o estado
  > atual, e estaria no esquema errado de qualquer forma.
- **`Use_X-Forwarded-For_Header: false`** — a whitelist do Plan usa o IP real do socket e **não é
  contornável por header**. Responde a pergunta 3b1 do spec.
- **Dois servidores, sem duplicata:** `Survival` (id 3, backend) e `AusTv` (id 4, proxy), ambos em
  **`5.8 build 3605`**. Builds idênticas — o `5.6 b2959 vs b2965` do plano de sprints está
  desatualizado. A unificação de 20/08 ficou limpa.
- **O webserver do Plan é do proxy:** `plan_servers.web_address` do AusTv é
  `http://198.89.99.70:25504`. O Survival tem `web_address` NULL, o que explica a 25505 não
  responder de fora. É a arquitetura certa, não um defeito.

### ⚠️ Armadilha de método registrada em 2026-08-23

Olhando `serverOverview?server=AusTv` retornando zero em tudo, foi levantada a hipótese de
**incidente ativo** — proxy sem coletar. **Estava errado.**

Proxy grava **usuário**, backend grava **sessão** (§2 do spec). Toda métrica derivada de sessão é
estruturalmente zero num proxy. O que desfez a hipótese foi uma query de controle
(`?server=NomeInventado` → `403`, provando que `AusTv` é válido) somada a `plan_users`, que mostrou
registro de minutos atrás.

Duas tabelas erradas foram consultadas antes da certa: `plan_sessions` e `plan_user_info`, ambas
incapazes de responder a pergunta. **A §6.1 já nomeava a tabela certa o tempo todo:
`plan_users.registered`.**

É a mesma raiz dos erros 1–4 no topo deste documento: série derivada de plugin mede o
comportamento daquele plugin, não a realidade. `PlanServersConfig.backends()` existe para que esse
erro específico não seja repetido em código.

### Restrição nova para o baseline da campanha

`plan_users` tem **5566** linhas; `plan_user_info` do Survival tem **5540**. O que exatamente
não veio na unificação — identidade, sessão, ou parte de cada — **não está estabelecido**;
as duas contagens acima não distinguem essas leituras. Ver o bloco abaixo.

> #### ✅ RESOLVIDO em 2026-08-31: a rede não está neste banco — o `plan_users` é o Survival
>
> Esta seção afirmava, como fato, que a métrica de rede só existia **desde 2026-08-20**, e
> disso saíram o adiamento da S8.2, a data de 2026-09-19 e metade do DoD da S8. Uma versão
> anterior desta nota tentou refutar isso pela contagem de linhas do `/v1/retention`, o que
> era inferir sobre uma fonte a partir de evidência sobre outra.
>
> **Agora está medido, na coluna certa.** `curl` autenticado em `/api/funnel/monthly`, cujo
> `coversFrom` é a resposta de `SELECT MIN(registered) FROM plan_users`:
>
> ```
> "coversFrom":"2024-06-02"
> ```
>
> **26 meses. A afirmação de "3 dias" era falsa.**
>
> #### E a mesma leitura abriu um problema maior
>
> Os buckets mensais de `rede` que a mesma resposta traz, ao lado da tabela de números
> verificados acima:
>
> | mês | `rede` no funil | `rede` na tabela | `survival` na tabela |
> |---|---|---|---|
> | 2025-11 | 687 | 1403 | 682 |
> | 2025-12 | 635 | 1259 | 641 |
> | 2026-01 | 727 | 1177 | 727 |
> | 2026-02 | 373 | 645 | 374 |
> | 2026-03 | 257 | 445 | 258 |
> | 2026-04 | 192 | 360 | 192 |
> | 2026-05 | 1 | 1 | 1 |
> | 2026-06 | 107 | *(Plan morto)* | 106 |
>
> **O degrau chamado `rede` bate com a coluna `survival`, não com a coluna `rede`.** Oito
> meses, diferença de 0 a 6 contra `survival` e cerca de metade de `rede`. E não é filtro:
> `networkArrivalsBetween` é `SELECT uuid, registered FROM plan_users WHERE registered
> BETWEEN ? AND ?`, sem servidor e sem plataforma.
>
> #### ✅ Resolvido no mesmo dia: o `plan_users` guarda o **Survival**, não a rede
>
> Três consultas, três fatos que apontam para o mesmo lugar.
>
> **1. O proxy não tem uma linha sequer.**
>
> ```
> total_plan_users   5638
> vistos_em_backend  5575
> vistos_no_proxy       0
> ```
>
> **2. Só um servidor aparece em `plan_user_info`:** `Survival` (`is_proxy = 0`), com 5575
> jogadores. O `AusTv` (`is_proxy = 1`) está no catálogo de `plan_servers`, com
> `plan_version 5.8 build 3605` como o Survival, e **zero** jogadores associados.
>
> **3. E o fecho: as contagens mensais de `plan_users` são a coluna `survival` desta
> tabela, exatamente.** Não "parecidas" — idênticas, nos oito meses:
>
> | mês | `plan_users` (SQL) | coluna `survival` | coluna `rede` |
> |---|---|---|---|
> | 2025-11 | 682 | **682** | 1403 |
> | 2025-12 | 641 | **641** | 1259 |
> | 2026-01 | 727 | **727** | 1177 |
> | 2026-02 | 374 | **374** | 645 |
> | 2026-03 | 258 | **258** | 445 |
> | 2026-04 | 192 | **192** | 360 |
> | 2026-05 | 1 | **1** | 1 |
> | 2026-06 | 106 | **106** | *(Plan morto)* |
>
> A série vai de **2024-06** (286 chegadas) a 2026-06, com o vale de 1 em 2026-05 que a
> tabela já registrava como manutenção.
>
> As diferenças de 1 a 6 entre isto e os buckets do funil são fuso: o funil agrupa em
> `America/Sao_Paulo` e o SQL na sessão do MySQL, então quem registrou perto da virada do
> mês cai de um lado ou do outro. É o comportamento correto, e confirma que o funil lê
> exatamente esta tabela e nada mais.
>
> #### O que isso quebra — ✅ os dois primeiros corrigidos em 2026-08-31
>
> **1. ~~O degrau `rede` do funil não mede rede.~~ Corrigido.** Media o Survival, com outro
> nome. O degrau `rede` passou a sair `null` com o motivo por escrito, e **a mesma contagem
> passou a alimentar o degrau `survival`** — que até então saía `null` por falta de fonte. Os
> dois trocaram de lugar; nenhuma contagem mudou. A conversão `rede → survival`, que era
> Survival ÷ Survival, agora sai `null` com motivo em vez de perto de 100%.
>
> A ressalva viaja no payload (`sources[].provenance`), não só em docblock: a tabela é
> `plan_users`, e a identidade Survival dela é **coincidência medida, não garantia de schema**.
> Se o proxy algum dia registrar nela, a série volta a ser de rede e o rótulo `survival`
> passaria a **superestimar** — em silêncio. É o custo assumido de publicar os 26 meses em vez
> de descartá-los, e é a mesma escolha já feita para as coortes da S8.2.
>
> A ponte `rede → tutorial_entrou` saiu junto: ela existia para pular por cima de um `survival`
> sem fonte, e `survival` agora é adjacente a `tutorial_entrou`.
>
> **2. ~~O check `funnel.network_to_survival` está estruturalmente cego.~~ Corrigido — no
> sentido de parar de mentir, não de voltar a medir.** Ele dividia os novatos do Survival (via
> `/v1/serverOverview`) pelas chegadas de `plan_users`, a mesma população; numerador e
> denominador se moviam juntos, então o `ok` que reportava era propriedade da aritmética e não
> medição. Passou a devolver **`no_data` por backend, todo ciclo, com o motivo por escrito** —
> sem tocar no banco e sem chamar o Plan, porque não há o que perguntar.
>
> `no_data` e não `error` pela regra da §6.1 (*de quem* é o vazio): nada falhou, falta fonte
> para o denominador — a mesma categoria de `PLAN_SERVERS` em branco. E **não** foi aposentado:
> tirá-lo do registro deixaria as linhas antigas envelhecerem em `staleChecks` e fixaria o
> resumo em `down` para sempre.
>
> **O que isso custa, dito sem maquiagem:** os ~54% deixaram de ser vigiados. Não é rebaixamento
> de um sinal — é o reconhecimento de que nunca houve sinal. Restaurar exige contagem de
> chegadas **no proxy**, que nem a API nem o banco autorizado hoje têm.
>
> **3b. Um terceiro rótulo herda o mesmo erro, e continua em aberto.**
> `plan.proxy_registration_alive` lê `plan_users` e por isso **não vigia o proxy**: no apagão de
> maio a agosto/2026 que lhe deu origem, a tabela acima mostra o proxy morto e o Survival
> registrando 106 jogadores em jun/2026 — o silêncio teria ficado em zero hora. O que ele vigia
> é real (registro parando no Survival), então continua rodando, e os sumários passaram a dizer
> Survival e a dizer que não cobrem o proxy. **O identificador não foi renomeado:** a string é
> persistida e é a chave do histórico do check, e renomear partiria a série e zeraria a memória
> da política de alerta. Renomear ou não é decisão do dono.
>
> O `platform.offline_account_share` foi auditado no mesmo dia e **está correto** — consulta
> `/v1/playersTable?server=<backend>`, escopado por servidor, e já diz o servidor no `context`.
>
> **3. Os ~54% rede→survival do DoD da S8 não saem desta base.** Não por falta de
> profundidade — isso foi medido e é falso, são 26 meses — mas porque **a população da
> rede não está neste banco**. Está no antigo, que é de onde a coluna `rede` desta tabela
> veio. Isso agora é medição, não suposição.
>
> **3c. E um ganho que ninguém esperava desta correção.** A segunda metade do DoD da S8 —
> *"~100% de entrada no tutorial antes de dez/2025"* — é `tutorial ÷ survival`, não
> `tutorial ÷ rede`. Com `plan_users` alimentando o degrau `survival`, esse é agora um **par
> consecutivo** publicado pelo endpoint: nov/2025 dá `694 / 682 = 101,8%`. Estava marcado como
> bloqueado por um payload que ninguém observou, e o bloqueio não existia. **Calculável;
> ainda não rodado contra produção** — é o mesmo passo em aberto da S6.2b e da S6.3.
>
> **4. A S8.2 continua viável, com o rótulo corrigido.** O `/v1/retention` serve a mesma
> população, então as coortes que ela vai calcular são **coortes de jogadores do
> Survival**, não da rede. Continua sendo retenção de verdade e continua derrubando a
> premissa da exceção 1 — mas o rótulo tem de dizer Survival, pela mesma razão que
> `lastSeenDate` tem de dizer intervalo de sobrevivência.
>
> #### A afirmação original estava certa, e mal escrita
>
> "Métrica de rede tem 3 dias de profundidade" apontava para um problema real — a rede não
> está aqui — e o descreveu como profundidade, que é a única parte falsa. Quem leu
> "profundidade" foi checar profundidade, achou 26 meses e concluiu que estava tudo bem.
> Duas revisões deste documento erraram por isso, uma para cada lado.
>
> O que faltava não era mais rigor na verificação: era a frase dizer **qual** era o
> problema. "Falta a população do proxy" teria sido checável em uma consulta desde o
> primeiro dia.

---

## ✅ Validação contra produção em 2026-09-01 — o que ela confirmou, e o que ela **não** pôde tocar

Quatro endpoints do Plan de produção (`198.89.99.70:25504`), lidos direto, sem autenticação
(`authRequired: false` segue valendo). É a **segunda fonte independente** que a lição de método
deste documento exige: a medição de 2026-08-31 foi feita por SQL em `plan_user_info`; esta foi
feita pela API HTTP, que é outro caminho para a mesma pergunta.

### ✅ A premissa central do PR #180 está confirmada

| consulta | resultado |
|---|---|
| `/v1/playersTable?server=AusTv` (proxy) | **`players: 0`** |
| `/v1/playersTable?server=Survival` | `players: 2500` — número redondo, quase certamente o teto do endpoint, **não** uma contagem; o SQL de 31/08 deu 5575 |
| `/v1/graph?type=uniqueAndNew&server=AusTv` | `uniquePlayers: []`, `newPlayers: []` |
| `/v1/graph?type=uniqueAndNew&server=Survival` | `newPlayers`: lista de **181** pontos |
| `/v1/networkMetadata` | dois servidores: `AusTv` (`proxy: true`), `Survival` (`proxy: false`) — e **sem `plan_version`**, confirmando que a exceção 2 fica de pé para o `version_divergence` |
| `/v1/serverOverview?server=Survival` | `last_7_days.new_players: 28` |

**O proxy não tem jogador nenhum nesta instalação do Plan, por duas fontes independentes.** É a
base de tudo que o PR #180 decidiu, e agora está cruzada.

### ✅ O caminho de volta ficou mais estreito, e isso é resultado

O `network_to_survival` só volta a medir com uma contagem de chegadas **no proxy**. Os três
candidatos nomeados eram o banco antigo, o `/v1/networkMetadata` e o `/v1/playersTable`. **Os dois
últimos foram lidos e não têm essa população.** Sobra o banco antigo — que passa a ser o único
candidato, não mais "um dos três".

### ⚠️ Um fato registrado em 2026-08-23 derivou, e a forma nova é a pior

Estava escrito que `serverOverview` do proxy vem com **`numbers: {}`**. Hoje vem com **14 campos**,
com todo o que é derivado de sessão em **zero** — `sessions: 0`, `total_players: 0`, `playtime: 0`,
`player_kills: 0` — ao lado dos que são nativos do proxy e são reais (`online_players: 19`,
`best_peak_players: "37"`, `current_uptime`). E `last_7_days.new_players` do proxy é **`0`**.

A substância segue: métrica de sessão é estruturalmente vazia num proxy. **A forma piorou.** Campo
ausente é obviamente ausente; `0` é um número, e este épico existe porque lacuna de coleta lida
como zero ficou invisível por meses. Hoje **nada consome isso** — todo check itera
`PlanServersConfig.backends()`, que exclui o proxy, e essa classe existe exatamente para isso —,
mas `serverOverview?server=<proxy>` é uma fonte viva de zeros plausíveis.

### ⚠️ E o bloqueio do `/v1/graph` caiu: o payload **foi observado**

O spec, o plano de sprints e o código diziam que *"ninguém observou o payload de
`/v1/graph?type=uniqueAndNew`"*, e isso sustentava a alegação de que o degrau `survival` não tinha
série diária. Foi observado agora: `{timestamp, timestamp_f, uniquePlayers, newPlayers, colors}`,
com `newPlayers` em 181 pontos para o Survival. Não muda o que o funil publica — desde 2026-08-31 o
degrau `survival` sai de `plan_users` —, mas **o bloqueio citado deixou de existir** e não deve
seguir sendo repetido como se existisse.

### ❌ O que esta validação NÃO conseguiu tocar, e é a maior parte

**As cinco commits do PR #180 não estão em produção.** O `origin/main` está em `dc4dfaa`, anterior a
todas elas. A API admin implantada roda o código **antigo**, então:

- `/api/funnel/monthly` de produção ainda publica o degrau `rede` com números (o defeito), e
  `survival: null`. Consultá-la valida o bug, não a correção;
- o par `survival → tutorial_entrou` de nov/2025 — os **`694 / 682 = 101,8%`** — **não existe** no
  código implantado. Segue calculável e **não calculado**;
- `blindSpots`, a flag `blindSpot` e o `pontos_cegos=` no log de ciclo não existem em produção;
- o caminho **`error`** do critério 4 da S6.3 — derrubar uma fonte de propósito — continua sem teste.

**Validar o comportamento novo exige implantar a branch**, o que é outra ação e depende de merge.
Enquanto isso não acontece, o estado honesto é: **premissas confirmadas contra produção,
comportamento não.**

---

## ✅ Comportamento validado em produção em 2026-09-01 — e a validação derrubou uma alegação

`backend-v0.15.2` implantado na VPS (release publicado 03:34, `Deploy to VPS: success`). É a
primeira vez que o épico fecha o ciclo que a auditoria de 2026-08-27 cobrava: entregar **e** tocar
o ambiente real.

### ✅ O defeito central está corrigido, medido

`GET /api/funnel/monthly?from=2025-11-01&to=2025-11-30`, produção:

| verificação | resultado |
|---|---|
| degrau `rede` | **`value: null`** com o motivo nomeando `plan_users` e o proxy |
| conversão `rede → survival` | **`percent: null, n: null`** — não mais ~100% |
| degrau `survival` | **`687`** — a série preservada, agora sob o rótulo certo |
| `sources[].coversFrom` | **`2024-06-02`** — os 26 meses, confirmados ao vivo |
| `sources[].provenance` | presente, com a ressalva de coincidência medida |

Os 687 batem com o bucket que o `HANDOFF` já registrava para 2025-11 (687 no funil contra 682 no
SQL — a diferença é fuso, como documentado).

`GET /api/health/instrumentation`, produção:

```json
{"status":"down","total":7,"counts":{"ok":5,"breached":0,"no_data":0,"error":1},
 "failing":["funnel.tutorial_entry_rate:Survival"],
 "blindSpots":["funnel.network_to_survival:Survival"]}
```

- `blindSpots` publica o ponto cego ✅
- ele **não** está em `failing` ✅
- **`counts.no_data: 0`** — fora do agregado ✅
- `total: 7` — continua contado ✅
- e a prova que mais importava: **`status: "down"` por um `error` de OUTRO check**. A exclusão não
  deixou o resumo surdo. Em produção, com o ponto cego presente, um problema real ainda move o
  agregado — que é a propriedade que o teste unitário fixou e que agora está observada.

### 🔴 A validação derrubou a alegação dos ~100% de entrada no tutorial

O PR #180 afirmou que a segunda metade do DoD da S8 (*"~100% antes de dez/2025"*) tinha destravado
e era **calculável**, faltando só rodar. Rodou. **Não é calculável em produção**, e o motivo não é
o que estava escrito:

```
"tutorial_entrou": {"value": null, "unavailableReason": "sem fonte para este degrau no periodo"}
"sources": [..., {"name":"tutorial_daily","ok":false,"failure":"never_synced"}]
```

`tutorial_daily` **nunca sincronizou**. Os logs do container dizem por quê, no boot:

> `TUTORIAL_PLAYERDATA_DIR/TUTORIAL_QUESTS_DIR nao configurados — o funil do tutorial fica sem
> fonte` · `TUTORIAL_SYNC_ENABLED nao esta ligado — o funil do tutorial NAO vai ser reconstruido`

**O ETL da S8.0 não está configurado em produção.** Consequências, que valem mais que a linha de
DoD:

1. **Dois dos quatro degraus do funil nunca produziram dado em produção.** `tutorial_entrou` e
   `tutorial_concluiu` saem `null` desde sempre, não desde este PR.
2. O `funnel.tutorial_entry_rate` está em **`error`** — corretamente, e é ele que põe o agregado em
   `down`. O check se comporta como projetado; o que falta é a fonte.
3. O bloqueio dos `694/682 = 101,8%` **mudou de natureza**: não é mais "payload nunca observado"
   (isso caiu em 2026-09-01), é **configuração de ambiente ausente**. Duas variáveis no `.env` da
   VPS separam o número de existir.
4. A contabilidade da S8.0 como "entregue" merece a mesma ressalva que a S6.2b e a S6.3 levaram: o
   código existe, o ETL nunca rodou onde importa.

**Este é o padrão que a auditoria de 2026-08-27 nomeou**, aparecendo pela terceira vez — o passo
que sobra é sempre o que exige tocar o ambiente real. A diferença é que desta vez ele foi tocado, e
por isso a lacuna apareceu em vez de continuar suposta.

### ✅ O terceiro item fechou: o ciclo real de 03:50:24

O `HealthCheckScheduler` agenda a primeira execução um intervalo após o boot, e o container subiu
03:35:24. O primeiro ciclo sob o código novo saiu **03:50:24**, no minuto previsto:

```
WARN [HealthCheckRunner] Ciclo de saude: 7 observacao(oes) em 138ms · ok=5 · breached=0
· no_data=1 · error=1 · anunciados=0 · entregues=0 · recuperacoes_seguradas=0
· segurados_por_orcamento=0 · pontos_cegos=1 · oscilando=0
```

Três coisas confirmadas de uma vez, e a segunda é a que mais importa:

1. **`no_data=1`** — o `funnel.network_to_survival` emite `no_data` em produção. A mudança de
   comportamento da S6.3 está viva.
2. **`anunciados=0` · `entregues=0` com `pontos_cegos=1`** — o veredito foi suprimido pelo ramo
   `accepted_blind_spot`, **não** por acaso. É a correção do achado da 2ª rodada de review: um
   `no_data` permanente com alerta aberto no canal re-anunciaria uma vez por dia, para sempre. Aqui
   ele não anunciou, e o contador diz por qual caminho.
3. **`pontos_cegos=1`** — o campo `blindSpotHeld` aparece no log de um ciclo real, que era o outro
   achado da 2ª rodada (o motivo existia mas não era contável em lugar nenhum).

Nota de leitura sobre o `error=1` com `anunciados=0`: o `funnel.tutorial_entry_rate` já está em
`error` de ciclos anteriores, então o canal segura o problema aberto e a política agrupa até vencer
o `reAlertAfterMs` (24h). É `grouped`, não silêncio — comportamento correto.

E a linha sai como **WARN** porque `breached + error > 0`, como o `log()` define.

O que este ciclo **não** prova, e está dito para não virar alegação: a passagem de `breached`/`error`
de um ponto cego (correção da 3ª rodada) não é observável aqui, porque este check só emite
`no_data`. Essa metade continua fixada só em teste.

> Observação sem baseline: o ciclo levou **138ms** para 7 observações, e o `network_to_survival`
> deixou de fazer uma consulta MySQL e uma chamada HTTP por backend. Os dois fatos são
> consistentes, mas ninguém mediu o tempo do ciclo antes, então isto **não** é medição de ganho.

---

## ✅ A lista autoritativa de endpoints do Plan foi encontrada (2026-08-26)

O `/docs` do webserver — `http://198.89.99.70:25504/docs` — serve um **OpenAPI 3.0.1 completo**.
Este documento dizia até hoje que ninguém o havia consultado; foi consultado, e o resultado desmente
duas coisas que estavam registradas aqui como fato.

### ❌ Erro 5 — "o Plan não expõe lista de servidores"

**Falso.** Existe `GET /v1/networkMetadata` — *"Get metadata about the network such as list of
servers"*.

A investigação de 2026-08-23 tentou `/v1/servers` e `/v1/networkOverview`, levou 404 nos dois, e
concluiu que o endpoint não existia. Os dois nomes estavam errados. A conclusão virou a
**justificativa da exceção 2 do ADR-002** — a que autorizou ler `plan_servers` por SQL direto — e
essa justificativa agora está sem apoio.

É a mesma causa raiz dos erros 1 a 4: **concluir ausência a partir de uma busca que não achou**, em
vez de consultar a fonte que enumera. O custo desta vez foi uma exceção a um ADR, aberta com o
argumento de que não havia alternativa.

> **Corpo lido em 2026-08-29:** o `networkMetadata` enumera as instâncias e **não** traz o
> `plan_version`. O check `plan.version_divergence` precisa dele, então a exceção 2 fica de
> pé por essa metade, com justificativa reescrita. Detalhe no bloco "Os dois corpos foram
> lidos", abaixo.

### O que mais a lista revelou

| endpoint | por que importa |
|---|---|
| `GET /v1/retention` | **Lido em 2026-08-29.** Devolve 5565 linhas com `playerUUID`, `registerDate`, `lastSeenDate`, `playtime` e `timeDifference`. Derruba a premissa da **exceção 1** do ADR-002 — a agregação por coorte × plataforma sai daí, sem SQL. Ver o bloco "Os dois corpos foram lidos" |
| `GET /v1/query` + `GET /v1/filters` | API de consulta com filtros e janela (`afterEpochMs`/`beforeEpochMs`, lista de servidores). Candidato para o degrau **rede → survival** da S8.1. Não cobre `tutorial_entrou` nem `tutorial_concluiu`, e isso não é leitura de documento: o Plan
**não coleta nada de tutorial** (bloco anterior deste arquivo), então nenhum endpoint dele poderia
cobrir. Seguem bloqueados pela S8.0 — e não se sabe se resolve o denominador de rede (§2 do spec: proxy grava usuário, não sessão). Verificar o corpo antes de estimar |
| `GET /v1/joinAddresses` | endereço de conexão usado pelo jogador. **Proxy possível** de canal de aquisição — só vale como canal se canais diferentes anunciarem hostnames diferentes. Rotular como proxy onde aparecer, pela mesma regra do critério 6 da S8.0 |
| `GET /v1/playersTable` | já conhecido, mas o schema documenta `registered` por jogador — é a outra metade da exceção 2 (`plan_users.registered`) |

## ✅ Os dois corpos foram lidos (2026-08-29)

O gatilho de reavaliação que o spec registrava para a exceção 2 era literalmente "ler o corpo
de `/v1/networkMetadata`". Foi lido, junto com o do `/v1/retention`. Os dois resultados puxam
em direções opostas, e é por isso que valem um bloco.

### `/v1/networkMetadata` — lista os servidores, **não** traz `plan_version`

O corpo enumera as instâncias da rede. Ele **não** carrega a versão do Plan por instância.

Isso parte a exceção 2 em duas metades com destinos diferentes:

- **`plan.orphan_instance`** reconcilia duas *listas* (`plan_servers` × `PLAN_SERVERS`). O
  endpoint serve essa lista. Esta metade **pode** sair do SQL.
- **`plan.version_divergence`** precisa da versão por instância, e o endpoint não a tem.
  Nenhum outro endpoint do OpenAPI a expõe. Esta metade **fica**.

Ou seja: a exceção 2 continua de pé, e a justificativa escrita dela morreu. São coisas
diferentes e o spec agora diz as duas.

> **Migrar o `orphan_instance` não é decisão tomada, e este documento tem o contra-argumento
> mais abaixo.** Sob 403 na API, os três checks que leem o `PlanDatabase` continuam
> respondendo *pela topologia do código*; tirar um deles do SQL trocaria dívida de
> acoplamento por perda de cobertura no cenário que hoje é plausível. Nada nos dois corpos
> lidos toca nesse argumento — ele não foi respondido, e continua de pé.
>
> O gatilho original pedia duas coisas: `plan_version` **e recência por instância**. Só a
> primeira foi verificada. A segunda importa porque o check construído reconcilia listas e
> não olha recência (§ do spec sobre a exceção 2), então um endpoint sem recência não
> substitui o que a redação da §6.1 pede, só o que o código faz hoje.

E enquanto as duas metades compartilharem o `PlanDatabase`, a credencial de MySQL continua
existindo, que é o custo que o ADR-002 queria evitar — migrar só o `orphan_instance` não a
remove.

### `/v1/retention` — derruba a premissa da exceção 1

5565 linhas, uma por jogador, com `playerUUID`, `registerDate`, `lastSeenDate`, `playtime` e
`timeDifference`. A exceção 1 foi aberta com o argumento de que *"agregação por coorte ×
plataforma não existe em nenhum endpoint"*. Com `registerDate` a coorte é derivável, e com
`playerUUID` a plataforma é derivável pelo ADR-003 — os dois eixos que a §6.2 pede, sem uma
linha de SQL.

> **A ressalva importa mais que a manchete, e ela é sobre o que a métrica significa.**
> `lastSeenDate` dá o **intervalo de sobrevivência** de um jogador, não se ele voltou no dia
> N. "Ainda ativo 30 dias depois de registrar" e "voltou no dia 30" são números diferentes.
> A §6.2 escreve *"retém D1/D7/D30 → por plataforma"* e **não define qual das duas leituras
> é**; "D30" na literatura costuma ser a segunda, e é assim que este documento vinha usando
> o termo. O endpoint entrega a primeira. Que a §6.2 "peça" a segunda é leitura, não citação,
> e está marcada como tal aqui de propósito.
>
> Isso não reabre a exceção: entregar a retenção por intervalo, rotulada como tal, é melhor
> que abrir acesso direto a três tabelas para entregar a outra. Mas o rótulo é obrigatório, e
> a S8.2 tem de publicá-lo junto do número. Chamar um de outro seria o mesmo erro de
> denominador que já custou uma linha do DoD da S8.

**Duas armadilhas nos dados, encontradas ao montar as coortes e que a S8.2 precisa tratar:**

1. **Coortes até 2025-08 dão D1/D7/D30 de 100%.** Não é retenção perfeita: quem foi
   importado na unificação carrega `lastSeenDate` posterior por construção.

   A S8.2 tem de emitir `null` **com o motivo** para essas coortes, nunca o 100% e nunca
   silêncio. "Não publicar" seria a única disposição que o critério 2 da própria história
   (*"marcadas, não escondidas"*) e a regra do projeto proíbem juntas.

   **A fronteira de 2025-08 é ajuste empírico, não mecanismo, e isso é um problema em
   aberto.** Se a contaminação vem da unificação de 2026-08-20, ela deveria atingir toda
   coorte, não parar em 2025-09. Entregar a data como se fosse regra dá ao implementador um
   número mágico sem critério de detecção. **A S8.2 precisa de um teste sobre o dado** —
   por exemplo, `lastSeenDate` idêntico ou colado à data da unificação — e não de um corte
   por mês.

   E a corroboração citada não vale como está: os 30,1 / 21,7 / 15,4 conhecidos foram
   apurados sobre uma base de **11.525**, registrada neste documento como *base enviesada*.
   Bater com ela não valida um cálculo sobre 5.565 linhas.
2. **A coorte do mês corrente é imatura.** 2026-08 dá D30 = 0,0% porque ninguém registrado
   neste mês teve 30 dias para voltar. Isso é *sem dados*, e sai `null`, nunca zero — é a
   regra dura do projeto aplicada ao caso mais fácil de errar.

> **✅ Medido em produção em 2026-09-02 — a armadilha 1 é real, e maior do que este documento
> descrevia.**
>
> A primeira leitura de `2024-06..2025-08` (a região que a janela padrão de 12 meses nunca
> alcançava, motivo pelo qual a leitura anterior **não** havia exercitado o detector) devolveu
> **45 coortes**, com `rows: 5580, parsed: 5580, dropped: 0`.
>
> O detector de carimbo achou **zero dias** — `stampDays: []` — e o artefato está lá assim
> mesmo: das 45 coortes, **21 saíram suprimidas** por `implausible_survival`, e das 24 que
> publicaram, **23 publicaram 100% em D1, D7 e D30 ao mesmo tempo**.
>
> **O que separava os dois grupos não era o dado.** Toda coorte suprimida tinha **20 ou mais**
> jogadores; toda coorte publicada tinha **19 ou menos**. A maior publicada tem 19, a menor
> suprimida tem 20 — a divisão cai exatamente em cima de `IMPLAUSIBLE_MIN_COHORT`. O piso de
> tamanho decidiu **todos os 45 casos sozinho**; nada sobre os dados decidiu nenhum.
>
> Isso confirma a armadilha 1 e corrige o diagnóstico dela: a fronteira de 2025-08 não era um
> ajuste empírico *errado* — a contaminação existe e cobre a faixa inteira —, mas o mecanismo
> que a pega **não é o carimbo por dia**. É a forma do resultado, e o teste que lê a forma
> estava cego por tamanho.
>
> **Corrigido:** o veredito passou a ser herdado por vizinhança (`contaminated_span`). Uma
> coorte pequena demais para ser julgada sozinha é suprimida quando (a) mostra a mesma forma
> de ~100% em todos os horizontes **e** (b) registra dentro de uma **corrida** de meses
> contaminados. Os meses *sem* evidência dentro da corrida entram — em produção, 2024-09 a
> 2025-01 são cinco meses seguidos sem uma única coorte de 20, quinze coortes, todas a 100%.
> Lacuna significa "ninguém aqui era grande o bastante para testar", não "este mês está limpo".
>
> **A corrida é crescida, não é o intervalo entre os extremos** — e essa distinção veio do
> review, porque a primeira versão *era* `[min, max]`. Ela invocava continuidade como
> justificativa e não testava continuidade em lugar nenhum: duas importações com um ano de
> distância viravam uma faixa de um ano, e uma coorte a onze meses da evidência mais próxima
> em qualquer direção era suprimida por ela. É o mesmo defeito que o teto de dois dias do
> detector de carimbo existe para evitar, um nível acima. Duas paredes param uma corrida:
>
> - **um mês limpo** — aquele cujas coortes julgáveis *passaram* e que não tem coorte
>   reprovada própria. Uma coorte saudável de 200 pessoas é evidência **contra** uma escrita
>   cobrindo aquele mês, e a inferência não atravessa isso;
> - **uma lacuna maior que seis meses** sem evidência. Seis é escolha, não mecanismo, e está
>   marcada como tal no código: a produção precisa de cinco, e seis é o menor número redondo
>   que cobre o único caso já observado com um mês de folga.
>
> Só o requisito de **tamanho** é relaxado: uma coorte com curva real dentro da corrida
> continua publicando. E a inferência é rotulada como inferência — motivo próprio, separado do
> `implausible_survival` que julga por evidência direta —, com as corridas publicadas em
> `contaminatedSpans` para poderem ser conferidas. A detecção roda sobre o **payload inteiro**
> e a janela é aplicada depois: pedir só `2024-09..2025-01` não pode fazer a evidência sumir.
>
> **Erro de método registrado, do mesmo review:** a string de motivo entregue ao leitor dizia
> que *"TODAS"* as coortes julgáveis do intervalo tinham sido reprovadas — e o código nunca
> olhava as que passaram. Em produção não é verdade: `2025-08 / java_offline` é julgável, tem
> 30 jogadores e **passa** (D30 96,7%), dentro de um mês confirmado pelas outras duas
> plataformas. O texto agora diz "21 de 22" porque a base passou a ser contada. Afirmar
> completude que ninguém mediu é a mesma família de erro que publicar percentual sem `n`, só
> que na prosa em vez de no número — e prosa também viaja no corpo HTTP e no Discord.
>
> A leitura de produção inteira está fixada em teste
> (`retention-production-shape.spec.ts`): as 45 coortes com os tamanhos verbatim, uma corrida
> só, 21 de 22 julgáveis reprovadas, 23 coortes (327 jogadores) suprimidas por herança, e
> `2025-08 / java_offline` como a única que ainda publica.
>
> **O buraco que fica de propósito:** uma coorte pequena a 100% **fora** de qualquer intervalo
> provado continua publicando. Onze jogadores que ficam não provam nada sozinhos, que é a
> razão de o piso existir. O que a correção remove é julgar em isolamento aquilo que é uma
> propriedade de uma *escrita* em massa.
>
> **✅ Achado secundário da mesma leitura, fechado em 2026-09-02 por decisão do dono
> ("marcar por medida").** `belowMinimum` olhava o tamanho da **coorte** e não a base do
> **horizonte**. A coorte `2026-08 / bedrock` tem 43 jogadores (acima do mínimo de 30, logo
> `belowMinimum: false`) e publicava `D30: 0%` sobre `n: 5`, sem nenhuma marca de amostra
> pequena — um colapso aparente que um único jogador move vinte pontos.
>
> A marca passou a existir **por medida**, calculada contra a base daquele horizonte. A de
> coorte continua, porque responde outra pergunta ("vale olhar para esta coorte?"), e as duas
> estão documentadas uma pela outra. As bases de uma mesma coorte divergem por construção — a
> maturidade é filtrada por jogador —, então uma marca só ao lado de três percentuais estaria
> errada para dois deles, exatamente como um `n` só estaria. Este projeto já recusou o `n`
> único por esse motivo; a marca seguiu a mesma regra.
>
> Escolhido **marcar** e não suprimir: amostra pequena suprimida é invisível, e *marcar, nunca
> esconder* é o critério 2 da própria história. No relatório semanal a marca fica ao lado do
> horizonte (`D30 0,0% (n=5 ⚠️)`), não na linha da coorte, porque é ali que ela é verdadeira.
>
> **Por que nenhum teste pegava isto — e a primeira resposta que dei estava errada.** Eu
> escrevi que *"nenhuma fixture tinha bases divergentes por horizonte"*. É falso, e o
> contraexemplo estava no mesmo arquivo desde antes: o teste
> `'shrinks the base as the horizon grows, within one cohort'` constrói uma coorte com D1 sobre
> 20 e D30 sobre 10. Divergência de bases já era coberta.
>
> A propriedade que de fato faltava é mais estreita: **nenhuma fixture tinha uma coorte no ou
> acima do mínimo cuja base de horizonte caísse abaixo dele.** Naquele teste a coorte tem 20
> contra um mínimo de 30, então `cohort.belowMinimum` já saía `true` — o piso de coorte
> mascarava a lacuna em vez de a lacuna não existir. Precisa das duas condições ao mesmo tempo,
> e nenhuma fixture as tinha.
>
> A lição prática é o oposto da que eu tinha escrito: não faltava um eixo de variação nas
> fixtures, faltava a **combinação** em que a marca existente cobre o caso por acidente. Quem
> lesse a versão errada concluiria que bastava adicionar fixtures de bases divergentes — que já
> estavam lá.
>
> E o erro em si é o padrão que este documento existe para registrar: afirmei uma causa para
> uma lacuna de teste **sem ler a suíte**, num documento cujo propósito declarado é guardar os
> erros de método. Pego pelo review, não por mim.
>
> **Anomalia que vale investigação, não correção:** em 2026-07 o `java_offline` dá D30 = 38,4%
> (n=151) contra 1,6% (n=62) do bedrock. Vinte e quatro vezes a retenção do bedrock é
> consistente com a suspeita já registrada aqui de que parte do tráfego `java_offline` seja
> bot.

### `serverOverview` e `onlineOverview` não estão no documento

Nenhum dos dois aparece no OpenAPI. **Funcionavam** em 23/08 e 25/08 — os payloads são reais —, mas
não estão documentados.

Ausência de um documento é evidência **mais fraca** que uma declaração explícita, e pode ser lacuna
de documentação. O que se pode dizer é que ela **soma** ao aviso de deprecação que o console emitiu
em 25/08, e ambos apontam na mesma direção. Note também que aquele aviso nomeou apenas o
`serverOverview`; o `onlineOverview` nunca foi marcado como deprecado por nada — os dois estão sendo
tratados juntos com base numa única observação negativa compartilhada.

A dívida não é só da S7.2. Além do módulo `metrics`, o `collection-alive.check` e o
`network-to-survival.check` da **S6.3** também chamam `/v1/serverOverview`. É superfície não
documentada sustentando parte da camada de saúde, e agora é dívida conhecida em vez de suposição.

### O `type` do `/v1/datapoint` **não é enumerado nem no documento autoritativo**

```json
"name": "type", "schema": { "type": "string" }, "example": { "value": "PLAYTIME" }
```

Um `string` livre com um exemplo. **A pergunta que ficou aberta na S7.2 não tem resposta no `/docs`**
— a única enumeração conhecida continua sendo a do changelog, que este documento já registra como
incompleta para listas.

**O que mudou é mais estreito do que parece:** a resposta **não está no `/docs`** — não que ela não
exista. O Plan é open source (LGPL-3.0), e o enum de `type` quase certamente é legível no código
fonte em minutos. Ninguém leu.

A decisão de não migrar segue de pé, mas pelo motivo correto: os `type` válidos continuam
desconhecidos, e descobri-los é trabalho que ninguém fez — não trabalho impossível.

### Autenticação é chave de configuração, e `/v1/whoami` é como se descobre

O `info.description` do spec: *"If authentication is enabled (see response of `/v1/whoami`) logging
in is required for endpoints (`/auth/login`). Pass 'Cookie' header in the requests after login."*

Ou seja, o `PLAN_API_TOKEN` do nosso client — hoje palpite defensivo, enviado como `Bearer` — está
no esquema errado. O Plan usa **cookie de sessão**, não bearer token. Se a autenticação for ligada,
o client da S6.3/S7.2 precisa de `/auth/login` + cookie, não do header que ele manda hoje.

### ⚠️ Superfície de escrita exposta — verificar antes da campanha

O documento lista endpoints que **modificam estado**:

| endpoint | o que faz |
|---|---|
| `POST /v1/saveGroupPermissions` | altera as permissões web de um grupo |
| `DELETE /v1/deleteGroup` | remove um grupo de permissão |
| `POST /v1/saveTheme` · `POST /v1/deleteTheme` | escreve e apaga tema |
| `POST /v1/storePreferences` | preferências do usuário — este declara `403` se não logado |
| `GET /v1/errors` | *"list of Plan error logs"* — conteúdo de arquivo de erro, com o que houver neles |

**Não sondei nenhum deles**, e não vou: são endpoints de escrita e de autenticação numa produção
com jogadores.

O que se **observou**: em 2026-08-26, mais cedo, `GET /v1/serverOverview?server=Survival` devolveu
dados a uma requisição **sem credencial nenhuma**, partindo de uma máquina residencial.

O que **não se sabe, e a diferença é o argumento inteiro**: se aquele IP estava na whitelist de
aplicação do Plan. A §10b do spec registra que essa whitelist **existe e cobre a 25504**, e ninguém
leu o conteúdo dela. A leitura ter funcionado é, se alguma coisa, indício de que o IP **estava**
permitido. E o 403 de horas depois tem "whitelist ajustada" entre as causas candidatas — o que
concede que uma whitelist governa este caminho.

Portanto: **se** aquele IP não estiver na whitelist — não verificado — então a superfície de
**leitura** está aberta a qualquer origem. Se a de **escrita** também está é pergunta separada e não
sondada, e o pior caso dela — qualquer um que alcance a 25504 alterando permissões web — depende das
duas hipóteses, não de uma.

Verificação, nesta ordem: **ler a whitelist no `config.yml` do Plan**, depois `/v1/whoami`. **Antes
do unban all**, que é quando o servidor ganha atenção.

### Conferência parcial no mesmo dia — a VPS está permitida, e só isso

`curl` da **VPS** para `/v1/whoami` devolve **200**; da máquina residencial, **403 em todos os
endpoints**.

**O que isso prova:** a VPS está permitida na 25504, ao menos naquele endpoint.

**O que isso NÃO prova, e a distinção é o argumento:** um 200 vindo de um IP permitido não diz nada
sobre *qualquer outro* IP estar bloqueado. A única evidência de que alguém é recusado é o 403 da
residencial — e esse 403 tem **quatro causas candidatas**, das quais só uma é whitelist restritiva.
Se for ban por volume ou autenticação recém-ligada, nenhuma whitelist restritiva foi demonstrada.

**Portanto a pergunta de segurança continua aberta.** A superfície de escrita nunca foi sondada — o
teste foi um GET num endpoint de leitura — e das três camadas do placar abaixo **só a autenticação
foi lida**. O bloco acima fica de pé, riscado em nada.

### 🔴 Medido em 2026-08-26: a autenticação do Plan está desligada

`/v1/whoami` da VPS devolve `{"authRequired":false,…}` — corpo truncado no terminal; **só este campo
foi lido**. Os demais, `loggedIn` inclusive, não foram vistos, e é justamente `loggedIn` que diria a
que principal um chamador sem credencial é resolvido com a auth off.

**O que isso estabelece, e onde para.** `authRequired` é chave global, então o gate de autenticação
não existe para **leitura** — observado duas vezes, da VPS e (mais cedo) da residencial.

Para **escrita**, estabelece apenas que *esse* gate está aberto. Nenhum endpoint de escrita foi
sondado, e a tabela de superfície de escrita logo acima traz evidência em contrário: o
`POST /v1/storePreferences` **declara `403` se não logado**, ou seja, ao menos um write tem gate
próprio, independente da chave global. O Plan resolve escrita por grupos de permissão web, e o que
um chamador anônimo herda com auth off é desconhecido.

**Portanto, o pior caso, rotulado como pior caso:** *se* os endpoints de escrita não tiverem gate
próprio, quem estiver na whitelist reescreve os grupos de permissão do Plan
(`POST /v1/saveGroupPermissions`) sem credencial nenhuma. Não sondado, e o `storePreferences` é
razão concreta para duvidar que valha para todos.

### O placar das camadas, com as datas que cada linha tem

O princípio está na §11 item 3b1 do spec — *"filtro de aplicação nunca substitui filtro de rede"*:

| camada | estado | quando foi visto |
|---|---|---|
| firewall de rede | `ufw` inativo | **2026-08-21**, e **não reverificado** desde a mudança de estado de 26/08 |
| whitelist de aplicação | **lida pelo dono, e adequada** | **2026-08-28** ✅ |
| autenticação | **desligada** | 2026-08-26, medido |

> ### ✅ A whitelist foi lida em 2026-08-28
>
> Aberta desde 2026-08-21 e apontada como **a verificação urgente antes do unban all**. O dono leu o
> `config.yml` do Plan e reporta a whitelist como adequada.
>
> **O que isso fecha:** a única camada de controle de acesso *conhecida* na 25504 deixou de ser uma
> incógnita. Com a autenticação desligada (`authRequired: false`, medido em 26/08), era ela sozinha
> decidindo quem alcança a porta — e agora se sabe que ela decide, em vez de se supor.
>
> Fecha também, por consequência, a candidata mais provável para o 403 que a máquina residencial
> levou em 26/08.
>
> **O que continua aberto, e a §11 item 3b1 do spec é explícita:** *"filtro de aplicação nunca
> substitui filtro de rede"*. O `ufw` estava inativo em 2026-08-21 e **não foi reverificado**. Uma
> whitelist de aplicação boa numa porta sem filtro de rede é uma camada, não duas — e a §8 do spec
> pede as duas. A **superfície de escrita** (`POST /v1/saveGroupPermissions` e companhia) também
> segue não sondada.

A whitelist é o único controle **conhecido de acesso à porta** — gate por endpoint é questão
separada, e o `storePreferences` acima mostra que ao menos um existe. E "conhecido" não é o mesmo
que "o único que existe": a linha do firewall tem cinco dias, e esta seção inteira trata de uma
mudança de estado que ninguém explicou — "firewall/whitelist ajustada" é uma das candidatas em
aberto. Afirmar ausência de controle de rede hoje seria decidir essa candidata sem evidência.

**Efeito colateral útil:** com auth desligada, "autenticação recém-ligada" sai das quatro candidatas
para o 403 da máquina residencial. Um 403 no `/v1/whoami`, que não recebe parâmetro, com auth off,
tem na whitelist a explicação de longe mais provável. Isso é atualização de probabilidade, não prova
— um mecanismo de ban por volume produziria o mesmo sintoma, e as 17 requisições registradas mantêm
essa candidata viva.

**A verificação que decide continua a mesma, e agora vale mais: ler a whitelist no `config.yml` do
Plan.** Antes ela diria *se* havia problema. Agora ela é a lista de quem alcança uma porta sem
autenticação. **Antes do unban all**, que é quando o servidor ganha atenção.

E junto dela, duas que ficaram baratas: reverificar o `ufw`, e sondar **um** endpoint de escrita a
partir da VPS para saber se o gate próprio do `storePreferences` é regra ou exceção.

### 🔴 Mudança de estado observada no mesmo dia

Horas depois daquela leitura bem-sucedida, **todo endpoint passou a responder 403** do mesmo IP —
inclusive a URL idêntica que havia devolvido dados:

```
403  /v1/whoami          403  /v1/serverOverview?server=Survival
403  /v1/networkMetadata 403  /v1/onlineOverview?server=Survival
403  /v1/retention       403  /v1/datapoint?type=PLAYTIME
```

Não sei a causa e não vou inventar uma: pode ser whitelist ajustada, autenticação ligada, bloqueio
por volume de sondagens, ou reinício com outra config.

Para quem for pesar a terceira hipótese: nesta sessão saíram **17 requisições** desta máquina para a
25504, ao longo de algumas horas — 2 de leitura de dados, 7 sondando caminhos de spec, e 8 de status
na última rodada. Volume baixo, mas registrado para não virar suposição.

**O que importa operacionalmente — e são só metade dos checks.** O 403 foi visto de uma máquina
residencial; **não se conferiu se a VPS do sales também está levando 403**. *Se* estiver, degradam
apenas os checks que falam HTTP com o Plan:

| check | fonte | sob 403 da API |
|---|---|---|
| `plan.collection_alive` | `PlanApiClient` | degrada |
| `platform.offline_account_share` | `PlanApiClient` | degrada |
| `funnel.network_to_survival` | API **+** MySQL | degrada (metade da API) |
| `plan.orphan_instance` | `PlanDatabase` | **segue verde** |
| `plan.proxy_registration_alive` | `PlanDatabase` | **segue verde** |
| `plan.version_divergence` | `PlanDatabase` | **segue verde** |

Mais as rotas de `metrics` da S7.2, que degradam por inteiro.

> **Isto corta contra a tese desta própria seção.** A exceção 2 do ADR-002 — a que perdeu a
> justificativa alegada — é o que manteria três dos seis checks vivos durante uma queda da API.
> Fechá-la sem substituir a fonte trocaria dívida de acoplamento por perda de cobertura no cenário
> que hoje é plausível.
>
> **É argumento estrutural, não observação.** Ninguém executou os checks durante o 403; a conclusão
> vem de ler de onde cada check lê. Está aqui porque omiti-lo tornaria esta seção uma peça de
> acusação em vez de um registro — mas rotulá-lo errado seria cometer, dentro dela, o erro que ela
> veio catalogar.

**E o alerta que sair vai rotular a causa errada.** O `PlanApiClient` mapeia **401 e 403 para o
mesmo `PlanAuthError`** (`plan-api.client.ts`). A mensagem é razoável e já cita as duas pistas —
*"Plan recusou a credencial (HTTP 403) em … — verifique PLAN_API_TOKEN **e a whitelist de IP do
Plan**"*. O problema está um nível acima: o comentário de módulo de `plan-api.errors.ts` classifica esta
falha como *"our credential is wrong or expired. Our bug, not an outage"* (tradução minha), e o
docblock da classe repete a ideia com outras palavras.

Sob um 403 de whitelist isso é um rótulo causal errado, e é o rótulo que o alerta carrega. Colapsar
401 e 403 numa classe só vira dívida a corrigir.

**Não é o risco da §10b.** Aquele é restrição de IP no nível do provedor quebrando o **ETL na
3306**. Isto é filtro de aplicação na 25504 e não toca o caminho do ETL. São dois caminhos de dado
diferentes, e confundi-los é como se chega à tabela errada.

O que continua verdadeiro: a camada **fala** em vez de parar em silêncio — mas só pelos três checks
que dependem da API, e com a causa errada no rótulo.

### Conferência parcial no mesmo dia — o 403 não atinge o caminho do sistema

```
VPS          -> /v1/whoami          200
residencial  -> todos os endpoints  403
```

> **O quanto esse 200 prova, antes da conclusão.** Ele veio do `/v1/whoami` — que, pelo próprio
> OpenAPI, é o endpoint cuja função é reportar estado de autenticação, e não um dos que os checks
> consomem. Nenhum check foi executado. Três dos seis nem passam pela 25504: leem MySQL na 3306, que
> este teste não tocou. E a última observação de VPS → `/v1/serverOverview` é de **2026-08-23**,
> anterior à mudança de estado que esta seção documenta.

**O que se conclui:** a VPS alcança a 25504. O 403 observado não atinge o caminho do sistema.

**O que é inferência, não execução:** que os checks da S6.3 e as rotas de `metrics` respondam.
Ninguém rodou nenhum dos dois.

> **Parte disso fechou no mesmo dia.** `curl` da VPS para `/v1/serverOverview?server=Survival`
> devolve **200**. Isso cobre o endpoint que três dos seis checks consomem e **metade** das rotas
> de `metrics` — o `MetricsService` também chama `/v1/onlineOverview`, que não foi sondado.
>
> E cobre para `server=Survival`. O `network-to-survival.check` compara chegadas do proxy contra as
> do backend, então ao menos uma chamada leva outro `server` — e nome de servidor que o Plan não
> reconhece é exatamente o que ele responde com `403`.
>
> Continua verdade que nenhum check foi executado. O que deixou de ser dúvida é se **uma** das
> fontes está alcançável. Os outros três checks leem MySQL na 3306, fora do alcance deste teste.

**E a causa do 403 continua indeterminada.** "A whitelist recusando uma origem estranha" é uma das
quatro candidatas listadas acima, não a conclusão — e as 17 requisições registradas nesta sessão
tornam "bloqueio por volume" tão plausível quanto ela.

A tabela de degradação por check continua válida como **descrição do que aconteceria** se a VPS
perdesse acesso. Descreve uma hipótese, não o estado.

O que **continua sem ser lido**: o conteúdo da whitelist e o corpo do `/v1/whoami`. Que o caminho do
dashboard funcione é questão de **disponibilidade**; se a autenticação está ligada e quem mais está
na lista é questão de **exposição**, e o prazo dela segue sendo o unban all — não o fato de o
dashboard ler dados.

---

## Perguntas em aberto (não são código, e valem mais que sprint)

1. **O que aconteceu em fevereiro/2026?** Aquisição de rede caiu de 1.177 para 645. **Nenhuma
   hipótese testada.** É a investigação mais valiosa em aberto.
2. **O Plan do proxy voltou a coletar?** Em ago/2026 tinha 8 registros contra 130 do PlayerPoints.
   Se não estiver coletando, a campanha (unban all + vídeos) passa sem medição.
3. **O conserto do tutorial pegou?** Verificar se a razão `tutorial/survival` voltou para perto de
   100%. Antes de dez/2025 era ~100%; em abril estava em 12%.
4. **Bedrock caiu de 43% para ~25% das chegadas em 6 meses.** Canal que secou ou barreira técnica?
   Teste de 5 minutos: entrar pelo celular, no Bedrock, na versão pública. **Importa antes da
   campanha de vídeo vertical**, que traz exatamente esse público.
5. **Os `java_offline` do proxy são bots?** Amostra de nomes resolve.

---

## Riscos aceitos

**§10b do spec — exposição de rede.** `mariadbd` em `0.0.0.0:3306`, `ufw` inativo, conta MySQL
`@%`, credenciais em texto plano em 4 configs de plugin, porta confirmada aberta de 3 pontos
independentes.

> **Correção de 2026-08-23 — o IP estava errado neste documento.** A máquina do game é
> **`198.89.99.70`** (`ip -4 addr`: `198.89.99.70/24` em `enp4s0`, e nada mais público). O
> `198.89.99.229` que aparecia aqui, no spec e no `Alternative_IP` do próprio Plan **não é
> endereço dessa máquina**. Custou uma investigação inteira de "a VPS não alcança o Plan" que era
> só endereço errado. A leitura correta da evidência de 21/08 é que `198.89.99.70` era o **alvo**
> dos testes, não a origem. **O dono decidiu tratar como responsabilidade da MagnoHost.** Registrado, não
relitigar. Se a MagnoHost restringir por IP no futuro, o ETL para sem aviso e a `S6.2b` precisa ser
reaberta.

---

## Ferramentas produzidas nesta sessão

Entregues por chat, **ainda não versionadas** — vale commitar junto do baseline da S6.0:

| arquivo | o que faz |
|---|---|
| `austv-diagnostico.ps1` | churn, duração de sessão, tipo de conta, gates do tutorial, último login por mês |
| `austv-diagnostico2.ps1` | funil por plataforma, retenção D1/D7/D30 retroativa, coorte por mês |
| `austv-diagnostico3.ps1` | chegadas e saídas por mês × plataforma + cross-check independente |
| `plan-forense.sh` | forense de instalação do Plan na VPS (resolveu o caso do SQLite) |
| `plan-analise.sql` | 5 blocos: cobertura, chegadas, atividade/bounce, retenção, antes-vs-depois do tutorial |

Estes scripts são hoje o **único registro histórico de retenção do AusTV** anterior ao Plan. Rodar
uma última vez antes do unban congela o "antes" — depois da campanha os arquivos mudam e essa foto
não volta.

---

## Regras de trabalho que emergiram

- **`n` obrigatório junto de todo percentual.** O contrato da API não permite percentual sem base.
- **"Sem dados" é diferente de zero.** Nunca preencher buraco de coleta com zero.
- **Vazio ≠ zero** em provider de economia.
- **Grant administrativo fora de métrica de receita** — existe linha de 9.999.999 na origem.
- **Nenhum I/O de rede na main thread** do servidor de jogo, se algum dia voltar a existir plugin.
- **Verificar o controle antes de confiar num teste.** Nesta sessão: um `nmap` foi descartado
  porque o controle falhou; um `fechada` foi descartado porque era o comando não existindo no CMD;
  um "Plan sem histórico" era o banco errado sendo consultado.

---

## Sprint 9 entregue em 2026-09-02 — e o que ela deixou por medir

As três histórias estão em `main`: S8.2 (#183), S9.2 (#184), S9.1 em duas fatias (#185, #186).

### Erros de método que esta sprint cometeu, para não repetir

**1. Um teste que passa não prova que a decisão está certa; prova que ela não mudou.**
Dois casos, ambos encontrados por code review e não pelo CI:

- O harness do ETL de pagamentos tinha `[]` como padrão de `accountCreations`, então **todo
  teste do arquivo executava `replaceCreations([])`** — a chamada que apaga a série de
  chegadas — e nenhum asseria nada sobre isso. O caminho destrutivo rodava no caminho feliz.
- O e2e asseria `expect(body.days).toEqual([])` com o comentário *"um array vazio dentro de
  um intervalo coberto é uma resposta real"*. Era a saída exata do defeito, fixada como
  contrato.

**2. O tipo da linha é o que o código acredita, não o que o driver faz.** O `pg` converte
uma coluna `timestamptz` em `Date` e os tipos de linha dizem isso. Ele **não** faz o mesmo
com o resultado de um agregado: `min(purchased_at)` voltou como string e o `.getTime()`
estourou. Os unitários mockam o handle do Drizzle, então o tipo era o que o teste escrevia.
Só o e2e contra Postgres real viu. Todo timestamp lido por `db.execute` passa por um
normalizador agora.

**3. Uma guarda pode liberar exatamente o que ela existe para recusar.** A regex que exigia
offset explícito numa data-string aceitava `2026-09-01`, porque ela só olhava o fim da
string e `-01` casa com "menos uma hora". O V8 então lê a forma só-data como meia-noite UTC
= 21:00 BRT do dia anterior, e todo registro do dia 1 cairia na coorte do mês anterior. O
defeito chegou ao `main` pelo #183 e foi corrigido pelo #185.

**4. Rebasear uma pilha de PRs perde trabalho se você limpar a árvore.** Quatro correções do
review do #185 foram descartadas por um `git checkout -- .` antes de trocar de branch, e o
commit seguinte as descrevia como aplicadas. Duas o CI pegou; duas só apareceram ao conferir
o arquivo. Se for preciso guardar trabalho para rebasear, guarde e **confira depois de
restaurar**.

### O que sobra para o dono, e nenhum item é código

1. **Provisionar o usuário MySQL read-only e dedicado** do PlayerPoints no `jogar.austv.net`.
   O usuário dos plugins é exatamente o que **não** se deve reusar: as credenciais dele estão
   em texto plano em quatro configs no servidor do jogo. Sem isso, E3, E4 e a série de
   chegadas reportam `never_synced` — nunca zero.
2. **Ligar os três jobs na VPS.** `PLAYER_DIMENSION_SYNC_ENABLED`, `PAYMENTS_SYNC_ENABLED` e
   `WEEKLY_REPORT_ENABLED`, mais `DISCORD_REPORT_WEBHOOK_URL`. É a mesma forma do ETL do
   tutorial, que ficou meses no repo sem estar configurado e só apareceu na validação de
   2026-09-01.
3. 🟡 **Meio-conferido em 2026-09-02, e o meio que falta é justamente a direção.** O dono leu
   um pagamento real e mediu o **layout**: as duas linhas que o PlayerPoints grava por
   transferência **trocam `source` e `receiver` entre si**, com o amount negado.

   ```
   PAY_RECEIVER  source=c628…   receiver=41574…    35
   PAY_SENDER    source=41574…  receiver=c628…    -35
   ```

   Isso é forte e resolve uma coisa: **nenhuma leitura dessas colunas vale para as duas
   linhas**, então fixar `transaction_type` é pré-requisito para elas significarem qualquer
   coisa, e quem consultar `player_payments` direto sem filtrar mistura duas leituras opostas no
   mesmo resultado. Registrado no `schema.ts`, em `CANONICAL_PAYMENT_TYPE` e no
   `directionCaveat` do payload.

   **🔴 Mas o par não decide a direção, e eu escrevi aqui que decidia.** Ele é um espelho
   perfeito: sobrevive intacto tanto a `receiver` ser o sujeito da linha quanto a `source` ser.
   Nem o sinal (o `+` está na linha do recebedor sob as duas leituras) nem os nomes dos tipos
   quebram o empate.

   O erro de método: *"as colunas trocam"* é **consequência** da simetria e carrega informação
   zero sobre direção, e eu o tratei como a confirmação — reescrevendo para "CONFIRMADA" uma
   ressalva que um moderador lê antes de agir sobre uma marca. Pego pelo review, não por mim.

   **✅ E a simetria foi quebrada no mesmo dia, com o `SELECT` que o review indicou.** As linhas
   `SET` têm uma parte real só, logo não podem ser simétricas. Em produção:

   ```
   SET   source=NULL   receiver=4f451aec-e16b-40f4-bcc1-c4da86aca030               amount=0
   SET   source=NULL   receiver=00000000-0000-0000-0009-01f25c4881fd               amount=0
   ```

   `source` é **nulo** e o uuid do jogador está em `receiver`. Portanto **`receiver` é o sujeito
   da linha** — a conta a que o lançamento se aplica — e `source` é a contraparte, ausente quando
   a ação não tem uma. Levando isso de volta ao par, ele fecha sem sobra: na `PAY_RECEIVER` o
   sujeito é a conta creditada (`receiver`, `+35`) e `source` é o pagador. **`from`/`to` do feed
   estão certos**, e `funding_many` conta quantas pessoas distintas **um pagador** pagou.

   A aposta que o código já fazia era a certa — `PlayerPointsDatabase.accountCreations` não
   seleciona o `receiver` de uma linha `SET` *porque ali é o jogador*. Era aposta; virou medida.

   **O que não caiu junto:** a armadilha do swap. Ela é independente da direção e continua de pé
   para qualquer consulta direta a `player_payments` — por isso o `directionCaveat` continua
   viajando no payload mesmo com a direção fechada.
   **Um defeito real caiu junto:** o E3 fazia o join sem filtrar o tipo, então casava o mesmo
   jogador nas duas linhas e contava todo pagamento duas vezes. **A duplicação era inerte** —
   as contagens só são lidas como `> 0` para escolher o grupo, e dobrar preserva o zero —, então
   nenhum número publicado estava errado. Corrigido mesmo assim: o dia em que uma dessas
   contagens virar número publicado, ela é 2×.
   **E o motivo de nenhum teste pegar é o mesmo padrão de sempre:** todas as fixtures de
   pagamento eram `PAY_RECEIVER`. Com uma linha por pagamento, um join que lê os dois tipos é
   indistinguível de um que lê o certo — a propriedade que separa os dois simplesmente não
   existia no conjunto de testes. É a segunda vez em dois dias que a lacuna é essa forma:
   *a fixture não tinha a combinação que expõe o defeito*, e não *faltava um caso*.
4. ✅ **Feito em 2026-09-02.** A posição no tutorial por jogador foi autorizada pelo dono e
   entregue: `tutorial_player_position`, escrita pelo mesmo ETL, atrás de
   `TUTORIAL_POSITION_ENABLED`. `/economy/first-spend` publica `byFunnelPosition` (três
   grupos) e `byFurthestStep` (um por passo, que é o que responde "quem trava no passo 03").
   **Falta ligar a variável na VPS** — enquanto estiver desligada o bloco sai `null` com o
   motivo, nunca uma lista de zeros.
   Um defeito latente apareceu no caminho e foi corrigido junto: `TutorialCatalogue.ids`
   estava em ordem de `readdir`, então `2tutorial` viria depois de `10tutorial` e todo índice
   derivado sairia errado. A ordem resolvida viaja no payload (`stepOrder`) para poder ser
   conferida contra o jogo.
5. ✅ **Fechada em 2026-09-02 por decisão do dono.** A exceção 1 do ADR-002 não tem mais
   consumidor e foi encerrada.
6. **Calibrar os limiares novos** contra a leitura de produção. Estado em 2026-09-02:
   - os **dois do detector de carimbo** não podem ser calibrados por esta leitura: em 5.580
     linhas eles não disparam **nenhuma** vez, e o artefato que existiriam para pegar foi
     pego pelo outro caminho. Mexer neles com base num detector que nunca falou seria chute
     com aparência de medida;
   - os **quatro do feed de moderação** continuam sem base: `windowSize: 0`,
     `never_synced` — o ETL do PlayerPoints nunca rodou, e depende do acesso MySQL abaixo;
   - o que a leitura **de fato** produziu foi um defeito de mecanismo, não um número a
     ajustar. Ver o bloco de 2026-09-02 acima.
7. **Conceder o acesso do PlayerPoints.** O grant medido em 2026-09-02 é
   `austv_admin_ro`@`<host-da-VPS>` com `SELECT` em `plan_servers` e `plan_users` apenas — o
   `ERROR 1045` visto da máquina do jogo era autenticação (host errado), não permissão, e o
   grant certo simplesmente não cobre a tabela do PlayerPoints. Falta uma linha:
   `GRANT SELECT ON <db>.playerpoints_transaction_log TO 'austv_admin_ro'@'<host-da-VPS>'`.
   É a única tabela que este sistema lê ali, e o `SET` dela é a série de chegadas do R1.

### Os dois itens do DoD da S9 que não podem ser fechados daqui

- **"Timings anexado ao PR provando ausência de regressão de tick"** — exige rodar contra a
  produção. O que dá para fazer foi feito: os dois ETLs medem a si mesmos e persistem
  `duration_ms`, e o do PlayerPoints persiste também `source_query_ms`, o tempo dentro da
  query do banco do jogo. A primeira execução real produz a evidência sozinha.
- **"Um relatório real gerado e conferido à mão"** — o gatilho existe
  (`POST /reports/weekly/run`) e o caminho inteiro é exercitado no e2e com **todas** as fontes
  ausentes. Falta o run em produção e a leitura humana do que chegou no canal.
