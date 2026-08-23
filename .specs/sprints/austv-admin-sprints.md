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
(`jogar.austv.net` / `198.89.99.229`, produção do Minecraft). O ETL cruza entre elas.

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

1. Os 7 checks da §6.1 do spec implementados e agendados
2. Falha dispara **alerta ativo no canal do Discord**, não espera alguém abrir página
3. Estado de cada check persistido em `health_check`, com histórico
4. **Verificado derrubando uma instância de propósito** — o alerta precisa chegar
5. Alerta de taxa de entrada no tutorial testado com valor forçado
6. Alerta repetido é agrupado, não vira flood

### DoD da S6

- [x] `plan_servers` mostra proxy e backends num único banco, mesma build — **feito em 2026-08-20**,
      fora do fluxo de sprint (ver S6.2)
- [ ] ~~Dump restaurável dos dois bancos guardado fora da VPS~~ — sem objeto: a unificação já
      aconteceu e não existem mais "dois bancos" a dumpar
- [ ] Alerta comprovado por teste destrutivo intencional
- [ ] Baseline pré-campanha commitado
- [ ] Spec órfão `specs/spec.md` (coleta de sessão no proxy) marcado superseded

### Riscos

| risco | mitigação |
|---|---|
| ~~Builds diferentes corrompendo schema~~ | **não materializado** — em 2026-08-20 os bancos foram unificados com as builds já iguais. O check `plan.version_divergence` (S6.3) passa a vigiar isso de forma contínua |
| Reinício do Paper/Velocity | janela fora de pico, anunciada |
| Unban chegando antes da sprint fechar | com a S6.1 cancelada e a S6.2 concluída fora do fluxo, resta a S6.3 (8 SP) — não cortável, é a razão de ser da sprint. A S6 agora cabe nos 13 SP de capacidade |

**[CORTE]** ~~S6.1~~ — cancelada. A S6 segue **sem história cortável**: S6.0 e S6.3 são não-cortáveis. A pressão sobre a válvula de escape caiu de qualquer forma — com a S6.2 concluída em 2026-08-20, a sprint tem 12 SP contra 13 de capacidade e não precisa mais de corte.

---

# Sprint 7 — API: saúde exposta e núcleo de métricas

### S7.1 — Módulo `health` no NestJS · 5 SP · `feat/api-health`

1. Expõe estado de cada check com histórico e timestamp da última verificação
2. Endpoint de status agregado para uso externo (uptime check)
3. Sob JWT; nenhum dado de jogador exposto aqui

### S7.2 — Módulo `metrics`: client do Plan, cache e visão de servidor · 8 SP · `feat/api-metrics-core`

1. Visão de servidor e de online normalizadas para o contrato da §7
2. Cache com **TTL por endpoint**, observável em log
3. Plan fora do ar → 503 com corpo explícito e último valor cacheado marcado *stale*; **nunca zero
   inventado**
4. **Nenhuma referência a tabela interna do Plan** (ADR-002)
5. Guard JWT, DTO validado, Helmet, throttling, Swagger

### DoD da S7

- [ ] Busca por nome de tabela do Plan no diff retorna vazio (fora do módulo de coorte)
- [ ] Teste de falha: Plan derrubado → 503/stale sem exceção não tratada
- [ ] 401 sem token e 429 sob flood verificados por teste de integração

**[CORTE]** S7.1 pode sair se a S6.3 já entregar visibilidade suficiente no Discord.

---

# Sprint 8 — O funil de 4 degraus

**Objetivo:** transformar a descoberta da investigação em métrica contínua.

### S8.1 — Módulo `funnel` · 8 SP · `feat/api-funnel`

1. Série diária e mensal de `rede → survival → tutorial_entrou → tutorial_concluiu`
2. Cada degrau segmentável por `platform` (ADR-003, direto do UUID)
3. **`n` retornado junto de todo percentual** — o contrato não permite percentual sem base
4. Período sem dados → "sem dados" explícito, distinto de zero
5. Agregação pesada em job **fora do pico**; falha mantém último resultado válido, datado

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
| 5 | S7 | Módulo `health` | 5 |
| 6 | S7 | `metrics` core | 8 |
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

**95 SP · 7 sprints.** (105 na conferência de 2026-08-21, menos os 5 SP da S6.1 cancelada em
2026-08-22 e os 5 SP da S6.2, concluída pelo dono em 2026-08-20 e reconhecida em 2026-08-23)

### ⚠️ Desbalanço conhecido — decisão pendente do dono

Com a capacidade planejada de 13 SP/sprint, **restou uma sprint estourando**:

| sprint | SP | situação |
|---|---|---|
| **S6** | ~~22~~ → ~~17~~ → **12** | **resolvido.** S6.1 cancelada (−5) e S6.2 concluída fora do fluxo (−5). Dentro da capacidade |
| S7–S11 | 13 cada | dentro |
| **S12** | **18** | 38% acima. Três histórias grandes — **único estouro restante** |

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
S6.3 (saude) ─► S7.1 ───────────────────────────────► S12.1
      └───────► S7.2 ─► S8.1 ────────────────────────► S12.1
                        └► S8.2 ─► S9.2
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
