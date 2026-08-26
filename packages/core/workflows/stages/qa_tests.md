# Stage reference: Automated Tests

> Loaded on demand by the `/team` interpreter for the `qa_tests` stage.
> Governance (classification, interpreter loop, gates, DoD) lives in `commands/team.md`.
> This file holds only the prompt templates / criteria for running the stage.

---

**🚫 Delegate, don't DIY.** Your first action for this stage is the Task call to the `qa` agent.

### PHASE 6.8: AUTOMATED TESTS — encode observed behavior as regression tests

**Why sequenced (v3.0):** tests are written **after** manual QA so they encode what was actually
observed working (`manual_qa.evidence`), not a guess made against unverified code. A
`CONDITIONAL` manual-qa verdict allows deterministic regression tests to proceed, but does not
prove the live acceptance criteria that an explicit capability, credential, or configuration
blocker made unobservable. This is the last runtime stage before summary.

**Gate** (`manual_qa.verdict != FAIL || !scope.has_runtime`): write/accept tests when manual QA
passed or is `CONDITIONAL` with runtime evidence. If there is no runtime (`!scope.has_runtime`),
manual_qa is skipped and the fallback remains valid. A `FAIL` verdict while runtime exists, or a
missing/unknown manual_qa verdict while runtime exists, never passes this gate.

**Input**: `manual_qa` (evidence + verdict + any `blocked_prerequisites`) when present, plus
`implementation` / `architecture`.

**Actions**:

1. Launch the qa agent:
   ```
   Agent (qa):
   "Write automated regression tests for the shipped change.

    Inputs:
    - manual_qa.evidence (if present) — each observed behavior becomes a test case
    - manual_qa.verdict and manual_qa.blocked_prerequisites — distinguish observed behavior
      from criteria that remain unproven because a capability/credential/config blocker exists
    - implementation.files_touched — the code under test

    Requirements:
    - encode the manually-observed behavior as durable tests (unit/integration/e2e as fits)
    - cover the acceptance criteria and any regressions manual-qa flagged
    - when verdict is CONDITIONAL, deterministic checks may proceed, but do not claim blocked
      live criteria are proven; retain the blocker context in coverage_note
    - run the test suite; report pass/fail
    - do NOT rewrite production code — if a test reveals a defect, report it as a finding

    Produce the `qa_tests` artifact (schema `qa_tests`):
    - tests_added: files/cases added or updated
    - build_status: pass | fail | n/a
    - based_on_manual_qa: true on the has_ui path
    - coverage_note: what is and isn't covered, including any CONDITIONAL blocker"
   ```

2. Write `.work-state/artifacts/qa_tests.json`.

**Feeds**: `summary` consumes `qa_tests`.

---

### DoD fan-in (source: qa_tests)

**Append** test-plan criteria — what the automated suite must cover — and **close** any DoD item
your tests now prove (status `met`, evidence = test output). Use `source: "qa_tests"` and
`id: "qa_tests-<n>"`; bump `updated_at`. See `commands/team.md` § Multi-source fan-in.
