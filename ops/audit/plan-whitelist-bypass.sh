#!/usr/bin/env bash
#
# Alcancabilidade externa + teste de contorno da whitelist do Plan.
# Historia S6.2b — issue #107.
#
# RODAR A PARTIR DA VPS (sales.austv.net), nunca da maquina do game:
#   bash ops/audit/plan-whitelist-bypass.sh > bypass-$(date +%F).txt
#
# A VPS e o ponto de vista certo por dois motivos: e externa a maquina do game
# (entao nao e loopback) e e a origem real do ETL (ADR-007/008). O que importa
# nao e "a porta responde de algum lugar", e "responde de quem vai usar".
#
# So le. Nao autentica, nao envia credencial, nao explora nada: mede codigo HTTP
# e handshake TCP.
#
set -uo pipefail

GAME_HOST="${GAME_HOST:-jogar.austv.net}"
PLAN_PORT="${PLAN_PORT:-25504}"
MYSQL_PORT="${MYSQL_PORT:-3306}"
# IP arbitrario, nao roteavel, usado so como valor de header. Nao precisa existir.
SPOOF_IP="${SPOOF_IP:-203.0.113.7}"
# Porta que deve estar fechada — e o CONTROLE do teste (ver bloco 0).
CONTROL_PORT="${CONTROL_PORT:-45999}"
TIMEOUT="${TIMEOUT:-5}"

hr() { printf '\n%s\n' '-------------------------------------------------------------'; }
sec() { hr; printf '## %s\n\n' "$1"; }

printf 'Teste de alcancabilidade e contorno de whitelist\n'
printf 'data:   %s\n' "$(date -Is)"
printf 'origem: %s (%s)\n' "$(hostname)" "$(curl -s --max-time "$TIMEOUT" https://api.ipify.org 2>/dev/null || echo 'IP publico nao resolvido')"
printf 'alvo:   %s\n' "$GAME_HOST"

# tcp_probe <porta> -> imprime ABERTA/FECHADA/TIMEOUT
tcp_probe() {
  local port="$1"
  if timeout "$TIMEOUT" bash -c "exec 3<>/dev/tcp/$GAME_HOST/$port" 2>/dev/null; then
    printf 'ABERTA'
  else
    printf 'FECHADA_OU_FILTRADA'
  fi
}

# ---------------------------------------------------------------------------
# 0. CONTROLE — antes de confiar em qualquer resultado
# ---------------------------------------------------------------------------
sec "0. Controle do teste"
cat <<EOF
Regra que emergiu desta investigacao: verificar o controle ANTES de confiar no
teste. Ja se descartou um nmap porque o controle falhou, e um "porta fechada"
que era o comando nao existir no CMD.

O controle aqui e uma porta que ninguem usa ($CONTROL_PORT). Se ela aparecer
como ABERTA, o metodo esta quebrado — provavelmente ha um proxy ou middlebox
respondendo por tudo — e NENHUM resultado abaixo vale.
EOF
CONTROL_RESULT="$(tcp_probe "$CONTROL_PORT")"
printf '\nporta de controle %s: %s\n' "$CONTROL_PORT" "$CONTROL_RESULT"
if [ "$CONTROL_RESULT" = "ABERTA" ]; then
  printf '\n*** CONTROLE FALHOU — pare aqui. O resto desta saida nao e evidencia. ***\n'
else
  printf 'controle OK: porta nao usada aparece fechada, o metodo distingue os dois estados.\n'
fi

# ---------------------------------------------------------------------------
# 1. Alcancabilidade das portas que o ETL vai atravessar
# ---------------------------------------------------------------------------
sec "1. Alcancabilidade a partir da VPS"
printf 'MySQL   %s:%s -> %s\n' "$GAME_HOST" "$MYSQL_PORT" "$(tcp_probe "$MYSQL_PORT")"
printf 'Plan    %s:%s -> %s\n' "$GAME_HOST" "$PLAN_PORT"  "$(tcp_probe "$PLAN_PORT")"
cat <<'EOF'

Leitura:
  Plan ABERTA da VPS  -> necessario. O NestJS precisa de /v1/* pela rede.
  MySQL ABERTA da VPS -> necessario hoje para o ETL (ADR-007), e e exatamente
                         o ponto do risco aceito na 10b: a mesma porta responde
                         de rede residencial. "Aberta para a VPS" e o alvo;
                         "aberta para o mundo" e o estado registrado.
  Qualquer uma FECHADA -> o ETL para sem aviso. Se isso aparecer, a S6.2b
                         precisa ser reaberta (previsto na 10b do spec).
EOF

# ---------------------------------------------------------------------------
# 2. A whitelist do Plan e contornavel por header?
# ---------------------------------------------------------------------------
sec "2. Contorno da whitelist por X-Forwarded-For"

BASE_URL="http://$GAME_HOST:$PLAN_PORT"

# Devolve SO o codigo HTTP em stdout — nada mais.
#
# Separar isto da impressao e obrigatorio, nao estilo: se a funcao tambem
# imprimisse o rotulo, a captura por $(...) levaria o rotulo junto do codigo. Como
# os rotulos diferem entre as chamadas, TODA comparacao daria "diferente" e o
# veredito sairia CONTORNAVEL em qualquer cenario, inclusive num Plan que ignora
# o header por completo.
http_code() { # http_code [args extras do curl...]
  local code
  # Em falha de conexao o proprio curl ja imprime 000 e sai != 0; o `|| true`
  # impede que um `|| echo 000` concatene um segundo 000 e produza "000000".
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time "$TIMEOUT" "$@" "$BASE_URL/" 2>/dev/null) || true
  printf '%s' "${code:-000}"
}

report() { printf '%-46s -> HTTP %s\n' "$1" "$2"; }

CODE_PLAIN=$(http_code)
report "sem header (controle)" "$CODE_PLAIN"

CODE_XFF=$(http_code -H "X-Forwarded-For: $SPOOF_IP")
report "X-Forwarded-For: $SPOOF_IP" "$CODE_XFF"

CODE_XREAL=$(http_code -H "X-Real-IP: $SPOOF_IP")
report "X-Real-IP: $SPOOF_IP" "$CODE_XREAL"

CODE_XFF_CHAIN=$(http_code -H "X-Forwarded-For: $SPOOF_IP, 127.0.0.1")
report "X-Forwarded-For: $SPOOF_IP, 127.0.0.1" "$CODE_XFF_CHAIN"

hr
cat <<'EOF'
### Como interpretar — e uma correcao ao spec

X-Forwarded-For e um header que QUALQUER cliente escreve. Ele so pode ser
confiado depois de um proxy reverso que o reescreva.

  codigos DIFERENTES com e sem o header
    -> o header influenciou a decisao de acesso
    -> quem controla o header controla o acesso
    -> WHITELIST CONTORNAVEL  (a camada de aplicacao vale zero)

  codigos IGUAIS com e sem o header
    -> o Plan ignorou o header
    -> WHITELIST SOLIDA quanto a este vetor

*** DIVERGENCIA REGISTRADA ***
A secao 11.3b1 do spec diz o inverso: "codigo HTTP diferente = whitelist
solida, igual = contornavel". Isso esta invertido, e aplicar a frase ao pe da
letra leva a conclusao de seguranca exatamente oposta a correta.
Este script implementa a semantica correta acima. A frase do spec precisa ser
corrigida — nao mudei o spec por conta propria.
EOF

hr
printf 'VEREDITO\n\n'
printf '  sem header       : HTTP %s\n' "$CODE_PLAIN"
printf '  com XFF          : HTTP %s\n' "$CODE_XFF"
printf '  com X-Real-IP    : HTTP %s\n' "$CODE_XREAL"
printf '  com XFF em cadeia: HTTP %s\n\n' "$CODE_XFF_CHAIN"

if [ "$CODE_PLAIN" = "000" ]; then
  printf '  INCONCLUSIVO — nem a requisicao sem header chegou (timeout/DNS/porta).\n'
  printf '  Resolver a alcancabilidade do bloco 1 antes de repetir.\n'
elif [ "$CODE_XFF" != "$CODE_PLAIN" ] || [ "$CODE_XREAL" != "$CODE_PLAIN" ] || [ "$CODE_XFF_CHAIN" != "$CODE_PLAIN" ]; then
  printf '  CONTORNAVEL — um header controlado pelo cliente mudou a resposta.\n'
  printf '  A whitelist do Plan nao conta como camada. Restam apenas as regras\n'
  printf '  de firewall, e o alvo de "duas camadas" da S6.2b nao foi atingido.\n'
else
  printf '  SOLIDA quanto a este vetor — nenhum dos headers mudou a resposta.\n'
  printf '  Continua valendo que ela cobre so a %s e nao tem efeito na %s.\n' "$PLAN_PORT" "$MYSQL_PORT"
fi

hr
printf 'Colar esta saida em ops/audit/exposure-report-<data>.md.\n'
