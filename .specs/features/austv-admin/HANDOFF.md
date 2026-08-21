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

---

## ⚠️ Erros já cometidos — não repetir

Três afirmações foram feitas com confiança e estavam **erradas**. Todas pela mesma causa raiz.

**1. "O colapso de aquisição começou em dezembro/2025."** Falso. A série usada vinha do
`Quests/playerdata` e media **quem entrou no tutorial**, não quem chegou. Em dezembro o tutorial
parou de capturar novatos (de ~100% para 12% de taxa de entrada); a aquisição só caiu em
**fevereiro/2026**.

**2. "48 chegadas/mês, impossível medir antes de 6 meses."** Falso. Os 48 eram entradas no
tutorial. Chegadas reais: **~190–250/mês**. Medir antes/depois de uma correção leva 2–4 semanas.

**3. "Queda de 96%."** Contaminado pela mesma série. A queda real (nov/2025 → ago/2026) é de
**−72%**.

> **Lição de método, aplicável a tudo:** série derivada de plugin mede o comportamento **daquele
> plugin**, não a realidade. Confirmar com uma segunda fonte independente antes de tratar qualquer
> série como métrica de negócio.

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

Ordem inegociável: `S6.1` (corpus) antes de todo o épico de sugestões · `S6.2` (banco único) antes
de `S6.3` · UI (`S12`) por último. Cada sprint tem uma história marcada `[CORTE]`, a primeira a
sair sob pressão.

**Desbalanço conhecido, decisão pendente:** com 13 SP/sprint planejados, a **S6 está em 22 SP** (tem
prazo externo — o unban — então é sprint de data, não de capacidade) e a **S12 em 18 SP**. As
opções estão no próprio plano de sprints. Decidir antes de abrir o worktree da S6.

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
independentes. **O dono decidiu tratar como responsabilidade da MagnoHost.** Registrado, não
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
