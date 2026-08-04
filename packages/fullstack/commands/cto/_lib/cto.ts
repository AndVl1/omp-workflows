/**
 * /cto — CTO sub-orchestration (self-contained copy of the core contract).
 *
 * Canonical implementation: `packages/core/src/commands/cto.ts` (exported
 * from @andvl1/omp-workflows-core — consumers wire it into their own
 * commands/hooks). This directory is the SHIPPED custom-TS command copied
 * into `<project>/.omp/commands/cto/` at install time; it is self-contained
 * because copied commands resolve imports relative to their own tree
 * (same pattern as `/do-work`). Keep the logic in sync with core.
 *
 * Design: vibe-report/sub-orchestration-2026-08-04.md
 */

import { execSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { resolveWorkflowProfilePath } from "../../do-work/_lib/profile.js";

const AUTONOMOUS_PREFIX = "[AUTONOMOUS";

export interface ParsedCtoEnvelope {
  task: string;
  autonomous: boolean;
  issue: number | null;
  branch: string | null;
}

export interface TeamDefLike {
  id: string;
  name: string;
  scope: string[];
  profile: string;
  lead: string;
  roster: string[];
}

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

/** Load `<cwd>/.omp/teams.json` (array of TeamDef). Missing/malformed -> []. */
export function loadTeamDefs(cwd: string): TeamDefLike[] {
  try {
    const raw = JSON.parse(readFileSync(join(cwd, ".omp", "teams.json"), "utf8")) as unknown;
    if (!Array.isArray(raw)) return [];
    return raw.filter((entry): entry is TeamDefLike => {
      return (
        typeof entry === "object" &&
        entry !== null &&
        typeof (entry as TeamDefLike).id === "string" &&
        typeof (entry as TeamDefLike).name === "string"
      );
    });
  } catch {
    return [];
  }
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

export function buildCtoPrompt(envelope: ParsedCtoEnvelope, cwd: string): string {
  const profilePath = resolveWorkflowProfilePath("cto", cwd);
  const profileSection = profilePath
    ? `Workflow profile: \`${profilePath}\` — read exactly this one file for the stage list, gates, checkpoints, produces/consumes.`
    : "Workflow profile: `cto.json` not found — use the stage skeleton below and write the typed artifacts per stage.";

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
    "   code). Decide the git strategy per team:",
    "   coupled tasks -> one branch with parallel teams; independent tasks -> separate worktrees.",
    "   Persist the plan through the engine (`runCto`): state lives in `.work-state/cto/<id>/`.",
    "2. **Architecture first (multi-team runs)**: after the plan, run the architecture stage — spawn the",
    "   `architect` (single `task`) to produce the cross-team contract BEFORE spawning leads: api_contract",
    "   (endpoints/DTOs), file ownership per team, shared interfaces, ports/CORS. Leads consume the contract",
    "   in their slices. Single-team runs: skip the stage, the contract lives in the plan.",
    "3. **Spawn leads** via `task` — one lead per team. Leads own their team: they decompose the slice into",
    "   worker tasks and spawn workers. Only you and the leads have `task`+`hub`; workers never re-delegate.",
    "   **Leads never write source** — after each lead returns, verify its transcript: any `write`/`edit` on a",
    "   path outside `.work-state/` is a delegation violation; log it in `decisions.md` and re-state the rule on",
    "   the next spawn. A zero-worker lead is a failed lead.",
    "4. **Escalation ladder**: worker -> lead -> you (CTO) -> user. Decide what you can with a documented",
    "   `why` (decisions.md); escalate only what you cannot. `blocker` waits without timeout — the team parks",
    "   (`background_wait`), all other work continues; `question`/`decision` get `timeoutMs` + `default`.",
    "5. **Answers** arrive as files `.work-state/cto/<id>/answers/<esc-id>.json` (shape { id, answer, at, by })",
    "   — pick them up at the next team checkpoint. Apply only if the team is still waiting; late answers are",
    "   advisory.",
    "6. **Summaries, not artifacts**: feed leads' compact summaries up, never raw artifacts.",
    "7. **Integration**: merge worktree branches, run the integration review stage, aggregate per-team DoDs.",
    "   A failed team is isolated: re-spawn with the gate's reason, drop its scope, or escalate.",
    "8. **Never code yourself.** Never patch a team's artifact by hand — re-spawn with a sharper task.",
    "",
    "### Failure modes to avoid",
    "- Do NOT let a worker re-delegate (rogue router) — only CTO/lead spawn.",
    "- Do NOT tolerate a self-coding lead — leads delegate, workers code.",
    "- Do NOT block the whole run on one escalation — park the team, continue the rest.",
    "- Do NOT mark a team done while its DoD items are unmet.",
    "- Do NOT exceed 8 teams or depth 2 — re-plan (coarsen) instead.",
    "- Do NOT scan the filesystem for profiles/teams — read exactly `cto.json`, `.omp/teams.json`, `.omp/team.config.json`.",
    "",
    "Begin: decompose the task into a TeamPlan, persist it, and spawn the first leads.",
  ].join("\n");
}

export interface ActiveCtoRun {
  runId: string;
  state: {
    plan: { created_at: string };
    teams: Array<{ id: string; status: string }>;
    pause: { kind: string; reason?: string };
    updated_at: string;
  };
}

const FINISH_MARKERS = ["summary.md", "summary.json", "integration_review.md", "integration_review.json"];
const TEAM_LINE = /(?:^\s*[-*]\s*(?:team\s*)?[:\-]?\s*|^\s*\|\s*)`?([a-z0-9][a-z0-9-_]*)`?/i;

function markdownCtoState(runId: string, runDir: string): ActiveCtoRun["state"] | null {
  let files: string[];
  try {
    files = readdirSync(runDir).filter((name) => name.endsWith(".md") || name.endsWith(".json"));
  } catch {
    return null;
  }
  if (!files.some((name) => ["team-plan.md", "decisions.md", "cto_discovery.md"].includes(name))) return null;
  if (files.some((name) => FINISH_MARKERS.includes(name))) return null;

  const teams: Array<{ id: string; status: string }> = [];
  try {
    const planPath = join(runDir, "team-plan.md");
    if (existsSync(planPath)) {
      for (const line of readFileSync(planPath, "utf8").split("\n")) {
        const match = line.match(TEAM_LINE);
        if (match?.[1] && !teams.some((t) => t.id === match[1])) teams.push({ id: match[1], status: "in_progress" });
      }
    }
  } catch { /* best-effort */ }

  let newest = 0;
  for (const name of files) {
    try { newest = Math.max(newest, statSync(join(runDir, name)).mtimeMs); } catch { /* skip */ }
  }
  const updatedAt = newest > 0 ? new Date(newest).toISOString() : new Date(0).toISOString();
  return {
    plan: { created_at: updatedAt },
    teams,
    pause: { kind: "none", reason: "markdown state (agent-written, no state.json)" },
    updated_at: updatedAt,
  };
}

type ActiveRunBest = { runId: string; state: ActiveCtoRun["state"] };

/**
 * Find the single active CTO run — state.json first (engine-written), then a
 * markdown fallback for agent-written runs (br-5ql). A run is finished when
 * its pause is done/failed, or (markdown) when a summary/integration-review
 * marker exists; latest by updated_at, else null. Self-contained copy of the
 * core contract (br-k19 amend protocol).
 */
export function findActiveCtoRun(cwd: string): ActiveRunBest | null {
  const runsDir = join(cwd, ".work-state", "cto");
  if (!existsSync(runsDir)) return null;
  let best: ActiveRunBest | null = null;
  let bestAt = "";
  for (const runId of readdirSync(runsDir)) {
    const runDir = join(runsDir, runId);
    if (!existsSync(runDir)) continue;
    const statePath = join(runDir, "state.json");
    let state: ActiveCtoRun["state"] | null = null;
    if (existsSync(statePath)) {
      try {
        const parsed = JSON.parse(readFileSync(statePath, "utf8")) as ActiveCtoRun["state"];
        if (parsed?.pause?.kind !== "done" && parsed?.pause?.kind !== "failed") state = parsed;
      } catch { /* corrupt — fall through to markdown */ }
    }
    if (!state) state = markdownCtoState(runId, runDir);
    if (!state) continue;
    if (!best || state.updated_at > bestAt) {
      best = { runId, state };
      bestAt = state.updated_at;
    }
  }
  return best;
}

/** Amend contract: second /cto while a run is active folds the task into it. */
export function buildAmendPrompt(
  envelope: ParsedCtoEnvelope,
  active: ActiveCtoRun,
): string {
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
    "3. **Persist**: append the new teams to `state.json` and stamp `amended_at`; document the amend in",
    "   `decisions.md` (why).",
    "4. **Integration covers ALL teams** (original + added): integration review verifies the merged result",
    "   against the (extended) contract; DoD aggregation across every team.",
    "5. **Edge cases**: run at max teams -> write the task to `.work-state/queue.json` for the next run;",
    "   run already in the integration phase -> same (queue it); scope overlap with an active team -> extend",
    "   that team's slice (re-spawn its lead with an additional worker task) instead of adding a team.",
    "6. **Escalations** of the new teams use the same ladder (worker -> lead -> you -> user); you never spawn",
    "   a second orchestrator.",
    "",
    "Begin: read the active state, amend the plan, spawn the new leads.",
  ].join("\n");
}
