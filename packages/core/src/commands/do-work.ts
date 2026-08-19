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
    "Then write `.work-state/team-state.json` (or the active feature state) with the classification",
    "(type, complexity, confidence, autonomous, autonomous_reason), the resolved workflow, the task,",
    "and the initial pending stages only when starting a new workflow. For a continuation, update the",
    "existing state in place and preserve its history. This state write is the gate before any",
    "investigation or delegation — the P5 gate reads `classification.autonomous` as the authority.",
    "If confidence is LOW, ask a focused clarification question before writing an expansive workflow",
    "(unless `autonomous` is true; then document a conservative default).",
    "",
    "### Only after state is written",
    "1. Call `workflow_begin` to issue the durable opaque capability for the current stage. If it fails, stop and record the error — never guess stage content.",
    "2. Call `workflow_instructions` and treat its returned current stage contract (`stage.instructions`, `roles`, `consumes`, `produces`, `checkpoint`/`gate`, `provenance`) as the ONLY workflow instruction source. Do not read, glob, or infer workflow profile JSON from the filesystem, package paths, or plugin directories.",
    "3. Continue executing in THIS TURN. Do not stop after printing CLASSIFICATION or writing state; immediately call `workflow_begin` and `workflow_instructions` and walk the returned stage contract.",
    "4. On continuation, skip stages already done/skipped and start at the first reopened or pending stage.",
    "5. For each `single` stage, call `task` once; for each `consilium` stage, use one parallel `task` batch.",
    "6. Honour gates, checkpoints, loops, typed artifacts, and the validation contract.",
    "7. After every `workflow_advance`, call `workflow_instructions` again and use the returned next-stage contract. If any workflow tool errors, fail closed: stop and record the failure rather than guessing the stage.",
    "8. When a stage or the whole workflow finishes, remain available in this same session: later user feedback reopens the affected state instead of starting a fresh workflow.",
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
    "For `single` and `consilium` stages, call `task` only with the exact returned stage cursor, epoch, expected role/agent roster, and dispatch marker. Use one task call for `single` and one parallel batch for `consilium`; do not dispatch an undeclared role.",
    "For `orchestrator`, `bash`, or `none` stages, perform only the declared contract action, persist required typed artifacts, then call `workflow_advance` with the current handoff's advance token and evidence.",
    "After every task result, call `workflow_status`. Synchronous task results are reconciled by the runtime; if a dispatch remains `authorized` or an async job has settled outside the hook, call `workflow_complete` with its dispatch token, identity binding, outcome, evidence, and artifact IDs.",
    "Advance only through `workflow_advance` after all current-stage dispatches are complete and required artifacts/gates exist. Use the returned next-stage handoff for the next stage; never call `task` from a stale cursor.",
    "### Cross-profile handoff (workflow_handoff)",
    "When the current profile completes at a `handoff` source stage and the user explicitly approves the result, persist a typed `workflow_approval` artifact in the existing feature artifacts directory (`type: workflow_approval`, `version: 1`, `decision: approved`, the run_key, source workflow, source stage, actor, and decided_at), then call `workflow_handoff` with the completed run's advance-token handoff, the target workflow, the approval reference, and only bounded artifact/decision references.",
    "NEVER infer approval from natural-language output or call `workflow_handoff` without typed approval evidence. If `workflow_handoff` rejects or fails, stop and preserve state: do not edit state.json or profile JSON, do not guess credentials, and do not retry with free text.",
    "On success, discard the source envelope, use ONLY the returned target handoff, call `workflow_instructions` again, and continue with the returned target stage contract; record the target stage's own checkpoints under the fresh capability.",
    "",
    "### Tool permission summary",
    "| Operation | Orchestrator |",
    "| --- | --- |",
    "| read/glob/grep | ALLOW |",
    "| write/edit `.work-state/**` | ALLOW |",
    "| write/edit application source or project files | DENY |",
    "| task for a declared stage | ALLOW |",
    "| task outside the active profile/state contract | DENY |",
    "| direct implementation or review-fix | DENY |",
    "| workflow_handoff after explicit typed user approval | ALLOW |",
    "| workflow_handoff without approval evidence or mid-workflow | DENY |",
  ].join("\n");
}

export type { Complexity, TaskType, WorkflowName };
