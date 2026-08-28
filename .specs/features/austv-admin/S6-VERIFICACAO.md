# Sprint 6 — verificação de entrega

> Auditoria de 2026-08-27, feita contra o repositório em `main` (`5a11a34`), não contra os
> documentos de sprint. Onde o documento e o código discordam, **o código é o fato** e a divergência
> está registrada abaixo.
>
> Escopo: as quatro histórias da milestone `AusTV Admin S6` (#106, #107, #108, #109) e a DoD da
> sprint no [plano](../../sprints/austv-admin-sprints.md).
>
> **Atualização de 2026-08-28.** A S8.0 fechou dois critérios da S6.3 — o 7º check e o alerta com
> valor forçado. As linhas afetadas estão marcadas *in loco*; o resto do documento continua sendo o
> retrato de 27/08 e é lido como tal. **O critério 4 — derrubar uma instância de propósito — segue
> aberto**, e é o achado central deste documento, não uma pendência de contagem.

## Resumo em uma tabela

| história | fechada em | veredito |
|---|---|---|
| S6.0 — Baseline pré-campanha (#106) | 2026-08-23 | ✅ **entregue**, com uma perda declarada |
| S6.2 — Unificar bancos (#108) | 2026-08-23 | ✅ **concluída fora do fluxo** pelo dono em 2026-08-20 |
| S6.2b — Auditar exposição de rede (#107) | 2026-08-23 | ⚠️ **instrumento entregue, medição nunca registrada** |
| S6.3 — Checks de saúde + alerta (#109) | 2026-08-23 | ⚠️ **6 de 7 checks entregues** (7 desde 28/08, ver atualização); **o alerta nunca foi comprovado** |

**Nenhuma história foi entregue de forma incorreta.** Duas foram fechadas com critérios de aceite
sem evidência — e as duas falham pelo **mesmo motivo estrutural**, que é o achado central desta
auditoria.

## O achado central: o padrão é "construímos o instrumento, não fizemos a medição"

A S6.2b e a S6.3 fecharam com o mesmo tipo de lacuna, e não é coincidência:

| história | o que foi construído | o que ficou por fazer |
|---|---|---|
| S6.2b | dois scripts de auditoria + runbook + template de relatório | **rodar os scripts e commitar o relatório** |
| S6.3 | sete peças de código, seis checks, agendador | **ligar o agendamento e derrubar uma instância** |

Nos dois casos o trabalho que sobrou é o que exige **tocar um ambiente real**, e nos dois casos é
justamente o passo que converte "parece funcionar" em "funciona". Um check que nunca disparou é um
check não testado; um script de auditoria que nunca rodou é uma pergunta que ninguém fez.

Isso importa mais do que a contagem de SP porque a §1 do spec define o objetivo do épico inteiro
como *"tornar impossível a cegueira silenciosa"*. Um alerta não verificado é exatamente uma cegueira
silenciosa com um verniz de instrumentação por cima — a **confiança falsa** que o ADR-006 nomeia
como pior que nenhum painel.

---

## S6.0 — Baseline pré-campanha (#106) · ✅ entregue

| critério | evidência | veredito |
|---|---|---|
| Os cinco scripts localizados e versionados | `ops/baseline/scripts/` tem **2 de 5** | ⚠️ parcial, **declarado** |
| Saída dos 3 scripts commitada, com data no nome | `ops/baseline/2026-08-19/` com 2 saídas | ⚠️ parcial, **declarado** |
| README explicando o que cada número mede e suas limitações | `ops/baseline/README.md` | ✅ |
| Execução **antes** do unban all, com data registrada | as-of `2026-08-19 20:20`, no README e no cabeçalho de cada saída | ✅ |
| Nenhum dado pessoal além do necessário | saídas são agregados; sem nick, sem IP | ✅ |

**Por que continua "entregue" com dois critérios parciais.** A ausência dos três artefatos
(`austv-diagnostico3.ps1`, `plan-forense.sh`, `plan-analise.sql`) está **no próprio README**, com a
lista dos lugares onde foram procurados e a instrução de não repetir a busca. Isso é o oposto de uma
lacuna silenciosa: é uma perda registrada, com o custo dito. O objetivo da história — congelar o
"antes" antes do unban — foi cumprido, e é irreversível se atrasar.

**Qualidade acima do critério:** os scripts foram versionados *verbatim* com `md5` conferido contra
a origem, o que dá valor probatório ao par script↔saída. O README documenta e justifica a exceção à
convenção "código em inglês" (traduzir quebraria o pareamento com os rótulos das saídas).

---

## S6.2 — Unificar os bancos do Plan (#108) · ✅ concluída fora do fluxo

Executada pelo dono em **2026-08-20**, antes de a história ser aberta. Confirmado por ele em
2026-08-23. Não houve PR porque unificar banco é operação de infraestrutura, não mudança de código.

O runbook escrito para guiar o procedimento (PR #126) foi **revertido** (PR #132) por descrever um
estado que já não existia. O plano de sprints registra o erro de método honestamente: a história foi
estimada em 5 SP sobre uma premissa nunca confirmada com o dono.

**Nada a verificar aqui além do que já está registrado.** O estado final virou invariante vigiada
pelos checks `plan.orphan_instance` e `plan.version_divergence`, o que é a forma certa de tratá-lo.

---

## S6.2b — Auditar exposição de rede (#107) · ⚠️ instrumento entregue, medição nunca registrada

Sete critérios de aceite. **Nenhum tem registro commitado.**

```
ops/audit/
├── README.md                       ← runbook: como rodar, e por que sondagem de porta não serve
├── game-listen-and-firewall.sh     ← roda na máquina do game
├── plan-whitelist-bypass.sh        ← roda na VPS
└── exposure-report-TEMPLATE.md     ← TEMPLATE. Não existe nenhum relatório preenchido
```

| critério | estado |
|---|---|
| `ss -tlnp` → interface de escuta documentada | ❌ sem relatório |
| `ufw status verbose` → regra efetiva documentada | ❌ sem relatório |
| Estado alvo: MySQL e Plan alcançáveis só pelo IP da VPS | ❌ não verificado |
| Webserver do Plan não em `127.0.0.1`, duas camadas | ❌ não verificado |
| Whitelist contornável por `X-Forwarded-For`, documentado | 🟡 **respondido fora da história**: o `HANDOFF.md` registra `Use_X-Forwarded-For_Header: false`, lido do config do Plan em 2026-08-23. Não é o teste que o critério pede, mas responde a pergunta com evidência mais forte |
| Usuário read-only dedicado para o ETL | 🟡 **documentado, não provisionado**: o `.env.example` traz o `CREATE USER` + `GRANT SELECT` nas duas tabelas da exceção 2. Ninguém confirmou que existe no MySQL do game |
| Nenhuma credencial nova em arquivo versionado | ✅ verificado: `.env.example` só tem placeholders |

**O que a auditoria de fato entregou, e não é pouco:** o *método*. O README acerta a parte mais
fácil de errar — teste rodado na própria máquina do game é loopback e não vale — e os dois scripts
têm pontos de vista deliberadamente diferentes. Isso é o que separa esta auditoria do `nmap` que a
investigação original teve de descartar porque o controle falhou.

**Mas o registro técnico é o produto da história**, não o script. O objetivo declarado na issue é
literal: *"produzir o registro técnico do estado atual, porque o ETL vai assumir que essa rede é
alcançável"*. Sem relatório, quando o ETL da S9.1 parar, não haverá linha de base para dizer o que
mudou — que é exatamente a função que a issue atribui a este documento.

### Custo de não fechar, e o prazo

O `CLAUDE.md` e o `HANDOFF.md` já listam a leitura da whitelist do `config.yml` do Plan como
verificação pendente **antes do unban all**. Ela é um dos passos deste mesmo runbook. Ou seja: a
S6.2b não está apenas incompleta, ela é o veículo natural de uma verificação que já foi julgada
urgente por outro caminho.

Estado das três camadas, com a idade de cada linha (o princípio é da §11 3b1 do spec — *filtro de
aplicação nunca substitui filtro de rede*):

| camada | estado | quando foi visto |
|---|---|---|
| firewall de rede | `ufw` inativo | 2026-08-21, **não reverificado** |
| whitelist de aplicação | existe; recusou ao menos um IP | conteúdo **nunca lido** |
| autenticação | **desligada** (`authRequired: false`) | 2026-08-26, medido |

---

## S6.3 — Checks de saúde + alerta no Discord (#109) · ⚠️ 6 de 7, e o alerta nunca chegou

### O que está de pé, verificado no código

| critério | evidência no repositório | veredito |
|---|---|---|
| Os 7 checks implementados e agendados | 6 classes registradas no token `HEALTH_CHECKS` na data desta auditoria; a **sétima entrou em 2026-08-28** pela S8.0. `HealthCheckScheduler` com intervalo, opt-in e carência no boot | ✅ **fechado**, 6 aqui e 7 desde 28/08 |
| Falha dispara alerta ativo no Discord | `DiscordAlerter` + `HealthCheckRunner` anunciam `breached` e `error` | ✅ no código |
| Estado persistido em `health_check`, com histórico | tabela `health_checks` **append-only** (migration `0002`), uma linha por execução, índice `(check_name, checked_at desc)` | ✅ |
| **Verificado derrubando uma instância de propósito** | — | ❌ **nunca feito** |
| Alerta de tutorial testado com valor forçado | `tutorial-entry-rate.alert.spec.ts`, desde 2026-08-28 | ✅ **fechado na S8.0** — força 12 de 100 e assere sobre o payload do webhook |
| Alerta repetido é agrupado, não vira flood | `alert-policy` com `HEALTH_ALERT_REALERT_HOURS` (24h) | ✅ no código |

Os seis checks presentes **na data desta auditoria**: `plan.collection_alive`,
`plan.proxy_registration_alive`, `plan.orphan_instance`, `plan.version_divergence`,
`funnel.network_to_survival`, `platform.offline_account_share`.

> **Atualizado em 2026-08-28 — são sete.** A S8.0 construiu a fonte do tutorial
> ([ADR-0004](../../decisions/ADR-0004-fonte-dados-tutorial.md)) e
> `funnel.tutorial_entry_rate` entrou no registro. O critério 1 da S6.3 fechou retroativamente, e o
> critério 5 (*alerta testado com valor forçado*) também.
>
> **O critério 4 continua aberto, e nada nesta atualização o toca.** É a distinção que este
> documento inteiro existe para fazer: sete checks construídos e testados em unidade não são sete
> checks vistos chegando num canal. Nenhum destes alertas foi observado ponta a ponta.

### Qualidade acima do critério, que vale registrar

- Os quatro estados (`ok` / `breached` / `no_data` / `error`) são **impostos pelo banco**, não só
  pelo tipo: há `CHECK` constraint na migration. "Sem dados" não pode virar `ok` nem zero por
  acidente de código.
- O contrato `HealthCheck` **documenta** a regra do projeto ("nenhum percentual sem base") como uma
  das três cláusulas que um check deve obedecer, no lugar exato onde alguém está prestes a agir
  sobre o número. *(Ver a ressalva logo abaixo: é documentação, não garantia.)*
- O runner tem guarda de ciclo sobreposto, e um check que lança não derruba os outros cinco.
- O adapter do `serverOverview` foi escrito sobre **payload real de produção** como fixture
  (`plan-server-overview.spec.ts`: *"production Plan, 2026-08-23"*), não sobre documentação — a
  regra que a S6.2 revertida ensinou.

### ⚠️ A regra mais importante do projeto não é verificada por máquina nenhuma

Achado desta auditoria, e ela quase o cometeu: a primeira versão deste documento afirmava que o `n`
obrigatório *"virou obrigação de tipo"*. **Não virou.** Em `health-check.types.ts`:

```ts
observed?: number;   // opcional
threshold?: number;  // opcional
n?: number;          // opcional
```

Os três são opcionais. A regra — *"`HealthCheckDetail.observed` sem `detail.n` é um percentual sem
a base dele"* — existe apenas no **docblock** do contrato. Um check que devolva `observed` sem `n`
compila, passa no lint, persiste, e chega ao Discord como um percentual sem base.

Isso não é defeito de implementação: os seis checks existentes obedecem à regra. É uma **garantia
ausente**, e ela cobre exatamente o erro que o `HANDOFF.md` cataloga três vezes (*"queda de 96%"*,
*"48 chegadas/mês"*) — percentuais sobre base contaminada ou inexistente. É a regra que o projeto
mais repete e a única sem rede de proteção.

Barato de fechar, e a S8.1 é a hora: o funil da §6.2 publica percentual em toda rota, e o critério 3
da história exige `n` junto de todos. Um tipo que torne o par inseparável — em vez de dois campos
opcionais lado a lado — serve as duas.

> Que este relatório tenha cometido o overclaim antes de corrigi-lo é o dado, não a ironia: ler o
> docblock e concluir sobre o tipo é a mesma classe de erro que o `HANDOFF.md` registra em
> *"li o requisito do check na redação do spec, não no código"*.

### O critério 4 é o item aberto mais importante do épico

Não é formalidade. A DoD da issue diz, com todas as letras: *"um check que nunca disparou é um check
não testado, e a história inteira existe para que o alerta chegue no dia ruim"*.

O que falta é operacional, e é conhecido:

1. `HEALTH_CHECK_ENABLED=true` num ambiente real (hoje `false` por padrão, deliberadamente).
2. `DISCORD_ALERT_WEBHOOK_URL` provisionado.
3. Derrubar uma instância de propósito e confirmar a mensagem no canal.

**Enquanto isso não acontece, toda a camada de saúde — incluindo a S7.1, que a expõe por API — é
construção sobre uma entrega que ninguém verificou ponta a ponta.**

### E os três limiares seguem sem calibração

`PLATFORM_OFFLINE_SHARE_MAX=0.5`, `FUNNEL_MIN_NETWORK_TO_SERVER=0.3` e
`PROXY_REGISTRATION_MAX_SILENCE_HOURS=24` entraram como **chute conservador, não medida**, e estão
marcados como tal no `.env.example` — o que é a forma honesta de deixá-los. Mas um limiar não
calibrado produz alerta que não dispara quando devia, ou dispara quando não devia; as duas falhas
terminam com o canal do Discord silenciado, que é o modo de falha que o épico existe para impedir.

O baseline da S6.0 é a fonte para calibrar. Ele existe, está commitado, e ninguém o usou para isso.

---

## DoD da Sprint 6

| item | veredito |
|---|---|
| `plan_servers` mostra proxy e backends num único banco, mesma build | ✅ feito em 2026-08-20, fora do fluxo |
| ~~Dump restaurável dos dois bancos fora da VPS~~ | ➖ **sem objeto** — a unificação já aconteceu, não existem "dois bancos" a dumpar |
| Alerta comprovado por teste destrutivo intencional | ❌ **aberto** — o item mais importante |
| Baseline pré-campanha commitado | ✅ |
| Spec órfão `specs/spec.md` marcado superseded | ➖ **sem objeto neste repositório** — `git log --all -- 'specs/'` não retorna nada; o arquivo nunca existiu aqui. Provável referência à pasta do Drive de onde spec e plano foram recuperados |

---

## Divergências entre documento e código, encontradas nesta auditoria

Ficam registradas porque cada uma é uma armadilha para quem ler o documento achando que está lendo o
sistema — o erro que o `HANDOFF.md` já cataloga.

1. **O docblock de `PlanServersConfig` afirma que `plan.orphan_instance` "cannot be built here".**
   Ele **foi construído** e está registrado no módulo. O texto é anterior à exceção 2 do ADR-002 e
   nunca foi atualizado.
2. **Cinco lugares ainda afirmam que o Plan não expõe lista de servidores**
   (`plan-servers.config.ts`, `plan-database.ts`, `metrics.service.ts`, `metrics.controller.ts` e
   `env.validation.ts`), e o `.env.example` repete. A premissa **caiu em 2026-08-26**: o endpoint é
   `/v1/networkMetadata`; `/v1/servers` e `/v1/networkOverview` davam 404 por serem nomes errados.
   É a justificativa alegada da exceção 2, e ela está sem apoio. *(O `HANDOFF.md` e o spec já
   registram a queda; os docblocks, não.)*

   > **Correção de 2026-08-28:** esta linha dizia "três arquivos". São cinco — e o que faltava
   > incluía o `@ApiOperation` de `metrics.controller.ts`, que é a versão da afirmação falsa
   > **publicada no OpenAPI**, isto é, a que um consumidor externo lê. Encontrado no code review do
   > PR que corrigiu os outros. Auditoria que enumera fontes tem de enumerar todas; parar na
   > terceira é a mesma classe de erro que ela veio catalogar.
3. **O docblock de `InstrumentationModule` lista como "still missing" os seis checks e o
   agendador.** Todos existem.
4. ~~**401 e 403 colapsados em `PlanAuthError`**, com rótulo causal errado.~~ — **corrigido**
   (PR [#164](https://github.com/ZzPowerTech/ausTvSales/pull/164)).

Nenhuma delas produz número errado; todas produzem **leitura errada**, que neste projeto já custou
cinco conclusões confiantes e falsas.

---

## Conclusão

A Sprint 6 entregou código de qualidade acima do critério, e fechou **duas histórias cujo passo
final — o que exige um ambiente real — nunca foi dado**. A distinção que importa não é quantos SP
saíram: é que a promessa raiz do épico (§1: *tornar impossível a cegueira silenciosa*) depende de um
alerta que ninguém viu chegar.

**Recomendação, em ordem:**

1. **Comprovar o alerta** (critério 4 da S6.3). Exige ambiente real; é o único item que fecha a S6.
2. **Rodar a auditoria da S6.2b e commitar o relatório**, começando pela leitura da whitelist no
   `config.yml` do Plan — que já é urgente por outro caminho, e antes do unban all.
3. **Calibrar os três limiares** contra o baseline da S6.0, que está commitado e ocioso.

Os três exigem acesso a máquina de produção e são decisão do dono, não trabalho de sessão.

O que **é** trabalho de sessão, e sai desta auditoria: tornar o `n` obrigatório verificável por
máquina, junto da S8.1 — a única regra que o projeto repete em todo documento e não tem nenhuma
garantia atrás dela.
