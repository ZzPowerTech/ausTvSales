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

`plan_users` tem **5566** linhas; `plan_user_info` do Survival tem **5540**. O histórico de rede do
proxy **não veio na unificação** — está no banco antigo. Na prática, **métrica de rede tem 3 dias de
profundidade** (desde 2026-08-20). Para comparar antes/depois do unban isso é raso, e é melhor
saber agora do que na hora de comparar.

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

> **O que NÃO está verificado, e não se conclui daqui:** se o `networkMetadata` traz o
> `plan_version` por instância. O check `plan.version_divergence` precisa disso. Sem verificar o
> corpo, a exceção 2 não pode ser fechada — só perdeu o motivo alegado.

### O que mais a lista revelou

| endpoint | por que importa |
|---|---|
| `GET /v1/retention` | *"Get retention data for server or the network"*. A **S8.2** existe para calcular retenção por coorte, e é a **exceção 1** do ADR-002 — o único ponto autorizado a fazer SQL direto. Verificar o que este endpoint devolve antes de escrever a S8.2 |
| `GET /v1/query` + `GET /v1/filters` | API de consulta com filtros e janela (`afterEpochMs`/`beforeEpochMs`, lista de servidores). Candidato para o degrau **rede → survival** da S8.1. Não cobre `tutorial_entrou` nem `tutorial_concluiu`, e isso não é leitura de documento: o Plan
**não coleta nada de tutorial** (bloco anterior deste arquivo), então nenhum endpoint dele poderia
cobrir. Seguem bloqueados pela S8.0 — e não se sabe se resolve o denominador de rede (§2 do spec: proxy grava usuário, não sessão). Verificar o corpo antes de estimar |
| `GET /v1/joinAddresses` | endereço de conexão usado pelo jogador. **Proxy possível** de canal de aquisição — só vale como canal se canais diferentes anunciarem hostnames diferentes. Rotular como proxy onde aparecer, pela mesma regra do critério 6 da S8.0 |
| `GET /v1/playersTable` | já conhecido, mas o schema documenta `registered` por jogador — é a outra metade da exceção 2 (`plan_users.registered`) |

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
| whitelist de aplicação | existe; recusou ao menos um IP | conteúdo **nunca lido** |
| autenticação | **desligada** | 2026-08-26, medido |

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
