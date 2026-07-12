# Sprint 2 — Ingestão de vendas autenticada + comando do plugin (caminho feliz)

> Duração: 1 semana
> Épicos: E2 (Ingestão de vendas), E3 (Plugin Java), E7 (Segurança)
> Capacidade planejada: 15 SP
> Pré-requisito: ADR da S1.3 aprovado (mecanismo de auth plugin→API decidido)

## Objetivo do sprint

Ao final do sprint, uma venda executada no servidor de jogo chega ao PostgreSQL: o plugin expõe o
comando `austv-sales add`, envia o evento autenticado para a API, e a API grava com idempotência,
rejeitando item não cadastrado. Ainda **sem** fila de fallback (Sprint 3) — se a API cair, o
evento é logado como perdido (aceitável apenas em ambiente de teste; cutover só no Sprint 6).

---

## Histórias

### S2.1 — Autenticação plugin→API + rate limiting no endpoint de ingest

- **Como** dono do sistema, **quero** que o endpoint de recebimento de vendas só aceite chamadas autenticadas da VPS do jogo, com rate limiting, **para** impedir flood e vendas forjadas (seção 7 do spec). **Bloqueante:** nenhum merge expõe o endpoint de vendas sem isto.
- **Responsável:** `devops-specialist` + `backend-specialist` (revisão: `cybersecurity-validator`)
- **Estimativa:** 3 SP — implementação do mecanismo decidido na S1.3 (guard NestJS + config Nginx) e throttling.
- **Critérios de aceite:**
  - [ ] Mecanismo do ADR implementado (guard dedicado, separado do guard admin da S1.4)
  - [ ] Chamada sem credencial ou com credencial inválida → 401, com log da origem
  - [ ] Rate limiting ativo no endpoint de ingest conforme esboço do ADR (Nginx e/ou throttler NestJS), com resposta 429
  - [ ] Segredo/certificado gerenciado fora do repositório (env/secret), com procedimento de rotação documentado
  - [ ] Revisão do `cybersecurity-validator` registrada no PR
- **Nota de fatiamento:** este PR entrega o guard + rota stub protegida. A lógica de negócio do ingest vem na S2.2, por cima do guard já mergeado.

### S2.2 — `POST /sales` idempotente com validação de catálogo

- **Como** plugin, **quero** enviar um evento de venda e receber ACK confiável, **para** que cada venda vire exatamente uma linha em `sales`, mesmo com reenvio.
- **Responsável:** `backend-specialist`
- **Estimativa:** 5 SP — é o coração do backend: idempotência real, upsert de player e semântica de erro precisa (o contrato do plugin e do worker do Sprint 3 dependem dela).
- **Critérios de aceite:**
  - [ ] Payload validado: `sale_id` (UUID), `item_id`, `player_uuid`, `nickname_at_purchase`, `total_price` (decimal, > 0), `qtd` (int, ≥ 1), `purchased_at` (ISO-8601)
  - [ ] `item_id` inexistente ou inativo → 422 com log claro, **sem criar registro fantasma** (CA2) e sem criar player
  - [ ] Reenvio do mesmo `sale_id` → 2xx idempotente (não duplica linha; constraint de unicidade da S1.2 como última defesa)
  - [ ] Upsert em `players`: cria se não existe; atualiza `last_known_nickname` + `updated_at` se o nick mudou
  - [ ] `created_at` gerado pelo banco (auditoria de latência da fila); `purchased_at` vem do payload, nunca do servidor
  - [ ] Semântica de status codes documentada (contrato para o plugin): 2xx = ACK definitivo; 4xx = erro permanente (não reenfileirar); 5xx = transitório (reenfileirar)
  - [ ] Testes e2e cobrindo: sucesso, duplicata, item desconhecido, payload malformado

### S2.3 — `GET /items` para sincronização do cache do plugin

- **Como** plugin, **quero** buscar a lista de itens ativos na API, **para** validar `item_id` localmente antes de aceitar o comando (sem uma chamada de rede por venda).
- **Responsável:** `backend-specialist`
- **Estimativa:** 2 SP
- **Critérios de aceite:**
  - [ ] Endpoint retorna itens ativos (`item_id`, `active`) em formato enxuto para o cache
  - [ ] Protegido pela mesma auth plugin→API da S2.1
  - [ ] Suporta consulta eficiente para polling periódico (ex.: `updated_at`/ETag ou resposta completa barata — decidir no PR e documentar)

### S2.4 — Plugin Paper: comando `austv-sales add` (caminho feliz)

- **Como** reward do Genesis, **quero** executar `austv-sales add <player_nick> <item_id> <total_price> <qtd>` e ter o evento entregue à API, **para** registrar a venda com timestamp real no momento da compra.
- **Responsável:** `gamedev-plugin-specialist` + `backend-specialist`
- **Estimativa:** 5 SP — scaffolding do plugin (Gradle, `plugin.yml`, config), `CommandExecutor` completo e cliente HTTP assíncrono autenticado.
- **Critérios de aceite:**
  - [ ] Projeto do plugin em `plugin/` (Paper 1.21.x, Java 21, Google Style), buildável via Gradle com CI
  - [ ] Comando restrito ao console/permissão de operador (jogador comum não pode forjar venda via chat)
  - [ ] `player_nick` resolvido para `player_uuid` via Bukkit API; nick não resolvível → erro logado, evento não enviado
  - [ ] `purchased_at = Instant.now()` capturado no executor; `sale_id` UUID gerado no plugin — **nunca** vindos de argumento
  - [ ] Envio assíncrono (`BukkitRunnable` async) via HTTPS com a credencial da S2.1 — zero I/O de rede na main thread
  - [ ] Argumentos inválidos (preço não numérico, qtd < 1) → rejeição com log claro, nada enviado
  - [ ] Falha de rede/5xx nesta fase: log de erro explícito marcado como `TODO Sprint 3 (queue)` — sem fila ainda
  - [ ] Teste manual documentado: comando no servidor de teste → linha em `sales` no Postgres

---

## Definition of Done do Sprint 2

- Todo código mergeado via PR revisado, CI verde nos dois projetos (backend e plugin)
- **Nenhum** endpoint novo acessível sem autenticação; revisão de segurança da S2.1 registrada
- Demo de ponta a ponta em ambiente de teste: cadastrar item via API (Sprint 1) → executar comando no servidor Paper → conferir linha em `sales` com `purchased_at` correto
- Reenvio manual do mesmo payload não duplica venda (idempotência demonstrada)
- Item não cadastrado é rejeitado nas duas pontas (plugin loga na S2.4 apenas se cache existir — validação local completa chega na S3.1; API rejeita sempre)
- Contrato de status codes (2xx/4xx/5xx) documentado — insumo direto do Sprint 3

## Riscos e dependências

| Risco | Mitigação |
|---|---|
| ADR da S1.3 atrasar | Sprint não inicia sem ele — cobrar aprovação no fim do Sprint 1 |
| Semântica de erro mal definida quebrar o worker do Sprint 3 | Contrato de status codes é critério de aceite explícito da S2.2 |
| Testar plugin exige servidor Paper de teste | Subir instância Paper local/na VPS de teste no início do sprint (parte do setup da S2.4) |
| `%price%` do Genesis com formato inesperado (vírgula, símbolo de moeda) | S2.4 valida e normaliza o argumento `total_price`; testar com valor real do Genesis no servidor de teste |
| Vendas perdidas se API cair (sem fila ainda) | Aceitável: cutover de produção só no Sprint 6, depois da fila (Sprint 3) |
