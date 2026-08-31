# AusTV Admin — Spec (v2)

**Projeto:** AusTV Admin — instrumentação e leitura única do AusTV Network
**Autor:** Murilo Weiss · **Revisão:** 2026-08-21 · **Status:** aguardando aprovação
**Metodologia:** SDD → Scrum → worktree → Conventional Commits → code-reviewer +
`cybersecurity-validator` → testes

**v2 substitui a v1 de 2026-08-20.** A v1 foi escrita antes de a instrumentação ser investigada.
O que mudou está na §2.

## 1. Objetivo

Duas coisas, nesta ordem de importância:

1. **Tornar impossível a cegueira silenciosa.** Todo problema grave encontrado no AusTV ficou
   invisível por meses porque nada avisava que o instrumento estava quebrado.
2. Dar uma leitura única de quem joga, por quanto tempo, em qual plataforma, quanto gasta e o que
   pede.

**Critério de sucesso:** um problema de instrumentação ou de funil é detectado em **dias**, não em
meses. E "o que aconteceu no mês X?" se responde em minutos.

## 2. O que a investigação de 2026-08-19/21 mudou

| Descoberta | Efeito no spec |
|---|---|
| ~~Plan já instalado no proxy (AusTv) e no backend (Survival), em **bancos separados**~~ | **Superado em 2026-08-20:** o dono unificou os bancos fora do fluxo de sprint. Não há PR de infra — a S6.2 nasceu e morreu sobre uma premissa já vencida |
| Proxy grava usuários, **backends gravam sessões** | Aquisição vem do proxy, retenção do backend — camadas diferentes, não redundância |
| **54% de quem conecta na rede nunca chega ao survival** | Novo degrau de funil, nunca medido. Vira métrica de primeira classe |
| Plataforma sai do UUID em SQL puro, com 100% de acerto | **A DataExtension de plataforma foi cancelada.** Uma sprint inteira eliminada |
| Plan de produção rodava em **SQLite**; o MySQL consultado estava pela metade | Saúde da instrumentação vira requisito, não enfeite |
| Plan do proxy **parou de coletar de maio a agosto/2026** sem ninguém notar | idem |
| Tutorial parou de capturar novatos em **dez/2025**; taxa de entrada caiu de ~100% para 12% ao longo de 8 meses | Vira métrica monitorada com alerta |
| Colapso real de aquisição é **fev/2026**, não dez/2025 | Causa ainda desconhecida — investigação em aberto |
| Mix de plataforma atual ≠ o histórico (59,2% Bedrock é *all-time*) | Todo número de plataforma precisa de janela explícita |
| `java_offline` converte proxy→survival a 39,3% contra 71,5% do Bedrock | Suspeita de tráfego de bot inflando aquisição. Precisa de filtro |
| Economia já instrumentada: `playerpoints_points` (saldo), `playerpoints_transaction_log` (transações), e o `ausTvSales` já classifica onde o cash foi gasto | **ausPlanBridge reduzido a quase nada** (§5.2). Nasce a camada de economia (§6.4) |

## 3. Fora de escopo

- Reescrever coleta de sessão/playtime/AFK — o Plan faz.
- Fork do Plan ou fusão de repositórios (ADR-001).
- Painel de retenção em tempo real — com dezenas de chegadas/mês seria ruído. Retenção é relatório
  periódico.
- Coleta de **conteúdo** de chat. Só contagem.
- Correções do tutorial e do funil — trilha paralela, precedência sobre este spec.

## 4. Decisões de arquitetura

### ADR-001 — Plan upstream como serviço de dados, consumido pela API JSON

Plan roda sem modificação; o AusTV Admin consome a **API JSON** (`/v1/*`) a partir da VPS. O
frontend é 100% Angular próprio; o React do Plan é ignorado (acessível só pelo IP da VPS, nunca
público).

Alternativas rejeitadas — fork e fusão de repositórios — com bloqueios verificados nos arquivos
reais:

| bloqueio | evidência |
|---|---|
| Licença | `ausTvSales/LICENSE` é **MIT**; Plan é **LGPL-3.0**. LGPL não entra em repo MIT mantendo MIT |
| Banco | `ausTvSales` = PostgreSQL/Drizzle. Plan = MySQL |
| Frontend | `ausTvSales` = Angular 19 + Signals. Plan = React/Bootstrap/HighCharts |
| Manutenção | ~7.090 commits, 189 releases, 12 módulos Gradle |

Endpoints, **conforme o OpenAPI lido em 2026-08-26** em `/docs` do webserver:

**Leitura:** `/v1/networkMetadata` (lista de servidores) · `/v1/retention` · `/v1/query` +
`/v1/filters` · `/v1/sessions` · `/v1/playersTable` · `/v1/joinAddresses` · `/v1/kills` ·
`/v1/player` · `/v1/playersOnline` · `/v1/graph?type=…` · `/v1/pluginHistory` ·
`/v1/datapoint?type=…` · `/v1/version` · `/v1/whoami` · `/v1/metadata` · `/v1/errors`.

**Escrita e autenticação — a API do Plan NÃO é somente leitura:** `POST /auth/login` ·
`GET /auth/register` · `POST /v1/saveGroupPermissions` · `DELETE /v1/deleteGroup` ·
`POST /v1/saveTheme` · `POST /v1/deleteTheme` · `POST /v1/storePreferences`. Esta camada nunca os
chama, mas eles existem na mesma porta e importam para a superfície de ataque da §8 — detalhe no
[`HANDOFF.md`](HANDOFF.md).

> ⚠️ `/v1/serverOverview` e `/v1/onlineOverview` — que a S6.3 e a S7.2 consomem — **não constam do
> OpenAPI**, embora funcionassem em 23/08 e 25/08. `/v1/performanceOverview` e `/v1/players` constam
> marcados `deprecated`. `/v1/playerbaseOverview` e `/player/<uuid>/raw`, que esta lista citava, não
> aparecem. Detalhe em [`HANDOFF.md`](HANDOFF.md).

### ADR-002 — NestJS fala com `/v1/*`, nunca com as tabelas do Plan

Schema interno muda entre versões; a API JSON é a superfície estável. Exceções **numeradas,
documentadas e isoladas em módulo próprio**, sempre em usuário **read-only**:

| # | escopo | tabelas | por quê a API não serve |
|---|---|---|---|
| 1 | Coorte histórica (§6.2, S8.2) | `plan_users`, `plan_user_info`, `plan_sessions` | ~~agregação por coorte × plataforma não existe em nenhum endpoint~~ — **premissa derrubada em 2026-08-29**, e **nenhuma justificativa a substitui**. Ver a nota abaixo |
| 2 | **Inventário de instâncias e chegadas de rede (§6.1, S6.3)** — *aprovada em 2026-08-23; **premissa desmentida em 2026-08-26**, corpo lido em 2026-08-29* | **`plan_servers` e `plan_users`** | ~~o Plan não expõe lista de servidores~~ — **falso**: `/v1/networkMetadata` lista as instâncias. Mas o corpo **não traz `plan_version`**, e nenhum outro endpoint traz: `version_divergence` fica, `orphan_instance` pode sair. Justificativa reescrita abaixo. A parte sobre chegadas de rede não foi reavaliada |

#### Exceção 1 — sem justificativa desde 2026-08-29

A exceção foi aberta com um único argumento: *"agregação por coorte × plataforma não existe
em nenhum endpoint"*. O corpo do `/v1/retention` foi lido e traz `registerDate` (coorte) e
`playerUUID` (plataforma, pelo ADR-003). O argumento caiu, e **nada foi escrito no lugar**.

Pelo próprio ADR-002, uma exceção numerada precisa carregar uma justificativa escrita. Esta
não carrega mais, e a regra que este documento aplica à exceção 2 quatro parágrafos abaixo
— *uma exceção que sobrevive porque ninguém reescreveu o motivo é como esta aqui foi
aberta* — vale igual para esta.

**Estado:** autoriza `plan_users`, `plan_user_info` e `plan_sessions`, e **nenhum código a
usa** — a S8.2, única história que dependia dela, sai do endpoint. Fechá-la é decisão do
dono, porque foi ele quem a abriu; até lá ela fica registrada aqui como o que é: uma
autorização de pé sem motivo de pé.

> **A ressalva que sobra, e não é sobre acesso:** `lastSeenDate` dá o **intervalo de
> sobrevivência**, não o retorno no dia N. Entregar retenção por intervalo, rotulada como
> tal, é melhor que abrir três tabelas para entregar a outra — mas é uma métrica
> diferente, e chamar uma de outra seria o erro de denominador que já custou uma linha do
> DoD da S8.

#### Exceção 2 — inventário de instâncias (2026-08-23)

**Problema.** Dois dos sete checks da §6.1 precisam saber *quais servidores existem* e *em que build
cada um roda*:

- `plan.orphan_instance` — servidor registrado no Plan sem dado recente
  > ⚠️ **A frase acima descreve a intenção, não o check construído.** O
  > `OrphanInstanceCheck` reconcilia duas **listas** (`plan_servers` ×
  > `PLAN_SERVERS`) e não olha recência: recência por servidor exigiria
  > `plan_sessions`, que está **fora** desta exceção. Ver o docblock de
  > `orphan-instance.check.ts`. Esta divergência entre a redação e o
  > comportamento já produziu uma conclusão errada em 2026-08-26.
- `plan.version_divergence` — builds diferentes entre instâncias, que corrompem schema compartilhado
  (ADR-005)

**Por que a API não resolve.** ~~Não há endpoint de catálogo.~~ — **falso, corrigido em
2026-08-26: existe `/v1/networkMetadata`. Ver a nota ao fim desta seção.** `/v1/serverOverview`
responde por *um* servidor, endereçado por nome, e não carrega versão. Sem lista, `orphan_instance` só poderia checar
servidores que alguém já configurou à mão — o que dá atestado de saúde **exatamente no caso que o
check existe para pegar**: a instância que ninguém sabia que existia.

**Decisão do dono (Murilo, 2026-08-23):** abrir a exceção.

**Extensão de 2026-08-23 — `plan_users`.** Dois outros checks da §6.1 precisam da
contagem de chegadas ~~**na rede**~~ — **e essa é a palavra errada; ver a nota de 2026-08-31 logo
abaixo**:

- `plan.proxy_registration_alive` — a §6.1 já o redige como *"nenhum
  **`plan_users.registered`** novo em 24h"*. **O spec nomeia a tabela**: quando isto
  foi escrito, já se assumia acesso ao banco para este check, e o ADR-002 nunca
  chegou a ser conciliado com essa linha.
- ~~`funnel.network_to_survival` — precisa do denominador do funil, que é o mesmo
  número.~~ **Caiu em 2026-08-31:** era o mesmo número porque as duas pontas eram a mesma
  população. O check não lê mais o banco.

Verificado em 2026-08-23 que a API **não** serve esse dado: o proxy grava usuário
e os backends gravam sessão (§2), então toda métrica derivada de sessão é
estruturalmente vazia no proxy. `graph?type=uniqueAndNew` devolve arrays vazios
para o proxy, e `serverOverview` do proxy vem com `numbers: {}`.

Só duas colunas são lidas: `registered` e a contagem de linhas. `plan_users` é
tabela de identidade — das mais estáveis do schema do Plan.

> #### 🔴 Correção de 2026-08-31 — esta exceção nunca leu a rede
>
> Toda a redação acima diz *chegadas na rede*. Medido: `plan_users`, **nesta instalação**, guarda o
> **Survival**. O proxy (`AusTv`, `is_proxy = 1`) está no catálogo de `plan_servers` com **zero**
> jogadores em `plan_user_info`; `Survival` é o único servidor que aparece lá, com 5575 das 5638
> linhas; e as contagens mensais da tabela são a coluna `survival` dos números verificados do
> [`HANDOFF.md`](HANDOFF.md) **linha a linha**, nos oito meses. A população da rede
> está no banco antigo.
>
> **O escopo da exceção não muda** — mesmas três colunas, mesma tabela, mesmo usuário read-only.
> Muda o que ela é capaz de responder, e três consumidores foram corrigidos:
>
> - o degrau **`rede`** do funil deixou de sair desta fonte e virou `null` com motivo; a mesma
>   contagem passou a alimentar o degrau **`survival`**, com a procedência no payload (§6.2);
> - **`funnel.network_to_survival`** parou de dividir Survival por Survival e passou a `no_data`
>   com o motivo (§6.1);
> - **`plan.proxy_registration_alive`** continua, com os sumários dizendo Survival e dizendo que
>   **não** cobrem o proxy (§6.1).
>
> **Consequência para o ADR-002 que vale registrar:** a justificativa original desta extensão —
> *"a API não serve chegadas de rede"* — segue verdadeira, e agora sabe-se que **o banco também
> não serve**. Nenhuma das duas fontes autorizadas hoje tem a população do proxy. Fechar isso é uma
> fonte nova, não um alargamento desta exceção.

> #### ⚠️ Extensão de 2026-08-28 — `plan_users.uuid`, para a S8.1
>
> **Decisão do dono pendente.** Implementada e sinalizada em vez de feita em silêncio, porque o
> limite 1 abaixo diz que qualquer alargamento pertence a esta seção.
>
> **O que muda:** o funil da S8.1 lê uma **terceira coluna**, `uuid`, de uma tabela que esta mesma
> exceção já abriu.
>
> **Por quê, e por que não dava para evitar:** o spec pede duas coisas que só se satisfazem juntas.
> A §6.2 exige cada degrau **segmentável por `platform`**, e o ADR-003 diz que `platform` é
> **derivada do UUID** — por desenho, porque derivá-la de outro jeito exigiria plugin (e foi o que
> cancelou uma sprint inteira). Um funil que honra a §6.2 tem de ler o uuid. A alternativa é
> entregar o degrau de rede sem segmentação por plataforma, o que reprova o critério 2 da S8.1.
>
> **O que isto não é:** tabela nova. O acesso continua `SELECT` no mesmo usuário read-only, e o
> uuid é consumido por `platformOf` e **descartado dentro da agregação** — nada identificável chega
> ao contrato nem é persistido, o que a §8 exige.
>
> **Custo:** três colunas em vez de duas, na tabela mais estável do schema do Plan. Se o dono
> preferir não abrir, o degrau de rede sai sem plataforma e o critério 2 fica parcial.

**Limites, que fazem parte da decisão:**

1. **Duas tabelas, e apenas estas: `plan_servers` e `plan_users`.** Qualquer outra
   — incluindo `plan_user_info` e `plan_sessions` — exige nova exceção numerada
   aqui. A recusa em esticar isto sozinho é o que mantém a tabela útil.
2. **Usuário MySQL read-only dedicado**, separado do usuário dos plugins e do usuário da exceção 1.
   `SELECT` apenas, e apenas nessa tabela.
3. **Um único módulo isolado.** Nenhum outro ponto do NestJS abre conexão com o MySQL do Plan.
4. **Credencial em variável de ambiente**, nunca versionada.
5. **Degradação honesta:** banco inalcançável → os dois checks reportam `error` com o motivo, nunca
   `ok` e nunca zero.

> ### ⚠️ A premissa desta exceção caiu em 2026-08-26
>
> O `/docs` do webserver do Plan serve um OpenAPI completo, e ele lista
> **`GET /v1/networkMetadata`** — *"metadata about the network such as list of servers"*.
>
> A investigação de 23/08 tentou `/v1/servers` e `/v1/networkOverview`, levou 404, e concluiu que o
> Plan não expunha a lista. Os dois nomes estavam errados. **Esta exceção foi aberta com o argumento
> de que não havia alternativa, e havia.**
>
> **Corpo lido em 2026-08-29, e o resultado parte a exceção em duas.** O `/v1/networkMetadata`
> enumera as instâncias da rede e **não** carrega `plan_version`. Nenhum outro endpoint do
> OpenAPI carrega.
>
> - **`plan.orphan_instance`** reconcilia duas *listas*, e o endpoint serve essa lista. Esta
>   metade **poderia** sair do SQL — mas não é decisão tomada: o argumento estrutural
>   registrado abaixo (sob 403 na API, os checks que leem SQL continuam respondendo) não foi
>   respondido por nada que os dois corpos mostraram. E o gatilho original pedia
>   `plan_version` **e recência por instância**; só a primeira foi verificada.
> - **`plan.version_divergence`** precisa da versão por instância. Esta metade **fica**, e a
>   exceção fica com ela.
>
> Então: a exceção 2 **continua de pé com uma justificativa nova**, e a antiga ("não há
> endpoint de catálogo") está morta. As duas coisas são diferentes e é importante que este
> documento diga as duas — uma exceção que sobrevive porque ninguém reescreveu o motivo é
> como esta aqui foi aberta.
>
> **O custo enquanto isso:** as duas metades compartilham o `PlanDatabase`, então a
> credencial de MySQL e a conexão que o ADR-002 existe para evitar continuam de pé mesmo
> depois de o `orphan_instance` migrar. Fechar de verdade exige as duas metades.
>
> A outra metade citada aqui — se o `/v1/playersTable` serve `plan_users.registered` —
> **segue não verificada**. Detalhe no [`HANDOFF.md`](HANDOFF.md).
>
> Erro de método, do mesmo tipo que este projeto já registrou quatro vezes: **concluir ausência a
> partir de uma busca que não achou**, em vez de consultar a fonte que enumera. A fonte existia em
> `/docs` o tempo todo.

**Custo aceito.** `plan_servers` e `plan_users` são schema interno e podem mudar entre versões do
Plan. É acoplamento real, e a mitigação é o tamanho do alvo: duas tabelas, seis colunas no total
(`uuid`, `name`, `is_proxy`, `plan_version` · `registered`, mais a contagem), lidas por um módulo
só. Se o schema mudar, o parser falha alto e vira veredito
`error` — não número errado em silêncio.

### ADR-003 — `platform` é dimensão de primeira classe, derivada do UUID

```sql
uuid LIKE '00000000-0000-0000-0009-%'  -- bedrock (Floodgate)
SUBSTRING(uuid,15,1) = '3'             -- java_offline
SUBSTRING(uuid,15,1) = '4'             -- java_premium
```

Validado sobre 49.302 arquivos com 100% de acerto. **Não requer plugin.** Toda métrica de jogador
carrega `platform`, sempre com janela temporal explícita.

### ADR-004 — `ausTvSales` continua MIT e intocado pela LGPL

Nenhum arquivo do Plan é copiado para o monorepo. Item de checklist na revisão de PR.

### ADR-005 — Um único banco MySQL para toda a rede

Requisito do Plan para setup de rede. Sem isso não existe visão de rede, identidade unificada de
jogador nem **tempo por servidor**. Proxy e backends **na mesma build** do Plan — builds diferentes
compartilhando banco corrompem schema.

**Estado em 2026-08-20 (confirmado pelo dono em 2026-08-23):** banco único **já em produção**, com
proxy e backends na **mesma build**. O ADR deixa de ser trabalho a fazer e passa a ser invariante a
vigiar — é o que o check `plan.version_divergence` da §6.1 existe para detectar se regredir.

### ADR-007 — Economia vem de banco, não de plugin

Cash, transações e classificação de gasto já existem em banco e são legíveis pelo NestJS:

| dado | fonte | acoplamento |
|---|---|---|
| saldo em cash | `playerpoints_points` | baixo — schema trivial e estável |
| transações (take do servidor, pagamento entre jogadores) | `playerpoints_transaction_log` | baixo |
| classificação de onde o gasto foi | **ausTvSales** (PostgreSQL próprio) | nenhum — é nosso |
| cargo LuckPerms | banco do LuckPerms | baixo — schema documentado |
| variáveis do MyCommand | `s1_mycommand_playerdata` | **alto e frágil** — adiado |

Todo acesso em usuário **read-only** dedicado. Leitura direta de schema de plugin é acoplamento
aceito **apenas** onde o schema é trivial e estável; MyCommand fica de fora por isso.

**Restrição descoberta em 2026-08-21:** `playerpoints_transaction_log` **não tem índice nenhum** —
nem chave primária, nem em `receiver`, `timestamp` ou `source`. Qualquer agregação vira *full table
scan* no MySQL que o servidor de jogo usa.

Portanto a economia **não é lida ao vivo**: um **job noturno de ETL** copia as transações para o
PostgreSQL do `ausTvSales`, indexado, e toda análise roda lá. Isso resolve três problemas de uma
vez — zero carga analítica na instância do jogo, índices sob nosso controle, e uma única superfície
a corrigir se o PlayerPoints mudar de schema.

Schema de origem (2026-08-21): `transaction_type varchar(20)` · `description varchar(100)` ·
`source varchar(36) NULL` · `receiver varchar(36)` · `amount int(11)` · `timestamp timestamp`.
**`source` nulo = movimento do sistema**; `source` preenchido = origem identificada.

**Conteúdo real (2026-08-21):** 6.664 linhas, de **2026-01-30** a hoje — ~7 meses, começando junto
com o colapso de aquisição de fevereiro. **A camada de economia é prospectiva**, sem período
saudável para comparação.

| transaction_type | n | amount | sem source | significado |
|---|---|---|---|---|
| OFFSET | 4.033 | −13.000 a **9.999.999** | 2.149 | Take = gasto · Give = concessão |
| SET | 1.299 | 0–50 | 1.296 | Starting balance = **criação de conta** |
| PAY_RECEIVER | 666 | 1 a 60.000 | 0 | pagamento recebido |
| PAY_SENDER | 666 | −60.000 a −1 | 0 | pagamento enviado |

Três consequências viram requisito:

**R1 — `SET`/`Starting balance` é uma série de chegadas independente**, contínua, que **cobre o
apagão do Plan no proxy (mai–jul/2026)**. Usar como fonte de reconciliação do funil da §6.2, não só
como dado de economia.

**R2 — Outlier de 9.999.999 é concessão administrativa, não receita.** Nenhuma soma, média ou
métrica de receita pode incluir grant de staff. Regra de negócio, não refinamento.

**R3 — RESOLVIDO em 2026-08-21: não existe join.** O escopo é **analytics apenas**; reconciliação
entre `transaction_log` e `ausTvSales` está fora. As duas fontes não se cruzam:

| pergunta | fonte única | PlayerPoints envolvido? |
|---|---|---|
| E1 — receita por plataforma e coorte | ausTvSales (PostgreSQL próprio) | não |
| E2 — tempo até o primeiro gasto, gasto por posição no funil | ausTvSales | não |
| E3 — contato social e feed de pagamentos | `playerpoints_transaction_log`, **só linhas `PAY_*`** | sim |

Consequências: **nenhuma alteração no plugin do `ausTvSales`** (o ADR-007 mantém zero Java na v1);
o ETL importa apenas `PAY_SENDER`/`PAY_RECEIVER` (1.332 de 6.664 linhas); `OFFSET`, `SET` e
`description` ficam fora do escopo de economia — exceto `SET`/`Starting balance`, que segue como
série de chegadas (R1).

**R4 — 666 pagamentos em 6,7 meses (~3/dia)** com ~579 ativos. A economia social está quase parada
— consistente com guerras e clãs desligados. E3 nasce com amostra pequena; medir sim, esperar
conclusão rápida não.

### ADR-008 — PostgreSQL é o armazém analítico; as fontes são ETL

Os dados vivem em bancos **fisicamente separados e de motores diferentes**. JOIN entre eles é
impossível em SQL — toda correlação acontece depois que os dados aterrissam no mesmo lugar.

| dado | onde vive | motor | como chega ao Admin |
|---|---|---|---|
| vendas / gasto classificado | VPS do sales.austv.net | **PostgreSQL** (nosso) | já está lá |
| métricas de jogador, sessão, funil | VPS do jogo | MySQL do Plan | **HTTP `/v1/*`** (ADR-002), nunca SQL |
| pagamentos entre jogadores | VPS do jogo | MySQL do PlayerPoints | **ETL noturno** (ADR-007) |
| coorte histórica | VPS do jogo | MySQL do Plan | exceção documentada: SQL read-only, módulo isolado |

**Regra:** o PostgreSQL do `ausTvSales` é o único lugar onde dados de fontes diferentes se cruzam.
Nada de correlação em memória entre resultados de dois bancos ao vivo.

Consequências práticas:

- **E1 (receita por plataforma) é Postgres puro.** A plataforma sai do `player_uuid` que o
  `ausTvSales` já guarda (ADR-003). Zero dependência externa.
- **E2 (gasto por posição no funil) exige uma dimensão `player` no Postgres** — uuid, platform,
  first_seen, posição no funil — alimentada por ETL a partir do Plan. É o que torna o cruzamento
  possível.
- **E3/E4 (social)** dependem do ETL de `PAY_*`.

**Rede e segredos:** o ETL cruza da VPS do sales.austv.net para a do jogo (jogar.austv.net /
198.89.99.70 — **corrigido em 2026-08-23**, o `.229` que estava aqui não é endereço da máquina).
A porta do MySQL do jogo **não pode estar aberta à internet** — túnel SSH ou
allowlist do IP da VPS da aplicação. Credenciais em variável de ambiente; usuário **read-only**
dedicado por fonte, nunca o usuário do plugin.

**Degradação:** fonte inalcançável → o dado correspondente é servido com marca de *stale* e **a
data da última sincronização visível**. Nunca zero, nunca silêncio.

### ADR-006 — O sistema precisa detectar a própria cegueira

Todo desastre encontrado foi silencioso: Plan em SQLite por meses, proxy morto de maio a agosto,
tutorial sem capturar por 8 meses. **Painel que não detecta a própria falha de coleta é pior que
nenhum painel**, porque produz confiança falsa.

Consequência: os checks de saúde da §6.1 são **PR 1**, antes de qualquer gráfico, e disparam alerta
ativo no Discord — não ficam esperando alguém abrir a página.

## 5. Componentes

```
┌── Paper: Survival ─────────┐   ┌── Velocity: AusTv ────┐
│  Plan (upstream)           │   │  Plan (upstream)      │
│  ausPlanBridge  ← novo     │   │  webserver 127.0.0.1  │
└─────────────┬──────────────┘   └──────────┬────────────┘
              └──────────┬──────────────────┘
                         ▼
              MySQL ÚNICO do Plan (ADR-005)
                         │
                   API JSON /v1/*
                         ▼
      ┌── NestJS: austv-admin-api ← novo ────┐
      │  health · metrics · funnel ·         │
      │  sales · suggestions · discord       │
      └──────────────┬───────────────────────┘
                     ▼
      ┌── AusTV Admin (monorepo ausTvSales) ─┐
      │  Angular 19 + Signals                │
      └──────────────────────────────────────┘
                     ▲
      ┌── Bot Discord AusTV ← novo ──────────┐
      │  sugestões · métricas de guild ·     │
      │  ENTREGA DOS ALERTAS DE SAÚDE        │
      └──────────────────────────────────────┘
```

### 5.1 Plan (upstream, sem modificação)

Nativo: online activity, picos, sessões, session median, playtime total/ativo/AFK, tempo por
servidor, punchcard, retenção, segmentação Active/Regular/Irregular/Inactive, TPS, downtime.

### 5.2 ausPlanBridge — **adiado para v2, provavelmente desnecessário**

O ADR-003 tirou a plataforma dele. A economia já está em banco (ADR-007). O que sobraria são as
variáveis do MyCommand — o item de menor valor de decisão da lista original, e o mais frágil
(renomear uma chave de playerdata quebra torneio e menu em silêncio).

**Decisão: nenhum plugin Java na v1.** Se as variáveis do MyCommand se mostrarem necessárias
depois, o DataExtension volta — com Plan como dependência opcional, hook isolado contra
`NoClassDefFoundError`, e zero I/O de rede na main thread.

Ganho: nada é implantado no servidor de jogo. Superfície de risco na produção do Minecraft = zero.

### 5.3 Bot Discord AusTV (novo)

- Sugestões: estados `enviada` → `aprovada` → `em_andamento` → `concluida` | `recusada`, listagem
  paginada, role de staff verificada server-side
- Métricas de guild: entradas, saídas, total por dia
- **Canal de entrega dos alertas de saúde da §6.1**

### 5.4 austv-admin-api (NestJS)

Módulos `health`, `metrics`, `funnel`, `sales`, `suggestions`, `discord`. Guards JWT, DTO com
class-validator, Swagger, Helmet, throttling.

### 5.5 AusTV Admin (Angular 19 + Signals)

Reutiliza os componentes de gráfico da Sprint 5 do `ausTvSales`.

## 6. Requisitos por camada

### 6.1 Camada 1 — Saúde da instrumentação (PRIORIDADE MÁXIMA)

Cada check roda periodicamente e **alerta ativamente no Discord** quando falha.

> ⚠️ **Esta tabela é a intenção; o código é o contrato.** Os identificadores aqui são idênticos aos
> nomes das classes de check, o que faz *ler esta seção parecer* ler o check — e não é. Onde a
> implementação divergiu da redação, a divergência está anotada na própria linha. Duas já
> divergiram, e a confusão entre as duas coisas já custou uma conclusão errada
> (`HANDOFF.md`, erro 5 e a correção de 2026-08-26).

| check | condição de alerta | desastre que teria evitado |
|---|---|---|
| Coleta viva por servidor | nenhuma sessão nova em 6h num servidor que deveria estar online | proxy morto de maio a agosto/2026 |
| Registro vivo no proxy | nenhum `plan_users.registered` novo em 24h — o check lê `PlanDatabase.networkArrivals()`, **não** `/v1/graph?type=uniqueAndNew` como o `HANDOFF.md` de 23/08 supunha | idem |
| Instância órfã | servidor em `plan_servers` sem dado recente — ⚠️ o check **construído** reconcilia listas, não recência (ver ADR-002, exceção 2) | Plan em SQLite invisível |
| Versões divergentes | builds diferentes entre instâncias | risco de corromper schema |
| **Taxa de entrada no tutorial** ⚠️ | `novatos_no_tutorial / novatos_no_survival` cai abaixo de 70% — o check mede uma **janela de 7 dias**, não "3 dias consecutivos"; ver a nota abaixo da tabela | tutorial sem capturar por 8 meses |
| ~~Conversão rede → survival~~ ⚠️ | **cego desde sempre; devolve `no_data` desde 2026-08-31** — ver o bloco abaixo | degrau do lobby |
| Crescimento anormal de conta offline | share de `java_offline` na rede sobe fora da faixa | tráfego de bot inflando aquisição |

> ### ✅ O 7º check entrou em 2026-08-28, e diverge desta tabela em três pontos
>
> Ficou de fora da S6.3 porque o Plan **não coleta nada do tutorial** e o dado não estava em banco
> nenhum — nenhuma das duas exceções ao ADR-002 ajudava. A **S8.0** construiu a fonte
> ([ADR-0004](../../decisions/ADR-0004-fonte-dados-tutorial.md)): ETL noturno lendo
> `Quests/playerdata/*.yml`, a mesma origem dos números do `HANDOFF.md`.
>
> As divergências, ditas em vez de arredondadas — e o aviso no topo desta seção é exatamente sobre
> isto: **a tabela é a intenção, o código é o contrato**.
>
> 1. **"por 3 dias" virou uma janela de 7 dias.** A cláusula existe para um único dia ruim não
>    alertar, e foi escrita para uma métrica diária. A janela de 7 dias já suaviza isso; o que
>    **não** existe é um contador de N avaliações consecutivas.
> 2. **O numerador e o denominador têm relógios diferentes** — o denominador é buscado ao vivo, o
>    numerador é o que o último ETL noturno gravou. Um numerador congelado sobre um denominador vivo
>    é uma razão que **cai sozinha**, então a frescura do ETL é conferida **antes** da razão: fonte
>    velha vira `error` culpando o ETL, nunca `breached` culpando o tutorial. A tolerância é o
>    período do ETL (36h), não a janela — permitir a idade da janela deixaria o alerta disparar
>    quando quase todo o estrago já aconteceu.
> 3. **`novatos_no_survival` é o denominador, mas o numerador é de REDE.** Os dois lados não contam
>    exatamente a mesma população, e a razão pode passar de 100%. Quando passa, o veredito diz isso
>    em palavras em vez de publicar um percentual arrumadinho.
>
>    ⚠️ **A palavra "REDE" aqui não foi verificada, e a auditoria de rótulos de 2026-08-31 não a
>    resolveu.** O numerador vem do ETL sobre `Quests/playerdata` na máquina do jogo; se o plugin
>    Quests roda só no Survival — que é o que o próprio docblock do check supõe ao dizer que *"o
>    tutorial pertence ao Survival"* — então os dois lados são **mais** alinhados do que esta linha
>    afirma, e o aviso acima de 100% é conservador em vez de errado. Nenhum número muda por isso, o
>    que é por que não foi mexido: fechar exige saber em que instância o Quests roda, e ninguém
>    verificou. Fica registrado para não virar o próximo "medido, nunca conferido".

> ### 🔴 O check `funnel.network_to_survival` nunca pôde medir o que promete (2026-08-31)
>
> Ele dividia `serverOverview.last_7_days.new_players` do Survival pelas chegadas de `plan_users`.
> Medido: **são a mesma população.** O proxy (`AusTv`, `is_proxy = 1`) está no catálogo de
> `plan_servers` com **zero** jogadores em `plan_user_info`; `Survival` é o único servidor que
> aparece lá, com 5575 das 5638 linhas; e as contagens mensais de `plan_users` são a coluna
> `survival` dos números verificados do `HANDOFF.md` **linha a linha**, nos oito meses, enquanto a
> coluna `rede` é cerca do dobro.
>
> Numerador e denominador se moviam juntos. A razão não podia cair, então o `ok` que ele vinha
> reportando era propriedade da própria aritmética: **ele reportaria `ok` com a rede inteira fora
> do ar.** É a cegueira do ADR-006 dentro da camada que existe para detectá-la, e é mais grave que
> o rótulo errado do funil — um número errado alguém eventualmente estranha; um `ok` construído
> para nunca mudar, ninguém.
>
> **O que passou a fazer:** `no_data` por backend, todo ciclo, com o motivo por escrito. Sem
> consulta ao banco e sem chamada ao Plan — não há o que perguntar, e perguntar mesmo assim faria a
> máquina do jogo pagar uma requisição por ciclo para produzir uma constante.
>
> **Por que `no_data` e não `error`:** pela regra do bloco seguinte — *de quem* é o vazio. Nada
> falhou; não temos fonte para o denominador, a mesma categoria de `PLAN_SERVERS` em branco.
> `error` pagaria o canal a cada quinze minutos sobre uma lacuna já documentada, que é como um canal
> vira mudo.
>
> **Por que não foi aposentado:** tirá-lo do registro o deixaria de fora da comparação que o
> `InstrumentationHealthService` faz, e as linhas antigas envelheceriam em `staleChecks`, fixando o
> resumo em `down` para sempre — o oposto de silêncio. Registrado, ele escreve um veredito fresco
> por ciclo cujo conteúdo inteiro é o motivo de não poder medir.
>
> ### 🔴 `no_data` sozinho não bastava — corrigido no mesmo PR, achado em revisão
>
> A primeira versão desta mudança afirmava que *"`no_data` nunca notifica"*. **Isso só vale a partir
> de um estado limpo.** Os dois consumidores de um veredito assumem que um estado não-`ok`
> eventualmente se resolve, e este nunca se resolve:
>
> 1. **Alerta diário, para sempre.** `decideAlerts` suprime um `no_data` como `not_notifiable`
>    apenas enquanto o canal não está segurando nada sobre o check. Com qualquer alerta não-`ok`
>    aberto — um `error` antigo de um soluço do MySQL que nunca recebeu recuperação confirmada — a
>    política caía em `repeat`, que entrega assim que `reAlertAfterMs` vence e **a cada janela
>    depois disso**, porque a saída é um registro `ok` que este check não produz mais. O teto por
>    janela também não segurava: `no_data` é o único status que ele emite, então toda janela nova
>    lhe dava o passe livre de "status não ouvido".
> 2. **`degraded` para sempre.** `resolveStatus` devolve `degraded` sempre que algum check está
>    `no_data`, então o agregado do `/health/instrumentation` nunca mais leria `ok` — e, pior, um
>    **segundo** check piorando não o moveria mais. Um status que não pode se mexer parou de
>    carregar informação: é o desastre fundador deste épico vestindo amarelo em vez de verde.
>
> **A saída foi um conceito novo, `ACCEPTED_BLIND_SPOTS`** (em `health-check.types.ts`), consultado
> pelos dois consumidores. Um membro do conjunto:
>
> - **nunca notifica** — nem na primeira vez, nem quando a janela vira, e não importa o que o canal
>   está segurando (supressão com motivo próprio, `accepted_blind_spot`, para que o quanto da camada
>   foi desligado seja contável);
> - **fica de fora de `counts`, de `failing` e do `status` agregado**, e é publicado por nome no
>   campo novo **`blindSpots`** do `/health/instrumentation`. Fora do veredito, **não** do payload:
>   ponto cego que some se lê como tudo bem, que é o erro que esta camada inteira existe para evitar;
> - **continua em `total`, em `reporting` e na janela de frescor** — está registrado, escrevendo
>   linha por ciclo, e se parar de escrever ainda cai em `staleChecks`.
>
> **O custo, que não está escondido:** a supressão é incondicional, então um check que entra no
> conjunto enquanto o canal segura um `breached` ou `error` deixa essa mensagem como última palavra,
> sem nota de encerramento. É deliberado — a alternativa é uma regra de "entrega exatamente uma vez,
> depois nunca", e as regras de transição do `decideAlerts` já erraram duas vezes raciocinando sobre
> formatos. Uma falha velha engana na direção segura; carimbar um `ok` para limpar o canal é a única
> coisa que esta camada não pode fazer.
>
> **A régua para entrar no conjunto:** *nenhuma fonte alcançável por este sistema responde à
> pergunta*, e isso está escrito em algum lugar durável. Não serve para check barulhento, mal
> calibrado ou inconveniente — silenciar um desses é como o canal emudece sobre algo real. Sair do
> conjunto é sempre seguro: o check volta a alertar.
>
> **O que custa:** os ~54% deixaram de ser vigiados. Isso é perda real, e não rebaixamento de um
> sinal existente — nunca foram vigiados, porque este check não os enxergava. Restaurar exige uma
> contagem de chegadas **no proxy**; o banco antigo é candidato, e `/v1/networkMetadata` e
> `/v1/playersTable` nunca foram lidos com esse fim. A aritmética volta inalterada do histórico do
> git: só o denominador esteve errado.
>
> ### ⚠️ Dois outros rótulos da §6.1 herdam o mesmo erro, com gravidades diferentes
>
> Auditados no mesmo dia, já que a causa é uma só — `plan_users` não é a rede.
>
> - **`plan.proxy_registration_alive` não vigia o proxy.** Lê `plan_users`, que é o Survival, então
>   **não cobre o apagão de maio a agosto/2026 que lhe deu origem**: naquele período a tabela de
>   números verificados mostra o proxy morto e o Survival registrando 106 jogadores em jun/2026 — o
>   silêncio teria ficado em zero hora. O que ele vigia é real (registro parando no Survival, que é
>   a aquisição do Survival), e por isso continua rodando; os sumários passaram a dizer Survival e a
>   dizer explicitamente que não cobrem o proxy. **O identificador não foi renomeado** — a string é
>   persistida e é a chave do histórico do próprio check, e renomear partiria a série em duas e
>   zeraria em silêncio a memória da política de alerta. Renomear ou não é decisão do dono.
> - **`platform.offline_account_share` está correto**, e vale registrar por que: ele consulta
>   `/v1/playersTable?server=<backend>`, escopado por servidor, então já mede o Survival e o diz no
>   `context`. Nenhum número muda.

> ### ⚠️ `no_data` nunca alerta sozinho — logo, fonte vazia é `error` (corrigido em 2026-08-29)
>
> `NOTIFIABLE_STATUSES` tem `breached` e `error`, e **não** `no_data`. A política (`decideAlerts`)
> suprime um `no_data` como `not_notifiable` enquanto não há problema aberto no check — sem
> temporizador e sem escalonamento. Isso é deliberado: *"sem base"* não é número baixo, e alertar em
> toda ausência de denominador é o ruído que deixa o canal mudo.
>
> A consequência não era: **um check que devolve `no_data` para sempre, a partir de um estado limpo,
> nunca gerava uma única mensagem** — e três checks usavam `no_data` para dizer algo muito pior que
> "sem base". `plan_servers` sem nenhum servidor (`orphan_instance`, `version_divergence`) e
> `plan_users` sem nenhuma linha (`proxy_registration_alive`) **são o desastre da §1**, não uma
> janela vazia: um inventário não tem janela, e um que volta vazio numa rede viva não respondeu,
> falhou. Os três passaram a devolver `error`. Buraco pré-existente desde a S6.3, achado numa
> revisão, nunca observado em produção.
>
> **A regra que fica**, e vale para todo check novo: antes de devolver `no_data`, pergunte se esse
> veredito se repetindo por um mês deveria ser ouvido. Se sim, é `error`. `no_data` fica para a
> janela que genuinamente veio vazia — amostra pequena demais, versão que o Plan nunca gravou,
> comparação com um dos lados ausente. O limite é *de quem* é o vazio: `PLAN_SERVERS` não
> configurada continua `no_data`, porque nada falhou — é a nossa configuração que está em branco, e
> um ambiente de staging não pode paginar o canal a cada janela de re-alerta. É a mesma calibração
> que o `InstrumentationHealthService` já faz para os checks `missing`.
>
> O `/health/instrumentation` já tratava `no_data` como degradado, mas isso é "ir olhar uma página",
> que é exatamente a postura que o ADR-006 recusa.

### 6.2 Camada 2 — Funil em camadas

O funil real tem quatro degraus, e só o terceiro tinha alguma medição:

```
conecta na rede (proxy)          → 100%   ← SEM FONTE: a população do proxy não está neste banco
chega ao survival                →  54%   ← descoberto em 2026-08-21; é o degrau que tem números
entra no tutorial                →  varia ← quebrou em dez/2025, silencioso
conclui o tutorial               →   0,3% histórico
retém D1/D7/D30                  →  por plataforma
```

Requisitos: cada degrau segmentável por `platform`; série mensal por coorte; **`n` sempre exibido
ao lado de todo percentual**; "sem dados" explícito, nunca zero.

> #### 🔴 Os dois primeiros degraus trocaram de lugar em 2026-08-31
>
> Até essa data `plan_users` alimentava o degrau **`rede`** e o `survival` saía `null`. A medição
> inverteu isso: `plan_users` guarda o **Survival**. As três consultas e a tabela mês a mês estão no
> [`HANDOFF.md`](HANDOFF.md); o resumo é que o proxy tem zero jogadores em `plan_user_info` e as
> contagens batem linha a linha com a coluna `survival` dos números verificados.
>
> **As contagens não mudaram; os rótulos mudaram.** O que isso conserta não é um número, é uma
> **conversão**: `rede → survival` era Survival ÷ Survival, perto de 100%, e não teria caído com a
> rede inteira apagada — a mesma classe do 4500% que este módulo já publicou duas vezes.
>
> O que o funil passa a publicar:
>
> | degrau | antes | agora |
> |---|---|---|
> | `rede` | contagem de `plan_users` | **`null` com motivo**: a população do proxy não está nesta fonte |
> | `survival` | `null` — "sem fonte" | contagem de `plan_users`, **com a procedência no payload** |
> | `tutorial_entrou` / `tutorial_concluiu` | `tutorial_daily` (S8.0) | inalterados |
>
> A ressalva de procedência viaja no `sources[].provenance`, não só num docblock: a tabela lida é
> `plan_users`, e a identidade Survival dela é **coincidência medida, não garantia de schema** —
> `plan_user_info`, que registraria por servidor, é a **exceção 1** do ADR-002 e pertence à S8.2. Se
> o proxy algum dia passar a registrar em `plan_users`, esta série volta a ser de rede e o rótulo
> `survival` passaria a **superestimar** as chegadas, em silêncio.
>
> **Conversões publicadas:** os três pares consecutivos. A ponte `rede → tutorial_entrou`, que
> existia para pular por cima de um `survival` sem fonte, foi removida — `survival` agora é
> **adjacente** a `tutorial_entrou`, então a ponte só repetiria um par consecutivo, e o repetiria
> como `null`.
>
> **Efeito colateral bom, e é o único ganho de medição aqui:** a segunda metade do DoD da S8
> (*"~100% de entrada no tutorial antes de dez/2025"*) é `tutorial ÷ survival`, e passou a ser
> exatamente um par consecutivo deste endpoint. Nov/2025 dá `694 / 682 = 101,8%`. Calculável a
> partir de agora; **ainda não rodado contra produção**.

### 6.4 Camada 3 — Economia (nova)

Três métricas que ninguém tem hoje e que mudam decisão, não só ilustram slide.

**E1 — Receita por plataforma e por coorte.** Bedrock é 45,4% dos jogadores do survival. Quanto por
cento da receita ele produz? Se for 10%, consertar o onboarding de celular vale muito menos do que
a contagem de cabeças sugere. Se for 45%, vale exatamente o que parece. **Nenhuma decisão sobre
priorizar Bedrock deveria ser tomada antes desse número.**

**E2 — Tempo até o primeiro gasto, e posição no funil como preditor.** Cruzando
`playerpoints_transaction_log` (take do servidor) com o funil da §6.2: quem conclui o tutorial
gasta mais? Quem trava no passo 03 gasta alguma coisa? Responde se o tutorial tem retorno
financeiro ou só custo.

**E3 — Contato social nos primeiros minutos.** Pagamento entre jogadores é registro de **contato
social real** — um dos preditores mais fortes de retenção em jogo multiplayer. Métrica: fração de
novatos que envia ou recebe pagamento nos primeiros N minutos, e o D7 desse grupo contra o resto.

**E4 — Feed de pagamentos com marcação de anomalia (ferramenta de moderação, não métrica).**
Últimos N pagamentos entre jogadores, **admin-only**. Um feed cronológico puro é inútil: com ~3
pagamentos/dia, os 10 últimos cobrem 3 dias e repetem as mesmas pessoas. O valor está na marcação:

- valor acima do percentil habitual da janela
- mesmo par emissor→receptor se repetindo
- conta recém-criada recebendo quantia grande
- uma conta financiando muitas outras

Cobre venda por dinheiro real, financiamento de alt, golpe e abuso de permissão de give. Marcar é
sinalização, **nunca acusação automática** — a decisão é humana.

**Restrição:** este feed é exclusivamente administrativo. Nome de jogador e valor de transação
**não** aparecem no site público sob nenhuma circunstância (§8, LGPD).

Nota: o `10tutorial` exige `/pagar <nick> 100`. O log registra tanto a conclusão desse passo quanto
interação social espontânea — separar os dois é requisito, não detalhe.

Regras da camada: `n` obrigatório junto de todo percentual; valores monetários sempre com a janela
temporal explícita; nenhum dado pessoal além de UUID e valor.

### 6.3 Camada 4 — Operação

Pico de jogadores, jogadores por período, **média de tempo online ativo (AFK fora)**, jogadores por
cargo LuckPerms, vendas (`ausTvSales`), últimas sugestões, entradas/saídas do Discord.

## 7. Entidades (contrato próprio do NestJS)

```
player        uuid · platform · username · first_seen · last_seen · luckperms_group
session       player_uuid · server · started_at · ended_at · active_sec · afk_sec
player_econ   player_uuid · balance · spent_total · first_spend_at · p2p_in · p2p_out
transaction   player_uuid · type (take|p2p_in|p2p_out|grant) · amount · category · created_at
funnel_daily  date · platform · rede · survival · tutorial_entrou · tutorial_concluiu
health_check  check_name · status · checked_at · detail · alerted_at
suggestion    id · discord_msg_id · author · text · votes_up · votes_down
              status · created_at · updated_at · assignee
guild_metric  date · joins · leaves · members_total
```

## 8. Superfície de ataque

| ponto de entrada | risco | mitigação |
|---|---|---|
| Webserver do Plan | exposto à internet | **não pode ser `127.0.0.1`** — o NestJS na VPS precisa alcançar `/v1/*` pela rede. Alvo: **firewall liberando a porta só para o IP da VPS** + **whitelist de IP do próprio Plan** também restrita a ele + autenticação ligada. Duas camadas, não uma |
| **MySQL do jogo alcançável pela internet** | credenciais em texto plano em 4 configs de plugin já concedem acesso total | **auditar `3306` de um host externo real antes da S6** — teste rodado na própria máquina do jogo é loopback e não vale. Se aberta ao mundo: fechar e liberar só o IP do sales.austv.net, ou túnel SSH |
| ETL entre VPSs | credencial trafegando e em repouso | usuário read-only por fonte, segredo em variável de ambiente, canal cifrado |
| MySQL do Plan ← NestJS (coorte) | credencial ampla, lag no servidor | usuário **read-only** dedicado; agregação fora do pico |
| `/v1/*` sob carga | query pesada afeta o jogo | cache com TTL por endpoint |
| Bot Discord | comando de staff por qualquer um | role verificada server-side, nunca só no client |
| Sugestões no site público | XSS via texto de jogador | sanitizar na escrita **e** escapar na renderização |
| API | IDOR em rota de jogador | JWT + verificação de escopo por recurso |
| Dados pessoais | LGPD | contagem de mensagens, não conteúdo; sem IP no dashboard |

Credenciais MySQL em texto plano em mcMMO, EvenMoreFish, BattlePass, MyCommand — **não versionar
sem sanitizar**.

## 9. Critérios de aceite

- [x] Proxy e backends na **mesma build** do Plan, num **único** MySQL — **satisfeito em
  2026-08-20**, fora do fluxo de sprint. Passa a ser vigiado continuamente pelos checks
  `plan.orphan_instance` e `plan.version_divergence`
- ~~webserver só no proxy em `127.0.0.1`~~ — **contraditório com a §8 e não resolvido.** A §8 exige
  o webserver alcançável pela rede, senão o NestJS da VPS não consome `/v1/*` (ADR-001/002). Este
  critério não pode ser aceito como está; depende da decisão de exposição de rede da §10b
- [x] **Os 7** checks de saúde da §6.1 implementados e agendados — o escopo foi reduzido para 6 em
  2026-08-23 (decisão do dono, opção 3) porque o sétimo,
  `funnel.tutorial_entry_rate`, não tinha fonte de dado. A **S8.0** construiu a fonte
  ([ADR-0004](../../decisions/ADR-0004-fonte-dados-tutorial.md)) e o sétimo entrou em 2026-08-28,
  fechando o conjunto retroativamente
- [ ] Verificado **derrubando uma instância de propósito** — pendente: exige o agendamento ligado
  com webhook num ambiente real
- [x] Alerta de taxa de entrada no tutorial testado com **valor forçado** — S8.0 critério 5.
  `tutorial-entry-rate.alert.spec.ts` força 12 de 100 (a taxa real de abril/2026), segue o veredito
  pelo `decideAlerts` e pelo `DiscordAlerter`, e assere sobre o **payload HTTP** que iria ao webhook:
  o valor, a base ao lado dele, e menções inertes.
  > Isto **não** substitui o critério acima. Este teste prova que a mensagem é *construída* certo a
  > partir de uma leitura em falha; só produção prova que ela *chega*. A distinção é o assunto do
  > [`S6-VERIFICACAO.md`](S6-VERIFICACAO.md).
- Funil de 4 degraus disponível por mês e por plataforma, com `n` visível
- Sessão, AFK e tempo por servidor conferidos contra **observação manual**
- NestJS não referencia tabela interna do Plan fora do módulo de coorte
- Nenhum I/O de rede na main thread (verificado com timings)
- Sugestões nos 4 estados, transição só por staff verificado server-side
- ~~Corpus do Carlito exportado e versionado antes de qualquer migração~~ — **removido em
  2026-08-22**: o Carlito é o Carl-bot, bot de terceiros, o acervo não é recuperável do banco dele,
  e o dono decidiu que perder os registros antigos é aceitável (S6.1 cancelada)
- `code-reviewer` aprovado · `cybersecurity-validator` sem crítico · testes passando

## 10. Riscos

| risco | impacto | mitigação |
|---|---|---|
| Builds diferentes do Plan no mesmo banco | corrupção de schema | igualar versão **antes** de unificar; mysqldump antes |
| Unificação depois do unban | campanha medida em dois lugares | fazer antes; se não der, adiar o merge, nunca a unificação |
| Tráfego de bot inflando aquisição | decisão de marketing em cima de número falso | check de share offline (§6.1) + amostra de nomes |
| `playerpoints_transaction_log` desabilitado ou podado | E1/E2/E3 ficam sem histórico | conferir contagem e janela **antes** de planejar a camada de economia |
| Tabela sem índice varrida com jogadores online | queda de TPS no servidor de jogo | ETL noturno fora do pico (ADR-007); nunca agregação ao vivo. Índice em `(receiver, timestamp)` só em janela de manutenção, se o dono aprovar |
| Schema de plugin mudando em update | camada de economia quebra | só PlayerPoints e LuckPerms (schemas triviais); MyCommand fora |
| Dashboard vira o projeto | funil segue quebrado | camada 3 é a última; camada 1 é PR 1 |
| Amostra pequena | ruído lido como tendência | `n` obrigatório; retenção é relatório |
| ~~Carlito não exporta~~ | **risco materializado e aceito (2026-08-22)** | O Carlito é o Carl-bot; o acervo não sai do banco dele. O dono aceitou a perda dos registros antigos e a S6.1 foi cancelada. Sugestões novas nascem sem histórico |

## 10b. Risco aceito pelo dono — exposição de rede (2026-08-21)

**Estado verificado:** `mariadbd` em `0.0.0.0:3306` · `ufw` **inativo** · conta MySQL
`u1_Eayoo9559P@%` (aceita conexão de qualquer host) · credenciais em texto plano em mcMMO,
EvenMoreFish, BattlePass, MyCommand · porta 3306 respondeu de **três pontos independentes**: VPS
sales.austv.net, PC residencial (`TcpTestSucceeded: True`, IP 198.89.99.70) e confirmação cruzada.
Porta 25504 idem.

**Decisão do dono (Murilo, 2026-08-21):** tratar como responsabilidade da MagnoHost e seguir com o
dashboard.

**Registro técnico:** a evidência acima é incompatível com filtragem ativa pelo provedor — tráfego
de rede residencial completou handshake TCP na 3306. A whitelist de IP configurada no Plan é filtro
de **aplicação** e cobre apenas a 25504; não afeta a 3306.

**Impacto no projeto:** o ETL e a API assumem que a rede entre VPS e game é alcançável — o que é
verdade hoje. Se a MagnoHost restringir por IP no futuro, a S6.2b precisa ser reaberta para incluir
o IP da VPS no allowlist, ou o ETL para de funcionar sem aviso.

Reabrir esta seção se: houver incidente no banco, a MagnoHost confirmar por escrito o que filtra,
ou o allowlist mudar.

## 11. Investigações em aberto (não são código)

1. **O que aconteceu em fevereiro/2026?** É onde a aquisição caiu de 1.177 para 645. Nenhuma
   hipótese testada ainda.
2. **Os `java_offline` do proxy são bots?** 39,3% de conversão contra 71,5% do Bedrock. Amostra de
   nomes resolve.
3. **O conserto do tutorial funcionou?** Verificar em 5–7 dias se a taxa de entrada voltou para
   perto de 100%.
   - **3b1. A whitelist de IP do Plan é contornável por `X-Forwarded-For`?** Testar da VPS com e
     sem o header; código HTTP diferente = whitelist sólida, igual = contornável. Filtro de
     aplicação nunca substitui filtro de rede.
   - **3b. As portas `3306` e `25504` de jogar.austv.net respondem de um host externo?** Testar a
     partir do sales.austv.net (externo ao jogo **e** origem do ETL). Teste feito na própria
     máquina do jogo é loopback e não responde a pergunta. Exposição aqui é ativa hoje, anterior a
     este projeto.
4. **O `playerpoints_transaction_log` tem histórico?** `COUNT(*)` + `MIN/MAX(timestamp)`. Define se
   a economia é histórica ou prospectiva. Rodar fora do pico — sem índice, varre a tabela inteira.
5. **Quais são os `transaction_type` e o `amount` fica negativo no take?** Define como separar
   gasto de recebimento.
6. O campo `description` classifica o gasto? **Respondido:** não — só Take/Give/Pay/Starting
   balance. Irrelevante agora, porque o gasto vem do `ausTvSales` (R3 resolvido).

## 12. Relação com o resto

A Sprint 5 do `ausTvSales` (ranking, série temporal) está em voo e **não é atropelada**: seus
componentes de gráfico são a base da camada 3. Terminar a S5 primeiro reduz o trabalho aqui.

As correções do funil de onboarding rodam em paralelo e **têm precedência**. Este sistema mede; ele
não conserta.
