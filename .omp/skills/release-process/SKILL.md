---
name: release-process
description: Coordinating end-to-end release of @andvl1/omp-workflows (this monorepo) to GitHub Packages — prepare metadata (versions, changelog, marketplace), validate, commit, tag and push the v* tag, then hand off to verification. MUTATING: edits files, creates a commit and a tag. Not a generic release tool — applies only to this repo's release.yml contract. Use when the user asks to prepare/bump/publish a release, release v1.2.3, bump version, make a release, выпусти релиз, подготовь релиз, забампай версию. For read-only readiness use release-preflight; for checking an already pushed release use release-verify.
---

# Release Process — координатор релиза omp-workflows (MUTATING)

Выполняет релиз этого монорепо end-to-end: metadata → validate → commit → tag/push →
hand off на верификацию. **Меняет репозиторий** (файлы, коммит, тег) — поэтому сначала preflight.

Точный контракт репозитория (порядок публикации, peer-диапазон, changelog, marketplace,
харды): `references/release-contract.md`. Прочитай его, не пересказывай здесь.
Всё ниже специфично для omp-workflows — не превращай в общий «как делать релизы».

## 0. Preflight обязателен

1. Прочитай и выполни `.omp/skills/release-preflight/SKILL.md` (read-only аудит готовности,
   без передачи будущей версии — проверяется чистый baseline текущего релиза).
2. Вердикт ≠ `PASS` → СТОП. Чини FAIL-ы (сам или отдельной задачей), повторяй preflight до PASS.
3. Без прошедшего preflight релиз не начинать.

## 1. Metadata

1. Целевая версия `X.Y.Z` — semver bump (patch/minor/major; пре-релиз `X.Y.Z-rc.N`).
2. Выровняй версии: `packages/core/package.json` и `packages/fullstack/package.json` → `X.Y.Z`
   (в каждом пакете `npm version X.Y.Z --no-git-tag-version --allow-same-version` или правка вручную;
   значения ОБЯЗАНЫ совпадать).
3. Peer-контракт: `packages/fullstack/package.json` →
   `peerDependencies["@andvl1/omp-workflows-core"]` = `^<major>.<minor>.0` (major.minor от `X.Y.Z`;
   для patch-bump, например `0.18.1`, диапазон НЕ меняется — остаётся `^0.18.0`).
4. Changelog: добавь в корневой `CHANGELOG.md` секцию `## [X.Y.Z] — <дата>` (Keep-a-Changelog,
   `### Added/Fixed/Changed`) — первая секция `## [X.Y.Z]` уйдёт в тело GitHub Release.
5. Marketplace: синхронизируй `.omp-plugin/marketplace.json` — `metadata.version` = `X.Y.Z`,
   счётчики (agents/skills/commands) сверь с реальными пакетами. Не копируй старые числа;
   не возвращай удалённые команды (team-next, team-yolo, pulse, coordinator-stats).

## 2. Validate (read-only, до коммита)

Детерминированные проверки по фактам файлов:
- версии обоих пакетов равны `X.Y.Z`;
- peer-диапазон = `^<major>.<minor>.0`;
- первая секция корневого `CHANGELOG.md` = `## [X.Y.Z]`;
- `metadata.version` marketplace = `X.Y.Z`, в описании нет удалённых команд;
- `packages/e2e` отсутствует в `files` публикуемых пакетов (dev-only, не публикуется).

## 3. Commit

- `git add` — ТОЛЬКО конкретные файлы: `CHANGELOG.md`, `packages/core/package.json`,
  `packages/fullstack/package.json`, `package-lock.json` (если изменился),
  `.omp-plugin/marketplace.json`. **НИКОГДА** `git add .` / `git add -A`.
- Сообщение: `chore(release): vX.Y.Z` (Conventional Commits).

## 4. Tag & push

1. Перед созданием проверь: `git tag -l "vX.Y.Z"` пуст. Существующий тег НЕ перезаписывай.
2. `git tag vX.Y.Z` (на релизном коммите).
3. `git push origin <branch>` и `git push origin vX.Y.Z`.
4. Релизный коммит не должен содержать правки CI/скриптов — только metadata/версии/changelog.

## 5. Hand off

После пуша тега `release.yml` стартует сам. Прочитай и выполни
`.omp/skills/release-verify/SKILL.md` (read-only): CI run → публикация обоих пакетов →
GitHub Release. Сам после пуша ничего не «проверяй» и не ретрай — это роль release-verify.

## Харды (детали — в контракте)

- CI использует `npm install`, а НЕ `npm ci` (npm ci 404-ит на внутренних workspace
  devDependencies до первой публикации) — не меняй это в релизном контексте.
- Публикация строго core → fullstack (fullstack peer-зависит от core).
- Тег обязан совпадать с версиями обоих пакетов — guard падает иначе.
- Никаких секретов/токенов в выводе и коммитах; никаких ссылок на удалённые команды.

## Output

Компактный отчёт: целевая версия, изменённые файлы, hash релизного коммита, тег `vX.Y.Z`,
указание передать верификацию в `release-verify`. Без секретов и лишних логов.
