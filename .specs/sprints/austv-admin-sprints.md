# AusTV Admin — Plano de Sprints (v2: S6 → S12)

> `.specs/sprints/austv-admin-sprints.md` · Revisão 2026-08-21
> Base: [`.specs/features/austv-admin/spec.md`](../features/austv-admin/spec.md) (v2)
> Sprints de 1 semana. Numeração a partir de 6 (S1–S4 entregues, S5 em voo).

## Mudanças da v1

| v1 | v2 | motivo |
|---|---|---|
| S7 inteira: DataExtension de plataforma (13 SP) | **eliminada** | ADR-003 — plataforma sai do UUID em SQL, 100% de acerto |
| ausPlanBridge (plugin Java) | **adiado para v2** | ADR-007 — economia já está em banco; **zero Java na v1** |
| S6 = instalar e validar contrato | S6 = **unificar bancos + saúde + baseline** | Plan já instalado, em dois bancos, e já ficou 3 meses morto sem ninguém ver |
| Saúde da instrumentação: inexistente | **PR 1, antes de qualquer gráfico** | ADR-006 |
| Funil: só tutorial | **4 degraus** (rede → survival → tutorial → retenção) | descoberta do degrau de 54% |
| 104 SP / 8 sprints | **86 SP / 7 sprints** | |

Capacidade planejada 13 SP/semana. **Medir a S6 e recalibrar** — se a velocidade real for 6–8 SP,
isto é um plano de 11–14 semanas, não de 7.

Precedência: correções do funil de onboarding vêm na frente. Cada sprint marca uma história
**[CORTE]**.

## Definition of Done — global

- PR único, uma responsabilidade lógica, **deployável sozinho**
- Branch em worktree `.claude/.worktrees/<branch>`; zero commits em `main`/`dev`/`prod`
- Conventional Commits
- `code-reviewer` aprovado · `cybersecurity-validator` sem crítico (OWASP) · testes passando em CI
- Nenhum segredo versionado
- Código em inglês; docs em português
- Rollback documentado no PR body

---

# Sprint 6 — Instrumentação confiável antes da campanha

**Objetivo:** um único banco, versões alinhadas, coleta viva e vigiada, e o "antes" congelado. Esta
sprint tem **prazo externo**: precisa fechar antes do unban all.

### S6.0 — Baseline pré-campanha · 2 SP · `chore/pre-campaign-baseline`

Rodar os três `austv-diagnostico*.ps1` uma última vez e versionar scripts + saída.

1. Saída dos 3 scripts commitada com data do snapshot
2. README em português explicando o que cada número mede e suas limitações
3. **Irreversível se atrasar** — depois da campanha os arquivos mudam

### S6.1 — Corpus do Carlito · **PR 0, BLOQUEANTE** · 5 SP · `chore/carlito-corpus-export`

1. JSONL + CSV com `id`, `autor`, `texto`, `votos_up`, `votos_down`, `data_criacao`,
   `discord_msg_id`
2. Total reportado contra a estimativa de ~3.028; divergência documentada
3. Sem exportação nativa → raspagem via bot, mesmo schema
4. Sanitização de PII + checksum no PR

### S6.2b — Auditar exposição de rede da máquina do game · 2 SP · `chore/db-network-exposure`

Arquitetura: **duas máquinas** — VPS (sales.austv.net, hospeda o `ausTvSales`) e game
(jogar.austv.net / 198.89.99.229, produção do Minecraft). O ETL cruza entre elas.

Método **autoritativo** (não sondagem de porta — teste rodado na própria máquina do game é loopback
e não vale):

1. `ss -tlnp | grep -E ':(3306|25504|25505)'` → interface de escuta de cada serviço, documentada
2. `ufw status verbose` (ou `iptables -S`) → regra efetiva de cada porta, documentada
3. **Estado alvo:** MySQL e webserver do Plan alcançáveis **apenas** pelo IP da VPS (allowlist de
   firewall ou túnel SSH)
4. Webserver do Plan **não** pode ir para `127.0.0.1` — o NestJS na VPS precisa dele pela rede.
   Duas camadas: firewall + whitelist de IP do próprio Plan, ambas restritas ao IP da VPS
   - 4b. Testar se a whitelist do Plan é contornável por `X-Forwarded-For` (`curl` com e sem o
     header); resultado documentado
5. Usuário **read-only** dedicado para o ETL, separado dos usuários dos plugins
6. Nenhuma credencial nova em arquivo versionado

### S6.2 — Unificar os bancos do Plan · 5 SP · `chore/plan-single-database`

1. `mysqldump` dos dois bancos **antes de qualquer alteração**, com restore testado
2. Proxy e backends na **mesma build** do Plan (hoje 5.6 b2959 vs b2965)
3. Proxy repontado para o MySQL único; webserver só no proxy, em `127.0.0.1`, autenticado
4. `ServerInfoFile.yml` **não** copiado entre servidores
5. `/plan reload` em todas as instâncias; `plan_servers` mostra proxy e backends no mesmo banco
6. Banco antigo do proxy preservado como arquivo somente leitura, documentado
7. Varredura externa confirma que a porta do Plan não responde

### S6.3 — Checks de saúde + alerta no Discord · 8 SP · `feat/instrumentation-health`

A entrega mais importante do plano. Sem ela, tudo pode parar em silêncio de novo.

1. Os 7 checks da §6.1 do spec implementados e agendados
2. Falha dispara **alerta ativo no canal do Discord**, não espera alguém abrir página
3. Estado de cada check persistido em `health_check`, com histórico
4. **Verificado derrubando uma instância de propósito** — o alerta precisa chegar
5. Alerta de taxa de entrada no tutorial testado com valor forçado
6. Alerta repetido é agrupado, não vira flood

### DoD da S6

- `plan_servers` mostra proxy e backends num único banco, mesma build
- Dump restaurável dos dois bancos guardado fora da VPS
- Alerta comprovado por teste destrutivo intencional
- Baseline pré-campanha commitado
- Corpus do Carlito no repo — **gate do épico de sugestões**
- Spec órfão `specs/spec.md` (coleta de sessão no proxy) marcado superseded

### Riscos

| risco | mitigação |
|---|---|
| Builds diferentes corrompendo schema | igualar versão antes de unificar; dump antes |
| Reinício do Paper/Velocity | janela fora de pico, anunciada |
| Unban chegando antes da sprint fechar | S6.2 e S6.3 não são cortáveis; corte S6.1 se precisar |

**[CORTE]** S6.1 (o corpus não some se o bot não for trocado). S6.0, S6.2 e S6.3 não são cortáveis.

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

- Busca por nome de tabela do Plan no diff retorna vazio (fora do módulo de coorte)
- Teste de falha: Plan derrubado → 503/stale sem exceção não tratada
- 401 sem token e 429 sob flood verificados por teste de integração

**[CORTE]** S7.1 pode sair se a S6.3 já entregar visibilidade suficiente no Discord.

---

# Sprint 8 — O funil de 4 degraus

**Objetivo:** transformar a descoberta da investigação em métrica contínua.

### S8.1 — Módulo `funnel` · 8 SP · `feat/api-funnel`

1. Série diária e mensal de rede → survival → `tutorial_entrou` → `tutorial_concluiu`
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

- Funil reproduz os números conhecidos: ~54% rede→survival, ~100% de entrada no tutorial antes de
  dez/2025
- Nenhum endpoint retorna percentual sem `n`
- Usuário read-only comprovadamente sem permissão de escrita

**[CORTE]** S8.2.

---

# Sprint 9 — ausPlanBridge e relatório periódico

### S9.1 — Módulo `economy` (sem plugin) · 8 SP · `feat/api-economy`

Substitui o ausPlanBridge, adiado pelo ADR-007. **Nenhum Java, nada implantado no servidor de
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

- Timings anexado ao PR provando ausência de regressão de tick
- Um relatório real gerado e conferido à mão

**[CORTE]** S9.1.

---

# Sprint 10 — Sugestões: modelo, corpus e bot

**Gate de entrada:** S6.1 concluída.

### S10.1 — Migration + importação do corpus · 5 SP · `feat/db-suggestions-schema`

1. Migration Drizzle cria `suggestion` conforme §7
2. `created_at` **original**, nunca a data da importação
3. Idempotente por `discord_msg_id`
4. Reporta importados / ignorados / rejeitados com motivo
5. Sanitização na escrita; rollback testado

### S10.2 — Estados no bot, verificados server-side · 5 SP · `feat/bot-suggestion-states`

1. `enviada` → `aprovada` → `em_andamento` → `concluida` | `recusada`; transição inválida recusada
   sem alterar registro
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

- Teste de XSS na página pública com payload real
- Network trace: nenhuma chamada do frontend direto ao Plan
- `cybersecurity-validator` sobre a superfície pública completa
- Runbook de operação em português

---

## Backlog consolidado

| # | Sprint | História | SP |
|---|---|---|---|
| 1 | S6 | Baseline pré-campanha | 2 |
| 2 | S6 | Corpus do Carlito | 5 |
| 3 | S6 | Unificar bancos do Plan | 5 |
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

**88 SP · 7 sprints.**

## Dependências

```
S6.0 (baseline) ─── independente, tem prazo externo

S6.1 (corpus) ─────────────────────► S10.1 ─► S10.2 ─► S10.3

S6.2 (banco unico) ─► S6.3 (saude) ─► S7.1 ─────────► S12.1
                            └──────► S7.2 ─► S8.1 ──► S12.1
                                            └► S8.2 ─► S9.2

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
5. `playerpoints_transaction_log` tem histórico? **Respondido em 2026-08-21:** 6.664 linhas desde
   2026-01-30; economia é prospectiva; `description` **não** classifica o gasto — `ausTvSales`
   segue obrigatório.
6. Como casar `transaction_log` com `ausTvSales`? **Resolvido em 2026-08-21:** não se casa.
   Analytics apenas; gasto vem do `ausTvSales`, social vem do PlayerPoints. **S9.1 desbloqueada,
   sem alteração de plugin.**
