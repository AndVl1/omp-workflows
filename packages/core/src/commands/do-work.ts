import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseAutonomousDirective } from "./envelope.js";
import { buildClassificationPhaseZero, buildWorkflowMatrix } from "./classification-contract.js";
import type { Complexity, TaskType, WorkflowName } from "../engine/types.js";

export interface ParsedWorkEnvelope {
  task: string;
  /**
   * MECHANICAL hint from the leading-directive parser. NON-AUTHORITATIVE:
   * PHASE-0 has the main LLM decide `autonomous` from the full task
   * semantics; this value is rendered as a hint and never persisted.
   */
  autonomyHint: boolean;
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
  return { task, autonomyHint, issue, branch };
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
  const activeFeaturePath = resolve(cwd, ".work-state", ".active-feature");
  const activeFeature = existsSync(activeFeaturePath) ? readFileSync(activeFeaturePath, "utf8").trim() : "";
  const statePath = activeFeature
    ? resolve(cwd, ".work-state", "features", activeFeature, "state.json")
    : resolve(cwd, ".work-state", "team-state.json");
  let continuation = "No existing do-work state was found. Start a new workflow.";
  if (existsSync(statePath)) {
    continuation = [
      `Existing workflow state found at \`${statePath}\`. This is a resumable continuation, not a new task.`,
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
    "1. Read exactly the resolved workflow profile JSON and then its stages. Use `packages/core/workflows/<workflow>.json` in this repository, or the installed package's `workflows/<workflow>.json`; never invent a `.md` profile path.",
    "2. Continue executing in THIS TURN. Do not stop after printing CLASSIFICATION or writing state; immediately read the profile and walk its stages.",
    "3. On continuation, skip stages already done/skipped and start at the first reopened or pending stage.",
    "4. For each `single` stage, call `task` once; for each `consilium` stage, use one parallel `task` batch.",
    "5. Honour gates, checkpoints, loops, typed artifacts, and the validation contract.",
    "6. When a stage or the whole workflow finishes, remain available in this same session: later user feedback reopens the affected state instead of starting a fresh workflow.",
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
  ].join("\n");
}

export type { Complexity, TaskType, WorkflowName };
