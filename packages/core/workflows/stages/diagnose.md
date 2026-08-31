# Stage reference: Diagnostics

> Loaded on demand by the `/team` interpreter for the `diagnose` stage (bug-fix / debug-cycle).
> Governance lives in `commands/team.md`. This file holds the prompt template / criteria.

---

**Delegate, don't DIY.** Your first action for this stage is an OMP `task` call. The diagnostics agent gathers its own context.

Launch the **diagnostics** agent to find the root cause before any code change.

```
Agent (diagnostics):
"Investigate: [error description / stacktrace / expected-vs-actual].
 Run the 5-phase diagnostic workflow:
 1. Static analysis of relevant code
 2. System commands (build, logs, tests)
 3. Add temporary debug instrumentation
 4. Runtime analysis
 5. Localize root cause with a proposed fix"
```

**Root-cause gate (`root_cause_documented`) — MANDATORY before implementation:**

The gate enforces ONE explicit diagnosis contract, identical to
`workflows/artifacts-schema.json` (both fields are schema-required):

- Write `diagnosis.root_cause` to `.work-state/artifacts/diagnosis.json`: **what** the root
  cause is.
- Write `diagnosis.explanation` to the same artifact: **why** the proposed fix closes that
  cause rather than masking the symptom.
- Both must be non-empty; the gate rejects the advance with the exact offending field
  (`diagnosis.root_cause is empty` / `diagnosis.explanation is empty`).
- Do at least **2 iterations** of repro/log evidence before proposing the fix.
- This directly answers the "опять мимо" (fix-the-symptom) failure mode. The workflow's
  root-cause gate blocks implementation until the evidence is recorded.

**Produces**: `diagnosis` (root_cause, explanation, evidence, proposed_fix,
verification_checklist) and `dod` (the Definition of Done — for a bug, minimum items:
root cause named; repro-before reproduces; repro-after does not; affected scenario
checked in manual-qa). See `workflows/artifacts-schema.json`.
