import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseAutonomousDirective } from "./envelope.js";
import { buildClassificationPhaseZero, buildWorkflowMatrix } from "./classification-contract.js";
import { DETACHED_BRANCH, NO_GIT_BRANCH, resolveActiveBranch, resolveState } from "../engine/state.js";
import { readAgentMapping } from "../engine/agent-mapping.js";
import type { Complexity, TaskType, WorkflowName } from "../engine/types.js";

export interface ParsedWorkEnvelope {
  task: string;
  /**
   * MECHANICAL hint from the leading-directive parser. NON-AUTHORITATIVE:
   * PHASE-0 has the main LLM decide `autonomous` from the full task
   * semantics; this value is rendered as a hint and never persisted.
   */
  autonomyHint: boolean;
  /** @deprecated Use autonomyHint; retained for parsed-envelope consumers. */
  autonomous: boolean;
  issue: number | null;
  branch: string | null;
}

export interface WorkTeamConfig {
  roles?: Record<string, string>;
}

export function parseWorkEnvelope(args: string, cwd: string): ParsedWorkEnvelope {
  const directive = parseAutonomousDirective(args);
  const autonomyHint = directive.autonomyHint;
  const cleaned = directive.task;
  const issueMatch = cleaned.match(/issue=#(\d+)/);
  const issue = issueMatch ? Number(issueMatch[1]) : null;
  const task = (issueMatch ? cleaned.replace(issueMatch[0], "") : cleaned).trim();
  const activeBranch = resolveActiveBranch(cwd);
  const branch = activeBranch === NO_GIT_BRANCH || activeBranch === DETACHED_BRANCH ? null : activeBranch;
  return { task, autonomyHint, autonomous: autonomyHint, issue, branch };
}

function loadTeamConfig(cwd: string): WorkTeamConfig {
  const path = resolve(cwd, ".omp", "team.config.json");
  if (!existsSync(path)) return {};
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as WorkTeamConfig;
    const mapping = readAgentMapping(cwd);
    if (!mapping) return raw;
    const configuredRoles = raw.roles ?? {};
    return {
      ...raw,
      roles: Object.fromEntries(
        Object.entries(configuredRoles).map(([role, agent]) => [role, mapping.resolved_roles[role] ?? agent]),
      ),
    };
  } catch {
    return {};
  }
}

export function buildDoWorkPrompt(envelope: ParsedWorkEnvelope, cwd: string): string {
  const roles = Object.entries(loadTeamConfig(cwd).roles ?? {});
  const roleTable = roles.map(([role, agent]) => `| \`${role}\` | \`${agent}\` |`).join("\n");
  const issueMeta = envelope.issue ? `Issue: #${envelope.issue}\n` : "";
  const branchMeta = envelope.branch
    ? `Branch: \`${envelope.branch}\` (canonical session branch; persist this exact value)\n`
    : "Branch: (no git work tree; strict workflow transitions cannot start)\n";
  const resolvedState = resolveState(cwd, envelope.branch ?? undefined);
  let continuation = "No existing do-work state was found. Start a new workflow.";
  if (resolvedState.state && !resolvedState.isStale && resolvedState.statePath) {
    continuation = [
      `Existing workflow state found at \`${resolvedState.statePath}\`. This is a resumable continuation, not a new task.`,
      "Read it before choosing stages; preserve its classification, artifacts, stage history, and prior task text.",
      "If the user reports a defect in the previous result, append the feedback to the task/history, reopen the smallest affected stage, reset only that stage and its downstream stages to pending, and continue from there.",
      "Do not discard or overwrite completed artifacts unless the reopened stage produces a replacement artifact.",
    ].join("\n");
  }
  return [
    "/do-work classification pass — understand the task before selecting a workflow.",
    "",
    "### Task",
    envelope.task,
    "",
    "### Metadata",
    issueMeta + branchMeta,
    "",
    continuation,
    "",
    buildClassificationPhaseZero({ label: "leading directive", value: envelope.autonomyHint }),
    "",
    buildWorkflowMatrix(),
    "",
    "After PHASE-0 classification, call `workflow_prepare` with the task, the exact canonical branch, the classification object, changed file paths, and issue metadata. For a continuation, pass the existing feedback and affected stage instead of creating a new state.",
    "`workflow_prepare` is the ONLY supported state initialization/update path: do not call `write`, `edit`, `bash`, or any filesystem API to create or modify `.work-state` files. It persists the classification, resolved workflow, task, branch, stages, scope, and durable capability atomically.",
    "If `workflow_prepare` fails, stop and record the structured error — never guess a state path or repair canonical state by hand. The P5 gate reads `classification.autonomous` as the authority.",
    "If confidence is LOW, ask a focused clarification question before preparing an expansive workflow (unless `autonomous` is true; then document a conservative default).",
    "",
    "### Only after workflow_prepare succeeds",
    "1. Call `workflow_begin` to issue the durable opaque capability for the current stage. On a resumed active stage, it may reissue fresh plaintext secrets while preserving the capability identity and authorized dispatch records; always use the newly returned handoff and never retry a stale token. If it fails, stop and record the error — never guess stage content.",
    "2. Call `workflow_instructions` and treat its returned current stage contract (`stage.instructions`, `roles`, `consumes`, `produces`, `artifact_schemas`, `slot_artifacts`, `checkpoint`/`gate`, `provenance`, and `state.artifactsDir`) as the ONLY workflow instruction source. Use `state.artifactsDir` as the exact destination for every declared artifact; do not read, glob, or infer workflow profile JSON or artifact schemas from the filesystem, package paths, or plugin directories.",
    "3. Continue executing in THIS TURN. Do not stop after printing CLASSIFICATION or preparing state; immediately call `workflow_begin` and `workflow_instructions` and walk the returned stage contract.",
    "4. On continuation, skip stages already done/skipped and start at the first reopened or pending stage.",
    "5. For each `single` stage, call `task` once; for each `consilium` stage, use one parallel `task` batch. Every delegated task payload must state that `workflow_*` control tools are main-session-only, must not mutate canonical `.work-state` with `bash`, and must use `write` for its declared artifact before returning. In a consilium, each role writes only its own `slot_artifacts[role]` files; never write the shared produce id directly.",
    "6. Before writing any declared artifact, match its JSON exactly to `stage.artifact_schemas[artifactId]`; for `dod`, `items` MUST be objects with `criterion`, `verify_method`, and `status` (`pending` or `met`), never bare strings or a legacy `criteria` array.",
    "7. After every task result, call `workflow_status`. For every dispatch whose status is not `succeeded`, wait or fail closed. For every succeeded dispatch whose `artifact_ids` is empty, call `workflow_complete` exactly once with the dispatch's identity binding and the exact artifact IDs from `slot_artifacts` (including `produce-slot` IDs for consilium); do not treat a native task result as artifact completion. If the runtime already repaired a synchronous completion, use the IDs shown by `workflow_status` and do not replay it with different IDs.",
    "8. Before `workflow_advance`, if the current stage contract declares a non-null `checkpoint`, call `workflow_checkpoint` first with the same capability handoff, checkpoint name, mode, decision, and rationale; for autonomous stages, record the orchestrator's explicit proceed/approve decision instead of relying on `workflow_advance` to infer it.",
    "9. After every `workflow_advance`, call `workflow_instructions` again and use the returned next-stage contract. If any workflow tool errors, apply only the single binding-recovery retry defined in the OPAQUE CAPABILITY EXECUTION PROTOCOL; otherwise fail closed, stop, and record the failure rather than guessing the stage.",
    "10. When a stage or the whole workflow finishes, remain available in this same session: later user feedback reopens the affected state instead of starting a fresh workflow.",
    "",
    "### Role mapping (effective runtime resolution)",
    "| Role | Agent |",
    "| --- | --- |",
    roleTable || "| (no roles configured) | |",
    "",
    "### Hard constraints",
    "- Do NOT call `task` during classification.",
    "- Do NOT glob for workflow files or scan installed plugins.",
    "- Do NOT read command sources or reconstruct classification from keywords.",
    "- Do NOT copy the autonomy hint ([AUTONOMOUS]/natural directive) into state as the decision —",
    "  persist your own `autonomous` classification from PHASE-0.",
    "- Do NOT mark a stage done without its required artifact and gate evidence.",
    "",
    "### STRICT ORCHESTRATOR POLICY (non-negotiable)",
    "You are the workflow orchestrator, not an implementation agent. Your allowed work is limited to reading application code, invoking engine-owned workflow control tools, writing declared typed artifacts under the exact `state.artifactsDir` returned by `workflow_instructions` (feature runs use `.work-state/features/<slug>/artifacts`; legacy runs use `.work-state/artifacts`), and deterministic auxiliary operations required to inspect or coordinate the run.",
    "NEVER use `write` or `edit` on application source, tests, configuration, lockfiles, documentation, or canonical workflow state. NEVER patch a subagent's code, validation, or artifact to make a stage pass.",
    "Every implementation, review-fix, or source-changing operation MUST be delegated through the profile's `single`/`consilium` stage. If a subagent fails, returns incomplete evidence, or produces incorrect work, re-spawn the same role with a corrected task; do not fix it yourself.",
    "Version-control/review control-plane operations are allowed once delegated work is ready: inspect with `git status`, `git diff`, `git log`, or `git show`; synchronize with `git fetch`, `git pull`, or `git pull --rebase`; integrate delegated commits with `git merge`, `git rebase`, or `git cherry-pick`; then `git add`, `git commit`, non-force `git push`, and `gh pr create`/`gh pr view`. At discovery start, create or select the working branch with `git checkout <branch>`, `git checkout -b <branch>`, `git switch <branch>`, or `git switch -c <branch>`. These operations reconcile or publish worker changes; they do not authorize editing source yourself.",
    "After every delegated call or parallel batch: stop and reconcile the result through `workflow_status` and the engine-owned completion/advance tools. Require every declared artifact and gate/validation evidence, then dispatch the next stage only if the state transition is valid. A subagent return is not permission to improvise, skip stages, or self-complete.",
    "If state, delegation evidence, artifact evidence, or gate evidence is missing/corrupt, fail closed: return the structured workflow error and stop or pause through the workflow tools. Do not continue by judgment alone.",
    "",
    "### OPAQUE CAPABILITY EXECUTION PROTOCOL",
    "After `workflow_prepare` succeeds, call `workflow_begin` before any stage action. Treat its returned handoff as the only valid capability credentials; never invent, reuse, or write tokens to `.work-state/`.",
    "Treat the latest `workflow_begin` or `workflow_advance` handoff as the only source of truth: copy `run_key`, `branch`, `workflow`, `profile_hash`, `stage_cursor`, `cursor_epoch`, and `capability_id` byte-for-byte into every subsequent workflow control request (and use its current `dispatch_token` or `advance_token`). Do not carry bindings forward from an older handoff. `profile_hash` remains the compact first-30/last-2 binding fingerprint; never abbreviate or reconstruct it. `run_key` is opaque, may contain `/` (for example `fix/sync-secrets-before-restart`), and must never be derived, slugified, normalized, or otherwise rewritten.",
    "For `single` and `consilium` stages, call `task` only with the exact returned stage cursor, epoch, expected role/agent roster, and role-specific marker from `handoff.dispatch_markers`. Put the complete marker string returned by `handoff.dispatch_markers` verbatim inside every role-specific `tasks[].task` string (including its run/stage/kind/cursor/roles/role fields); shared context is insufficient and does not satisfy the dispatch gate. Keep the declared `role` and `agent` beside it; never shorten, reconstruct, normalize, or derive a marker.",
    "For `orchestrator`, `bash`, or `none` stages, perform only the declared contract action, persist required typed artifacts, then call `workflow_advance` with the current handoff's advance token and evidence.",
    "After every task result, call `workflow_status`. For every succeeded dispatch whose `artifact_ids` is empty, call `workflow_complete` exactly once with its identity binding and the exact artifact IDs from `slot_artifacts` (including `produce-slot` ids for consilium); do not treat a native task result as artifact completion. If the runtime already repaired a synchronous completion, use the IDs shown by `workflow_status` and do not replay it with different IDs.",
    "Advance only through `workflow_advance` after all current-stage dispatches are complete and required artifacts/gates exist. Use the returned next-stage handoff for the next stage; never call `task` from a stale cursor.",
    "If any workflow tool reports a binding error, obtain at most one fresh handoff with `workflow_begin`, replace every binding field from that latest handoff byte-for-byte, and retry only the failed request once. If the fresh handoff or retry fails (or a non-binding error occurs), fail closed and stop; never guess, normalize, or retry again.",
    "",
    "### Tool permission summary",
    "| Operation | Orchestrator |",
    "| --- | --- |",
    "| read/glob/grep | ALLOW |",
    "| write/edit declared artifacts under `state.artifactsDir` returned by `workflow_instructions` | ALLOW |",
    "| write/edit application source or project files | DENY |",
    "| direct write/edit canonical workflow state | DENY |",
    "| git status, git diff, git log, git show, git fetch, git pull, git pull --rebase | ALLOW |",
    "| git add, git commit, git merge, git rebase, git cherry-pick, non-force git push | ALLOW |",
    "| gh pr create, gh pr view, gh pr checks, gh pr status | ALLOW |",
    "| branch setup (`git checkout <branch>`, `git checkout -b <branch>`, `git switch <branch>`, `git switch -c <branch>`) | ALLOW |",
    "| direct source/worktree mutations (`git checkout -- <path>`, `git restore`, `git reset`, `git clean`, `git mv`, `git rm`, `git stash`) | DENY |",
    "| task for a declared stage | ALLOW |",
    "| task outside the active profile/state contract | DENY |",
    "| direct implementation or review-fix | DENY |",
  ].join("\n");
}

export type { Complexity, TaskType, WorkflowName };
