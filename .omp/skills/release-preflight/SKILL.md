---
name: release-preflight
description: Read-only release-readiness audit for @andvl1/omp-workflows (this monorepo) — deterministic PASS/FAIL/BLOCKED checks of versions, peer range, changelog, marketplace metadata, tag and tree state before any version bump or tag push. NEVER mutates: no edits, no npm version, no tags, no pushes. Not a generic release checklist — every check targets this repo's files and release.yml contract. Use when the user asks release preflight, is the repo release-ready, check readiness before release, audit before publishing, проверить готовность к релизу, префлайт релиза, можно ли публиковать. For actually preparing/publishing use release-process; for checking an already pushed release use release-verify.
---

# Release Preflight — read-only аудит готовности omp-workflows

Детерминированный аудит ДО любых мутаций (bump, тег, push). **Read-only**: никаких
изменений файлов, `npm version`, тегов и push'ей — только чтение и вывод вердикта.
Проверки привязаны к конкретным файлам ЭТОГО репо — не обобщай.

Контракт репозитория (при спорных фактах): `../release-process/references/release-contract.md`.

## Проверки (каждая → PASS / FAIL / BLOCKED)

1. **Дерево чистое** — в релиз-релевантных путях нет незакоммиченных изменений:
   `git status --porcelain -- CHANGELOG.md packages/core/package.json packages/fullstack/package.json package-lock.json .omp-plugin/marketplace.json .github/workflows/release.yml`.
   Любая строка в выводе → FAIL.
2. **Версии пакетов** — `packages/core/package.json` и `packages/fullstack/package.json`
   имеют ОДИНАКОВУЮ версию. Если задана целевая `X.Y.Z`, обе уже подготовленные версии
   должны ей соответствовать; для pre-bump baseline целевую версию не передавай.
   Расхождение → FAIL.
3. **Peer-контракт** — `packages/fullstack/package.json` →
   `peerDependencies["@andvl1/omp-workflows-core"]` == `^<major>.<minor>.0`
   (major.minor от версии п.2). Иначе → FAIL.
4. **Changelog** — в корневом `CHANGELOG.md` есть первая секция `## [<version>]`
   (до следующего `## `; допустимо `## [0.18.0] — 2026-08-08`). Нет → FAIL.
5. **Marketplace** — `.omp-plugin/marketplace.json`: `metadata.version` == версии п.2;
   описание НЕ содержит удалённых команд (team-next, team-yolo, pulse, coordinator-stats);
   счётчики (agents/skills/commands) не скопированы вслепую — сверь с реальными пакетами.
   Несоответствие → FAIL.
6. **Тег свободен** — `git tag -l "v<version>"` пуст; при наличии remote также
   `git ls-remote origin "refs/tags/v<version>"` пуст. Тег существует → FAIL
   (перезапись тегов запрещена).
7. **e2e вне релиза** — `packages/e2e` отсутствует в `files` у `packages/core` и
   `packages/fullstack` (dev-only, не публикуется). Присутствует → FAIL.

## Вердикт

- `PASS` — все проверки PASS. Можно запускать `release-process`.
- `FAIL` — перечисли все FAIL-ы с evidence `путь:значение`; релиз не начинать.
- `BLOCKED` — факт не читается (файл отсутствует/невалиден, версия не определена) —
  укажи, что именно недоступно.

## Output

Компактная таблица: `№ | проверка | PASS/FAIL/BLOCKED | evidence (путь:значение)` +
итоговый вердикт. Только факты из файлов и git — никаких «наверное». Никаких секретов.
