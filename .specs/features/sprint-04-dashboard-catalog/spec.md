# Spec técnica — Sprint 4: Dashboard de administração do catálogo

> Fase 4 (design de implementação) — derivado de [`sprint-04.md`](../../sprints/sprint-04.md)
> Data: 2026-07-18
> Pré-requisitos satisfeitos:
> - CRUD de categorias e itens protegido por sessão (S1.5/S1.6, mergeado).
> - Login por Discord + `SessionAuthGuard` global + `authGuard` no Angular (S1.4, mergeado).
> - Design tokens do AusTV versionados em `frontend/src/styles/_tokens.scss`.
> Objetivo: transformar as histórias S4.0–S4.3 em decisões de implementação prontas para PR, corrigindo o plano original com o estado real do código.

---

## 0. Estado herdado (o que já existe e condiciona o design)

O plano original da Sprint 4 foi escrito antes da Sprint 1 ser entregue e **superestima
o trabalho da S4.1**: a fundação de autenticação e o padrão visual já estão no lugar.

**Já pronto — não recriar:**

| Peça | Onde | Observação |
|---|---|---|
| Discord OAuth (`login`/`callback`/`logout`/`me`) | `backend/src/auth/auth.controller.ts` | `state` CSRF em cookie one-time |
| Allowlist de `discordId` | `backend/src/auth/allowlist.service.ts` | Nega login fora da lista |
| Sessão em cookie httpOnly assinado | `backend/src/auth/session.service.ts` | Frontend nunca toca no token |
| `SessionAuthGuard` **global** | `backend/src/auth/session-auth.guard.ts` | Deny-by-default; `@Public()` é a exceção |
| `authGuard` + `AuthService` (Signals) | `frontend/src/app/core/` | `ensureLoaded()` com `shareReplay(1)` |
| `credentialsInterceptor` | `frontend/src/app/core/interceptors/` | `withCredentials` em toda chamada |
| Login + shell autenticado com logout | `frontend/src/app/features/` | Shell tem topbar; **não tem navegação lateral** |
| Design tokens do AusTV | `frontend/src/styles/_tokens.scss` | Tema único escuro; regras de uso de cor documentadas no arquivo |
| CI de frontend (build + lint + test) | `.github/workflows/frontend-ci.yml` | Já verde |
| `POST/GET/PATCH /categories` e `/items` | `backend/src/{categories,items}/` | 409 em nome duplicado; `item_id` imutável por ausência no `UpdateItemDto` |

**Lacunas encontradas na análise (origem da S4.0):**

1. **`categories` não tem coluna `active`.** O critério original "desativar categorias" é
   inimplementável hoje. **Decisão (2026-07-18, Murilo): fora do escopo do MVP** — categoria
   sem item ativo simplesmente não aparece na sidebar da Sprint 5. Sem migration, sem estado
   novo para a S5.2 tratar.
2. **Unicidade de `categories.name` é só de aplicação.** `assertNameAvailable` faz `SELECT`
   e depois `INSERT`, sem constraint no banco — mesma classe de corrida que o PR #56 corrigiu
   no upsert de player. Um único admin torna o risco baixo, mas é dívida real.
3. **Reordenação não é atômica.** Mover uma categoria exige dois `PATCH` independentes; uma
   falha no meio deixa `display_order` inconsistente e a UI mentindo.

**Decisão de permissões:** formalizada em [ADR-0002](../../decisions/ADR-0002-permissoes-dashboard.md) —
admin único via allowlist do Discord, sem papéis. Fecha a pendência §9 do spec.

---

## 1. S4.0 — Integridade do catálogo no banco (dívida técnica)

> Backend + database. **Primeira história do sprint**: a S4.2 consome o endpoint de
> reordenação, então este PR precisa mergear antes.

### 1.1 Constraint de unicidade case-insensitive

Migration Drizzle nova (`0001_*.sql`) adicionando índice único funcional:

```sql
CREATE UNIQUE INDEX "categories_name_lower_unique" ON "categories" (lower("name"));
```

No `schema.ts`, declarar via `uniqueIndex(...).on(sql\`lower(${table.name})\`)` para o
schema continuar sendo a fonte de verdade.

- **A migration falha se já existirem nomes duplicados** no ambiente de destino. Verificar
  antes de aplicar (`SELECT lower(name), count(*) FROM categories GROUP BY 1 HAVING count(*) > 1`)
  e resolver manualmente — o runbook do deploy deve registrar isso.
- **Manter a pré-checagem em `assertNameAvailable`**: ela produz a mensagem amigável. A
  constraint é a rede de segurança. Adicionar tratamento do erro `23505` do Postgres →
  `ConflictException` com a mesma mensagem, para o caminho de corrida também devolver 409
  em vez de 500.

### 1.2 Endpoint de reordenação atômica

```
PATCH /categories/reorder
Body: { "order": [3, 1, 2] }   // ids na ordem desejada
200 → Category[] (já reordenado, mesma projeção do GET)
```

Semântica: `display_order = índice no array`. Executado em **uma transação** —
`db.transaction(...)` com um `UPDATE` por id.

Validação (`ReorderCategoriesDto`):
- `order`: `@IsArray()`, `@ArrayNotEmpty()`, `@IsInt({ each: true })`, `@ArrayUnique()`.
- O array precisa conter **exatamente** o conjunto de ids existentes. Ids faltando ou
  desconhecidos → `400`, não reordenação parcial. Evita que duas abas abertas deixem o
  `display_order` com buracos.

⚠️ **Ordem de declaração das rotas:** `@Patch('reorder')` precisa vir **antes** de
`@Patch(':id')` no controller. Com `ParseIntPipe` no `:id` o erro seria um 400 confuso em
vez de um 404, então a ordem correta é obrigatória, não estética. Cobrir com teste.

### 1.3 Critérios de aceite

- [ ] Migration aplica em banco limpo e o índice único aparece no `\d categories`
- [ ] `POST /categories` com nome duplicado em caixa diferente → 409 (já coberto) **e**
      inserção concorrente direta no banco também é barrada pela constraint
- [ ] Violação `23505` mapeada para 409, nunca 500
- [ ] `PATCH /categories/reorder` persiste a ordem em uma transação; erro no meio não deixa
      ordem parcial (teste com id inexistente no array)
- [ ] `order` incompleto ou com id desconhecido → 400 com mensagem clara
- [ ] `PATCH /categories/reorder` continua exigindo sessão (guard global)

---

## 2. S4.1 — Shell de navegação + tratamento global de 401

> Escopo **reduzido**: login, guard, tokens e CI já existem (§0). Sobra o que falta para o
> shell comportar duas telas e para a sessão morrer de forma limpa.

### 2.1 Layout com navegação

Extrair o shell do `DashboardComponent` para um `DashboardLayoutComponent` com
`<router-outlet />`, e converter as rotas para aninhadas:

```
''                        → DashboardLayoutComponent  [authGuard]
  ''                      → redirect para 'catalog/categories'
  'catalog/categories'    → CategoriesPageComponent    (S4.2)
  'catalog/items'         → ItemsPageComponent         (S4.3)
'login'                   → LoginComponent
'**'                      → redirect para ''
```

- Topbar existente preservada (marca + usuário + logout).
- **Navegação lateral** com os links de catálogo, usando `routerLinkActive` para o estado
  ativo. A sidebar **dinâmica por categoria** é da S5.2 — este slot é a estrutura onde ela
  vai morar, não a implementação dela.
- `authGuard` no nó pai cobre todos os filhos (deny-by-default mantido).
- Todos os componentes `standalone` + `ChangeDetectionStrategy.OnPush`, como o código atual.

### 2.2 Interceptor de erro de autenticação

Hoje um 401 no **meio** da sessão (cookie expirado) não derruba nada: o guard já rodou e a
tela fica quebrada silenciosamente. Adicionar `authErrorInterceptor`:

- Em `401`: limpa o estado do `AuthService` (novo método `reset()`, que zera o signal e o
  `meRequest` cacheado) e navega para `/login?error=session_expired`.
- **Não** interceptar 401 de `GET /auth/me` — ali o 401 é o resultado normal para "não
  logado", já tratado pelo `catchError` do `AuthService`. Redirecionar dali causaria
  navegação dupla no boot.
- Registrar **depois** do `credentialsInterceptor` em `app.config.ts`.
- A `LoginComponent` já lê `?error=` via `withComponentInputBinding` — adicionar a mensagem
  de `session_expired` ao mapa de erros existente.

### 2.3 Serviços de catálogo (base das S4.2/S4.3)

`ApiService` hoje só tem um `getSales()` de placeholder. Criar serviços dedicados:

- `CategoriesService` (frontend): `list()`, `create()`, `rename()`, `reorder(ids)`.
- `ItemsService` (frontend): `list()`, `create()`, `update()`.
- Modelos em `core/models/`: `Category`, `Item` — snake_case no contrato da API
  (`display_order`, `item_id`, `display_name`, `category_id`), mantendo o que o backend
  devolve, sem tradução de nomes.

Estado com **Signals**, seguindo o padrão do `AuthService`: signal privado + `asReadonly()`
exposto. Sem NgRx, sem biblioteca de UI de terceiros.

### 2.4 Critérios de aceite

- [ ] Rotas aninhadas com navegação lateral; link ativo destacado
- [ ] Rota não autenticada continua redirecionando para `/login`
- [ ] 401 no meio da sessão → sessão limpa + redirect para login com mensagem de expiração
- [ ] 401 de `/auth/me` **não** dispara redirect duplicado no boot (teste explícito)
- [ ] Nenhum token em `localStorage`/`sessionStorage` — sessão segue 100% no cookie httpOnly
- [ ] Visual usa exclusivamente os tokens de `_tokens.scss`; nenhuma cor hard-coded
- [ ] [ADR-0002](../../decisions/ADR-0002-permissoes-dashboard.md) referenciado no PR

---

## 3. S4.2 — Tela de gestão de categorias

### 3.1 Comportamento

| Ação | Chamada | Nota |
|---|---|---|
| Listar | `GET /categories` | Já vem ordenado por `display_order`, depois `name` |
| Criar | `POST /categories` | `display_order` omitido → backend usa 0; a ordem é ajustada pelo reorder |
| Renomear | `PATCH /categories/:id` | Só `name` |
| Reordenar | `PATCH /categories/reorder` (S4.0) | Mover ↑/↓ na lista; envia o array completo |

Reordenação com botões **mover para cima / mover para baixo** — drag-and-drop está fora do
escopo (custo alto, ganho marginal para uma lista de poucas categorias).

**Otimismo controlado:** aplicar a nova ordem na UI imediatamente e reverter se a chamada
falhar. A operação é atômica no backend (S4.0), então o rollback é sempre para o estado
anterior inteiro — sem ordem parcial possível.

### 3.2 Erros

- **409** (nome duplicado) → mensagem no próprio campo do formulário, texto explícito de
  que já existe categoria com esse nome. É a proteção contra typo ficando visível.
- **400** → mensagem do backend exibida como erro de formulário.
- **5xx / rede** → aviso não-destrutivo, mantendo o que o usuário digitou.

### 3.3 Critérios de aceite

- [ ] Listagem ordenada por `display_order`, com criação e renomeação inline
- [ ] Mover ↑/↓ persiste via endpoint atômico; falha reverte a UI ao estado anterior
- [ ] 409 exibido no formulário, claro e sem jargão
- [ ] Estado com Signals; sem bibliotecas de UI genéricas
- [ ] Botões de ordem desabilitados nos extremos (primeira não sobe, última não desce)
- [ ] Sem opção de excluir/desativar categoria (fora do MVP — §0)

---

## 4. S4.3 — Tela de gestão de itens

### 4.1 Formulário

Validação **espelhando o backend**, não inventando regra nova:

| Campo | Regra (fonte: `CreateItemDto`) |
|---|---|
| `item_id` | `/^[A-Za-z0-9][A-Za-z0-9_-]*$/`, até 120 chars. **Imutável após criação** |
| `display_name` | Obrigatório, até 200 chars, trim |
| `category_id` | Obrigatório, selecionado de `GET /categories` |
| `active` | Booleano, default `true` |

Na edição, `item_id` aparece **travado** (não apenas escondido) — o `UpdateItemDto` sequer
aceita o campo, e o motivo é forte: vendas históricas referenciam `item_id` por chave
estrangeira.

### 4.2 Listagem e filtros

`GET /items` devolve o catálogo inteiro ordenado por `item_id`. Filtro por categoria e por
status ativo/inativo é **client-side sobre Signals computados** — o catálogo tem dezenas de
itens, não milhares; paginação server-side seria complexidade sem demanda.

Exibir o `display_name` da categoria (join client-side com a lista de categorias já
carregada), não o `category_id` cru.

### 4.3 Desativação

Desativar (`PATCH /items/:id` com `active: false`) exige **confirmação explícita** deixando
claro o efeito operacional: vendas novas daquele `item_id` passam a ser rejeitadas, tanto
pelo cache local do plugin (S3.1) quanto pela API. Vendas já registradas não são afetadas.

### 4.4 Ajuda contextual do comando

Após criar um item, exibir o comando de reward pronto para colar na config do Genesis, com
botão de copiar:

```
austv-sales add %player% <item_id> %price% 1
```

Formato confirmado no `plugin.yml`: `/<command> add <player_nick> <item_id> <total_price> <qtd>`.
O `<item_id>` sai preenchido com o valor real do item criado — é exatamente aqui que o erro
de digitação acontece hoje, e o custo dele é uma venda rejeitada em produção.

### 4.5 Critérios de aceite

- [ ] Criação valida `item_id` com o mesmo regex do backend, antes do round-trip
- [ ] Categoria obrigatória, escolhida de lista carregada da API
- [ ] `item_id` travado na edição; só `display_name`, categoria e `active` editáveis
- [ ] Listagem filtrável por categoria e por status, via Signals computados
- [ ] Desativar tem confirmação explícita com o efeito descrito em português claro
- [ ] Comando de reward exibido com `item_id` preenchido e botão de copiar
- [ ] 409 (`item_id` duplicado) e 422 (categoria inexistente) tratados no formulário

---

## 5. Ordem de execução e fatiamento em PRs

```
S4.0  Integridade do catálogo (backend)     ── mergear primeiro: S4.2 depende do reorder
  │
S4.1  Shell + rotas aninhadas + 401 global  ── base das duas telas
  │
  ├── S4.2  Categorias   ┐
  └── S4.3  Itens        ┴─ independentes entre si após a S4.1
```

4 PRs, um por história. S4.2 e S4.3 podem ser paralelizadas depois que a S4.1 mergear —
tocam arquivos diferentes e compartilham apenas os serviços criados na S4.1.

## 6. Riscos

| Risco | Mitigação |
|---|---|
| Migration da constraint falha por nome duplicado pré-existente | Query de verificação documentada em §1.1; rodar antes do deploy |
| Ordem de rotas (`reorder` vs `:id`) passar despercebida no review | Teste explícito no PR da S4.0 |
| Filtro client-side não escalar se o catálogo crescer muito | Aceito: dezenas de itens. Se passar de ~500, vira história de paginação |
| Duas abas abertas reordenando ao mesmo tempo | O contrato exige o conjunto completo de ids → a segunda chamada com conjunto defasado falha com 400 em vez de corromper a ordem |
| Escopo do visual crescer além do necessário | Tokens já existem e definem as regras de cor; telas são tabelas + formulários, não dashboards gráficos |

## 7. Referências

- Sprint: [`sprint-04.md`](../../sprints/sprint-04.md)
- Decisão de permissões: [`ADR-0002`](../../decisions/ADR-0002-permissoes-dashboard.md)
- Spec do projeto: [`PROJECT.md`](../../project/PROJECT.md) — CA6 (cadastro manual funcional)
- Precedente de spec de sprint: [`sprint-03-resilience/spec.md`](../sprint-03-resilience/spec.md)
