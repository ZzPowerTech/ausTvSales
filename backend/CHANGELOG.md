# Changelog

## [0.15.0](https://github.com/ZzPowerTech/ausTvSales/compare/backend-v0.14.0...backend-v0.15.0) (2026-08-28)


### Features

* **backend:** 7o check da secao 6.1 — funnel.tutorial_entry_rate (S8.0) ([#169](https://github.com/ZzPowerTech/ausTvSales/issues/169)) ([a59b47e](https://github.com/ZzPowerTech/ausTvSales/commit/a59b47e4d59a579cccbdf317edade2eefa35fa05))
* **backend:** fonte de dados do tutorial e ETL idempotente (S8.0) ([#168](https://github.com/ZzPowerTech/ausTvSales/issues/168)) ([eb68df1](https://github.com/ZzPowerTech/ausTvSales/commit/eb68df1536fcbc0aab24a8804f5d846aa62da866))
* **backend:** modulo funnel — os degraus que tem fonte, e o motivo do que nao tem (S8.1) ([#170](https://github.com/ZzPowerTech/ausTvSales/issues/170)) ([5fd7bb5](https://github.com/ZzPowerTech/ausTvSales/commit/5fd7bb56d2acf029429d6212df49295c7793d80f))


### Bug Fixes

* **backend:** 403 do Plan deixa de ser rotulado como credencial errada ([#164](https://github.com/ZzPowerTech/ausTvSales/issues/164)) ([222eb2f](https://github.com/ZzPowerTech/ausTvSales/commit/222eb2fc4ce62a84333cc7e401c2313b28019427))

## [0.14.0](https://github.com/ZzPowerTech/ausTvSales/compare/backend-v0.13.0...backend-v0.14.0) (2026-08-26)


### Features

* **backend:** adapter do /v1/onlineOverview sobre payload real (S7.2) ([e59c6ab](https://github.com/ZzPowerTech/ausTvSales/commit/e59c6ab02159e24fdfd1fcf1a8bb2d4f48efd8ed)), closes [#111](https://github.com/ZzPowerTech/ausTvSales/issues/111)
* **backend:** agendador publica a cadencia configurada ([bca216e](https://github.com/ZzPowerTech/ausTvSales/commit/bca216efcc25378b4efe5bb8a1d14ed3faa26717)), closes [#110](https://github.com/ZzPowerTech/ausTvSales/issues/110)
* **backend:** cache com TTL por endpoint na frente do Plan (S7.2) ([fac63b4](https://github.com/ZzPowerTech/ausTvSales/commit/fac63b4be476d5667aa84fd03c9b5622a62bc4b7)), closes [#111](https://github.com/ZzPowerTech/ausTvSales/issues/111)
* **backend:** documentacao OpenAPI servida atras da sessao ([d715cf8](https://github.com/ZzPowerTech/ausTvSales/commit/d715cf843cd03a4a2e9f4d3116cb56bb75bab8ac))
* **backend:** documentação OpenAPI servida atrás da sessão (S7) ([a0622db](https://github.com/ZzPowerTech/ausTvSales/commit/a0622db564d79593daa7dadc4a62d40fd7731115))
* **backend:** modulo health expoe os checks de instrumentacao (S7.1) ([fdc6ade](https://github.com/ZzPowerTech/ausTvSales/commit/fdc6ade0411b63cbd3618b37a963d4e6de03cc1f)), closes [#110](https://github.com/ZzPowerTech/ausTvSales/issues/110)
* **backend:** módulo health expõe os checks de instrumentação (S7.1) ([5651fe1](https://github.com/ZzPowerTech/ausTvSales/commit/5651fe1aaf593b3b9a3aa43768274a7f1b00af9b))
* **backend:** módulo metrics — client do Plan, cache e visão de servidor (S7.2) ([5eaa812](https://github.com/ZzPowerTech/ausTvSales/commit/5eaa812346371eced2acd15569f136c3ab20e07b))
* **backend:** modulo metrics — visao de servidor e de online normalizadas (S7.2) ([ecb9b3d](https://github.com/ZzPowerTech/ausTvSales/commit/ecb9b3d9335c62f7433e80dccb0f9fb422b6df09)), closes [#111](https://github.com/ZzPowerTech/ausTvSales/issues/111)
* **backend:** rate limit nas leituras de saude da instrumentacao ([3b972a4](https://github.com/ZzPowerTech/ausTvSales/commit/3b972a4792c12b80c9ff272568389f6e2dcf46c4)), closes [#111](https://github.com/ZzPowerTech/ausTvSales/issues/111)


### Bug Fixes

* **backend:** charset do nome do check aceita o que PLAN_SERVERS pode conter ([9d26ea5](https://github.com/ZzPowerTech/ausTvSales/commit/9d26ea522ec90cee4991d81dd621e4ff0841a4f0)), closes [#110](https://github.com/ZzPowerTech/ausTvSales/issues/110)
* **backend:** CORP volta a same-origin; HSTS e COOP viram decisao escrita ([b67fda1](https://github.com/ZzPowerTech/ausTvSales/commit/b67fda1ef2d7a585fb1f86b306cd5f2f824a5f4c)), closes [#111](https://github.com/ZzPowerTech/ausTvSales/issues/111)
* **backend:** corrige o que o limite do dashboard realmente cobre ([4445e44](https://github.com/ZzPowerTech/ausTvSales/commit/4445e44bf78a1ba67c17d20d5825bbd27adbac94)), closes [#111](https://github.com/ZzPowerTech/ausTvSales/issues/111)
* **backend:** e2e de throttling reconstroi o app a cada caso ([b7457b0](https://github.com/ZzPowerTech/ausTvSales/commit/b7457b0cd536497c9f15a85bd0c68652b209fe8c)), closes [#111](https://github.com/ZzPowerTech/ausTvSales/issues/111)
* **backend:** frescor do agregado vem do check mais VELHO, nao do mais novo ([405805b](https://github.com/ZzPowerTech/ausTvSales/commit/405805bb0c841130bb88faef1e7a495431d98fd6)), closes [#110](https://github.com/ZzPowerTech/ausTvSales/issues/110)
* **backend:** leituras concorrentes compartilham uma busca ao Plan ([42eb3c9](https://github.com/ZzPowerTech/ausTvSales/commit/42eb3c95f028f62a2ef8ef84c1f2bdb8f7345c67)), closes [#111](https://github.com/ZzPowerTech/ausTvSales/issues/111)
* **backend:** motivo da falha e rotulo fechado, nao a mensagem crua do Plan ([824d314](https://github.com/ZzPowerTech/ausTvSales/commit/824d314bb28e1b7985ecfde8bda5958e27484fe0)), closes [#111](https://github.com/ZzPowerTech/ausTvSales/issues/111)
* **backend:** o documento OpenAPI deixa de mentir sobre autenticacao ([46b01e2](https://github.com/ZzPowerTech/ausTvSales/commit/46b01e24044a17e11d660b5f776c2ae9323cd05d))
* **backend:** registro majoritariamente silencioso rebaixa o agregado para down ([b00944d](https://github.com/ZzPowerTech/ausTvSales/commit/b00944d18f3ff4efaea15e0d0b0f518ffd26a058)), closes [#110](https://github.com/ZzPowerTech/ausTvSales/issues/110)
* **backend:** rejeicao do verify tratada sem engolir falha do allowlist ([9f0034f](https://github.com/ZzPowerTech/ausTvSales/commit/9f0034f75fce1ef00666f2eedb492ec342260efc))
* **backend:** remove o campo de motivo cru e fecha a corrida do clear() ([21a21f9](https://github.com/ZzPowerTech/ausTvSales/commit/21a21f9a5ba99744afdf1e805f44540b7829c21b)), closes [#111](https://github.com/ZzPowerTech/ausTvSales/issues/111)
* **backend:** requisicoes do e2e de assets em serie, nao em paralelo ([2f053c5](https://github.com/ZzPowerTech/ausTvSales/commit/2f053c5dc5177cf26c9a2a4272914d96005af36c))

## [0.13.0](https://github.com/ZzPowerTech/ausTvSales/compare/backend-v0.12.0...backend-v0.13.0) (2026-08-23)


### Features

* **backend:** adapter do /v1/serverOverview do Plan (S6.3) ([2855b3d](https://github.com/ZzPowerTech/ausTvSales/commit/2855b3df5d0cb4abbc67dd5ee0e816e01331f69f))
* **backend:** adapter do /v1/serverOverview do Plan (S6.3) ([442735e](https://github.com/ZzPowerTech/ausTvSales/commit/442735ebe7bdeaf3617f57d28160e41fd67a9f7d))
* **backend:** agendamento do ciclo de checks de saude (S6.3) ([909dbb3](https://github.com/ZzPowerTech/ausTvSales/commit/909dbb3b53a6415fa8a2d32ddd1fe77566b24fce))
* **backend:** agendamento do ciclo de checks de saude (S6.3) ([bbfd11a](https://github.com/ZzPowerTech/ausTvSales/commit/bbfd11a7c57f1def385417aac5d78efe69d70cc6))
* **backend:** check de coleta viva por servidor (S6.3) ([0437a78](https://github.com/ZzPowerTech/ausTvSales/commit/0437a788ae510aae17759ed0fc2f7be7403ea63a))
* **backend:** check de coleta viva por servidor (S6.3) ([1caa295](https://github.com/ZzPowerTech/ausTvSales/commit/1caa295e6a9c2406a5d5bcc5c8cd6963c53ea6e5))
* **backend:** check de conversao rede -&gt; servidor (S6.3, secao 6.2) ([5c31740](https://github.com/ZzPowerTech/ausTvSales/commit/5c317405a4a28af13061635f6313aaf0323de882))
* **backend:** check de conversao rede -&gt; servidor (S6.3, secao 6.2) ([22cbbb6](https://github.com/ZzPowerTech/ausTvSales/commit/22cbbb6c33240b43dc3545709172ee3698ccbc8b))
* **backend:** check de instancia orfa por reconciliacao de catalogo (S6.3) ([48b11df](https://github.com/ZzPowerTech/ausTvSales/commit/48b11dfcc6c736b82db32367696acd1abb5eed52))
* **backend:** check de instancia orfa por reconciliacao de catalogo (S6.3) ([5f0d06f](https://github.com/ZzPowerTech/ausTvSales/commit/5f0d06fe20733c523d518a12a8b5cf3bf1ec3435))
* **backend:** check de registro vivo na rede (S6.3) ([b5eeacb](https://github.com/ZzPowerTech/ausTvSales/commit/b5eeacbbf2c7989590b15ad2d735462b02ae74f0))
* **backend:** check de registro vivo na rede (S6.3) ([5fc3c9e](https://github.com/ZzPowerTech/ausTvSales/commit/5fc3c9e3fc8916df19276f345f2db3520d984c8b))
* **backend:** check de share de conta offline por janela (S6.3) ([903d6bc](https://github.com/ZzPowerTech/ausTvSales/commit/903d6bc8f34f9d21e57463b92db6a5a32c207cf8))
* **backend:** check de share de conta offline por janela (S6.3) ([3d8baad](https://github.com/ZzPowerTech/ausTvSales/commit/3d8baade44656e9b33a668c84619f1c957077376))
* **backend:** excecao 2 do ADR-002 e check de builds divergentes (S6.3) ([962cca6](https://github.com/ZzPowerTech/ausTvSales/commit/962cca68bad9d7343f8bbe80df4ef6abd3b5e328))
* **backend:** excecao 2 do ADR-002 e check de builds divergentes (S6.3) ([a76880e](https://github.com/ZzPowerTech/ausTvSales/commit/a76880e3abd923517305cc726e64fd1ea5a6999b))
* **backend:** runner que executa, persiste e anuncia os checks (S6.3) ([c882dfd](https://github.com/ZzPowerTech/ausTvSales/commit/c882dfdf12d399255d1114fc965cafd3c62f8ff0))
* **backend:** runner que executa, persiste e anuncia os checks (S6.3) ([8659242](https://github.com/ZzPowerTech/ausTvSales/commit/865924201ce5878044a4cf918b1e3b6881039df5))

## [0.12.0](https://github.com/ZzPowerTech/ausTvSales/compare/backend-v0.11.0...backend-v0.12.0) (2026-08-23)


### Features

* **backend:** transporte HTTP para a API JSON do Plan (S6.3) ([2a6972c](https://github.com/ZzPowerTech/ausTvSales/commit/2a6972cd9c63ded0c99a25ea5a0a7b91a96943b2))
* **backend:** transporte HTTP para a API JSON do Plan (S6.3) ([aff4508](https://github.com/ZzPowerTech/ausTvSales/commit/aff45084809a5964cb3a9ff10705b19c648575e1))


### Bug Fixes

* **backend:** o alerter nao pode mentir sobre o que entregou (S6.3) ([758a14e](https://github.com/ZzPowerTech/ausTvSales/commit/758a14e6cd9f9b38562f3568e87a7fe2cc53ac8f))
* **backend:** o alerter nao pode mentir sobre o que entregou (S6.3) ([4045ba0](https://github.com/ZzPowerTech/ausTvSales/commit/4045ba0bc9aeb133aeb2b0d05a449de5f061815e))
* **backend:** PLAN_BASE_URL ausente e erro permanente, nao transitorio (S6.3) ([2bc0f2e](https://github.com/ZzPowerTech/ausTvSales/commit/2bc0f2e25c58d5fc64163c33cb9451a2297a650e))

## [0.11.0](https://github.com/ZzPowerTech/ausTvSales/compare/backend-v0.10.1...backend-v0.11.0) (2026-08-23)


### Features

* **backend:** tabela health_checks e store de vereditos (S6.3) ([0243ae5](https://github.com/ZzPowerTech/ausTvSales/commit/0243ae54935aa1d66f8467a2765a8a766f154a83))
* **backend:** tabela health_checks e store de vereditos (S6.3) ([a9248ab](https://github.com/ZzPowerTech/ausTvSales/commit/a9248ab40f785251974ae86147f290fb0c46d50f)), closes [#109](https://github.com/ZzPowerTech/ausTvSales/issues/109)

## [0.10.1](https://github.com/ZzPowerTech/ausTvSales/compare/backend-v0.10.0...backend-v0.10.1) (2026-07-21)


### Bug Fixes

* **security:** resolve os 6 alertas do CodeQL (regex, hash de API key, permissions de CI) ([2e69c7b](https://github.com/ZzPowerTech/ausTvSales/commit/2e69c7b9db63d646f25e666e712ad21b30374493))
* **security:** resolve os 6 alertas do CodeQL (regex, hash de API key, permissions de CI) ([a7147f5](https://github.com/ZzPowerTech/ausTvSales/commit/a7147f5918e2bf53a2c2c9f627bcb93dcf9c32b9))

## [0.10.0](https://github.com/ZzPowerTech/ausTvSales/compare/backend-v0.9.0...backend-v0.10.0) (2026-07-20)


### Features

* **backend:** endpoints de analise de vendas [S5.1] ([1294fed](https://github.com/ZzPowerTech/ausTvSales/commit/1294fedd19140e3d6595f18b546158522e91a88a))
* **backend:** endpoints de analise de vendas [S5.1] ([5d5eaf2](https://github.com/ZzPowerTech/ausTvSales/commit/5d5eaf27f0739d554c6396502ae4910eaf470b12))

## [0.9.0](https://github.com/ZzPowerTech/ausTvSales/compare/backend-v0.8.1...backend-v0.9.0) (2026-07-20)


### Features

* **backend:** gerador de vendas sinteticas [S5.0] ([b02d1ac](https://github.com/ZzPowerTech/ausTvSales/commit/b02d1ac70c6a729ea03a4cb6a15f5281e6bf4d2f))
* **backend:** gerador de vendas sinteticas [S5.0] ([c16a4d8](https://github.com/ZzPowerTech/ausTvSales/commit/c16a4d8e26d44c1b593eb5cd8550d8868e980f3a))

## [0.8.1](https://github.com/ZzPowerTech/ausTvSales/compare/backend-v0.8.0...backend-v0.8.1) (2026-07-20)


### Bug Fixes

* **backend:** torna o 403 do ingest autodiagnosticavel ([02fa74c](https://github.com/ZzPowerTech/ausTvSales/commit/02fa74cbe4d8522de152ce2f19b9e8591a8c6da2))
* **backend:** torna o 403 do ingest autodiagnosticável ([c346192](https://github.com/ZzPowerTech/ausTvSales/commit/c3461928ff43c477e324058a0910d664fd64270b))

## [0.8.0](https://github.com/ZzPowerTech/ausTvSales/compare/backend-v0.7.0...backend-v0.8.0) (2026-07-18)


### Features

* **backend:** unicidade de categoria no banco e reordenacao atomica [S4.0] ([bb9c352](https://github.com/ZzPowerTech/ausTvSales/commit/bb9c35205b082f01caf2bec64b30c4f20d595e44)), closes [#72](https://github.com/ZzPowerTech/ausTvSales/issues/72)
* **backend:** unicidade de categoria no banco e reordenação atômica [S4.0] ([61b2154](https://github.com/ZzPowerTech/ausTvSales/commit/61b21541f0bf7747838fb31f9c98b4dd43886331))

## [0.7.0](https://github.com/ZzPowerTech/ausTvSales/compare/backend-v0.6.0...backend-v0.7.0) (2026-07-18)


### Features

* **backend:** allowlist de IP no ingest + trust proxy (ADR-0001, defesa em profundidade) ([58356af](https://github.com/ZzPowerTech/ausTvSales/commit/58356afbd0441ff903e6734de8f849e7006b2ef3))
* **backend:** allowlist de IP no ingest + trust proxy (ADR-0001, defesa em profundidade) ([d8589ec](https://github.com/ZzPowerTech/ausTvSales/commit/d8589ec41617fb4fa6ad1953e077a7ef6b0b2993))

## [0.6.0](https://github.com/ZzPowerTech/ausTvSales/compare/backend-v0.5.0...backend-v0.6.0) (2026-07-17)


### Features

* **backend:** POST /sales idempotente com validacao de catalogo [S2.2] ([9d469c0](https://github.com/ZzPowerTech/ausTvSales/commit/9d469c0bdbcb49f16a813492880da4df60d95774))
* **backend:** POST /sales idempotente com validação de catálogo [S2.2] ([f355927](https://github.com/ZzPowerTech/ausTvSales/commit/f3559271c5ee45ae1a7ca46a000db726b76dfa92))


### Bug Fixes

* **backend:** upsert de player concorrencia-safe (review Copilot [#56](https://github.com/ZzPowerTech/ausTvSales/issues/56)) ([91af561](https://github.com/ZzPowerTech/ausTvSales/commit/91af5619dcee267ae43689053248b773b515fa82))

## [0.5.0](https://github.com/ZzPowerTech/ausTvSales/compare/backend-v0.4.0...backend-v0.5.0) (2026-07-17)


### Features

* **backend:** GET /items/sync para cache do plugin [S2.3] ([f3f02ca](https://github.com/ZzPowerTech/ausTvSales/commit/f3f02ca88208b27e29bf85bc4b0dca77c03a4714))
* **backend:** GET /items/sync para cache do plugin [S2.3] ([64e2bf5](https://github.com/ZzPowerTech/ausTvSales/commit/64e2bf53a0124e6b6a577217ca91fb32a405e695))


### Bug Fixes

* **backend:** Cache-Control private no /items/sync (review Copilot [#54](https://github.com/ZzPowerTech/ausTvSales/issues/54)) ([7826d5b](https://github.com/ZzPowerTech/ausTvSales/commit/7826d5b7010b7934742643708ed451ba4d9b45cb))

## [0.4.0](https://github.com/ZzPowerTech/ausTvSales/compare/backend-v0.3.1...backend-v0.4.0) (2026-07-17)


### Features

* **backend:** auth de ingest (API key) + rate limiting + rota stub de vendas [S2.1] ([2afed3d](https://github.com/ZzPowerTech/ausTvSales/commit/2afed3db5ea763f2f076e4d9c45eb6af52ea3066))
* **backend:** auth de ingest (API key) + rate limiting + rota stub de vendas [S2.1] ([68affc5](https://github.com/ZzPowerTech/ausTvSales/commit/68affc5233b1c052da4312f1423cdedde021556b))

## [0.3.1](https://github.com/ZzPowerTech/ausTvSales/compare/backend-v0.3.0...backend-v0.3.1) (2026-07-16)


### Bug Fixes

* **backend:** corrige entrypoint da imagem (dist/main.js em vez de dist/src) ([31c9c0c](https://github.com/ZzPowerTech/ausTvSales/commit/31c9c0cf33a67a41cef2acd528b5b9315fb280d1))
* **backend:** corrige entrypoint da imagem Docker (dist/main.js) — resolve 502 ([0d5b702](https://github.com/ZzPowerTech/ausTvSales/commit/0d5b70262493a38436d1b1e53df0dafcf818ee05))

## [0.3.0](https://github.com/ZzPowerTech/ausTvSales/compare/backend-v0.2.0...backend-v0.3.0) (2026-07-16)


### Features

* **backend:** login por Discord + catálogo protegido por auth ([e919d5b](https://github.com/ZzPowerTech/ausTvSales/commit/e919d5b0558dedb8497b8594ed0d02639b4cc9f5))
* login por Discord (2 usuários) + catálogo protegido — Sprint 1 ([0230000](https://github.com/ZzPowerTech/ausTvSales/commit/023000086775f94c52fcb7b6a1de469de4241de6))


### Bug Fixes

* **backend:** ajustes do review do PR [#44](https://github.com/ZzPowerTech/ausTvSales/issues/44) ([3092d77](https://github.com/ZzPowerTech/ausTvSales/commit/3092d778a425ded20b4ced20af2d31855a2416ed))

## [0.2.0](https://github.com/ZzPowerTech/ausTvSales/compare/backend-v0.1.0...backend-v0.2.0) (2026-07-16)


### Features

* **backend:** aplicar migrations no boot via drizzle-orm migrator ([47a9242](https://github.com/ZzPowerTech/ausTvSales/commit/47a9242695173261a18d7e70937e9f00108de97e))

## [0.1.0](https://github.com/ZzPowerTech/ausTvSales/compare/backend-v0.0.1...backend-v0.1.0) (2026-07-14)


### Features

* **backend:** schema PostgreSQL via Drizzle + camada de persistência (S1.2) ([c984143](https://github.com/ZzPowerTech/ausTvSales/commit/c98414351363ef38b90d14e6fbc0dd6a0a49fb60))
* **backend:** schema PostgreSQL via Drizzle + camada de persistência (S1.2) ([489da13](https://github.com/ZzPowerTech/ausTvSales/commit/489da13567ae4f47620c27ab25df999f54df0330))


### Bug Fixes

* **backend:** aplica feedback do review do Copilot no PR [#33](https://github.com/ZzPowerTech/ausTvSales/issues/33) ([c3fe2c7](https://github.com/ZzPowerTech/ausTvSales/commit/c3fe2c774a5acff05b03616e82ec31bb90ec660c))
