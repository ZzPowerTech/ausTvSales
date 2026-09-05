# Implantação do subsistema de sugestões — runbook

> Sprint `AusTV Admin S10` · issues [#116](https://github.com/ZzPowerTech/ausTvSales/issues/116),
> [#117](https://github.com/ZzPowerTech/ausTvSales/issues/117),
> [#118](https://github.com/ZzPowerTech/ausTvSales/issues/118)
> Referência: [§5.3 e §7 do spec](../../.specs/features/austv-admin/spec.md) ·
> [`docs/nginx-ingest.md`](../../backend/docs/nginx-ingest.md) (topologias e `TRUST_PROXY`)

## Por que este arquivo existe

A S10 fechou com as três histórias em `main` e **nada rodando**. Esse é o mesmo desfecho que a
[`S6-VERIFICACAO.md`](../../.specs/features/austv-admin/S6-VERIFICACAO.md) já registrou duas vezes
no épico: a S6.2b entregou scripts que ninguém rodou, a S6.3 entregou alerta que ninguém disparou.
Nos três casos o que sobra é o passo que exige tocar um ambiente real.

Este runbook é esse passo escrito. Ele **não** implanta nada sozinho — precisa de alguém com acesso
à VPS.

## O que a S10 atravessa

| peça | repositório | o que precisa na VPS |
|---|---|---|
| schema, máquina de estados, auditoria, listagem | `ZzPowerTech/ausTvSales` | `BOT_API_KEYS`, `BOT_ALLOWED_IPS` |
| comandos `/sugestao*`, check de cargo, escape, navegação | `austv-minecraft/Ticket-Bot` | `ADMIN_API_KEY`, `ADMIN_API_BASE_URL`, `SUGGESTIONS_CHANNEL_ID` |

Bot e API rodam na **mesma VPS** (decisão de 2026-09-02). O bot fala com a API por HTTP em
loopback, com token de serviço — nunca direto no Postgres.

## 🔴 Bloqueio conhecido, antes de começar

O `pnpm-lock.yaml` committado do `Ticket-Bot` resolve `@magicyan/discord@1.7.4` +
`discord.js@14.20.0`, e esse par **não importa**:

```
SyntaxError: The requested module 'discord.js' does not provide an export named 'LabelBuilder'
```

`LabelBuilder` não existe na 14.20.0, e o `env.validate.ts` importa `brBuilder` desse pacote. **Uma
instalação limpa não sobe o bot.** Não foi causado pela S10 — o lockfile não foi tocado — e o
deploy atual provavelmente roda com um `node_modules` mais antigo, mas **o passo 5 abaixo é um
rebuild**, então ele encontra.

Resolver o lockfile é pré-requisito do passo 5. **Os passos 1 a 4 (metade API) não dependem dele** e
podem ir na frente.

## ⚠️ Ordem entre os dois repositórios: API PRIMEIRO

O bot manda `actor_nickname` em toda transição e a API valida com `forbidNonWhitelisted`. Subir o
bot antes da API faz **toda** mudança de estado voltar **400** até a API subir. A ordem abaixo não é
preferência.

---

## 1. Gerar as chaves

Duas listas separadas de propósito: uma chave compartilhada entre plugin e bot faria um vazamento do
bot virar permissão de gravar venda.

```bash
openssl rand -hex 32      # vira BOT_API_KEYS na API e ADMIN_API_KEY no bot — o MESMO valor
```

Os dois lados carregam o mesmo segredo com nomes diferentes. `BOT_API_KEYS` aceita lista
separada por vírgula (janela de rotação `antiga,nova`); `ADMIN_API_KEY` é uma só.

**Nunca versionar o valor.** Injetar como secret de deploy.

## 2. MEDIR `BOT_ALLOWED_IPS` — não escolher

`127.0.0.1` é o palpite óbvio e é o valor que **nenhuma** das duas topologias documentadas produz
com certeza:

| onde a API roda | peer que o processo enxerga |
|---|---|
| direto no host | loopback → `127.0.0.1` (o `::1` de um host dual-stack normaliza para essa forma) |
| **em container** (deploy atual) | o **gateway da bridge** (ex.: `172.27.0.1`), não o loopback |

Foi essa confusão que custou o incidente de 2026-07-19. O procedimento mede em vez de supor:

1. Suba a API com `BOT_ALLOWED_IPS` num endereço deliberadamente errado — use
   `203.0.113.1` (bloco `TEST-NET-3` da RFC 5737, nunca roteável). **Não deixe vazia**: vazia
   *desliga* a allowlist, e uma chamada que passa não revela endereço nenhum.
2. Faça uma chamada autenticada qualquer **a partir do host do bot**:
   ```bash
   curl -sS -o /dev/null -w '%{http_code}\n' \
     -H "X-API-Key: <a chave do passo 1>" \
     http://127.0.0.1:3000/suggestions   # ajustar host:porta do backend
   ```
   Espere `403`.
3. Leia o IP no log de recusa da API. A linha tem a forma:
   ```
   Rejected bot request GET /suggestions from 172.27.0.1: source IP not in allowlist — endereco privado/loopback recusado para um principal CO-LOCADO: ...
   ```
4. **Esse endereço** é o valor de `BOT_ALLOWED_IPS`. Fixe, reinicie, repita o `curl`: agora tem de
   passar da allowlist (o código deixa de ser `403`).

> **O que a lista compra, dito com a condição junto.** Qualquer coisa na própria máquina alcança o
> processo de qualquer jeito. O ganho corre no outro sentido: uma requisição que chega **pelo
> Nginx com `proxy_set_header X-Forwarded-For`** carrega o IP real do cliente e não casa, então um
> `location` acidental não expõe as rotas. Sem esse header a requisição chega como loopback e
> **casa** — a garantia depende da topologia. O que vale sem condição é o menor: chave vazada é
> inútil fora deste host.

## 3. Migrations

```bash
cd backend && npm run db:migrate
```

Aplica até a `0011_suggestion_assignee`. Rollback: os `.down.sql` em `backend/drizzle/rollback/`,
na ordem que o `test/rollback-utils.ts` impõe — **só a migration que é a cabeça pode voltar**, e
essa ordem é código, não convenção.

## 4. Subir a API e verificar

```bash
cd backend && npm ci && npm run build && npm run start:prod
```

No boot, confira as três linhas:

- `IP allowlist active from BOT_ALLOWED_IPS (1 address(es))` — **se aparecer o `warn` de
  `DISABLED`, pare**: as rotas estão protegidas só pela chave.
- `API key auth ready (N key(s) accepted from BOT_API_KEYS)`
- o valor de `TRUST_PROXY`, que precisa casar com a tabela do `docs/nginx-ingest.md`
  (`1` com a API em container, `loopback` no host).

## 5. Subir o bot

Só depois que o passo 4 fechou, e só depois do lockfile resolvido.

`ADMIN_API_KEY`, `ADMIN_API_BASE_URL` e `SUGGESTIONS_CHANNEL_ID` são **opcionais por decisão**: sem
elas os comandos de sugestão respondem "não configurado" e o resto do bot segue de pé. É isso que
torna seguro ter mergeado sem implantar — e é isso que faz um erro de digitação em qualquer das
três passar despercebido como "comando ainda não configurado". Confira as três antes de dar por
subido.

---

## Verificação pós-implantação — o que precisa ser OBSERVADO

Verde em CI não é observação. Cada linha abaixo é um critério de aceite das issues #116–#118 visto
em produção **uma vez**. Registre a saída ao fechar as issues.

| # | o que fazer | o que precisa acontecer |
|---|---|---|
| 1 | Postar uma sugestão no canal | linha em `suggestion` com `created_at` = **hora do post**, não do insert |
| 2 | Repetir o mesmo `discord_msg_id` | devolve a sugestão já gravada, texto original preservado (idempotência) |
| 3 | Staff aprova | estado vai a `aprovada`; `assignee_nickname` **congelado** no apelido do momento |
| 4 | Tentar `concluida` a partir de `enviada` | **409**, e `SELECT` mostra o registro **inalterado** |
| 5 | Não-staff tenta aprovar | bot recusa **e** `GET /suggestions/:id/audit` mostra a tentativa com autor e comando |
| 6 | `GET /suggestions/:id/audit` | trilha com quem mudou o quê, recusas incluídas |
| 7 | `/sugestoes` com mais de uma página | filtro por estado, `total` do conjunto **inteiro**, sem linha repetida nem pulada entre páginas |
| 8 | Sugestão contendo `@everyone` e `> # TESTE` | renderiza como **texto**: sem menção disparada, sem heading |
| 9 | `curl` das rotas de sugestão **de fora da VPS** | **403** antes de qualquer avaliação de chave |

O item 9 é o que prova que os passos 1 e 2 valeram alguma coisa. Os itens 5 e 8 são os dois
requisitos de segurança das histórias.

## Rollback

- **Bot:** apagar as três variáveis e reiniciar. Os comandos voltam a responder "não configurado"; o
  resto do bot não é afetado. Não perde dado.
- **API:** os `.down.sql`, da cabeça para trás. `0011` → `0010` → `0009`. **Isto apaga as sugestões
  gravadas** — se já houver sugestão real, faça dump antes.
- **Parcial:** derrubar só o bot e deixar a API de pé é seguro e é o rollback preferido. O inverso
  não é: bot vivo com a API fora devolve erro em toda interação de staff.
