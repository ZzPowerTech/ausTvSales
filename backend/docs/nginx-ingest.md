# Nginx — borda do ingest (plugin → API)

> Trecho de referência da configuração do Nginx para as rotas de **ingest** (`POST /sales`,
> `GET /items/sync`). Deriva do [ADR-0001](../../.specs/decisions/ADR-0001-auth-plugin-api.md).
> Este arquivo é **documentação versionada** — o Nginx roda na VPS (repo de infra/deploy); use
> este trecho como fonte da verdade do que precisa estar aplicado lá.

## Objetivo

A comunicação plugin→API tem **defesa em camadas** (ADR-0001). A **allowlist de IP** garante que a
API key **sozinha não basta**: mesmo com a chave, uma chamada de fora do IP da VPS do jogo é
recusada. Esta é a enforcement de **borda**; o backend repete a allowlist no app
(`IngestIpAllowlistGuard`) como segunda linha, caso este trecho falte ou esteja errado.

## Trecho de referência

```nginx
# Rotas de ingest do plugin (austv-sales). Ajuste o prefixo se a API sobe sob /api.
location ~ ^/(sales|items/sync)$ {
    # 1) Allowlist de IP: so a VPS do jogo alcanca o ingest. Contem o estrago se a key vazar.
    allow 203.0.113.10;      # <-- IP FIXO da VPS do servidor de jogo (ajustar)
    deny all;

    # 2) Rate limiting na borda (ponto de partida ADR: ~10 req/s, burst pequeno).
    #    Requer, no bloco http{}:  limit_req_zone $binary_remote_addr zone=ingest:10m rate=10r/s;
    limit_req zone=ingest burst=20 nodelay;

    # 3) Repasse ao container do backend. O X-Forwarded-For setado AQUI e a fonte confiavel
    #    do req.ip no app (que fixa `trust proxy` no hop do Nginx via TRUST_PROXY).
    proxy_pass http://127.0.0.1:3000;   # <-- ajustar host:porta do container do backend
    proxy_set_header Host              $host;
    proxy_set_header X-Real-IP         $remote_addr;
    proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

## Coerência com o app (obrigatória)

Para a allowlist do app confiar no `req.ip`, o `TRUST_PROXY` do backend precisa **casar** com como
o Nginx alcança o container:

| Nginx → backend | `TRUST_PROXY` |
|---|---|
| `proxy_pass http://127.0.0.1:3000` (mesmo host) | `loopback` (default) |
| rede Docker (ex.: `172.18.0.0/16`) | o IP/subnet do Nginx na rede, ex.: `172.18.0.0/16` |
| um hop de proxy conhecido | `1` (conta de hops) |

E o `INGEST_ALLOWED_IPS` do backend deve conter **o mesmo IP** que o `allow` do Nginx (o IP público
da VPS do jogo). Se as duas camadas divergirem, o app pode recusar (`403`) tráfego legítimo — por
isso o teste de go-live (S6.3 / runbook de resiliência, Fase 1) confere que uma venda real chega.

## Checklist de deploy / go-live (S6.3)

- [ ] `allow <ip da VPS do jogo>; deny all;` aplicado no `location` do ingest.
- [ ] `limit_req_zone` declarado no `http{}` e `limit_req` no `location`.
- [ ] `X-Forwarded-For` repassado pelo Nginx.
- [ ] `INGEST_ALLOWED_IPS` (backend) = IP público da VPS do jogo.
- [ ] `TRUST_PROXY` (backend) coerente com o caminho Nginx→container.
- [ ] Teste: venda real do servidor de jogo chega em `sales`; venda forjada de outro IP → recusada.
