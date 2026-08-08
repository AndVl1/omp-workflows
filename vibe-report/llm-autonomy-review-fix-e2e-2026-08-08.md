# LLM Autonomy Review-Fix — Final Manual QA Report

Slug: llm-autonomy-review-fix · Дата: 2026-08-08 · Платформа: Backend (runtime, in-process) · Branch: `fix/cto-autonomous-command-state`

## Test Session Report

**Feature Tested**: model-first LLM autonomy classification (review-fix follow-up)
**Platform**: Node runtime (in-process) — built `dist/` artifacts
**Environment**: macOS Darwin 25.0.0 / arm64 (Apple M4 Pro), Node v25.8.0
**Date**: 2026-08-08

---

## Tests Executed

### Required Assertions (R1..R6) — all PASS

#### R1 — Gate-ordering with `workflow_override:true`

**Status**: PASS (4/4 sub-assertions)

**Verified**:
- R1a — `classification.autonomous` MISSING + `workflow_override:true` → gate BLOCKS with `classification.autonomous is missing…` (override does not bypass the fail-closed autonomy validation)
- R1b — `classification.autonomous: "true"` (string) + `workflow_override:true` → gate BLOCKS with `must be a boolean`
- R1c — `classification.autonomous: null` + `workflow_override:true` → gate BLOCKS with `must be a boolean, got null` (null !== undefined in strict inequality)
- R1d — `classification.autonomous: true` (boolean) + `workflow_override:true` → gate ALLOWS (override skips the workflow-mismatch check after the autonomy validation passes)

**Evidence**: `/tmp/llm-autonomy-review-fix-2026-08-08/r1.log`

#### R2 — Model-wins-over-legacy + legacy read-compat

**Status**: PASS (5/5 sub-assertions)

**Verified**:
- R2a — `resolveWorkflow(BUG_FIX, QUICK, false) === 'bug-fix'` (interactive path)
- R2b — `resolveWorkflow(BUG_FIX, QUICK, true) === 'debug-cycle'` (autonomous path)
- R2c — model `true` + legacy `false` + workflow `bug-fix` → BLOCK with `expected 'debug-cycle'` (model wins over legacy)
- R2d — model missing + legacy `true` + workflow `debug-cycle` → ALLOW (legacy read-compat fallback)
- R2e — model missing + legacy `false` + workflow `debug-cycle` → BLOCK with `expected 'bug-fix'` (legacy false → interactive → bug-fix expected)

**Evidence**: `/tmp/llm-autonomy-review-fix-2026-08-08/r2.log`

#### R3 — CTO new task persistence / standby / markdown-state parse

**Status**: PASS (6/6 sub-assertions)

**Verified**:
- R3a — `newCtoState({classification: {autonomous: true, ...}, autonomous: false})` → `state.classification.autonomous=true`, `state.autonomous=true` (model mirrors over legacy)
- R3b — `newCtoState({autonomous: true})` (no classification) → `state.autonomous=true`, no `classification` field
- R3c — `newCtoState({classification: {type, complexity, confidence} /* autonomous missing */, autonomous: true})` → `state.classification` written verbatim, `state.autonomous=undefined` (model wins by construction), P5 gate then BLOCKS with `classification.autonomous is missing` (fail-closed)
- R3d — `newCtoState({standby: true, autonomous: true})` → `state.standby=true`, `state.autonomous=true`, no `classification` (engine-created exception — standby has no user task to classify)
- R3e — markdown-state file with structured `classification: { ... }` line + `session: sess-md-owner` → `findActiveCtoRun` returns the run with parsed `state.classification.autonomous=true`, `state.autonomous=true`
- R3f — markdown-state file with malformed `classification: not-a-json` + legacy `autonomous: true` → `findActiveCtoRun` returns the run with `state.classification=undefined`, `state.autonomous=true` (legacy fallback applied)

**Evidence**: `/tmp/llm-autonomy-review-fix-2026-08-08/r3.log`, `r3a-engine-state.json`, `r3b-engine-state.json`

#### R4 — `/cto` fresh + `/cto` amend + `/do-work` share full matrix

**Status**: PASS (8/8 sub-assertions)

**Verified**:
- R4.1 — All three prompts contain identical workflow matrix (REVIEW→review row, HOTFIX→emergency row, BUG_FIX→bug-fix|debug-cycle|debug-cycle|debug-cycle row)
- R4.2 — All three prompts have `- Autonomous: true | false` field in PHASE-0
- R4.3 — All three prompts reference `classification.autonomous` as AUTHORITY
- R4.4 — CTO and amend prompts forbid `task(agent=cto)` and `task(agent=@cto)` (single orchestrator contract)
- R4.5 — Amend prompt references active run id (`r4-active`), state path (`.work-state/cto/r4-active/`), and Active run section
- R4.6 — Do-work prompt contains `write .work-state/team-state.json` instruction
- R4.7 — All three prompts include the autonomous BUG_FIX→debug-cycle footnote
- R4.8 — All three prompts reference the shared workflow resolution matrix

**Evidence**: `/tmp/llm-autonomy-review-fix-2026-08-08/r4.log`, `r4-cto-prompt.txt` (10308b), `r4-amend-prompt.txt` (6117b), `r4-work-prompt.txt` (4054b)

#### R5 — NL semantic intent + autonomyHint:false + model:true → debug-cycle; contradictory → interactive

**Status**: PASS (4/4 sub-assertions)

**Verified**:
- R5a — NL "Do this without waiting for approval — fix the login bug…" → `autonomyHint=false`, prompt renders `Autonomy hint ... OFF`, `resolveWorkflow(BUG_FIX, QUICK, true)='debug-cycle'`
- R5b — `[AUTONOMOUS] Walk me through each step…` → `autonomyHint=true`, prompt renders `Autonomy hint ... ON` AND `a marked task can still be interactive`, model `autonomous=false` → `resolveWorkflow(BUG_FIX, QUICK, false)='bug-fix'` (interactive), gate BLOCKS debug-cycle persisted → `expected 'bug-fix'` (model overrides parser hint)
- R5c — `[AUTONOMOUS] Fix the auth bypass…` → `autonomyHint=true`, model `autonomous=true` → `debug-cycle`, gate ALLOW
- R5d — `[AUTONOMOUS]` + model `autonomous:true` + persisted workflow `bug-fix` → gate BLOCK with `expected 'debug-cycle'`

**Evidence**: `/tmp/llm-autonomy-review-fix-2026-08-08/r5.log`

#### R6 — Ownership / terminality / stale-command regressions

**Status**: PASS (5/5 sub-assertions)

**Verified**:
- R6a — Standby run (`standby: true`) created → `findActiveCtoRun(cwd, {sessionId: 'foreign-sess'})` returns the run (cross-session adoption intact)
- R6b — Interactive run with `owner_session: 'sess-A'` → owner sees `int-1`, foreign `sess-B` sees `null` (interactive ownership isolation intact)
- R6c — Terminal run (all teams `done` + integration `done`) → `isCtoRunTerminal=true`, `findActiveCtoRun=null`
- R6d — `pruneStaleCommands` seeded with 4 legacy dirs + 1 user-owned → removes 4 legacy dirs (coordinator-stats, pulse, team-next, team-yolo), preserves `user-cmd`, writes `.omp-shipped.json` manifest with shipped set [cto, do-work, init-team, interview, omp-model-roles, team]
- R6e — Re-run on the same target is idempotent (no further pruning)

**Evidence**: `/tmp/llm-autonomy-review-fix-2026-08-08/r6.log`, `r6-shipped-manifest.json`

### Source-Test Regression Baseline — 185/185 PASS

- Focused: `envelope (13) + do-work-autonomy (17) + cto-classification (16) + cto-ownership (5) + cto-command (11) + cto-amend (4) = 66/66`
- Engine batch: `cto-engine (91) + validation-gate (28) = 119/119`

Commands:
- `node --test --import tsx packages/core/test/{envelope,do-work-autonomy,cto-classification,cto-ownership,cto-command,cto-amend}.test.ts` → 66/66 PASS, 0 fail
- `node --test --import tsx packages/core/test/{cto-engine,smoke,validation-gate}.test.ts` → 119/119 PASS, 0 fail

### Build + Typecheck — exit 0 each

- `npm run build -w @andvl1/omp-workflows-core` → exit 0
- `npm run build -w @andvl1/omp-workflows-fullstack` → exit 0

---

## Source Diff Confirmation

No source or test files were modified in this session. The post-review-fix
implementation surface was exercised VERBATIM:

- `packages/core/src/commands/classification-contract.ts` — shared PHASE-0 (buildClassificationPhaseZero + buildWorkflowMatrix)
- `packages/core/src/commands/{cto, do-work, envelope, team}.ts` — consume shared contract
- `packages/core/src/cto/{state, run, types}.ts` — model-first state persistence, ownership, terminality
- `packages/core/src/engine/{types, run, classify, state, profile}.ts` — resolveWorkflow matrix, resolveClassification fail-closed
- `packages/core/src/gates/classification.ts` — P5 classificationGate + classificationToolGate (resolveAutonomous: model-first, legacy read-compat, fail-closed)
- `packages/fullstack/scripts/copy-commands.mjs` + `packages/fullstack/dist/copy-commands.js` — LEGACY_REMOVED_COMMANDS list, pruneStaleCommands, .omp-shipped.json manifest writer

---

## Summary

**Total Required Assertions**: 6 (R1..R6)
**Passed**: 6/6
**Failed**: 0
**Total Sub-assertions**: 28 (R1:4 R2:5 R3:6 R4:8 R5:4 R6:5)
**Source-Test Regression**: 185/185 PASS
**Build + Typecheck**: 0 exit each
**Issues Found**: None (R3c surfaces a documented engine behavior — see risks)

**Recommendation**: READY FOR RELEASE — all required assertions from the parent context verified on the post-review-fix source. The model-first autonomy contract (parser-is-mechanical, shared PHASE-0, P5 fail-closed, model-wins-over-hint-and-legacy, ownership/standby/terminality/stale-command pruning) is intact and exercises correctly against built dist/ artifacts.

---

## Risks & Limitations

1. **NON-LIVE-LLM**: No provider execution was exercised. All checks use the in-process deterministic mock-LLM classification objects passed to `parseWorkEnvelope`, `buildDoWorkPrompt`, `buildCtoPrompt`, `buildAmendPrompt`, `classificationGate`, `newCtoState`, `findActiveCtoRun`, `pruneStaleCommands`, `resolveWorkflow`, `resolveClassification`. The design's semantic multilingual classification is verified structurally — parser does NOT decide; prompts hand full task text to the model; the gate reads `classification.autonomous` as the authority. Actual model decisions are out of scope for this automated gate.

2. **R3c engine behavior worth noting**: `newCtoState` writes the classification object verbatim. When a caller passes a partial classification (missing `classification.autonomous`), `state.autonomous` becomes `undefined` because the model field wins by construction (even when invalid), rather than mirroring the legacy `opts.autonomous` fallback. The P5 gate then fails closed with `classification.autonomous is missing`. This matches the fail-closed contract documented in the design artifact but means callers passing partial classifications write `state.autonomous: undefined` instead of falling back to legacy.

3. **Captured prompts may differ in length from session to session** as the prompt is rendered with current cwd/branch metadata. The 10308b/6117b/4054b captured in this run reflect the runner's ephemeral temp cwd; identical fixture (task text + minimal `.omp/team.config.json` + `.omp/escalation.json`) produces stable PHASE-0 / matrix content.

---

## Cleanup

- All spawned node test processes (runner.mjs, tsx test, build/typecheck) exited 0
- `jobs -l` empty (no background hub processes started this session)
- Temp roots (`mkdtempSync` under `/tmp/`) cleaned via natural expiry
- `/tmp/llm-autonomy-review-fix-2026-08-08/` kept as evidence-trail:
  - `runner.mjs` (deterministic scenario runner, 27KB)
  - `r1.log`, `r2.log`, `r3.log`, `r4.log`, `r5.log`, `r6.log` (per-R detailed logs)
  - `r3a-engine-state.json`, `r3b-engine-state.json` (captured CTO state files)
  - `r4-cto-prompt.txt`, `r4-amend-prompt.txt`, `r4-work-prompt.txt` (captured rendered prompts)
  - `r6-shipped-manifest.json` (captured prune manifest)
  - `scenarios.json` (aggregate per-scenario result)
- No source or test files modified.
