/**
 * /team slash command — the workflow interpreter.
 *
 * Accepts: `[task description]`
 * Detects autonomous mode (`[AUTONOMOUS ...]` prefix) and routes to the
 * `run(opts)` engine.
 */

import { execSync } from "node:child_process";
import { run } from "../engine/run.js";
import type { CommandContext } from "./types.js";
export type { CommandContext } from "./types.js";

const AUTONOMOUS_PREFIX = "[AUTONOMOUS";

export async function teamCommand(ctx: CommandContext): Promise<string> {
  const args = ctx.args.trim();
  if (!args) {
    return "Usage: /team [AUTONOMOUS] [issue=#N] [task description]";
  }

  const autonomous = args.startsWith(AUTONOMOUS_PREFIX);
  const task = stripPrefix(args, AUTONOMOUS_PREFIX);
  const { issue, task: cleanedTask } = parseIssue(task);

  const branch = currentBranch(ctx.cwd);
  if (!branch) {
    return "ERROR: not inside a git work tree.";
  }

  const result = await run({
    task: cleanedTask,
    cwd: ctx.cwd,
    branch,
    autonomous,
    issue: issue ? { number: issue } : null,
    taskTool: ctx.callTask,
    pause: async (reason: string) => {
      ctx.ui.notify(`paused: ${reason}`, "info");
    },
    log: (line: string) => ctx.ui.notify(line, "info"),
  });

  return formatResult(result);
}

function stripPrefix(text: string, prefix: string): string {
  if (!text.startsWith(prefix)) return text;
  const rest = text.slice(prefix.length).trimStart();
  // allow `]` or ` issue=#N url=...` token after the prefix
  if (rest.startsWith("]")) return rest.slice(1).trimStart();
  return rest;
}

function parseIssue(text: string): { issue: number | null; task: string } {
  const m = text.match(/issue=#(\d+)/);
  if (!m) return { issue: null, task: text };
  return { issue: Number(m[1]), task: text.replace(m[0], "").trim() };
}

function currentBranch(cwd: string): string | null {
  try {
    return execSync("git rev-parse --abbrev-ref HEAD", { cwd, encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

function formatResult(r: {
  classification: { type: string; complexity: string; workflow: string };
  profile: { name: string; stages: Array<{ id: string }> };
  outcomes: Array<{ stageId: string; status: string; note: string }>;
  statePath: string | null;
}): string {
  const lines: string[] = [];
  lines.push(`## /team run finished`);
  lines.push("");
  lines.push(`- classification: ${r.classification.type}/${r.classification.complexity} -> ${r.classification.workflow}`);
  lines.push(`- profile: ${r.profile.name} (${r.profile.stages.length} stages)`);
  lines.push(`- state: ${r.statePath ?? "(none)"}`);
  lines.push("");
  lines.push("### Outcomes");
  for (const o of r.outcomes) {
    lines.push(`- ${o.stageId}: ${o.status} (${o.note})`);
  }
  return lines.join("\n");
}
