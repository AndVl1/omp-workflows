# Reconstructed stage prompt preview — 2026-08-08

## Result
PASS. Stage details now include an optional nested prompt preview based on persisted workflow metadata.

## Semantics
The report does not claim to show the literal runtime prompt. `/do-work` and CTO per-stage task text is generated dynamically by the main agent and is not persisted. The report instead reconstructs a bounded preview from the stage definition, session task, truthful agent roster, declared input/output ids, and checkpoint/gate/autonomous metadata.

## Implemented
- Added optional `StageInfo.promptPreview`.
- Profile-backed do-work and CTO stages receive a deterministic preview; custom/legacy and derived CTO team stages without a `StageDef` do not.
- Preview is capped at 4096 characters; oversized task text is clipped first so stage metadata remains visible.
- Nested `Show reconstructed prompt preview (not the original runtime prompt)` disclosure is collapsed by default.
- Preview content is escaped into a line-preserving bounded `<pre>`; no raw artifact JSON, transcripts, tool arguments, or external resources are embedded.

## Verification
- Core full suite: **319/319 passed**; build/typecheck clean.
- Fullstack suite: **179/179 passed**; build/typecheck clean.
- Browser QA via `playwright-cli`: **PASS**.
  - 10 stage cards and 10 nested previews initially closed.
  - Code Review preview expanded to 8 lines containing stage id/type, task, agents, inputs, outputs, checkpoint and gate.
  - No raw artifact keys/body markers observed.
  - Filters, node selection/highlighting, zoom and reset remained functional.
  - No external requests; only expected favicon 404.
  - Browser session/server/screenshots cleaned up.
- Code review: **APPROVE**; strict bound and metadata preservation follow-up applied.

Scenario: `vibe-report/session-prompt-preview-e2e-scenario.md`
