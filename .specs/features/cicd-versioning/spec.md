# Spec — Versionamento independente + CI/CD + Auto-update do plugin

- **Status:** aprovado (Murilo, 2026-07-14)
- **Feature branch base:** `claude/github-actions-versioning-cicd-0de7da`
- **Relacionado:** [`CLAUDE.md`](../../../CLAUDE.md), [`.specs/project/PROJECT.md`](../../project/PROJECT.md)

## 1. Problema

O monorepo `austv-sales` (frontend / backend / plugin) já tem **CI por componente** com
path filters, mas:

1. Nenhuma versão é "carimbada" — não há tags, changelog nem releases.
2. Não há **CD**: nada publica artefatos nem faz deploy na VPS.
3. O plugin exige build manual + upload para o servidor a cada mudança.

## 2. Objetivos

- Cada pasta (`frontend`, `backend`, `plugin`) recebe **versão independente** (SemVer).
- CI/CD totalmente automatizado por componente, disparado só pelo que mudou.
- O plugin **se auto-atualiza** a partir do GitHub Release, aplicando no próximo restart
  do servidor — sem build manual nem upload.

## 3. Decisões fechadas (2026-07-14)

| Tema | Decisão |
|---|---|
| Versionamento | **release-please** (automático, lê Conventional Commits por caminho) |
| Deploy VPS | **Docker + SSH** (build → GHCR → `docker compose pull && up -d` via SSH) |
| Visibilidade do repo | **Público** → auto-update do plugin lê Releases sem token |
| Esquema de tag | prefixo por componente: `frontend-vX.Y.Z`, `backend-vX.Y.Z`, `plugin-vX.Y.Z` |
| Fonte da versão | `package.json` (front/back); `build.gradle.kts` (plugin, via marcador) |
| Aplicação do update | pasta nativa `plugins/update/` do Paper (swap automático no restart) |

## 4. Arquitetura

### 4.1 Versionamento — release-please (monorepo)

- `release-please-config.json` + `.release-please-manifest.json` na raiz.
- 3 pacotes independentes: `frontend` (node), `backend` (node), `plugin` (generic/simple
  com marcador `// x-release-please-version` no `build.gradle.kts`).
- Workflow `release-please.yml` roda no push para `main`; abre 1 Release PR por componente
  com bump de versão + CHANGELOG; ao mergear, cria tag + GitHub Release.

### 4.2 CD — um release workflow por componente

- `plugin-release.yml` (on tag `plugin-v*`): `gradlew build` → anexa `.jar` + `.jar.sha256`
  como assets do Release. É a fonte consumida pelo auto-update.
- `backend-release.yml` (on tag `backend-v*`): build imagem Docker → push GHCR → SSH → deploy.
- `frontend-release.yml` (on tag `frontend-v*`): build estático → imagem Nginx → GHCR → SSH → deploy.
- Secrets: `VPS_HOST`, `VPS_USER`, `VPS_SSH_KEY`. GHCR usa `GITHUB_TOKEN`.

### 4.3 Auto-update do plugin

No `onEnable()` (assíncrono, jamais bloqueia o boot):

1. GET `api.github.com/repos/ZzPowerTech/ausTvSales/releases` → última tag `plugin-v*`.
2. Compara com a versão do `plugin.yml`.
3. Se maior → baixa o `.jar`, valida `sha256`, grava em `plugins/update/`.
4. Próximo restart → Paper aplica automaticamente.

Config `config.yml`:
```yaml
auto-update:
  enabled: true
  notify-only: false   # true = só loga "update disponível", não baixa
```
Falha de rede/GitHub → warn no log e segue normalmente.

## 5. Requisitos de segurança (bloqueiam merge)

- Auto-update valida o **checksum sha256** do `.jar` baixado antes de gravar.
- Download só de `github.com` / `api.github.com` (host allowlist) e do repo oficial.
- Nunca travar o startup do servidor por falha de rede.
- Revisão obrigatória do `cybersecurity-validator` na PR #3.

## 6. Fatiamento em PRs (1 PR = 1 responsabilidade)

| # | PR | Escopo | Subagent |
|---|---|---|---|
| 1 | `chore(ci): release-please` | versionamento automático dos 3 componentes | devops |
| 2 | `ci(plugin): publica jar no release` | `plugin-release.yml` + checksum | devops |
| 3 | `feat(plugin): auto-update via plugins/update` | classe `UpdateChecker` + `config.yml` | gamedev + cybersecurity |
| 4 | `ci(backend): docker + deploy VPS` | `Dockerfile` + `backend-release.yml` + SSH | devops |
| 5 | `ci(frontend): docker + deploy VPS` | `Dockerfile` Nginx + `frontend-release.yml` | devops + frontend |

## 7. Critérios de aceite

- [ ] Commit `feat:`/`fix:` em uma pasta gera Release PR só daquele componente.
- [ ] Merge do Release PR cria tag prefixada + GitHub Release com CHANGELOG.
- [ ] Release do plugin publica `.jar` + `.jar.sha256` como assets.
- [ ] Plugin com auto-update detecta versão nova, baixa para `plugins/update/` e aplica no restart.
- [ ] Release do backend/frontend publica imagem no GHCR e faz deploy na VPS via SSH.
- [ ] `auto-update.enabled: false` desativa completamente a checagem.
