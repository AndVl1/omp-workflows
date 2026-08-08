# CTO Autonomy / Session / Stale-Commands — manual-QA report

- **Дата**: 2026-08-08
- **Branch**: `fix/cto-autonomous-command-state`
- **Mode**: runtime (Node-process assertions, no live PTY)
- **Slug**: cto-autonomy-stale-commands
- **Verdict**: **PASS**

## Контекст

`.work-state/diagnosis.json` фиксирует 6 root causes (RC1..RC6) и перечисляет
invariants:

1. One shared deterministic autonomous parser feeds cto/do-work/team,
   preserves the resolved flag in state, renders non-contradictory metadata.
2. Exact `[AUTONOMOUS]` and approved leading natural-language directives
   enable autonomy; ambiguous text remains task text; lookalike prefixes never
   corrupt input.
3. LLM PHASE-0 and engine classification consume the same parsed flag.
4. Interactive tasks amend only same-session runs; standby runs remain
   cross-session adoptable; foreign active runs are not amended.
5. All teams done plus integration done is terminal even without pause.kind
   done/failed.
6. Command synchronization converges to the shipped set while preserving
   explicitly user-owned commands.

Fix branch delivers новый общий парсер в `packages/core/src/commands/envelope.ts`,
прогоняет `cto.ts` / `do-work.ts` / `team.ts` через него, добавляет ownership
в `CtoState`, расширяет terminality в `isCtoRunTerminal`, и реализует prune
в `packages/fullstack/src/copy-commands.ts` + `scripts/copy-commands.mjs`.

## Подготовка

| Команда | Exit | Лог |
|---|---|---|
| `mkdir -p /tmp/cto-autonomy-stale-2026-08-08` | 0 | n/a |
| `npm run build -w @andvl1/omp-workflows-core` | 0 | stdout: `> tsc` |
| `npm run build -w @andvl1/omp-workflows-fullstack` | 0 | stdout: `> tsc` |
| `npm run build -w @andvl1/omp-workflows-e2e` | 0 | stdout: `> tsc` |
| `npm run typecheck --workspaces` | 0 | все 3 пакета OK |

## Summary (агрегировано из 12 in-process scenario tests)

```
ℹ tests 12
ℹ suites 0
ℹ pass 12
ℹ fail 0
ℹ duration_ms 284.232
```

Полный лог: `/tmp/cto-autonomy-stale-2026-08-08/s-all-scenarios.log`.
Source-тесты (фиксированные в коде, не in-process):

| Suite | Tests | Pass | Fail | Лог |
|---|---|---|---|---|
| `core/test/envelope.test.ts` | 14 | 14 | 0 | `s-envelope.log` |
| `core/test/do-work-autonomy.test.ts` | 8 | 8 | 0 | `s-do-work-autonomy.log` |
| `core/test/cto-ownership.test.ts` | 5 | 5 | 0 | `s-cto-ownership.log` |
| `core/test/cto-command.test.ts` + `cto-amend.test.ts` (regression) | 16 | 16 | 0 | `s-cto-cmd-existing.log` |
| `fullstack/test/copy-prune.test.ts` (new) | 5 | 5 | 0 | `s-copy-prune.log` |
| `fullstack/test/copy-commands.test.ts` (existing) | 5 | 5 | 0 | `s-copy-commands-existing.log` |
| `fullstack/test/cto-command.test.ts` + `team-command.test.ts` | 26 | 26 | 0 | `s-fullstack-existing.log` |
| `core` aggregate (`npm run test:core`) | 222 | 222 | 0 | `s-core-all.log` |
| `fullstack` aggregate (`npm run test:fullstack`) | 168 | 168 | 0 | `s-fullstack-all.log` |
| `e2e` aggregate (`npm run test`) | 73 | 73 | 0 | `s-e2e-all.log` |
| `e2e` mock-OMP CTO inbox scenario | 1 | 1 | 0 | `s-cto-inbox-mock.log` |

**Итого**: 12/12 scenario, 222/222 core, 168/168 fullstack, 73/73 e2e.

## Per-scenario results (Given / When / Then)

### Scenario 1 — /cto exact [AUTONOMOUS] renders Autonomous mode ON

**Given**: parseAutonomousDirective, parseCtoEnvelope, parseWorkEnvelope,
buildDoWorkPrompt на изолированной mkdtemp root.

**When**: вход — `[AUTONOMOUS] Fix the 500 error`.

**Then** (наблюдаемые assertions):
- `parseAutonomousDirective("[AUTONOMOUS] Fix the 500 error")` →
  `{ autonomous: true, task: "Fix the 500 error" }`
- `parseCtoEnvelope("[AUTONOMOUS] Fix the 500 error")` → `autonomous: true`
- `buildDoWorkPrompt(envelope, root)` содержит
  - `Autonomous mode: ON`
  - `state.autonomous: true`

**Status**: PASS — 26.8 ms.

### Scenario 2 — /cto leading Russian `действуй автономно` renders ON and strips only the directive

**Given**: те же четыре функции.

**When**: вход — `действуй автономно: исправь 500 на /api/users`.

**Then**:
- `parseAutonomousDirective(...)` → `{ autonomous: true, task: "исправь 500 на /api/users" }`
- `parseCtoEnvelope(...)` → `autonomous: true`
- `parseWorkEnvelope(...)` → `task: "исправь 500 на /api/users"`, `autonomous: true`
- `buildDoWorkPrompt` содержит `Autonomous mode: ON`, `state.autonomous: true`,
  `исправь 500 на /api/users`, и **НЕ** содержит literal `действуй автономно` в
  rendered body.

**Status**: PASS — 24.4 ms.

### Scenario 3 — /do-work receives same natural directive, persists autonomous:true, BUG_FIX -> debug-cycle

**Given**: parseWorkEnvelope, buildDoWorkPrompt, classify, resolveWorkflow,
classificationGate, временный `.work-state/team-state.json`.

**When**: вход — `действуй автономно: fix the login bug issue=#42`.

**Then**:
- `envelope.autonomous === true`
- `envelope.task === "fix the login bug"` (issue-marker stripped)
- `envelope.issue === 42`
- prompt содержит `Autonomous mode: ON` + `state.autonomous: true`
- `classify("fix the login bug", { autonomous: true })` → `{ type: "BUG_FIX", complexity: "MEDIUM", ... }`
- `resolveWorkflow("BUG_FIX", "MEDIUM", true) === "debug-cycle"`
- state `{ workflow: "debug-cycle", autonomous: true }` → `classificationGate` пропускает (return undefined)
- state `{ workflow: "bug-fix", autonomous: true }` → `classificationGate` блокирует, reason
  содержит `expected 'debug-cycle'`

**Status**: PASS — 13.0 ms.

### Scenario 4 — [AUTONOMOUSLY] and glued/ambiguous variants remain literal task text

**Given**: parseAutonomousDirective, parseWorkEnvelope, buildDoWorkPrompt.

**When**: пять inputs:
1. `[AUTONOMOUSLY] Fix bug`
2. `[AUTONOMOUS]Fix bug` (glued, no separator)
3. `Fix [AUTONOMOUS] bug` (token mid-text)
4. `[AUTONOMOUS without closing bracket` (truncated)
5. `продолжай автономно работать` (unapproved phrasing)

**Then**: для всех пяти:
- `parseAutonomousDirective(input).autonomous === false`
- `parseAutonomousDirective(input).task === input` (verbatim)
- `parseWorkEnvelope(input, root).autonomous === false`
- `parseWorkEnvelope(input, root).task === input`
- `buildDoWorkPrompt(envelope, root)` содержит
  - `Autonomous mode: OFF`
  - `state.autonomous: false`

**Status**: PASS — 57.0 ms (5 inputs × 4 assertions each = 20 assertions).

### Scenario 5 — Foreign session gets fresh contract; same-session amend still works

**Given**: runCto с `owner_session: "sess-A"`, findActiveCtoRun.

**When**:
- `findActiveCtoRun(root, { sessionId: "sess-A" })` — owner lookup
- `findActiveCtoRun(root, { sessionId: "sess-B" })` — foreign lookup
- `findActiveCtoRun(root)` — session-less presence lookup

**Then**:
- owner runId === `res.plan.id` (тот же run виден)
- foreign → `null` (не амендит чужой task run)
- sessionless runId === `res.plan.id` (presence detection работает)

**Status**: PASS — 1.8 ms.

### Scenario 6 — Standby run remains cross-session adoptable

**Given**: newCtoState с `standby: true`, writeCtoState, findActiveCtoRun.

**When**: каждый из `sess-A`, `sess-B`, `undefined` ищет active run.

**Then**: для каждого:
- `active.runId === "standby-1"`
- `active.state.standby === true`

**Status**: PASS — 0.8 ms.

### Scenario 7 — Run with all teams and integration done is not active even when pause is none

**Given**: runCto с двумя командами, setTeamStatus, setIntegration,
isCtoRunTerminal, findActiveCtoRun.

**When**:
- оба team'а set в `done` через setTeamStatus
- integration set в `done` через setIntegration
- `pause.kind === "none"` (по умолчанию)

**Then**:
- intermediate state (один team done, integration done) → `isCtoRunTerminal === false`,
  `findActiveCtoRun` возвращает runId
- final state (оба team done + integration done) →
  - `isCtoRunTerminal === true`
  - `findActiveCtoRun === null` (terminal не селектится)

**Status**: PASS — 1.0 ms.

### Scenario 8 — Copy-commands seed + prune + manifest + discovery exclusion

**Given**: `ensureCommandsForSession`, `copyCommandsForInstall`,
`pruneStaleCommands`, `resolveShippedCommandsDir`,
LEGACY_REMOVED_COMMANDS = ["team-next", "team-yolo", "pulse", "coordinator-stats"].

**When**:
- seed все 4 legacy + `my-custom-helper` + `_lib/util.ts`
- вызвать `ensureCommandsForSession` (session bootstrap path)
- вызвать `copyCommandsForInstall` (install / postinstall path)
- вызвать `pruneStaleCommands(target, ["cto", "do-work"])` напрямую (pure helper)

**Then**:
- Все 4 legacy dirs удалены (`existsSync === false` для каждого)
- `my-custom-helper` сохранён
- `_lib` сохранён
- `do-work`, `cto`, `team` присутствуют (current shipped)
- `.omp/commands/.omp-shipped.json` (manifest) — это **файл** (не директория),
  `existsSync(".omp-shipped.json/index.ts") === false`
- manifest.shipped содержит `["cto", "do-work", "init-team", "interview",
  "omp-model-roles", "team"]`, **не** содержит ни одной legacy name
- `resolveShippedCommandsDir()` (файловая система shipped) — ни одного legacy dir
- `pruneStaleCommands` идемпотентна: второй вызов возвращает `[]`
- `copyCommandsForInstall` (install path) тоже pruneит legacy и сохраняет user-owned
- **Симуляция OMP discovery** (scan `<dir>/<name>/index.ts`): pre-sync видит
  `[coordinator-stats, pulse, team-next, team-yolo, user-keep]`, post-sync видит
  `[cto, do-work, init-team, interview, omp-model-roles, team, user-keep]` — ни
  одного legacy имени в discovery.

**Status**: PASS — S8 5.1 ms, S8b 3.5 ms, S8c 1.7 ms, discovery-script 0.1 s.

**Evidence**:
- `/tmp/cto-autonomy-stale-2026-08-08/s8-discovery.log`:
  ```
  PRE-sync discovery: ["coordinator-stats","pulse","team-next","team-yolo","user-keep"]
  POST-sync discovery: ["cto","do-work","init-team","interview","omp-model-roles","team","user-keep"]
  PASS: discovery does not select any removed name; user-owned preserved.
  ```
- `/tmp/cto-autonomy-stale-2026-08-08/s8-copy-commands-manifest.json` (содержимое
  манифеста после script path):
  ```json
  { "schema": 1, "shipped": ["cto","do-work","init-team","interview","omp-model-roles","team"] }
  ```
- `/tmp/cto-autonomy-stale-2026-08-08/s8-shipped-listing.log` (содержимое
  `packages/fullstack/commands/`): cto, do-work, init-team, interview,
  omp-model-roles, team — ни одного legacy.

### Scenario 9 — copy-commands.mjs script path

**Given**: `node /Users/a.vladislavov/projects/oss/omp-workflows-monorepo/packages/fullstack/scripts/copy-commands.mjs`
против `/tmp/s9-script-iso` с seeded `team-next`, `team-yolo`, `pulse`,
`coordinator-stats`, `user-keep`.

**When**: spawnSync node с `OMP_PROJECT_DIR=/tmp/s9-script-iso` и path arg
`/tmp/s9-script-iso`.

**Then**:
- `result.status === 0`
- `result.stdout` содержит
  - `copy-commands: .../commands -> /tmp/s9-script-iso/.omp/commands`
  - per-file progress: `index.ts -> ...` (включая `_lib/cto.ts`, `config.ts`)
  - `copy-commands: pruned stale plugin-owned commands: coordinator-stats, pulse, team-next, team-yolo`
  - `copy-commands: done`
- `result.stderr` пустой
- Post-script `ls .omp/commands/` = `cto do-work init-team interview omp-model-roles team user-keep`
- `user-keep` сохранён (user-owned)
- `.omp-shipped.json` записан

**Status**: PASS — 48.7 ms (script runtime).

**Evidence**: `/tmp/cto-autonomy-stale-2026-08-08/s9-script-stdout.log`:
```
copy-commands: .../commands -> /tmp/s9-script-iso/.omp/commands
  cto.ts -> /tmp/s9-script-iso/.omp/commands/cto/_lib/cto.ts
  index.ts -> /tmp/s9-script-iso/.omp/commands/cto/index.ts
  config.ts -> /tmp/s9-script-iso/.omp/commands/do-work/_lib/config.ts
  index.ts -> /tmp/s9-script-iso/.omp/commands/do-work/index.ts
  index.ts -> /tmp/s9-script-iso/.omp/commands/init-team/index.ts
  index.ts -> /tmp/s9-script-iso/.omp/commands/interview/index.ts
  index.ts -> /tmp/s9-script-iso/.omp/commands/omp-model-roles/index.ts
  index.ts -> /tmp/s9-script-iso/.omp/commands/team/index.ts
copy-commands: pruned stale plugin-owned commands: coordinator-stats, pulse, team-next, team-yolo
copy-commands: done
```

### Scenario 10 — Repeat key scenarios for leakage / order dependence

**Given**: тесты S1, S4, S5, S8 на одних и тех же fixtures, повторно.

**When**:
- `parseAutonomousDirective("[AUTONOMOUS] Fix the 500 error")` × 2 →
  `assert.deepEqual` pass
- `parseAutonomousDirective("[AUTONOMOUSLY] Fix bug")` × 2 →
  `assert.deepEqual` pass
- single `runCto` → repeated `findActiveCtoRun` reads на той же root → тот же
  runId; foreign session → null
- `setTeamStatus(state, "backend", "done", root)` → `findActiveCtoRun` returns
  same runId (mutation не меняет identity)
- `pruneStaleCommands(target, ["cto","do-work"])` × 2 → first call `["team-next"]`,
  second call `[]`
- после первого prune добавить новый stale (`pulse`) → `pruneStaleCommands` снова
  возвращает `["pulse"]` (order: новые stale ловятся на следующий вызов); ещё раз
  → `[]`

**Then**:
- parser deep-equal
- same-fixture re-read runId stable
- mutation preserves runId
- prune идемпотентна
- order dependence: новые stale корректно обрабатываются, нет "утечки" между
  вызовами
- foreign session всегда null (никакого residual из предыдущих вызовов)

**Status**: PASS — 2.3 ms.

## Команды, выполненные во время manual-QA

```bash
# Подготовка
mkdir -p /tmp/cto-autonomy-stale-2026-08-08
npm run build -w @andvl1/omp-workflows-core
npm run build -w @andvl1/omp-workflows-fullstack
npm run build -w @andvl1/omp-workflows-e2e
npm run typecheck --workspaces

# Source-тесты (regression coverage)
cd packages/core && node --test --import tsx test/envelope.test.ts
cd packages/core && node --test --import tsx test/do-work-autonomy.test.ts
cd packages/core && node --test --import tsx test/cto-ownership.test.ts
cd packages/core && node --test --import tsx test/cto-command.test.ts test/cto-amend.test.ts
cd packages/fullstack && node --test --import tsx test/copy-prune.test.ts
cd packages/fullstack && node --test --import tsx test/copy-commands.test.ts
cd packages/fullstack && node --test --import tsx test/cto-command.test.ts test/team-command.test.ts

# Aggregate
npm run test:core    # 222/222
npm run test:fullstack    # 168/168
npm run test -w @andvl1/omp-workflows-e2e    # 73/73

# In-process scenario runner (12 tests, scenarios 1-10 + 8b/8c sub-cases)
node --test --import tsx /tmp/scenario-runner.mjs

# Discovery simulation (S8 last invariant)
node --import tsx /tmp/cto-autonomy-stale-2026-08-08/test-discovery.mjs

# Script path (S9)
cd /tmp/s9-script-iso && \
  OMP_PROJECT_DIR=/tmp/s9-script-iso \
  node /Users/a.vladislavov/projects/oss/omp-workflows-monorepo/packages/fullstack/scripts/copy-commands.mjs
```

## Cleanup

- `node test` и `spawnSync` для copy-commands.mjs — все завершены с exit 0.
- `jobs -l` — пусто; моих spawned процессов не осталось.
- Pre-existing omp-ux-e2e-detach процессы в `ps aux` (4 шт.) принадлежат
  другим сессиям, не моей работе; я их не трогаю.
- Директория `/tmp/cto-autonomy-stale-2026-08-08/` оставлена как evidence-trail
  (логи, manifest, runner script, discovery output). Удалить вручную или через
  tmp-rotation.

## Risks / remaining concerns

- **Никаких live omp PTY-сценариев не выполнялось.** Режим manual-QA — runtime
  (Node-process assertions). Все сценарии 1-8 покрыты через in-process
  test-runner + дополнительные file-system симуляции discovery / script path.
  live-omp поведение тех же сценариев не подтверждено; но при текущем известном
  состоянии xterm/web surface (omp 17.2.9 TUI freezes — см. memory lessons от
  2026-08-06) live E2E не даст дополнительной уверенности.
- **S10 first run failed** на моей стороне: я сравнивал time-stamped runId
  между разными fixtures. Code untouched, assertion в runner-e подправлен
  (сравнение stem без sequence counter). Подтверждено, что state между
  fixtures не leakает, иначе бы S10 упал в assertion `findActiveCtoRun ===
  null` (что не так).
- **`cwd` test fixtures** — некоторые source-тесты вызывают `parseWorkEnvelope`
  с `mkdtempSync` root, который не под git, поэтому тесты логируют
  `fatal: not a git repository` через `git rev-parse` в parseWorkEnvelope. Это
  ожидаемый fallback (`branch === null`) и не блокирует assertions.
- **CtoState ownership type** — я проверил что `runCto({owner_session})`
  persistится в `findActiveCtoRun` через sessionId lookup; markdown-state с
  inline `session: sess-X` header также читается. Engine case покрыт focused
  тестом `cto-ownership.test.ts` (5/5 pass).
- **Синхронизация установленного плагина** — known issue (per memory): при
  тестировании через `omp -e repo/dist/index.js` installed plugin
  auto-loads и его session_start copy-commands OVERWRITES the -e extension's
  copies. Для live-тестов command changes: `omp plugin disable
  @andvl1/omp-workflows-fullstack` (re-enable after). К моей manual-QA не
  относится, но упомянуто для downstream reviewer'а.

## Acceptance

- [x] Все 10 сценариев PASS на свежем, не модифицированном исходном коде.
- [x] Существующие тесты не регрессировали: 222/222 core, 168/168 fullstack,
  73/73 e2e.
- [x] Никаких правок production или test файлов.
- [x] Cleanup: spawned процессы завершены; evidence-trail оставлен под
  /tmp/cto-autonomy-stale-2026-08-08/.

**Final verdict**: PASS. Manual-QA stage complete. Готово к qa_tests stage.