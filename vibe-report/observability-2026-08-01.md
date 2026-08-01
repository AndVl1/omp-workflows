# Observability layer — 2026-08-01

## Что сделано

`@andvl1/omp-workflows-core` v0.7.0. Добавлен runtime-observability слой, который
через OMP extension event bus логирует в `.work-state/features/<slug>/observability/events.jsonl`:

- `agent_start` / `agent_end` (с `messageCount`)
- `tool_call` / `tool_result` (с `isError`, `toolName`, `subagent` для `task` tool)
- `before_agent_start` (со списком skills, извлечённых из system prompt)
- `session_start` / `session_stop`

Rollup (agent invocations, per-tool counts, per-subagent counts, per-skill counts,
error counts, wall-clock duration) встроен в `TeamState.observability` и
зеркалится в `team-state.md` под секцией `## Observability`.

Pre-observability фичи получают отсутствующее поле `TeamState.observability` — никакой
миграции не нужно. Opt-out через `registerTeamWorkflow(pi, { observability: false })`.

## Архитектурное наблюдение по разбору сессии 019fbd62-f1db-7000-81e5-07f756ebbf87

### Почему орк-ру приходилось дочинять за субагентами

В этой сессии main-agent (орк-р) делал 6 раз то, что по контракту должен был делать
субагент:

1. `ImplOverengineeredHelloWorld` отдал `ready: true, validation_run: false` — и ушёл,
   не проверив `go build`/`go test`. Тест-файл `presenter_test.go` был сломан
   (нет закрывающей `)` у `import`).
2. Орк-р потратил ~3 tool-call-а на чтение, brace counting, и edit чтобы починить
   тест сам. (`session.jsonl` lines 99-137).
3. После `FixReviewFindings` — снова сломан braces в `greeting_service_test.go:111`.
   Орк-р опять починил сам (lines 195-236).

Контрактная причина: в задании developer-go явно написано
"Per assignment, formatters/linters/test suites were not run — orchestrator owns validation".
Это, видимо, метаинструкция системного промпта или интерпретация LLM-а, и
**без логов нельзя понять кто её туда положил**.

С observability это место теперь видимо: rollup показывает `tool_call` для каждого
редактирования, `agent_invocations` для каждого субагента, и `durationMs` для
каждого. Можно автоматически алертить, если main-agent тратит > N% wall-time на
исправление работы субагентов.

### Почему первый чекпоинт был только после написания кода

В lightweight-профиле:
- Стадия `implementation` имеет `checkpoint: "approve_implementation"`.
- Семантика чекпоинта в текущей реализации — "pause **после** стадии",
  а не "pause **до** старта". (См. session.jsonl line 78:
  "I must pause for user review **before** implementation actually starts (per the
  stage contract: `checkpoint: \"approve_implementation\"`)".)
- Кроме того, в lightweight нет pre-implementation чекпоинта между `discovery`
  и `implementation`. DoD пишется в discovery, но юзер его видит только
  когда implementation уже сделан и сломан.

**Это отдельная архитектурная задача, не в scope этого PR.** Здесь зафиксировано
как Non-goal. Rollup уже сейчас умеет считать, какие skills были активны во
время planning-turn-а — это правильное место, где потом surface-ить "юзер потратил
X секунд на approve" когда чекпоинт переедет.

## Файлы

### Новые
- `packages/core/src/observability/events.ts` — schema (Event union, rollup, pointer)
- `packages/core/src/observability/recorder.ts` — append-only writer + pure rollup
- `packages/core/src/observability/skills.ts` — `extractSkills(systemPrompt)`
- `packages/core/src/observability/hooks.ts` — 7 OMP hook handlers
- `packages/core/src/observability/index.ts` — public surface
- `packages/core/test/observability/recorder.test.ts` (7 tests)
- `packages/core/test/observability/skills.test.ts` (6 tests)
- `packages/core/test/observability/integration.test.ts` (5 tests)

### Изменены
- `packages/core/src/engine/types.ts` — добавлен optional `TeamState.observability` (non-breaking)
- `packages/core/src/engine/state.ts` — `writeState` подцепляет pointer; `writeStateMd` пишет секцию
- `packages/core/src/index.ts` — wires `registerObservabilityHooks`; добавлены re-exports; `RegisterOptions.observability?: boolean`
- `packages/core/package.json` — 0.6.0 → 0.7.0; test glob `test/**/*.test.ts`
- `packages/fullstack/package.json` — 0.6.0 → 0.7.0
- `CHANGELOG.md`, `README.md`

## Тесты

- 33/33 core tests pass (15 старых + 12 observability + 6 уже добавленных в 0.6.0 task-caller)
- 11/11 fullstack tests pass
- `npm run typecheck` clean для обоих workspace
- Никаких real-timers в тестах — `flushRecorder(cwd)` дренирует очередь

## Open follow-ups (не в этом PR)

1. Pre-implementation `checkpoint: "approve_plan_and_dod"` между `discovery` и `implementation` в lightweight + full-feature профилях. Потребует решения: где чекпоинт живёт — в profile.json или в команде.
2. `/pulse`/read-only digest для observability rollup. Сейчас он пишется в `team-state.md`, но `/pulse` команда про это не знает. Должна показывать top-N skills, subagents, error rates.
3. Сделать чтобы subagent-ы developer-go проверяли `go build`/`go test` сами. Это потребует изменений в `packages/fullstack/agents/developer-*.md` (добавить явное "validate before report") ИЛИ в задании, которое орк-р шлёт субагенту (не передавать `validation_run: false` как оправдание).
