# Stage reference: Discovery

> Loaded on demand by the `/team` interpreter for the `discovery` stage.
> Governance (classification, interpreter loop, gates, DoD) lives in `commands/team.md`.
> This file holds only the prompt templates / criteria for running the stage.

---

### PHASE 1: DISCOVERY

**Goal**: Understand *what* needs to be built well enough to **route** it — not to solve it.

**⚠️ Scope ceiling (orchestrator stage = orientation, NOT investigation).** This stage exists to
verify the already-selected bound branch, frame the task, and route it to the delegated stage. Branch
selection/creation is a user/outer-host precondition before `/do-work` invocation and is captured in
the run metadata; discovery never creates, switches, pulls, or rebinds a branch/run. It is **not** a
place to find root causes, read app logic in depth, ssh prod, query DBs, build, or reproduce — that
is `exploration`/`diagnose`, which are **delegated**. If you find yourself doing real investigation
here, stop and launch the agent (see ORCHESTRATOR ROLE BOUNDARY in `commands/team.md`). Allowed
here: bounded sanitized read-only Git artifact-proof inspection, state/config reads, and a quick
filename-level skim to route. Nothing domain-shaped.

**Actions**:
1. **Verify the prepared/current bound branch** (read-only):
   - Branch selection/creation and capture of its canonical metadata were already satisfied by the user/outer host before `/do-work` invocation and `workflow_prepare`; use only the canonical sanitized read-only form `GIT_OPTIONAL_LOCKS=0 git --no-pager -c core.fsmonitor=false branch --show-current` to compare the current branch with the prepared binding.
   - If the read-only check diverges from the prepared binding, or the branch is detached or missing, fail closed and report the structured inconsistency; do not switch, rebind, or repair it here. The outer host must correct branch selection and reinvoke `/do-work`.
   - Never use `checkout`, `switch`, branch creation, `pull`, or any other branch setup/synchronization command here; never reuse stale metadata or rebind an active run.

2. Create todo list with all phases

3. If request unclear, ask:
   - What problem are you solving?
   - What should the feature do?
   - Any constraints or requirements?

4. Summarize understanding and confirm

**Output**:
- Prepared/current bound branch read and verified against the captured metadata (the stage never creates, switches, or pulls it).
- Clear, confirmed feature description; any branch divergence, detachment, or absence is a failed-closed structured inconsistency for outer-host correction and `/do-work` reinvocation.

**Checkpoint**: ✋ WAIT for user confirmation before Phase 2

---

