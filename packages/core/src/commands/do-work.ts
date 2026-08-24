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
    "9. After every `workflow_advance`, call `workflow_instructions` again and use the returned next-stage contract. If any workflow tool errors, fail closed: stop and record the failure rather than guessing the stage.",
    "10. When a stage or the whole workflow finishes, remain available in this same session: later user feedback reopens the affected state instead of starting a fresh workflow.",
    "",
    "### Workflow tool-result envelope (mandatory)",
    "Native workflow control tools return an OMP result envelope `{ content: [{ type: \"text\", text: \"<JSON>\" }], details: <object> }`.",
    "When invoking them through Python `eval`, `tool.workflow_*` returns `{ \"text\": \"<JSON>\" }`; parse `json.loads(r[\"text\"])`, never `json.loads(r)`.",
    "Require `ok: true` on operation envelopes such as `workflow_prepare` and `workflow_begin`; require `workflow_instructions` to contain the expected `stage` and `provenance` objects before reading it.",
    "Keep the parsed `workflow_begin` payload: only its `handoff.dispatch_markers` contains dispatch markers; `workflow_instructions` returns the stage contract and does not contain `dispatch_markers`.",
    "For each declared role, select the marker by exact role from that begin handoff and preserve it verbatim; missing, empty, duplicate, or mismatched markers are a fail-closed condition."
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
    "The handoff's `profile_hash` is a compact first-30/last-2 binding fingerprint; copy it verbatim in every `workflow_complete`, `workflow_checkpoint`, and `workflow_advance` request. Never abbreviate or reconstruct it.",
    "For every declared role, copy the exact `handoff.dispatch_markers[].marker` string returned by `workflow_begin` verbatim into that role's `tasks[].task` payload, including the full `<!-- omp-dispatch ... -->` syntax. Put that exact marker inside every role-specific `tasks[].task` payload, not only in shared context. Do not synthesize, transform, normalize, truncate, or otherwise alter it; if the required marker is unavailable, stop and fail closed without calling `task`.",
    "For `single` and `consilium` stages, call `task` only with the exact returned stage cursor, epoch, expected role/agent roster, dispatch marker, and count. Use exactly one task call for each `single` stage and one parallel task batch for each `consilium` stage; include exactly the returned roster/count and do not dispatch an undeclared role.",
    "For `orchestrator`, `bash`, or `none` stages, perform only the declared contract action, persist required typed artifacts, then call `workflow_advance` with the current handoff's advance token and evidence.",
    "After every task result, immediately call `workflow_status` before interpreting completion. In its `capability.dispatches[]`, select the single persisted dispatch record matching the completed task by exact `role`, `agent`, and `tool_call_id` binding; pass exactly that record's `id` verbatim as `workflow_complete.dispatch_id`.",
    "NEVER pass job IDs, task call IDs (including task-call IDs), capability IDs, role names, or synthesized IDs (including synthesized/derived IDs) as `workflow_complete.dispatch_id`; only the matching persisted dispatch record's `id` is valid. If no unique matching persisted record exists, fail closed and do not call `workflow_complete`.",
    "When calling `workflow_complete`, preserve the exact current dispatch token, capability identity (`capability_id`), run/branch/workflow/stage binding, `stage_cursor`/`cursor_epoch`, and `profile_hash`, and include the actual outcome, evidence, and artifact IDs. Preserve the one-batch/declared-roster, actor/path, and stale-branch rules; any missing or mismatched binding fails closed.",
    "For every succeeded dispatch whose `artifact_ids` is empty, call `workflow_complete` exactly once with its identity binding and the exact artifact IDs from `slot_artifacts` (including `produce-slot` IDs for consilium); do not treat a native task result as artifact completion. If the runtime already repaired a synchronous completion, use the IDs shown by `workflow_status` and do not replay it with different IDs.",
    "Advance only through `workflow_advance` after all current-stage dispatches are complete and required artifacts/gates exist. Use the returned next-stage handoff for the next stage; never call `task` from a stale cursor.",
    "### Cross-profile handoff (workflow_handoff)",
    "When the current profile completes at a `handoff` source stage and the user explicitly approves the result, choose the target workflow from the engine's typed route catalogue. The safe result of `workflow_handoff` exposes route id/kind/status, source and target workflow/stage, prerequisites, and the target preparation/materialization description. Only `enabled` catalogue routes complete; `conditional` routes are rejected deterministically until their declared evidence/materialization adapter exists, and `unsupported` or arbitrary target strings are denied — never pick a target outside the catalogue.",
    "Persist a typed `workflow_approval` artifact in the existing feature artifacts directory (`type: workflow_approval`, `version: 1`, `decision: approved`, the run_key, source workflow, source stage, actor, and decided_at), then call `workflow_handoff` with the completed run's advance-token handoff, the target workflow, the approval reference, and only bounded artifact/decision references.",
    "NEVER infer approval from natural-language output or call `workflow_handoff` without typed approval evidence. If `workflow_handoff` rejects or fails, stop and preserve state: do not edit state.json or profile JSON, do not guess credentials, and do not retry with free text.",
    "On success, discard the source envelope, use ONLY the returned target handoff, call `workflow_instructions` again, and continue with the returned target stage contract; record the target stage's own checkpoints under the fresh capability.",
    "",
    "### Tool permission summary",
    "| Operation | Orchestrator |",
    "| --- | --- |",
    "| read/glob/grep | ALLOW |",
    "| workflow_prepare after PHASE-0 with typed input | ALLOW |",
    "| workflow_prepare with malformed classification/branch or without ok:true | DENY |",
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
    "| workflow_handoff after explicit typed user approval | ALLOW |",
    "| workflow_handoff to a catalogue `enabled` route with typed approval evidence | ALLOW |",
    "| workflow_handoff to conditional/unsupported routes or arbitrary targets | DENY |",
    "| workflow_handoff without approval evidence or mid-workflow | DENY |",
  ].join("\n");
}

export type { Complexity, TaskType, WorkflowName };
