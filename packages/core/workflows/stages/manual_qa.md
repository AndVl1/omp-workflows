# Stage reference: Manual QA / Runtime Verification (on fixed code)

> Loaded on demand by the `/team` interpreter for the `manual_qa` stage.
> Governance (classification, interpreter loop, gates, DoD) lives in `commands/team.md`.
> This file holds only the prompt templates / criteria for running the stage.

---

**Delegate, don't DIY.** Your first action for this stage is an OMP `task` call with
`agent: "manual-qa"`. Do not drive the app or device yourself.

### PHASE 6.7: MANUAL QA — sequenced, on the FIXED code

**NOT UI-only.** This is manual *runtime* verification: observe the shipping code actually running.
The mode depends on scope:

| scope | mode | how manual-qa verifies |
|-------|------|------------------------|
| `scope.has_ui` (frontend/mobile) | **ui** | drive the real UI via OMP `browser` (web) or configured device automation (app); screenshot + console + network |
| backend / CLI / service (no UI) | **runtime** | run the app/binary, hit endpoints (`curl`), read logs/output, check exit codes |

**Skip when**: `!scope.has_runtime` — i.e. there is nothing to run (pure docs/config/research
change). The interpreter skips the stage only then; a backend-only task is **not** skipped.

**Why sequenced (v3.0):** manual QA runs **after `review_fixes`**, so it exercises exactly the
code that will ship. Its evidence then feeds `qa_tests`, which encodes what was observed into
durable automated tests.

**Input**: the `review` (fixes applied), `implementation`, `architecture`, and — when present —
`feature_spec.acceptance_criteria` (use it as the checklist).

**Actions**:

1. Launch OMP `task` with `agent: "manual-qa"`:
   ```
   manual-qa:
   "Manually verify the shipped change at RUNTIME against the acceptance criteria.

    Inputs:
    - feature_spec.acceptance_criteria (if present) — each is a pass/fail check
    - architecture + implementation — what changed and where

    Pick the mode from scope:
    - UI (has_ui): use OMP `browser` for web or configured device automation for the app;
      screenshot each criterion and state WHAT IS VISIBLE; check console + network.
    - RUNTIME (no UI): run the app/binary; hit the affected endpoints/commands
      (curl, CLI invocation); capture the actual responses/exit codes and the
      relevant log lines.

    For each criterion record concrete evidence. Check for regressions in adjacent flows.

    Produce the `manual_qa` artifact (schema `manual_qa`):
    - verdict: PASS only if every acceptance criterion was observed working at runtime
    - verdict: CONDITIONAL only when deterministic/runtime checks produced real evidence but one or more required criteria are unavailable because of an explicit capability, credential, or configuration blocker
    - verdict: FAIL for an observed failure; missing or unknown remains fail-closed
    - mode: ui | runtime
    - evidence: array of concrete observations (screenshot+what's visible, or curl+response+logs)
    - blocked_prerequisites: for CONDITIONAL, identify each unavailable criterion and its blocker; never include secrets, raw provider/media data, or fabricated positive live evidence
    - regressions: anything pre-existing that broke (empty if none)
    - dod_additions: acceptance criteria to append to dod.json (source: manual_qa)
   ```

2. Write `.work-state/artifacts/manual_qa.json`.

**Gate** (`manual_qa.verdict != FAIL`): a `FAIL` verdict blocks progress — loop back to
`review_fixes`/implementation with the failing evidence, or escalate to the user. `PASS`
requires all acceptance criteria to be observed at runtime. `CONDITIONAL` is terminal only
when the runtime/deterministic evidence is real and an explicit capability, credential, or
configuration blocker makes one or more required criteria unobservable; preserve that blocker
in `blocked_prerequisites`. A missing or unknown verdict is treated as FAIL (never auto-pass).

**Feeds**: `qa_tests` consumes `manual_qa.evidence`; `summary` consumes the verdict.

---

### DoD fan-in (source: manual_qa)

**Append** acceptance criteria you verified — for UI include *what must be visible on the
screenshot*; for runtime include *the endpoint/command + expected response/log* — via the
`manual_qa` artifact `dod_additions[]` (which the orchestrator merges into `dod.json` with
`source: "manual_qa"`), and **close** items you verified with the observation as evidence.
Bump `updated_at`. See `commands/team.md` § Multi-source fan-in.
