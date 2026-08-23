# Runbook — unificar os bancos do Plan num único MySQL

> História [S6.2](https://github.com/ZzPowerTech/ausTvSales/issues/108) · Sprint `AusTV Admin S6`
> Referência: [ADR-005](../../.specs/features/austv-admin/spec.md) · **Não-cortável** · **Antes do unban**
>
> **Janela de manutenção obrigatória.** Reinicia Paper e Velocity. Fora de pico, anunciada.

## Por que isto é pré-requisito, e não melhoria

Sem banco único não existe visão de rede, identidade unificada de jogador nem tempo por servidor.
Sem isso não há como cruzar **quem conecta na rede** com **quem chega ao survival** — que é
exatamente o degrau onde se descobriu que **54% dos jogadores se perdem**, e que a S8.1 vai medir
continuamente.

Também é o que destrava a S6.3: não dá para vigiar coleta em instâncias que gravam em bancos
separados.

**Contexto que dá urgência:** o Plan do proxy ficou morto de **maio a agosto/2026** sem ninguém
notar, e antes disso a instalação de produção rodava em **SQLite** enquanto o MySQL que se
consultava estava pela metade.

---

## ⚠️ Divergência de critérios — resolvida antes de executar

Os critérios de aceite da S6.2 e os da S6.2b/§8 do spec **se contradizem** em dois pontos. Seguir a
S6.2 ao pé da letra quebraria a S7.2 em silêncio. A resolução adotada aqui segue a **§8 do spec**,
que é o lado que explica o porquê e do qual a S7.2, a S8 e a S12 dependem.

| # | S6.2 diz | §8 do spec / S6.2b dizem | resolução adotada |
|---|---|---|---|
| 1 | webserver do Plan em `127.0.0.1` | **não pode** ser `127.0.0.1` — o NestJS na VPS precisa de `/v1/*` pela rede | **bind na interface alcançável**, com acesso restrito por **duas camadas**: firewall + whitelist de IP do Plan, ambas só com o IP da VPS |
| 2 | varredura externa confirma que a porta do Plan **não responde** | a porta precisa responder **à VPS** | varredura de um host **que não é a VPS** → não responde · da **VPS** → responde |

**Se o dono preferir `127.0.0.1`**, é uma decisão válida, mas então o ADR-002 precisa mudar junto: o
NestJS deixaria de alcançar `/v1/*` e seria necessário um túnel SSH permanente ou um proxy reverso
no game. Isso é escopo novo, não detalhe de execução. **Decidir antes de rodar o passo 5.**

O item "webserver **só no proxy**" não conflita e continua valendo: uma única instância de webserver,
no proxy.

---

## Pré-condições

- [ ] Janela anunciada aos jogadores, fora de pico
- [ ] Acesso root à máquina do game
- [ ] Espaço em disco ≥ 3× o tamanho somado dos dois bancos
- [ ] Destino **fora da VPS** para guardar os dumps (exigência do DoD)
- [ ] [Auditoria de exposição](../audit/README.md) da S6.2b executada — você vai precisar do IP da
      VPS e do estado atual do firewall

## Inventário — preencher antes de começar

| item | proxy (AusTv / Velocity) | backend (Survival / Paper) |
|---|---|---|
| versão/build do Plan | (registrado: 5.6 b2959) | (registrado: 5.6 b2965) |
| tipo de banco atual | | |
| host:porta do MySQL | | |
| nome do schema | | |
| caminho do `config.yml` | | |
| `ServerInfoFile.yml` (uuid) | | |

---

## Passo 1 — Dump dos dois bancos, **antes de qualquer alteração**

> Dump não verificado **não é backup**. O passo 2 existe por isso.

```bash
STAMP=$(date +%F-%H%M)
mkdir -p /root/plan-backup-$STAMP && cd /root/plan-backup-$STAMP
```

```bash
mysqldump --single-transaction --routines --triggers --events \
  -u root -p <schema_do_proxy> | gzip > proxy-$STAMP.sql.gz
```

```bash
mysqldump --single-transaction --routines --triggers --events \
  -u root -p <schema_do_backend> | gzip > backend-$STAMP.sql.gz
```

Se alguma instância estiver em **SQLite** (já aconteceu nesta produção), o "banco" é o arquivo
`.db`/`.sqlite` dentro da pasta do plugin — copie o arquivo inteiro com o servidor **parado**.

```bash
sha256sum *.gz > SHA256SUMS && cat SHA256SUMS
```

## Passo 2 — Testar o restore (não pular)

Restaurar num schema descartável, na **mesma** instância, e conferir que as tabelas voltam:

```bash
mysql -u root -p -e "CREATE DATABASE restore_test_$STAMP;"
```

```bash
gunzip -c proxy-$STAMP.sql.gz | mysql -u root -p restore_test_$STAMP
```

```bash
mysql -u root -p -e "SELECT COUNT(*) AS servers FROM restore_test_$STAMP.plan_servers; \
                     SELECT COUNT(*) AS users FROM restore_test_$STAMP.plan_users;"
```

- [ ] contagens batem com o banco de origem
- [ ] repetir para o dump do backend
- [ ] `DROP DATABASE restore_test_$STAMP;` depois de conferir

## Passo 3 — Copiar os dumps para fora da VPS

Exigência do DoD. Backup que mora na máquina que pode morrer não é backup.

```bash
scp /root/plan-backup-$STAMP/*.gz /root/plan-backup-$STAMP/SHA256SUMS <destino-externo>:
```

- [ ] `sha256sum -c SHA256SUMS` **no destino**, não na origem

## Passo 4 — Igualar a build do Plan, **antes** de unificar

> É o risco de maior impacto da sprint, e ele se materializa **em silêncio**: builds diferentes
> compartilhando banco corrompem schema. Igualar depois não desfaz a corrupção.

1. Escolher a build alvo — **a mais nova entre as instâncias** (b2965)
2. Parar as duas instâncias
3. Substituir o JAR do Plan em ambas pela mesma build
4. Subir **uma de cada vez** e conferir no log que carregou sem erro de migration

- [ ] `/plan info` em cada instância reporta a **mesma** versão e build

## Passo 5 — Repontar o proxy para o MySQL único

Antes: reler a divergência lá em cima e confirmar a decisão sobre o bind.

No `config.yml` do **proxy**, na seção de banco:

```yaml
Database:
  Type: MySQL
  MySQL:
    Host: <host_do_mysql_unico>
    Port: 3306
    Database: <schema_unico>
    User: <usuario_do_plan>
    # senha fora do repo, nunca versionada
```

No `config.yml` do **backend**: apontar para o **mesmo** host/porta/schema.

Webserver — **só no proxy**:

- [ ] webserver **desabilitado** na instância do backend
- [ ] webserver habilitado **apenas** no proxy
- [ ] bind na interface alcançável pela VPS (**não** `127.0.0.1` — ver divergência)
- [ ] autenticação do Plan **ligada**
- [ ] whitelist de IP do Plan contendo **só** o IP da VPS
- [ ] regra de firewall liberando a porta do Plan **só** para o IP da VPS

## Passo 6 — `ServerInfoFile.yml` não se copia

> Ele carrega o **UUID da instância**. Copiado entre servidores, duas instâncias reivindicam a mesma
> identidade e o `plan_servers` passa a mentir — que é justamente o dado que a S6.3 vigia.

- [ ] cada instância manteve **o seu** `ServerInfoFile.yml`
- [ ] nenhum arquivo foi copiado entre pastas de servidores diferentes

## Passo 7 — Reload e verificação

```
/plan reload
```

em **todas** as instâncias. Depois, no MySQL único:

```sql
SELECT id, uuid, name, web_address, proxy FROM plan_servers ORDER BY id;
```

- [ ] proxy **e** backends aparecem, no **mesmo** banco
- [ ] cada linha com UUID **distinto**
- [ ] sessão nova aparece em `plan_sessions` depois de entrar no jogo de propósito
- [ ] `plan_users.registered` recebe registro novo ao entrar com conta nunca vista

## Passo 8 — Preservar o banco antigo do proxy como somente leitura

```sql
-- Nenhum usuario da aplicacao escreve aqui a partir de agora.
REVOKE INSERT, UPDATE, DELETE, CREATE, DROP, ALTER
  ON `<schema_antigo_do_proxy>`.* FROM '<usuario_do_plan>'@'<host>';
FLUSH PRIVILEGES;
```

- [ ] schema antigo renomeado ou marcado como arquivo (ex.: `plan_proxy_archive_2026_08`)
- [ ] documentado **onde** ele está e **por que** foi preservado
- [ ] nenhuma instância aponta mais para ele

## Passo 9 — Varredura externa

Ler junto com a divergência do topo — o alvo **não** é "não responde a ninguém":

| de onde | porta do Plan | esperado |
|---|---|---|
| host que **não** é a VPS | | **não responde** |
| **VPS** (`sales.austv.net`) | | **responde** |

Usar o [`plan-whitelist-bypass.sh`](../audit/plan-whitelist-bypass.sh) a partir da VPS. Ele já
verifica o controle antes de confiar no resultado.

- [ ] resultado anexado ao PR / ao relatório de exposição

---

## Rollback

O ponto de não-retorno é o **passo 5**. Até o passo 4 tudo é reversível trocando o JAR de volta.

**Se algo quebrar depois do passo 5:**

1. Parar todas as instâncias do Plan
2. Restaurar `config.yml` de cada instância a partir da cópia (fazer a cópia **antes** do passo 5)
3. Reconceder escrita no schema antigo do proxy (desfazer o passo 8)
4. Restaurar os dumps do passo 1 nos schemas originais:
   ```bash
   gunzip -c proxy-$STAMP.sql.gz | mysql -u root -p <schema_do_proxy>
   ```
5. Voltar o JAR da build original em cada instância, se o passo 4 for suspeito
6. Subir uma instância de cada vez, conferindo o log

**Perda esperada no rollback:** as sessões gravadas entre o passo 5 e o rollback. Com a janela fora
de pico e anunciada, é da ordem de minutos de dado.

**O que torna o rollback confiável:** o dump do passo 1 com restore **testado** no passo 2. Sem o
passo 2, este procedimento é uma esperança, não um plano.

---

## Riscos

| risco | mitigação |
|---|---|
| Builds diferentes corrompendo schema | igualar versão **antes** de unificar (passo 4); dump antes (passo 1) |
| Dump não restaurável | passo 2 é obrigatório; `sha256sum -c` no destino |
| Reinício do Paper/Velocity com jogadores online | janela fora de pico, anunciada |
| `ServerInfoFile.yml` copiado | passo 6; sintoma é `plan_servers` com UUID repetido |
| Unban chegando antes da sprint fechar | S6.2 e S6.3 não são cortáveis; se apertar, a sprint roda estendida |
| Bind em `127.0.0.1` por seguir a S6.2 literalmente | divergência resolvida no topo — quebraria a S7.2 em silêncio |

## Definition of Done

- [ ] `plan_servers` mostra proxy e backends num único banco, mesma build
- [ ] Dump restaurável dos dois bancos guardado **fora da VPS**, com checksum conferido no destino
- [ ] Banco antigo do proxy preservado como somente leitura e documentado
- [ ] Varredura externa conforme a tabela do passo 9
- [ ] Divergência do bind decidida e registrada
