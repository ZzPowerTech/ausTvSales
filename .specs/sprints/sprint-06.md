# Sprint 6 — Migração histórica, cutover no Genesis e go-live

> Duração: 1 semana
> Épicos: E6 (Migração e cutover), E7 (Segurança e operação)
> Capacidade planejada: 12 SP
> Pré-requisito: pipeline completo validado nos Sprints 1–5 (plugin resiliente + dashboard funcional)

## Objetivo do sprint

Ao final do sprint, o sistema está em produção: histórico do MyCommand migrado uma única vez com
`historical_import = true`, rewards do Genesis apontando para o comando novo, comandos antigos do
MyCommand removidos e validação final do `cybersecurity-validator` aprovada. Fecha CA7, CA8
(validação final) e CA9 — completando o MVP.

---

## Histórias

### S6.1 — Script de migração histórica (execução única)

- **Como** dono do sistema, **quero** migrar os contadores acumulados do MyCommand (`otherdb.yml` + tabela MySQL de playerdata) para `sales` como eventos agregados com `historical_import = true`, **para** não perder a apuração histórica sem poluir a série temporal com datas falsas (CA7).
- **Responsável:** `backend-specialist` + `database-specialist`
- **Estimativa:** 5 SP — parsing de duas fontes legadas, mapeamento contador→evento agregado, dry-run e relatório de conciliação. Dados legados costumam ter surpresas.
- **Critérios de aceite:**
  - [ ] Script versionado no repo (fora do caminho de deploy da API), lendo `otherdb.yml` + MySQL do MyCommand
  - [ ] Cada contador vira um evento agregado: `qtd` = total acumulado, `historical_import = true`, `sale_id` **determinístico** (ex.: UUID v5 de `player_uuid + item_id + "historical"`) — rodar duas vezes não duplica
  - [ ] `purchased_at` recebe data sentinela documentada (ex.: data do lançamento) — irrelevante para exibição, pois a série temporal exclui `historical_import` (garantido na S5.1)
  - [ ] `total_price` dos eventos históricos: **NULL/zero documentado** — o sistema antigo não guarda preço; receita histórica não será inventada *(validar com o Murilo)*
  - [ ] `item_id` legado sem correspondência no catálogo → listado no relatório do dry-run para cadastro manual **antes** da execução real; nada é auto-criado
  - [ ] Modo `--dry-run` com relatório de conciliação (contadores lidos × eventos a inserir × divergências)
  - [ ] Execução real registrada em runbook (data, operador, totais conferidos no dashboard)

### S6.2 — Cutover no Genesis: comando novo + remoção do MyCommand

- **Como** dono do servidor, **quero** os rewards das crates do Genesis chamando `austv-sales add ... %price% ...` e os dois comandos antigos do MyCommand removidos, **para** que toda venda nova passe pelo sistema novo, sem contagem dupla (CA9).
- **Responsável:** `gamedev-plugin-specialist` + `devops-specialist`
- **Estimativa:** 2 SP — mudança de configuração, mas em produção e por crate; exige checklist e plano de rollback.
- **Critérios de aceite:**
  - [ ] Todos os rewards de crates atualizados conforme o padrão da seção 5 do spec (uma linha `austv-sales add %player% <item_id> %price% 1` por crate), com `item_id` já cadastrado no dashboard para cada crate ativa
  - [ ] Os dois comandos antigos do MyCommand removidos dos rewards — sem janela de contagem dupla nem de vão (mudança atômica por crate)
  - [ ] Compra de teste em produção por crate confirmada no dashboard
  - [ ] Backup das configs anteriores + rollback documentado (reverter reward em < 5 min se necessário)
  - [ ] Configs do MyCommand em si intocadas além dos rewards (fora de escopo do spec, seção 2)

### S6.3 — Validação de segurança final + go-live

- **Como** dono do sistema, **quero** a revisão final do `cybersecurity-validator` e o checklist de produção executado, **para** liberar o go-live com o CA8 formalmente fechado.
- **Responsável:** `cybersecurity-validator` + `devops-specialist`
- **Estimativa:** 3 SP
- **Critérios de aceite:**
  - [ ] Revisão de superfície: auth plugin→API ativa em produção, rate limiting efetivo (testado com flood controlado), nenhum endpoint sem auth, segredos fora do repo, container isolado atrás do Nginx (não na máquina do jogo)
  - [ ] NTP re-verificado nas duas VPS na semana do go-live (skew registrado)
  - [ ] Runbook de resiliência da S3.4 re-executado contra produção (janela controlada)
  - [ ] HTTPS válido no endpoint público; logs sem vazamento de credenciais
  - [ ] Parecer do `cybersecurity-validator` registrado (documento de aprovação) — CA8 fechado
  - [ ] Checklist de go-live executado e arquivado como runbook

### S6.4 — [BUFFER] Estabilização pós-go-live

- **Como** equipe, **quero** capacidade reservada para correções da primeira semana em produção, **para** absorver surpresas de dados legados e de comportamento real de jogadores sem estourar o plano.
- **Responsável:** conforme a natureza do problema
- **Estimativa:** 2 SP (buffer intencional — não alocar antecipadamente)
- **Critérios de aceite:**
  - [ ] Issues abertas para qualquer anomalia observada (fila crescendo, latência, dado estranho no dashboard)
  - [ ] Correções pequenas entram como PRs isolados; qualquer coisa maior vira item de backlog pós-MVP

---

## Definition of Done do Sprint 6

- Migração histórica executada **uma única vez** em produção, com relatório de conciliação arquivado; totais do dashboard batem com os contadores antigos (amostragem conferida pelo Murilo)
- Dados históricos aparecem em totais/ranking, e **não** como pontos de série temporal (CA7 verificado em produção)
- 100% das crates ativas registrando venda pelo sistema novo; comandos antigos do MyCommand fora dos rewards (CA9)
- Parecer de segurança aprovado e arquivado (CA8)
- Todos os 9 critérios de aceite da seção 6 do spec marcados como atendidos, com evidência (screenshot/registro) por critério
- Runbooks de operação versionados: migração, rollback do cutover, teste de resiliência, checklist de go-live

## Riscos e dependências

| Risco | Mitigação |
|---|---|
| Dados legados inconsistentes (nick sem UUID resolvível, item extinto) | Dry-run da S6.1 é obrigatório antes da execução real; divergências resolvidas manualmente com o Murilo |
| Janela de contagem dupla ou de vão durante o cutover | Mudança atômica por crate (adiciona novo e remove antigo no mesmo edit) + compra de teste por crate |
| `%price%` em produção com formato diferente do ambiente de teste | Compra de teste por crate no cutover valida o valor gravado antes de considerar a crate migrada |
| Migração rodada duas vezes por engano | `sale_id` determinístico (UUID v5) torna a re-execução idempotente por design |
| Validação de segurança reprovar algo | `cybersecurity-validator` já revisou S2.1 e S4.1 nos sprints anteriores — a validação final é confirmação, não primeira olhada |
