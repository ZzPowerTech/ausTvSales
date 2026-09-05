# Implantação do subsistema de sugestões — runbook

> Sprint `AusTV Admin S10` · issues [#116](https://github.com/ZzPowerTech/ausTvSales/issues/116),
> [#117](https://github.com/ZzPowerTech/ausTvSales/issues/117),
> [#118](https://github.com/ZzPowerTech/ausTvSales/issues/118)
> Referência: [§5.3 e §7 do spec](../../.specs/features/austv-admin/spec.md) ·
> [`docs/nginx-ingest.md`](../../backend/docs/nginx-ingest.md) (topologias e `TRUST_PROXY`)

## Estado — 2026-09-04

**Executado e verificado: 9 de 9 em 2026-09-05.** O subsistema está no ar, criou sugestões reais, e
cada critério de aceite das issues #116–#118 foi observado em produção. Este arquivo passa a ser
referência de reimplantação, não de trabalho pendente.

A data está no corpo de propósito: este épico já perdeu tempo com um registro de ambiente sem data,
lido no dia seguinte como se fosse o estado atual. Se você chegou aqui muito depois, **confirme
antes de agir** — nada abaixo é garantia permanente.

| passo | estado |
|---|---|
| 1. gerar as chaves | ✅ feito (a primeira vazou num `grep` e foi rotacionada) |
| 2. **medir** `BOT_ALLOWED_IPS` | ✅ **`172.27.0.5`** — o IP do bot na rede `austv-sales_default` |
| 3. migrations | ✅ aplicadas |
| 4. subir a API | ✅ |
| 5. subir o bot | ✅ `v0.2.1`, por pipeline (release-please → GHCR → deploy SSH) |

## Por que este arquivo existe

A S10 fechou com as três histórias em `main` e nada rodando **até 2026-09-04**. Esse é o mesmo desfecho que a
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

Bot e API rodam na **mesma VPS** (decisão de 2026-09-02), com token de serviço — nunca direto no
Postgres.

**🔴 E não é por loopback, embora este arquivo dissesse que era.** São dois *containers*:
`127.0.0.1` dentro do bot é o loopback dele, não o do host, e a API publica só em
`127.0.0.1:3000` do host. Medido em 2026-09-04: **nenhum** valor aceito pelo schema alcançava a
API, e o subsistema não podia ser ligado. Os dois passaram a dividir a rede
`austv-sales_default` e o endereço é `http://austv-sales-backend-1:3000`.

## ✅ Bloqueio RESOLVIDO em 2026-09-03 — mantido como registro

O `pnpm-lock.yaml` committado do `Ticket-Bot` resolve `@magicyan/discord@1.7.4` +
`discord.js@14.20.0`, e esse par **não importa**:

```
SyntaxError: The requested module 'discord.js' does not provide an export named 'LabelBuilder'
```

`LabelBuilder` não existe na 14.20.0, e o `env.validate.ts` importa `brBuilder` desse pacote. **Uma
instalação limpa não sobe o bot.** Não foi causado pela S10 — o lockfile não foi tocado — e o
deploy atual provavelmente roda com um `node_modules` mais antigo, mas **o passo 5 abaixo é um
rebuild**, então ele encontra.

**Resolvido** em [Ticket-Bot#4](https://github.com/austv-minecraft/Ticket-Bot/pull/4): o lockfile
foi regerado e o CI do repositório (que não existia) passou a rodar os dois caminhos de boot como
smoke. O parágrafo acima fica como registro de por que o passo 5 travou.

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

| # | o que fazer | o que precisa acontecer | observado em 2026-09-05 |
|---|---|---|---|
| 1 | Postar uma sugestão no canal | `created_at` = **hora do post**, não do insert | ✅ `#5` postada 16:53:49 BRT, API devolve `19:53:49.266Z` — **mesmo instante** (UTC−3). E o `createdAt` da `#1` continuou em 04/09 depois de um reenvio que mandou a data de hoje |
| 2 | Repetir o mesmo `discord_msg_id` | devolve a gravada, texto original preservado | ✅ **5 de 5** sugestões: mesmo id, texto original |
| 3 | Staff aprova | `assignee_nickname` **congelado** | ✅ apelido do servidor **trocado** e o valor **não** mudou |
| 4 | `concluida` a partir de `enviada` | **409**, registro **inalterado** | ✅ `#5`: 409, estado depois `enviada`, motivo legível na trilha |
| 5 | Não-staff tenta aprovar | recusa **e** trilha consultável | ✅ recusa no Discord + **7 linhas `auth_denied`** de 5 atores distintos |
| 6 | `GET /suggestions/:id/audit` | trilha com quem mudou o quê | ✅ transições e recusas, com ator, comando, `de→para` e motivo |
| 7 | `/sugestoes` paginado | `total` do conjunto **inteiro** | ✅ `total=5` com `limit=1`; páginas 0 e 1 devolveram `#5` e `#4` |
| 8 | `@everyone` e `> # TESTE` | renderiza como **texto** | ✅ menção inerte e markdown escapado |
| 9 | `curl` **de fora da VPS** | **403** antes de avaliar a chave | ✅ `GET https://sales.austv.net/api/suggestions` → **403** |

O item 9 é o que prova que os passos 1 e 2 valeram alguma coisa. Os itens 5 e 8 são os dois
requisitos de segurança das histórias.

### 🔴 A armadilha de leitura do item 1

`created_at` volta em **UTC** (o `Z` do ISO 8601) e o Discord mostra no fuso de quem olha. Em
America/Sao_Paulo isso são **três horas de diferença aparente**, e parece atraso de gravação. Não
é — converta antes de abrir incidente. Quase virou um aqui.

### As duas metades que quase passaram por inteiras

Vale registrar porque nas duas a parte que faltava podia estar quebrada **sem diferença visível**
para quem só olha o Discord:

- **item 5** — o bot recusar é a metade visível; a outra é a recusa ficar **consultável**, que é a
  razão declarada do desenho da S10.2. O `recordDeniedAttempt` chama a API antes de recusar: se
  essa chamada falhasse, a recusa apareceria igual e a linha não existiria. As 7 linhas provam que
  grava.
- **item 3** — ler o apelido uma vez é indistinguível de um valor resolvido ao vivo. Só a **troca
  de apelido entre duas leituras** separa congelado de consultado.

### Como reproduzir esta verificação

O script está em [`verify-s10.js`](verify-s10.js), ao lado deste arquivo. Roda **dentro do
container do bot** e usa as variáveis de lá — nenhum segredo digitado nem impresso, e sai do único
IP que a allowlist aceita:

```bash
docker cp ops/deploy/verify-s10.js discordbot:/tmp/verify-s10.js
docker exec discordbot node /tmp/verify-s10.js <id-da-sugestao> <seu-discord-id>
```

O `<seu-discord-id>` vai para a trilha como autor da tentativa ilegal do item 4 — é honesto que
seja o real, não um inventado.

Dois itens o script **não** decide sozinho, de propósito: o **3** exige a troca de apelido entre
duas execuções, e o **1** exige comparar com o horário do Discord convertendo o fuso.

### Cuidado ao verificar: a allowlist agora barra o host

Com `BOT_ALLOWED_IPS=172.27.0.5`, um `curl` rodado **no host** da VPS chega como loopback e leva
`403`. Não é defeito — é a lista funcionando. Para chamar a API "como o bot", use o `docker exec`
acima, que sai de dentro do container.

## Rollback

- **Bot:** apagar as três variáveis e reiniciar. Os comandos voltam a responder "não configurado"; o
  resto do bot não é afetado. Não perde dado.
- **API:** os `.down.sql`, da cabeça para trás. `0011` → `0010` → `0009`. **Isto apaga as sugestões
  gravadas** — se já houver sugestão real, faça dump antes.
- **Parcial:** derrubar só o bot e deixar a API de pé é seguro e é o rollback preferido. O inverso
  não é: bot vivo com a API fora devolve erro em toda interação de staff.
