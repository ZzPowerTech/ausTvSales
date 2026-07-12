# Sprint 1 — Fundação: schema, API de catálogo e decisões de segurança

> Duração: 1 semana
> Épicos: E1 (Fundação de dados e API base), E7 (Segurança e operação)
> Capacidade planejada: 15 SP (acima do alvo de 13; ver nota em Riscos)

## Objetivo do sprint

Ao final do sprint, existe um backend NestJS deployável em container com o schema PostgreSQL
completo e CRUD de categorias/itens protegido por autenticação. As duas decisões bloqueantes de
segurança (mecanismo de auth plugin→API e NTP) estão resolvidas e documentadas — nada do Sprint 2
fica esperando decisão.

---

## Histórias

### S1.1 — Scaffolding do backend NestJS + container + CI básico

- **Como** mantenedor do projeto, **quero** um backend NestJS containerizado com healthcheck e pipeline de build/test, **para** que todo PR seguinte já nasça deployável na VPS original do servidor AusTV.
- **Responsável:** `devops-specialist` + `backend-specialist`
- **Estimativa:** 3 SP — scaffolding é mecânico, mas inclui Dockerfile, docker-compose de dev (Postgres local), config de ambiente e workflow de CI.
- **Critérios de aceite:**
  - [ ] Projeto NestJS em `backend/` com estrutura de módulos e config por variáveis de ambiente
  - [ ] `GET /health` responde 200 com status do banco
  - [ ] Dockerfile multi-stage + docker-compose de desenvolvimento com PostgreSQL
  - [ ] CI roda lint + testes a cada PR
  - [ ] Nenhuma porta exposta além da necessária; container não roda como root

### S1.2 — Schema PostgreSQL (migrations)

- **Como** sistema, **quero** as tabelas `categories`, `items`, `players` e `sales` criadas via migrations versionadas, **para** que o modelo do spec (seção 4) exista de forma reprodutível.
- **Responsável:** `database-specialist`
- **Estimativa:** 3 SP — modelo pequeno, mas exige acerto nas constraints que garantem idempotência e integridade (errar aqui custa caro depois).
- **Critérios de aceite:**
  - [ ] Migrations criam as 4 tabelas exatamente como na seção 4 do spec
  - [ ] `sales.id` é UUID **fornecido pelo cliente** (sem auto-geração no banco) com constraint de unicidade — base da idempotência
  - [ ] `items.item_id` com constraint `UNIQUE`; FKs `sales.item_id → items.item_id` e `sales.player_uuid → players.uuid`
  - [ ] Índices `sales(item_id, purchased_at)` e `sales(player_uuid, item_id)` criados
  - [ ] `historical_import` com default `false`; `created_at` com default do lado do banco
  - [ ] Migrations rodam do zero e são idempotentes (up/down testados)

### S1.3 — [SPIKE] Decisão do mecanismo de auth plugin→API

- **Como** `devops-specialist` + `cybersecurity-validator`, **quero** decidir entre API key e mTLS para a comunicação VPS do jogo → VPS da API, **para** desbloquear o Sprint 2 (a implementação é bloqueante antes de qualquer merge que exponha o endpoint de vendas).
- **Responsável:** `devops-specialist` + `cybersecurity-validator`
- **Estimativa:** 2 SP (timebox: 1 dia) — não gera PR de código; gera ADR.
- **Critérios de aceite:**
  - [ ] ADR escrito em `.specs/decisions/` comparando API key vs mTLS (complexidade de rotação, gestão de certificado na máquina do jogo, o que o Nginx suporta sem fricção)
  - [ ] Decisão inclui: onde o segredo/certificado vive no plugin, estratégia de rotação e o que acontece em caso de vazamento
  - [ ] Estratégia de rate limiting do endpoint de ingest esboçada no mesmo ADR
  - [ ] Aprovado pelo Murilo antes do fim do sprint

### S1.4 — Guard de autenticação para rotas administrativas

- **Como** operador do catálogo, **quero** que toda rota de escrita do catálogo exija autenticação, **para** que nenhum endpoint de cadastro seja público (risco da seção 7 do spec: erro no catálogo contamina tudo).
- **Responsável:** `backend-specialist` (revisão: `cybersecurity-validator`)
- **Estimativa:** 2 SP — guard NestJS com token de admin via env var nesta fase; a sessão de usuário do dashboard evolui na S4.1.
- **Critérios de aceite:**
  - [ ] Guard aplicado por padrão a todas as rotas administrativas (allowlist explícita para rotas públicas, não o contrário)
  - [ ] Requisição sem credencial → 401; credencial inválida → 401 com log de tentativa
  - [ ] Nenhum segredo hardcoded; testes cobrindo acesso negado/permitido
- **Nota de fatiamento:** deve ser mergeado **antes** de S1.5/S1.6 — os CRUDs já nascem protegidos.

### S1.5 — CRUD de categorias (API)

- **Como** operador do catálogo, **quero** criar, listar, editar e desativar categorias via API autenticada, **para** que a sidebar do dashboard e o vínculo de itens tenham fonte de dados.
- **Responsável:** `backend-specialist`
- **Estimativa:** 2 SP
- **Critérios de aceite:**
  - [ ] `POST/GET/PATCH` de categorias com validação (`name` obrigatório e único case-insensitive, `display_order` inteiro)
  - [ ] Nome duplicado → 409 com mensagem clara (decisão de negócio: evitar categoria duplicada por typo)
  - [ ] Rotas de escrita atrás do guard da S1.4; listagem pode ser lida pelo dashboard
  - [ ] Testes e2e do módulo

### S1.6 — CRUD de itens (API)

- **Como** operador do catálogo, **quero** cadastrar itens (`item_id` opaco, `display_name`, categoria, `active`) via API autenticada, **para** que o endpoint de vendas e o cache do plugin tenham catálogo para validar.
- **Responsável:** `backend-specialist`
- **Estimativa:** 2 SP
- **Critérios de aceite:**
  - [ ] `POST/GET/PATCH` de itens; `item_id` único, imutável após criação, validado por regex (identificador opaco, sem espaços)
  - [ ] Item exige `category_id` existente → 422 se categoria inexistente
  - [ ] Desativação (`active = false`) em vez de delete físico (vendas históricas referenciam o item)
  - [ ] Rotas de escrita atrás do guard da S1.4; testes e2e

### S1.7 — [OPS] Validar NTP nas duas VPS

- **Como** operador, **quero** confirmar que a VPS do jogo e a VPS da API estão sincronizadas via NTP, **para** que `purchased_at` seja confiável (risco de clock skew, seção 7 do spec).
- **Responsável:** `devops-specialist`
- **Estimativa:** 1 SP — tarefa operacional; não gera PR de código, gera registro de verificação.
- **Critérios de aceite:**
  - [ ] `timedatectl`/chrony verificado nas duas máquinas; skew medido e registrado
  - [ ] NTP habilitado e persistente (sobrevive a reboot) onde faltava
  - [ ] Resultado documentado (nota em `.specs/decisions/` ou runbook) — será re-checado no go-live (S6.3)

---

## Definition of Done do Sprint 1

- Todo código mergeado via PR revisado, com CI verde (lint + testes)
- Backend sobe do zero com `docker compose up` e migrations aplicam sem intervenção manual
- Nenhuma rota de escrita acessível sem autenticação (verificado por teste automatizado)
- ADR de auth plugin→API aprovado pelo Murilo — Sprint 2 não inicia sem isso
- NTP verificado e documentado nas duas VPS
- É possível, via API autenticada (curl/HTTP client), cadastrar uma categoria e um item de ponta a ponta

## Riscos e dependências

| Risco | Mitigação |
|---|---|
| 15 SP > alvo de 13 | S1.7 é tarefa de ~1h e S1.3 é timeboxed; se apertar, S1.6 desliza para o início do Sprint 2 sem quebrar dependências |
| Spike S1.3 travar em análise | Timebox rígido de 1 dia; na dúvida, API key + IP allowlist no Nginx é o caminho reversível (mTLS pode evoluir depois) |
| Instância Postgres compartilhada com AusTV Finance | Usar database/schema separado e usuário próprio com permissões mínimas — validar acesso logo no início da S1.2 |
| Acesso às duas VPS necessário (S1.7) | Confirmar credenciais/SSH antes de começar o sprint |
