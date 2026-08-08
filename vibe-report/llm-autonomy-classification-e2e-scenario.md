# LLM Autonomy Classification — E2E Scenario

Slug: llm-autonomy-classification · Дата: 2026-08-08 · Платформа: Backend (runtime, in-process)

Источник правды для manual-QA финальной проверки. Перед каждым validation action
перечитать этот файл; выполненные `[x]` не повторять. При ошибке зафиксировать
результат и оставить шаг `[ ]`.

## Контекст

- Branch: `fix/cto-autonomous-command-state` (RC2+ регрессия — статический
  parser demoted до `autonomyHint`, PHASE-0 и P5 gate читают model
  `classification.autonomous` как единственный авторитет)
- Source-of-truth contract: `.work-state/artifacts/llm-autonomy-design.json`
- Implementation surface:
  - `packages/core/src/commands/classification-contract.ts` (shared PHASE-0)
  - `packages/core/src/commands/{cto,do-work}.ts` (consume contract)
  - `packages/core/src/gates/classification.ts` (P5 — `classificationGate` +
    `classificationToolGate`, `resolveAutonomous` — model wins over legacy)
  - `packages/core/src/engine/{run,classify,profile}.ts` (`resolveClassification`
    fail-closed, `keywordClassify` no `autonomous`)
  - `packages/core/src/engine/types.ts` (`Classification.autonomous` —
    единственный авторитет)
- Режим manual-QA: **runtime** (Node-process + tsx, без live omp PTY). Все
  сценарии покрываются in-process assertions и захватом rendered prompt
  strings + state files в `/tmp/llm-autonomy-classification-2026-08-08/`.
- Симуляция LLM — детерминированные mock-объекты, **не live LLM**. Никакого
  заявления на live execution.

## Подготовка

- [x] Создать `/tmp/llm-autonomy-classification-2026-08-08/` для evidence
- [x] Build: `npm run build -w @andvl1/omp-workflows-core` → exit 0
- [x] Build: `npm run build -w @andvl1/omp-workflows-fullstack` → exit 0
- [x] Build: `npm run build -w @andvl1/omp-workflows-e2e` → exit 0
- [x] Typecheck: `npm run typecheck --workspaces` → exit 0
- [x] Baseline `node --test --import tsx packages/core/test/do-work-autonomy.test.ts`
  → 17/17 PASS
- [x] Baseline `node --test --import tsx packages/core/test/envelope.test.ts`
  → 15/15 PASS
- [x] Baseline `node --test --import tsx packages/core/test/cto-ownership.test.ts`
  → 5/5 PASS

## Scenario 1 — NL-task без recognized parser hint: hint=false, model=true → debug-cycle

**Given**: `parseWorkEnvelope`, `buildDoWorkPrompt`, `classificationGate`,
`resolveWorkflow`, детерминированный mock-LLM, который классифицирует
`{type:BUG_FIX, complexity:QUICK, autonomous:true}`.

**When**: передаём задачу
`Do this without waiting for approval — fix the login bug, the password
reset loop is broken`. Парсер НЕ распознаёт её как directive (никакого
`[AUTONOMOUS]`, никакой approved NL directive). Hint=false.

**Then**:
1. `envelope.autonomyHint === false`
2. `envelope.task` сохраняет полный текст включая NL autonomy формулировку
3. `buildDoWorkPrompt` рендерит `Autonomy hint (leading directive —
   MECHANICAL, NOT authoritative): OFF`
4. Prompt содержит блок PHASE-0 с `- Autonomous: true | false`
5. Запись `classification: {type:BUG_FIX, complexity:QUICK, workflow:debug-cycle,
   autonomous:true}` проходит `classificationGate` (return undefined)
6. Если записан `workflow: bug-fix` (non-autonomous profile) с тем же
   `autonomous:true`, gate **блокирует** — сообщение содержит
   `expected 'debug-cycle'`

Result: PASS
Evidence: `/tmp/llm-autonomy-classification-2026-08-08/s1.log`

## Scenario 2 — `[AUTONOMOUS]` directive: hint=true, model=false → interactive

**Given**: тот же harness, mock-LLM классифицирует как
`{type:BUG_FIX, complexity:QUICK, autonomous:false}` (пользователь явно
просил step-by-step).

**When**: `[AUTONOMOUS] Walk me through each step before touching code`.

**Then**:
1. `envelope.autonomyHint === true`
2. `envelope.task === "Walk me through each step before touching code"`
3. Prompt содержит `Autonomy hint ... ON` И строку
   `a marked task can still be interactive` (документирует override path)
4. `classification: {type:BUG_FIX, complexity:QUICK, workflow:bug-fix,
   autonomous:false}` → gate PASS (interactive bug-fix workflow)
5. `classification: {type:BUG_FIX, complexity:QUICK, workflow:debug-cycle,
   autonomous:false}` → gate **блокирует** с `expected 'bug-fix'`

Result: PASS
Evidence: `/tmp/llm-autonomy-classification-2026-08-08/s2.log`

## Scenario 3 — `[AUTONOMOUS]` directive: hint=true, model=true → debug-cycle (happy path)

**Given**: тот же harness, mock-LLM классифицирует как
`{type:BUG_FIX, complexity:QUICK, autonomous:true}`.

**When**: `[AUTONOMOUS] Fix the auth bypass in /api/users`.

**Then**:
1. `envelope.autonomyHint === true` (parser agrees)
2. Запись `classification: {type:BUG_FIX, complexity:QUICK,
   workflow:debug-cycle, autonomous:true}` → gate PASS (autonomous path)
3. resolveWorkflow(BUG_FIX, QUICK, true) === 'debug-cycle'

Result: PASS
Evidence: `/tmp/llm-autonomy-classification-2026-08-08/s3.log`

## Scenario 4 — Model omitting `autonomous` или non-boolean — блок P5

**Given**: gate, mock-LLM классифицирует БЕЗ поля `autonomous` или с
`autonomous: "true"` (string) или `autonomous: null`.

**When**: запись state с classification.

**Then**:
1. Поле `autonomous` отсутствует → `classificationGate` возвращает
   `{block:true, reason: "classification.autonomous is missing..."}`
2. `autonomous: "true"` (string) → block + `must be a boolean`
3. `autonomous: null` → block + reason содержит `is missing`
4. `autonomous: undefined` (explicit) → block + reason contains `is missing`
5. `autonomous: 1` (number) → block + `must be a boolean`
6. `resolveClassification({task, autonomous:true, classification:{type,
   complexity, confidence}})` → THROWS `classification gate: model
   classification incomplete`

Result: PASS
Evidence: `/tmp/llm-autonomy-classification-2026-08-08/s4.log`

## Scenario 5 — `/cto` и `/do-work` идентичные PHASE-0 fields, hint non-authoritative

**Given**: `buildCtoPrompt`, `buildDoWorkPrompt`, общий contract.

**When**: одна и та же NL-задача проходит через оба command builder.

**Then**:
1. Оба prompts содержат `CLASSIFICATION:` header
2. Оба prompts содержат `- Type: FEATURE | REFACTOR | OPS | BUG_FIX |
   INVESTIGATION | REVIEW | HOTFIX`
3. Оба prompts содержат `- Complexity: QUICK | MEDIUM | COMPLEX | CRITICAL`
4. Оба prompts содержат `- Confidence: HIGH | MEDIUM | LOW`
5. Оба prompts содержат `- Autonomous: true | false`
6. Оба prompts содержат `Autonomy is YOUR decision` (model authority)
7. Оба prompts содержат hint `MECHANICAL, NOT authoritative`
8. Оба prompts содержат `Never copy the hint into persisted` (no decision copy)
9. **Ни** один prompt **не** содержит `state.autonomous: true` или
   `state.autonomous: false` (parser hint не инжектируется как state
   decision)
10. Оба prompts содержат identical workflow resolution matrix
    (`buildWorkflowMatrix()`)

Result: PASS
Evidence: `/tmp/llm-autonomy-classification-2026-08-08/s5.log`

## Scenario 6 — New state writes persist `classification.autonomous`; legacy reads compatibly

**Given**: `run()` engine entrypoint, mock-LLM classification.

**When**: запуск с `classification` (model path) → `run()` пишет state.
Запуск legacy path (no classification) → использует `opts.autonomous`
verbatim.

**Then**:
1. Model path state содержит `state.classification.autonomous` И
   `state.classification.autonomous_reason`
2. Model path state НЕ содержит top-level `state.autonomous` field
   (engine deliberately does NOT write legacy top-level)
3. Legacy path state: `state.autonomous` === `opts.autonomous`
4. P5 gate: legacy `state.autonomous:true` +
   `classification:{type:BUG_FIX, complexity:QUICK, workflow:debug-cycle,
   autonomous:undefined}` → PASS (legacy read-compat)
5. P5 gate: legacy `state.autonomous:false` +
   classification без autonomous → BLOCK (legacy false без debug-cycle path)
6. P5 gate: `classification.autonomous:false` + legacy `autonomous:true`
   → PASS как `bug-fix` (model wins, legacy ignored)

Result: PASS
Evidence: `/tmp/llm-autonomy-classification-2026-08-08/s6.log`

## Scenario 7 — Standby / session ownership / terminality / stale-command pruning regressions PASS

**Given**: `runCto`, `findActiveCtoRun`, `isCtoRunTerminal`, `newCtoState`,
`pruneStaleCommands`, `ensureCommandsForSession`, `copyCommandsForInstall`.

**When**:
- `runCto({owner_session:'sess-A'})` → findActiveCtoRun: sess-A → видим,
  sess-B → null
- `newCtoState({standby:true})` → write → все sessions adopt
- team1 done, team2 done, integration done → `isCtoRunTerminal=true`,
  `findActiveCtoRun=null`
- seed legacy plugin-owned + user-owned + _lib → sync → legacy dirs
  удалены, user-owned сохранён, manifest written

**Then**: все 4 sub-cases PASS.

Result: PASS
Evidence: `/tmp/llm-autonomy-classification-2026-08-08/s7.log`,
`/tmp/llm-autonomy-classification-2026-08-08/s7-shipped-manifest.json`

## Scenario 8 — Повтор ключевых сценариев для leakage / order / state

**Given**: всё из S1–S6 на shared fixtures.

**When**:
- Запустить S1 (parser idempotent), S2 (model override), S3 (model agree),
  S4 (block), S6 (legacy read) последовательно дважды на одних и тех же
  fixtures.
- Начать со state-write fixture `{autonomous:true, classification:{...}}`,
  перезаписать через `writeState` → state остаётся consistent
  (deep-equal classification + monotonic stage status).
- Mutation `setStageStatus` не меняет `state.classification.autonomous`.
- `resolveWorkflow` вызывается 100x на одинаковых inputs → identical
  outputs (no side-effect).

**Then**: ни order-issues, ни leakage, ни side-effects в resolveWorkflow.

Result: PASS
Evidence: `/tmp/llm-autonomy-classification-2026-08-08/s8.log`

## Acceptance

- [x] Все 8 сценариев выше дают PASS на свежем, не модифицированном исходном
  коде.
- [x] Verify `autonomyHint` can DISAGREE with `classification.autonomous` —
  demonstrated S2 (hint=true, model=false → interactive; explicit block
  when workflow mismatches).
- [x] Verify missing/non-boolean `classification.autonomous` blocks —
  demonstrated S4 (6 variants) + S6.5 (legacy false blocks).
- [x] Verify `/cto` and `/do-work` share identical PHASE-0 fields —
  demonstrated S5 (10 sub-checks).
- [x] Verify new writes persist `classification.autonomous`; legacy
  compat reads — demonstrated S6 (6 sub-checks).
- [x] Verify standby, ownership, terminality, copy-commands regressions —
  demonstrated S7 (4 sub-cases).
- [x] Repeat for leakage — S8 (5 sub-checks).
- [x] Никаких правок production/test файлов.
- [x] Cleanup: temporary projects/processes.

## Cleanup

- [x] Все spawned node test процессы завершены корректно; `jobs -l` пуст.
- [/] Директория `/tmp/llm-autonomy-classification-2026-08-08/` оставлена
  как evidence-трейл (логи, captured prompts, captured state). Удаляется
  пользователем вручную или автоматическим tmp cleanup.