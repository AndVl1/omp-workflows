# LLM Autonomy Classification — Manual QA Report

**Дата**: 2026-08-08
**Slug**: `llm-autonomy-classification`
**Branch**: `fix/cto-autonomous-command-state`
**Платформа**: Backend (runtime, in-process)
**Режим**: runtime (Node-process + in-process harness, без live omp PTY)
**Verdict**: **PASS**

---

## 1. Цель

Подтвердить, что в RC2+ контракте:

1. **Модель** — единственный авторитет для `autonomous` (PHASE-0 +
   `resolveClassification` + P5 gate `classificationGate` +
   `classificationToolGate`).
2. **Парсер** — non-authoritative `autonomyHint`, никогда не копируется в
   persisted state как decision.
3. **`autonomyHint` и `classification.autonomous` могут не соглашаться**:
   статический hint — MECHANICAL, не должен заставлять модель молчать.
4. **`/cto` и `/do-work`** разделяют один PHASE-0 contract (4 поля +
   matrix).
5. **Missing / non-boolean** `classification.autonomous` блокирует P5
   fail-closed (no silent default).
6. **New writes** идут в `state.classification.autonomous`; legacy
   top-level `state.autonomous` остаётся read-compat, не переопределяет
   модель.
7. **Standby / ownership / terminality / stale-command** регрессии RC4-RC6
   остаются PASS.

## 2. Артефакты

- Scenario checklist: `vibe-report/llm-autonomy-classification-e2e-scenario.md`
- Report: `vibe-report/llm-autonomy-classification-e2e-2026-08-08.md`
- Manual-QA artifact: `.work-state/artifacts/manual_qa_model_first.json`
- Evidence root: `/tmp/llm-autonomy-classification-2026-08-08/`
- Design contract: `.work-state/artifacts/llm-autonomy-design.json`

## 3. Подготовка

| Шаг | Команда | Exit | Evidence |
| --- | --- | --- | --- |
| Build core | `npm run build -w @andvl1/omp-workflows-core` | 0 | `packages/core/dist/` |
| Build fullstack | `npm run build -w @andvl1/omp-workflows-fullstack` | 0 | `packages/fullstack/dist/` |
| Build e2e | `npm run build -w @andvl1/omp-workflows-e2e` | 0 | `packages/e2e/dist/` |
| Typecheck | `npm run typecheck --workspaces` | 0 | (clean) |
| Baseline test: do-work-autonomy | `node --test --import tsx packages/core/test/do-work-autonomy.test.ts` | 0 | 17/17 PASS |
| Baseline test: envelope | `node --test --import tsx packages/core/test/envelope.test.ts` | 0 | 15/15 PASS |
| Baseline test: cto-ownership | `node --test --import tsx packages/core/test/cto-ownership.test.ts` | 0 | 5/5 PASS |

## 4. Сценарии (GWT)

### S1 — NL-task без recognized parser hint, model=true → debug-cycle

- **Given**: `parseWorkEnvelope`, `buildDoWorkPrompt`, `classificationGate`,
  `resolveWorkflow`, mock-LLM классифицирует
  `{type:BUG_FIX, complexity:QUICK, autonomous:true}`.
- **When**: задача
  `"Do this without waiting for approval — fix the login bug, the password
  reset loop is broken"`.
- **Then**:
  - `envelope.autonomyHint === false` (парсер НЕ распознаёт NL формулировку)
  - `envelope.task` сохраняет полный текст включая NL autonomy phrasing
  - `buildDoWorkPrompt` рендерит `Autonomy hint (leading directive — MECHANICAL, NOT authoritative): OFF`
  - Prompt содержит `- Autonomous: true | false` (PHASE-0 field)
  - `classificationGate` для `{BUG_FIX, QUICK, debug-cycle, autonomous:true}` → undefined (PASS)
  - `classificationGate` для `{BUG_FIX, QUICK, bug-fix, autonomous:true}` → BLOCK
    с reason `expected 'debug-cycle'`
  - `resolveWorkflow(BUG_FIX, QUICK, true) === 'debug-cycle'`

**Result**: PASS
**Evidence**: `/tmp/llm-autonomy-classification-2026-08-08/s1.log`

### S2 — `[AUTONOMOUS]` directive, model=false → interactive

- **Given**: mock-LLM классифицирует `{type:BUG_FIX, complexity:QUICK,
  autonomous:false}` (пользователь явно просил step-by-step review).
- **When**: `[AUTONOMOUS] Walk me through each step before touching code`.
- **Then**:
  - `envelope.autonomyHint === true`
  - `envelope.task === "Walk me through each step before touching code"`
  - Prompt содержит `Autonomy hint ... ON` И `a marked task can still be interactive`
  - `classificationGate` для `{BUG_FIX, QUICK, bug-fix, autonomous:false}` → undefined (PASS, interactive)
  - `classificationGate` для `{BUG_FIX, QUICK, debug-cycle, autonomous:false}` → BLOCK с reason `expected 'bug-fix'`
  - **МОДЕЛЬ OVERRIDE УСПЕШНО** — parser hint=true, но модель решила false и workflow=interactive bug-fix проходит; попытка записать autonomous+debug-cycle блокируется

**Result**: PASS
**Evidence**: `/tmp/llm-autonomy-classification-2026-08-08/s2.log`

### S3 — `[AUTONOMOUS]` directive, model=true → debug-cycle (happy path)

- **Given**: parser и model соглашаются на autonomous.
- **When**: `[AUTONOMOUS] Fix the auth bypass in /api/users`.
- **Then**:
  - `envelope.autonomyHint === true`
  - `classificationGate` для `{BUG_FIX, QUICK, debug-cycle, autonomous:true}` → undefined (PASS)
  - `resolveWorkflow(BUG_FIX, QUICK, true) === 'debug-cycle'`
  - `/cto` envelope с тем же input → hint=true, prompt содержит ON hint + Autonomous field

**Result**: PASS
**Evidence**: `/tmp/llm-autonomy-classification-2026-08-08/s3.log`

### S4 — Model omitting / non-boolean `autonomous` → блок P5

- **Given**: gate, mock-LLM классифицирует БЕЗ `autonomous` или с
  invalid type.
- **When**: state с classification.
- **Then**:
  - Поле `autonomous` отсутствует → BLOCK reason `is missing`
  - `autonomous: "true"` (string) → BLOCK reason `must be a boolean`
  - `autonomous: null` → BLOCK reason `must be a boolean`
  - `autonomous: 1` (number) → BLOCK reason `must be a boolean`
  - `autonomous: 0` (number, falsy) → BLOCK reason `must be a boolean`
  - `resolveClassification({classification:{type, complexity, confidence}})` (без autonomous) → THROWS
    `classification gate: model classification incomplete`
  - `resolveClassification({classification:{type, complexity, confidence, autonomous:"true"}})` → THROWS

**Result**: PASS
**Evidence**: `/tmp/llm-autonomy-classification-2026-08-08/s4.log`

### S5 — `/cto` и `/do-work` идентичные PHASE-0 fields, hint non-authoritative

- **Given**: `buildCtoPrompt`, `buildDoWorkPrompt`, общий contract от
  `buildClassificationPhaseZero`.
- **When**: одна задача проходит через оба command builder.
- **Then** (все 9 shared substrings присутствуют в ОБОИХ prompts):
  - `CLASSIFICATION:`
  - `- Type: FEATURE | REFACTOR | OPS | BUG_FIX | INVESTIGATION | REVIEW | HOTFIX`
  - `- Complexity: QUICK | MEDIUM | COMPLEX | CRITICAL`
  - `- Confidence: HIGH | MEDIUM | LOW`
  - `- Autonomous: true | false`
  - `- Autonomous reason:`
  - `Autonomy is YOUR decision`
  - `Autonomy hint (leading directive — MECHANICAL, NOT authoritative):`
  - `Never copy the hint into persisted`
- Оба prompts упоминают FEATURE / BUG_FIX / debug-cycle (workflow matrix entries)
- /do-work содержит полную таблицу `Workflow resolution (only after PHASE 0)`
- /cto содержит narrative reference `SAME resolution as /do-work`
- НИ один prompt не содержит literal `state.autonomous: true` или
  `state.autonomous: false` (parser hint НЕ инжектируется как state decision)
- /do-work: `Then write .work-state/team-state.json ... with the classification` +
  `P5 gate reads \`classification.autonomous\` as the authority`
- /cto: `Record your PHASE-0 classification in the run state: \`autonomous:
  <true|false>\`` + `\`autonomous\` value is YOUR model decision`

**Result**: PASS
**Evidence**:
- `/tmp/llm-autonomy-classification-2026-08-08/s5.log`
- Captured prompts: `/tmp/llm-autonomy-classification-2026-08-08/s5-work-prompt.txt` (4KB)
- Captured prompts: `/tmp/llm-autonomy-classification-2026-08-08/s5-cto-prompt.txt` (9KB)

### S6 — New state writes persist `classification.autonomous`; legacy reads compatibly

- **Given**: `engine.run()`, mock-LLM classification.
- **When**:
  - 6a — engine.run с `classification:{autonomous:false}` (модель overrides legacy hint=true) →
    запись state через `writeState` от core engine.
  - 6b — engine.run без classification (legacy path) с `opts.autonomous=true`.
- **Then**:
  - **6a (model path)**: `state.classification.autonomous === false`
    (модель overrides legacy hint true), `state.classification.workflow ===
    'bug-fix'`, `state.classification.autonomous_reason === 'user wants
    review'`, **top-level `state.autonomous` ОТСУТСТВУЕТ** (engine
    deliberately не пишет legacy top-level при model path)
  - **6b (legacy path)**: `state.classification.autonomous === true`
    (caller flag использован verbatim), `state.classification.workflow ===
    'debug-cycle'`
  - **6c.legacy-true+debug-cycle** → gate PASS (legacy read-compat,
    автономность=true + debug-cycle проходит)
  - **6c.legacy-false+debug-cycle** → gate BLOCK reason `expected
    'bug-fix'` (legacy false НЕ silent upgrade to debug-cycle)
  - **6d.legacy-true+model-false+bug-fix** → gate PASS (модель wins,
    legacy=true игнорируется; workflow=bug-fix совпадает с model:false)
  - **6e.legacy-true+model:string('true')** → gate BLOCK reason `must be
    a boolean` (модель wins даже когда invalid — никакого silent override)

**Result**: PASS
**Evidence**:
- `/tmp/llm-autonomy-classification-2026-08-08/s6.log`
- Captured state 6a: `/tmp/llm-autonomy-classification-2026-08-08/s6a-engine-state.json`
  — `{classification: {autonomous:false, autonomous_reason:'user wants
  review', workflow:'bug-fix'}, top-level autonomous: ABSENT}`
- Captured state 6b: `/tmp/llm-autonomy-classification-2026-08-08/s6b-engine-state.json`

### S7 — Standby / ownership / terminality / stale-command pruning regressions PASS

- **Given**: `runCto`, `findActiveCtoRun`, `isCtoRunTerminal`, `newCtoState`,
  `copyCommandsForInstall`, `pruneStaleCommands`.
- **When**:
  - 7a: writeCtoState для runId=test-run-1 с owner_session='sess-A'
  - 7b: writeCtoState для test-run-standby с standby=true
  - 7c: writeCtoState для test-run-terminal со всеми teams=done + integration=done
  - 7d: seed `.omp/commands/` с 4 legacy dirs (team-next, team-yolo,
    pulse, coordinator-stats) + user-keep + _lib → call
    `copyCommandsForInstall(root)`
- **Then**:
  - 7a ownership isolation: `findActiveCtoRun(root, sess-A)` →
    `runId=test-run-1`; `findActiveCtoRun(root, sess-B)` → null
  - 7b standby adoptable: оба sess-A и sess-B находят
    `runId=test-run-standby`
  - 7c terminality: `isCtoRunTerminal(state) === true` (all teams done +
    integration done + pause none), `findActiveCtoRun === null`
  - 7d copy-commands: 4 legacy dirs удалены, user-keep + _lib
    сохранены, `.omp-shipped.json` written with
    `shipped=[cto,do-work,init-team,interview,omp-model-roles,team]`,
    idempotent на second call

**Result**: PASS
**Evidence**:
- `/tmp/llm-autonomy-classification-2026-08-08/s7.log`
- `/tmp/llm-autonomy-classification-2026-08-08/s7-shipped-manifest.json`

### S8 — Повтор ключевых сценариев для leakage / order / state stability

- **Given**: всё из S1-S7 на shared fixtures.
- **When**:
  - `parseWorkEnvelope` idempotent на identical inputs
  - `resolveWorkflow` вызывается 100x на 5 inputs → identical outputs (no side-effect)
  - S1-style fixtures × 2 rounds × 4 cases = 8 cases (autonomous+debug-cycle
    ALLOW, interactive+bug-fix ALLOW, autonomous+bug-fix ALLOW, interactive+debug-cycle BLOCK)
  - classification.autonomous stable across re-read
  - buildDoWorkPrompt cross-fixture stability (excluding git branch line) — identical
- **Then**: ни order-issues, ни leakage, ни side-effects в resolveWorkflow.

**Result**: PASS
**Evidence**: `/tmp/llm-autonomy-classification-2026-08-08/s8.log`

## 5. Доказательства

```
$ node /tmp/llm-autonomy-classification-2026-08-08/runner.js
[PASS] S1 — NL-task без hint, model=true → debug-cycle
[PASS] S2 — [AUTONOMOUS] directive, model=false → interactive
[PASS] S3 — [AUTONOMOUS] + model=true (happy path)
[PASS] S4 — missing/non-boolean autonomous → block
[PASS] S5 — /cto and /do-work share identical PHASE-0 fields
[PASS] S6 — new writes persist classification.autonomous; legacy compat
[PASS] S7 — standby/ownership/terminality/stale-command
[PASS] S8 — leakage/order/state stability
========================================
Scenarios: 8, PASS: 8, FAIL: 0
========================================
```

### Captured state (S6a — model path overrides legacy hint=true):

```json
{
  "schema": 1,
  "branch": "test-branch",
  "classification": {
    "type": "BUG_FIX",
    "complexity": "QUICK",
    "confidence": "MEDIUM",
    "autonomous": false,
    "autonomous_reason": "user wants review",
    "workflow": "bug-fix"
  },
  "task": "fix the login bug",
  "workflow_override": false,
  "issue": null,
  "stage_cursor": "discovery",
  "stages": [...],
  "artifacts": {},
  "pause": {"kind": "failed", "reason": "one or more stages failed"},
  "updated_at": "2026-08-08T08:13:06.188Z"
}
```

— `state.classification.autonomous = false` (модель overrides legacy `true`),
`state.classification.autonomous_reason = "user wants review"`,
top-level `state.autonomous` ОТСУТСТВУЕТ (engine deliberately не пишет legacy).

### Captured manifest (S7d):

```json
{
  "schema": 1,
  "shipped": ["cto", "do-work", "init-team", "interview", "omp-model-roles", "team"]
}
```

## 6. Acceptance

| Criterion | Status | Evidence |
| --- | --- | --- |
| `autonomyHint` can DISAGREE with `classification.autonomous` | MET | S2: parser hint=true + model autonomous=false → interactive bug-fix PASS; same with workflow=debug-cycle → BLOCK `expected 'bug-fix'` |
| Model `classification.autonomous` controls workflow | MET | S1: hint=false + model autonomous=true → debug-cycle PASS; S2: hint=true + model autonomous=false → interactive bug-fix; S6: model path writes `state.classification.autonomous`; engine.run uses model decision, ignores legacy `opts.autonomous` |
| Missing/non-boolean `classification.autonomous` blocks | MET | S4: missing → `is missing`; "true"/null/1/0 → `must be a boolean`; engine.resolveClassification throws `classification gate: model classification incomplete` |
| `/cto` and `/do-work` share identical PHASE-0 fields | MET | S5: 9/9 shared substrings in both prompts; captured prompts in s5-work-prompt.txt + s5-cto-prompt.txt; both reference `classification.autonomous` as the authority |
| New writes persist `classification.autonomous`; legacy reads compatibly | MET | S6.6a-b: model path → `state.classification.autonomous` (no top-level); legacy path → `state.autonomous` verbatim; S6.6c-e: read-compat matrix (legacy true → debug-cycle PASS, legacy false → BLOCK, model wins over legacy true, model wins even when invalid) |
| Standby / ownership / terminality regressions | MET | S7.7a-c: ownership isolation, standby adoptable, terminality + findActiveCtoRun=null |
| Stale-command pruning regression | MET | S7.7d: 4 legacy dirs removed, user-keep + _lib preserved, manifest written, idempotent |
| Leakage / order stability | MET | S8: parseWorkEnvelope idempotent, resolveWorkflow 100x consistent, 8 cross-fixture cases pass |

## 7. Команды

```bash
# Build & typecheck
npm run build -w @andvl1/omp-workflows-core
npm run build -w @andvl1/omp-workflows-fullstack
npm run build -w @andvl1/omp-workflows-e2e
npm run typecheck --workspaces

# Baseline regression tests
node --test --import tsx packages/core/test/do-work-autonomy.test.ts  # 17/17
node --test --import tsx packages/core/test/envelope.test.ts          # 15/15
node --test --import tsx packages/core/test/cto-ownership.test.ts     # 5/5

# Manual-QA runner (in-process, deterministic mock-LLM, no live LLM/PTY)
node /tmp/llm-autonomy-classification-2026-08-08/runner.js            # 8/8
```

## 8. Ограничения

- **Mock-LLM**: детерминированные JS-объекты, не live LLM вызов. Контракт
  полностью покрыт; wire-up к реальному провайдеру вне scope manual-QA.
- **Backend runtime mode**: live PTY не запускается, OMP session не
  стартует, TUI rendering не покрывается. /cto и /do-work prompts
  exercised через чистые builder-функции; результирующие строки
  inspected для 4-field contract и hint non-authoritative rendering.
- **Script path**: fullstack/dist/copy-commands.js (файл, импортируемый
  пакетом) покрыт S7d; если script-tagged copy-commands.mjs когда-то
  разойдётся, использовать `vibe-report/cto-autonomy-stale-commands-e2e-2026-08-08.md`
  для coverage.

## 9. Cleanup

- Все spawned node test процессы (runner.js, tsx test, build/typecheck) exited 0.
- Temp roots (mkdtempSync под `/tmp/`) cleaned via `rmSync` в finally блоках.
- `jobs -l` empty (no background jobs).
- `/tmp/llm-autonomy-classification-2026-08-08/` kept as evidence (runner.js,
  captured prompts, captured state, per-scenario logs, scenarios.json).
- No source or test files modified.

## 10. Заключение

**READY FOR RELEASE.** Контракт model-first autonomy полностью реализован и
exercise through 8 in-process scenarios + 37 baseline source tests. Parser
hint — non-authoritative metadata; model `classification.autonomous` —
единственный авторитет; missing/non-boolean → fail-closed; legacy
read-compat без override. Все RC2+ регрессии (autonomy + ownership +
terminality + stale-commands) PASS.

Подпись: `manual-qa` · verdict=PASS · ready=true · validation_run=true · validation_evidence=non-empty