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
 * executes mechanically through its own `task`/`hub`. Consumers re-export the
 * contract through thin project-local discovery adapters.
 *
 * Design: vibe-report/sub-orchestration-2026-08-04.md
 */

import { execSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { findProfileDir } from "../engine/profile.js";
import { loadTeamDefs } from "../cto/plan.js";
import { isCtoRunTerminal, readCtoState, resolveCtoAutonomous, ctoStateDir } from "../cto/state.js";
import { MAX_DECOMPOSITION_DEPTH, MAX_TEAMS, type CtoState } from "../cto/types.js";
import type { ModelClassification } from "../engine/run.js";
import { parseAutonomousDirective } from "./envelope.js";
import { buildClassificationPhaseZero, buildWorkflowMatrix } from "./classification-contract.js";
import type { CommandContext } from "./types.js";

export interface ParsedCtoEnvelope {
  task: string;
  /**
   * MECHANICAL hint from the leading-directive parser. NON-AUTHORITATIVE:
   * PHASE-0 has the main LLM decide `autonomous` from the full task
   * semantics; this value is rendered as a hint and never persisted as the
   * decision.
   */
  autonomyHint: boolean;
  issue: number | null;
  branch: string | null;
}

/**
 * Parse the raw `<args>` string for `/cto`.
 * Recognized syntax: `[AUTONOMOUS] <task description> [issue=#N]`, plus the
 * approved leading natural-language directives from the shared parser
 * (`действуй автономно`). Lookalike prefixes stay literal task text.
 * Outside a git work tree `branch` is `null` instead of an error.
 */
export function parseEnvelope(args: string, cwd: string): ParsedCtoEnvelope {
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
 * Render the user-communication channel section from `.omp/escalation.json`.
 * - `telegram`: bidirectional — ALL user questions go through the messenger
 *   (outbox -> answers/), the `ask` tool is blocked.
 * - `http`: push-only — use `ask` for interactive checkpoints.
 * - none: use `ask`.
 */
export function renderChannelSection(cwd: string): string {
  let adapter: string | null = null;
  let bidirectional = false;
  try {
    const raw = JSON.parse(readFileSync(join(cwd, ".omp", "escalation.json"), "utf8")) as { adapter?: string; bidirectional?: boolean };
    if (typeof raw?.adapter === "string") adapter = raw.adapter;
    if (raw?.bidirectional === true) bidirectional = true;
  } catch {
    // missing/malformed — no channel
  }
  if (adapter === "telegram" || bidirectional) {
    return [
      "### User channel (messenger, BIDIRECTIONAL)",
      "A messenger channel with feedback is configured. ALL user communication goes through it:",
      "- Checkpoints and any question: write the escalation to `.work-state/cto/<id>/outbox/<escId>.json`",
      "  (level `question`/`decision`, `timeoutMs` + `default`); answers arrive in `answers/<escId>.json`.",
      "- NEVER use the `ask` tool — it is blocked while this channel is active.",
      "- Blocking waits park the team (`background_wait`); everything else continues.",
      "- In standby: tasks arrive as `[CTO-INBOX]` messages — treat each as a USER COMMAND to the",
      "  main-session CTO: fold it into the run (amend discipline) and return to standby after the wave.",
    ].join("\n");
  }
  if (adapter === "http") {
    return [
      "### User channel (push-only)",
      "An HTTP channel is configured but it is PUSH-ONLY (no feedback path).",
      "Use `ask` for interactive checkpoints; escalations sent over the channel are advisory.",
    ].join("\n");
  }
  return [
    "### User channel (none)",
    "No escalation channel configured. Use the `ask` tool for checkpoints.",
  ].join("\n");
}

/**
 * Build the CTO STANDBY prompt: CTO mode with no task yet. The agent persists
 * a standby run (so the run is active: amend detection, inbox routing and the
 * per-turn reminder all key off it), yields, and waits for `[CTO-INBOX]`
 * tasks (injected by the messenger dispatcher or dropped in
 * `.work-state/cto/<id>/inbox/`).
 */
export function buildStandbyCtoPrompt(cwd: string): string {
  return [
    "/cto STANDBY — CTO sub-orchestration is ON with NO task yet. Execute this contract YOURSELF, in this session.",
    "",
    "### You are the CTO (standby)",
    "You ARE the orchestrator — and you are THE MAIN AGENT of this session, the resident CTO.",
    "Do NOT invent work while waiting. Do NOT delegate the orchestrator role.",
    "The CTO is never spawned: NEVER run `task(agent=cto)` or `task(agent=@cto)` — not mechanically,",
    "not by text. `/cto` executes in-session; this session IS the CTO.",
    "",
    "### Standby steps",
    "1. **Adopt or persist the standby run NOW**: inspect `.work-state/cto/*/state.json` for the latest active",
    "   standby state (`standby: true`, `plan.task: \"standby — awaiting inbox tasks\"`). Reuse its `<id>` and",
    "   inbox so tasks queued before this session are not lost. If none exists, write",
    "   `.work-state/cto/standby-<id>/state.json` (schema 2, `pause.kind: \"none\"`,",
    "   `plan.task: \"standby — awaiting inbox tasks\"`, `teams: []`, `autonomous: true`, `standby: true` — the",
    "   standby marker keeps the run adoptable across sessions). The run must exist before waiting: inbox",
    "   routing, amend detection and the per-turn reminder all key off its state.",
    "   **This `autonomous: true` is ENGINE-CREATED — standby has NO user task, so there is nothing to",
    "   classify.** The standby state therefore carries NO `classification` field (model-first: a",
    "   classification exists only when a task was classified). It is not a PHASE-0 decision; each",
    "   inbox task that arrives is classified by YOU (type, complexity, confidence, autonomous) on",
    "   wake, exactly like a `/cto <task>` invocation.",
    "2. Read `.omp/teams.json` + `cto.json` profile now (not later) so the wake turn is cheap.",
    "3. Drain the adopted run's pending inbox before yielding, then yield and WAIT.",
    "",
    "### Tasks arrive two ways",
    "- A `[CTO-INBOX]` user message (injected by the messenger dispatcher), or",
    "- files in `.work-state/cto/<id>/inbox/*.json` ({ id, text, at, by }).",
    "`[CTO-INBOX]` messages ARE USER COMMANDS — direct instructions to you, the main-session CTO:",
    "no new session, no subagent dispatch. On EACH wake: treat the payload as a `/cto <task>` command",
    "and fold it into THIS run (amend discipline: re-plan, spawn leads in parallel, integration covers",
    "ALL teams). Multiple tasks = multiple sequential waves; do not merge them into one team.",
    "",
    "### After each wave",
    "Stay on-line when a wave completes — you remain the CTO of this session. Close the wave",
    "(integration + summary), keep the run active, and return to standby: yield and wait for the",
    "next `[CTO-INBOX]` task (or `inbox/` file) to fold in.",
    "",
    "### Your rules (abridged)",
    "- Delegate, never code. Teams: pick from the registry, one lead per team, leads spawn workers.",
    "- Escalation ladder: worker -> lead -> you -> user.",
    "- Failed subagents (exit 1) are resource failures: verify disk artifacts, re-spawn the SAME spec,",
    "  on second failure dispatch the workers directly (single-worker slices skip the lead from the start).",
    "",
    renderChannelSection(cwd),
    "",
    "Begin: persist the standby run, read the registry, yield.",
  ].join("\n");
}

/**
 * Options that affect prompt rendering (session identity for ownership).
 */
export interface CtoPromptOptions {
  /**
   * OMP session id of the interactive session that invoked `/cto`. Rendered
   * into the persistence contract so the run records its owner; a foreign
   * session cannot amend an owned run (see findActiveCtoRun).
   */
  sessionId?: string;
}

/** Persistence contract lines shared by the CTO task/amend prompts. */
function persistenceContract(opts: CtoPromptOptions): string {
  const sessionLine = opts.sessionId ? `\`session: ${opts.sessionId}\`` : "`session: <your current omp session id>`";
  return [
    "### State persistence (mandatory)",
    "When you persist the run state (cto_discovery.md / team-plan.md / state.json), include the",
    "classification you decided in PHASE-0 as the STRUCTURED model decision — one",
    "`classification: { \"type\": ..., \"complexity\": ..., \"confidence\": ..., \"autonomous\": <true|false>,",
    "\"autonomous_reason\": ... }` line. `classification.autonomous` is the AUTHORITY; the legacy",
    "top-level `autonomous` line is read-compat only. The `autonomous` value is YOUR model decision,",
    "never the mechanical hint. Also keep the metadata line below VERBATIM so session ownership",
    "survives across sessions and is never re-derived from task text:",
    sessionLine,
    "",
  ].join("\n");
}

/**
 * Build the CTO workflow prompt the main agent will execute.
 */
export function buildCtoPrompt(envelope: ParsedCtoEnvelope, cwd: string, opts: CtoPromptOptions = {}): string {
  const profilePath = join(findProfileDir(), "cto.json");
  const profileSection = existsSync(profilePath)
    ? `Workflow profile: \`${profilePath}\` — read exactly this one file for the stage list, gates, checkpoints, produces/consumes.`
    : "Workflow profile: `cto.json` not shipped yet — use the stage skeleton below and write the typed artifacts per stage.";

  const issueMeta = envelope.issue ? `Issue: #${envelope.issue}\n` : "";
  const branchMeta = envelope.branch ? `Branch: \`${envelope.branch}\`\n` : "Branch: (no git work tree)\n";
  const sessionMeta = opts.sessionId ? `Session: \`${opts.sessionId}\`\n` : "";

  return [
    "/cto workflow — execute this prompt IN-SESSION: you are the MAIN AGENT, the resident CTO.",
    "You are never dispatched for this — `/cto` runs here.",
    "",
    "### You are the CTO",
    "You ARE the orchestrator — execute this contract YOURSELF, in this session, as the resident",
    "CTO (main-session role). NEVER run `task(agent=cto)` or `task(agent=@cto)`: the CTO role has",
    "no nested form — spawning one is forbidden even by text.",
    "Do NOT delegate the orchestrator role to a sub-agent (no sub-CTO): a delegated CTO",
    "eats a nesting level and breaks the lead/worker toolset (depth contract: main(CTO) ->",
    "lead -> worker, max 3 levels). You spawn leads via `task`; you never spawn a CTO.",
    "",
    "### Task",
    envelope.task,
    "",
    "### Metadata",
    issueMeta + branchMeta + sessionMeta,
    "",
    buildClassificationPhaseZero({ label: "leading directive", value: envelope.autonomyHint }),
    "",
    buildWorkflowMatrix(),
    "",
    "### Persist the classification",
    "Record your PHASE-0 classification in the run state as the STRUCTURED model decision, on ONE",
    "line in cto_discovery.md / team-plan.md / state.json:",
    "`classification: { \"type\": ..., \"complexity\": ..., \"confidence\": ..., \"autonomous\": <true|false>,",
    "\"autonomous_reason\": ... }`. `classification.autonomous` is the AUTHORITY — the legacy",
    "top-level `autonomous: <true|false>` line is read-compat only and never overrides a present",
    "classification. The persisted `autonomous` value is YOUR model decision — never the mechanical hint.",
    "",
    persistenceContract(opts),
    "### Team registry (.omp/teams.json)",
    "| Team | Name | Scope | Profile | Lead | Roster |",
    "| --- | --- | --- | --- | --- | --- |",
    renderTeamsTable(cwd),
    "",
    profileSection,
    "",
    renderChannelSection(cwd),
    "",
    "### CTO discipline (you are the orchestrator, not a coder)",
    "1. **Decompose** the task into a TeamPlan: pick teams from the registry (max 8, decomposition depth max 2),",
    "   assign each a non-overlapping `scope` slice + task `slice`, and choose the sub-profile from the",
    "   Workflow resolution matrix above — the SAME table as /do-work (resolveWorkflow), including REVIEW ->",
    "   review and HOTFIX -> emergency. Bug-fix slices run through the",
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
    "9. **Inbox check**: read `.work-state/cto/*/inbox/*.json` BEFORE decomposing — tasks may have",
    "   arrived via the messenger while no session was listening; fold them into this run too",
    "   (each as its own wave, amend discipline).",
    "",
    "### Failure modes to avoid",
    "- Do NOT let a worker re-delegate (rogue router) — only CTO/lead spawn.",
    "- Do NOT tolerate a self-coding lead — leads delegate, workers code.",
    "- Do NOT block the whole run on one escalation — park the team, continue the rest.",
    "- Do NOT mark a team done while its DoD items are unmet.",
    "- Do NOT exceed 8 teams or depth 2 — re-plan (coarsen) instead.",
    "- Do NOT scan the filesystem for profiles/teams — read exactly `cto.json`, `.omp/teams.json`, `.omp/team.config.json`.",
    "",
    "### Subagent dispatch reliability (lead exit-1 protocol)",
    "A lead that returns `exit 1` is a SUBAGENT/PROVIDER failure, not a team decision —",
    "the harness intermittently kills subagents that stall or mis-yield at a nested `task` call",
    "(provider-side, model-dependent). Treat it as a resource failure and FAIL OVER, never as a verdict:",
    "1. **Verify disk state first.** The failed lead's prep usually survived: check",
    "   `.work-state/cto/<id>/` and `.work-state/artifacts/<team>/` for inventories, decisions,",
    "   worker outputs. NEVER redo the inventory/prep — it is on disk.",
    "2. **Re-spawn the lead with the SAME slice spec** (the exact task text from the plan, plus a",
    "   note 'resume from disk state — do not redo prep; verify artifacts first').",
    "3. **Second failure -> degrade, do not loop.** Dispatch that team's workers DIRECTLY from you",
    "   (your own `task` tool): one worker per actionable item, each with the findings already on",
    "   disk. Or fold the slice into an adjacent team. Log the degradation in `decisions.md` (why).",
    "4. **Single-worker slices: skip the lead hop from the start.** When a team's slice needs one",
    "   worker (typical fix slice), dispatch that worker directly from you — the lead layer pays",
    "   off only for genuinely multi-worker teams. This also halves the nesting depth.",
    "5. **Dispatch hygiene for leads** (re-state in the lead task): dispatch the first worker as",
    "   soon as the slice is decomposed — BEFORE pulling large files into context; keep task specs",
    "   lean (reference file paths; findings go to disk as inventory JSON the worker reads, not into",
    "   the spec); one worker per `task` call. Big specs at heavy context are exactly where subagents",
    "   stall.",
    "",
    "### After the wave",
    "When integration completes and the summary is written, close ONLY the current wave.",
    "Keep the resident CTO run active; return to standby — stay on-line, yield, and await the next task",
    "(`[CTO-INBOX]` message or `inbox/` file), folding it in as an amend.",
    "",
    "Begin: decompose the task into a TeamPlan, persist it, and spawn the first leads.",
  ].join("\n");
}

/**
 * Files that mark a markdown-state run as FINISHED (agent-written).
 * Two-layer reality: the CTO agent writes state as markdown (team-plan.md,
 * decisions.md, cto_discovery.md) and never calls the TS engine — so a run
 * without state.json is active until one of these markers appears.
 */
const FINISH_MARKERS = ["summary.md", "summary.json", "integration_review.md", "integration_review.json"];

/** Team ids referenced in a markdown team-plan (best-effort extraction). */
const TEAM_LINE = /(?:^\s*[-*]\s*(?:team\s*)?[:\-]?\s*|^\s*\|\s*)`?([a-z0-9][a-z0-9-_]*)`?/i;

function markdownFiles(runDir: string): string[] {
  try {
    return readdirSync(runDir).filter((name) => name.endsWith(".md") || name.endsWith(".json"));
  } catch {
    return [];
  }
}

function newestMtime(runDir: string, files: string[]): string {
  let newest = 0;
  for (const name of files) {
    try {
      newest = Math.max(newest, statSync(join(runDir, name)).mtimeMs);
    } catch {
      // missing/racy — skip
    }
  }
  return newest > 0 ? new Date(newest).toISOString() : new Date(0).toISOString();
}

/**
 * Deterministic metadata line inside agent-written state files. The CTO
 * prompts instruct persisting the model classification as ONE
 * `classification: { ... }` line plus `session: <id>` on their own lines, so
 * markdown-state runs keep the parsed classification and their session owner
 * instead of erasing them (RC3/RC4). The top-level `autonomous: <bool>` and
 * `standby: <bool>` lines remain LEGACY read-compat only: `autonomous` is
 * consulted solely when no classification line is present, and standby stays
 * the engine-created marker.
 */
const STATE_META_LINE = /^\s*(autonomous|session|standby)\s*:\s*(.+?)\s*$/i;

/** One-line structured model classification: `classification: { "type": ..., ... }`. */
const CLASSIFICATION_LINE = /^\s*classification\s*:\s*(\{.*\})\s*$/i;

/**
 * Files that may carry the persisted state-metadata lines per the CTO
 * prompt contract (`classification:` / `autonomous:` / `session:` /
 * `standby:`). Only these are scanned so unrelated markdown prose (e.g. a
 * decisions.md line starting with "session: ...") can never be misread as
 * run metadata.
 */
const STATE_META_FILES = ["state.json", "cto_discovery.md", "team-plan.md"];

interface MarkdownStateMeta {
  /** Model-first structured classification (the authority when present). */
  classification?: ModelClassification;
  /** LEGACY top-level autonomy line — read-compat only. */
  autonomous?: boolean;
  session?: string;
  standby?: boolean;
}

/** A classification line counts only when it carries the required fields. */
function isStructuredClassification(value: unknown): value is ModelClassification {
  if (!value || typeof value !== "object") return false;
  const c = value as Record<string, unknown>;
  return (
    typeof c.type === "string" &&
    typeof c.complexity === "string" &&
    typeof c.confidence === "string" &&
    typeof c.autonomous === "boolean"
  );
}

function readStateMeta(runDir: string, files: string[]): MarkdownStateMeta {
  const meta: MarkdownStateMeta = {};
  const candidates = files.filter((name) => STATE_META_FILES.includes(name)).sort();
  for (const name of candidates) {
    let body: string;
    try {
      body = readFileSync(join(runDir, name), "utf8");
    } catch {
      continue; // unreadable — try the next state file
    }
    for (const line of body.split("\n")) {
      const classMatch = line.match(CLASSIFICATION_LINE);
      if (classMatch?.[1] && meta.classification === undefined) {
        try {
          const parsed = JSON.parse(classMatch[1]) as unknown;
          if (isStructuredClassification(parsed)) meta.classification = parsed;
          // A malformed classification line is NOT stored — the run falls
          // back to the legacy top-level autonomous line (see markdownCtoState).
        } catch {
          // unparseable JSON — same legacy fallback
        }
        continue;
      }
      const match = line.match(STATE_META_LINE);
      if (!match) continue;
      const key = match[1]?.toLowerCase();
      const value = (match[2] ?? "").replace(/^`|`$/g, "").trim();
      if (key === "autonomous" && meta.autonomous === undefined) {
        if (value.toLowerCase() === "true") meta.autonomous = true;
        else if (value.toLowerCase() === "false") meta.autonomous = false;
      } else if (key === "session" && meta.session === undefined) {
        meta.session = value || undefined;
      } else if (key === "standby" && meta.standby === undefined) {
        if (value.toLowerCase() === "true") meta.standby = true;
        else if (value.toLowerCase() === "false") meta.standby = false;
      }
    }
  }
  return meta;
}

/**
 * Build a minimal CtoState from the agent-written markdown files, so the
 * amend prompt can render run context without a state.json (br-5ql).
 * The model-first classification is read from the persisted
 * `classification: { ... }` line (authority for autonomy); the top-level
 * `autonomous:` line is legacy read-compat used only when no classification
 * is present. Session ownership is restored from the `session:` line;
 * absent metadata defaults to non-autonomous, unowned — matching legacy
 * agent-written runs.
 */
function markdownCtoState(runId: string, runDir: string): CtoState | null {
  const files = markdownFiles(runDir);
  // Active evidence: any CTO state file. cto_discovery.md alone means the run
  // started (often parked at a confirm_understanding checkpoint) — still active.
  if (!files.some((name) => ["team-plan.md", "decisions.md", "cto_discovery.md"].includes(name))) return null;
  if (files.some((name) => FINISH_MARKERS.includes(name))) return null;

  const meta = readStateMeta(runDir, files);

  let task = runId;
  for (const name of ["cto_discovery.md", "team-plan.md"]) {
    if (!files.includes(name)) continue;
    try {
      const first = readFileSync(join(runDir, name), "utf8").split("\n").find((l) => l.startsWith("# "));
      if (first) {
        task = first.replace(/^#\s+/, "").trim();
        break;
      }
    } catch {
      // unreadable — keep runId
    }
  }

  const teams: CtoState["teams"] = [];
  try {
    const planPath = join(runDir, "team-plan.md");
    if (existsSync(planPath)) {
      for (const line of readFileSync(planPath, "utf8").split("\n")) {
        const match = line.match(TEAM_LINE);
        if (match?.[1] && !teams.some((t) => t.id === match[1])) {
          teams.push({ id: match[1], status: "in_progress", escalations: {} });
        }
      }
    }
  } catch {
    // best-effort
  }

  const updatedAt = newestMtime(runDir, files);
  return {
    schema: 2,
    id: runId,
    task,
    branch: "",
    // Model-first: a present classification is the authority; the top-level
    // field mirrors it for legacy readers. Without a classification the
    // legacy `autonomous:` line applies; absent both -> non-autonomous
    // (legacy agent-written runs, status quo).
    ...(meta.classification ? { classification: meta.classification } : {}),
    autonomous: resolveCtoAutonomous({ classification: meta.classification, autonomous: meta.autonomous ?? false }),
    ...(meta.session ? { owner_session: meta.session } : {}),
    ...(meta.standby === true ? { standby: true } : {}),
    plan: { id: runId, task, teams: [], created_at: updatedAt },
    teams,
    integration: { status: "pending" },
    pause: { kind: "none", reason: "markdown state (agent-written, no state.json)" },
    updated_at: updatedAt,
  };
}

/**
 * Find the single active CTO run — state.json first (engine-written), then
 * a markdown fallback for agent-written runs (br-5ql). A run is finished
 * when its pause is done/failed, or all teams done plus integration done,
 * or (markdown) when a summary or integration-review marker exists.
 *
 * Session ownership (RC4): when a `sessionId` is provided, interactive task
 * runs that declare a DIFFERENT owner are skipped — a foreign session gets
 * a fresh contract instead of amending another session's run. Standby runs
 * (`standby: true`) remain adoptable cross-session so inbox continuity is
 * preserved, and unowned/legacy runs stay amendable (status quo).
 * Returns the latest by updated_at among the eligible runs.
 * The amend protocol (br-k19): a second `/cto` while a run is active folds
 * the new task into THAT run instead of starting a fresh orchestrator.
 */
export function findActiveCtoRun(
  cwd: string,
  opts: { sessionId?: string } = {},
): { runId: string; state: CtoState } | null {
  const runsDir = join(cwd, ".work-state", "cto");
  if (!existsSync(runsDir)) return null;
  let best: { runId: string; state: CtoState } | null = null;
  let bestAt = "";
  for (const runId of readdirSync(runsDir)) {
    const runDir = ctoStateDir(runId, cwd);
    if (!existsSync(runDir)) continue;

    const state = readCtoState(runId, cwd);
    if (state) {
      if (isCtoRunTerminal(state)) continue;
      if (!isRunOwnedBySession(state, opts.sessionId)) continue;
      if (!best || state.updated_at > bestAt) {
        best = { runId, state };
        bestAt = state.updated_at;
      }
      continue;
    }

    const mdState = markdownCtoState(runId, runDir);
    if (mdState) {
      if (isCtoRunTerminal(mdState)) continue;
      if (!isRunOwnedBySession(mdState, opts.sessionId)) continue;
      if (!best || mdState.updated_at > bestAt) {
        best = { runId, state: mdState };
        bestAt = mdState.updated_at;
      }
    }
  }
  return best;
}

/**
 * Ownership gate for amend/continuation: standby runs are adoptable by any
 * session; a run declaring a foreign `owner_session` is only eligible for
 * its owner; unowned runs stay eligible (legacy agent-written/engine runs).
 */
function isRunOwnedBySession(state: CtoState, sessionId: string | undefined): boolean {
  if (state.standby === true) return true;
  if (sessionId && state.owner_session && state.owner_session !== sessionId) return false;
  return true;
}

/**
 * Amend contract: returned by `/cto` when a run is already active. The new
 * task is folded into the same run by the SAME orchestrator (single CTO).
 */
export function buildAmendPrompt(
  envelope: ParsedCtoEnvelope,
  cwd: string,
  active: { runId: string; state: CtoState },
  opts: CtoPromptOptions = {},
): string {
  const teamsLine = active.state.teams.map((t) => `${t.id}:${t.status}`).join(", ");
  const issueMeta = envelope.issue ? `Issue: #${envelope.issue}\n` : "";
  const sessionMeta = opts.sessionId ? `Session: \`${opts.sessionId}\` (state field: \`owner_session\`)\n` : "";

  return [
    "/cto AMEND — a new task arrived while a CTO run is ACTIVE.",
    "",
    "### Active run",
    `Run: \`${active.runId}\` (started ${active.state.plan.created_at})`,
    `Teams: ${teamsLine}`,
    `Pause: ${active.state.pause.kind} — ${active.state.pause.reason || "no reason"}`,
    `State: \`.work-state/cto/${active.runId}/\` (state.json when engine-written, markdown otherwise) — read it BEFORE touching anything.`,
    "",
    "### New task (fold into the SAME run)",
    issueMeta + sessionMeta,
    envelope.task,
    "",
    buildClassificationPhaseZero({ label: "leading directive", value: envelope.autonomyHint }),
    "",
    buildWorkflowMatrix(),
    "",
    "### Persist the classification",
    "Record your PHASE-0 classification for the new task in the run state as the STRUCTURED model",
    "decision: `classification: { \"type\": ..., \"complexity\": ..., \"confidence\": ...,",
    "\"autonomous\": <true|false>, \"autonomous_reason\": ... }` on ONE line in the run state files.",
    "`classification.autonomous` is the AUTHORITY — the legacy top-level `autonomous: <true|false>`",
    "line is read-compat only and never overrides a present classification. The persisted `autonomous`",
    "value is YOUR model decision — never the mechanical hint.",
    "",
    persistenceContract(opts),
    "### You are still the CTO (single orchestrator, this session)",
    "You are the MAIN AGENT — the resident CTO. Do NOT start a second run or orchestrator.",
    "Do NOT spawn a sub-CTO: NEVER `task(agent=cto)` / `task(agent=@cto)` (main-session only, no",
    "nested form). Continue the same run in-session.",
    "",
    "### Amend rules",
    "1. **Re-plan**: add teams from the registry (`.omp/teams.json`) for the new task — total teams across the",
    "   run <= 8, depth <= 2. New leads spawn in PARALLEL with active teams; existing teams keep working.",
    "   Choose sub-profiles from the Workflow resolution matrix above — the SAME table as /do-work (resolveWorkflow).",
    "2. **Architecture**: if the new task adds cross-team surface, run the architect for the ADDITIONAL",
    "   contract (or extend the existing architecture artifact); new leads consume it.",
    "3. **Persist**: append the new teams to \`state.json\` and stamp \`amended_at\`; document the amend in",
    "   \`decisions.md\` (why). Keep the metadata lines from the persistence contract above.",
    "4. **Integration covers ALL teams** (original + added): integration review verifies the merged result",
    "   against the (extended) contract; DoD aggregation across every team.",
    "5. **Edge cases**: run at max teams -> write the task to \`.work-state/queue.json\` for the next run;",
    "   run already in the integration phase -> same (queue it); scope overlap with an active team -> extend",
    "   that team's slice (re-spawn its lead with an additional worker task) instead of adding a team.",
    "6. **Escalations** of the new teams use the same ladder (worker -> lead -> you -> user); you never spawn",
    "   a second orchestrator.",
    "7. **Inbox check**: read \`.work-state/cto/`+runId+`/inbox/*.json\` for tasks that arrived while",
    "   no session was listening; fold each in as its own wave.",
    "",
    renderChannelSection(cwd),
    "",
    "### After the wave",
    "When the amended wave integrates, close ONLY that wave and keep the resident CTO run active.",
    "Return to standby — stay on-line, yield, and await the next `[CTO-INBOX]` task to fold in.",
    "",
    "Begin: read the active state, amend the plan, spawn the new leads.",
  ].join("\n");
}

/**
 * CommandContext-style entry (legacy command surface, mirrors `teamCommand`).
 * Returns the CTO prompt; the caller feeds it to the main agent.
 * Empty args start CTO STANDBY (no task — tasks arrive via the messenger
 * inbox / [CTO-INBOX] wake).
 */
export function ctoCommand(ctx: CommandContext): string {
  const raw = ctx.args.trim();
  if (!raw) {
    ctx.ui.notify("cto: standby mode — awaiting tasks via messenger inbox", "info");
    return buildStandbyCtoPrompt(ctx.cwd);
  }
  const envelope = parseEnvelope(raw, ctx.cwd);
  if (!envelope.task) return "ERROR: empty task after stripping prefix.";
  const active = findActiveCtoRun(ctx.cwd, { sessionId: ctx.sessionId });
  if (active) {
    ctx.ui.notify(`cto: amending run ${active.runId} with: ${envelope.task.slice(0, 50)}`, "info");
    return buildAmendPrompt(envelope, ctx.cwd, active, { sessionId: ctx.sessionId });
  }
  ctx.ui.notify(`cto: ${envelope.task.slice(0, 60)} (decomposition pending)`, "info");
  return buildCtoPrompt(envelope, ctx.cwd, { sessionId: ctx.sessionId });
}
