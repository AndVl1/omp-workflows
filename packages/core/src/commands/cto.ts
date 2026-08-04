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
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { findProfileDir } from "../engine/profile.js";
import { loadTeamDefs } from "../cto/plan.js";
import { readCtoState, ctoStateDir } from "../cto/state.js";
import { MAX_DECOMPOSITION_DEPTH, MAX_TEAMS, type CtoState } from "../cto/types.js";
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
    "### You are the CTO",
    "You ARE the orchestrator — execute this contract YOURSELF, in this session.",
    "Do NOT delegate the orchestrator role to a sub-agent (no sub-CTO): a delegated CTO",
    "eats a nesting level and breaks the lead/worker toolset (depth contract: main(CTO) ->",
    "lead -> worker, max 3 levels). You spawn leads via `task`; you never spawn a CTO.",
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
    "   assign each a non-overlapping `scope` slice + task `slice`, choose the sub-profile with the SAME",
    "   resolution as /do-work (resolveWorkflow): FEATURE/REFACTOR: QUICK -> lightweight, MEDIUM -> standard,",
    "   COMPLEX/CRITICAL -> full-feature; BUG_FIX -> debug-cycle (bug-fix only for interactive QUICK);",
    "   OPS: QUICK -> lightweight else standard; INVESTIGATION -> research. Bug-fix slices run through the",
    "   team: the lead walks debug-cycle (diagnose -> root cause -> fix -> verify; root_cause gate before",
    "   code). Decide the git strategy per team (Q3):",
    "   coupled tasks -> one branch with parallel teams; independent tasks -> separate worktrees.",
    "   Persist the plan through the engine (`runCto`): state lives in `.work-state/cto/<id>/`.",
    "2. **Architecture first (multi-team runs)**: after the plan, run the architecture stage — spawn the",
    "   `architect` (single `task`) to produce the cross-team contract BEFORE spawning leads: api_contract",
    "   (endpoints/DTOs), file ownership per team, shared interfaces, ports/CORS. Leads consume the contract",
    "   in their slices. Single-team runs: skip the stage, the contract lives in the plan.",
    "3. **Spawn leads** via `task` — one lead per team. Leads own their team: they decompose the slice into",
    "   worker tasks and spawn workers. Only you and the leads have `task`+`hub`; workers never re-delegate (R1).",
    "   **Leads never write source** — after each lead returns, verify its transcript: any `write`/`edit` on a",
    "   path outside `.work-state/` is a delegation violation; log it in `decisions.md` and re-state the rule on",
    "   the next spawn. A zero-worker lead is a failed lead.",
    "4. **Escalation ladder**: worker -> lead -> you (CTO) -> user. Decide what you can with a documented",
    "   `why` (decisions.md); escalate only what you cannot. `blocker` waits without timeout — the team parks",
    "   (`background_wait`), all other work continues; `question`/`decision` get `timeoutMs` + `default`.",
    "5. **Answers** arrive as files `.work-state/cto/<id>/answers/<esc-id>.json` (shape { id, answer, at, by })",
    "   — pick them up at the next team checkpoint. Apply only if the team is still waiting; late answers are",
    "   advisory (R5).",
    "6. **Summaries, not artifacts**: feed leads' compact summaries up, never raw artifacts (R3).",
    "7. **Integration**: merge worktree branches, run the integration review stage, aggregate per-team DoDs.",
    "   A failed team is isolated: re-spawn with the gate's reason, drop its scope, or escalate (R8).",
    "8. **Never code yourself.** Never patch a team's artifact by hand — re-spawn with a sharper task.",
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
 * Find the single active CTO run — any state.json under
 * `.work-state/cto/<runId>/` whose pause.kind is not done/failed.
 * Returns the latest by updated_at, or null.
 * The amend protocol (br-k19): a second `/cto` while a run is active folds
 * the new task into THAT run instead of starting a fresh orchestrator.
 */
export function findActiveCtoRun(cwd: string): { runId: string; state: CtoState } | null {
  const runsDir = join(cwd, ".work-state", "cto");
  if (!existsSync(runsDir)) return null;
  let best: { runId: string; state: CtoState } | null = null;
  let bestAt = "";
  for (const runId of readdirSync(runsDir)) {
    if (!existsSync(ctoStateDir(runId, cwd))) continue;
    const state = readCtoState(runId, cwd);
    if (!state) continue;
    if (state.pause.kind === "done" || state.pause.kind === "failed") continue;
    if (!best || state.updated_at > bestAt) {
      best = { runId, state };
      bestAt = state.updated_at;
    }
  }
  return best;
}

/**
 * Amend contract: returned by `/cto` when a run is already active. The new
 * task is folded into the same run by the SAME orchestrator (single CTO).
 */
export function buildAmendPrompt(envelope: ParsedCtoEnvelope, cwd: string, active: { runId: string; state: CtoState }): string {
  const teamsLine = active.state.teams.map((t) => `${t.id}:${t.status}`).join(", ");
  const issueMeta = envelope.issue ? `Issue: #${envelope.issue}\n` : "";
  const autonomousMeta = envelope.autonomous
    ? "Autonomous mode: ON — apply documented defaults at every checkpoint."
    : "Autonomous mode: OFF — pause at checkpoints for user review.";

  return [
    "/cto AMEND — a new task arrived while a CTO run is ACTIVE.",
    "",
    "### Active run",
    `Run: \`${active.runId}\` (started ${active.state.plan.created_at})`,
    `Teams: ${teamsLine}`,
    `Pause: ${active.state.pause.kind} — ${active.state.pause.reason || "no reason"}`,
    `State: \`.work-state/cto/${active.runId}/state.json\` — read it BEFORE touching anything.`,
    "",
    "### New task (fold into the SAME run)",
    issueMeta + autonomousMeta,
    envelope.task,
    "",
    "### You are still the CTO (single orchestrator, this session)",
    "Do NOT start a second run or orchestrator. Do NOT spawn a sub-CTO.",
    "",
    "### Amend rules",
    "1. **Re-plan**: add teams from the registry (`.omp/teams.json`) for the new task — total teams across the",
    "   run <= 8, depth <= 2. New leads spawn in PARALLEL with active teams; existing teams keep working.",
    "   Choose sub-profiles with the SAME resolution as /do-work (resolveWorkflow).",
    "2. **Architecture**: if the new task adds cross-team surface, run the architect for the ADDITIONAL",
    "   contract (or extend the existing architecture artifact); new leads consume it.",
    "3. **Persist**: append the new teams to \`state.json\` and stamp \`amended_at\`; document the amend in",
    "   \`decisions.md\` (why).",
    "4. **Integration covers ALL teams** (original + added): integration review verifies the merged result",
    "   against the (extended) contract; DoD aggregation across every team.",
    "5. **Edge cases**: run at max teams -> write the task to \`.work-state/queue.json\` for the next run;",
    "   run already in the integration phase -> same (queue it); scope overlap with an active team -> extend",
    "   that team's slice (re-spawn its lead with an additional worker task) instead of adding a team.",
    "6. **Escalations** of the new teams use the same ladder (worker -> lead -> you -> user); you never spawn",
    "   a second orchestrator.",
    "",
    "Begin: read the active state, amend the plan, spawn the new leads.",
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
      "CTO sub-orchestration: decompose -> architecture -> teams -> integration.",
      "Example: /cto Add OAuth with Google and GitHub",
    ].join("\n");
  }
  const envelope = parseEnvelope(raw, ctx.cwd);
  if (!envelope.task) return "ERROR: empty task after stripping prefix.";
  const active = findActiveCtoRun(ctx.cwd);
  if (active) {
    ctx.ui.notify(`cto: amending run ${active.runId} with: ${envelope.task.slice(0, 50)}`, "info");
    return buildAmendPrompt(envelope, ctx.cwd, active);
  }
  ctx.ui.notify(`cto: ${envelope.task.slice(0, 60)} (decomposition pending)`, "info");
  return buildCtoPrompt(envelope, ctx.cwd);
}
