# Sprint 3 — Resiliência do plugin: cache de itens, fila SQLite e reenvio

> Duração: 1 semana
> Épico: E3 (Plugin Java)
> Capacidade planejada: 13 SP
> Pré-requisito: contrato de status codes do `POST /sales` (S2.2) mergeado

## Objetivo do sprint

Ao final do sprint, o plugin é resiliente: valida `item_id` contra cache local sincronizado,
grava eventos em SQLite quando a API está fora do ar e reenvia depois sem duplicar nada.
O critério de aceite CA1 do MVP ("fallback SQLite testável desligando a API propositalmente")
fica completo e demonstrado.

---

## Histórias

### S3.1 — Cache local de itens com sincronização periódica

- **Como** plugin, **quero** manter em memória a lista de itens ativos, sincronizada periodicamente via `GET /items` (S2.3), **para** rejeitar `item_id` não cadastrado no momento do comando, sem chamada de rede por venda.
- **Responsável:** `gamedev-plugin-specialist`
- **Estimativa:** 3 SP
- **Critérios de aceite:**
  - [ ] Sync no enable do plugin + scheduled task periódica (intervalo configurável no `config.yml`)
  - [ ] Comando com `item_id` fora do cache → **rejeita e loga erro**, não cria nada e não envia (decisão de negócio: nunca auto-criar item)
  - [ ] Falha na sincronização → mantém último cache válido e loga warning (não zera o cache)
  - [ ] Cache vazio (primeiro boot sem rede): comportamento definido e documentado — rejeitar com log orientando verificar conectividade/cadastro
  - [ ] Sync roda fora da main thread; estrutura do cache thread-safe

### S3.2 — Fila de fallback em SQLite

- **Como** plugin, **quero** gravar o evento de venda em SQLite local quando o envio à API falhar (timeout, 5xx, sem rede), **para** nunca perder uma venda — o dado é irrecuperável se descartado.
- **Responsável:** `gamedev-plugin-specialist` + `backend-specialist`
- **Estimativa:** 5 SP — schema SQLite, integração sqlite-jdbc, classificação correta de falhas e escrita fora da main thread.
- **Critérios de aceite:**
  - [ ] Banco SQLite criado na pasta de dados do plugin, schema com evento completo + `status` (`pending`/`sent`) + contador de tentativas + timestamps
  - [ ] Falha **transitória** (timeout, 5xx, ConnectException) → grava `pending`; resposta **4xx** (erro permanente, ex.: item desconhecido) → **não** enfileira, loga erro definitivo (contrato da S2.2)
  - [ ] `sale_id` gerado no executor é persistido junto — o mesmo UUID é usado no reenvio (idempotência)
  - [ ] Escrita no SQLite fora da main thread; falha de escrita no SQLite loga erro crítico (último recurso)
  - [ ] Eventos `sent` são limpos após retenção configurável (fila não cresce para sempre)
  - [ ] Testável: desligar a API, executar comando, verificar linha `pending` no SQLite

### S3.3 — Worker de reprocessamento da fila

- **Como** plugin, **quero** uma scheduled task que reenvia os eventos `pending` periodicamente, **para** que vendas gravadas offline cheguem ao Postgres assim que a API voltar, sem duplicar.
- **Responsável:** `gamedev-plugin-specialist`
- **Estimativa:** 3 SP
- **Critérios de aceite:**
  - [ ] Worker assíncrono periódico processa `pending` em ordem de gravação, marcando `sent` **somente** após ACK 2xx
  - [ ] Reenvio usa o `sale_id` original → API trata como upsert idempotente (S2.2)
  - [ ] 4xx no reenvio → marca como falha permanente com log (não tenta para sempre); 5xx/timeout → mantém `pending` com backoff
  - [ ] Sobrevive a restart do plugin: `pending` gravados antes do restart são reprocessados no boot
  - [ ] Sem envio concorrente do mesmo evento (worker não sobrepõe execução anterior)
  - [ ] Métricas no log: quantos reenviados/pendentes por ciclo (visibilidade operacional)

### S3.4 — Teste integrado de resiliência ponta a ponta

- **Como** dono do sistema, **quero** um roteiro de teste executado e documentado que derruba e religa a API durante vendas, **para** provar o CA1 (fallback funcional) e a ausência de duplicatas antes do cutover.
- **Responsável:** `gamedev-plugin-specialist` + `backend-specialist`
- **Estimativa:** 2 SP — gera runbook + correções pequenas que couberem no PR; bugs maiores viram histórias.
- **Critérios de aceite:**
  - [ ] Roteiro executado: (1) vendas com API no ar; (2) API desligada + N vendas → todas `pending`; (3) API religada → todas entregues e `sent`; (4) restart do plugin no meio → nada perdido nem duplicado
  - [ ] Contagem em `sales` no Postgres == número de comandos executados (zero duplicatas, zero perdas)
  - [ ] Roteiro documentado como runbook reproduzível (será reusado na validação do go-live, S6.3)

---

## Definition of Done do Sprint 3

- Todo código mergeado via PR revisado, CI verde
- CA1 do MVP demonstrado: venda registrada com API no ar **e** com API fora do ar (fila + reenvio), sem duplicatas
- Nenhuma operação de I/O (rede ou SQLite) na main thread do servidor — verificado em revisão
- Comportamentos de erro (4xx vs 5xx) consistentes com o contrato da S2.2
- Runbook de teste de resiliência versionado no repositório
- Plugin roda 24h+ no servidor de teste sem leak de memória/timer aparente no log

## Riscos e dependências

| Risco | Mitigação |
|---|---|
| Duplicidade sutil (evento enviado, ACK perdido, reenvio) | É exatamente o cenário coberto pela idempotência da S2.2 + teste explícito na S3.4 |
| Corrupção/lock do SQLite com escrita concorrente | Serializar acesso via executor único no plugin; sqlite-jdbc em modo WAL |
| Relógio do servidor de jogo errado contamina `purchased_at` dos eventos enfileirados | NTP já verificado na S1.7; `purchased_at` gravado na fila é o do momento do comando (correto por design) |
| Sprint depende de ambiente de teste estável (Paper + API) | Ambiente já montado no Sprint 2 (S2.4) |
