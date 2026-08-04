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
import { readFileSync } from "node:fs";
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
    "2. **Spawn leads** via `task` — one lead per team. Leads own their team: they decompose the slice into",
    "   worker tasks and spawn workers. Only you and the leads have `task`+`hub`; workers never re-delegate.",
    "   **Leads never write source** — after each lead returns, verify its transcript: any `write`/`edit` on a",
    "   path outside `.work-state/` is a delegation violation; log it in `decisions.md` and re-state the rule on",
    "   the next spawn. A zero-worker lead is a failed lead.",
    "3. **Escalation ladder**: worker -> lead -> you (CTO) -> user. Decide what you can with a documented",
    "   `why` (decisions.md); escalate only what you cannot. `blocker` waits without timeout — the team parks",
    "   (`background_wait`), all other work continues; `question`/`decision` get `timeoutMs` + `default`.",
    "4. **Answers** arrive as files `.work-state/cto/<id>/answers/<esc-id>.json` (shape { id, answer, at, by })",
    "   — pick them up at the next team checkpoint. Apply only if the team is still waiting; late answers are",
    "   advisory.",
    "5. **Summaries, not artifacts**: feed leads' compact summaries up, never raw artifacts.",
    "6. **Integration**: merge worktree branches, run the integration review stage, aggregate per-team DoDs.",
    "   A failed team is isolated: re-spawn with the gate's reason, drop its scope, or escalate.",
    "7. **Never code yourself.** Never patch a team's artifact by hand — re-spawn with a sharper task.",
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
