# ADR-0001 — Autenticação plugin→API (API key vs mTLS)

- **Status:** Aceito (aprovado pelo Murilo em 2026-07-16)
- **Data:** 2026-07-16
- **História:** S1.3 (spike) — issue #7
- **Responsáveis:** `devops-specialist` + `cybersecurity-validator`
- **Bloqueia:** Sprint 2 (S2.1 implementa o mecanismo decidido aqui)

## Contexto

O plugin roda na **VPS do servidor de jogo** e precisa enviar cada venda para a
API em `sales.austv.net` (VPS separada, atrás de Nginx). O endpoint de ingest de
vendas fica exposto na internet, então é **superfície de ataque**: sem
autenticação, qualquer um poderia forjar vendas para inflar métricas/receita
(spec §7). A comunicação plugin→API **precisa** de autenticação forte + rate
limiting — bloqueante, validado pelo `cybersecurity-validator` antes de qualquer
merge que exponha o endpoint (S2.1).

Duas opções na mesa:

1. **API key** — segredo compartilhado enviado num header HTTP; a API compara com
   o valor esperado (via env/secret).
2. **mTLS** — o plugin apresenta um certificado cliente; o Nginx valida contra
   uma CA própria (`ssl_verify_client on`).

Ambos rodam sobre HTTPS (confidencialidade garantida pelo TLS do Nginx em
qualquer caso). A escolha é sobre **como o cliente prova identidade**.

## Comparação

| Critério | API key + IP allowlist | mTLS |
|---|---|---|
| **Rotação** | Gerar nova key e trocar env nas duas pontas; suporta janela de dupla-chave sem downtime | Reemitir certificado cliente, distribuir e recarregar Nginx; gerir validade/expiração da CA |
| **Gestão na máquina do jogo** | 1 valor no `config.yml` do plugin | Keystore/PEM do certificado + chave privada no servidor de jogo, com permissões restritas |
| **Suporte no Nginx** | Trivial: repassa o header + `allow/deny` por IP | `ssl_verify_client` + `ssl_client_certificate` (CA); mais peças para manter |
| **Complexidade do plugin (Java/Paper)** | Header simples no `HttpClient` | Configurar `SSLContext`/keystore no cliente HTTP |
| **Reversibilidade** | Alta — é o caminho apontado na nota de risco do Sprint 1 | Menor — migrar depois exige tocar CA + clientes |
| **Força** | Boa quando combinada com IP allowlist + rate limiting + HTTPS | Mais forte (identidade criptográfica), mas com mais superfície operacional |

## Decisão

**API key no header, combinada com IP allowlist no Nginx e rate limiting**, como
mecanismo do MVP. **mTLS fica como evolução futura** caso a superfície de ataque
mude (ex.: múltiplos clientes, exigência de identidade criptográfica).

Racional: para **um único cliente conhecido** (a VPS do jogo, IP fixo), a API key
+ IP allowlist entrega segurança adequada com a menor fricção operacional e é o
caminho **reversível** já registrado como mitigação no Sprint 1. O ganho do mTLS
não compensa, neste momento, o custo de gerir CA e certificados na máquina do
jogo.

### Detalhes de implementação (para a S2.1)

- **Transporte do segredo:** header `X-Api-Key: <key>` (ou
  `Authorization: Bearer <key>`) sobre HTTPS. Guard NestJS **dedicado ao ingest**,
  separado do guard de sessão do dashboard (S1.4) — o plugin não tem sessão de
  usuário.
- **Onde a key vive:**
  - **API:** variável de ambiente/secret (ex.: `INGEST_API_KEY`), fora do
    repositório, como já é feito com os segredos de auth do dashboard.
  - **Plugin:** no `config.yml` do plugin, na pasta de dados do servidor de jogo
    (fora do repo), lido no `onEnable`. Nunca commitado.
- **Comparação constante:** validar a key com comparação de tempo constante
  (`crypto.timingSafeEqual`), como já feito no guard de sessão.
- **IP allowlist:** no Nginx, restringir o `location` do ingest ao IP da VPS do
  jogo (`allow <ip>; deny all;`). Contém o estrago mesmo se a key vazar.
- **Rate limiting:** `limit_req` no Nginx no location do ingest (ponto de partida:
  ~10 req/s com burst pequeno) **e/ou** `@nestjs/throttler` no endpoint →
  resposta **429** ao estourar. Camada dupla: o Nginx corta flood na borda, o
  throttler protege caso alguém fure o proxy. Números finais calibrados na S2.1
  com base no volume real de vendas.

### Rotação da key

1. Gerar nova key: `openssl rand -hex 32`.
2. Publicar a nova key na API aceitando **as duas** (antiga + nova) por uma janela
   curta (dupla-chave), para não perder vendas durante a troca.
3. Atualizar o `config.yml` do plugin com a nova key e recarregar/reiniciar o
   plugin.
4. Remover a key antiga da API após confirmar que o plugin já usa a nova.

### Resposta a vazamento

1. **Revogar** a key vazada na API imediatamente (remover do conjunto aceito).
2. Gerar e publicar uma nova key (passos de rotação acima).
3. Auditar logs de origem do ingest; a **IP allowlist** limita o estrago mesmo com
   a key vazada (chamadas de fora do IP da VPS do jogo já são recusadas pelo
   Nginx).
4. A **idempotência por `sale_id`** (constraint da S1.2) impede que reenvios/
   duplicatas — inclusive forjados — dupliquem linhas em `sales`.

## Consequências

- **Positivas:** implementação simples nas duas pontas, rotação sem downtime,
  caminho reversível. Defesa em profundidade (HTTPS + key + IP allowlist + rate
  limit + idempotência).
- **Negativas / trade-offs:** a key é um segredo compartilhado — se vazar e o
  atacante estiver no IP permitido, pode forjar vendas até a revogação; mitigado
  pela IP allowlist e pela rotação. mTLS daria identidade criptográfica mais
  forte, ao custo de gestão de certificados — adiado.
- **Follow-up:** S2.1 implementa o guard de ingest + rate limiting e registra a
  revisão do `cybersecurity-validator`; a re-validação final de segurança
  acontece na S6.3 (go-live).

## Alternativas consideradas

- **mTLS agora:** rejeitado para o MVP pelo custo operacional (CA + certificados
  na máquina do jogo) sem ganho proporcional para um único cliente de IP fixo.
  Reavaliar se surgirem múltiplos clientes ou requisito de identidade forte.
- **Sem IP allowlist (só API key):** rejeitado — a allowlist é defesa barata que
  reduz muito o impacto de um vazamento de key.
