---
name: release-verify
description: Read-only post-release verification and failed-release diagnosis for @andvl1/omp-workflows (this monorepo) — confirm a pushed v* tag produced a green GitHub Actions run, both packages published to GitHub Packages, and a non-draft GitHub Release with changelog body; diagnose failed runs step-by-step. NEVER mutates: no retries, no re-pushes, no tag edits. Specific to this repo's release.yml pipeline — not a generic release checker. Use when the user asks verify the release, did the release succeed, check the GitHub Actions run, is the package published, release failed, релиз упал, проверить релиз, проверить публикацию. For preparing a release use release-process; for pre-push readiness use release-preflight.
---

# Release Verify — read-only верификация после тега (omp-workflows)

Проверяет УЖЕ запушенный релиз ЭТОГО репо: CI run → публикация обоих пакетов →
GitHub Release. **Read-only**: ничего не перезапускай, не пуши, не ретрай.
Диагноз — текстом; исправления — как рекомендации для `release-process`, а не действия здесь.

Контракт (порядок шагов CI, guard-ы): `../release-process/references/release-contract.md`.

## 1. Определи тег

`git tag -l "v*" --sort=-v:refname` или из запроса пользователя. Версия `X.Y.Z` = тег без `v`.

## 2. CI run

- `rtk proxy gh run list --workflow=release.yml --limit 10`.
- Найди run на ref `refs/tags/vX.Y.Z` (или последний workflow_dispatch).
- `success` → раздел 3; `failure` → раздел 5 (диагностика);
  `in_progress` → `rtk proxy gh run watch <run-id> --exit-status`, затем перечитай статус.
- Run'а нет → тег мог не дойти до origin: проверь `git ls-remote origin "refs/tags/vX.Y.Z"`.

## 3. Публикация пакетов

Оба пакета обязаны существовать в GitHub Packages (публикация строго core → fullstack):

```
npm view @andvl1/omp-workflows-core@X.Y.Z version --registry=https://npm.pkg.github.com
npm view @andvl1/omp-workflows-fullstack@X.Y.Z version --registry=https://npm.pkg.github.com
```

- core есть, fullstack нет → CI упал между двумя publish-шагами (см. раздел 5).
- core нет → publish core не выполнился.
- `packages/e2e` в проверке НЕ участвует — dev-only, не публикуется.

## 4. GitHub Release

- `rtk proxy gh release view vX.Y.Z` — существует, не draft, name = `vX.Y.Z`, тело непустое
  (пришло из первой секции `## [X.Y.Z]` корневого CHANGELOG.md).
- `prerelease: true` ожидаем ТОЛЬКО при теге с `-` (например `v0.18.0-rc.1`).

## 5. Диагностика упавшего run'а

Сопоставь fail-шаг из лога с типовыми причинами:

| Шаг CI | Типовая причина | Исправление (для release-process, не здесь) |
|---|---|---|
| Verify version matches tag | версия пакета ≠ тегу | выровнять ОБА package.json под тег, коммит, push |
| Extract release notes | нет секции `## [X.Y.Z]` в корневом CHANGELOG.md | добавить секцию до следующего `## ` |
| Install workspace dependencies | 404 на внутренних devDeps | ожидаемо для первого релиза; CI использует `npm install`, не `npm ci` — не менять |
| Publish core / fullstack | auth/registry/access | registry npm.pkg.github.com, `--access public` (репо публичное), NODE_AUTH_TOKEN=GITHUB_TOKEN |
| Create GitHub Release | пустое/отсутствующее тело | см. Extract release notes |

## Output

Evidence-отчёт: тег, run URL + conclusion, версии опубликованных пакетов (или их
отсутствие), URL/статус Release, вердикт `VERIFIED` / `FAILED` + шаг-причина.
Никаких секретов в выводе; логи с токенами не печатать.
