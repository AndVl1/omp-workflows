# LLM Autonomy Review-Fix — E2E Scenario

Slug: llm-autonomy-review-fix · Дата: 2026-08-08 · Платформа: Backend (runtime, in-process)

Источник правды для финальной manual-QA проверки post-code-review fixes.
Перед каждым validation action перечитать этот файл; выполненные `[x]` не
повторять. При ошибке — зафиксировать результат и оставить шаг `[ ]`.

## Контекст

- Branch: `fix/cto-autonomous-command-state`
- Source-of-truth contract: `.work-state/artifacts/llm-autonomy-design.json`
- Prior QA: `.work-state/artifacts/manual_qa_model_first.json` (PASS, 8/8 S1..S8)
- Prior QA tests: `.work-state/artifacts/qa_tests_model_first.json` (PASS, 203/203)
- Implementation surface (review fixes):
  - `packages/core/src/commands/classification-contract.ts` (shared PHASE-0)
  - `packages/core/src/commands/{cto,do-work,envelope,team}.ts`
  - `packages/core/src/cto/{state,run,types}.ts`
  - `packages/core/src/engine/{types,run,classify,state,profile}.ts`
  - `packages/core/src/gates/classification.ts` (P5)
  - `packages/fullstack/scripts/copy-commands.mjs` (pruneStaleCommands)
- Режим manual-QA: **runtime** (Node-process + tsx, без live omp PTY).
  Все сценарии покрываются in-process assertions + захватом rendered prompt
  strings + state files в `/tmp/llm-autonomy-review-fix-2026-08-08/`.
- Симуляция LLM — детерминированные mock-объекты, **не live LLM**.
  Никакого заявления на live execution.

## Подготовка

- [x] Создать `/tmp/llm-autonomy-review-fix-2026-08-08/` для evidence
- [x] Build: `npm run build -w @andvl1/omp-workflows-core` → exit 0
- [x] Build: `npm run build -w @andvl1/omp-workflows-fullstack` → exit 0
- [x] Baseline core tests: `node --test --import tsx packages/core/test/{envelope,do-work-autonomy,cto-classification}.test.ts` → 38/38 PASS
- [x] Baseline core engine tests: `node --test --import tsx packages/core/test/{cto-engine,cto-ownership,cto-command,cto-amend,smoke,validation-gate}.test.ts` → 192/192 PASS

## Required assertions (per parent context)

### R1 — Gate-ordering: `workflow_override:true` with missing/non-boolean `classification.autonomous` BLOCKS before override

**Given**: `classificationGate(event, ctx)` from `gates/classification.ts`,
synthetic state JSON on disk with `workflow_override:true` and a missing or
non-boolean `classification.autonomous`.

**When**: invoke gate.

**Then**:
1. Missing `classification.autonomous` + `workflow_override:true` →
   `{block:true, reason:'BLOCK (P5): classification.autonomous is missing…'}`
   (the override escape hatch only skips the workflow-mismatch check,
   never the fail-closed autonomy validation).
2. Non-boolean `classification.autonomous:'true'` + `workflow_override:true`
   → block + `must be a boolean`.
3. `classification.autonomous:null` + `workflow_override:true` → block +
   `is missing`.
4. `classification.autonomous:true` (boolean) + `workflow_override:true`
   → gate returns (allow).

Result: PASS
Evidence: `/tmp/llm-autonomy-review-fix-2026-08-08/r1.log`

### R2 — Model `classification.autonomous` controls workflow even when legacy top-level flag conflicts

**Given**: synthetic state JSON with both `classification.autonomous`
and `state.autonomous` (legacy).

**When**: invoke gate with conflicting flags.

**Then**:
1. Model `false` + legacy `true` → resolveAutonomous returns false →
   workflow resolves as `bug-fix` (non-autonomous path).
2. Model `true` + legacy `false` → resolveAutonomous returns true →
   workflow resolves as `debug-cycle` (autonomous path).
3. Model `true` + legacy `true` + workflow `bug-fix` → BLOCK with
   `expected 'debug-cycle'` (model wins over legacy, but workflow must match).
4. Model missing + legacy `true` + workflow `debug-cycle` → ALLOW
   (legacy read-compat fallback).
5. Model missing + legacy `false` + workflow `debug-cycle` → BLOCK
   (legacy false → interactive → expected 'bug-fix').

Result: PASS
Evidence: `/tmp/llm-autonomy-review-fix-2026-08-08/r2.log`

### R3 — CTO new task persistence: structured classification stored; malformed/missing fail-closed; standby remains engine-created exception

**Given**: `runCto(opts)`, `newCtoState`, `resolveCtoAutonomous`,
`markdownCtoState`.

**When**: invoke with model classification; then with malformed; then
with standby flag.

**Then**:
1. Model classification present →
   `state.classification = opts.classification`,
   `state.autonomous = resolveCtoAutonomous(...)` (mirrors model).
2. Missing classification + `autonomous:true` →
   `state.autonomous = true`, no `classification` key.
3. Malformed classification (missing `autonomous`) → if it passed type
   guard would be accepted but `autonomous_block` is enforced at gate;
   `resolveCtoAutonomous` would return `state.autonomous`.
4. Standby state created via `newCtoState({standby:true, autonomous:true})` →
   `state.standby = true`, `state.autonomous = true` (engine-created
   exception, no classification).
5. Markdown-state classification parse: `classification: {"type":"BUG_FIX",...,"autonomous":true}`
   → `meta.classification` populated.
6. Malformed `classification:` line (invalid JSON) → `meta.classification`
   stays `undefined`; legacy top-level `autonomous:` line is consulted.

Result: PASS
Evidence: `/tmp/llm-autonomy-review-fix-2026-08-08/r3.log`

### R4 — `/cto` fresh/amend and `/do-work` share full workflow matrix, including REVIEW/HOTFIX and P5 classification.autonomous rule

**Given**: `buildCtoPrompt`, `buildAmendPrompt`, `buildDoWorkPrompt`.

**When**: render fresh CTO prompt + amend prompt + do-work prompt on
identical NL task.

**Then**:
1. All three prompts contain identical workflow matrix table
   (REVIEW -> review, HOTFIX -> emergency, etc.).
2. All three prompts contain `- Autonomous: true | false` in PHASE-0 block.
3. All three prompts contain `P5 gate reads classification.autonomous`
   (or `classification.autonomous is the AUTHORITY`) line.
4. CTO and amend prompts contain `Never run task(agent=cto)` / `task(agent=@cto)`
   rule (single orchestrator contract).
5. CTO amend prompt references active run id, teams, pause, state path.
6. Do-work prompt contains `Then write .work-state/team-state.json with the classification`.
7. All prompts include REVIEW -> review and HOTFIX -> emergency rows.
8. All prompts include `> Autonomous BUG_FIX resolves to debug-cycle even at QUICK complexity`
   footnote.

Result: PASS
Evidence: `/tmp/llm-autonomy-review-fix-2026-08-08/r4.log` + captured prompts

### R5 — NL semantic intent with `autonomyHint:false` + simulated model `autonomous:true` → debug-cycle; contradictory `[AUTONOMOUS]` + model false → interactive

**Given**: `parseWorkEnvelope`, `parseEnvelope` (CTO), `buildDoWorkPrompt`,
`buildCtoPrompt`, `classificationGate`, `resolveWorkflow`.

**When**: pass NL "do this without approval" (no `[AUTONOMOUS]` token)
with simulated model `{type:BUG_FIX, complexity:QUICK, autonomous:true}`,
and pass `[AUTONOMOUS] walk me through each step` with simulated
model `{autonomous:false}`.

**Then**:
1. NL autonomy intent: `autonomyHint = false`, prompt renders
   `Autonomy hint ... OFF`, classification persists with `autonomous:true`,
   workflow = `debug-cycle` via `resolveWorkflow(BUG_FIX, QUICK, true)`.
2. `[AUTONOMOUS]` override: `autonomyHint = true`, prompt renders
   `Autonomy hint ... ON`, classification persists with `autonomous:false`
   (model wins), workflow = `bug-fix` via `resolveWorkflow(BUG_FIX, QUICK, false)`.
3. `[AUTONOMOUS] agree`: `autonomyHint = true`, model `autonomous:true`,
   workflow = `debug-cycle`, gate PASS.
4. `[AUTONOMOUS] model:true` + workflow=`bug-fix` → BLOCK
   `expected 'debug-cycle'`.

Result: PASS
Evidence: `/tmp/llm-autonomy-review-fix-2026-08-08/r5.log`

### R6 — Repeat key checks: prior ownership/terminality/stale-command coverage retained

**Given**: `findActiveCtoRun`, `isCtoRunTerminal`, `newCtoState`,
`copy-commands.mjs` `pruneStaleCommands`.

**When**:
1. Standby run created → adopted by foreign session (cross-session
   adoption). Standby session isolation intact.
2. Interactive run with `owner_session:'sess-A'` → foreign
   `sessionId:'sess-B'` cannot amend (findActiveCtoRun returns null).
3. All teams done + integration done → `isCtoRunTerminal = true`,
   `findActiveCtoRun = null`.
4. Stale `.omp/commands/` seeded with `team-next,team-yolo,pulse,coordinator-stats`
   + user-owned `custom-cmd` → after `pruneStaleCommands`, legacy dirs gone,
   user-owned retained, `.omp-shipped.json` manifest written with shipped set.
5. Re-run on same target: idempotent (no further pruning).

Result: PASS
Evidence: `/tmp/llm-autonomy-review-fix-2026-08-08/r6.log` + manifest

## Acceptance

- [x] Все 6 required assertions (R1..R6) дают PASS на свежем, не модифицированном исходном коде.
- [x] Source-test regression baseline (envelope, do-work-autonomy, cto-classification, cto-engine, cto-ownership, cto-command, cto-amend, smoke, validation-gate) — 230+/230+ PASS.
- [x] Build + typecheck: 0 exit each.
- [x] Никаких правок production/test файлов.
- [x] Cleanup: temporary processes terminated.

## Cleanup

- [x] Все spawned node test процессы завершены корректно; `jobs -l` пуст.
- [/] Директория `/tmp/llm-autonomy-review-fix-2026-08-08/` оставлена как
  evidence-трейл (runner.js, captured prompts, captured state, per-R logs,
  scenarios.json). Удаляется пользователем вручную или автоматическим tmp
  cleanup.
