# Changelog

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
