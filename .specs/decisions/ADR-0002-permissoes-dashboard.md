# ADR-0002 — Modelo de permissões do dashboard

- **Status:** Aceito (aprovado pelo Murilo em 2026-07-18)
- **Data:** 2026-07-18
- **História:** S4.1 — issue #20
- **Responsáveis:** `frontend-specialist` + `backend-specialist` — revisão `cybersecurity-validator`
- **Fecha:** pendência da seção 9 do spec ("desenhar tela de cadastro: permissões e fluxo")

## Contexto

O spec do projeto (§9) deixou em aberto o modelo de permissões do dashboard. A
Sprint 1 já implementou, para destravar o CRUD de catálogo, um mecanismo
funcional que nunca foi formalizado como decisão:

- Login via **Discord OAuth 2.0** (`GET /auth/discord/login` → callback), com
  cookie de `state` como proteção CSRF do round-trip.
- **Allowlist de `discordId`** (`AllowlistService`): quem não está na lista tem o
  login negado com `?error=access_denied`, mesmo tendo autenticado no Discord.
- Sessão em **cookie httpOnly assinado** (`SessionService`); o frontend nunca
  toca no token — só pergunta `GET /auth/me`.
- `SessionAuthGuard` **global** no backend: rotas são protegidas por padrão e
  precisam de `@Public()` explícito para escapar. Inclui as leituras de
  `/categories` e `/items` — nada em `sales.austv.net` é enumerável sem sessão.

Na prática o sistema já opera com **um único nível de acesso**. A decisão
pendente é se o MVP introduz papéis (ex.: um perfil somente-leitura para ver
receita sem poder cadastrar) ou se formaliza o modelo binário atual.

## Decisão

**Admin único via allowlist do Discord.** Quem está na allowlist é administrador
pleno: pode ler métricas e escrever no catálogo. Não há papéis, níveis nem fluxo
de aprovação no MVP.

Consequências operacionais:

- Conceder acesso = adicionar um `discordId` na allowlist e reiniciar/recarregar
  a configuração. Revogar = remover da lista.
- A sessão **não carrega papel**. Se papéis entrarem depois, o claim novo no
  token de sessão é aditivo — sessões antigas expiram naturalmente.
- Toda rota do dashboard carrega `authGuard` (deny-by-default no frontend,
  espelhando o guard global do backend).

## Alternativa descartada

**Admin + papel somente-leitura** (+3 SP): exigiria modelar papel no token de
sessão, um guard por rota no backend e ocultação condicional de ações no
frontend. Descartada porque o público do dashboard hoje é a própria equipe que
administra o catálogo — não existe usuário real que precise ver receita **sem**
poder cadastrar. Introduzir o papel agora seria complexidade sem demanda, e o
custo de adicioná-lo depois é baixo (claim aditivo).

## Consequências

- ✅ Fecha a pendência §9 do spec sem custo de implementação — o que existe vira
  a decisão registrada.
- ✅ Superfície de autorização mínima: um bit (está na allowlist ou não), fácil
  de auditar pelo `cybersecurity-validator`.
- ⚠️ Toda conta autorizada pode alterar o catálogo. Como desativar um item
  rejeita vendas novas daquele `item_id`, um erro de um admin tem efeito
  operacional imediato — mitigado pela confirmação explícita na UI (S4.3) e pelo
  tamanho da equipe.
- ⚠️ Não há trilha de auditoria de quem cadastrou/alterou o quê. Aceito no MVP;
  se virar necessidade, entra como história futura (`created_by`/`updated_by` no
  catálogo).

## Referências

- [ADR-0001](ADR-0001-auth-plugin-api.md) — auth **plugin→API** (API key). É um
  eixo **separado** por design: máquina→máquina não compartilha o mecanismo de
  sessão humana.
- [`sprint-04.md`](../sprints/sprint-04.md) — S4.1
- Implementação: [`backend/src/auth/`](../../backend/src/auth/),
  [`frontend/src/app/core/guards/auth.guard.ts`](../../frontend/src/app/core/guards/auth.guard.ts)
