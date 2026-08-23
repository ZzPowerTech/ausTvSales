# Auditoria de exposição de rede — runbook

> História [S6.2b](https://github.com/ZzPowerTech/ausTvSales/issues/107) · Sprint `AusTV Admin S6`
> Referência: [§8 e §10b do spec](../../.specs/features/austv-admin/spec.md)

## Por que isto é assunto do projeto

Duas máquinas: a **VPS** (`sales.austv.net`, hospeda o `ausTvSales`) e a máquina do **game**
(`jogar.austv.net`, produção do Minecraft). O ETL noturno da S9.1 e o client `/v1/*` da S7.2
atravessam de uma para a outra.

É essa travessia que torna a exposição um assunto do projeto e não apenas de infraestrutura: se a
rota fecha, **o ETL para sem aviso**.

## O método, e por que sondagem de porta sozinha não serve

Teste rodado **na própria máquina do game é loopback** e não responde à pergunta. Nesta
investigação já se descartou um `nmap` porque o controle falhou, e um "porta fechada" que era o
comando não existir no CMD.

Daí a divisão em dois scripts, com pontos de vista diferentes:

| script | onde roda | responde |
|---|---|---|
| `game-listen-and-firewall.sh` | **na máquina do game** | em qual interface cada serviço escuta e qual regra de firewall vale — fatos locais e autoritativos |
| `plan-whitelist-bypass.sh` | **na VPS** | a porta responde de quem vai usar, e a whitelist do Plan é contornável por header |

Nenhum dos dois altera nada: `ss`, `ufw status`, `iptables -S`, handshake TCP e código HTTP. Sem
autenticação, sem credencial, sem exploração.

## Ordem de execução

```bash
# 1) na máquina do game, como root
sudo bash ops/audit/game-listen-and-firewall.sh > exposure-$(date +%F).txt
```

```bash
# 2) na VPS (sales.austv.net) — nunca na máquina do game
bash ops/audit/plan-whitelist-bypass.sh > bypass-$(date +%F).txt
```

3. Copiar `exposure-report-TEMPLATE.md` para `exposure-report-<AAAA-MM-DD>.md`, colar as duas
   saídas e preencher os vereditos.
4. Commitar **o relatório**, nunca as saídas cruas sem revisar — o `grep` de config do Plan pode
   ter capturado valor sensível.

O `plan-whitelist-bypass.sh` aceita override por variável de ambiente:
`GAME_HOST`, `PLAN_PORT`, `MYSQL_PORT`, `SPOOF_IP`, `CONTROL_PORT`, `TIMEOUT`.

## O controle vem antes do resultado

O `plan-whitelist-bypass.sh` começa sondando uma porta que ninguém usa. Se ela aparecer **aberta**,
o método está quebrado — há middlebox respondendo por tudo — e nenhum resultado daquela execução é
evidência. O script diz isso na saída e o template tem a caixa correspondente.

Isto não é zelo: é a regra que emergiu desta investigação depois de duas conclusões descartadas por
controle não verificado.

## A divergência do spec sobre `X-Forwarded-For`

A [§11.3b1 do spec](../../.specs/features/austv-admin/spec.md) diz:

> "código HTTP diferente = whitelist sólida, igual = contornável"

**Está invertido.** `X-Forwarded-For` é escrito por qualquer cliente e só pode ser confiado depois
de um proxy reverso que o reescreva. Portanto:

| observação | significado |
|---|---|
| códigos **diferentes** com e sem o header | o header influenciou a decisão → quem controla o header controla o acesso → **CONTORNÁVEL** |
| códigos **iguais** com e sem o header | o Plan ignorou o header → **SÓLIDA** quanto a este vetor |

Os scripts implementam a semântica correta e imprimem a divergência na própria saída. **O spec não
foi alterado por conta própria** — a frase precisa ser corrigida numa mudança à parte, decidida pelo
dono.

Aplicar a frase do spec ao pé da letra levaria à conclusão de segurança exatamente oposta à correta,
que é o tipo de erro que fica anos sem ser notado.

## O estado alvo

| item | alvo |
|---|---|
| MySQL (3306) | alcançável **apenas** pelo IP da VPS — allowlist de firewall ou túnel SSH |
| Webserver do Plan (25504) | alcançável **apenas** pelo IP da VPS, em **duas** camadas: firewall **e** whitelist de IP do Plan |
| bind do webserver do Plan | **não** pode ir para `127.0.0.1` — o NestJS na VPS precisa dele pela rede (ADR-002) |
| usuário do ETL | **read-only** dedicado, host = IP da VPS, nunca `%`, nunca o usuário dos plugins |
| credenciais | nenhuma nova em arquivo versionado |

Filtro de aplicação nunca substitui filtro de rede: a whitelist do Plan cobre a 25504 e **não tem
efeito nenhum sobre a 3306**.

## O risco já aceito — não relitigar aqui

A [§10b do spec](../../.specs/features/austv-admin/spec.md) registra o estado verificado em
2026-08-21: `mariadbd` em `0.0.0.0:3306`, `ufw` **inativo**, conta MySQL `@%`, credenciais em texto
plano em quatro configs de plugin, e a porta 3306 respondendo de **três pontos independentes** —
inclusive rede residencial, que completou handshake TCP.

**O dono decidiu tratar como responsabilidade da MagnoHost.** Essa decisão está registrada e não se
reabre nesta issue.

Esta auditoria existe por outro motivo: produzir o registro técnico do estado atual, porque o ETL
vai assumir que essa rede é alcançável. Se a MagnoHost restringir por IP, a S6.2b precisa ser
reaberta — e é a comparação entre dois relatórios datados que vai mostrar isso.

Reabrir a §10b apenas se: houver incidente no banco, a MagnoHost confirmar por escrito o que
filtra, ou o allowlist mudar.

## Criar o usuário read-only do ETL

Rodar a mão na máquina do game, com senha forte gerada na hora e guardada **fora do repo** (o ETL
lê de variável de ambiente, ADR-008):

```sql
-- <IP_DA_VPS> literal, nunca '%'. Um usuário por fonte, nunca o dos plugins.
CREATE USER 'austv_etl_ro'@'<IP_DA_VPS>' IDENTIFIED BY '<senha-gerada-na-hora>';

-- Apenas leitura, apenas no schema necessário.
GRANT SELECT ON `<schema_playerpoints>`.`playerpoints_transaction_log`
  TO 'austv_etl_ro'@'<IP_DA_VPS>';

FLUSH PRIVILEGES;
```

Conferir depois — e é este resultado, com o usuário mascarado e **sem senha**, que vai para o
relatório:

```sql
SHOW GRANTS FOR 'austv_etl_ro'@'<IP_DA_VPS>';
```

Esperado: só `SELECT`, só nos schemas necessários, host igual ao IP da VPS.

> A tabela `playerpoints_transaction_log` **não tem índice nenhum** (ADR-007). Qualquer agregação
> nela é *full table scan* no MySQL do servidor de jogo — por isso o ETL é noturno e fora do pico, e
> por isso nada de analítico roda ao vivo lá.
