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
| Funil: só tutorial | **4 degraus** (rede → survival → tutorial → retenção) | descoberta do degrau de 54% |
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
4. [ ] **Verificado derrubando uma instância de propósito** — o alerta precisa chegar.
   **Pendente:** exige o agendamento ligado com webhook num ambiente real. É o **último item aberto
   da S6** e a promessa raiz do épico
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
   quatro degraus**. O `survival` está no contrato de todo bucket, mas sem números e **com o motivo
   escrito**; ver o bloco abaixo
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

> #### ⚠️ O degrau `survival` ficou sem série diária, e isso é uma lacuna real
>
> É o degrau cuja descoberta abriu o épico — **54% de quem conecta na rede nunca chega ao
> survival** —, então vale dizer alto em vez de deixar alguém notar.
>
> Uma **série diária** de chegadas a um backend precisa de uma de duas fontes, e nenhuma está ao
> alcance desta história:
>
> 1. **`/v1/graph?type=uniqueAndNew`** — o endpoint certo, mas **ninguém observou o payload dele**.
>    Escrever parser contra forma imaginada é o erro que fez a S6.2 ser escrita, mergeada e
>    revertida, e é a regra sob a qual os adapters da S7.2 foram construídos.
> 2. **`plan_user_info`**, que registra a entrada por servidor — mas essa tabela é a **exceção 1** do
>    ADR-002, escopada ao módulo de coorte da **S8.2**. Puxá-la aqui seria alargar uma exceção que
>    pertence a outra história.
>
> **O sinal não sumiu do sistema, só desta série:** a conversão rede→servidor em janela de 7 dias
> existe e é vigiada continuamente pelo check `funnel.network_to_survival` desde a S6.3.
>
> Fechar isto é observar o corpo do `/v1/graph` numa instância viva — trabalho de minutos com acesso,
> impossível sem ele.
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

> #### E o item 1 do DoD da S8 não é verificável hoje, nas **duas** metades
>
> *"Funil reproduz os números conhecidos: ~54% rede→survival, ~100% de entrada no tutorial antes de
> dez/2025."*
>
> - **~54% rede→survival** — o degrau `survival` não tem série diária (bloco acima).
> - **~100% antes de dez/2025** — igualmente impossível, e por um motivo diferente: `plan_users`
>   **perdeu o histórico do proxy** na unificação de 2026-08-20 (`HANDOFF.md`, "Restrição nova para
>   o baseline da campanha"). Não há denominador de rede anterior a essa data, então a taxa de
>   dez/2025 não tem como ser calculada a partir desta fonte.
>
> O funil **não finge** conseguir: buckets anteriores à cobertura de `plan_users` saem com `rede:
> null` e motivo, nunca com um zero medido. Sem essa guarda, o período default mensal publicaria
> doze meses de `rede: 0` ao lado de números reais de tutorial — um funil onde mais gente entra no
> tutorial do que conecta na rede.

### S8.2 — Retenção D1/D7/D30 por coorte e plataforma · 5 SP · `feat/api-cohort-retention`

1. Coorte mensal × plataforma, com `n`
2. Coortes com `n` abaixo do mínimo configurável são marcadas, não escondidas
3. Único ponto do sistema autorizado a fazer SQL direto (ADR-002), em usuário read-only, isolado
   num módulo

### DoD da S8

- [ ] Funil reproduz os números conhecidos: ~54% rede→survival, ~100% de entrada no tutorial antes
      de dez/2025
- [ ] Nenhum endpoint retorna percentual sem `n`
- [ ] Usuário read-only comprovadamente sem permissão de escrita

**[CORTE]** S8.2.

---

# Sprint 9 — `ausPlanBridge` e relatório periódico

### S9.1 — Módulo `economy` (sem plugin) · 8 SP · `feat/api-economy`

Substitui o `ausPlanBridge`, adiado pelo ADR-007. **Nenhum Java, nada implantado no servidor de
jogo.**

1. **E1 e E2 saem do `ausTvSales` sozinho** — receita por plataforma e coorte, tempo até o primeiro
   gasto, gasto por posição no funil. **Nenhuma dependência de PlayerPoints** (R3 resolvido:
   analytics apenas, sem reconciliação)
2. **ETL noturno apenas das linhas `PAY_SENDER`/`PAY_RECEIVER`** (1.332 de 6.664) para o
   PostgreSQL, em usuário read-only na origem. Tabela sem índice — nada roda ao vivo no MySQL do
   jogo (ADR-007). Idempotente e re-executável
3. **E3** — contato social nos primeiros minutos e D7 desse grupo contra o resto; conclusão do
   `10tutorial` separada de interação espontânea
4. **E4** — feed de pagamentos **admin-only** com marcação de anomalia (valor fora do percentil,
   par repetido, conta nova recebendo alto, conta financiando muitas). Marcação é sinalização,
   nunca acusação automática
5. Feed e valores **não** aparecem no site público em nenhuma hipótese
6. Fonte indisponível → **vazio, nunca zero**; agregação pesada fora do pico
7. **Grant administrativo excluído de toda métrica de receita** (R2 — existe linha de 9.999.999 na
   origem)
8. Regra de desempate do join `transaction_log` × `ausTvSales` documentada e testada com colisão
   proposital (R3)
9. Série `SET`/`Starting balance` publicada como fonte de reconciliação do funil, cobrindo o apagão
   do Plan de mai–jul/2026 (R1)

### S9.2 — Relatório periódico no Discord · 5 SP · `feat/api-weekly-report`

1. Semanal: funil de 4 degraus, retenção por coorte e plataforma, saúde da instrumentação
2. `n` ao lado de cada percentual
3. Falha do job avisa no canal — degradação honesta, nunca silêncio
4. Versão gerada persistida

### DoD da S9

- [ ] Timings anexado ao PR provando ausência de regressão de tick
- [ ] Um relatório real gerado e conferido à mão

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
| **S8** | ~~13~~ → **18** | **novo estouro (2026-08-23):** a S8.0 (5 SP) entrou com a fonte do tutorial |
| **S12** | **18** | 38% acima. Três histórias grandes |

**Dois estouros agora, não um.** A S8 pode ser aliviada movendo a **S8.2** (retenção por coorte,
5 SP, já marcada `[CORTE]`) para a S9 — a S8.0 é pré-requisito da S8.1 e não pode sair. Decisão do
dono, junto com a da S12.

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
