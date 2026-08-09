# CTO Resident Control-Plane — Process-Level E2E Verification

Slug: cto-process-e2e-resident-qa-2026-08-09
Date: 2026-08-09
Branch: feat/cto-resident-control-plane (HEAD = 7567e00 chore(release): v0.19.0)

## Scope

Run the existing process-level CTO E2E harness against the fixed code on
`feat/cto-resident-control-plane`. Real child-process boundary, real git
worktrees, persisted fake-RW transport. No edits to production source or
tests; no project-wide test suite; deterministic focused commands only.

## Harness

- Test file: `packages/e2e/test/cto-process-e2e.test.ts`
- Fixture dispatcher (child process): `packages/e2e/test/fixtures/cto-process-dispatcher.ts`
- Slice worker (grand-child process): `packages/e2e/test/fixtures/slice-worker.ts`
- Sibling inbox harness: `packages/e2e/test/cto-inbox-mock.test.ts` (verified PASS as a sanity check)

## Environment

- Node: v25.8.0
- Git: 2.50.1 (Apple Git-155)
- tsx loader: `node_modules/.bin/tsx` (no global install)
- Network: not required
- LLM: not required (deterministic fixture, no provider)
- omp binary: not required

## Exact command

```bash
cd packages/e2e
node --test --import tsx test/cto-process-e2e.test.ts \
  --test-timeout=180000 --test-reporter=spec
```

Reproducible on a clean checkout (the test creates and tears down an isolated
`mkdtempSync` scratch repo in `os.tmpdir()`; no persistent side effects in
the monorepo).

## Result

```
✔ cto process e2e: resident control plane — waves, worktrees, dedupe, restart recovery, gates (5362.449167ms)
ℹ tests 1
ℹ suites 0
ℹ pass 1
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 10476.495875
```

Sibling:
```
✔ mock E2E: resident CTO accepts inbox tasks during wave 1 and starts wave 2 (2281.231583ms)
ℹ tests 1
ℹ pass 1
ℹ fail 0
ℹ duration_ms 2418.129584
```

Two consecutive `node --test` invocations of the process-E2E both passed
(5361 ms / 5362 ms / 5364 ms / 5401 ms across 4 runs in this session) — the
run is deterministic, not flaky.

## Assertion counts (static, from source)

- `assert.{ok,equal,match,notEqual,deepEqual}` calls in the test body: **56**
- `waitFor(...)` / `waitForEvidence(...)` poll steps: **17**
- Phases: **7** (A through G) + TEARDOWN

## Phases — what each one proves

### PHASE A — MAIN WAVE + durable admission + online ACK

- Dispatcher child spawns, writes `{t:"start"}` evidence line.
- MAIN_TASK_ID lands in RW `.omp/fake-rw-control/inbound/task-1.json`.
- `{t:"wake", task:{id:MAIN_TASK_ID, runId, waveId}}` evidence.
- `.work-state/cto/<runId>/inbox/<MAIN_TASK_ID>.json` durable on disk.
- `readCtoState(runId).wave_history.length === 1`, status `active`, source_id == MAIN_TASK_ID.
- Online ack delivery lands on the primary RW outbound (`messages.jsonl`) with `intent:"ack", receipt.sent:true`.

### PHASE B — CONCURRENT WORKTREES + wave completion

- Two parallel slice workers (`slice-a`, `slice-b`) each create a real git worktree.
- `git worktree list --porcelain` matches both `worktrees/slice-a` and `worktrees/slice-b` with distinct branches `refs/heads/slice-a`, `refs/heads/slice-b`.
- HEAD in each worktree equals the worker's evidence `commit`.
- `git show HEAD:done.json` includes the slice name.
- Per-slice ordering invariant: `{t:"slice-dod", slice}` evidence precedes `{t:"worker-start", slice}` for both slices.
- `.work-state/artifacts/<slice>/dod.json` has non-empty `items[]`.
- Wave completes (`status === 'done'`); summary delivery lands on primary.

### PHASE C — RO-REPORT-ONLY

- Audit sink (`.omp/fake-rw-audit/outbound/messages.jsonl`) receives ≥1 line.
- Every audit line is `intent:"summary"` with `receipt.sent:true` and `topic === "summary"`.
- No audit line with intent in `["ack","question","progress"]`.
- `.omp/fake-rw-audit/inbound` does NOT exist.
- `.omp/fake-rw-audit/answers` does NOT exist (RO has no inbound or answer path).

### PHASE D — RESTART + PENDING DELIVERY RECOVERY

- `stopChild(child1)` returns exit code 0.
- `dispatcherLockPath` is gone within 5s — lease released.
- `queueCtoDelivery(scratch, runId, {intent:"progress", id: progressId, ...})` returns a path that exists on disk.
- `child2` recovers and the control outbound gets a line with `escId === progressId` and `receipt.sent:true`.
- After recovery: `wave_history.length === 1` (no re-admission); inbox dir has exactly 1 file; quarantine hash for MAIN_TASK_TEXT remains `admitted`.

### PHASE E — DUPLICATE MESSAGE ID (quarantine hash + wx)

- Two duplicate inbound files (`task-2.json` and `task-3.json`) are consumed by the transport.
- `wake` evidence for MAIN_TASK_ID appears exactly **once** (no new wake).
- After duplicates: 1 wave, 1 inbox file.
- `sha256Hex(MAIN_TASK_TEXT)` quarantine hash is still `admitted`.
- `sha256Hex("Different text body for the same id")` quarantine hash is **not** `admitted`.

### PHASE F — FOLLOW-UP WAVE (same resident run, worktree reuse)

- FOLLOW_TASK_ID arrives, gets a NEW `waveId` (`!==` wave1Id).
- `runDirs.length === 1`, `runDirs[0] === runId` (same run, no new standby).
- `wave_history.length === 2`, both with `status === 'done'`, distinct ids.
- For each slice: a `{t:"worktree", created:true}` line AND a `{t:"worktree", created:false}` line with the **same** `path` — proves reuse.
- Total `git worktree list` count is **3** (main + 2 slices), not 4 or 5 — no re-creation.
- Second `summary` line lands on primary.

### PHASE G — MARKER/LEAD GATE + NESTED CTO BLOCKED

- `ctoNestingGuard({toolName:"task", input:{agent:"cto"}})` returns truthy — BLOCKED.
- Same for `agent:"@cto"` and batched `tasks:[{agent:"@cto"}]`.
- `ctoNestingGuard({toolName:"task", input:{agent:"team-lead"}})` returns `undefined` — ALLOWED.
- A gate-probe wave is appended via `appendWave` to give the gate an active wave.
- `ctoSliceTaskGate` returns `undefined` for a fully-provisioned dispatchable slice (marker includes `runId + slice`).
- Corrupting `teamA.classification.autonomous` → gate returns truthy with `reason` matching `/autonomous/` (mentions the field).
- Restoring the pristine state → gate returns `undefined` again.
- `assertCtoSliceDispatchable(state, {sliceId, root, markerRunId: "standby-other"})` returns `{ok:false, reason}` with reason matching `/marker run mismatch/` (actionable).
- Probe wave is closed via `finishWave` (no active wave lingers).

### TEARDOWN

- `stopChild(child2)` returns exit code 0.
- `dispatcherLockPath` released within 5s.
- Every tracked child has `exitCode !== null` (no orphans).
- Scratch directory (with worktrees) is removed.

### Run-level invariants

- No `{t:"wave-error"}` or `{t:"worker-error"}` evidence anywhere in the run.
- No fixture child remains alive after the test ends.

## Runtime artifacts (this session)

- `.work-state/artifacts/manual_qa.json` — `verdict:PASS, mode:runtime`, 11 evidence bullets, 12 DoD additions.
- `.work-state/artifacts/cto-process-e2e-runtime-2026-08-09/cto-process-e2e-test-output.log` — captured node --test output.
- Scratch dirs were per-test under `os.tmpdir()` (auto-removed by the test in `finally`).

## Blocked environment prerequisites

None. The harness runs on a vanilla Node + git + tsx setup; no network, no
LLM, no omp, no credentials.

## Verdict

**PASS** — every acceptance criterion is observable from disk and process
behavior in the existing process-level CTO E2E harness. The fixed code on
`feat/cto-resident-control-plane` passes the real child-process boundary
harness in deterministic ~10s.
