# Proposal

## Why

Текущий Bash gate допускает lookup/index-refresh и узкий `unused-symbols` с ограниченными flags (baseline локальных fixes `b57045e`); `deps`, `module-route`, SQL и structural patterns остаются вне текущего allowlist. Этот proposal описывает ещё не выполненный полный допуск AST-инструмента с границей «не произвольный shell»; baseline не закрывает его acceptance/tasks.

## What Changes

- Разрешить приватным `omp-analyst` / `omp-tech-researcher` и аутентифицированному artifact-scoped orchestrator все команды анализа и управления индексом установленного `ast-index`, включая `query`, `agrep`, `clear`, `watch`, `add-root` / `remove-root`, и поддерживаемые CLI options.
- По явному выбору пользователя исключить `install-claude-plugin` и `install-codex-mcp`: эти команды меняют глобальные конфигурации Claude/Codex, а не только индекс. Допуск анализа не означает допуск всех побочных эффектов любого CLI.
- Заменить узкий verb/argument allowlist распознаванием одной команды с доверенным executable и буквальными argv. Поддержать кавычки для SQL, путей с пробелами и AST patterns; запретить shell-композиции, expansions, redirects, wrappers и подмену env/cwd.
- Сохранить existing native worker binding, role opt-in, host/claim admission и остальные source/canonical-state restrictions. Добавление/удаление AST roots и изменение index/cache — разрешённые операции самого инструмента, не право на произвольную запись исходников.
- Обновить существующие agent instructions, документацию и поведенческие regression tests; проверить настоящий CLI в owned scratch, включая контролируемую остановку `watch`.

## Capabilities

### New Capabilities

- `ast-index-execution-policy`: полная поверхность AST analysis/index management в worker/orchestrator Bash без общего shell-доступа и установки глобальных интеграций.

### Modified Capabilities

Нет: `openspec list --specs --json` возвращает пустой main-spec inventory. Исторические changes не изменяются и не архивируются этим предложением.

## Impact

- `packages/core/src/gates/read-only-bash.ts`: общий AST command predicate. В существующей композиции `packages/core/src/index.ts`, `orchestrator-write.ts` (orchestrator и worker write-scope) и `packages/core/src/gates/safety.ts` допущенные буквальные AST arguments не должны повторно трактоваться как executable shell mutations.
- `packages/core/test/read-only-bash.test.ts`: consumer-visible authorization и injection boundaries.
- `packages/omp-workflows-internal/agents/omp-analyst.md`, `omp-tech-researcher.md`, `packages/core/README.md` и Unreleased `CHANGELOG.md`: описание расширенной capability вместо lookup-only контракта.
- Отдельный новый AST tool, изменение workflow profiles/receipts/recovery, запуск чужого watcher, изменение пользовательского run, установка интеграций и общий доступ к Bash не входят в scope.
- Это planning change: runtime-права пока не изменены. Применение — отдельный apply после review; зависимости workspace и public registration API не требуют изменения.
