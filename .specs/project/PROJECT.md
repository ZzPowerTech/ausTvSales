# Spec — AusTV Sales Dashboard (`austv-sales`)

> Status: Fase 1 (SDD) — pronto para quebra em sprints (`scrum-master`)
> Data: 2026-07-11
> Escopo explicitamente separado de: automação de saldo via webhook Central Cart (projeto futuro, fora deste spec)

---

## 1. Objetivo

Substituir o registro de vendas de itens por cash (caixas, passes, pets, fly, etc.) — hoje feito via contadores acumulados do MyCommand (`otherdb.yml` + tabela MySQL de playerdata) — por um sistema de eventos de venda com granularidade temporal, permitindo:

- Análise de vendas por item ao longo do tempo (não só total acumulado)
- Ranking dos 5 jogadores que mais compraram cada item, com possibilidade de filtro por período
- Apuração financeira real (receita por item/categoria), coisa que o sistema atual não tem porque não guarda preço

## 2. Fora de escopo (explicitamente)

- Automação de entrada de saldo via webhook da Central Cart — projeto separado, spec própria no futuro
- Qualquer alteração no MyCommand além de remover os dois comandos antigos do reward do Genesis

## 3. Decisões de negócio já fechadas

| Decisão | Resolução |
|---|---|
| Modelo de item | `item_id` opaco por item (ex: `caixaNatal2026`, `caixaNatal2027`) — **sem** decomposição em family+season, porque itens de anos diferentes são produtos diferentes, não o mesmo item reeditado |
| Categoria | Tabela `categories`, não enum — cadastro **manual via dashboard**, não auto-criação por comando (evita categoria duplicada por typo) |
| Preço | Lido do placeholder `%price%` do Genesis (testado e confirmado funcional dentro do bloco `Reward`) — plugin recebe `total_price` já resolvido, sem duplicar valor manualmente |
| Semântica do preço | `total_price` = valor total da transação, independente da quantidade (`qtd`) |
| Identidade do jogador | `player_uuid` como chave de agregação; `nickname` salvo por evento (histórico) + resolução de nick mais recente para exibição |
| Timestamp | Capturado pelo plugin no momento da execução do comando (`Instant.now()` dentro do `CommandExecutor`), nunca passado como argumento |
| Fila de fallback | SQLite local no plugin — grava se a API estiver indisponível, reenvia depois. Requer ID único gerado no plugin (não auto-increment) para idempotência no reprocessamento |
| Persistência | Postgres — reaproveitar a instância que já serve o AusTV Finance |
| Comandos antigos do MyCommand | Removidos dos rewards do Genesis. Não há dependência externa identificada (confirmado pelo Murilo) |
| Histórico pré-existente | Migração única na data de lançamento: ler `otherdb.yml` + tabela MySQL do MyCommand e inserir como eventos agregados com `historical_import = true`, sem timestamp granular — não deve poluir o gráfico de série temporal com data falsa |
| Segurança da chamada plugin→API | A construir (API key ou mTLS entre VPS do jogo e VPS da API) — obrigatório antes do merge, bloqueante na Fase 5.5 (`cybersecurity-validator`) |

## 4. Entidades e relacionamentos

```
categories
  id (PK)
  name
  display_order

items
  id (PK)
  item_id (unique, string opaco — ex: "caixaNatal2026")
  display_name
  category_id (FK → categories.id)
  active (bool)

players
  uuid (PK)
  last_known_nickname
  updated_at

sales
  id (PK, UUID gerado no plugin — garante idempotência)
  item_id (FK → items.item_id)
  player_uuid (FK → players.uuid)
  nickname_at_purchase (string — snapshot do nick no momento da venda)
  total_price (decimal)
  qtd (int)
  purchased_at (timestamp — gerado no plugin, não no insert da API)
  historical_import (bool, default false)
  created_at (timestamp — quando o registro chegou na API, para auditoria/debug de latência da fila)
```

Índices recomendados: `sales(item_id, purchased_at)`, `sales(player_uuid, item_id)`.

## 5. Contrato do comando (plugin Java)

```
austv-sales add <player_nick> <item_id> <total_price> <qtd>
```

Comportamento do `CommandExecutor`:
1. Resolve `player_nick` → `player_uuid` via Bukkit API
2. Valida `item_id` contra tabela `items` local em cache (sincronizada periodicamente com a API) — **rejeita e loga erro** se item não cadastrado, não cria automaticamente
3. Captura `purchased_at = Instant.now()`
4. Gera UUID próprio para o evento (`sale_id`)
5. Envia payload assíncrono (`BukkitRunnable` async) para a API via HTTPS com autenticação
6. Se a chamada falhar (timeout, 5xx, sem rede): grava o evento no SQLite local com status `pending`
7. Worker separado (scheduled task) reprocessa fila `pending` periodicamente, marca `sent` após ACK 2xx da API, usando `sale_id` para que a API trate reenvio como upsert idempotente (não duplicar linha em `sales`)

Reward do Genesis por crate passa a ser:
```yaml
RewardType: COMMAND
Reward:
  - 'crazycrates give physical abducao 1 %player%'
  - 'austv-sales add %player% caixaAbducao2026 %price% 1'
```

## 6. Critérios de aceite (Sprint 1 — MVP)

- [ ] Plugin registra venda via comando, com fallback SQLite funcional (testável desligando a API propositalmente)
- [ ] API rejeita `item_id` desconhecido com log claro, sem criar registro fantasma
- [ ] Dashboard exibe sidebar por categoria (dinâmica, vinda da tabela `categories`)
- [ ] Cada categoria lista os itens e, por item, os 5 jogadores com mais compras (nickname atual, não histórico)
- [ ] Gráfico de vendas por item ao longo do tempo, com granularidade real de evento (não staircase de polling)
- [ ] Cadastro manual de item/categoria funcional no dashboard antes de qualquer venda daquele item poder ser aceita
- [ ] Migração histórica executada uma vez, dados marcados com `historical_import = true` e não aparecem como pontos de série temporal enganosos
- [ ] Comunicação plugin→API autenticada (API key ou mTLS) — validado pelo `cybersecurity-validator`
- [ ] Comandos antigos do MyCommand removidos dos rewards do Genesis

## 7. Superfície de ataque e riscos

- Endpoint de recebimento de vendas exposto a partir da VPS do jogo → exige autenticação forte + rate limiting (evita flood/forjar vendas falsas para inflar métricas)
- Clock skew entre VPS do jogo e VPS da API → validar NTP sincronizado nas duas máquinas antes de considerar `purchased_at` confiável
- Reprocessamento da fila SQLite após restart do plugin → precisa idempotência real no backend (constraint de unicidade em `sale_id`), senão duplica venda no Postgres
- Cadastro manual de item/categoria no dashboard → precisa de autenticação/autorização (não pode ser endpoint público), já que erro aqui contamina todo o catálogo

## 8. Decisões técnicas (stack)

- Plugin: Java (Paper 1.21.x), SQLite via biblioteca leve embutida (ex: sqlite-jdbc)
- Backend: NestJS + PostgreSQL (reaproveitando instância do AusTV Finance)
- Frontend: Angular (Signals), seguindo padrão visual próprio já estabelecido — proibido UI genérica
- Deploy: container isolado na VPS (`weissmurillo.de`), atrás de Nginx — não roda na máquina dedicada do servidor de jogo

## 9. Pendências para a próxima fase (Scrum)

- Definir mecanismo exato de autenticação plugin→API (API key simples vs mTLS) — decisão do `devops-specialist` + `cybersecurity-validator`
- Confirmar NTP sincronizado nas duas VPS antes de considerar o clock skew resolvido
- Desenhar tela de cadastro manual de item/categoria (quem tem permissão, fluxo de aprovação se houver)
