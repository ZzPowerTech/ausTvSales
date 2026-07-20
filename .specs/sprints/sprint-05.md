# Sprint 5 — Dashboard: visualização (navegação de análise, ranking, gráfico temporal)

> Duração: 1 semana
> Épico: E5 (Dashboard: visualização)
> Capacidade planejada: 15 SP *(velocidade alvo ~13 SP — estouro aceito, ver §"Nota de revisão")*
> Pré-requisito: shell + auth do dashboard (S4.1) ✅ entregues; catálogo operacional (S4.0/S4.2/S4.3) ✅
> **Revisado em 2026-07-20** — ver §"Nota de revisão" no final. Design de implementação:
> [`.specs/features/sprint-05-dashboard-analytics/spec.md`](../features/sprint-05-dashboard-analytics/spec.md)

## Objetivo do sprint

Ao final do sprint, o valor de negócio do projeto fica visível: navegação por categoria, top 5
compradores por item com filtro de período e gráfico de vendas ao longo do tempo com
granularidade real de evento. Cobre CA3, CA4 e CA5 do MVP e já embute a regra de exclusão de
`historical_import` da série temporal (preparando o CA7).

## Cadeia de dependência do sprint

```
S5.0  Gerador de vendas sintéticas (backend)
   │     └─ sem dataset não há como demonstrar CA3/CA4/CA5 nem validar EXPLAIN em 50k linhas
S5.1  Endpoints de leitura agregada (backend + database)
   │     └─ consome o dataset da S5.0; é a fonte única das três telas
S5.2  Seção "Vendas" na sidenav existente (frontend)
   │     └─ abre a rota de categoria que a S5.3 preenche
S5.3  Página de categoria: itens + top 5 compradores com filtro de período
   │     └─ define a janela de período que o gráfico da S5.4 herda
S5.4  Gráfico de série temporal por item   ← candidata natural a corte se o sprint apertar
```

---

## Histórias

### S5.0 — Gerador de vendas sintéticas (ferramenta de desenvolvimento)

- **Como** desenvolvedor, **quero** um gerador parametrizável de vendas sintéticas, **para** demonstrar as telas com dados representativos e medir performance das agregações antes de acreditar que elas escalam.
- **Responsável:** `backend-specialist`
- **Estimativa:** 2 SP
- **Critérios de aceite:**
  - [ ] Script parametrizável: volume total, janela de datas, distribuição por item e por jogador
  - [ ] Gera também linhas com `historical_import = true`, para exercitar a regra da S5.1 (série exclui, totais incluem) com dados reais em vez de fixture de teste
  - [ ] Jogadores sintéticos cujo nickname **muda ao longo do tempo** — `nickname_at_purchase` antigo diferente do `last_known_nickname` atual, provando o CA4 visualmente e não só no teste unitário
  - [ ] Idempotente/re-executável: rodar duas vezes não duplica nem quebra (`sale_id` determinístico por seed)
  - [ ] Guarda explícita por variável de ambiente impedindo execução contra produção — apontar para o banco de produção deve abortar, não perguntar
  - [ ] Documentado no README do backend, com o comando de gerar o dataset de ~50k vendas usado na DoD
- **Nota de fatiamento:** primeiro PR do sprint. É pré-requisito das demais histórias e será
  reaproveitado na Sprint 6 (ensaio da migração histórica) e em qualquer teste de performance futuro.

### S5.1 — Endpoints de leitura agregada (backend)

- **Como** dashboard, **quero** endpoints de agregação (itens por categoria com totais, top N compradores por item, série temporal por item), **para** que as telas não façam agregação no cliente nem exponham a tabela `sales` crua.
- **Responsável:** `backend-specialist` + `database-specialist` (revisão das queries/índices)
- **Estimativa:** 5 SP — três agregações com regras sutis (nickname atual via join em `players`, filtro de período, exclusão de `historical_import` na série mas não nos totais). Módulo inteiramente novo: hoje `sales` expõe apenas `POST /sales`.
- **Critérios de aceite:**
  - [ ] `GET` de resumo por categoria: itens com total de vendas, quantidade e receita (`SUM(total_price)`), respeitando filtro de período opcional
  - [ ] `GET` top 5 compradores por item: agregado por `player_uuid`, exibindo `last_known_nickname` (nickname **atual**, não o snapshot `nickname_at_purchase` — CA4), com filtro de período opcional
  - [ ] `GET` série temporal por item: eventos agregados por bucket (dia como padrão; granularidade parametrizável), **excluindo** `historical_import = true` (CA7 — sem pontos de data falsa)
  - [ ] Totais/receita acumulada **incluem** `historical_import` (o histórico conta para apuração, só não para a série) — regra documentada no código e na resposta da API
  - [ ] `EXPLAIN` de cada agregação revisado pelo `database-specialist` **sobre o dataset de 50k gerado pela S5.0**, não sobre tabela vazia
  - [ ] Endpoints atrás da autenticação do dashboard; testes e2e com dataset incluindo eventos históricos e recentes
- **Nota técnica (índices):** o top-N filtra por `item_id` + período e agrupa por `player_uuid`.
  O índice `sales_item_purchased_at_idx (item_id, purchased_at)` atende o filtro, mas
  `sales_player_item_idx (player_uuid, item_id)` tem `player_uuid` como coluna líder e **não**
  serve a esse padrão de acesso. Se o `EXPLAIN` indicar necessidade de um índice de cobertura,
  ele vira **débito técnico documentado** — não migration às pressas no meio do sprint.

### S5.2 — Seção de análise na navegação, dinâmica por categoria

- **Como** administrador, **quero** as categorias vindas da tabela `categories` como entradas de navegação, **para** circular pelo catálogo real (CA3) — categoria nova aparece sem deploy.
- **Responsável:** `frontend-specialist`
- **Estimativa:** 2 SP — **extensão** do sidenav já entregue na S4.1, não construção de shell novo.
- **Critérios de aceite:**
  - [ ] Segunda seção ("Vendas") adicionada ao sidenav existente do `dashboard-layout`, abaixo da seção "Catálogo"
  - [ ] Seção "Catálogo" (entradas estáticas "Categorias" e "Itens") permanece **intacta** em comportamento e posição
  - [ ] Entradas da seção "Vendas" renderizadas a partir da API, ordenadas por `display_order`
  - [ ] Seleção de categoria navega por rota aninhada (URL compartilhável/recarregável), com link ativo destacado como no padrão da S4.1
  - [ ] Estados de carregamento e de lista vazia ("nenhuma categoria cadastrada" com link para a tela da S4.2)

### S5.3 — Página de categoria: itens + top 5 compradores com filtro de período

- **Como** administrador, **quero** ver, por categoria, os itens com seus números e o top 5 de compradores de cada item, filtrável por período, **para** saber quem mais compra o quê e quando (CA4).
- **Responsável:** `frontend-specialist`
- **Estimativa:** 3 SP
- **Critérios de aceite:**
  - [ ] Lista de itens da categoria com quantidade vendida e receita no período selecionado
  - [ ] Por item: top 5 jogadores (nickname atual + quantidade/valor comprado)
  - [ ] Filtro de período (presets: 7d, 30d, temporada/custom) refletido na URL e aplicado a lista e rankings
  - [ ] Itens inativos visualmente distintos (histórico permanece visível)
  - [ ] Estado com Signals; sem agregação pesada no cliente (usa S5.1)

### S5.4 — Gráfico de vendas por item ao longo do tempo

- **Como** administrador, **quero** um gráfico de série temporal das vendas de um item com granularidade real de evento, **para** enxergar picos (lançamento de crate, promoções) em vez do staircase de polling do sistema antigo (CA5).
- **Responsável:** `frontend-specialist`
- **Estimativa:** 3 SP
- **Critérios de aceite:**
  - [ ] Escolha entre **Chart.js e ECharts** feita no primeiro dia da história e registrada como **ADR-0003** em [`.specs/decisions/`](../decisions/) *(spike — não gera PR de código)*
  - [ ] Lib instanciada **diretamente** dentro de um `effect` do componente Angular, sem wrapper (`ng2-charts` e similares estão descartados — ver nota de revisão)
  - [ ] Gráfico por item consumindo a série da S5.1, com alternância quantidade × receita
  - [ ] Respeita o filtro de período da página; granularidade coerente com a janela (dia como padrão)
  - [ ] Eventos com `historical_import = true` **não** aparecem como pontos da série (CA7); se houver histórico do item, o total pré-migração aparece como anotação/baseline textual, não como ponto datado
  - [ ] Cores e tipografia vindas dos tokens do AusTV (`_tokens.scss`) — nada de tema default da lib
  - [ ] Estado vazio tratado ("sem vendas no período")

---

## Definition of Done do Sprint 5

- Todo código mergeado via PR revisado, CI verde
- CA3, CA4 e CA5 demonstrados no ambiente de teste sobre o dataset da S5.0 — incluindo o caso de
  jogador que trocou de nickname (ranking exibe o atual)
- Regra `historical_import` verificada por teste automatizado no backend **e** visível no ambiente
  de teste: item com histórico mostra baseline sem ponto datado na série
- Filtro de período consistente entre lista, ranking e gráfico (mesma janela em toda a página)
- Nenhum endpoint de leitura acessível sem autenticação
- Performance: página de categoria carrega com ~50k vendas sem query > 1s — medido sobre o dataset
  da S5.0 e validado com `EXPLAIN` (S5.1); eventual índice faltante registrado como débito
- ADR-0003 (biblioteca de gráfico) registrado em `.specs/decisions/`

## Riscos e dependências

| Risco | Mitigação |
|---|---|
| Agregações lentas conforme `sales` crescer | Revisão de `EXPLAIN` na S5.1 sobre o dataset real da S5.0; materialização/cache fica fora do MVP (anotar como débito se necessário) |
| Top-N por item não ter índice adequado (`sales_player_item_idx` não serve ao acesso) | Verificado explicitamente na S5.1; índice de cobertura vira débito documentado, não migration de última hora |
| Wrapper Angular de gráfico indisponível/atrasado para Angular 22 | **Já mitigado:** decisão de 2026-07-20 usa lib agnóstica de framework sem wrapper — o suporte a major novo deixa de ser dependência externa |
| Estouro de 15 SP contra velocidade de ~13 SP | S5.4 é a última da cadeia de dependência e o corte natural; S5.0–S5.3 já entregam CA3 e CA4 |
| Definição de "temporada" no filtro de período | MVP usa presets simples + custom range; preset de temporada configurável fica para depois *(validar com o Murilo)* |
| Gerador de dados apontado para produção por engano | Guarda por env na S5.0 (aborta, não pergunta) — critério de aceite bloqueante |

---

## Nota de revisão (2026-07-20)

O plano original foi escrito em 2026-07-11, **antes** das Sprints 1–4 serem entregues, e envelheceu.
A análise pré-sprint encontrou:

1. **S5.2 encolheu de responsabilidade.** O plano falava em "sidebar dinâmica" como se não
   houvesse navegação. O `dashboard-layout` e o sidenav já existem desde a S4.1, com a seção
   "Catálogo" e duas entradas estáticas. A S5.2 **não cria sidebar**: ela adiciona uma segunda
   seção ("Vendas") alimentada por `categories` ordenada por `display_order`, mais a rota de
   categoria. Estimativa mantida em 2 SP — o que era scaffolding virou integração com API,
   roteamento e estados de carregamento/vazio.
2. **Faltava a ferramenta que a própria DoD exige.** A DoD pede demonstrar CA3/CA4/CA5 com dados
   reais e validar performance com ~50k vendas, mas não existe seed: hoje o único caminho é POSTar
   no `/sales` com API key, um a um. O risco original citava "gerar seed sintético" como mitigação
   **sem alocar esforço** — exatamente o tipo de buraco que envelheceu o plano da Sprint 4.
   Vira a história **S5.0** (2 SP), primeiro PR do sprint e pré-requisito das demais.
3. **Capacidade sobe de 13 SP para 15 SP** (S5.0=2, S5.1=5, S5.2=2, S5.3=3, S5.4=3). O Murilo
   aceitou o estouro conscientemente em 2026-07-20: a S5.0 é infraestrutura reaproveitável na
   Sprint 6 e não faz sentido cortá-la. Se o sprint apertar, a **S5.4 é a candidata a corte** —
   é a última na cadeia de dependência e sua remoção não invalida nada já entregue.
4. **Biblioteca de gráfico decidida.** Usar lib agnóstica de framework (Chart.js ou ECharts)
   instanciada direto num `effect` do componente, **sem wrapper Angular**. Wrappers costumam
   demorar a suportar major novo, e o projeto está em Angular 22 / TypeScript 6 — um wrapper
   incompatível travaria a S5.4 no meio do sprint. O efeito colateral é bem-vindo: controle total
   sobre os tokens visuais do AusTV. A escolha final entre as duas é do primeiro dia da S5.4 e
   vira **ADR-0003**. Na tabela de riscos, "lib brigar com o padrão visual" foi rebaixado (deixa
   de ser risco quando não há tema default imposto); o risco relevante passou a ser
   disponibilidade de wrapper para v22, já mitigado pela decisão.
5. **Índice do top-N não estava garantido.** `sales` tem `sales_item_purchased_at_idx` e
   `sales_player_item_idx`. O segundo tem `player_uuid` como coluna líder e não atende o acesso
   "filtra por `item_id` + período, agrupa por `player_uuid`". Virou nota técnica explícita na
   S5.1, a ser confirmada por `EXPLAIN` sobre o dataset da S5.0.
6. **A S5.1 continua integralmente nova.** Confirmado no código: o módulo `sales` expõe apenas
   `POST /sales`; não existe nenhum endpoint de leitura agregada. Os 5 SP seguem válidos.

Total: 13 SP → 15 SP. O que mudou foi menos scaffolding de UI (já entregue) e uma dependência de
dados que estava implícita virando trabalho explícito.
