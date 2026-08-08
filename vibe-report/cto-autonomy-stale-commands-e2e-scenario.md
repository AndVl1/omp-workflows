# CTO Autonomy / Session / Stale-Commands — E2E Scenario

Slug: cto-autonomy-stale-commands · Дата: 2026-08-08 · Платформы: Backend (runtime)

Источник правды для manual-QA финальной проверки. Перед каждым validation action
перечитать этот файл; выполненные `[x]` не повторять. При ошибке зафиксировать
результат и оставить шаг `[ ]`.

## Контекст

- Branch: `fix/cto-autonomous-command-state`
- Source-of-truth contract: `.work-state/diagnosis.json` (RC1..RC6)
- Fix artifacts:
  - `packages/core/src/commands/envelope.ts` (новый общий автономный парсер)
  - `packages/core/src/commands/{cto,do-work,team}.ts` (используют парсер)
  - `packages/core/src/cto/{run,state,types}.ts` (ownership, terminality, RC4/5)
  - `packages/fullstack/src/copy-commands.ts` + `scripts/copy-commands.mjs` (RC6)
  - новые тесты:
    - `packages/core/test/envelope.test.ts`
    - `packages/core/test/do-work-autonomy.test.ts`
    - `packages/core/test/cto-ownership.test.ts`
    - `packages/fullstack/test/copy-prune.test.ts`
- Режим manual-QA: **runtime** (Node-process + скрипты), без live omp PTY — все
  сценарии покрываются in-process assertions.

## Подготовка

- [x] Создать /tmp/cto-autonomy-stale-2026-08-08/ для логов и уникальный prefix
- [x] Сборка core: `npm run build -w @andvl1/omp-workflows-core` → exit 0
- [x] Сборка fullstack: `npm run build -w @andvl1/omp-workflows-fullstack` → exit 0
- [x] Сборка e2e (для вспомогательных helpers): `npm run build -w @andvl1/omp-workflows-e2e` → exit 0
- [x] Typecheck всех 3 пакетов: `npm run typecheck --workspaces` → exit 0

## Scenario 1 — /cto exact [AUTONOMOUS] renders Autonomous mode ON

Given: parseAutonomousDirective, parseCtoEnvelope, parseWorkEnvelope,
buildDoWorkPrompt
When: передаём `[AUTONOMOUS] Fix the 500 error`
Then: `{autonomous:true, task:"Fix the 500 error"}` + prompt содержит
`Autonomous mode: ON` + `state.autonomous: true`

Result: PASS
Evidence: `/tmp/cto-autonomy-stale-2026-08-08/s-all-scenarios.log` (S1 ✔),
исходный focused test: `/tmp/cto-autonomy-stale-2026-08-08/s-envelope.log` (14/14)

## Scenario 2 — /cto leading Russian `действуй автономно` renders ON and strips only the directive

Given: parseAutonomousDirective, parseCtoEnvelope, parseWorkEnvelope,
buildDoWorkPrompt
When: передаём `действуй автономно: исправь 500 на /api/users`
Then: `{autonomous:true, task:"исправь 500 на /api/users"}` + prompt ON +
directive НЕ leakится в rendered prompt body

Result: PASS
Evidence: `/tmp/cto-autonomy-stale-2026-08-08/s-all-scenarios.log` (S2 ✔)

## Scenario 3 — /do-work receives same natural directive, persists autonomous:true, BUG_FIX -> debug-cycle

Given: parseWorkEnvelope, buildDoWorkPrompt, classify, resolveWorkflow,
classificationGate
When: `действуй автономно: fix the login bug issue=#42`
Then:
  - envelope.autonomous === true
  - envelope.task === "fix the login bug"
  - envelope.issue === 42
  - prompt включает `Autonomous mode: ON` + `state.autonomous: true`
  - classify → BUG_FIX, resolveWorkflow(BUG_FIX, COMPLEXITY, true) === 'debug-cycle'
  - classificationGate проходит когда state.workflow='debug-cycle' && state.autonomous=true
  - classificationGate блокирует когда state.workflow='bug-fix' && state.autonomous=true

Result: PASS
Evidence: `/tmp/cto-autonomy-stale-2026-08-08/s-all-scenarios.log` (S3 ✔),
исходный focused test: `/tmp/cto-autonomy-stale-2026-08-08/s-do-work-autonomy.log` (8/8)

## Scenario 4 — [AUTONOMOUSLY] and glued/ambiguous variants remain literal task text

Given: parseAutonomousDirective, parseWorkEnvelope, buildDoWorkPrompt
When: пять вариантов:
  - `[AUTONOMOUSLY] Fix bug`
  - `[AUTONOMOUS]Fix bug` (glued)
  - `Fix [AUTONOMOUS] bug` (mid-text)
  - `[AUTONOMOUS without closing bracket` (truncated)
  - `продолжай автономно работать` (unapproved phrasing)
Then: для всех пяти `autonomous:false` + `task` остаётся идентичным входу,
никакого corruption. buildDoWorkPrompt рендерит OFF + `state.autonomous: false`
+ task text в render body verbatim.

Result: PASS
Evidence: `/tmp/cto-autonomy-stale-2026-08-08/s-all-scenarios.log` (S4 ✔),
исходный focused test: `/tmp/cto-autonomy-stale-2026-08-08/s-envelope.log` (14/14)

## Scenario 5 — Foreign session gets fresh contract; same-session amend still works

Given: runCto({owner_session:'sess-A'}), findActiveCtoRun
When:
  - findActiveCtoRun(root, {sessionId:'sess-A'}) → runId видим
  - findActiveCtoRun(root, {sessionId:'sess-B'}) → null
  - findActiveCtoRun(root) (presence) → runId видим
Then: ownership isolation работает; sess-B не амендит чужой task run.

Result: PASS
Evidence: `/tmp/cto-autonomy-stale-2026-08-08/s-all-scenarios.log` (S5 ✔),
исходный focused test: `/tmp/cto-autonomy-stale-2026-08-08/s-cto-ownership.log` (5/5)

## Scenario 6 — Standby run remains cross-session adoptable

Given: newCtoState({standby:true}), writeCtoState, findActiveCtoRun
When: каждый из sess-A, sess-B, undefined ищет active run
Then: каждый находит standby runId, state.standby=true сохраняется.

Result: PASS
Evidence: `/tmp/cto-autonomy-stale-2026-08-08/s-all-scenarios.log` (S6 ✔)

## Scenario 7 — Run with all teams and integration done is not active even when pause is none

Given: runCto, setTeamStatus, setIntegration, isCtoRunTerminal, findActiveCtoRun
When: оба team'а done + integration done, pause.kind = none
Then: isCtoRunTerminal === true, findActiveCtoRun === null

Result: PASS
Evidence: `/tmp/cto-autonomy-stale-2026-08-08/s-all-scenarios.log` (S7 ✔)

## Scenario 8 — Copy-commands seed + prune + manifest + discovery exclusion

Given: ensureCommandsForSession, copyCommandsForInstall, pruneStaleCommands,
resolveShippedCommandsDir
When: seed team-next/team-yolo/pulse/coordinator-stats + user-owned + _lib;
sync через session bootstrap и install path
Then:
  - все четыре legacy plugin-owned dirs удалены
  - user-owned и _lib сохранены
  - .omp-shipped.json manifest содержит shipped set (cto, do-work, init-team,
    interview, omp-model-roles, team)
  - resolveShippedCommandsDir не возвращает legacy dirs
  - JSON файл манифеста — это .json файл, не директория — discovery его не
    подхватывает
  - Симуляция OMP discovery (scan <dir>/<name>/index.ts) видит только
    current shipped set + user-owned

Result: PASS
Evidence:
  - `/tmp/cto-autonomy-stale-2026-08-08/s-all-scenarios.log` (S8 ✔ + S8b ✔ + S8c ✔)
  - `/tmp/cto-autonomy-stale-2026-08-08/s-copy-prune.log` (5/5 focused tests)
  - `/tmp/cto-autonomy-stale-2026-08-08/s8-copy-commands-manifest.json` (содержимое манифеста)
  - `/tmp/cto-autonomy-stale-2026-08-08/s8-shipped-listing.log` (список shipped)
  - `/tmp/cto-autonomy-stale-2026-08-08/s8-discovery.log` (PRE=5 stale → POST=7 current+user)

## Scenario 9 — copy-commands.mjs script path (postinstall / manual CLI)

Given: `node packages/fullstack/scripts/copy-commands.mjs` против временного
проекта
When: запускаем скрипт против временного проекта с seeded legacy dirs
Then: legacy dirs удалены, manifest обновлён, exit code 0, stdout содержит
"pruned stale plugin-owned commands: ..."

Result: PASS
Evidence: `/tmp/cto-autonomy-stale-2026-08-08/s9-script-stdout.log` (скрипт
выводит "pruned stale plugin-owned commands: coordinator-stats, pulse,
team-next, team-yolo", exit 0)

## Scenario 10 — Repeat key scenarios for leakage / order dependence

Re-run S1, S4, S5, S8 последовательно дважды на одних и тех же fixtures:
  - Parser idempotent: parseAutonomousDirective одинаковых inputs →
    deep-equal outputs
  - Same-fixture re-read: findActiveCtoRun на той же root возвращает тот же
    runId
  - Mutation через setTeamStatus не меняет runId
  - pruneStaleCommands идемпотентна: второй вызов возвращает []
  - Order dependence не выявлен: добавление нового stale после sync
    корректно pruneится на следующем вызове

Result: PASS
Evidence: `/tmp/cto-autonomy-stale-2026-08-08/s-all-scenarios.log` (S10 ✔)

## Acceptance

- [x] Все 10 сценариев выше дают PASS на свежем, не модифицированном исходном коде.
- [x] Если существующий тест падает — изолировать и зафиксировать перед повтором.
  (S10 first run failed: comparison of time-based runIds across separate
   fixtures — adjusted assertion to compare stems excluding only the seq
   counter; the fix is the assertion, not the code. Code untouched.)
- [x] Никаких правок production/test файлов.
- [x] Cleanup: временные проекты под /tmp/cto-autonomy-stale-2026-08-08/ удалены.

## Cleanup

- [x] Все spawned processes (запуски node test, spawnSync для copy-commands.mjs) —
  завершены корректно; `jobs -l` пуст, `ps grep` не находит остатков моего
  runner'а. Pre-existing процессы omp-ux-e2e-detach (от других сессий) не
  относятся к моей работе.
- [ ] Директория /tmp/cto-autonomy-stale-2026-08-08/ — оставлена как часть
  evidence-трейла (все логи, манифест, runner script). Будет удалена
  пользователем вручную или в рамках автоматического tmp cleanup.