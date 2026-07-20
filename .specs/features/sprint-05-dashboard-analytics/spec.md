# Spec técnica — Sprint 5: Dashboard de visualização (análise de vendas)

> Fase 4 (design de implementação) — derivado de [`sprint-05.md`](../../sprints/sprint-05.md)
> Data: 2026-07-20
> Pré-requisitos satisfeitos:
> - Shell autenticado com sidenav, `authGuard` e interceptors de 401 (S4.1, mergeado).
> - CRUD de catálogo operacional pelo dashboard (S4.0/S4.2/S4.3, mergeado).
> - `POST /sales` idempotente com upsert de `players` (S2.2, mergeado).
> - Design tokens do AusTV em `frontend/src/styles/_tokens.scss`.
> Objetivo: transformar as histórias S5.0–S5.4 em decisões de implementação prontas para PR.

---

## 0. Estado herdado (o que já existe e condiciona o design)

**Já pronto — não recriar:**

| Peça | Onde | Observação |
|---|---|---|
| `SessionAuthGuard` **global** | `backend/src/auth/session-auth.guard.ts` | Deny-by-default; `@Public()` é a exceção. Os endpoints da S5.1 ficam protegidos **por omissão** |
| `GET /categories` (ordenado) | `backend/src/categories/` | Fonte da navegação da S5.2 |
| `GET /items` | `backend/src/items/` | Projeção com `categoryId` e `active` |
| Upsert de `players` | `backend/src/sales/sales.service.ts` | `last_known_nickname` já é mantido atualizado — o CA4 depende disso e **já funciona** |
| Índices de `sales` | `backend/src/db/schema.ts` | `sales_item_purchased_at_idx (item_id, purchased_at)`, `sales_player_item_idx (player_uuid, item_id)` |
| Sidenav + rotas aninhadas sob `authGuard` | `frontend/src/app/features/dashboard/` | Seção "Catálogo" com duas entradas estáticas |
| `CategoriesService` com Signals e cache | `frontend/src/app/core/services/` | `categories()` + `loaded()`; a S5.2 **reusa**, não refaz o fetch |
| `withComponentInputBinding()` | `frontend/src/app/app.config.ts` | Route params e query params já chegam como `input()` no componente — base do filtro de período em URL |

**Lacunas que este sprint preenche:**

1. Nenhum endpoint de leitura agregada existe — `sales` expõe somente `POST /sales`.
2. Nenhuma ferramenta de seed — o único caminho para popular `sales` hoje é POSTar no ingest, um a um.
3. Nenhuma dependência de gráfico no `frontend/package.json`.

---

## 1. S5.0 — Gerador de vendas sintéticas

> Backend. **Primeiro PR do sprint** — a S5.1 valida `EXPLAIN` sobre o dataset que este script gera.

### 1.1 Forma e execução

Script standalone em `backend/scripts/seed-sales.ts`, rodado com o `ts-node` já presente
(devDependency usada por `test:debug`). Novo script em `package.json`:

```
npm run seed:sales -- --count=50000 --from=2026-01-01 --to=2026-07-20 --seed=austv
```

**Não é um endpoint HTTP.** Um endpoint de seed é superfície de ataque permanente para um
ganho de conveniência que não existe: quem roda o seed tem acesso ao shell da máquina.

### 1.2 Escrita direta no banco (e por que não via `POST /sales`)

O gerador insere via Drizzle em lotes (`INSERT ... ON CONFLICT (id) DO NOTHING`, ~1000 linhas
por lote), **não** chamando o endpoint de ingest.

- 50k requisições HTTP passando por guard, throttle e uma transação cada levaria dezenas de
  minutos e esbarraria no próprio rate limit do ingest.
- O caminho do ingest já tem cobertura e2e desde a Sprint 2; o seed não é o lugar de reprová-lo.
- **Contrapartida aceita e documentada:** o gerador precisa reproduzir os mesmos invariantes à
  mão — item existente e ativo, `players` upsertado antes da venda, `qtd > 0`, `total_price > 0`.
  Os `CHECK` do schema seguem valendo como rede de segurança.

### 1.3 Idempotência determinística

`sale_id` é derivado, não aleatório: UUIDv5 (`crypto.createHash('sha1')` sobre
`"<seed>:<índice>"`, com os bits de versão/variante ajustados). Consequências:

- Rodar o mesmo comando duas vezes é no-op (`ON CONFLICT DO NOTHING`) — o critério de
  re-executabilidade sai de graça.
- Mudar `--seed` gera um dataset disjunto, permitindo somar volume sem recriar o banco.
- Toda aleatoriedade (escolha de item, jogador, timestamp) vem de um PRNG **semeado**
  (xorshift ou mulberry32, ~10 linhas) — nunca `Math.random()`. Dataset reproduzível é
  pré-condição para comparar dois `EXPLAIN`.

### 1.4 Guarda contra produção (critério bloqueante)

Antes de qualquer escrita, o script **aborta com exit code 1** — sem prompt, sem `--force` —
se qualquer condição valer:

- `NODE_ENV === 'production'`;
- `SEED_ALLOW !== 'true'` (opt-in explícito, ausente por padrão em qualquer `.env`);
- o host do `DATABASE_URL` casar com a allowlist de produção configurada em `SEED_FORBIDDEN_HOSTS`.

Prompt interativo é anti-padrão aqui: o dano acontece justamente quando o script roda dentro
de um pipeline, onde não há ninguém para responder.

### 1.5 Formato dos dados gerados

| Aspecto | Regra |
|---|---|
| Itens | Sorteados entre os `items` **ativos** existentes, com distribuição enviesada (lei de potência): poucos itens campeões, cauda longa — um dataset uniforme esconde exatamente os picos que o CA5 quer mostrar |
| Jogadores | Pool sintético de `players`; distribuição enviesada também, para o top 5 ter separação visível |
| **Troca de nickname** | Uma fração dos jogadores (~20%) tem 2–3 nicknames ao longo da janela. `nickname_at_purchase` recebe o nick **vigente na data da venda**; `players.last_known_nickname` recebe o **mais recente**. É o que prova o CA4 na tela, e não só no teste |
| `purchased_at` | Distribuído na janela com picos concentrados (simula lançamento de crate), não uniforme |
| `historical_import` | Fração configurável (`--historical-ratio`, padrão 10%) com `purchased_at` **fixo num único instante anterior à janela**, espelhando a semântica da Sprint 6 (migração sem granularidade fictícia — CA7) |

### 1.6 Critério de pronto

Documentado no `backend/README.md` com o comando exato do dataset de ~50k usado na DoD do sprint.

---

## 2. S5.1 — Endpoints de leitura agregada

> Backend + revisão de `database-specialist`. Módulo novo `backend/src/analytics/`.

Módulo separado de `sales` de propósito: `sales` é o caminho de **escrita** do plugin, com guard
de API key e throttle próprios. Leitura é o caminho do **dashboard**, com sessão. Misturar os dois
no mesmo controller é como um guard errado acaba aplicado na rota errada.

### 2.1 Contrato

```
GET /analytics/categories/:id/items?from=&to=
GET /analytics/items/:itemId/top-buyers?from=&to=&limit=5
GET /analytics/items/:itemId/series?from=&to=&bucket=day
```

`:id` de categoria é inteiro (`ParseIntPipe`); `:itemId` é a **chave de negócio opaca** em texto
(`caixaNatal2026`) — sem pipe numérico. Categoria ou item inexistente → 404. Período sem vendas
→ **200 com zeros/array vazio**, nunca 404: "não vendeu nada" é um resultado, não um erro.

### 2.2 Semântica do período

`from`/`to` são datas `YYYY-MM-DD`, ambas opcionais, interpretadas em **America/Sao_Paulo** como
intervalo semiaberto `[from 00:00, to+1d 00:00)`. Omitir ambos = toda a história.

DTO de query compartilhado (`PeriodQueryDto`) com `@IsDateString()` e validação `from <= to`,
para as três rotas responderem 400 igual.

### 2.3 A regra do fuso (armadilha principal)

O bucket da série usa:

```sql
date_trunc('day', purchased_at AT TIME ZONE 'America/Sao_Paulo')
```

Sem o `AT TIME ZONE`, uma venda às 21h de Brasília cai no bucket do **dia seguinte** em UTC —
e o pico de lançamento de uma crate aparece partido em dois dias. Mesma conversão vale para os
limites de `from`/`to`, senão filtro e bucket discordam na borda. Teste e2e explícito com venda
às 23h BRT.

### 2.4 A regra do `historical_import`

| Agregação | `historical_import = true` |
|---|---|
| Totais por item / receita da categoria | **Incluído** — o histórico conta para apuração |
| Série temporal | **Excluído** — não existe timestamp real para plotar (CA7) |
| Top compradores | **Incluído** — quem comprou, comprou |

Para a exclusão da série não virar um buraco silencioso, a resposta de `/series` carrega a
baseline explicitamente:

```jsonc
{
  "bucket": "day",
  "points": [ { "at": "2026-07-01", "qtd": 12, "revenue": "1440.00" } ],
  "excludedHistorical": { "qtd": 300, "revenue": "36000.00" }
}
```

A S5.4 renderiza `excludedHistorical` como anotação textual — nunca como ponto datado. O campo
existir no contrato é o que impede a próxima pessoa a mexer aqui de "consertar" o filtro.

### 2.5 Dinheiro nunca vira `number`

`total_price` é `numeric(12,2)`; o driver `pg` devolve `SUM(...)` como **string**. Manter string
até o fim: a resposta expõe `revenue: "1440.00"`, e o frontend formata com `Intl.NumberFormat`.
Um `parseFloat` no meio do caminho reintroduz o erro de ponto flutuante que a coluna `numeric`
existe para evitar. Teste com valores que quebram em `float64` (ex.: `0.1 + 0.2`).

### 2.6 Nickname atual vs. snapshot (CA4)

O top-N agrega por `player_uuid` e faz join em `players` para exibir `last_known_nickname`.
`sales.nickname_at_purchase` **não** aparece no ranking — é registro histórico do evento.
Teste sobre o dataset da S5.0, usando um jogador que trocou de nick.

### 2.7 Índices e `EXPLAIN`

O top-N filtra por `item_id` + período e agrupa por `player_uuid`.
`sales_item_purchased_at_idx (item_id, purchased_at)` atende o filtro;
`sales_player_item_idx (player_uuid, item_id)` **não** serve — coluna líder errada.

Procedimento: rodar `EXPLAIN (ANALYZE, BUFFERS)` das três agregações sobre o dataset de 50k da
S5.0 e colar a saída no PR. Se aparecer `Seq Scan` em `sales` ou o tempo passar de ~1s, o índice
de cobertura candidato é `(item_id, purchased_at) INCLUDE (player_uuid, qtd, total_price)` —
registrado como **débito técnico documentado**, não migration de última hora no meio do sprint.

### 2.8 Limite de janela

`/series` calcula quantos buckets a janela produz e responde **400** acima de 366. Sem isso,
`?from=2000-01-01&bucket=day` devolve milhares de pontos que o gráfico não consegue desenhar e
que ninguém consegue ler — e é um vetor de DoS barato mesmo atrás de sessão.

### 2.9 Testes

- e2e cobrindo as três rotas sobre dataset com eventos históricos **e** recentes.
- **401 sem cookie de sessão nas três rotas** — teste explícito. O guard é global, mas o teste é
  o que impede um `@Public()` colado por engano de passar despercebido no review.
- Borda de fuso (§2.3), precisão monetária (§2.5), nickname trocado (§2.6), janela excessiva (§2.8).

---

## 3. S5.2 — Seção de análise na navegação

> Frontend. Extensão do sidenav da S4.1.

### 3.1 Estrutura

Segunda seção no `dashboard-layout.component.html`, **abaixo** da seção "Catálogo", que permanece
intacta em comportamento e posição:

```
Catálogo          ← inalterado
  Categorias
  Itens
Vendas            ← novo, dinâmico
  <categoria 1>
  <categoria 2>
```

Rota nova, aninhada no mesmo layout (herda o `authGuard` do pai):

```
/sales/categories/:categoryId?from=&to=
```

### 3.2 Reuso do `CategoriesService`

As entradas vêm do `categories()` já cacheado em Signals — a mesma lista da tela de gestão, com a
ordenação `display_order` que **o servidor define**. Não introduzir segunda fonte de verdade nem
ordenar no cliente: a S4.2 já resolveu isso e duplicar a regra é como ela passa a divergir.

### 3.3 Estados

- Carregando: placeholder na seção, sem derrubar o resto do sidenav.
- Vazio (`loaded() && categories().length === 0`): "nenhuma categoria cadastrada" com link para
  `/catalog/categories`. Gatear no `loaded()` — nunca no array vazio, senão o estado vazio pisca
  durante o carregamento.
- Link ativo destacado com o mesmo `routerLinkActive` da seção existente.

---

## 4. S5.3 — Página de categoria: itens + top 5 compradores

> Frontend.

### 4.1 Período na URL

`from`/`to` como **query params**, chegando por `input()` graças ao `withComponentInputBinding()`
já configurado. Presets (7d, 30d, custom) apenas escrevem na URL; a URL é a única fonte de verdade
do período. Isso dá recarregar-e-compartilhar de graça e garante o critério "mesma janela em toda
a página" por construção — lista, ranking e gráfico leem o mesmo lugar, em vez de sincronizarem
três estados locais.

### 4.2 Carregamento

- Ao entrar/trocar de período: um `GET /analytics/categories/:id/items`.
- Top 5 por item: **sob demanda ao expandir o item**, não N requisições no load. Uma categoria com
  30 itens dispararia 30 chamadas para dados que ninguém olhou.
- Estado em Signals, no padrão dos serviços de catálogo. Nenhuma agregação no cliente.

### 4.3 Apresentação

- Itens inativos visualmente distintos (histórico segue visível — desativar não apaga vendas).
- Receita formatada com `Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' })`
  a partir da **string** da API (§2.5).
- Estado vazio por item: "sem vendas no período".

---

## 5. S5.4 — Gráfico de série temporal

> Frontend. Última da cadeia — candidata a corte se o sprint apertar.

### 5.1 Biblioteca (decisão de 2026-07-20)

Lib **agnóstica de framework** (Chart.js ou ECharts), instanciada **direto** no componente. Sem
`ng2-charts` nem wrapper equivalente: wrappers demoram a suportar major novo do Angular, e o
projeto está em Angular 22 / TypeScript 6 — um wrapper incompatível travaria a história no meio
do sprint. Efeito colateral bem-vindo: controle total sobre os tokens visuais.

Escolha final entre as duas no primeiro dia, registrada como **ADR-0003** em `.specs/decisions/`
*(spike — não gera PR de código)*. Critério de desempate sugerido: peso do bundle e o que é
preciso desligar do tema default para chegar ao visual AusTV.

### 5.2 Ciclo de vida

Instância criada num `effect` do componente, com `destroy()` no teardown — gráfico não destruído
em rota que troca é vazamento de memória e listener duplicado. Trocas de período **atualizam** a
instância existente (`update()`), não recriam.

### 5.3 Visual e conteúdo

- Cores e tipografia lidas dos tokens do AusTV (`_tokens.scss`), não hardcoded no options object.
- Alternância quantidade × receita.
- `excludedHistorical` (§2.4) como anotação/baseline textual fora da área de plotagem.
- Estado vazio tratado ("sem vendas no período") — sem canvas em branco sem explicação.

---

## 6. Ordem de merge

```
S5.0 → S5.1 → S5.2 → S5.3 → S5.4
```

S5.0 antes de tudo (a S5.1 precisa do dataset para o `EXPLAIN`). S5.2 e S5.3 poderiam ir em
paralelo, mas a S5.3 depende da rota que a S5.2 cria — manter sequencial evita conflito no
`app.routes.ts`. Uma história = um PR.

## 7. Pontos em aberto

| # | Ponto | Encaminhamento |
|---|---|---|
| 1 | Chart.js vs ECharts | ADR-0003, primeiro dia da S5.4 |
| 2 | Preset de "temporada" no filtro | Fora do MVP; presets 7d/30d/custom bastam *(confirmado no plano do sprint)* |
| 3 | Índice de cobertura para o top-N | Decidido pelo `EXPLAIN` da S5.1; débito documentado se necessário |
| 4 | Granularidade além de `day` (hora/semana) | Contrato já aceita `bucket`; implementar só `day` no MVP se o tempo apertar |
