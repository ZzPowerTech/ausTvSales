# AusTV Admin — Plano de Sprints (v2: S6 → S12)

> `.specs/sprints/austv-admin-sprints.md` · Revisão 2026-08-21
> Base: [`.specs/features/austv-admin/spec.md`](../features/austv-admin/spec.md) (v2)
> Sprints de 1 semana. Numeração a partir de 6 (S1–S5 entregues).

## Mudanças da v1

| v1 | v2 | motivo |
|---|---|---|
| S7 inteira: `DataExtension` de plataforma (13 SP) | **eliminada** | ADR-003 — plataforma sai do UUID em SQL, 100% de acerto |
| `ausPlanBridge` (plugin Java) | **adiado para v2** | ADR-007 — economia já está em banco; **zero Java na v1** |
| S6 = instalar e validar contrato | S6 = **unificar bancos + saúde + baseline** | Plan já instalado, em dois bancos, e já ficou 3 meses morto sem ninguém ver |
| Saúde da instrumentação: inexistente | **PR 1, antes de qualquer gráfico** | ADR-006 |
| Funil: só tutorial | **4 degraus** (rede → survival → tutorial → retenção) — o `rede` sem fonte desde 2026-08-31 | descoberta do degrau de 54% |
| 104 SP / 8 sprints | **105 SP / 7 sprints** | o total caiu com a S7 eliminada, mas subiu com S6.0, S6.2b e a camada de saúde |

Capacidade planejada 13 SP/semana. **Medir a S6 e recalibrar** — se a velocidade real for 6–8 SP,
isto é um plano de 11–14 semanas, não de 7.

Precedência: correções do funil de onboarding vêm na frente. Cada sprint marca uma história
**[CORTE]**.

---

## Definition of Done — global

- [ ] PR único, uma responsabilidade lógica, **deployável sozinho**
- [ ] Branch em worktree `.claude/.worktrees/<branch>`; zero commits em `main`/`dev`/`prod`
- [ ] Conventional Commits
- [ ] `code-reviewer` aprovado · `cybersecurity-validator` sem crítico (OWASP) · testes passando em CI
- [ ] Nenhum segredo versionado
- [ ] Código em inglês; docs em português
- [ ] Rollback documentado no PR body

---

# Sprint 6 — Instrumentação confiável antes da campanha

**Objetivo:** um único banco, versões alinhadas, coleta viva e vigiada, e o "antes" congelado. Esta
sprint tem **prazo externo**: precisa fechar antes do unban all.

### S6.0 — Baseline pré-campanha · 2 SP · `chore/pre-campaign-baseline`

Rodar os três `austv-diagnostico*.ps1` uma última vez e versionar scripts + saída.

1. Saída dos 3 scripts commitada com data do snapshot
2. README em português explicando o que cada número mede e suas limitações
3. **Irreversível se atrasar** — depois da campanha os arquivos mudam

### ~~S6.1 — Corpus do Carlito~~ · **CANCELADA em 2026-08-22** · ~~5 SP~~ → 0

> **Decisão do dono (Murilo, 2026-08-22): o acervo histórico de sugestões é descartável.**
>
> Cadeia de descobertas que levou aqui, toda no mesmo dia:
>
> 1. O `austv-minecraft/Ticket-Bot` foi lido na íntegra e **não tem sistema de sugestões** — o
>    domínio dele é ticket, e as quatro coleções do Mongo (`guilds`, `members`, `tickets`,
>    `messages`) não guardam sugestão, voto nem reação. Varredura por
>    `sugest|suggest|vote|voto|upvote|poll|enquete|carlito` deu um match, e era ruído
>    (`.vscode/settings.json`, `typescript.suggest.autoImports`).
> 2. O "Carlito" é o **Carl-bot**, um bot público de terceiros. Nunca foi software da equipe, e o
>    corpus vive no banco do fornecedor.
> 3. **Não há como recuperar as sugestões do banco do Carl-bot.**
> 4. O dono decidiu que perder os registros antigos é aceitável.
>
> A história existia unicamente para preservar esse acervo. Sem acervo a preservar, ela não tem
> objeto. **Cancelada — não movida, não adiada.**
>
> #### O que isso destrava
>
> - **A S6 cai de 22 SP para 17**, resolvendo sozinha o desbalanço que estava em aberto. A opção 2
>   da seção de desbalanço ("mover a S6.1 para a S7") ficou sem sentido: não há o que mover.
> - **O épico de sugestões perde seu gate.** A S10 dependia da S6.1 estar concluída; agora pode
>   começar quando a capacidade permitir.
> - **A S10.1 encolhe.** Era "Migration + importação do corpus"; sem corpus, sobra só a migration
>   do schema. Os 5 SP dela precisam ser reestimados — decisão do dono, não fiz sozinho.
>
> #### O que isso custa, registrado sem relitigar
>
> As sugestões futuras nascem sem histórico: não haverá base para dizer o que a comunidade já pediu
> nem o que já foi recusado, e um pedido repetido não terá como ser reconhecido como repetido. A
> decisão foi tomada com esse trade-off à vista.
>
> #### Pendência que sobra — **encerrada em 2026-08-23**
>
> A S6 ficou **sem história marcada `[CORTE]`** — a S6.1 era ela. As três restantes (S6.0, S6.2,
> S6.3) foram declaradas não-cortáveis. ~~A 17 SP contra 13 planejados, a sprint segue acima da
> capacidade e agora sem válvula de escape.~~
>
> **Deixou de ser problema em 2026-08-23**, quando a S6.2 foi reconhecida como já concluída
> (2026-08-20): a sprint caiu para **12 SP contra 13 de capacidade**. Segue sem história cortável,
> mas não precisa de uma. Nada a decidir.

### S6.2b — Auditar exposição de rede da máquina do game · 2 SP · `chore/db-network-exposure`

Arquitetura: **duas máquinas** — VPS (`sales.austv.net`, hospeda o `ausTvSales`) e game
(`jogar.austv.net` / **`198.89.99.70`**, produção do Minecraft). O ETL cruza entre elas.

> **Correção de 2026-08-23:** este documento dizia `198.89.99.229`, que **não é endereço da máquina
> do game** (`ip -4 addr` mostra `198.89.99.70/24` em `enp4s0`, e nada mais público). O erro estava
> replicado no spec e no `Alternative_IP` do próprio Plan, e custou uma investigação inteira de "a
> VPS não alcança o Plan" que era só endereço errado. Com o IP certo, a VPS alcança:
> `curl http://198.89.99.70:25504/v1/serverOverview` devolve `400`, igual ao localhost.

Método **autoritativo** (não sondagem de porta — teste rodado na própria máquina do game é loopback
e não vale):

1. `ss -tlnp | grep -E ':(3306|25504|25505)'` → interface de escuta de cada serviço, documentada
2. `ufw status verbose` (ou `iptables -S`) → regra efetiva de cada porta, documentada
3. **Estado alvo:** MySQL e webserver do Plan alcançáveis **apenas** pelo IP da VPS (allowlist de
   firewall ou túnel SSH)
4. Webserver do Plan **não** pode ir para `127.0.0.1` — o NestJS na VPS precisa dele pela rede.
   Duas camadas: firewall + whitelist de IP do próprio Plan, ambas restritas ao IP da VPS

   4b. Testar se a whitelist do Plan é contornável por `X-Forwarded-For` (curl com e sem o header);
   resultado documentado
5. Usuário **read-only** dedicado para o ETL, separado dos usuários dos plugins
6. Nenhuma credencial nova em arquivo versionado

> ### ⚠️ Fechada com o instrumento pronto e a medição por fazer (auditoria de 2026-08-27)
>
> `ops/audit/` tem os dois scripts, o runbook e o `exposure-report-TEMPLATE.md`. **Não existe
> nenhum relatório preenchido**, e portanto nenhum dos seis critérios acima tem registro — exceto o
> 6, verificável no repo, e o 4b, que foi respondido por outro caminho
> (`Use_X-Forwarded-For_Header: false`, lido do config do Plan em 2026-08-23 e registrado no
> `HANDOFF.md`).
>
> O método entregue é bom e acerta a parte fácil de errar. Mas a issue define o produto da história
> como *"o registro técnico do estado atual, porque o ETL vai assumir que essa rede é alcançável"* —
> e sem ele, quando o ETL da S9.1 parar, não haverá linha de base para dizer o que mudou.
>
> O passo 1 desse runbook é a leitura da whitelist no `config.yml` do Plan, que o `CLAUDE.md` já
> lista como urgente **antes do unban all** por um caminho independente. Fechar a S6.2b e fazer essa
> verificação são a mesma tarefa. Detalhe em
> [`S6-VERIFICACAO.md`](../features/austv-admin/S6-VERIFICACAO.md).

### ~~S6.2 — Unificar os bancos do Plan~~ · **CONCLUÍDA em 2026-08-20** · ~~5 SP~~ → 0

> **Executada pelo dono fora do fluxo de sprint** (confirmado por ele em 2026-08-23). Os bancos do
> Plan **já estão unificados** desde 2026-08-20, e as builds do proxy e dos backends **já estão
> iguais** — o `5.6 b2959 vs b2965` do critério 2 não existe mais.
>
> Não houve PR: unificar banco é operação de infraestrutura na VPS do jogo, não mudança de código.
> O runbook escrito para guiar o procedimento (PR #126) foi **revertido no PR #132**, porque
> descrevia um estado que já não existia.
>
> #### Erro de método registrado
>
> A história foi escrita e estimada em 5 SP sobre a premissa de "dois bancos separados", tirada da
> investigação de 19–21/08 e **nunca confirmada com o dono**. É a mesma raiz da S6.1/Carlito, que o
> `HANDOFF.md` já registra: **estimar trabalho sobre um sistema antes de ler o sistema**. Custo
> desta vez: um runbook de 258 linhas escrito, revisado, mergeado e revertido.
>
> #### O que isso destrava
>
> - **A S6 cai de 17 SP para 12** — pela primeira vez, dentro dos 13 SP de capacidade planejada. O
>   desbalanço da S6 deixa de existir; sobra apenas o da S12.
> - **A S6.3 perde seu gate.** O grafo ligava `S6.2 → S6.3`; sem a S6.2, os checks de saúde correm
>   imediatamente.
>
> #### O que continua valendo, movido para a S6.3
>
> Dois critérios eram sobre o **estado final**, não sobre a migração, e passam a ser verificados
> continuamente pelos checks em vez de uma vez só aqui: `plan_servers` mostrando proxy e backends no
> mesmo banco (check `plan.orphan_instance`) e builds iguais entre instâncias (check
> `plan.version_divergence`).
>
> #### Pendência que sobra
>
> O critério 3 dizia "webserver só no proxy, em `127.0.0.1`", o que **contradiz a §8 do spec**, que
> exige o webserver alcançável pela rede para o NestJS da VPS consumir `/v1/*`. A contradição é
> anterior a esta conclusão e **segue aberta** — resolver exige decisão do dono sobre a exposição de
> rede (§10b).

### S6.3 — Checks de saúde + alerta no Discord · 8 SP · `feat/instrumentation-health`

A entrega mais importante do plano. Sem ela, tudo pode parar em silêncio de novo.

1. [x] **Os 7 checks** da §6.1 implementados e agendados — o escopo foi reduzido para 6 em
   2026-08-23 (decisão do dono, opção 3) porque o sétimo, `funnel.tutorial_entry_rate`, **não tinha
   fonte de dado**. A [S8.0](#s80--fonte-de-dados-do-tutorial--5-sp--featutorial-data-source)
   construiu a fonte, e o sétimo entrou em **2026-08-28** — este critério fecha retroativamente
2. [x] Falha dispara **alerta ativo no canal do Discord**, não espera alguém abrir página
3. [x] Estado de cada check persistido em `health_check`, com histórico
4. [~] **Verificado derrubando uma instância de propósito** — **metade fechada em 2026-08-28.**
   O agendamento está ligado com webhook em produção, e alertas reais do
   `platform.offline_account_share` foram observados chegando no canal em 26/08 — `breached`,
   recuperação, agrupamento e o `n` ao lado do percentual, tudo funcionando.

   **Falta o caminho `error`**, que é o que a redação do critério pede: uma fonte que **morre**, não
   um limiar que estoura. É outro código e é o que cobre o apagão de três meses. Teste mais barato:
   parar o webserver do Plan, ou bloquear a 25504 da VPS, por um ciclo
5. [x] ~~Alerta de taxa de entrada no tutorial testado com valor forçado~~ — **fechado na S8.0** em
   2026-08-28. Não confundir com o critério 4: um prova que a mensagem é construída certo, o outro
   que ela chega
6. [x] Alerta repetido é agrupado, não vira flood

> **Entregue em 2026-08-23** (PRs #127, #128, #131, #135, #137, #139, #140, #141, #143, #144, #145,
> #146, #147): store, política de alerta, alerter do Discord, transporte HTTP do Plan, adapter do
> `serverOverview`, runner com guarda de ciclo sobreposto, agendamento opt-in e os seis checks.
>
> #### Calibração pendente, e não é detalhe
>
> Três limiares entraram como **chute conservador, não medida**, e estão marcados como tal no
> `.env.example` e no `env.validation`:
>
> | variável | padrão | risco de não calibrar |
> |---|---|---|
> | `PLATFORM_OFFLINE_SHARE_MAX` | `0.5` | alerta errado ou nunca alerta |
> | `FUNNEL_MIN_NETWORK_TO_SERVER` | `0.3` | idem — o histórico é 0,46 |
> | `PROXY_REGISTRATION_MAX_SILENCE_HOURS` | `24` | o menos crítico dos três |
>
> Enquanto não forem calibrados contra o baseline, o alerta é ruído em potencial — que é como um
> canal do Discord vira mudo.

### DoD da S6

> Auditado em 2026-08-27 contra o repositório, não contra este documento. Resultado completo em
> [`S6-VERIFICACAO.md`](../features/austv-admin/S6-VERIFICACAO.md).

- [x] `plan_servers` mostra proxy e backends num único banco, mesma build — **feito em 2026-08-20**,
      fora do fluxo de sprint (ver S6.2)
- [ ] ~~Dump restaurável dos dois bancos guardado fora da VPS~~ — sem objeto: a unificação já
      aconteceu e não existem mais "dois bancos" a dumpar
- [ ] Alerta comprovado por teste destrutivo intencional — **último item aberto da S6**
- [x] Baseline pré-campanha commitado — `ops/baseline/2026-08-19/`, as-of `2026-08-19 20:20`.
      Parcial e **declarado como tal**: 2 dos 5 artefatos do `HANDOFF.md` foram localizados, e o
      README lista onde os outros três foram procurados
- [ ] ~~Spec órfão `specs/spec.md` (coleta de sessão no proxy) marcado superseded~~ — **sem objeto
      neste repositório**: `git log --all -- 'specs/'` não retorna nada, o arquivo nunca existiu
      aqui. Provável referência à pasta do Drive de onde o spec e este plano foram recuperados
- [ ] **Novo, saído da auditoria:** relatório da S6.2b preenchido e commitado. Os scripts e o
      runbook estão em `ops/audit/`, mas **nenhum dos sete critérios da história tem registro** —
      só existe o `exposure-report-TEMPLATE.md`. O produto da história é o registro, não o script

### Riscos

| risco | mitigação |
|---|---|
| ~~Builds diferentes corrompendo schema~~ | **não materializado** — em 2026-08-20 os bancos foram unificados com as builds já iguais. O check `plan.version_divergence` (S6.3) passa a vigiar isso de forma contínua |
| Reinício do Paper/Velocity | janela fora de pico, anunciada |
| Unban chegando antes da sprint fechar | com a S6.1 cancelada e a S6.2 concluída fora do fluxo, resta a S6.3 (8 SP) — não cortável, é a razão de ser da sprint. A S6 agora cabe nos 13 SP de capacidade |

**[CORTE]** ~~S6.1~~ — cancelada. A S6 segue **sem história cortável**: S6.0 e S6.3 são não-cortáveis. A pressão sobre a válvula de escape caiu de qualquer forma — com a S6.2 concluída em 2026-08-20, a sprint tem 12 SP contra 13 de capacidade e não precisa mais de corte.

---

# Sprint 7 — API: saúde exposta e núcleo de métricas

> **ENTREGUE em 2026-08-26** (PRs #150, #153, #155, #156, #158): **13 de 13 SP**, ambas as
> histórias, sem corte.
>
> `main` verde: **45 suítes unitárias, 437 testes**, build e lint limpos. Os e2e rodam em config
> separada (`test/jest-e2e.json`) e não entram nessa conta — vão no CI, contra um Postgres real.

### S7.1 — Módulo `health` no NestJS · 5 SP · `feat/api-health`

1. [x] Expõe estado de cada check com histórico e timestamp da última verificação
2. [~] Endpoint de status agregado para uso externo (uptime check) — **entregue sob a sessão**;
   ver a tensão registrada abaixo
3. [x] Sob JWT; nenhum dado de jogador exposto aqui

> **Entregue no PR #155.** `GET /health/instrumentation` (agregado),
> `/checks` (estado atual por check) e `/checks/:name/history`.
>
> #### A decisão de design, e o bug que o review pegou
>
> `ok` não é a resposta padrão: o agregado responde `unknown` quando nada nunca rodou e `down`
> quando o **ciclo** não está vivo. `error` supera `breached` — "não conseguimos medir" é pior que
> "medimos algo ruim" —, e `no_data` conta como degradado, nunca como saudável.
>
> A primeira versão calculava frescor pelo carimbo **mais novo** entre todos os checks, o que
> responde "algo rodou recentemente" e não "todo mundo continua rodando". Um check que emudece
> mantém a última linha para sempre e qualquer irmão que ainda escreve o esconde — **é o proxy
> morto de novo, um nível acima**. Corrigido: `stale` vem do check mais velho, `staleChecks` diz
> quais pararam, e o registro `HEALTH_CHECKS` é comparado com o banco para expor `missing` (check
> registrado que nunca gravou linha não aparecia em contagem alguma, e ausência se lê como tudo
> bem).
>
> #### Tensão entre os critérios 2 e 3 — decisão do dono pendente
>
> O critério 2 pede endpoint agregado "para uso externo (uptime check)"; o 3 exige JWT. **Um
> monitor de uptime não completa OAuth do Discord.** Ficou sob a sessão, com a tensão registrada no
> docblock do controller — endpoint público que informa se a rede de jogo está sendo medida é
> reconhecimento de graça.
>
> Recomendação para quando isso for endereçado: um **heartbeat** que o agendador empurra
> (dead-man's switch) resolve a lacuna real — "processo vivo mas o ciclo parou" — sem abrir
> superfície de entrada nenhuma. `GET /health` já é público e cobre "processo morto".

### S7.2 — Módulo `metrics`: client do Plan, cache e visão de servidor · 8 SP · `feat/api-metrics-core`

1. [x] Visão de servidor e de online normalizadas para o contrato da §7
2. [x] Cache com **TTL por endpoint**, observável em log
3. [x] Plan fora do ar → 503 com corpo explícito e último valor cacheado marcado *stale*; **nunca
   zero inventado**
4. [x] **Nenhuma referência a tabela interna do Plan** (ADR-002)
5. [x] Guard JWT, DTO validado, Helmet, throttling, Swagger

> **Entregue no PR #158**, sobre a base dos PRs #150 (Helmet), #153 (Swagger) e #156 (throttler).
>
> #### O adapter do `/v1/onlineOverview` saiu de payload real
>
> Regra do projeto, e não zelo: o
> [Javadoc do Plan](https://plan-player-analytics.github.io/Plan/api/index.html) documenta a **API
> Java do plugin** e é silencioso sobre esses corpos. Escrever parser a partir dele seria escrever
> a partir de imaginação — foi assim que a S6.2 nasceu sobre premissa não verificada e teve de ser
> revertida.
>
> #### `/v1/serverOverview` está deprecado, e não migramos
>
> O console do Plan avisa em favor do `/v1/datapoint`. **Segundo o changelog do Plan**, os
> datapoints implementados são PLAYTIME, AFK_TIME, AFK_TIME_PERCENTAGE, WORLD_PIE, SERVER_PIE,
> MOST_PLAYED_GAME_MODE e MOST_PLAYED_WORLD — nenhum dos quais dá chegadas, jogadores únicos,
> sessões ou retenção.
>
> **Isso não é enumeração verificada.** Os valores válidos de `type` não foram observados, e a
> lista autoritativa fica no `/docs` do webserver do Plan, que ninguém consultou. O próprio
> changelog já se mostrou incompleto para esse tipo de lista: ele marca como deprecados o
> `sessionsOverview` e o `network/sessionsOverview`, **não** os dois que usamos — o aviso de
> deprecação do `serverOverview` veio da instância viva, não dele.
>
> A decisão de não migrar é conservadora e o custo de estar errado é inação, não número errado. Mas
> ela se apoia numa fonte que a investigação provou incompleta, e isso fica registrado em vez de
> arredondado. Detalhe e armadilhas de leitura no
> [`HANDOFF.md`](../features/austv-admin/HANDOFF.md).
>
> #### Dois achados do review que valem registro
>
> - **O cache não prevenia o stampede que existe para prevenir.** TTL limita a *frequência*, não a
>   *concorrência*: N leituras numa chave fria davam N chamadas a um webserver que roda dentro do
>   processo do Minecraft. Corrigido com single-flight.
> - **O corpo do 503 vazava topologia interna** — a URL do Plan e, em algumas falhas, até 200
>   caracteres do corpo que ele devolveu (tipicamente uma página de login HTML). O contrato passou
>   a publicar rótulo fechado (`unreachable`, `auth`, `contract_mismatch`…) e a mensagem completa
>   ficou no log.

### DoD da S7

- [x] Busca por nome de tabela do Plan no diff retorna vazio (fora do módulo de coorte) —
      verificado por `grep` sobre o diff no code review
- [x] Teste de falha: Plan derrubado → 503/stale sem exceção não tratada — os **dois** ramos:
      `unavailable` (nada em cache) e `stale` (valor anterior servido), este último com
      `overrideProvider(PlanApiClient)`
- [~] 401 sem token e 429 sob flood verificados por teste de integração — **401 e o flood de 429
      estão cobertos** (`throttling.e2e-spec.ts` esgota o perfil de dashboard e afirma o 429 na
      requisição seguinte). Nas rotas de `metrics` não há flood próprio: o que o header
      `x-ratelimit-limit: 120` afirma é o **acoplamento do throttler à rota e qual perfil
      resolveu** — não o 429 em si. A chave do throttler inclui o nome do handler, então um segundo
      flood custaria ~1 min de CI para reprovar o mesmo mecanismo. Decisão consciente, registrada
      aqui em vez de marcada como completa

**[CORTE]** ~~S7.1 pode sair se a S6.3 já entregar visibilidade suficiente no Discord.~~ — **não
foi cortada.** A sprint coube inteira, e a S7.1 é pré-requisito da S12.1.

### O que a S7 exigiu e o plano não enumerava

Três PRs de infraestrutura. Não são escopo extra: Helmet, throttling e Swagger estão nomeados no
critério 5 da S7.2. Estavam fora da **enumeração** do plano, não fora do plano.

| PR | o que |
|---|---|
| #150 | Helmet — política de CSP de **API** (`default-src 'none'`), HSTS explícito, e um `configureApp` único para que a suíte e2e deixe de testar um app diferente do que sobe |
| #153 | Swagger atrás da sessão. `SwaggerModule.setup()` **não** cria rota do Nest, então o `APP_GUARD` não a alcança — sem a middleware dedicada, o inventário completo de rotas ficaria legível por quem alcançasse a porta |
| #156 | Raiz do throttler extraída para módulo compartilhado + perfil de dashboard. `ThrottlerModule.forRoot()` só pode ser chamado uma vez por aplicação, e enquanto morava dentro do módulo de ingest, limitar rota de dashboard exigia importar *ingest* de uma feature sem relação |

### Achados que viraram issue

| issue | o que |
|---|---|
| [#151](https://github.com/ZzPowerTech/ausTvSales/issues/151) | O Nginx do dashboard serve o `index.html` **sem cabeçalho de segurança nenhum**. A resposta que o browser de fato renderiza não tem CSP; só `/api/*` tem |
| [#154](https://github.com/ZzPowerTech/ausTvSales/issues/154) | DTOs anteriores à S7 saem com schema vazio no OpenAPI — custo assumido de recusar o plugin de CLI do `@nestjs/swagger` |
| [#157](https://github.com/ZzPowerTech/ausTvSales/issues/157) | **Perda de dado.** `SaleDelivery.classify()` mapeia todo 4xx para `PERMANENT`, então um **429 descarta a venda para sempre**. E o throttler da app (10/s, sem burst) dispara *antes* do Nginx (`burst=20`, responde 503, que o plugin reenfileira em segurança). Drenar uma fila depois de uma queda pode destruir exatamente as linhas que o fallback SQLite existe para proteger |

---

# Sprint 8 — O funil de 4 degraus

**Objetivo:** transformar a descoberta da investigação em métrica contínua.

### S8.0 — Fonte de dados do tutorial · 5 SP · `feat/tutorial-data-source`

> **Aberta em 2026-08-23** pela decisão do dono (opção 3): a S6.3 entregou 6 dos 7 checks, e o
> sétimo virou esta história em vez de segurar a sprint inteira.

**Bloqueia:** o degrau `tutorial_entrou` da S8.1 · o check `funnel.tutorial_entry_rate` da §6.1 ·
o critério 5 da S6.3.

**O problema.** O Plan **não coleta nada do tutorial**. Os números de tutorial do `HANDOFF.md`
vieram de ler `Quests/playerdata/*.yml` **na máquina do game** com os scripts do baseline. Esses
arquivos não são alcançáveis pela API `/v1/*`, não estão no MySQL do Plan e não estão no PostgreSQL
do `ausTvSales`. Nenhuma das duas exceções ao ADR-002 ajuda — o dado não está em banco nenhum.

É o check que teria evitado o desastre mais longo já registrado: o tutorial parou de capturar
novatos em **dez/2025** e a taxa de entrada caiu de ~100% para 12% ao longo de **8 meses**, sem
ninguém notar.

**Primeira tarefa da história: escolher a fonte.** As opções, do `HANDOFF.md`:

| # | opção | custo | o que perde |
|---|---|---|---|
| 1 | ETL noturno lendo `Quests/playerdata` na máquina do game | ETL de **arquivo**, não de banco; exige acesso ao FS do game | nada — é a fonte real |
| 2 | Proxies do Essentials (`kit prot` = 02tutorial, `home` ≥1 = 05tutorial) | mais barato; os scripts do baseline já leem | são **proxies** — kit/home obtidos por outra via inflam o número |
| 4 | Instrumentar o tutorial na origem (plugin/comando) | contraria o ADR-007 (**zero Java na v1**) | reabre decisão fechada |

**Recomendação:** opção 1. A 2 é tentadora e é a que **não** recomendo sem rótulo explícito —
trocar a métrica pela proxy sem marcar seria repetir a classe de erro que o `HANDOFF.md` inteiro
existe para impedir.

**Critérios de aceite:**

1. [x] Fonte escolhida e registrada como ADR, com o custo declarado —
   [ADR-0004](../decisions/ADR-0004-fonte-dados-tutorial.md), opção 1
2. [x] ETL idempotente e re-executável, fora do pico — `TutorialSyncScheduler`, cron em
   America/Sao_Paulo, opt-in
3. [x] Fonte indisponível → **"sem dados" explícito**, nunca zero — e mais forte do que o critério
   pede: **seis regras de piso** recusam a gravação quando a varredura é degenerada, porque o
   `replaceAll` apaga antes de reescrever e uma varredura vazia apagaria a série gravando `ok`
4. [x] `funnel.tutorial_entry_rate` implementado sobre a fonte nova, fechando o 7º check da §6.1
5. [x] Alerta testado com **valor forçado** — `tutorial-entry-rate.alert.spec.ts` força 12 de 100 e
   assere sobre o payload HTTP que iria ao webhook. **Não substitui o critério 4 da S6.3**, que
   segue aberto: este prova que a mensagem é construída certo, não que ela chega
6. ➖ Sem objeto — a opção 2 não foi escolhida, então não há número a rotular como proxy

> **Entregue em 2026-08-28** (PRs [#168](https://github.com/ZzPowerTech/ausTvSales/pull/168) e o do
> 7º check). O ADR registra duas coisas que a história não previa: `started-date` é **epoch ms**,
> então o tutorial vira série diária em vez de retrato; e o script do baseline **superconta
> conclusões**, o que tira dele o status de árbitro da coluna `concluiu`.

### S8.1 — Módulo `funnel` · 8 SP · `feat/api-funnel`

1. [~] Série diária e mensal de `rede → survival → tutorial_entrou → tutorial_concluiu` — **três dos
   quatro degraus**. Até 2026-08-31 o degrau sem números era o `survival`; medido, é o **`rede`**, e
   os dois trocaram de lugar sem que nenhuma contagem mudasse. Ver o bloco abaixo
2. [x] Cada degrau segmentável por `platform` (ADR-003, direto do UUID) — exigiu ler
   `plan_users.uuid`, uma **extensão da exceção 2 do ADR-002** registrada lá e pendente do dono
3. [x] **`n` retornado junto de todo percentual** — imposto pela *forma*: `percent` e `n` são um par
   que existe ou não existe junto, então publicar razão sem base é irrepresentável, não apenas
   desencorajado
4. [x] Período sem dados → "sem dados" explícito, distinto de zero — e a distinção vai além do
   bucket: `sources` reporta cada store separadamente, então um apagão de banco não se parece com
   um período vazio
5. [~] Agregação pesada em job **fora do pico**; falha mantém último resultado válido, datado — ver
   a justificativa abaixo

> #### 🔴 O degrau vazio é o `rede`, não o `survival` — corrigido em 2026-08-31
>
> ~~O degrau `survival` ficou sem série diária.~~ Estava invertido, e o bloco original apontava para
> as fontes erradas.
>
> **O que se mediu.** `plan_users`, que alimentava o degrau `rede`, guarda o **Survival**: o proxy
> (`AusTv`, `is_proxy = 1`) tem **zero** jogadores em `plan_user_info`, `Survival` é o único servidor
> que aparece lá (5575 de 5638 linhas), e as contagens mensais da tabela são a coluna `survival` dos
> números verificados **linha a linha**, nos oito meses. Detalhe no
> [`HANDOFF.md`](../features/austv-admin/HANDOFF.md).
>
> **O que mudou no código:** os rótulos, e só. `rede` saiu `null` com motivo; a mesma contagem passa
> a alimentar `survival`, com a procedência no payload (`sources[].provenance`), dizendo que a
> tabela é `plan_users` e que a identidade Survival dela é coincidência medida, não garantia de
> schema — `plan_user_info` continua sendo a **exceção 1** do ADR-002 e pertence à S8.2.
>
> **O que isso conserta não é uma contagem, é uma conversão.** `rede → survival` era Survival ÷
> Survival: perto de 100%, plausível, e incapaz de cair com a rede inteira apagada. Mesma classe do
> 4500% que este módulo já publicou duas vezes.
>
> **O sinal não estava vigiado em lugar nenhum**, ao contrário do que este bloco dizia: o check
> `funnel.network_to_survival` dividia as mesmas duas populações e reportaria `ok` com a rede
> desaparecida. Ele passou a `no_data` com o motivo — ver §6.1 do spec.
>
> **Fechar isto** deixou de ser "observar o corpo do `/v1/graph`" e passou a ser **achar uma fonte de
> chegadas no proxy**: nem a API nem o banco autorizado hoje têm essa população. O banco antigo é
> candidato; `/v1/networkMetadata` e `/v1/playersTable` nunca foram lidos com esse fim.
>
> #### Sobre o critério 5: metade entregue, metade não
>
> O critério pressupõe agregação pesada. Medida, não é: `plan_users` tinha **5.566 linhas no total**
> em 2026-08-23, e toda leitura é ainda janelada em cima disso. Um ETL noturno para alguns milhares
> de linhas seria cerimônia — e acrescentaria uma defasagem própria a um número que hoje é vivo.
>
> Das duas metades do critério:
>
> - **"fora do pico"** → ✅ o que ele protege é entregue de outro jeito: a janela é limitada a 366
>   **dias** e o corte acontece **antes** de qualquer fonte ser consultada, então nenhum pedido
>   consegue alargar a varredura na máquina do jogo.
> - **"falha mantém último resultado válido, datado"** → ❌ **não entregue.** Uma fonte que falha
>   devolve `null` com rótulo fechado, não o último valor bom. Isso é degradação honesta, que é
>   outra coisa. A capacidade existe no repo — `PlanCache` (`outcome: 'stale'` + a idade real),
>   construída na S7.2 exatamente para isto — e ligar o funil nela é o próximo passo óbvio.

> #### E o item 1 do DoD da S8 não é verificável hoje
>
> ⚠️ **Este bloco dizia "nas duas metades" e a segunda metade está em dúvida desde
> 2026-08-30.** A profundidade de `plan_users.registered` nunca foi medida — ela foi
> inferida da perda do histórico do proxy, e `earliestArrivalAt()` /
> `coversFrom` respondem isso em um `curl` que ninguém deu. O texto abaixo fica como está
> por ser o registro do que se acreditava; leia-o com essa ressalva. Ver o bloco da
> profundidade no [`HANDOFF.md`](../features/austv-admin/HANDOFF.md).
>
> *"Funil reproduz os números conhecidos: ~54% rede→survival, ~100% de entrada no tutorial antes de
> dez/2025."*
>
> - **~54% rede→survival** — o degrau `rede` não tem fonte (bloco acima). Continua bloqueado, e
>   agora por um motivo medido em vez de suposto.
> - **~100% antes de dez/2025** — ~~igualmente impossível~~. **Destravou em 2026-08-31.** A premissa
>   desta linha era que `plan_users` **perdeu o histórico do proxy** na unificação de 2026-08-20;
>   medido, `coversFrom` é **2024-06-02**, e o que a tabela nunca teve não é profundidade, é a
>   população do proxy. Esta metade não precisa dela: `~100%` é **tutorial ÷ survival**, e
>   `survival` é justamente o degrau que a tabela alimenta. Nov/2025 dá `694 / 682 = 101,8%`.
>   **Calculável; ainda não rodado contra produção.**
>
> O funil **não finge** conseguir: buckets anteriores à cobertura de `plan_users` saem com
> `survival: null` e motivo, nunca com um zero medido — e o degrau `rede` sai `null` em todo bucket,
> sempre, porque nenhuma fonte tem essa população. Sem a guarda de cobertura, o período default
> mensal publicaria doze meses de `survival: 0` ao lado de números reais de tutorial — um funil onde
> mais gente entra no tutorial do que chega ao servidor.

### S8.2 — Retenção D1/D7/D30 por coorte e plataforma · 5 SP · `feat/api-cohort-retention`

> ## ✅ ENTREGUE em 2026-09-01, na Sprint 9 — e **sem abrir a exceção 1**
>
> ⚠️ **O bloco `🛑 NÃO INICIADA` mais abaixo é histórico.** Ele registra o estado de
> 2026-08-28 e a decisão de mover a história para a S9, e fica de pé porque o raciocínio
> dele — em especial a resposta à pergunta *"mas a S8.1 entregou com um degrau sem
> fonte, por que a S8.2 não?"* — continua sendo o registro de por que esta história
> esperou. Nada nele descreve o estado atual.
>
> Módulo `retention`: `GET /retention/cohorts`, coorte mensal × plataforma, `n` por horizonte.
> Zero MySQL, zero credencial nova.
>
> | critério | estado |
> |---|---|
> | 1. Coorte mensal × plataforma, com `n` | ✅ e o `n` é **por horizonte**, não por coorte — ver abaixo |
> | 2. Coortes abaixo do mínimo **marcadas, não escondidas** | ✅ `belowMinimum`, com o mínimo em vigor publicado ao lado |
> | 3. Único ponto autorizado a fazer SQL direto | ➖ **sem objeto**: a história não faz SQL. O critério pressupunha a exceção 1, que caiu em 2026-08-29 |
>
> ### O `n` é por horizonte, e isso não é detalhe de implementação
>
> Um jogador registrado há dez dias teve oportunidade de sobreviver a um dia e **não** a trinta.
> Dividir a coorte inteira no D30 é o que faz o mês corrente sair `0,0%` — um número que se lê
> como colapso e é o calendário. Então cada horizonte conta só quem teve `N` dias de
> oportunidade e publica **essa** contagem como sua base. As três bases de uma mesma coorte
> divergem de propósito; um `n` único ao lado de três percentuais estaria errado em dois deles.
>
> Coorte cuja base madura é vazia sai `null` com `immature_horizon`. Nunca zero.
>
> ### As duas armadilhas do `HANDOFF.md`, e como cada uma foi tratada
>
> **1. Coortes antigas dando 100% por causa da unificação.** O `HANDOFF.md` é explícito que a
> fronteira de 2025-08 é *"ajuste empírico, não mecanismo"* e pede **um teste sobre o dado**. O
> que entrou é isso: uma escrita em massa deixa a **mesma** `lastSeenDate` em toda linha que
> tocou, e população orgânica não concentra um décimo de si num único dia de calendário. Os dias
> que concentram saem no payload (`stampDays`, com dia, `n` e a população sobre a qual o share
> foi tirado), e a coorte que passa do teto sai `null` com `import_artifact` **e a evidência** —
> nunca os ~100%, nunca silêncio.
>
> A detecção é por **janela de até dois dias adjacentes**, não por dia isolado, e isso saiu
> do code review: o `HANDOFF.md` diz *"idêntico **ou colado** à data da unificação"*, e
> "colado" é exatamente o caso que um teste por dia não vê — duas metades de ~8% contra um
> limiar de 10%, com a saída de uma detecção perdida sendo uma coorte publicada a 100%.
> Dois dias e não mais: com janela livre, um mês de jogo normal vira uma corrida única com
> um terço da população e o detector passa a suprimir o dado saudável.
>
> **E há uma segunda guarda, independente do detector.** Uma coorte que sobrevive a ≥99% em
> **todos** os horizontes não é retenção — coorte real perde gente já no D1 —, e essa forma
> aparece qualquer que tenha sido o espalhamento dos carimbos. É ela que fecha o caso que o
> detector populacional não enxerga: uma coorte antiga pequena, inteiramente importada, que
> cabe abaixo do limiar de 10% de 5.565 linhas. Sai `implausible_survival`, com a base
> publicada.
>
> ⚠️ **Os dois limiares do detector não estão calibrados**, e estão marcados como tal no
> `.env.example`, na mesma prateleira dos três da S6.3. Foram escolhidos por estarem
> obviamente fora de comportamento orgânico, não por medição contra esta população. **A
> primeira leitura de produção é o que vira calibração** — e a evidência necessária sai na
> própria resposta, de propósito.
>
> **2. Coorte do mês corrente imatura.** Coberta pelo filtro de maturidade, que é o mesmo
> mecanismo: não há caso especial para "mês corrente", há oportunidade contada por jogador.
>
> ### 🔴 E uma terceira, que o code review encontrou e que era pior que as duas
>
> A maturidade era medida contra o **relógio** enquanto a sobrevivência é medida contra o
> `lastSeenDate`, que vem do dado. Com a coleta parada, o calendário continua tornando todo
> jogador "maduro" enquanto nenhum pode ser observado sobrevivendo — e o módulo publicava o
> zero resultante como medição, com um `n` de aparência saudável ao lado.
>
> Isto é o apagão de três meses vestido de número certo, no módulo cujo docblock prometia
> justamente nunca fazer isso. A oportunidade passou a ser limitada por `dataThrough`, e um
> horizonte que a fonte não alcança sai `source_stale` — nunca `0,0%`. As duas ausências têm
> motivos distintos de propósito: uma diz "espere", a outra diz "a fonte morreu".
>
> ### Degradação
>
> Plan inalcançável, não configurado ou respondendo forma desconhecida → relatório **sem
> coortes e com a falha nomeada** (`not_configured` / `unreachable` / `contract_mismatch`),
> nunca um relatório de zeros. `cohorts: []` ao lado de `source.ok: false` é o contrato.
>
> Com o Plan fora do ar **e um payload anterior em cache**, o anterior é servido marcado
> `stale` com a idade — melhor que nada, e só aceitável porque a marca viaja junto. O cache
> em si é a mitigação que a §8 do spec pede (*"cache com TTL por endpoint"*) e que faltava:
> sem ele, uma aba de dashboard podia puxar as 5.565 linhas 120 vezes por janela da máquina
> do jogo, porque é o que o throttle permite.
>
> E `cohorts: []` ao lado de `source.ok: **true**` também ganhou resposta: quando a janela
> pedida cai fora do que a fonte cobre, sai `coverageWarning` dizendo isso. Sem ele, era
> indistinguível de "ninguém se registrou nesse período" — a mesma confusão que o PR #180
> consertou no funil com `coversFrom`.
>
> ### A dívida que esta história cria, e vale registrar antes que vire descoberta
>
> O corpo do `/v1/retention` foi lido em 2026-08-29, mas o que ficou registrado foram os
> **nomes dos campos e a contagem de linhas** — não os tipos JSON deles, nem o envelope. O
> parser foi escrito tolerante às três formas plausíveis de data (epoch ms, epoch s, string) e
> **recusa ruidosamente** o que não reconhece, em vez de adivinhar. É o mais perto da regra do
> repo que dá para chegar sem acesso à instância: **a primeira execução em produção é a
> observação que ninguém fez**, e ela produz ou o número ou um `contract_mismatch` que nomeia
> o campo faltante.

1. [x] Coorte mensal × plataforma, com `n`
2. [x] Coortes com `n` abaixo do mínimo configurável são marcadas, não escondidas
3. ➖ ~~Único ponto do sistema autorizado a fazer SQL direto (ADR-002), em usuário read-only,
   isolado num módulo~~ — sem objeto: nenhum SQL foi escrito

> ### 🛑 [HISTÓRICO — estado de 2026-08-28] NÃO INICIADA — três pré-requisitos abertos
>
> Avaliada em **2026-08-28**, depois de S8.0 e S8.1 entregues. Recomendação: **mover para a S9**,
> que é exatamente a válvula de escape que o próprio plano nomeia para esta história (`[CORTE]` da
> S8, e o desbalanço de 18 SP contra 13 de capacidade **em que a sprint estava antes do corte**).
>
> #### 1. `/v1/retention` nunca foi avaliado — e o spec já avisa que este é o mesmo erro
>
> A exceção 1 do ADR-002 justifica o SQL direto dizendo que *"agregação por coorte × plataforma não
> existe em nenhum endpoint"*. O próprio spec anotou em 2026-08-26:
>
> > `/v1/retention` é candidato **não avaliado**; mesma classe de afirmação de ausência que caiu na
> > exceção 2.
>
> A exceção 2 foi aberta com o argumento de que o Plan não expunha lista de servidores. Era falso —
> o endpoint existia com outro nome, e ninguém tinha olhado. **Abrir a exceção 1 sem ler o
> `/v1/retention` seria cometer o mesmo erro pela segunda vez, no mesmo ADR.**
>
> #### 2. O schema de `plan_sessions` nunca foi observado
>
> Retenção D1/D7/D30 precisa saber se o jogador teve sessão N dias depois de chegar, e isso mora em
> `plan_sessions`. Não há **nenhuma** coluna dessa tabela registrada em lugar nenhum do repo — o
> `HANDOFF.md` só menciona que ela foi consultada por engano numa investigação, sem guardar o
> formato.
>
> Escrever SQL contra schema não observado é literalmente o que fez a **S6.2** ser escrita, estimada,
> revisada, mergeada e revertida — e é a regra sob a qual todos os adapters da S7.2 e o parser da
> S8.0 foram construídos.
>
> #### 3. ~~`plan_users` não tem coortes antigas para reter~~ — **não se aplica mais**
>
> Este pré-requisito supunha que a S8.2 leria `plan_users` por SQL. Ela não lê: sai do
> `/v1/retention`, cujo corpo lido em 2026-08-29 cobre 26 meses de `registerDate`. A
> profundidade do `plan_users` deixou de ser pergunta **desta história** — e, em 2026-08-31,
> deixou de ser pergunta de qualquer história: foi medida em **2024-06-02**, 26 meses. O que
> falta ao degrau `rede` do funil nunca foi profundidade, é a **população do proxy**, que não
> está neste banco.
>
> A data de **2026-09-19** que este bloco produziu não tem base: ela saía da suposição
> acima, não de uma leitura.
>
> #### O que destrava, em ordem de custo
>
> | # | passo | custo | o que resolve | estado |
> |---|---|---|---|---|
> | 1 | `curl` no `/v1/retention` da VPS e registrar o corpo | minutos, com acesso | **eliminou** a premissa da exceção 1 | ✅ feito em 2026-08-29 |
> | 2 | `DESCRIBE plan_sessions` e registrar o schema | minutos, com acesso | destravava o pré-requisito 2 | ⬜ deixou de importar — a S8.2 não toca a tabela |
> | 3 | esperar a primeira coorte de 30 dias | até 2026-09-19 | destravava o pré-requisito 3 | ❌ sem base — a data vinha da suposição do item 3 |
>
> **Nenhum pré-requisito da S8.2 continua aberto.** O que resta é a ressalva de rótulo
> (`lastSeenDate` é intervalo de sobrevivência, não retorno no dia N) e as duas armadilhas
> de dado, ambas no [`HANDOFF.md`](../features/austv-admin/HANDOFF.md).
>
> #### "Mas a S8.1 entregou com um degrau sem fonte. Por que a S8.2 não?"
>
> É a primeira pergunta de qualquer leitor — a S8.1 é a história imediatamente anterior, no mesmo
> documento — e ela merece resposta em vez de silêncio. Três diferenças, e a terceira decide:
>
> 1. **Proporção.** Na S8.1, **três de quatro** degraus tinham fonte: o módulo saiu com conteúdo
>    real e um degrau declarado vazio. Na S8.2, **D1, D7 e D30 dependem os três de
>    `plan_sessions`**. O esqueleto sairia 100% `null` — não é o padrão da S8.1, é um contrato sem
>    nada dentro.
> 2. **Direção da declaração.** A S8.1 declarou o `survival` vazio justamente para **não** alargar
>    a exceção 1 puxando `plan_user_info`. Aqui, declarar vazio não evita nada.
> 3. **A exceção viria junto, e é ela que pode não ser necessária.** Entregar a S8.2 de verdade
>    exige exercer a exceção 1: usuário MySQL novo, credencial nova, conexão nova. Um esqueleto que
>    já traga essa arquitetura **commita a exceção antes de alguém ter feito o `curl` que pode
>    eliminá-la inteira**. Um esqueleto que não traga não entrega nenhum dos três critérios de
>    aceite — o critério 3 é literalmente *"único ponto do sistema autorizado a fazer SQL direto,
>    isolado num módulo"*.
>
> **A fatia que existiria, e foi considerada:** o **tamanho de coorte** (`n` por mês × plataforma)
> sai de `plan_users.registered` + `uuid`, que a exceção **2** já abriu — sem tocar a exceção 1.
> Endereçaria em parte os critérios 1 e 2.
>
> ### ✅ Os dois motivos do adiamento caíram em 2026-08-29
>
> Este bloco adiou a S8.2 por duas razões, e as duas eram afirmações sobre ausência que
> ninguém tinha ido conferir. Foram conferidas.
>
> 1. ~~"com profundidade de rede desde 2026-08-20 renderia um bucket parcial e nenhuma
>    retenção"~~ — **falso**. O `registerDate` do `/v1/retention` vai de 2024-06 a 2026-08:
>    26 meses, sobre a mesma população de 5566 linhas do `plan_users`. O que não veio na
>    unificação foi o histórico de **sessão** do proxy, que é outra coisa. Erro 6 do
>    [`HANDOFF.md`](../features/austv-admin/HANDOFF.md).
> 2. ~~"a alternativa de consumir `/v1/retention` está fechada porque o payload nunca foi
>    observado"~~ — **resolvido**: foi observado. 5565 linhas com `playerUUID`,
>    `registerDate`, `lastSeenDate`, `playtime`, `timeDifference`.
>
> A coerência que este bloco invocava vale nos dois sentidos: recusar o `/v1/graph` sem ver o
> payload estava certo, e **adiar por ausência sem ver o payload estava errado pelo mesmo
> motivo**. A leitura custou um `curl`.
>
> **A S8.2 sai da exceção 1 inteira.** Sem SQL, sem `plan_sessions`, sem `DESCRIBE` — os três
> pré-requisitos que este bloco listava eram o mesmo pré-requisito, e ele caiu.
>
> **Duas coisas que a implementação precisa carregar, e nenhuma é opcional:**
>
> - `lastSeenDate` mede **intervalo de sobrevivência**, não retorno no dia N. A §6.2 pede o
>   segundo. Publicar o primeiro é aceitável; publicar o primeiro chamando-o de segundo é o
>   erro de denominador que já custou uma linha do DoD desta sprint. **O rótulo vai junto do
>   número.**
> - Coortes até 2025-08 dão D1/D7/D30 de 100% por artefato da unificação, e a coorte do mês
>   corrente é imatura (D30 = 0,0% porque ninguém teve 30 dias). A primeira tem de ser
>   detectada e não publicada; a segunda sai `null`, nunca zero.

### DoD da S8

- [ ] Funil reproduz os números conhecidos: ~54% rede→survival, ~100% de entrada no tutorial
      antes de dez/2025 — **uma metade bloqueada, não as duas. A linha anterior dizia
      "inalcançável nas duas metades" e estava errada sobre a primeira.**

      **Primeira metade (~54% rede→survival): resolvida em 2026-08-31, e é inalcançável —
      agora por um motivo medido.** O `plan_users` deste banco guarda o **Survival**, não a
      rede: o proxy tem zero linhas em `plan_user_info`, e as contagens mensais da tabela são
      exatamente a coluna `survival` dos números verificados, nos oito meses.

      O bloqueio alegado antes (profundidade) era falso — `coversFrom` = **2024-06-02**, 26
      meses. O bloqueio real é que **a população da rede não está neste banco**; está no antigo,
      de onde veio a coluna `rede` daquela tabela.

      ✅ **Os dois defeitos que isso expôs foram corrigidos em 2026-08-31.** O degrau `rede`
      passou a `null` com motivo e a contagem de `plan_users` passou a alimentar o degrau
      `survival`, com a procedência no payload; o `funnel.network_to_survival` parou de dividir
      Survival por Survival e passou a `no_data` com o motivo, sem tocar no banco nem no Plan.
      A meta de ~54% **continua bloqueada** — nada disso cria a população do proxy. Detalhe no
      [`HANDOFF.md`](../features/austv-admin/HANDOFF.md) e na §6.2 do spec.

      A segunda metade merece a conta explícita, porque é fácil errar o denominador — e a primeira
      versão desta linha errou. O `~100%` sai de **tutorial ÷ survival**, não de tutorial ÷ rede.
      Na tabela de números verificados do `HANDOFF.md`, nov/2025: `694 / 682 = 101,8%` ✅, enquanto
      `694 / 1403 = 49,5%`, que não é "~100%".

      ✅ **E esta metade destravou em 2026-08-31, pelo mesmo motivo que a primeira travou.** Ela
      depende do degrau `survival`, que agora **tem** números — `694 / 682 = 101,8%` para
      nov/2025 é exatamente o par consecutivo `survival → tutorial_entrou` que o endpoint passou
      a publicar. O bloqueio alegado antes (`/v1/graph?type=uniqueAndNew` nunca observado) caiu
      junto: a fonte é `plan_users`, que já estava aqui.

      🔴 **Rodado contra produção em 2026-09-01, e NÃO é calculável lá.** O
      `/api/funnel/monthly` devolveu `tutorial_entrou: null` com
      `sources[].tutorial_daily: {ok: false, failure: "never_synced"}`: o **ETL da S8.0 não está
      configurado na VPS** (`TUTORIAL_PLAYERDATA_DIR` vazio, `TUTORIAL_SYNC_ENABLED=false`, ambos
      avisados no boot). O degrau `survival` veio certo — **687**, com `n` publicado ao lado do
      percentual nulo —, então falta só o numerador.

      O bloqueio mudou de natureza: não é mais "payload do `/v1/graph` nunca observado", é
      **configuração de ambiente ausente**. Duas variáveis separam este número de existir.
      Detalhe no [`HANDOFF.md`](../features/austv-admin/HANDOFF.md).

      A data de **2026-09-19** que aparecia aqui saía da suposição sobre `plan_users`, não de
      uma leitura, e não deve ser citada como prazo de nada.
- [x] **Nenhum endpoint retorna percentual sem `n`** — verdadeiro hoje em toda a superfície. No
      funil é **imposto pelo tipo**: em `Conversion`, a variante medida carrega os dois e
      `{ percent: 50, n: null }` não compila. Fecha o achado que a auditoria da S6 deixou em aberto.

      **Onde ainda é convenção:** os checks de saúde montam `{ observed, threshold, n }` como objeto
      literal (`HealthCheckDetail` tem os três opcionais), então nada impede um check futuro de
      omitir a base. Nenhum omite hoje, e o contrato `HealthCheck` documenta a regra — mas a
      garantia de máquina cobre o funil, não a camada de saúde. A união do funil é o molde para
      quando alguém fechar aquela também
- [ ] ~~Usuário read-only comprovadamente sem permissão de escrita — pertence à S8.2~~ —
      **deixou de pertencer**: a S8.2 consome o `/v1/retention` e não abre conexão MySQL. A
      exigência continua válida para a exceção **2**, que segue de pé, e por isso não é
      apagada daqui — só deixa de estar atrelada a esta história.
      **Confirmado ao entregar a S8.2 em 2026-09-01:** o módulo não tem MySQL nenhum, então
      não há usuário novo a provar. A pendência é integralmente da exceção 2 e do
      `PlanDatabase`, que já existia antes desta história

### Fechamento da S8 — 2026-08-28

| história | estado |
|---|---|
| **S8.0** — Fonte de dados do tutorial | ✅ **entregue** (PRs #168, #169). Fecha também o 7º check da §6.1 e o critério 5 da S6.3 |
| **S8.1** — Módulo `funnel` | ✅ **entregue** (PR #170). Corrigida em 2026-08-31: o degrau sem fonte é o **`rede`**, não o `survival` — os dois trocaram de lugar quando se mediu que `plan_users` é o Survival |
| **S8.2** — Retenção por coorte | ✅ **entregue em 2026-09-01**, dentro da Sprint 9, sem abrir a exceção 1 do ADR-002. Ver o bloco dela |

**Recomendação: mover a S8.2 para a S9**, que é a válvula de escape que o próprio plano nomeia
(`[CORTE]` da S8). Isso põe a S8 em 13 SP contra 13 de capacidade e resolve o estouro registrado no
desbalanço, sem inventar velocidade: os 5 SP da S8.2 não foram executados, foram **adiados por
falta de pré-requisito** — a mesma distinção que o `HANDOFF.md` pede que se faça ao medir a S6.

**[CORTE]** S8.2 — exercido.

---

# Sprint 9 — `ausPlanBridge` e relatório periódico

### S9.1 — Módulo `economy` (sem plugin) · 8 SP · `feat/api-economy`

Substitui o `ausPlanBridge`, adiado pelo ADR-007. **Nenhum Java, nada implantado no servidor de
jogo.**

> ## Entregue em duas fatias, e a divisão é por credencial
>
> | fatia | PR | o que exige do ambiente |
> |---|---|---|
> | **Receita — E1 + a metade entregável de E2** | `feat/api-economy-revenue` | **nada novo**: usa o `PLAN_BASE_URL` que já existe |
> | **Social — E3 + E4** | `feat/api-economy-social` | conta **read-only nova** no MySQL do PlayerPoints, na máquina do jogo |
>
> A linha divisória não é tamanho, é o que trava o deploy. A receita por plataforma é o número
> que o spec diz que **nenhuma decisão sobre Bedrock deveria ser tomada sem** — e ela sai do
> próprio `sales`, sem ETL nenhum, porque a plataforma vem do uuid da venda (ADR-003). Prendê-la
> atrás de uma credencial que ainda não existe seria segurar o número mais urgente da camada
> pelo mais lento.
>
> ### O que a fatia de receita entrega
>
> - **E1** — `GET /economy/revenue`: receita por plataforma (sem ETL) e por coorte de registro
>   (com ETL), `share` sempre com `n`, cobertura de coorte publicada mesmo quando é 100%.
> - **E2, primeira metade** — `GET /economy/first-spend`: tempo até o primeiro gasto por coorte ×
>   plataforma, com o denominador sendo a **coorte** e não os compradores.
> - **A dimensão `player` do ADR-008**, preenchida por ETL noturno sobre o `/v1/retention` — sem
>   credencial nova, sem MySQL, sem abrir a exceção 1 do ADR-002.
> - **Dinheiro nunca vira float**: a re-agregação acontece em centavos inteiros (`bigint`) e volta
>   a string decimal. O `PROJECT.md` §2.5 já exigia isso; aqui era preciso *somar*, não só
>   repassar.
> - **`historical_import` fora de todo número, e republicado ao lado.** Essas linhas têm preço
>   migrado e nenhum timestamp real por evento, então não podem ser atribuídas a uma janela nem
>   comparadas com uma data de registro. Excluir em silêncio faria estes números divergirem dos
>   endpoints de analytics por um motivo invisível.
>
> ### 🔴 A metade de E2 que NÃO foi entregue, e por quê
>
> *"Gasto por posição no funil"* — *"quem conclui o tutorial gasta mais? Quem trava no passo 03
> gasta alguma coisa?"* — precisa da posição no tutorial **de um jogador individual**, e nenhuma
> fonte deste sistema guarda isso.
>
> O `tutorial_daily` é agregado em `(dia, plataforma)` por decisão registrada da S8.0, tomada
> justamente para não trazer identidade de jogador do jogo para este banco numa pergunta que se
> responde contando. Essa decisão está certa para o funil **e é exatamente o que bloqueia esta
> métrica**; as duas coisas não podem valer ao mesmo tempo.
>
> Entregar exige persistir posição **por jogador**, o que alarga a superfície de dado pessoal que
> a §8 do spec governa — e isso é **decisão do dono, não desta sessão**. O custo de errar é
> assimétrico: métrica se adiciona na sprint seguinte, dado pessoal gravado não se desgrava.
>
> O caminho, para a decisão sair barata: uma tabela por `player_uuid` com a quest mais avançada
> alcançada, escrita pelo próprio ETL da S8.0 — que já lê esse dado e o descarta. O endpoint
> publica `byFunnelPosition: null` com esse motivo por extenso, em vez de omitir o campo.

1. [~] **E1 e E2 saem do `ausTvSales` sozinho** — receita por plataforma e coorte, tempo até o primeiro
   gasto, ~~gasto por posição no funil~~ (ver o bloco acima). **Nenhuma dependência de PlayerPoints** (R3 resolvido:
   analytics apenas, sem reconciliação)
2. [x] **ETL noturno apenas das linhas `PAY_SENDER`/`PAY_RECEIVER`** (1.332 de 6.664) para o
   PostgreSQL, em usuário read-only na origem. Tabela sem índice — nada roda ao vivo no MySQL do
   jogo (ADR-007). Idempotente e re-executável
3. [x] **E3** — contato social nos primeiros minutos e D7 desse grupo contra o resto; conclusão do
   `10tutorial` separada de interação espontânea — **por assinatura de valor, e rotulada como
   heurística**: o log registra valor, não intenção
4. [x] **E4** — feed de pagamentos **admin-only** com marcação de anomalia (valor fora do percentil,
   par repetido, conta nova recebendo alto, conta financiando muitas). Marcação é sinalização,
   nunca acusação automática — cada marca publica **o que foi observado e contra que limiar**
5. [x] Feed e valores **não** aparecem no site público em nenhuma hipótese
6. [x] Fonte indisponível → **vazio, nunca zero**; agregação pesada fora do pico
7. [x] **Grant administrativo excluído de toda métrica de receita** (R2) — **por construção**: a
   receita lê o `sales`, e o `OFFSET` de 9.999.999 nunca entra no ETL
8. [x] Regra de desempate documentada e testada com colisão proposital — ~~do join
   `transaction_log` × `ausTvSales`~~, que a R3 eliminou. **A colisão que existe de verdade é
   outra, e é pior**: a tabela de origem não tem chave primária nenhuma, então ela não distingue
   uma releitura de um segundo pagamento. Ver o bloco abaixo
9. [x] Série `SET`/`Starting balance` publicada como fonte de reconciliação do funil, cobrindo o
   apagão do Plan de mai–jul/2026 (R1) — `GET /economy/account-creations`

> ### O critério 8 aponta para uma colisão que não existe mais, e havia outra que existe
>
> A redação pede a regra de desempate do **join** `transaction_log` × `ausTvSales`. Esse join foi
> eliminado pela própria R3 em 2026-08-21: *"não existe join... o escopo é analytics apenas"*. Ler
> o critério ao pé da letra entregaria um teste sobre um cruzamento que o spec proíbe.
>
> **A colisão real é a da origem.** `playerpoints_transaction_log` **não tem chave primária**, e
> nenhum outro índice. Dois jogadores podem pagar o mesmo valor à mesma pessoa no mesmo segundo, e
> o log grava isso como duas linhas byte a byte idênticas. Uma cópia noturna precisa fazer a mesma
> coisa com elas toda noite:
>
> - **fundir** → um pagamento some para sempre, e o feed que existe para pegar abuso é o primeiro a
>   perder linha;
> - **chave surrogate por execução** → a tabela cresce pela população inteira toda noite;
> - **contar dentro da execução** → o que foi feito. A chave é
>   `(transaction_type, source, receiver, amount, occurred_at, ordinal)`, e o `ordinal` conta linhas
>   idênticas numa ordem determinística imposta pelo `ORDER BY` da consulta. A mesma entrada
>   reproduz os mesmos ordinais — é isso que faz a re-execução ser no-op — e duas linhas
>   genuinamente iguais ficam com 0 e 1, ambas vivas.
>
> Testado com colisão proposital em duas camadas: em unitário sobre a regra, e em e2e contra o
> Postgres real, onde a segunda linha só entra se a chave composta de fato incluir o ordinal.

### S9.2 — Relatório periódico no Discord · 5 SP · `feat/api-weekly-report`

> ## ✅ ENTREGUE em 2026-09-01
>
> Módulo `report`: cron opt-in (segunda 09:00 BRT), tabela `weekly_reports`, publicação em
> webhook **próprio**, e `GET /reports/weekly{,/latest,/:id}` + `POST /reports/weekly/run`.
>
> | critério | estado |
> |---|---|
> | 1. Funil, retenção por coorte e plataforma, saúde da instrumentação | ✅ as três seções, cada uma degradando por conta própria |
> | 2. `n` ao lado de cada percentual | ✅ imposto pelo tipo, não pelo cuidado do renderer |
> | 3. Falha do job avisa no canal | ✅ aviso publicado **mesmo quando o banco cai junto** — ver abaixo |
> | 4. Versão gerada persistida | ✅ payload estruturado + o texto exato que foi enviado |
>
> ### O rollup semanal recusa uma semana parcial
>
> Um degrau só é somado quando **todos** os sete dias trazem número. Faltou um, o total sai
> `null` com o motivo — e o motivo distingue *"a fonte está fora"* de *"a semana está
> incompleta"*, que são coisas diferentes e teriam a mesma cara sob um `null` mudo. Somar seis
> dias e publicar como semana é numerador menor contra denominador de semana inteira: a mesma
> forma de erro do 4500% e do mês parcial.
>
> A janela termina **ontem**, não hoje. Incluir o dia corrente faria o balde mais novo ser
> estruturalmente menor que os outros seis, e toda comparação semana-a-semana leria como queda —
> errado na mesma direção toda semana, que é o tipo mais difícil de notar.
>
> **E o motivo é por degrau**, o que não era. Os degraus de tutorial caíam no texto genérico
> *"sem fonte para este degrau"*, que culpa um ETL saudável por uma semana incompleta — e o
> imprimia na mesma linha que a nota `6/7 dias` contradizendo-o. Achado do code review.
>
> ### Markdown de terceiro é neutralizado no corpo da mensagem
>
> Nome de check por alvo carrega o nome do servidor vindo do **catálogo do Plan**, texto livre
> que este sistema não controla. Uma crase nele fecha o code span, e o resto da seção de saúde
> — inclusive a linha que diz que o ciclo de checks está desligado — some dentro de um spoiler
> ou de um fence. O `DiscordAlerter` já tinha aprendido isso; este renderer não. Quando há
> crase, o valor sai escapado e **sem** code span: dentro de um span não existe com o que
> escapar uma crase.
>
> ### Webhook próprio, sem fallback para o de alerta
>
> `DISCORD_REPORT_WEBHOOK_URL` é variável separada e **não** cai no `DISCORD_ALERT_WEBHOOK_URL`
> quando ausente. O alerta pagina; o relatório é leitura de rotina. Misturar dilui o canal de
> alerta até ninguém mais ler — que é como um canal do Discord vira mudo, e este épico já tem
> uma história sobre isso. Sem webhook o relatório ainda é gerado e persistido, e o boot avisa.
>
> ### 🔴 O critério 3 era inalcançável para a única falha que acontece de verdade
>
> Descoberto no code review. Rastreando o que pode fazer `builder.build()` estourar: o funil
> engole toda falha de fonte e a retenção transforma toda falha em rótulo fechado. A única
> dependência que **rejeita** é o read model de saúde — ou seja, o **nosso próprio Postgres**.
>
> Com o `persist` sem `try/catch` próprio, essa mesma falha fazia o `recordFailure` estourar e
> o `publishFailure` nunca era chamado. Resultado: sem linha, sem aviso vermelho, uma linha de
> log — e ausência de linha é **definida neste módulo** como "o agendador não disparou", o que
> seria falso. O modo de falha que a história existe para impedir, reproduzido pelo módulo
> construído para impedi-lo.
>
> Agora o `persist` tem catch próprio e o aviso vai ao canal com ou sem linha gravada. O canal
> é a parte que não pode depender do banco estar de pé.
>
> ### `POST /reports/weekly/run` existe por causa do DoD
>
> O DoD da S9 pede *"um relatório real gerado e conferido à mão"*. Esperar uma segunda-feira
> faria da própria conferência uma atividade de cadência semanal, e a história deste épico diz
> que o que só acontece por agendamento é o que nunca acontece. Limitado a 6 execuções por hora:
> cada uma consulta o Plan na máquina do jogo e manda mensagem no canal.
>
> 🔴 **E esse limite era inerte.** `@Throttle` sozinho é metadado; o `ThrottlerGuard` não é
> `APP_GUARD` neste app de propósito. A rota compilava, documentava-se como limitada e não
> limitava nada — na única rota com efeito colateral externo. Virou `@ManualRunThrottle()`,
> que empacota guard e perfil como o `@DashboardThrottle()` faz, e o e2e assere os cabeçalhos
> de rate limit em vez de confiar no decorador.
>
> ### A falha que este módulo **não** consegue anunciar
>
> O agendador nunca disparar. Nada dentro de um processo que não rodou pode dizer que não rodou,
> e por isso a ausência de linha em `weekly_reports` significa exatamente isso. As duas defesas
> são o aviso de boot em frase inteira e o próprio corpo do relatório, que imprime toda semana se
> o ciclo de checks está ligado.

1. [x] Semanal: funil de 4 degraus, retenção por coorte e plataforma, saúde da instrumentação
2. [x] `n` ao lado de cada percentual
3. [x] Falha do job avisa no canal — degradação honesta, nunca silêncio
4. [x] Versão gerada persistida

> ### O que a fatia social entrega, e o que ela custa ao ambiente
>
> `GET /economy/social-contact` (E3), `GET /economy/payments/feed` (E4) e
> `GET /economy/account-creations` (R1), sobre uma cópia noturna do log do PlayerPoints.
>
> **Esta é a única parte do sistema que põe uma query no banco que o servidor de Minecraft está
> usando.** A tabela não tem índice nenhum, então toda leitura é full table scan por construção —
> não existe forma de consulta que evite isso, e é literalmente o que o ADR-007 foi escrito para
> disciplinar. Daí: job noturno, opt-in, escalonado 15 minutos depois dos outros dois, e medindo o
> próprio tempo **dentro** da query.
>
> **Exige credencial nova**: usuário MySQL read-only e dedicado no `jogar.austv.net`. O usuário dos
> plugins é exatamente o que não se deve reusar — as credenciais dele estão em texto plano em
> quatro configs no servidor do jogo.
>
> **Uma premissa fica medida em vez de afirmada.** Que `PAY_SENDER` e `PAY_RECEIVER` sejam as duas
> metades de um mesmo pagamento é a leitura natural do schema e **não foi confirmada contra um
> pagamento conhecido**. Os dois tipos são copiados verbatim e contados separadamente a cada
> execução; se as contagens divergirem, a premissa caiu e o número diz isso.

### DoD da S9

- [ ] **Timings anexado ao PR provando ausência de regressão de tick** — pertence à S9.1, e
      **não é produzível fora da produção**: exige rodar o ETL contra o MySQL do PlayerPoints na
      máquina do jogo. O que a sessão pôde fazer foi instrumentar o ETL para *medir e persistir* o
      próprio tempo, de modo que a primeira execução real produza a evidência. Ver o bloco da S9.1
- [~] **Um relatório real gerado e conferido à mão** — o gatilho existe
      (`POST /reports/weekly/run`) e o caminho inteiro é exercitado no e2e contra Postgres real,
      com **todas** as fontes ausentes: o run é persistido, o corpo nomeia cada falha e nada vira
      zero. O que falta é o run em **produção**, com Plan alcançável e webhook configurado, e a
      conferência humana do texto que chega no canal. É item de dono

**[CORTE]** S9.1.

---

# Sprint 10 — Sugestões: modelo, corpus e bot

**Gate de entrada:** ~~S6.1 concluída~~ — **removido em 2026-08-22** com o cancelamento da S6.1. A S10 não depende mais de nada da S6 e pode começar quando a capacidade permitir.

> **Verificação de 2026-08-22:** planejar S10.2 e S10.3 como **construção do zero, não extensão**.
> No `Ticket-Bot` não há máquina de estados (`status` é string livre com dois valores, `"Open"` e
> `"Closed"`, sem enum e sem validação de transição — `tickets.ts:12`), não há trilha de auditoria
> persistida (só embed enviado a canal do Discord, editável e sem ID de ator — `logs.ts:13-32`) e
> não há paginação em lugar nenhum. O único ativo reaproveitável é o padrão de checagem de cargo
> do `control-close-delete.ts:29-37` — reaproveitar **por dentro do responder**, nunca por
> efemeridade, que é como o `/configuracoes` faz hoje e não checa nada.

### S10.1 — Migration + ~~importação do corpus~~ · 5 SP **(a reestimar)** · `feat/db-suggestions-schema`

> **2026-08-22:** com a S6.1 cancelada não existe corpus a importar. Sobram apenas os itens 1 e 5
> — a migration do schema e a sanitização. Os critérios 2, 3 e 4 eram todos sobre importação e
> ficam sem objeto. Os 5 SP estão superestimados; reestimar é decisão do dono.

1. Migration Drizzle cria `suggestion` conforme §7
2. ~~`created_at` **original**, nunca a data da importação~~ — sem importação. A regra continua
   valendo para sugestão nova: gravar a data do evento, nunca a do insert
3. ~~Idempotente por `discord_msg_id`~~ — sem objeto
4. ~~Reporta importados / ignorados / rejeitados com motivo~~ — sem objeto
5. Sanitização na escrita; rollback testado

### S10.2 — Estados no bot, verificados server-side · 5 SP · `feat/bot-suggestion-states`

1. `enviada → aprovada → em_andamento → concluida | recusada`; transição inválida recusada sem
   alterar registro
2. Role de staff verificada **server-side**
3. Tentativa negada é logada com autor e comando
4. Trilha de auditoria de quem mudou o quê

### S10.3 — Listagem paginada · 3 SP · `feat/bot-suggestion-pagination`

1. Filtra pelos 4 estados, paginada, com total
2. Texto escapado — sem markup nem menção em massa

**[CORTE]** S10.3.

---

# Sprint 11 — API de sugestões e métricas de guild

### S11.1 — Módulo `suggestions` · 8 SP · `feat/api-suggestions`

1. Filtra por estado, ordena por data ou votos, pagina obrigatoriamente
2. Leitura pública sem campos internos (`assignee`, auditoria)
3. Escrita exige JWT com escopo de staff
4. Texto sanitizado; contrato documenta que o consumidor ainda escapa na renderização

### S11.2 — Métricas de guild do Discord · 5 SP · `feat/bot-guild-metrics`

1. Entradas, saídas e total por dia em `guild_metric`
2. Bot offline e de volta → reconcilia, marcando o período como **"sem dados"**
3. Nenhum dado pessoal além de identificador e contagem

**[CORTE]** S11.2.

---

# Sprint 12 — Interface

### S12.1 — Página de saúde e funil · 8 SP · `feat/web-health-funnel`

1. Estado dos 7 checks, com hora da última verificação
2. Funil de 4 degraus com seletor de plataforma afetando **todos** os gráficos
3. `n` visível ao lado de cada percentual
4. Estados vazio, de erro e *stale* explícitos
5. **Reutiliza os componentes de gráfico da Sprint 5**, sem duplicar

### S12.2 — Home consolidada · 5 SP · `feat/web-admin-home`

1. Pico de jogadores, jogadores por período, tempo online **ativo**, cargos LuckPerms, últimas
   sugestões, guild
2. Card sem fonte degrada individualmente, sem derrubar a página
3. Frontend não chama o Plan diretamente
4. Não-staff não acessa, verificado server-side

### S12.3 — Sugestões públicas + gate de aceite · 5 SP · `feat/web-public-suggestions`

1. Lista `aprovada` e `em_andamento`, paginada, pública sob rate limit
2. Texto **escapado na renderização** mesmo já sanitizado — defesa em profundidade
3. Cada item da §9 do spec com status e **evidência anexada**; item que falha vira issue

### DoD da S12

- [ ] Teste de XSS na página pública com payload real
- [ ] Network trace: nenhuma chamada do frontend direto ao Plan
- [ ] `cybersecurity-validator` sobre a superfície pública completa
- [ ] Runbook de operação em português

---

## Backlog consolidado

| # | Sprint | História | SP |
|---|---|---|---|
| 1 | S6 | Baseline pré-campanha | 2 |
| ~~2~~ | S6 | ~~Corpus do Carlito~~ — **cancelada 2026-08-22** | ~~5~~ → 0 |
| ~~3~~ | S6 | ~~Unificar bancos do Plan~~ — **concluída 2026-08-20**, fora do fluxo de sprint | ~~5~~ → 0 |
| 3b | S6 | Auditar exposição do MySQL (3306) | 2 |
| 4 | S6 | **Checks de saúde + alerta** | 8 |
| ~~5~~ | S7 | ~~Módulo `health`~~ — **entregue 2026-08-26** | 5 |
| ~~6~~ | S7 | ~~`metrics` core~~ — **entregue 2026-08-26** | 8 |
| 6b | S8 | **Fonte de dados do tutorial** — *aberta 2026-08-23* | 5 |
| 7 | S8 | Módulo `funnel` (4 degraus) | 8 |
| 8 | S8 | Retenção por coorte | 5 |
| 9 | S9 | Módulo `economy` (sem plugin) | 8 |
| 10 | S9 | Relatório semanal | 5 |
| 11 | S10 | Schema + corpus importado | 5 |
| 12 | S10 | Estados no bot | 5 |
| 13 | S10 | Paginação | 3 |
| 14 | S11 | API de sugestões | 8 |
| 15 | S11 | Guild metrics | 5 |
| 16 | S12 | Página de saúde e funil | 8 |
| 17 | S12 | Home | 5 |
| 18 | S12 | Públicas + gate | 5 |

**100 SP · 7 sprints.** (105 na conferência de 2026-08-21, menos os 5 SP da S6.1 cancelada em
2026-08-22 e os 5 SP da S6.2 concluída em 2026-08-20, mais os 5 SP da S8.0 aberta em 2026-08-23)

> A S8.0 não é escopo novo: é escopo que **sempre esteve na S6.3** e foi movido quando se descobriu
> que não tinha fonte de dado. O total voltar a 100 SP registra o custo real, em vez de fazer o
> trabalho sumir da conta ao trocar de sprint.

### ⚠️ Desbalanço conhecido — decisão pendente do dono

Com a capacidade planejada de 13 SP/sprint, **restou uma sprint estourando**:

| sprint | SP | situação |
|---|---|---|
| **S6** | ~~22~~ → ~~17~~ → **12** | **resolvido.** S6.1 cancelada (−5) e S6.2 concluída fora do fluxo (−5). Dentro da capacidade |
| S7 · S9 · S10 · S11 | 13 cada | dentro |
| **S8** | ~~13~~ → ~~18~~ → **13** | **resolvido em 2026-08-28.** A S8.0 (5 SP) entrou com a fonte do tutorial e virou estouro; o `[CORTE]` foi exercido e a **S8.2** (5 SP) moveu para a S9 |
| **S12** | **18** | 38% acima. Três histórias grandes |

**Um estouro agora, não dois.** A S8 fechou movendo a **S8.2** para a S9 — a S8.0 era pré-requisito
da S8.1 e não podia sair. E o corte não foi por capacidade: a S8.2 tinha três pré-requisitos
abertos, o primeiro deles ler o `/v1/retention` antes de abrir a exceção 1 do ADR-002.

**Os três caíram em 2026-08-29**, quando a leitura foi feita: a S8.2 sai do endpoint e não
precisa da exceção 1. Ver o bloco da história.

**Resta a S12**, e dividi-la em duas segue sendo a única decisão de escopo do dono.

**A S6 é sprint de prazo, não de capacidade.** O limite dela é a data do unban all, não a
velocidade — e a questão de capacidade dela **fechou sozinha**. Opções:

1. ~~**Aceitar 17 SP como sprint estendida**~~ — **sem objeto desde 2026-08-23**: a S6 está em
   12 SP, abaixo dos 13 de capacidade. Não precisa ser estendida
2. ~~**Mover S6.1 para a S7**~~ — **sem objeto desde 2026-08-22**: a S6.1 foi cancelada
3. **Dividir a S12 em duas** (S12 + S13), voltando para 8 sprints — **segue de pé, e é a única
   decisão que resta**

**A decidir antes de abrir o worktree da S12** (não mais o da S6, que já está em execução).

> Nota de calibração: duas das três sprints "estouradas" do plano original se resolveram por
> **descoberta**, não por execução — trabalho que não existia (S6.1) ou que já estava feito (S6.2).
> Isso não é velocidade, e não deve ser lido como tal ao medir a S6.

## Dependências

```
S6.0 (baseline) ─── independente, tem prazo externo
S10.1 ─► S10.2 ─► S10.3            (a S6.1 era o gate; cancelada, S10 nao depende da S6)
S6.3 (saude, 6/7) ─► S7.1 ──────────────────────────► S12.1
      └───────────────► S7.2 ─► S8.1 ─────────────────► S12.1
                                 └► S8.2 ─► S9.2
S8.0 (fonte do tutorial) ─► S8.1 (degrau tutorial_entrou)
      └──────────────────► fecha o 7o check da S6.3, retroativamente
   (a S6.2 era o gate da S6.3; concluida 2026-08-20, a S6.3 nao depende de nada)
S9.1 (economy) ───────────────────────────────────► S12.2
S11.1 ────────────────────────────────────────────► S12.3
S11.2 ────────────────────────────────────────────► S12.2
Sprint 5 (graficos) ──────────────────────────────► S12.1
```

Nenhuma seta aponta para trás.

## Perguntas abertas (não são código)

1. **O que aconteceu em fevereiro/2026?** Aquisição caiu de 1.177 para 645. Nenhuma hipótese
   testada.
2. **Os `java_offline` do proxy são bots?** 39,3% de conversão contra 71,5% do Bedrock.
3. **O conserto do tutorial pegou?** Verificar em 5–7 dias se a taxa de entrada voltou a ~100%.
4. **Onde roda o bot do Discord?** Afeta rede e gestão de segredos na S10.
5. ~~`playerpoints_transaction_log` tem histórico?~~ **Respondido em 2026-08-21:** 6.664 linhas
   desde 2026-01-30; economia é prospectiva; `description` **não** classifica o gasto —
   `ausTvSales` segue obrigatório.
6. ~~Como casar `transaction_log` com `ausTvSales`?~~ **Resolvido em 2026-08-21:** não se casa.
   Analytics apenas; gasto vem do `ausTvSales`, social vem do PlayerPoints. **S9.1 desbloqueada,
   sem alteração de plugin.**
