# Release Contract — @andvl1/omp-workflows (этот монорепо)

Точный контракт публикации ЭТОГО репозитория. Источники: `.github/workflows/release.yml`,
`packages/{core,fullstack}/package.json`, `.omp-plugin/marketplace.json`.
Обновляй только при изменении самого контракта (CI/манифестов), не при каждом релизе.
Ничего из этого файла не переноси в «дженерик релиз» — контракт привязан к omp-workflows.

## Пакеты

| Пакет | Роль | Публикуется | Порядок |
|---|---|---|---|
| `@andvl1/omp-workflows-core` | движок (workflows, классификация, DoD gate) | да | 1-й |
| `@andvl1/omp-workflows-fullstack` | агенты, скиллы, slash-команды | да | 2-й |
| `packages/e2e` | dev-only тестовая обвязка | НИКОГДА | — |

## Версии и тег

- Версии core и fullstack движутся lockstep и ОБЯЗАНЫ быть равны.
- Тег `vX.Y.Z` обязан совпадать с версией в ОБОИХ `package.json`; иначе CI падает
  на guard-шаге (который печатает команды фикса).
- Воркфлоу НЕ переписывает package.json сам — bump делает человек/агент до пуша тега.
- Пре-релиз: тег вида `vX.Y.Z-rc.N` → `prerelease: true` в GitHub Release
  (признак — тег содержит `-`).

## Peer-контракт

- `packages/fullstack/package.json` → `peerDependencies["@andvl1/omp-workflows-core"]`
  = `^<major>.<minor>.0`, где major.minor — от версии релиза (например fullstack `0.18.0`
  → peer `^0.18.0`). Полный peer-диапазон не допускается.
- `@oh-my-pi/pi-coding-agent`: `*` — не трогать.
- Следствие: fullstack ставится/публикуется ТОЛЬКО после core (peer-зависимость).

## CI-пайплайн (release.yml; триггер — push тега v*, + workflow_dispatch)

1. Checkout (`fetch-depth: 0`), Node 20, registry `https://npm.pkg.github.com`.
2. `npm install --no-audit --no-fund` — НЕ `npm ci`: `npm ci` 404-ит на внутренних
   workspace devDependencies, пока оба пакета не опубликованы.
3. `npm run build && npm run typecheck && npm test`.
4. Guard версии: версии `packages/core` и `packages/fullstack` == тег без `v`.
5. Publish core → publish fullstack: `npm publish --registry https://npm.pkg.github.com --access public`
   (репо публичное), `NODE_AUTH_TOKEN=secrets.GITHUB_TOKEN` (достаточно: публикация в
   namespace той же организации + Release через API того же репозитория).
6. Release notes: корневой `CHANGELOG.md`, ПЕРВАЯ секция `## [<version>]`
   (awk-матч, обрыв на следующем `## `; может иметь вид `## [0.18.0] — 2026-08-08`).
   Отсутствие/пустота секции — жёсткий fail, а не пустой Release.
7. GitHub Release: `softprops/action-gh-release@v2`, name `v<version>`, body из п.6.

- Concurrency: группа `release-${{ github.ref }}`, `cancel-in-progress: false`.

## Marketplace (`.omp-plugin/marketplace.json`)

- `metadata.version` сверять с релизом при КАЖДОМ выпуске — может отставать от пакетов.
- Описание несёт счётчики agents/skills/commands — брать из реальных пакетов,
  никогда не копировать прошлые числа и имена команд.
- Удалённые команды не возвращать: `team-next`, `team-yolo`, `pulse`, `coordinator-stats`.

## Харды

- Никогда `git add .` / `git add -A` в релизном коммите — только целевые файлы
  (CHANGELOG.md, оба package.json, package-lock.json при изменении, marketplace.json).
- Никаких секретов/токенов в выводе, коммитах и отчётах.
- `packages/e2e` не публикуется и не должна появляться в `files` публикуемых пакетов.
- Существующий тег `vX.Y.Z` не перезаписывать — это повод остановиться и разобраться.
