# Sprint 4 — Dashboard: administração de catálogo

> Duração: 1 semana
> Épico: E4 (Dashboard: administração de catálogo)
> Capacidade planejada: 11 SP
> Pré-requisito: CRUDs de catálogo da API (S1.5, S1.6) mergeados ✅
> **Revisado em 2026-07-18** — ver §"Nota de revisão" no final. Design de implementação:
> [`.specs/features/sprint-04-dashboard-catalog/spec.md`](../features/sprint-04-dashboard-catalog/spec.md)

## Objetivo do sprint

Ao final do sprint, o Murilo consegue entrar no dashboard autenticado e cadastrar categorias e
itens sem tocar em SQL — cobrindo o CA6 do MVP ("cadastro manual funcional antes de qualquer
venda daquele item poder ser aceita") e a pendência da seção 9 (permissões, fechada em
[ADR-0002](../decisions/ADR-0002-permissoes-dashboard.md)). Prioridade sobre a visualização
(Sprint 5) porque o cadastro é pré-condição operacional do cutover.

---

## Histórias

### S4.0 — Integridade do catálogo no banco (dívida técnica)

- **Como** dono do sistema, **quero** unicidade de nome de categoria garantida pelo banco e reordenação atômica, **para** que a estrutura do catálogo não possa entrar em estado inconsistente por corrida ou falha no meio da operação.
- **Responsável:** `database-specialist` + `backend-specialist`
- **Estimativa:** 3 SP
- **Critérios de aceite:**
  - [ ] Índice único funcional `lower(name)` em `categories`, via migration Drizzle
  - [ ] Violação `23505` mapeada para 409 (nunca 500); pré-checagem amigável mantida
  - [ ] `PATCH /categories/reorder` transacional recebendo o array completo de ids
  - [ ] Array incompleto ou com id desconhecido → 400, sem reordenação parcial
  - [ ] Rota `reorder` declarada antes de `:id` no controller, com teste que cobre a ordem
- **Nota de fatiamento:** primeiro PR do sprint — a S4.2 consome o endpoint de reordenação.

### S4.1 — Shell de navegação + tratamento global de 401

- **Como** administrador do AusTV, **quero** um shell com navegação entre as telas de catálogo e uma sessão que expira de forma limpa, **para** trabalhar no dashboard sem telas quebradas silenciosamente.
- **Responsável:** `frontend-specialist` — revisão: `cybersecurity-validator`
- **Estimativa:** 2 SP *(reduzida de 5 SP: login, guard, tokens e CI já foram entregues na Sprint 1)*
- **Critérios de aceite:**
  - [ ] Rotas aninhadas sob layout autenticado, com navegação lateral e link ativo destacado
  - [ ] 401 no meio da sessão limpa o estado e redireciona para login com mensagem de expiração
  - [ ] 401 de `GET /auth/me` **não** dispara redirect duplicado no boot
  - [ ] Serviços de catálogo (categorias/itens) com estado em Signals, base das S4.2/S4.3
  - [ ] Nenhum token em `localStorage`/`sessionStorage`; visual só com tokens de `_tokens.scss`
  - [ ] Decisão de permissões: **admin único via allowlist do Discord**, registrada em [ADR-0002](../decisions/ADR-0002-permissoes-dashboard.md) ✅ aprovada pelo Murilo em 2026-07-18

### S4.2 — Tela de gestão de categorias

- **Como** administrador, **quero** criar, renomear e reordenar categorias pelo dashboard, **para** montar a estrutura da sidebar sem acesso direto ao banco.
- **Responsável:** `frontend-specialist`
- **Estimativa:** 3 SP
- **Critérios de aceite:**
  - [ ] Listagem ordenada por `display_order`, com criação e edição de nome
  - [ ] Reordenação por mover ↑/↓ persiste via `PATCH /categories/reorder`; falha reverte a UI
  - [ ] Erro 409 da API (nome duplicado) exibido de forma clara no formulário
  - [ ] Estado gerenciado com Signals; sem bibliotecas de UI genéricas fora do padrão visual
  - [ ] Sem opção de excluir ou desativar categoria (fora do escopo do MVP — ver nota de revisão)

### S4.3 — Tela de gestão de itens

- **Como** administrador, **quero** cadastrar itens (`item_id`, `display_name`, categoria, ativo) pelo dashboard, **para** liberar a venda de um item novo minutos antes do lançamento de uma crate, sem SQL manual.
- **Responsável:** `frontend-specialist`
- **Estimativa:** 3 SP
- **Critérios de aceite:**
  - [ ] Formulário de criação com validação espelhando a API: `item_id` no regex do backend, categoria obrigatória selecionada de lista
  - [ ] `item_id` imutável após criação (campo travado na edição) — só `display_name`, categoria e `active` editáveis
  - [ ] Listagem filtrável por categoria e por status ativo/inativo
  - [ ] Desativar item tem confirmação explícita, deixando claro que vendas novas daquele `item_id` passarão a ser rejeitadas
  - [ ] Ajuda contextual mostra o comando de reward já preenchido (`austv-sales add %player% <item_id> %price% 1`) com botão de copiar — reduz erro de digitação na config da crate

---

## Definition of Done do Sprint 4

- Todo código mergeado via PR revisado, CI verde (build + lint do frontend, testes do backend)
- Migration da S4.0 aplicada no ambiente de teste, com verificação prévia de nomes duplicados
- Dashboard deployado no ambiente de teste, atrás do Nginx, acessível apenas com login
- Fluxo real validado: login → criar categoria → criar item → executar venda desse item no servidor de teste → venda aceita; venda de `item_id` não cadastrado segue rejeitada
- Nenhuma rota do dashboard nem endpoint consumido acessível sem autenticação (revisão `cybersecurity-validator`)
- UI segue o padrão visual próprio do AusTV — sem componentes genéricos destoantes
- Decisão de permissões registrada em ADR-0002 ✅

## Riscos e dependências

| Risco | Mitigação |
|---|---|
| Migration da constraint falha por nome duplicado pré-existente | Query de verificação documentada no spec §1.1; rodar antes do deploy |
| Ordem de rotas (`reorder` vs `:id`) passar despercebida no review | Teste explícito exigido no PR da S4.0 |
| Duas abas reordenando ao mesmo tempo | Contrato exige o conjunto completo de ids → a chamada defasada falha com 400 em vez de corromper a ordem |
| Escopo do visual crescer além do necessário | Tokens do AusTV já existem e definem as regras de cor; as telas são tabelas + formulários |
| Evolução do guard S1.4 quebrar clientes existentes | O guard plugin→API (S2.1) é separado por design; testes e2e dos Sprints 1/2 seguem no CI |

---

## Nota de revisão (2026-07-18)

O plano original foi escrito em 2026-07-11, **antes** da Sprint 1 ser entregue, e envelheceu.
A análise pré-sprint encontrou:

1. **S4.1 já estava ~70% entregue.** Discord OAuth com allowlist, `SessionAuthGuard` global,
   `authGuard` no Angular, design tokens do AusTV e CI de frontend vieram junto com a Sprint 1
   (commits `e919d5b` e `a83d09c`). Estimativa caiu de 5 SP para 2 SP.
2. **"Desativar categoria" era inimplementável.** A tabela `categories` tem apenas
   `id`, `name`, `display_order` — não existe coluna `active`. **Decisão do Murilo: fora do
   escopo do MVP.** Categoria sem item ativo simplesmente não aparece na sidebar (Sprint 5).
   Evita uma migration e um estado novo que a S5.2 teria de tratar.
3. **Duas dívidas de integridade no catálogo:** unicidade de nome apenas na aplicação (mesma
   classe de corrida corrigida no PR #56) e reordenação não-atômica. **Decisão do Murilo:**
   usar a capacidade liberada pela S4.1 para pagá-las → nova história **S4.0**.

Total permanece 11 SP. O que mudou foi a distribuição: menos scaffolding, mais integridade.
