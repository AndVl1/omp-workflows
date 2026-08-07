import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Complexity, TaskType, WorkflowName } from "../engine/types.js";

export interface ParsedWorkEnvelope {
  task: string;
  autonomous: boolean;
  issue: number | null;
  branch: string | null;
}

export interface WorkTeamConfig {
  roles?: Record<string, string>;
}

const AUTONOMOUS_PREFIX = "[AUTONOMOUS";

export function parseWorkEnvelope(args: string, cwd: string): ParsedWorkEnvelope {
  const autonomous = args.trimStart().startsWith(AUTONOMOUS_PREFIX);
  const stripped = autonomous ? args.trimStart().slice(AUTONOMOUS_PREFIX.length).trimStart() : args;
  const cleaned = stripped.startsWith("]") ? stripped.slice(1).trimStart() : stripped;
  const issueMatch = cleaned.match(/issue=#(\d+)/);
  const issue = issueMatch ? Number(issueMatch[1]) : null;
  const task = (issueMatch ? cleaned.replace(issueMatch[0], "") : cleaned).trim();
  let branch: string | null = null;
  try {
    branch = execSync("git rev-parse --abbrev-ref HEAD", { cwd, encoding: "utf8" }).trim() || null;
  } catch {
    branch = null;
  }
  return { task, autonomous, issue, branch };
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
  const autonomousMeta = envelope.autonomous
    ? "Autonomous mode: ON. After classification, apply the profile's autonomous decisions.\n"
    : "Autonomous mode: OFF. After classification, pause at profile checkpoints for user review.\n";
  return [
    "/do-work classification pass — understand the task before selecting a workflow.", "", "### Task", envelope.task, "",
    "### Metadata", issueMeta + branchMeta + autonomousMeta,
    "### PHASE 0: INTELLIGENT CLASSIFICATION (zero step)",
    "Before any other tool call — no `read`, `glob`, `grep`, `bash`, `edit`, `write`, or `task` — understand the task semantically.",
    "Do NOT use keyword counts, task length, or language-specific keyword lists. Infer the requested outcome, primary intent, scope, constraints, risk, and whether code changes are actually requested.", "",
    "Return this visible block before continuing:", "CLASSIFICATION:",
    "- Type: FEATURE | REFACTOR | OPS | BUG_FIX | INVESTIGATION | REVIEW | HOTFIX",
    "- Complexity: QUICK | MEDIUM | COMPLEX | CRITICAL", "- Workflow: resolved from the matrix below",
    "- Confidence: HIGH | MEDIUM | LOW", "- Reason: concise evidence-based explanation", "",
    "Then write `.work-state/team-state.json` (or the active feature state) with the classification, resolved workflow, task, autonomous flag, and initial pending stages. This state write is the gate before any investigation or delegation.",
    "If confidence is LOW, ask a focused clarification question before writing an expansive workflow (unless autonomous mode is ON; then document a conservative default).", "",
    "### Workflow resolution (only after PHASE 0)", "Resolve the profile from the semantic classification, not from heuristics:",
    "| Type | QUICK | MEDIUM | COMPLEX | CRITICAL |", "| --- | --- | --- | --- | --- |",
    "| FEATURE | lightweight | standard | full-feature | full-feature |", "| REFACTOR | lightweight | standard | full-feature | full-feature |",
    "| OPS | lightweight | standard | standard | standard |", "| BUG_FIX | bug-fix | debug-cycle | debug-cycle | debug-cycle |",
    "| INVESTIGATION | research | research | research | research |", "| REVIEW | review | review | review | review |", "| HOTFIX | emergency | emergency | emergency | emergency |", "",
    "### Only after state is written", "1. Read exactly the resolved workflow profile file and then its stages.",
    "2. Walk the selected profile in order; do not execute any stage before classification and state persistence.",
    "3. For each `single` stage, call `task` once; for each `consilium` stage, use one parallel `task` batch.",
    "4. Honour gates, checkpoints, loops, typed artifacts, and the validation contract.", "### Role mapping (from .omp/team.config.json)", "| Role | Agent |", "| --- | --- |", roleTable || "| (no roles configured) | |", "",
    "### Hard constraints", "- Do NOT call `task` during classification.", "- Do NOT glob for workflow files or scan installed plugins.", "- Do NOT read command sources or reconstruct classification from keywords.", "- Do NOT mark a stage done without its required artifact and gate evidence.",
  ].join("\n");
}

export type { Complexity, TaskType, WorkflowName };
