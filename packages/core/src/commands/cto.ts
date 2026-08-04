/**
 * /cto — CTO sub-orchestration command (core contract).
 *
 * Part of the CTO/Head mode: the CTO agent receives a task, decomposes it
 * into a TeamPlan (up to 8 teams, depth 2), each team runs a sub-workflow
 * profile with its own lead + roster, escalations to the user are
 * asynchronous through an EscalationAdapter, and work continues while the
 * user answers.
 *
 * Same two-layer contract as `/do-work`: custom-TS commands have no `task`
 * surface, so this command returns a fully-formed prompt that the main agent
 * executes mechanically through its own `task`/`hub`. Consumers wire this
 * module into their own commands/hooks; the fullstack bundle ships a
 * self-contained copy (`packages/fullstack/commands/cto/`) — keep them in
 * sync (canonical source is here).
 *
 * Design: vibe-report/sub-orchestration-2026-08-04.md
 */

import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { findProfileDir } from "../engine/profile.js";
import { loadTeamDefs } from "../cto/plan.js";
import { MAX_DECOMPOSITION_DEPTH, MAX_TEAMS } from "../cto/types.js";
import type { CommandContext } from "./types.js";

const AUTONOMOUS_PREFIX = "[AUTONOMOUS";

export interface ParsedCtoEnvelope {
  task: string;
  autonomous: boolean;
  issue: number | null;
  branch: string | null;
}

/**
 * Parse the raw `<args>` string for `/cto`.
 * Recognized syntax: `[AUTONOMOUS] <task description> [issue=#N]`.
 * Outside a git work tree `branch` is `null` instead of an error.
 */
export function parseEnvelope(args: string, cwd: string): ParsedCtoEnvelope {
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

function renderTeamsTable(cwd: string): string {
  const teams = loadTeamDefs(cwd);
  if (teams.length === 0) {
    return [
      "| (no teams configured) | | | | | |",
      "",
      "> Create `.omp/teams.json` (array of TeamDef: id, name, scope, profile, lead, roster) to",
      "> register your development teams. Without teams the CTO cannot decompose.",
    ].join("\n");
  }
  return teams
    .map((t) => `| \`${t.id}\` | ${t.name} | \`${t.scope.join(", ")}\` | \`${t.profile}\` | \`${t.lead}\` | ${t.roster.map((r) => `\`${r}\``).join(", ")} |`)
    .join("\n");
}

/**
 * Build the CTO workflow prompt the main agent will execute.
 */
export function buildCtoPrompt(envelope: ParsedCtoEnvelope, cwd: string): string {
  const profilePath = join(findProfileDir(), "cto.json");
  const profileSection = existsSync(profilePath)
    ? `Workflow profile: \`${profilePath}\` — read exactly this one file for the stage list, gates, checkpoints, produces/consumes.`
    : "Workflow profile: `cto.json` not shipped yet — use the stage skeleton below and write the typed artifacts per stage.";

  const issueMeta = envelope.issue ? `Issue: #${envelope.issue}\n` : "";
  const branchMeta = envelope.branch ? `Branch: \`${envelope.branch}\`\n` : "Branch: (no git work tree)\n";
  const autonomousMeta = envelope.autonomous
    ? "Autonomous mode: ON. Skip user checkpoints; apply `autonomous` decision for every `checkpoint` stage."
    : "Autonomous mode: OFF. Pause at each `checkpoint` stage for user review.";

  return [
    "/cto workflow — execute via your `task` tool.",
    "",
    "### Task",
    envelope.task,
    "",
    "### Metadata",
    issueMeta + branchMeta + autonomousMeta,
    "",
    "### Team registry (.omp/teams.json)",
    "| Team | Name | Scope | Profile | Lead | Roster |",
    "| --- | --- | --- | --- | --- | --- |",
    renderTeamsTable(cwd),
    "",
    profileSection,
    "",
    "### CTO discipline (you are the orchestrator, not a coder)",
    "1. **Decompose** the task into a TeamPlan: pick teams from the registry (max 8, decomposition depth max 2),",
    "   assign each a non-overlapping `scope` slice + task `slice`, choose the sub-profile by slice complexity",
    "   (lightweight for small, standard for medium). Decide the git strategy per team (Q3):",
    "   coupled tasks -> one branch with parallel teams; independent tasks -> separate worktrees.",
    "   Persist the plan through the engine (`runCto`): state lives in `.work-state/cto/<id>/`.",
    "2. **Spawn leads** via `task` — one lead per team. Leads own their team: they decompose the slice into",
    "   worker tasks and spawn workers. Only you and the leads have `task`+`hub`; workers never re-delegate (R1).",
    "   **Leads never write source** — after each lead returns, verify its transcript: any `write`/`edit` on a",
    "   path outside `.work-state/` is a delegation violation; log it in `decisions.md` and re-state the rule on",
    "   the next spawn. A zero-worker lead is a failed lead.",
    "3. **Escalation ladder**: worker -> lead -> you (CTO) -> user. Decide what you can with a documented",
    "   `why` (decisions.md); escalate only what you cannot. `blocker` waits without timeout — the team parks",
    "   (`background_wait`), all other work continues; `question`/`decision` get `timeoutMs` + `default`.",
    "4. **Answers** arrive as files `.work-state/cto/<id>/answers/<esc-id>.json` (shape { id, answer, at, by })",
    "   — pick them up at the next team checkpoint. Apply only if the team is still waiting; late answers are",
    "   advisory (R5).",
    "5. **Summaries, not artifacts**: feed leads' compact summaries up, never raw artifacts (R3).",
    "6. **Integration**: merge worktree branches, run the integration review stage, aggregate per-team DoDs.",
    "   A failed team is isolated: re-spawn with the gate's reason, drop its scope, or escalate (R8).",
    "7. **Never code yourself.** Never patch a team's artifact by hand — re-spawn with a sharper task.",
    "",
    "### Failure modes to avoid",
    "- Do NOT let a worker re-delegate (rogue router) — only CTO/lead spawn.",
    "- Do NOT tolerate a self-coding lead — leads delegate, workers code (R1).",
    "- Do NOT block the whole run on one escalation — park the team, continue the rest.",
    "- Do NOT mark a team done while its DoD items are unmet.",
    "- Do NOT exceed 8 teams or depth 2 — re-plan (coarsen) instead.",
    "- Do NOT scan the filesystem for profiles/teams — read exactly `cto.json`, `.omp/teams.json`, `.omp/team.config.json`.",
    "",
    "Begin: decompose the task into a TeamPlan, persist it, and spawn the first leads.",
  ].join("\n");
}

/**
 * CommandContext-style entry (legacy command surface, mirrors `teamCommand`).
 * Returns the CTO prompt; the caller feeds it to the main agent.
 */
export function ctoCommand(ctx: CommandContext): string {
  const raw = ctx.args.trim();
  if (!raw) {
    return [
      "Usage: /cto <task description> [issue=#N] [AUTONOMOUS]",
      "",
      "CTO sub-orchestration: decompose -> teams -> integration.",
      "Example: /cto Add OAuth with Google and GitHub",
    ].join("\n");
  }
  const envelope = parseEnvelope(raw, ctx.cwd);
  if (!envelope.task) return "ERROR: empty task after stripping prefix.";
  ctx.ui.notify(`cto: ${envelope.task.slice(0, 60)} (decomposition pending)`, "info");
  return buildCtoPrompt(envelope, ctx.cwd);
}
