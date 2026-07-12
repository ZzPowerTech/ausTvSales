# Sprint 5 — Dashboard: visualização (sidebar, ranking, gráfico temporal)

> Duração: 1 semana
> Épico: E5 (Dashboard: visualização)
> Capacidade planejada: 13 SP
> Pré-requisito: shell + auth do dashboard (S4.1); dados de venda de teste existentes (Sprints 2–3)

## Objetivo do sprint

Ao final do sprint, o valor de negócio do projeto fica visível: navegação por categoria, top 5
compradores por item com filtro de período e gráfico de vendas ao longo do tempo com
granularidade real de evento. Cobre CA3, CA4 e CA5 do MVP e já embute a regra de exclusão de
`historical_import` da série temporal (preparando o CA7).

---

## Histórias

### S5.1 — Endpoints de leitura agregada (backend)

- **Como** dashboard, **quero** endpoints de agregação (itens por categoria com totais, top N compradores por item, série temporal por item), **para** que as telas não façam agregação no cliente nem exponham a tabela `sales` crua.
- **Responsável:** `backend-specialist` + `database-specialist` (revisão das queries/índices)
- **Estimativa:** 5 SP — três agregações com regras sutis (nickname atual via join em `players`, filtro de período, exclusão de `historical_import` na série mas não nos totais).
- **Critérios de aceite:**
  - [ ] `GET` de resumo por categoria: itens com total de vendas, quantidade e receita (`SUM(total_price)`), respeitando filtro de período opcional
  - [ ] `GET` top 5 compradores por item: agregado por `player_uuid`, exibindo `last_known_nickname` (nickname **atual**, não o snapshot histórico — CA4), com filtro de período opcional
  - [ ] `GET` série temporal por item: eventos agregados por bucket (dia como padrão; granularidade parametrizável), **excluindo** `historical_import = true` (CA7 — sem pontos de data falsa)
  - [ ] Totais/receita acumulada **incluem** `historical_import` (o histórico conta para apuração, só não para a série) — regra documentada no código e na resposta da API
  - [ ] Queries usam os índices da S1.2; `EXPLAIN` revisado pelo `database-specialist`
  - [ ] Endpoints atrás da autenticação do dashboard; testes e2e com dataset incluindo eventos históricos e recentes

### S5.2 — Sidebar dinâmica por categoria

- **Como** administrador, **quero** uma sidebar com as categorias vindas da tabela `categories`, **para** navegar pelo catálogo real (CA3) — categoria nova aparece sem deploy.
- **Responsável:** `frontend-specialist`
- **Estimativa:** 2 SP
- **Critérios de aceite:**
  - [ ] Sidebar renderiza categorias da API ordenadas por `display_order`, dentro do shell da S4.1
  - [ ] Seleção de categoria navega por rota (URL compartilhável/recarregável)
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
  - [ ] Gráfico por item consumindo a série da S5.1, com alternância quantidade × receita
  - [ ] Respeita o filtro de período da página; granularidade coerente com a janela (dia como padrão)
  - [ ] Eventos com `historical_import = true` **não** aparecem como pontos da série (CA7); se houver histórico do item, o total pré-migração aparece como anotação/baseline textual, não como ponto datado
  - [ ] Biblioteca de chart integrada ao padrão visual próprio (cores/tipografia AusTV — nada de tema default)
  - [ ] Estado vazio tratado ("sem vendas no período")

---

## Definition of Done do Sprint 5

- Todo código mergeado via PR revisado, CI verde
- CA3, CA4 e CA5 demonstrados no ambiente de teste com dados reais de venda gerados pelo plugin
- Regra `historical_import` verificada por teste automatizado no backend (série exclui, totais incluem)
- Filtro de período consistente entre lista, ranking e gráfico (mesma janela em toda a página)
- Nenhum endpoint de leitura acessível sem autenticação
- Performance sanidade: página de categoria carrega com dataset de teste volumoso (ex.: 50k vendas) sem query > 1s — validado com `EXPLAIN` (S5.1)

## Riscos e dependências

| Risco | Mitigação |
|---|---|
| Poucos dados de teste tornam as telas não representativas | Gerar seed de vendas sintéticas via endpoint de ingest no início do sprint (script reaproveitável) |
| Agregações lentas conforme `sales` crescer | Índices da S1.2 + revisão de `EXPLAIN` na S5.1; materialização/cache fica fora do MVP (anotar como débito se necessário) |
| Escolha da lib de gráfico brigar com o padrão visual | Decidir a lib no primeiro dia da S5.4 com aprovação visual rápida do Murilo antes de integrar |
| Definição de "temporada" no filtro de período | MVP usa presets simples + custom range; preset de temporada configurável fica para depois *(validar com o Murilo)* |
