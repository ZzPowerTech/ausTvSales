#!/usr/bin/env bash
#
# Auditoria de exposicao de rede da maquina do game (jogar.austv.net).
# Historia S6.2b — issue #107.
#
# RODAR NA MAQUINA DO GAME, como root ou com sudo:
#   sudo bash ops/audit/game-listen-and-firewall.sh > exposure-$(date +%F).txt
#
# So le. Nao altera regra de firewall, nao reinicia servico, nao toca em banco.
#
# METODO: este script responde "em qual interface cada servico escuta" e "qual
# regra de firewall vale", que sao fatos locais e autoritativos. Ele NAO tenta
# responder "a porta responde de fora" — sondagem rodada na propria maquina e
# loopback e nao vale como evidencia. Essa metade da pergunta e respondida pelo
# plan-whitelist-bypass.sh, rodado a partir da VPS.
#
set -uo pipefail

PORTS='3306|25504|25505'

hr() { printf '\n%s\n' '-------------------------------------------------------------'; }
sec() { hr; printf '## %s\n\n' "$1"; }

printf 'Auditoria de exposicao — maquina do game\n'
printf 'data: %s\n' "$(date -Is)"
printf 'host: %s\n' "$(hostname)"
printf 'kernel: %s\n' "$(uname -sr)"

# ---------------------------------------------------------------------------
# 1. Interface de escuta de cada servico
# ---------------------------------------------------------------------------
sec "1. Interface de escuta (ss -tlnp)"
cat <<'EOF'
Como ler a coluna Local Address:Port
  0.0.0.0:3306   -> escuta em TODAS as interfaces IPv4, inclusive a publica
  [::]:3306      -> idem, IPv6
  127.0.0.1:3306 -> so loopback; inalcancavel de fora por definicao
  198.x.x.x:3306 -> so naquele IP

Estado registrado em 2026-08-21 (spec 10b): mariadbd em 0.0.0.0:3306.

EOF
if command -v ss >/dev/null 2>&1; then
  printf '%s\n' "$(ss -tlnp 2>/dev/null | head -1)"
  ss -tlnp 2>/dev/null | grep -E ":($PORTS)\b" || printf '(nenhuma das portas %s esta escutando)\n' "$PORTS"
  sec "1b. Todas as portas em escuta (contexto)"
  ss -tlnp 2>/dev/null
else
  printf 'ss AUSENTE — fallback para netstat\n\n'
  netstat -tlnp 2>/dev/null | grep -E ":($PORTS)\b" || printf '(sem match)\n'
fi

# ---------------------------------------------------------------------------
# 2. Regra efetiva de firewall
# ---------------------------------------------------------------------------
sec "2. Firewall — regra efetiva"
cat <<'EOF'
ATENCAO: "ufw inactive" nao significa "sem firewall" — significa que o ufw nao
esta gerenciando nada. Pode haver regra em iptables/nftables por baixo, ou
filtragem no provedor, invisivel daqui. Por isso os tres sao consultados.

Estado registrado em 2026-08-21 (spec 10b): ufw INATIVO.

EOF
printf '### ufw status verbose\n'
if command -v ufw >/dev/null 2>&1; then ufw status verbose 2>&1; else printf '(ufw nao instalado)\n'; fi

printf '\n### iptables -S\n'
if command -v iptables >/dev/null 2>&1; then iptables -S 2>&1; else printf '(iptables nao instalado)\n'; fi

printf '\n### nft list ruleset\n'
if command -v nft >/dev/null 2>&1; then nft list ruleset 2>&1 | head -60; else printf '(nftables nao instalado)\n'; fi

# ---------------------------------------------------------------------------
# 3. Quem pode conectar no MySQL — a conta, nao a porta
# ---------------------------------------------------------------------------
sec "3. MySQL — hosts aceitos por conta"
cat <<'EOF'
Fechar a porta e uma camada; a outra e a conta. Uma conta '%' aceita conexao de
qualquer host, entao ela so esta protegida enquanto a rede estiver.

Estado registrado em 2026-08-21 (spec 10b): conta u1_..@% existente.

Este bloco NAO recebe senha por argumento (ficaria no histórico do shell e em
`ps`). Rode a mao, com o cliente pedindo a senha:

  mysql -u root -p -e "SELECT user, host, plugin FROM mysql.user ORDER BY user, host;"

E, para o usuario do ETL (S9.1), confira que ele e read-only e restrito ao IP
da VPS:

  mysql -u root -p -e "SHOW GRANTS FOR 'austv_etl_ro'@'<IP_DA_VPS>';"

Esperado: apenas SELECT, apenas nos schemas necessarios, host = IP da VPS.
NUNCA '%', NUNCA o mesmo usuario que os plugins usam.
EOF

# ---------------------------------------------------------------------------
# 4. Webserver do Plan
# ---------------------------------------------------------------------------
sec "4. Webserver do Plan — bind e whitelist"
cat <<'EOF'
O webserver do Plan NAO pode ir para 127.0.0.1: o NestJS na VPS precisa
alcancar /v1/* pela rede (ADR-002). O alvo sao DUAS camadas, ambas restritas
ao IP da VPS:

  a) firewall liberando a porta 25504 so para o IP da VPS
  b) whitelist de IP do proprio Plan, tambem so com o IP da VPS

A camada (b) e filtro de APLICACAO e nao substitui a (a): ela cobre apenas a
25504 e nao tem efeito nenhum sobre a 3306.

Se a whitelist do Plan for contornavel por X-Forwarded-For, a camada (b) vale
zero e so a (a) protege. Isso e o que o plan-whitelist-bypass.sh mede — e ele
roda DA VPS, nao daqui.
EOF

printf '\n### config do Plan (grep de bind/whitelist, sem despejar segredo)\n'
PLAN_CFG=$(find / -maxdepth 8 -path /proc -prune -o -name 'config.yml' -path '*Plan*' -print 2>/dev/null | head -5)
if [ -n "$PLAN_CFG" ]; then
  for f in $PLAN_CFG; do
    printf '\n--- %s ---\n' "$f"
    grep -inE 'internal_ip|ip:|port|whitelist|allowed|proxy|forwarded' "$f" 2>/dev/null | grep -viE 'pass|senha|secret|token|key' || true
  done
else
  printf '(config.yml do Plan nao localizado automaticamente — apontar a mao)\n'
fi

hr
cat <<'EOF'
## Proximo passo

1. Cole esta saida em ops/audit/exposure-report-<data>.md (a partir do template).
2. Rode o plan-whitelist-bypass.sh A PARTIR DA VPS e cole o resultado no mesmo
   relatorio. Sem essa metade, a pergunta "responde de fora?" segue sem resposta.
3. Nenhuma credencial vai para o relatorio versionado. Se algum grep acima
   tiver capturado valor sensivel, apague antes de commitar.
EOF
