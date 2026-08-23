# Baseline pré-campanha — o "antes" do AusTV congelado

> História [S6.0](https://github.com/ZzPowerTech/ausTvSales/issues/106) · Sprint `AusTV Admin S6`
> Snapshot: **2026-08-19** · Origem dos dados: `D:\AUSTV\clone_survival` (cópia offline de
> `plugins/` do Survival, tirada em 2026-08-13)

## Por que este diretório existe

Estes são hoje o **único registro histórico de retenção do AusTV anterior ao Plan**. Os scripts leem
arquivos de `playerdata` e `userdata` que a campanha de unban all vai alterar. Rodar depois não
reproduz este dado — produz outro dado, de outro momento.

Ou o "antes" ficou capturado aqui, ou não há com o que comparar o "depois". É o único item da
Sprint 6 cujo custo de atraso é perda permanente, não retrabalho.

Os scripts **só leem**. Nenhum deles escreve no servidor ou no clone.

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

### O que não foi localizado

Três dos cinco artefatos citados no [HANDOFF](../../.specs/features/austv-admin/HANDOFF.md) não
estão versionados nem foram encontrados no disco:

| ausente | o que fazia |
|---|---|
| `austv-diagnostico3.ps1` | chegadas e saídas por mês × plataforma + cross-check independente |
| `plan-forense.sh` | forense da instalação do Plan na VPS (resolveu o caso do SQLite) |
| `plan-analise.sql` | 5 blocos: cobertura, chegadas, atividade/bounce, retenção, antes-vs-depois do tutorial |

O `austv-diagnostico3.ps1` é o mais custoso de perder: era ele que fazia o **cross-check
independente** — exatamente o controle cuja ausência produziu os três erros descritos abaixo.

## Sanitização

Conferido antes do commit: as duas saídas **não contêm UUID, nickname, IP nem qualquer
identificador de jogador**. São contagens e distribuições agregadas. O bloco `AMOSTRA: maior
playerdata` da saída 1 despeja 45 linhas de um arquivo de quests — só ids de quest e timestamps
epoch, sem dono identificável. Os scripts não têm credencial embutida.

---

# Como ler cada número

> Esta seção é o entregável principal da S6.0. O dado sozinho já induziu a erro três vezes.

## A regra que vale para tudo: são duas bases diferentes

| base | fonte | tamanho | quem entra nela |
|---|---|---|---|
| **userdata** | `Essentials/userdata/*.yml` | **49.302** | todo jogador que já teve registro no Essentials |
| **playerdata** | `Quests/playerdata/*.yml` | **19.700** (11.538 com dado útil) | só quem **tocou em alguma quest** |

**Misturar as duas é a causa raiz dos três erros do HANDOFF.** Um percentual do bloco de Quests
descreve quem entrou no tutorial; não descreve quem chegou ao servidor. Sempre que um número aparecer
sem base, ele está incompleto.

## `austv-diagnostico.ps1`

### Bloco 1 — Essentials userdata (base 49.302)

| número | o que mede de verdade | limitação que muda a leitura |
|---|---|---|
| `arquivos_userdata: 49302` | contas com registro no Essentials, all-time | não é "jogadores únicos que chegaram". Uma pessoa com conta Java e Bedrock conta duas vezes |
| `login_mais_recente` / `defasagem` | o **relógio de referência do script** | todos os buckets de churn são relativos a este instante, **não a hoje**. Rodar de novo sobre o mesmo clone daqui a um mês dá exatamente os mesmos números |
| CHURN `<=1d` … `>365d` | distribuição do **último** login | não mede atividade. Quem jogou 300 dias seguidos e parou ontem cai em `<=1d`, igual a quem entrou uma única vez ontem |
| DURAÇÃO DA ÚLTIMA SESSÃO | `logout − login` da **última** sessão, só dela | não é sessão típica nem playtime. `logout < login` (jogador online no momento do dump, ou crash) vira `sem_dado` — são 202 casos |
| TIPO DE CONTA — **59,2% bedrock** | mix **all-time** | ⚠️ **não é o mix atual.** Em 2026 a fatia bedrock das chegadas está em ~25%. Este número só pode ser citado com a janela junto |
| `recebeu_kit_prot` 11,8% | contas com o kit `prot` registrado | **proxy** da recompensa do `02tutorial`, não a conclusão dele. Kit obtido por outra via infla |
| `tem_pelo_menos_1_home` 21,4% | contas com ≥1 home | **proxy** do gate do `05tutorial` (`/casacriar`). Home criada fora do tutorial também conta |
| `ativos_ultimos_30d` 579 | último login dentro de 30d **do snapshot** | não é "ativos hoje" |
| ÚLTIMO LOGIN POR MÊS | **quando cada leva parou** | ⚠️ é uma série de **saídas**, não de chegadas. Ler ao contrário inverte a conclusão |

### Bloco 2 — funil do tutorial (base 19.700, **outra base**)

- O `%concl` de cada quest é sobre **19.700**, não sobre 49.302.
- `playerdata_vazio_0kb` = entrou no servidor e nunca tocou em quest nenhuma.
- `passo 33 → 148` é o número real de conclusões do tutorial no acervo.

> Sobre o "148 em 49.302 (0,3%)" que circula no HANDOFF: ele mistura numerador do Bloco 2 com
> denominador do Bloco 1. **É defensável como piso** — e é uma leitura útil —, mas precisa ser
> rotulado assim, nunca apresentado como "taxa de conclusão do tutorial", que seria 148/19.700.

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
| PLATAFORMA todos / ativos30 / com_home | contagem por plataforma sobre userdata | `ativos30` é relativo ao `login_mais_recente` do snapshot, não a hoje |
| FUNIL POR PLATAFORMA | base = quem tem playerdata **com dado** (11.538) | mede **quem entrou no tutorial**, não quem chegou ao servidor |
| **RETENÇÃO D1/D7/D30/D90** | `lifespan = último login − primeira atividade`. "D7 = 21,7%" significa **21,7% tiveram ≥7 dias entre a primeira e a última atividade** | ⚠️ **não é retenção clássica.** Não diz se a pessoa voltou no dia 7 — só que a distância entre as duas pontas passou de 7 dias. Quem entrou uma vez e reapareceu no dia 400 conta como retido em D1, D7, D30 **e** D90 |
| base **11.525** | ⚠️ **base enviesada para cima** | só entra quem tocou em quest. Sobre todas as 49.302 contas, o piso é `30,1% × 11.525/49.302 ≈ **7%** de D1` |
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

O caminho do clone é a variável `$Base` no topo de cada script (hoje `D:\AUSTV\clone_survival`).
A saída é gravada em UTF-8 sem BOM ao lado do script — mover para um diretório
`ops/baseline/<data>/` novo antes de commitar.

Para liberar o Bloco 3 (playtime real), apontar `$StatsDir` para a pasta `world/stats` do servidor.
Ela não existe no clone atual.

## Comparar "antes" e "depois" sem repetir o erro

Ao comparar este snapshot com um posterior à campanha:

1. **Compare a mesma base.** Coorte com coorte (entrada no tutorial), userdata com userdata. Um
   crescimento na coorte pode ser só o tutorial voltando a capturar.
2. **Cruze com uma segunda fonte** antes de concluir qualquer coisa sobre aquisição. As candidatas
   independentes são o `plan_users.registered` do proxy e a série
   `SET`/`Starting balance` do `playerpoints_transaction_log` (R1 do
   [spec](../../.specs/features/austv-admin/spec.md)) — esta última cobre inclusive o apagão do Plan
   entre maio e julho/2026.
3. **Verifique o controle antes de confiar no teste.** Nesta investigação um `nmap` foi descartado
   porque o controle falhou, e um "porta fechada" era o comando não existir no CMD.
