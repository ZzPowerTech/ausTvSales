# Sprint 4 — Dashboard: autenticação e cadastro de catálogo

> Duração: 1 semana
> Épico: E4 (Dashboard: administração de catálogo)
> Capacidade planejada: 11 SP
> Pré-requisito: CRUDs de catálogo da API (S1.5, S1.6) mergeados

## Objetivo do sprint

Ao final do sprint, o Murilo consegue entrar no dashboard autenticado e cadastrar categorias e
itens sem tocar em SQL — cobrindo o CA6 do MVP ("cadastro manual funcional antes de qualquer
venda daquele item poder ser aceita") e a pendência da seção 9 (desenho da tela de cadastro e
permissões). Prioridade sobre a visualização (Sprint 5) porque o cadastro é pré-condição
operacional do cutover.

---

## Histórias

### S4.1 — Scaffolding Angular + layout base + autenticação do dashboard

- **Como** administrador do AusTV, **quero** um dashboard Angular com o padrão visual próprio da rede e tela de login, **para** que só pessoas autorizadas acessem administração e métricas de receita.
- **Responsável:** `frontend-specialist` + `backend-specialist` (endpoint de sessão) — revisão: `cybersecurity-validator`
- **Estimativa:** 5 SP — scaffolding (Angular + Signals), shell de layout seguindo o padrão visual do AusTV (proibido UI genérica), fluxo de login e evolução do guard admin da S1.4 para sessão de usuário.
- **Critérios de aceite:**
  - [ ] Projeto Angular em `frontend/` com Signals, rotas com guard de autenticação e build no CI
  - [ ] Shell de layout (topbar + área de sidebar) seguindo o padrão visual próprio já estabelecido do AusTV
  - [ ] Login funcional contra o backend; token/sessão nunca em código; logout e expiração tratados
  - [ ] Rota não autenticada redireciona para login; chamadas 401 derrubam a sessão de forma limpa
  - [ ] **Decisão de permissões registrada no PR** (pendência da seção 9): usuário único admin nesta fase, sem fluxo de aprovação — evolução para papéis fica fora do MVP *(validar com o Murilo)*
- **Nota de fatiamento:** 1 PR — o layout base sem auth não é deployável com segurança, e a auth sem shell não é testável de verdade; juntos formam a menor unidade funcional.

### S4.2 — Tela de gestão de categorias

- **Como** administrador, **quero** criar, renomear, reordenar e desativar categorias pelo dashboard, **para** montar a estrutura da sidebar sem acesso direto ao banco.
- **Responsável:** `frontend-specialist`
- **Estimativa:** 3 SP
- **Critérios de aceite:**
  - [ ] Listagem ordenada por `display_order`, com criação e edição de nome
  - [ ] Reordenação persiste `display_order` (controle simples: mover para cima/baixo é suficiente no MVP)
  - [ ] Erro 409 da API (nome duplicado) exibido de forma clara no formulário — a proteção contra typo é visível ao usuário
  - [ ] Estado gerenciado com Signals; sem bibliotecas de UI genéricas fora do padrão visual

### S4.3 — Tela de gestão de itens

- **Como** administrador, **quero** cadastrar itens (`item_id`, `display_name`, categoria, ativo) pelo dashboard, **para** liberar a venda de um item novo minutos antes do lançamento de uma crate, sem SQL manual.
- **Responsável:** `frontend-specialist`
- **Estimativa:** 3 SP
- **Critérios de aceite:**
  - [ ] Formulário de criação com validação espelhando a API: `item_id` no formato de identificador (sem espaços), categoria obrigatória selecionada de lista
  - [ ] `item_id` imutável após criação (campo travado na edição) — só `display_name`, categoria e `active` editáveis
  - [ ] Listagem filtrável por categoria e por status ativo/inativo
  - [ ] Desativar item tem confirmação explícita, deixando claro que vendas novas daquele `item_id` passarão a ser rejeitadas
  - [ ] Ajuda contextual mostra o comando de reward correspondente (ex.: `austv-sales add %player% <item_id> %price% 1`) para copiar no Genesis — reduz erro de digitação na config da crate

---

## Definition of Done do Sprint 4

- Todo código mergeado via PR revisado, CI verde (build + lint do frontend)
- Dashboard deployado no ambiente de teste, atrás do Nginx, acessível apenas com login
- Fluxo real validado: login → criar categoria → criar item → executar venda desse item no servidor de teste → venda aceita; venda de `item_id` não cadastrado segue rejeitada
- Nenhuma rota do dashboard nem endpoint consumido acessível sem autenticação (revisão `cybersecurity-validator`)
- UI segue o padrão visual próprio do AusTV — sem componentes genéricos destoantes
- Decisão de permissões (admin único no MVP) validada pelo Murilo

## Riscos e dependências

| Risco | Mitigação |
|---|---|
| Padrão visual próprio consome mais tempo que o previsto | Reaproveitar tokens/estilos do AusTV Finance onde existirem; escopo do shell é mínimo (topbar + sidebar) |
| Decisão de permissões (seção 9) divergir do assumido | Assunção "admin único, sem aprovação" está explícita na S4.1 para o Murilo validar cedo no sprint |
| Evolução do guard S1.4 para sessão quebrar clientes existentes | O guard plugin→API (S2.1) é separado por design; testes e2e do Sprint 1/2 seguem no CI |
