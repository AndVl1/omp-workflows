/**
 * Lightweight slash commands that don't need the full interpreter:
 *   - /team-next:    pick the next task from the queue and run /team
 *   - /team-yolo:    autonomous loop (one task per tick)
 *   - /pulse:        read-only project steward (digest + next-action menu)
 *   - /init-team:    detect stacks and emit .omp/team.config.json
 *   - /interview:    deep interview to clarify ideas
 *   - /coordinator-stats: rollup profile-usage + new-profile proposals
 *
 * These are thin wrappers today; the heavy lifting lives in skills/agents
 * the runner delegates to. The point: every command is a single slash
 * entry that exists in omp's command registry, not a 200-line markdown.
 */

import { execSync } from "node:child_process";
import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import defaultConfig from "../../workflows/team.config.example.json" with { type: "json" };
import type { CommandContext } from "./types.js";
export type { CommandContext } from "./types.js";

const WORK_STATE_DIR = ".work-state";

export async function teamNextCommand(ctx: CommandContext): Promise<string> {
  const queue = readQueue(ctx.cwd);
  if (queue.length === 0) {
    return "queue: empty. Use /team to start a task or commit something to the queue.";
  }
  const next = queue[0];
  if (!next) return "queue: empty";
  ctx.ui.notify(`queue: running '${next.title}'`, "info");
  return `Run /team ${next.body}`;
}

export async function teamYoloCommand(ctx: CommandContext): Promise<string> {
  return "team-yolo: scheduling autonomous loop. (Wire to /loop with [AUTONOMOUS] wrapper.)";
}

export async function pulseCommand(ctx: CommandContext): Promise<string> {
  const wsDir = resolve(ctx.cwd, WORK_STATE_DIR);
  if (!existsSync(wsDir)) {
    return "pulse: no .work-state found. Run /team first to bootstrap.";
  }
  const branches = safeGit("git branch --show-current", ctx.cwd);
  const status = safeGit("git status --short", ctx.cwd);
  const last = safeGit("git log --oneline -10", ctx.cwd);
  const lines = [
    "## Pulse",
    "",
    `branch: ${branches ?? "(none)"}`,
    "",
    "git status:",
    status ?? "(clean)",
    "",
    "last 10 commits:",
    last ?? "(none)",
    "",
    "next-action menu:",
    "- /team <feature>",
    "- /team-fix <bug>",
    "- /init-team (if config missing)",
    "- /coordinator-stats",
  ];
  return lines.join("\n");
}

export async function initTeamCommand(ctx: CommandContext): Promise<string> {
  const dir = resolve(ctx.cwd, ".omp");
  mkdirSync(dir, { recursive: true });
  const configPath = join(dir, "team.config.json");
  if (existsSync(configPath)) {
    return `init-team: ${configPath} already exists. Skipping.`;
  }
  writeFileSync(configPath, JSON.stringify(defaultConfig, null, 2) + "\n");
  return `init-team: wrote ${configPath}`;
}

export async function interviewCommand(ctx: CommandContext): Promise<string> {
  return "interview: starting deep interview. (Delegates to `analyst` agent with structured clarifying questions.)";
}

export async function coordinatorStatsCommand(ctx: CommandContext): Promise<string> {
  const statsPath = resolve(ctx.cwd, WORK_STATE_DIR, "coordinator", "profile-stats.md");
  if (!existsSync(statsPath)) {
    return "coordinator-stats: no profile-stats.md yet. Run some /team invocations first.";
  }
  return readFileSync(statsPath, "utf8");
}

function readQueue(cwd: string): Array<{ title: string; body: string }> {
  const queuePath = resolve(cwd, WORK_STATE_DIR, "queue.json");
  if (!existsSync(queuePath)) return [];
  try {
    return JSON.parse(readFileSync(queuePath, "utf8")) as Array<{ title: string; body: string }>;
  } catch {
    return [];
  }
}

function safeGit(cmd: string, cwd: string): string | null {
  try {
    return execSync(cmd, { cwd, encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}
