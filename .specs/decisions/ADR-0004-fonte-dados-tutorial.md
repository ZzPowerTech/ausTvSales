# ADR-0004 — Fonte de dados do tutorial

- **Status:** Proposto (aguardando aprovação do Murilo)
- **Data:** 2026-08-28
- **História:** [S8.0](https://github.com/ZzPowerTech/ausTvSales/issues/148) — AusTV Admin Sprint 8
- **Decisor:** Murilo
- **Fecha:** a primeira tarefa da S8.0 (*"escolher a fonte"*) e, por consequência, o 7º check da
  §6.1 e o degrau `tutorial_entrou` da S8.1

> ### ⚠️ Dois namespaces de ADR neste repositório — leia antes de seguir uma referência
>
> Este arquivo é `ADR-0004` no índice de [`.specs/decisions/`](README.md), a numeração do
> **`ausTvSales`** (0001 auth plugin→API, 0002 permissões, 0003 biblioteca de gráfico).
>
> O épico **AusTV Admin** tem uma numeração **própria e independente**, embutida no
> [`spec.md`](../features/austv-admin/spec.md): ADR-001 a ADR-008. Quando este documento cita
> "ADR-003" (plataforma pelo UUID), "ADR-007" (zero Java na v1) ou "ADR-008", são **os do spec do
> Admin** — não os deste diretório. Repare que o Admin já tem um ADR-004 seu ("`ausTvSales` continua
> MIT e intocado pela LGPL"), que **não** é este.
>
> É a mesma colisão que o `CLAUDE.md` resolveu para as sprints, e resolvida do mesmo jeito: **não
> renumerar**, separar por contexto e dizer onde cada uma vale. Renumerar quebraria dezenas de
> referências cruzadas no spec para resolver um problema que é só de organização.

## Contexto

O Plan **não coleta absolutamente nada do tutorial**. Isso foi descoberto em 2026-08-23 ao desenhar
o port dos sete checks da §6.1, e é a razão de a S6.3 ter fechado com seis.

Os números de tutorial do [`HANDOFF.md`](../features/austv-admin/HANDOFF.md) vieram de ler
`Quests/playerdata/*.yml` **na máquina do game**, com os scripts do baseline. Esses arquivos não
são alcançáveis pela API `/v1/*`, não estão no MySQL do Plan e não estão no PostgreSQL do
`ausTvSales`. **Nenhuma das duas exceções ao ADR-002 ajuda** — o dado não está em banco nenhum.

O que fica sem cobertura enquanto isso: o tutorial parou de capturar novatos em **dez/2025** e a
taxa de entrada caiu de ~100% para 12% ao longo de **8 meses**, sem ninguém notar. É o desastre mais
longo já registrado neste servidor, e o check que o teria pego é justamente o que não tem fonte.

## Decisão

**Opção 1 — ETL lendo `Quests/playerdata/*.yml`, a fonte real.**

As alternativas, com o que cada uma custa:

| # | opção | custo | o que perde |
|---|---|---|---|
| **1** | **ETL lendo `Quests/playerdata`** | ETL de **arquivo**, não de banco; exige que o diretório seja alcançável a partir da API | **nada — é a fonte real** |
| 2 | Proxies do Essentials (`kit prot` = `02tutorial`, `home` ≥1 = `05tutorial`) | mais barato; os scripts do baseline já leem | são **proxies**: kit ou home obtidos por outra via inflam o número |
| 3 | Entregar 6 dos 7 checks e adiar o do tutorial | zero agora | **já foi escolhida**, em 2026-08-23 — é o que abriu esta história. Não é mais uma opção; é o estado de que se parte |
| 4 | Instrumentar o tutorial na origem (plugin/comando) | contraria o **ADR-007** (zero Java na v1) | reabre decisão fechada, e implanta código na produção do Minecraft |

> A numeração salta de propósito e a opção 3 está listada por isso: ela existe nas quatro opções
> originais do `HANDOFF.md`, e omiti-la faria a tabela parecer ter perdido uma linha. Escolhê-la de
> novo seria adiar indefinidamente.

### Por que a opção 2 é recusada mesmo sendo mais barata

Trocar a métrica por uma proxy **sem rótulo** seria repetir a classe de erro que o `HANDOFF.md`
inteiro existe para impedir — foi exatamente assim que a série do `Quests/playerdata` foi lida como
"chegadas" e produziu três conclusões erradas na investigação original.

O critério 6 da história prevê a opção 2 *com* rótulo obrigatório. Mesmo assim: quando a fonte real
está disponível e o custo extra é um parser, aceitar um número inflado por construção não se paga.

### Por que a opção 4 não é considerada seriamente

O ADR-007 fechou "zero Java na v1", e o ganho declarado foi **superfície de risco zero na produção
do Minecraft**. A opção 4 devolve exatamente essa superfície para medir um número que a opção 1 já
mede. Reabrir uma decisão fechada precisa de um argumento melhor que "seria mais direto".

## O que a fonte de fato contém

Formato real, colhido da saída do baseline de 2026-08-19 (`ops/baseline/2026-08-19/`), **não de
documentação**:

```yaml
quest-progress:
  01tutorial:
    started: false
    started-date: 1723333480856      # epoch ms
    completed: true
    completed-before: true
    completion-date: 1723333480856   # epoch ms
    task-progress:
      objetivo:
        completed: false
```

- **Um arquivo por jogador**, nomeado com o UUID — o que dá `platform` de graça pelo ADR-003.
- **`started-date` e `completion-date` são epoch ms.** Consequência que muda o escopo: a fonte tem
  **granularidade temporal real**, então `tutorial_entrou` e `tutorial_concluiu` viram série
  diária, não apenas um retrato. O `HANDOFF.md` tratava o tutorial como número de snapshot.
- Os ids das quests do tutorial são os nomes de arquivo de `Quests/quests/tutorial/*.yml` — **41
  quests** no baseline, com prefixo numérico e variantes (`04-2tutorial`, `12-3tutorial`).

Números do baseline, com o que cada um vale como referência:

| medida | valor | serve de teste de aceitação? |
|---|---|---|
| `playerdata_total` | 19.700 | sim |
| tocou `01tutorial` | 10.834 | **sim** — e coincide com `playerdata_com_tutorial: 10834`, ou seja, "tocou `01tutorial`" e "tocou qualquer quest do tutorial" são o mesmo conjunto neste snapshot |
| concluiu `33tutorial` | 148 | **não — ver abaixo** |

### ⚠️ O baseline superconta conclusões, então não é árbitro dessa coluna

Descoberto no code review deste ADR. O bloco 2 de `austv-diagnostico.ps1` é um scanner de linha que
mantém a quest corrente aberta enquanto a indentação for maior, e testa:

```powershell
elseif ($curId -ne $null -and $key -eq 'completed' -and $val -eq 'true') { $curDone = $true }
```

**Em qualquer profundidade.** O payload real tem `task-progress: <task>: completed: <bool>` aninhado
*dentro* do bloco da quest. Logo, uma quest **em progresso** cujo objetivo esteja concluído é
contada pelo script como **quest concluída**.

O parser deste projeto lê apenas a chave de nível da quest — está correto, e por isso pode produzir
um número **menor** que o do baseline. A versão anterior deste ADR dizia *"se o ETL não reproduzir
essas contagens, o parser está errado, não o baseline"*, o que instituía como árbitro justamente o
lado com o defeito.

### O que ainda **não** foi medido, e é preciso dizer

**Ninguém rodou este parser contra os 19.700 arquivos.** O parser foi testado contra o payload de
amostra transcrito da saída do baseline; a coluna `concluiu` do baseline e a coluna `completed` do
ETL nunca foram comparadas.

Afirmar coincidência sem executar é a causa raiz dos cinco erros do `HANDOFF.md` — e literalmente do
erro 1, que nasceu de ler esta mesma série do `Quests/playerdata`. Portanto:

- `19.700` e `10.834` valem como conferência de sanidade do lado da **entrada**.
- O `148` **não** vale como alvo. Quando o ETL rodar contra o snapshot real, esperar um número
  **menor ou igual**; uma diferença para menos é evidência de que o script supercontava, não de que o
  parser errou. Registrar o par de números quando isso acontecer.

## Consequências

### 1. O acesso ao diretório é o custo real, e não é resolvido por este ADR

A API roda na VPS do `sales.austv.net`; os arquivos estão na máquina do game. O ETL lê de um
**diretório configurado** (`TUTORIAL_PLAYERDATA_DIR`), e como esse diretório chega até lá é decisão
de operação, com três saídas conhecidas:

| via | prós | contras |
|---|---|---|
| `rsync` periódico game → VPS | simples, sem montagem, funciona com a rede atual | cópia defasada; consome disco na VPS |
| Montagem read-only (SSHFS/NFS) | sempre atual | I/O de rede por arquivo; falha de rede vira lentidão, não erro claro |
| Coletor rodando na máquina do game | lê local, envia agregado | **novo processo na produção do Minecraft** — o que o ADR-007 evita |

**Recomendação: `rsync`.** É a única das três que não adiciona processo na máquina do jogo nem
transforma latência de rede em I/O por arquivo. A defasagem é aceitável: a métrica é diária.

**Enquanto o diretório não existir na VPS, o ETL reporta "sem dados" — nunca zero.** É o critério 3
da história, e é o que impede a ausência de um caminho de arquivo de virar "ninguém entrou no
tutorial", que é indistinguível do desastre que o check procura.

### 2. A fonte é **estado atual**, não log de eventos — e isso tem um preço

`Quests/playerdata` guarda o progresso vigente de cada jogador. Não é um histórico append-only.
Duas consequências que precisam estar ditas antes de alguém confiar numa série:

- **Um arquivo apagado apaga o passado.** Se um `playerdata` for removido ou resetado, os dias
  anteriores mudam retroativamente na próxima execução do ETL. A série é uma **reconstrução do
  passado a partir do presente**, não um registro do que foi observado no dia.
- **Reset de quest sobrescreve `started-date`.** Um jogador que refaz o tutorial move a própria
  data de entrada.

Nenhum dos dois invalida a métrica para o uso que ela tem — detectar que a **taxa de entrada
despencou** —, mas os dois invalidariam um uso contábil. Fica registrado para que o próximo a ler a
série saiba o que ela é.

### 3. O ETL é idempotente por construção

Como a fonte é um retrato do estado atual, reprocessar o mesmo diretório produz exatamente as mesmas
linhas. Re-executar é seguro e é a operação **normal**, não um caminho de recuperação. É o critério
2 da história.

A gravação **substitui a série inteira** dentro de uma transação, e não faz `upsert` por
`(data, plataforma)`. A diferença importa: um `upsert` deixaria de pé o número velho de um dia cujo
único entrante teve o `playerdata` apagado — e como a fonte é estado atual, esse dia *deve* mudar.
Substituir é o que torna a reconstrução fiel à fonte.

**Substituir tem um risco que o `upsert` não tem:** *qualquer* execução que chegue ao fim sem nada a
escrever apaga a série e grava `ok`. Quatro acidentes levam lá, e os dois últimos mantêm
`filesScanned` alto — por isso um piso que olhe só a entrada não os pega:

| acidente | como aparece | regra que recusa |
|---|---|---|
| `rsync` não rodou; montagem vazia | 0 arquivos | 1 — zero nunca é varredura válida |
| `rsync` pego no meio | poucos arquivos | 2 — abaixo de metade do último sync bom |
| **Quests mudou o formato do arquivo** | muitos arquivos, todos ilegíveis | 3 — taxa de falha ≥ 50% |
| **um id de quest foi renomeado** | muitos arquivos, zero jogadores no tutorial | 4 — zero contra um anterior > 0 |

Um diretório **vazio mas existente** não faz o `opendir` falhar, e é o caso mais provável na prática.
As regras 3 e 4 medem a **saída** da varredura, e existem porque a primeira versão deste ETL só
media a entrada — e passava batido justamente nos dois acidentes que não reduzem a contagem de
arquivos.

A regra 4 precisa do valor da execução anterior, e é por isso que `players_in_tutorial` é
**persistido** em `tutorial_syncs`, não apenas logado: "zero jogadores no tutorial" é legítimo num
servidor novo e catastrófico neste.

### 4. Fora do pico

Varredura de ~20 mil arquivos. O baseline levou **15s** em PowerShell na máquina local; com parse
de YAML completo será mais lento. Roda uma vez por dia, em horário configurável, e nunca no caminho
de uma requisição HTTP.

### 5. O 7º check nasce em cima disso

`funnel.tutorial_entry_rate` = `novatos_no_tutorial / novatos_no_survival`, com o denominador vindo
de `serverOverview.last_7_days.new_players` — a mesma fonte e a **mesma janela de 7 dias** que o
`funnel.network_to_survival` já usa. A janela é fixa pelo mesmo motivo registrado lá: o Plan só
oferece `last_7_days` neste endpoint, e janela configurável deixaria comparar um numerador de 30
dias com um denominador de 7.

## Alternativas rejeitadas

Já tabeladas acima (opções 2 e 4). Uma terceira, não listada na história, foi considerada e
descartada: **derivar a entrada no tutorial do `plan_users.registered`**, assumindo que todo novato
entra. É circular — assume verdadeira exatamente a proporção que o check existe para medir.

## Pendências que este ADR **não** decide

1. **Como o diretório chega à VPS.** Recomendado `rsync`; a execução é operação.
2. **Qual quest marca a conclusão.** O baseline aponta `33tutorial` — é o passo de maior prefixo, e
   o `HANDOFF.md` cita o mesmo id. *(O `148` que aparece ao lado dele na saída **identifica a
   quest**; ele não valida contagem nenhuma — ver a ressalva sobre a supercontagem do script, acima
   nesta página.)* O id fica **configurável** em vez de fixo no código: a estrutura do tutorial é
   fato de negócio e já mudou antes. O id efetivamente usado é gravado em cada execução do ETL.
3. **O limiar do check** (a §6.1 propõe 70% por 3 dias) entra como **chute conservador marcado como
   tal**, igual aos três da S6.3, e precisa de calibração contra o baseline.
