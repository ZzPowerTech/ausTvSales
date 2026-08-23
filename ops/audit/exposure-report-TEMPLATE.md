# Relatório de exposição de rede — `<AAAA-MM-DD>`

> Copiar para `ops/audit/exposure-report-<AAAA-MM-DD>.md` e preencher.
> História [S6.2b](https://github.com/ZzPowerTech/ausTvSales/issues/107).
>
> **Nenhuma credencial neste arquivo.** Nem usuário, nem senha, nem hash, nem
> string de conexão. Se um `grep` capturou valor sensível, apague antes de commitar.

| campo | valor |
|---|---|
| data da coleta | |
| quem coletou | |
| máquina do game (host / IP) | |
| VPS de origem do ETL (host / IP público) | |
| versão do Plan por instância | |

---

## 0. Controle do teste

> Regra: verificar o controle **antes** de confiar no resultado. Nesta
> investigação já se descartou um `nmap` porque o controle falhou.

| item | resultado |
|---|---|
| porta de controle (não usada) aparece FECHADA? | ☐ sim ☐ não |

**Se "não": pare.** Nada abaixo é evidência — provavelmente há middlebox
respondendo por tudo. Registrar e refazer por outro caminho.

---

## 1. Interface de escuta — `ss -tlnp` na máquina do game

Saída bruta:

```
<colar aqui>
```

| porta | serviço | interface de escuta | leitura |
|---|---|---|---|
| 3306 | mariadbd | | `0.0.0.0` = todas as interfaces |
| 25504 | Plan webserver | | não pode ser `127.0.0.1` (o NestJS precisa pela rede) |
| 25505 | | | |

---

## 2. Regra efetiva de firewall

```
<colar ufw status verbose / iptables -S / nft list ruleset>
```

| porta | regra efetiva | restrita ao IP da VPS? |
|---|---|---|
| 3306 | | ☐ sim ☐ não |
| 25504 | | ☐ sim ☐ não |

> `ufw inactive` **não** é "sem firewall" — é "o ufw não gerencia nada". Conferir
> `iptables`/`nft` e considerar filtragem do provedor, invisível da máquina.

---

## 3. Alcançabilidade a partir da VPS

> Este é o ponto de vista que importa: externo à máquina do game **e** origem
> real do ETL. Teste rodado na própria máquina do game é loopback e não vale.

| porta | resultado da VPS | esperado |
|---|---|---|
| 3306 (MySQL) | ☐ aberta ☐ fechada | aberta **só** para este IP |
| 25504 (Plan) | ☐ aberta ☐ fechada | aberta **só** para este IP |

---

## 4. Contorno da whitelist do Plan por header

| requisição | HTTP |
|---|---|
| sem header (controle) | |
| `X-Forwarded-For: <IP arbitrário>` | |
| `X-Real-IP: <IP arbitrário>` | |
| `X-Forwarded-For` em cadeia | |

**Veredito:** ☐ CONTORNÁVEL ☐ SÓLIDA ☐ INCONCLUSIVO

> Códigos **diferentes** = o header controlado pelo cliente mudou a decisão =
> **contornável**. Códigos **iguais** = o Plan ignorou o header = **sólida**.
>
> A §11.3b1 do spec afirma o contrário; a frase do spec está invertida. Ver a
> divergência registrada em `plan-whitelist-bypass.sh`.

Se **contornável**: a camada de aplicação vale zero e só o firewall protege — o
alvo de "duas camadas" da S6.2b não foi atingido. Registrar como pendência.

---

## 5. Usuário read-only do ETL

| item | estado |
|---|---|
| usuário dedicado do ETL existe | ☐ sim ☐ não |
| é **separado** dos usuários dos plugins | ☐ sim ☐ não |
| host do grant é o IP da VPS (nunca `%`) | ☐ sim ☐ não |
| privilégios são **apenas** `SELECT` | ☐ sim ☐ não |
| escopo limitado aos schemas necessários | ☐ sim ☐ não |

`SHOW GRANTS` (com o nome do usuário mascarado, sem senha):

```
<colar aqui>
```

---

## 6. Conclusão

| pergunta | resposta |
|---|---|
| o ETL consegue atravessar hoje? | |
| a exposição está restrita ao IP da VPS? | |
| o que mudou desde o registro de 2026-08-21 (§10b)? | |
| alguma pendência nova? | |

### Sobre o risco já aceito

O estado de 2026-08-21 — `mariadbd` em `0.0.0.0:3306`, `ufw` inativo, conta
MySQL `@%`, credenciais em texto plano em quatro configs de plugin — foi
**aceito pelo dono como responsabilidade da MagnoHost** (§10b do spec).

Este relatório **não reabre esse debate**. Ele existe porque o ETL vai assumir
que essa rede é alcançável: se a MagnoHost restringir por IP no futuro, o ETL
para sem aviso, e é este documento que dirá o que mudou.

Reabrir a §10b apenas se: houver incidente no banco, a MagnoHost confirmar por
escrito o que filtra, ou o allowlist mudar.
