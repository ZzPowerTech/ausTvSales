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

O backend **não tem prefixo global**: ele responde em `/sales` e `/items/sync`. Como o dashboard
e a API compartilham o domínio e o Nginx roteia `/api` → backend, o `location` casa `/api/...` e
reescreve antes do `proxy_pass`.

```nginx
# Rotas de ingest do plugin (austv-sales), sob o prefixo /api do deploy atual.
location ~ ^/api/(sales|items/sync)$ {
    # 1) Allowlist de IP: so a VPS do jogo alcanca o ingest. Contem o estrago se a key vazar.
    allow 203.0.113.10;      # <-- IP FIXO da VPS do servidor de jogo (ajustar)
    deny all;

    # 2) Rate limiting na borda (ponto de partida ADR: ~10 req/s, burst pequeno).
    #    Requer, no bloco http{}:  limit_req_zone $binary_remote_addr zone=ingest:10m rate=10r/s;
    limit_req zone=ingest burst=20 nodelay;

    # 3) Tira o /api antes de repassar: o backend nao conhece esse prefixo. Em location por
    #    regex o Nginx PROIBE URI no proxy_pass ("proxy_pass cannot have URI part in location
    #    given by regular expression"), entao a reescrita e feita aqui.
    rewrite ^/api/(.*)$ /$1 break;

    # 4) Repasse ao backend. O X-Forwarded-For setado AQUI e a fonte confiavel do req.ip no app
    #    (que fixa `trust proxy` via TRUST_PROXY). SEM esta linha o app cai no peer direto —
    #    que, com o backend em container, e o gateway da bridge, nao o cliente real.
    proxy_pass http://127.0.0.1:3000;   # <-- ajustar host:porta do backend
    proxy_set_header Host              $host;
    proxy_set_header X-Real-IP         $remote_addr;
    proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

## Coerência com o app (obrigatória)

Para a allowlist do app confiar no `req.ip`, o `TRUST_PROXY` do backend precisa **casar** com o
endereço de onde a conexão do Nginx **chega no processo** — que não é a mesma coisa que o destino
escrito no `proxy_pass`:

| Onde o backend roda | O que o processo enxerga como peer | `TRUST_PROXY` |
|---|---|---|
| No próprio host (sem container) | `127.0.0.1` | `loopback` (default) |
| **Em container** (deploy atual) | o **gateway da bridge** do Docker (ex.: `172.27.0.1`) | **`1`** |
| Atrás de mais de um proxy | o proxy mais próximo | a contagem de hops (`2`, `3`, …) |

> ⚠️ **A armadilha que já custou um incidente (2026-07-19).** Com o backend em container,
> `proxy_pass http://127.0.0.1:3000` **parece** loopback, mas o container recebe a conexão pela
> bridge. Com `TRUST_PROXY=loopback` o Express não confia nesse hop, **descarta o
> `X-Forwarded-For`** e usa o peer direto — o `req.ip` vira `172.27.0.1`, a allowlist recusa, e
> todo o ingest passa a responder `403` para tráfego legítimo.
>
> Prefira **`1`** a uma subnet (`172.27.0.0/16`): a subnet da bridge é atribuída pelo Docker e
> **muda** se a rede for recriada, trazendo o mesmo 403 de volta sem ninguém ter mexido em nada.
> `1` descreve a topologia (um proxy na frente) e não a numeração.
>
> `1` continua seguro contra header forjado: o `$proxy_add_x_forwarded_for` **anexa** o IP real ao
> que o cliente mandou, e o Express com um hop de confiança lê o mais à direita.

E o `INGEST_ALLOWED_IPS` do backend deve conter **o mesmo IP** que o `allow` do Nginx (o IP público
da VPS do jogo). Se as duas camadas divergirem, o app pode recusar (`403`) tráfego legítimo — por
isso o teste de go-live (S6.3 / runbook de resiliência, Fase 1) confere que uma venda real chega.

### Diagnóstico rápido de um `403` no ingest

O app dá duas pistas, nesta ordem:

1. **No boot:** `Trust proxy: "loopback" (define o req.ip usado pela allowlist de ingest)` e
   `Ingest IP allowlist active (N address(es))`. As duas linhas juntas dizem se a allowlist está
   ligada e de onde o `req.ip` sai.
2. **Na recusa:** `Rejected ingest request ... from <ip>`. Se `<ip>` for privado/loopback, a
   mensagem já aponta para o `TRUST_PROXY` — é o proxy, não o cliente. Se for um IP público, o
   `TRUST_PROXY` está certo e o que falta é esse IP no `INGEST_ALLOWED_IPS`.

Se **não houver** linha de recusa alguma, o `403` veio da borda (o `deny all` do Nginx), não do app.

> **Variável de ambiente alterada não vale sem recriar o container.** `docker restart` e
> `docker compose restart` reiniciam o processo preservando o ambiente da criação. Use
> `docker compose up -d` (ou `down && up -d`) — caso contrário o boot parece normal e a
> configuração antiga continua valendo.

## Checklist de deploy / go-live (S6.3)

- [ ] `allow <ip da VPS do jogo>; deny all;` aplicado no `location` do ingest.
- [ ] `location` casa o prefixo real (`/api/...` no deploy atual) e tem o `rewrite`.
- [ ] `limit_req_zone` declarado no `http{}` e `limit_req` no `location`.
- [ ] `X-Forwarded-For` repassado pelo Nginx.
- [ ] `INGEST_ALLOWED_IPS` (backend) = IP público da VPS do jogo.
- [ ] `TRUST_PROXY` (backend) = `1` com backend em container (ver tabela acima).
- [ ] Container **recriado** (`docker compose up -d`) após qualquer mudança de env.
- [ ] Boot confere: linha `Trust proxy: ...` com o valor esperado + `allowlist active (N)`.
- [ ] Teste **positivo**: `curl` da VPS do jogo em `/api/items/sync` → `200`.
- [ ] Teste **negativo**: mesmo `curl` de outra máquina → `403`. Sem este, um `200` não
      distingue "corrigido" de "proteção desligada".
- [ ] Teste: venda real do servidor de jogo chega em `sales`; venda forjada de outro IP → recusada.
