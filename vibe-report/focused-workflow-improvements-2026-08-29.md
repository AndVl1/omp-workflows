# Focused workflow improvements — wave-004 final report

- Run: `01a03ee4-7dd6-7580-8ad7-16d26dc886ba`, slice `focused-workflow-improvements`
- Branch: `do-work-show-command`, baseline `81365d6` — 2026-08-29
- Author: `FocusedWorkflowLead.FocusedWorkflowDocs` (final documentation handoff; source work by the wave-004 workers, rework by the review-driven correction workers)

**Outcome:** all four workstreams are implemented, passed fresh security and correctness re-reviews (both ACCEPT), and Main's post-rework validation is green across build, typechecks, all test suites, `git diff --check`, and a live OMP 18.0.6 smoke. This report claims no version bump, tag, release, commit, or push.

---

## 1. What shipped

### 1.1 Adaptive semantic roster selection

- Roster stages expose their allowed role pool through `workflow_instructions` before any capability exists; `workflow_begin` accepts only semantic role/facet/focus/reason selections — concrete agent ids are rejected at the tool boundary (strict zod) and the durable boundary.
- Selections are validated against the live registered agent mapping and fail closed on unmapped roles, multiplicity/bounds violations, or a missing trusted mapping; no identity or unrelated-stack fallback on roster stages.
- Frozen selection bound to the capability epoch: identical re-issue is idempotent, a changed selection is rejected naming the frozen `snapshot_id`.
- **Advancing INTO a roster-policy stage defers selection and capability issuance until an explicit `workflow_begin`** (the stage stays `pending`, nothing preselected or frozen at the advance boundary); non-roster stages arm normally at advance, and a loop `back_to` a roster stage defers the same way. Documented in `packages/core/workflows/README.md` protocol steps 4/6.
- Full-feature `exploration` and `architecture` moved from fixed alias manifests to bounded 1..3 worker pools with deterministic defaults (minimum valid set plus at most one risk-trigger addition); `architect_minimal`/`architect_clean`/`architect_pragmatic` removed from shipped roles, fallbacks, examples and init-team output; selections normalize to stable numbered repeated-role slots (`architect#1..#3`).

### 1.2 Private internal bundle activation

- Activates through the supported OMP 18.x project extension setting (`.omp/settings.json#extensions` → `node_modules/@andvl1/omp-workflows-internal` only); marker-gated namespaced `/omp-do-work`, `/omp-team`, `/omp-cto` plus read-only `/omp-workflow-team validate`.
- Ownership: `workflow_registration` claimed by the command layer first, then all three engine capabilities idempotently under the single `private_omp` owner inside marked workspaces; typed fail-closed `activation_markers_missing` with zero owner claims outside.
- Host agent discovery is bundle-owned and lazily injected: `session_start` kicks off the marker-gated mapping refresh, `workflow_begin` awaits it, discovery is filtered to exact `omp-*` candidates with no generic fallback; custom external plugin agents (`product-*`) and project-local role mappings preserved.
- Bare `/do-work`, `/team`, `/cto` are never registered by this bundle — when a separately installed fullstack plugin is active they appear in the inventory from that plugin (observed on OMP 18.0.6), and the internal bundle never owns or shadows them.

### 1.3 Canonical `teams[].dod_path`

- One resolver (`resolveDodPath`/`readDoDFile` in `packages/core/src/engine/dod.ts`) for every consumer (slice gate, integration gate, session report, visualization): directory containing `dod.json` or the file itself; unset defaults to `.work-state/artifacts/<teamId>`.
- Fail-closed safety: relative-only, no `..`/empty segments, no NUL, length caps, symlinked ancestors/targets rejected, realpath containment; unsafe values are never echoed. Missing/malformed diagnostics name the resolved file path plus cause.
- Visualization DoD planning applies the excluded-input predicate before safe read (review remediation); `/cto` prompts state both accepted forms explicitly.

### 1.4 Preserved invariants

- Wave-001 command discoverability: `/do-work`, `/team`, `/cto` remain owned by the external fullstack plugin (`registerWorkflowCommands`, exported surface unchanged); presentation copy derives from the actually registered names — bare output byte-for-byte identical, `namespace='omp'` renders the `/omp-*` equivalents.
- Archived workflow-v2 disposition: the blocked experiment exists only on `backup/workflow-v2-blocked-2026-08-29` (commit `b3cdc1e`); this branch is wave-004 fixes and revives nothing from workflow-v2.

## 2. Review and acceptance (trusted remediation facts)

Two fresh targeted reviews after the final rework round, both **ACCEPT**:

- **Correctness re-review: accept.** Prior blockers remediated and rechecked:
  - `W004-CONTRACT-EPOCH-001` (P2) — legacy state without an authoritative top-level cursor epoch could expose an unbound selection; core remediation now requires explicit epoch equality with missing-epoch masking fixtures.
  - `W004-INTERNAL-ACTIVATION-ORDER-001` (P1) — internal mapping refresh previously preceded first-session config seeding; remediation seeds the supported runtime config synchronously before refresh, preserving no-overwrite and unmarked fail-closed behavior.
  - `W004-VIS-EXCLUSION-002` (P1) — canonical visualization DoD planning bypassed excluded-input filtering; remediation applies the exclusion predicate before safe read, reserves unsafe/missing paths, and suppresses the generic fallback with fixtures.
- **Security re-review: accept, zero blocking findings.** `W004-VIS-TOCTOU-READ` (medium) is pre-existing at baseline `81365d6` and not widened by this wave; deferred to open bead `br-w004-vis-toctou-read-w0l` (P2 bug, open/unblocked).

## 3. Final validation — Main-observed (post-rework rerun)

| Check | Result |
|---|---|
| `npm run build` | PASS (core, e2e, fullstack, internal) |
| `npm run typecheck` | PASS, all workspaces (fullstack: source + custom commands) |
| Focused core suites | 214/214 |
| Full core suite | 746/746 |
| e2e package | 67 passed / 0 failed / 7 skipped (node-pty native binding unavailable for PTY/browser fixtures) |
| Fullstack suite | 277/277 |
| Internal suite | 74/74 |
| `git diff --check` | PASS (clean) |

Live OMP 18.0.6 smoke (actual host):

- Marked-workspace command inventory: `omp-workflow-team`, `omp-do-work`, `omp-team`, `omp-cto` — plus bare `do-work`/`team`/`cto` from the separately active fullstack plugin, which the internal bundle does not own.
- `/omp-workflow-team validate`: markers OK; `workflow_registration`, `workflow_tools`, `config_writer` all claimed by `@andvl1/omp-workflows-internal` (`private_omp`); 14-agent pool; live mapping source is the internal bundle (e.g. `analyst → omp-analyst`, `developer → omp-engine-specialist`, `code-reviewer → omp-code-reviewer`), unavailable external roles reported.
- `/omp-do-work` dispatch emitted the internal classification prompt with autonomy OFF, the eight-step instructions-before-begin contract, and omp-* runtime role mapping; namespaced usage text is correct.
- Unmarked-workspace negative smoke: `activation_markers_missing`, all three capabilities unclaimed.

The documentation worker ran **no** validation itself (`validation_run: false`); every result in this section is Main's evidence.

For the record: `.work-state/artifacts/focused-workflow-improvements/wave-004/main-validation.json` now carries the final post-rework evidence (`status: accepted_final`, evidence owner Main) and matches the table above; the earlier failing/rework rounds remain only in correction/history artifacts and are not represented as current validation anywhere.

## 4. Deferred items and scope notes

- `br-w004-vis-toctou-read-w0l` — harden generic (non-DoD) visualization artifact reads against pathname TOCTOU (`packages/core/src/visualize/snapshot.ts`); pre-existing at baseline, P2, open/unblocked; explicitly a non-goal for this wave.
- The 7 e2e skips are environmental (node-pty), not failures.
- `product-*` external agents have no provider in this checkout; selecting them fails closed with a clear diagnostic — by design.

## 5. Evidence

- Source worker results: `roster-worker-result.json`, `dod-worker-result.json`, `dod-root-cause.json`, `internal-activation-worker-result.json`, `internal-identity-correction-result.json`
- Final review/rework artifacts: `final-review-findings.json`, `final-correctness-rereview-fresh-result.json`, `final-security-rereview-fresh-result.json`, plus the correction/rework results in the same directory
- Final validation evidence: `main-validation.json` (`status: accepted_final`); earlier failing/rework rounds preserved only in correction/history artifacts
- All under `.work-state/artifacts/focused-workflow-improvements/wave-004/`

Docs deliverables (this worker): `CHANGELOG.md` Unreleased entry, `packages/core/workflows/README.md` roster protocol, root `README.md` private-bundle section, this report, and `documentation-worker-result.json`. No source, config, or test files were touched by the documentation worker.
