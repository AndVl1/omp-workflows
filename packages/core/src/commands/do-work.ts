import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseAutonomousDirective } from "./envelope.js";
import { buildClassificationPhaseZero, buildWorkflowMatrix } from "./classification-contract.js";
import { resolveState } from "../engine/state.js";
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

const ROOT_ARTIFACTS_DIR = [".", "work-state"].join("") + "/artifacts";

export function parseWorkEnvelope(args: string, cwd: string): ParsedWorkEnvelope {
  const directive = parseAutonomousDirective(args);
  const autonomyHint = directive.autonomyHint;
  const cleaned = directive.task;
  const issueMatch = cleaned.match(/issue=#(\d+)/);
  const issue = issueMatch ? Number(issueMatch[1]) : null;
  const task = (issueMatch ? cleaned.replace(issueMatch[0], "") : cleaned).trim();
  let branch: string | null = null;
  try {
    branch = execSync("git rev-parse --abbrev-ref HEAD", { cwd, encoding: "utf8" }).trim() || null;
  } catch {
    branch = null;
  }
  return { task, autonomyHint, autonomous: autonomyHint, issue, branch };
}

function loadTeamConfig(cwd: string): WorkTeamConfig {
  const path = resolve(cwd, ".omp", "team.config.json");
  if (!existsSync(path)) return {};
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as WorkTeamConfig;
    return raw;
  } catch {
    return {};
  }
}

export function buildDoWorkPrompt(envelope: ParsedWorkEnvelope, cwd: string): string {
  const roles = Object.entries(loadTeamConfig(cwd).roles ?? {});
  const roleTable = roles.map(([role, agent]) => `| \`${role}\` | \`${agent}\` |`).join("\n");
  const issueMeta = envelope.issue ? `Issue: #${envelope.issue}\n` : "";
  const branchMeta = envelope.branch ? `Branch: \`${envelope.branch}\`\n` : "Branch: (no git work tree)\n";
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
    "Do not hand-author persisted workflow state and do not invent opaque capability fields. The engine owns state initialization.",
    "Use the PHASE-0 classification (type, complexity, confidence, autonomous, autonomous_reason, workflow), task, active branch, issue, and any known file paths as the typed preparation input.",
    "If confidence is LOW, ask a focused clarification question before preparing an expansive workflow (unless `autonomous` is true; then document a conservative default).",
    "For a continuation, pass the user's bounded `feedback` and the requested `stageId` to preparation; the persisted classification, artifacts, and history remain authoritative.",
    "",
    "### Only after PHASE 0",
    "1. Call `workflow_prepare` with the typed PHASE-0 result. It validates the active branch and resolved profile, then atomically initializes or reopens feature-scoped state with pending stages, scope, and strict policy.",
    "2. Require a typed `workflow_prepare` result with `ok: true`; if it errors, is missing, or is malformed, stop and fail closed — never write state by hand and never guess stages.",
    "3. Only after preparation succeeds, call `workflow_begin` to issue the durable opaque capability for the current stage. If it fails, stop and record the error — never guess stage content.",
    "4. Call `workflow_instructions` and treat its returned current stage contract (`stage.instructions`, `roles`, `consumes`, `produces`, `checkpoint`/`gate`, `provenance`) as the ONLY workflow instruction source. Do not read, glob, or infer workflow profile JSON from the filesystem, package paths, or plugin directories.",
    `The returned contract must include the authenticated feature-scoped \`state.artifactsDir\`; every producer MUST write each declared artifact under that returned directory as exactly \`<artifact_id>.json\`, or for a consilium slot exactly \`<artifact_id>-<slot>.json\`. NEVER write to root ${ROOT_ARTIFACTS_DIR}; do not use guessed paths (never guess an artifact path) or any other directory.`,
    "5. Continue executing in THIS TURN. Do not stop after printing CLASSIFICATION or preparing state; immediately call `workflow_begin` and `workflow_instructions` and walk the returned stage contract.",
    "6. On continuation, skip stages already done/skipped and start at the first reopened or pending stage.",
    "7. For each `single` stage, call `task` once; for each `consilium` stage, use one parallel `task` batch.",
    "8. Honour gates, checkpoints, loops, typed artifacts, and the validation contract.",
    "9. After every `workflow_advance`, call `workflow_instructions` again and use the returned next-stage contract. If any workflow tool errors, fail closed: stop and record the failure rather than guessing the stage.",
    "10. When a stage or the whole workflow finishes, remain available in this same session: later user feedback reopens the affected state instead of starting a fresh workflow.",
    "",
    "### Workflow tool-result envelope (mandatory)",
    "Native workflow control tools return an OMP result envelope `{ content: [{ type: \"text\", text: \"<JSON>\" }], details: <object> }`.",
    "When invoking them through Python `eval`, `tool.workflow_*` returns `{ \"text\": \"<JSON>\" }`; parse `json.loads(r[\"text\"])`, never `json.loads(r)`.",
    "Require `ok: true` on operation envelopes such as `workflow_prepare` and `workflow_begin`; require `workflow_instructions` to contain the expected `stage` and `provenance` objects before reading it.",
    "Keep the parsed `workflow_begin` payload: only its `handoff.dispatch_markers` contains dispatch markers; `workflow_instructions` returns the stage contract and does not contain `dispatch_markers`.",
    "For each declared role, select the marker by exact role from that begin handoff and preserve it verbatim; missing, empty, duplicate, or mismatched markers are a fail-closed condition.",
    "",
    "### Role mapping (from .omp/team.config.json)",
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
    "You are the workflow orchestrator, not an implementation agent. Your allowed work is limited to reading application code, writing workflow state and typed artifacts under `.work-state/`, and deterministic auxiliary operations required to inspect or coordinate the run.",
    "NEVER use `write` or `edit` on application source, tests, configuration, lockfiles, documentation, or any path outside `.work-state/`. NEVER patch a subagent's code, validation, or artifact to make a stage pass.",
    "Every implementation, review-fix, or source-changing operation MUST be delegated through the profile's `single`/`consilium` stage. If a subagent fails, returns incomplete evidence, or produces incorrect work, re-spawn the same role with a corrected task; do not fix it yourself.",
    "After every delegated call or parallel batch: stop and reconcile the result with persisted state. Write the stage outcome, require every declared artifact and gate/validation evidence, then dispatch the next stage only if the state transition is valid. A subagent return is not permission to improvise, skip stages, or self-complete.",
    "If state, delegation evidence, artifact evidence, or gate evidence is missing/corrupt, fail closed: record the failure in `.work-state/` and re-delegate or pause for the user. Do not continue by judgment alone.",
    "",
    "### OPAQUE CAPABILITY EXECUTION PROTOCOL",
    "After the classification state is persisted, call `workflow_begin` before any stage action. Treat its returned handoff as the only valid capability credentials; never invent, reuse, or write tokens to `.work-state/`.",
    "For every declared role, copy the exact `handoff.dispatch_markers[].marker` string returned by `workflow_begin` verbatim into that role's `tasks[].task` payload, including the full `<!-- omp-dispatch ... -->` syntax. Put that exact marker inside every role-specific `tasks[].task` payload, not only in shared context. Do not synthesize, transform, normalize, truncate, or otherwise alter it; if the required marker is unavailable, stop and fail closed without calling `task`.",
    "For `single` and `consilium` stages, call `task` only with the exact returned stage cursor, epoch, expected role/agent roster, dispatch marker, and count. Use exactly one task call for each `single` stage and one parallel task batch for each `consilium` stage; include exactly the returned roster/count and do not dispatch an undeclared role.",
    "For `orchestrator`, `bash`, or `none` stages, perform only the declared contract action, persist required typed artifacts, then call `workflow_advance` with the current handoff's advance token and evidence.",
    "After every task result, immediately call `workflow_status` before interpreting completion. In its `capability.dispatches[]`, select the single persisted dispatch record matching the completed task by exact `role`, `agent`, and `tool_call_id` binding; pass exactly that record's `id` verbatim as `workflow_complete.dispatch_id`.",
    "NEVER pass job IDs, task call IDs (including task-call IDs), capability IDs, role names, or synthesized IDs (including synthesized/derived IDs) as `workflow_complete.dispatch_id`; only the matching persisted dispatch record's `id` is valid. If no unique matching persisted record exists, fail closed and do not call `workflow_complete`.",
    "When calling `workflow_complete`, preserve the exact current dispatch token, capability identity (`capability_id`), run/branch/workflow/stage binding, `stage_cursor`/`cursor_epoch`, and `profile_hash`, and include the actual outcome, evidence, and artifact IDs. Preserve the one-batch/declared-roster, actor/path, and stale-branch rules; any missing or mismatched binding fails closed.",
    "Advance only through `workflow_advance` after all current-stage dispatches are complete and required artifacts/gates exist. Use the returned next-stage handoff for the next stage; never call `task` from a stale cursor.",
    "### Cross-profile handoff (workflow_handoff)",
    "When the current profile completes at a `handoff` source stage and the user explicitly approves the result, choose the target workflow from the engine's typed route catalogue. The safe result of `workflow_handoff` exposes route id/kind/status, source and target workflow/stage, prerequisites, and the target preparation/materialization description. Only `enabled` catalogue routes complete; `conditional` routes are rejected deterministically until their declared evidence/materialization adapter exists, and `unsupported` or arbitrary target strings are denied — never pick a target outside the catalogue.",
    "Persist exactly this flat typed `workflow_approval` artifact in the existing feature artifacts directory: `{ \"type\": \"workflow_approval\", \"version\": 1, \"decision\": \"approved\", \"run_key\": \"<authenticated source run_key>\", \"source_workflow\": \"<authenticated source workflow>\", \"source_stage\": \"<authenticated source stage>\", \"actor\": \"<approving actor>\", \"decided_at\": \"<ISO-8601 timestamp>\" }`. New artifacts MUST use the exact `source_workflow` and `source_stage` field names, never invented `workflow`/`stage` aliases; legacy flat aliases remain engine-compatible only for existing artifacts. Then call `workflow_handoff` with the completed run's advance-token handoff, the requested target workflow, the approval reference, and only bounded artifact/decision references.",
    "NEVER infer approval from natural-language output or call `workflow_handoff` without typed approval evidence. If `workflow_handoff` rejects or fails, stop and preserve state: do not edit state.json or profile JSON, do not guess credentials, and do not retry with free text.",
    "On success, discard the source envelope, use ONLY the returned target handoff, call `workflow_instructions` again, and continue with the returned target stage contract; record the target stage's own checkpoints under the fresh capability.",
    "`workflow_handoff` returns a fresh target capability on success. Source credentials and dispatch markers are invalid immediately; discard them and never use the source capability, advance token, cursor epoch, roster, or marker for target work.",
    "On the target, call `workflow_instructions` using only the fresh target handoff before selecting the target stage contract.",
    "For every target task, copy the latest target `handoff.dispatch_markers[].marker` verbatim into each role-specific `tasks[].task`; use only the latest target handoff's exact cursor/epoch, expected role/agent roster, and count.",
    "After every target `workflow_advance`, call `workflow_status` and `workflow_instructions` to refresh the target handoff; replace the marker, cursor/epoch, advance token, and expected role/agent roster with the newly returned values before any next target task or advance.",
    "Never retry target work with a stale source or previous-stage marker (or any stale source/previous-stage capability, cursor/epoch, roster, or advance token); missing or mismatched fresh values fail closed.",
    "",
    "### Tool permission summary",
    "| Operation | Orchestrator |",
    "| --- | --- |",
    "| read/glob/grep | ALLOW |",
    "| workflow_prepare after PHASE-0 with typed input | ALLOW |",
    "| workflow_prepare with malformed classification/branch or without ok:true | DENY |",
    "| write/edit `.work-state/**` | ALLOW |",
    "| write/edit application source or project files | DENY |",
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
