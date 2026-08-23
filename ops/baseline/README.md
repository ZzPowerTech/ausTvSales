# Baseline pré-campanha — o "antes" do AusTV congelado

> História [S6.0](https://github.com/ZzPowerTech/ausTvSales/issues/106) · Sprint `AusTV Admin S6`
>
> **As-of oficial: 2026-08-19 20:20** (`login_mais_recente` da saída 1 — a ponta empírica).
> Origem: clone offline de `plugins/` do Survival em `D:\AUSTV\clone_survival`, criado em
> **2026-08-13**, com `Essentials/` (19/08 19:56) e `Quests/` (19/08 20:14) — **as duas pastas que
> os scripts leem** — ressincronizadas em **2026-08-19**.

> ⚠️ **Use a as-of, não a data do clone.** O README ensina abaixo que todos os buckets de churn são
> relativos ao instante de referência. Tomar 08-13 como esse instante erra em 6 dias no churn, nos
> ativos30 e no corte do mês 2026-08.

## Por que este diretório existe

Estes são hoje o **único registro histórico de retenção do AusTV anterior ao Plan**. Os scripts leem
arquivos de `playerdata` e `userdata` que a campanha de unban all vai alterar. Rodar depois não
reproduz este dado — produz outro dado, de outro momento.

Ou o "antes" ficou capturado aqui, ou não há com o que comparar o "depois". É o único item da
Sprint 6 cujo custo de atraso é perda permanente, não retrabalho.

Os scripts **não modificam nada em `plugins/`**. A única escrita é o arquivo de saída, gravado ao
lado do `.ps1` (`$PSScriptRoot`).

## O que está aqui

```
ops/baseline/
├── README.md                         ← este arquivo: como ler cada número
├── scripts/
│   ├── austv-diagnostico.ps1         churn, sessão, tipo de conta, gates do tutorial, último login/mês
│   └── austv-diagnostico2.ps1        funil por plataforma, retenção retroativa, coorte por mês
└── 2026-08-19/
    ├── austv-diagnostico-saida.txt   execução de 2026-08-19 20:57
    └── austv-diagnostico2-saida.txt  execução de 2026-08-19 21:12
```

A data do snapshot está no nome do diretório **e** no cabeçalho de cada saída. Uma re-execução
futura cria um diretório irmão (`2026-09-XX/`), nunca sobrescreve este.

**Scripts versionados verbatim**, com `md5` conferido contra a origem. É o que dá valor probatório
ao par: a saída commitada corresponde exatamente ao código que a produziu. Duas consequências:

- Os caminhos e instruções **no cabeçalho dos scripts** são anteriores à versionagem e foram
  preservados de propósito. Siga o roteiro do fim deste README, não o cabeçalho.
- Os scripts estão **inteiramente em português** (`$maiorArq`, `$curtoSemHome`, rótulos de saída),
  contra a convenção "código em inglês" do `CLAUDE.md`. **Exceção deliberada:** traduzir mudaria os
  rótulos que as saídas já usam e destruiria o pareamento.

### O que não foi localizado

Três dos cinco artefatos citados no [HANDOFF](../../.specs/features/austv-admin/HANDOFF.md) não
estão versionados. **Procurados em:** todo o histórico do git (todas as branches), o disco `D:`
(`/d/AUSTV`, `/d/Faculdade`) e a pasta do Drive de onde vieram o spec e o plano. Não repita a busca
nesses lugares.

| ausente | o que fazia |
|---|---|
| `austv-diagnostico3.ps1` | chegadas e saídas por mês × plataforma + cross-check independente |
| `plan-forense.sh` | forense da instalação do Plan na VPS (resolveu o caso do SQLite) |
| `plan-analise.sql` | 5 blocos: cobertura, chegadas, atividade/bounce, retenção, antes-vs-depois do tutorial |

O `austv-diagnostico3.ps1` é o mais custoso de perder: era ele que fazia o **cross-check
independente** — exatamente o controle cuja ausência produziu os três erros descritos abaixo.
**Não foi reconstruído**, e reconstruí-lo do zero para apresentá-lo como o original seria pior que a
perda. As fontes independentes de reposição estão no fim deste documento.

## Sanitização

Conferido antes do commit: as duas saídas **não contêm UUID, nickname, IP nem qualquer
identificador de jogador**. São contagens e distribuições agregadas. O bloco `AMOSTRA: maior
playerdata` da saída 1 despeja 45 linhas de um arquivo de quests — só ids de quest e timestamps
epoch. O nome do arquivo, que **é** o UUID do jogador, nunca é impresso: o script imprime apenas o
tamanho em bytes (`$maiorTam`), nunca `$maiorArq`. Os scripts não têm credencial embutida.

---

# Como ler cada número

> Esta seção é o entregável principal da S6.0. O dado sozinho já induziu a erro três vezes.

## A regra que vale para tudo: são bases diferentes, e são três, não duas

| base | fonte | tamanho | quem entra nela |
|---|---|---|---|
| **userdata** | `Essentials/userdata/*.yml` | **49.302** | todo jogador que já teve registro no Essentials |
| **playerdata** | `Quests/playerdata/*.yml` | **19.700** | todo jogador com arquivo criado pelo Quests — **8.162 (41,4%) estão vazios** |
| ↳ com dado de quest | idem | **11.538** | tocou em **alguma** quest (inclui 704 que nunca tocaram no tutorial) |
| ↳ com dado de tutorial | idem | **10.834** | tocou no **tutorial** |

**Misturar as bases é a causa raiz dos três erros do HANDOFF.** Sempre que um número aparecer sem
base, ele está incompleto.

> ### A demonstração, com números destes próprios arquivos
>
> `01tutorial` tem **8.391 conclusões** nos dois relatórios (na saída 2 vem partido por plataforma:
> 4.459 + 2.494 + 1.438 = 8.391).
>
> - Sobre **19.700** → **42,6%** (saída 1)
> - Sobre **11.538** → **72,7%** (saída 2, agregando as plataformas)
>
> **Mesmo numerador, 1,7× de diferença, só pela troca de denominador.** Não há divergência entre os
> relatórios — há duas perguntas diferentes. Este é o mecanismo exato dos três erros lá embaixo.

## `austv-diagnostico.ps1`

### Bloco 1 — Essentials userdata (base 49.302)

| número | o que mede de verdade | limitação que muda a leitura |
|---|---|---|
| `arquivos_userdata: 49302` | contas com registro no Essentials, all-time | não é "jogadores únicos que chegaram". Uma pessoa com conta Java e Bedrock conta duas vezes |
| `login_mais_recente` / `defasagem` | o **relógio de referência do script**, e a as-of oficial deste baseline | todos os buckets de churn são relativos a este instante, **não a hoje**. Rodar de novo sobre o mesmo clone daqui a um mês dá exatamente os mesmos números |
| **CHURN `<=1d` … `>365d`** | distribuição do **último** login | ⚠️ **os rótulos parecem cumulativos, mas os baldes são EXCLUSIVOS** (`if/elseif`). Ver a caixa abaixo |
| DURAÇÃO DA ÚLTIMA SESSÃO | `logout − login` da **última** sessão, só dela | não é sessão típica nem playtime. `logout < login` (jogador online no momento do dump, ou crash) vira `sem_dado` — são 202 casos |
| TIPO DE CONTA — **59,2% bedrock** | mix **all-time** | ⚠️ **não é o mix atual.** Em 2026 a fatia bedrock das chegadas oscila entre **23% e 43% ao mês** (tabela de números verificados do HANDOFF, três fontes cruzadas) — nunca perto dos 59,2%. Esse intervalo **não sai deste snapshot**; a fonte é o HANDOFF |
| `recebeu_kit_prot` 11,8% | contas com o kit `prot` registrado | **proxy** da recompensa do `02tutorial`, não a conclusão dele. Kit obtido por outra via infla |
| `tem_pelo_menos_1_home` 21,4% | contas com ≥1 home | **proxy** do gate do `05tutorial` (`/casacriar`). Home criada fora do tutorial também conta |
| `sessao_curta_sem_home` 42,5% | sem home **E** última sessão < 5 min | **não é bounce.** Mede a **última** aparição, não a primeira: quem jogou meses e cuja última visita foi rápida entra aqui |
| `saldo_zero` 11.611 | contas com `money ≤ 0` entre as que têm o campo legível | snapshot de **saldo**, não de fluxo. Não usar como métrica de economia — ver a regra do grant administrativo no HANDOFF |
| `ativos_ultimos_30d` 579 | último login dentro de 30d **do instante de referência** | não é "ativos hoje" |
| ÚLTIMO LOGIN POR MÊS | **quando cada leva parou** | ⚠️ é uma série de **saídas**, não de chegadas. Ler ao contrário inverte a conclusão |

> ### ⚠️ CHURN: os rótulos mentem, e o próprio arquivo se contradiz
>
> A tabela usa rótulos cumulativos (`<=1d`, `<=7d`, `<=30d`…) sobre uma cadeia `if/elseif`, ou seja,
> **baldes mutuamente exclusivos**. Quem lê `<=30d 328` conclui "328 logaram nos últimos 30 dias".
> O valor verdadeiro é **579**.
>
> | rótulo | significa de verdade | cumulativo real |
> |---|---|---|
> | `<=1d` 71 | 0–1 dia | **71** |
> | `<=7d` 180 | 1–7 dias | **251** |
> | `<=30d` 328 | 7–30 dias | **579** |
> | `<=90d` 384 | 30–90 dias | **963** |
> | `<=365d` 5.399 | 90–365 dias | **6.362** |
>
> O número correto (**579**) está impresso **22 linhas abaixo, no mesmo arquivo**, como
> `ativos_ultimos_30d 579`. A saída se contradiz na cara do leitor.
>
> **Nunca cite um balde isolado como se fosse cumulativo.** Se um script sucessor for escrito,
> renomear os rótulos para faixas (`1-7d`, `7-30d`, …).

### Bloco 2 — funil do tutorial (base 19.700, **outra base**)

- O `%concl` de cada quest é sobre **19.700**, não sobre 49.302.
- `playerdata_vazio_0kb` = 8.162 (41,4%): entrou no servidor e nunca tocou em quest nenhuma.
- `passo 33 → 148` é o número real de conclusões do tutorial no acervo.

⚠️ **A coluna `%concl` não é um funil linear.** São **41 arquivos de quest para 33 passos
numerados**:

- Os sufixos `-2`/`-3` são **ramos opcionais** pendurados no passo anterior (`04-2` exige `04`;
  `12-3` exige `12-2`), **não sub-passos**. Não somar `04` + `04-2`.
- Seis passos — **04, 10, 12, 19, 26, 28** — têm 23–98 conclusões all-time contra 150–500 dos
  vizinhos, e o grafo de `requires` é incompatível com o acervo nesses seis pontos (`04` tem 98
  conclusões, mas `04-2` e `05`, que dependem dele, têm 872 e 1.146). A leitura consistente é que
  esses passos foram **inseridos depois** e o `requires` dos vizinhos foi religado.
- **Logo a coluna atravessa duas topologias de tutorial** e não pode ser lida como funil.

#### `ATE ONDE CHEGOU` — percentual sobre uma população que não é a dele

O histograma só conta quem chegou ao tutorial (**10.834**), mas os percentuais são impressos sobre
**19.700**. Por isso a coluna soma 55%, não 100%.

`passo 0 → 2.443 → 12,4%` **não** quer dizer que 12,4% não saiu do lugar. Quem nunca concluiu passo
nenhum é `8.162 vazios + 704 sem tutorial + 2.443 = **11.309 (57,4%)**`.

> 12,4% contra 57,4% é a diferença entre "o tutorial vaza" e "o tutorial praticamente não existe
> para a maioria" — e é essa métrica que decide a prioridade do conserto de onboarding, que o spec
> diz vir **na frente** deste sistema.

#### As três leituras da taxa de conclusão

O HANDOFF cita "148 em 49.302 (0,3%)", que mistura numerador do Bloco 2 com denominador do Bloco 1.
São três leituras defensáveis, cada uma respondendo a uma pergunta diferente:

| leitura | valor | responde |
|---|---|---|
| 148 / 49.302 | **0,30%** | piso sobre todas as contas do Essentials |
| 148 / 19.700 | **0,75%** | sobre todo mundo com arquivo do Quests |
| 148 / 10.834 | **1,37%** | de quem efetivamente entrou no tutorial |

Nenhuma é "a certa". A errada é citar qualquer uma sem dizer qual pergunta ela responde.

### Bloco 3 — playtime: **PULADO, e isso importa**

O clone só tem `plugins/`; não existe `world/stats`. **Não há playtime real neste baseline.** A
duração da última sessão é o único proxy disponível, e é fraco (mede uma sessão, não o hábito).
Qualquer afirmação sobre "tempo de jogo" a partir deste snapshot é extrapolação.

## `austv-diagnostico2.ps1`

Plataforma é derivada do UUID, sem plugin — é a base empírica do
[ADR-003](../../.specs/features/austv-admin/spec.md):
`00000000-0000-0000-0009-…` = bedrock · 15º caractere `3` = java_offline · `4` = java_premium.

| número | o que mede de verdade | limitação que muda a leitura |
|---|---|---|
| PLATAFORMA todos / ativos30 / com_home | contagem por plataforma | ⚠️ **as três colunas de % têm bases diferentes:** `%` é sobre as 49.302; `%at` e `%hm` são sobre o total da **própria plataforma** (a coluna `todos` da mesma linha). Ler `%hm` como fatia do total inverte: bedrock aparece com 15,4% dentro do bedrock, mas seria 9,1% sobre as 49.302. `ativos30` é relativo à as-of, não a hoje |
| FUNIL POR PLATAFORMA | base = quem tem playerdata **com dado** (11.538 — inclui 704 que tocaram em quest fora do tutorial; quem tocou no tutorial são 10.834) | mede **quem entrou no tutorial**, não quem chegou ao servidor |
| **RETENÇÃO D1/D7/D30/D90** | `lifespan = último login − primeira atividade`. "D7 = 21,7%" significa **21,7% tiveram ≥7 dias entre a primeira e a última atividade** | ⚠️ **não é retenção clássica.** Não diz se a pessoa voltou no dia 7 — só que a distância entre as duas pontas passou de 7 dias. Quem entrou uma vez e reapareceu no dia 400 conta como retido em D1, D7, D30 **e** D90 |
| ↳ de onde vêm as pontas | início = primeira atividade no **Quests**; fim = último login no **Essentials** | é um **cruzamento das duas bases** — legítimo, porque a chave é o UUID, mas **o zero do relógio é a entrada no tutorial, não a chegada no servidor**. Para quem chegou antes de ~2024-12, quando o Quests mal capturava, o lifespan medido é **menor** que o real: o viés empurra a retenção para parecer pior do que foi |
| base **11.525** | ⚠️ **base enviesada para cima** | só entra quem tocou em quest. Sobre todas as 49.302 contas, o piso é `30,1% × 11.525/49.302 ≈ **7%** de D1`. (São 11.525 e não 11.538 porque 13 registros não têm login legível no Essentials — o cruzamento precisa das duas pontas) |
| TEMPO ENTRE 01 E 02 | intervalo entre as duas conclusões | só de quem completou **os dois** — tem sobrevivência embutida no denominador |
| **COORTE POR MÊS** | mês da **primeira atividade no Quests** | ⚠️ **é entrada no tutorial, não chegada no servidor.** É literalmente a série que gerou os três erros abaixo |
| coortes anteriores a ~2024-12 | truncadas | o Quests não capturava antes: base de 36–352/mês contra 432+ depois. Não comparável com o período posterior |
| ausência de 2026-05 | não é zero | mês de manutenção. **"Sem dados" ≠ zero** — nunca preencher o buraco |

---

# Os três erros, e qual número exatamente os produziu

Registrado para que o próximo leitor não repita. Detalhe em
[HANDOFF.md](../../.specs/features/austv-admin/HANDOFF.md).

| # | afirmação feita com confiança | número que a produziu | verdade |
|---|---|---|---|
| 1 | "o colapso de aquisição começou em dezembro/2025" | coluna `base` da COORTE POR MÊS | a coorte mede **entrada no tutorial**. O tutorial parou de capturar em dez/2025; a aquisição real só caiu em **fevereiro/2026** |
| 2 | "48 chegadas/mês, impossível medir antes de 6 meses" | a linha `2026-08 → 48` da COORTE | os 48 são entradas no tutorial. Chegadas reais: **~190–250/mês**. Medir antes/depois leva 2–4 semanas |
| 3 | "queda de 96%" | mesma série contaminada | a queda real (nov/2025 → ago/2026) é de **−72%** |

**A causa raiz é uma só nos três casos:** uma série derivada de plugin foi tratada como métrica de
negócio sem cruzar com uma segunda fonte independente.

> **Regra de método:** série derivada de plugin mede o comportamento **daquele plugin**, não a
> realidade. Antes de tratar qualquer série como métrica de negócio, confirmar com uma segunda fonte
> independente.

Regra irmã, que vale para tudo o que sair daqui: **`n` obrigatório junto de todo percentual**, e
**"sem dados" é diferente de zero** — buraco de coleta nunca vira zero.

---

# Como re-executar

Os scripts leem um clone offline; nada precisa estar de pé.

```powershell
powershell -ExecutionPolicy Bypass -File ops\baseline\scripts\austv-diagnostico.ps1
```

## Checklist antes de rodar

- [ ] **Copiar o script para a nova pasta de snapshot e editar a cópia.** Nunca editar o arquivo em
      `scripts/` — o `$Base` está lá dentro, e alterá-lo quebra o pareamento com os `.txt` já
      commitados.
- [ ] **Rodar em máquina no fuso `America/Sao_Paulo`.** Os buckets de mês usam `.ToLocalTime()`;
      outro fuso desloca as fronteiras de mês, e a próxima execução é justamente a que vai gerar o
      "depois" para comparar com este "antes".
- [ ] **Ignorar os caminhos do cabeçalho dos scripts** — são de antes da versionagem, preservados
      verbatim de propósito.
- [ ] Para liberar o Bloco 3 (playtime real), apontar `$StatsDir` para a pasta `world/stats` do
      servidor. Ela não existe no clone atual.

## Ao ler a saída nova

- [ ] ⚠️ **`Pct()` imprime `0,0%` quando o denominador é zero.** Ausência de base sai indistinguível
      de "medimos e deu zero" — exatamente a regra que o épico marca como contrato. Neste snapshot
      não há ocorrência viva, mas a coluna `02/01` da COORTE imprimiria `0,0%` para qualquer mês com
      `c01 = 0`, e o funil por plataforma faria o mesmo para uma plataforma com base zero.
      **Antes de citar qualquer `0,0%`, conferir a coluna de base na mesma linha.** Num script
      sucessor, `Pct` deve devolver `s/base`.
- [ ] Mover a saída para um diretório `ops/baseline/<data>/` novo antes de commitar.

## Comparar "antes" e "depois" sem repetir o erro

1. **Compare a mesma base.** Coorte com coorte (entrada no tutorial), userdata com userdata. Um
   crescimento na coorte pode ser só o tutorial voltando a capturar.
2. **Cruze com uma segunda fonte** antes de concluir qualquer coisa sobre aquisição. Como o
   `diagnostico3` (o cross-check original) se perdeu, as fontes independentes de reposição são o
   `plan_users.registered` do proxy e a série `SET`/`Starting balance` do
   `playerpoints_transaction_log` (R1 do [spec](../../.specs/features/austv-admin/spec.md)) — esta
   última cobre inclusive o apagão do Plan entre maio e julho/2026.
3. **Verifique o controle antes de confiar no teste.** Nesta investigação um `nmap` foi descartado
   porque o controle falhou, e um "porta fechada" era o comando não existir no CMD.
