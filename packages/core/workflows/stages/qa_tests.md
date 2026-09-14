# Stage reference: Automated Tests

> Loaded on demand by the `/team` interpreter for the `qa_tests` stage.
> Governance (classification, interpreter loop, gates, DoD) lives in `commands/team.md`.
> This file holds only the prompt templates / criteria for running the stage.

---

**🚫 Delegate, don't DIY.** Your first action for this stage is the Task call to the `qa` agent.

### PHASE 6.8: AUTOMATED TESTS — encode observed behavior as regression tests

**Why sequenced:** tests run in an independent QA stage after implementation and any review fixes. QA may consume implementation, review, and manual-QA reports as context, but those worker attestations never prove the test gate.

**Gate** (`qa_reported_pass`): the canonical `qa_tests` artifact must report
`build_status: "pass"`. A missing artifact, `fail`, or `n/a` status blocks the
workflow; there is no runtime or manual-QA fallback.

**Input**: implementation/review-fix reports and `manual_qa` when present. These
reports are informational worker attestations only. The QA worker chooses the
project-specific test commands from the repository and records the result in
the canonical artifact; the profile must not guess a package-manager command.

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
