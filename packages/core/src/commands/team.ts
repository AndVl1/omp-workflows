/**
 * /team slash command — workflow interpreter (stub for v0.3.x).
 *
 * Accepts: `[task description]`
 * Detects autonomous mode (`[AUTONOMOUS ...]` prefix) and records the envelope.
 *
 * ### Why a stub
 * OMP extension commands do not expose a subagent-dispatch affordance. The
 * underlying `task` tool lives on the main OMP agent, which an extension
 * command cannot drive from `ExtensionCommandContext`. Until workflow
 * commands ship as OMP custom-TS commands (see
 * `.work-state/plans/omp-workflow-rewrite.md`), `/team` validates the task
 * envelope and posts it back as a user-visible digest.
 *
 * The profile-driven engine (`packages/core/src/engine/`) and the 17 role-mapped
 * agents in `packages/fullstack/agents/` are still consumed by the upcoming
 * custom-TS command.
 */

import { execSync } from "node:child_process";
import { parseAutonomousDirective } from "./envelope.js";
import type { CommandContext } from "./types.js";
export type { CommandContext } from "./types.js";

export async function teamCommand(ctx: CommandContext): Promise<string> {
  const args = ctx.args.trim();
  if (!args) {
    return [
      "Usage: /team [task description] [issue=#N] [AUTONOMOUS]",
      "",
      "Workflow dispatch via /team is temporarily a stub. The main OMP agent",
      "is expected to take the returned envelope and run the profile-driven",
      "workflow through its own task tool. See plan:",
      ".work-state/plans/omp-workflow-rewrite.md",
    ].join("\n");
  }

  const directive = parseAutonomousDirective(ctx.args);
  const autonomous = directive.autonomous;
  const cleanedTask = directive.task;
  const issueMatch = cleanedTask.match(/issue=#(\d+)/);
  const issue = issueMatch ? Number(issueMatch[1]) : null;
  const finalTask = issueMatch ? cleanedTask.replace(issueMatch[0], "").trim() : cleanedTask;

  let branch: string | null = null;
  try {
    branch = execSync("git rev-parse --abbrev-ref HEAD", { cwd: ctx.cwd, encoding: "utf8" }).trim();
  } catch {
    branch = null;
  }
  if (!branch) {
    return "ERROR: not inside a git work tree.";
  }

  const lines: string[] = [
    "## /team envelope (v0.3 stub)",
    "",
    `- task: ${finalTask}`,
    `- autonomous: ${autonomous}`,
    `- issue: ${issue ?? "(none)"}`,
    `- branch: ${branch}`,
    `- cwd: ${ctx.cwd}`,
    "",
    "The main OMP agent should now drive the role-mapped workflow:",
    "discovery → architecture → implementation → review → manual-qa → qa-tests.",
    "Until the custom-TS command lands, this command only records the envelope.",
  ];
  ctx.ui.notify(`team envelope recorded: ${finalTask.slice(0, 60)}`, "info");
  return lines.join("\n");
}
