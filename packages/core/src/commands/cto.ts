/**
 * /cto — CTO sub-orchestration command (core contract).
 *
 * Part of the CTO/Head mode: the CTO agent receives a task, decomposes it
 * into a TeamPlan (up to 8 teams, depth 2), each team runs a sub-workflow
 * profile with its own lead + roster, escalations to the user are
 * asynchronous through an EscalationAdapter, and work continues while the
 * user answers.
 *
 * The registered command adapter acquires the exact CTO claim before rendering
 * one of these prompts. This module contains only parsing and prompt builders;
 * it has no exported prompt-only CommandContext entry point.
 *
 * Design: vibe-report/sub-orchestration-2026-08-04.md
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { findProfileDir } from "../engine/profile.js";
import { loadTeamDefs } from "../cto/plan.js";
import { resolveChannelProfile } from "../cto/channels.js";
import { isCtoRunTerminal, readCtoState, resolveCtoAutonomous, ctoStateDir } from "../cto/state.js";
import { MAX_DECOMPOSITION_DEPTH, MAX_TEAMS, type CtoState } from "../cto/types.js";
import type { ModelClassification } from "../engine/run.js";
import { parseAutonomousDirective } from "./envelope.js";
import { buildClassificationPhaseZero, buildWorkflowMatrix } from "./classification-contract.js";
import { DETACHED_BRANCH, NO_GIT_BRANCH, resolveActiveBranch } from "../engine/state.js";

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

export interface ParsedCtoCommand {
  ok: true;
  task: string;
  run_id?: string;
  recover_legacy?: boolean;
}

export interface ParsedCtoCommandFailure {
  ok: false;
  code: "lifecycle_request_conflict";
  error: string;
}

export type CtoCommandParseResult = ParsedCtoCommand | ParsedCtoCommandFailure;

/** Parse `/cto` options without interpreting flags after the `--` terminator. */

export function parseCtoCommand(args: string): CtoCommandParseResult {
  const tokens = [...args.matchAll(/\S+/g)].map((match) => ({ value: match[0]!, start: match.index! }));
  let parsingOptions = true;
  let runId: string | undefined;
  let runSelectorCount = 0;
  let recoverLegacy = false;
  let recoverLegacyCount = 0;
  let task = "";
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (!parsingOptions) {
      task = args.slice(token.start).trim();
      break;
    }
    if (token.value === "--") {
      parsingOptions = false;
      const next = tokens[index + 1];
      task = next ? args.slice(next.start).trim() : "";
      break;
    }
    if (!token.value.startsWith("--")) {
      parsingOptions = false;
      task = args.slice(token.start).trim();
      break;
    }
    if (token.value === "--recover-legacy") {
      recoverLegacyCount += 1;
      if (recoverLegacyCount > 1) {
        return { ok: false, code: "lifecycle_request_conflict", error: "duplicate --recover-legacy selectors are ambiguous" };
      }
      recoverLegacy = true;
      if (runSelectorCount > 1) {
        return { ok: false, code: "lifecycle_request_conflict", error: "duplicate --run selectors are ambiguous for legacy recovery" };
      }
      continue;
    }
    if (token.value === "--run") {
      const next = tokens[index + 1]?.value;
      if (!next || next === "--" || next.startsWith("--")) {
        return { ok: false, code: "lifecycle_request_conflict", error: "--run requires an exact CTO run id" };
      }
      if (!/^[A-Za-z0-9._-]+$/.test(next) || next === "." || next === "..") {
        return { ok: false, code: "lifecycle_request_conflict", error: `invalid exact CTO run id '${next}'` };
      }
      runSelectorCount += 1;
      if (recoverLegacy && runSelectorCount > 1) {
        return { ok: false, code: "lifecycle_request_conflict", error: "duplicate --run selectors are ambiguous for legacy recovery" };
      }
      runId = next;
      index += 1;
      continue;
    }
    if (token.value.startsWith("--run=")) {
      const value = token.value.slice("--run=".length).trim();
      if (!value) return { ok: false, code: "lifecycle_request_conflict", error: "--run requires an exact CTO run id" };
      if (!/^[A-Za-z0-9._-]+$/.test(value) || value === "." || value === "..") {
        return { ok: false, code: "lifecycle_request_conflict", error: `invalid exact CTO run id '${value}'` };
      }
      runSelectorCount += 1;
      if (recoverLegacy && runSelectorCount > 1) {
        return { ok: false, code: "lifecycle_request_conflict", error: "duplicate --run selectors are ambiguous for legacy recovery" };
      }
      runId = value;
      continue;
    }
    return { ok: false, code: "lifecycle_request_conflict", error: `unknown CTO option '${token.value}'` };
  }
  if (recoverLegacy && !runId) {
    return { ok: false, code: "lifecycle_request_conflict", error: "--recover-legacy requires an exact --run selector" };
  }
  return { ok: true, task, ...(runId ? { run_id: runId } : {}), ...(recoverLegacy ? { recover_legacy: true } : {}) };
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

  const activeBranch = resolveActiveBranch(cwd);
  const branch = activeBranch === NO_GIT_BRANCH || activeBranch === DETACHED_BRANCH ? null : activeBranch;
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

function residentNativeRouteContract(): string {
  return [
    "The resident CTO is the main session's authenticated native dispatcher. Use this exact route:",
    "`cto_state(read exact run) → cto_state(commit active wave/classification/workflow/DoD) → task(configured TeamDef.lead with exact CTO slice marker) → stage-aware lead execution: on a lead-owned orchestrator stage, publish only the lead's declared outputs and report the accepted receipt/root checkpoint-and-advance request → resident root performs the authorized cto_stage_advance and supplies the current canonical worker-stage handoff → lead dispatches only that stage's declared worker slots to agents resolved from TeamDef.roster, repeating the exact marker and inherited native authority → each assigned producer submits only its declared outputs through workflow_submit_result({ \"outputs\": { ... } }) → engine receipts/immutable fan-in → lead validation/DoD and applicable worker-terminal checks → resident root checkpoint decision (`policy_auto` or cto_checkpoint_ask) → resident root cto_stage_advance({ \"slice_id\": \"<sliceId>\" }) → engine/native state progress or wave closure`.",
    "The CTO root and its leads MUST NOT call ordinary `workflow_prepare`, `workflow_status`, `workflow_instructions`, `workflow_begin`, or `workflow_advance` with the CTO slug. A CTO `id`/slice marker is not an ordinary workflow UUID or selector; native stage transition uses only registered `cto_stage_advance({ \"slice_id\": \"<sliceId>\" })`, which derives current scope and rejects ordinary tokens or candidate progress injection. Native CTO state, namespace, lifecycle, receipts, and recovery remain independent.",
    "Roles are fixed by ownership: the resident main session is the CTO and canonical-state owner; each registry `TeamDef.lead` is the concrete lead agent for that team; that lead may spawn only agents resolved from its `TeamDef.roster` roles through the effective configuration; workers implement source changes and never re-delegate. Native admission checks the actual task agent against this configured route, not a task display name or hardcoded lead alias; never substitute a `cto` child.",
    "The resolved sub-workflow profile remains a quality contract for the native slice: preserve its stages, complete artifact schemas, code-review/validation obligations, checkpoints, fan-in, and DoD evidence, but satisfy them through the native lead/roster handoff and native state rather than an ordinary selector bridge.",
    "Every assigned producer publishes only its own profile-declared outputs through `workflow_submit_result` with exactly `{ \"outputs\": { ... } }`. The trusted native engine derives run/wave/slice/stage/slot identity, validates schemas and evidence references, persists immutable output references, returns a receipt, and performs fan-in. No producer hand-writes workflow JSON, canonical state, manifests, or canonical output paths, and no root/lead fabricates a worker result or copies authority fields.",
    "Only a configured native lead may publish its own profile-declared `orchestrator` assignment; the resident CTO root never impersonates a lead or worker. A consumer tool such as `lecture_acquire` remains a main-session callback and publishes its declared acquisition output through the trusted engine API as `tool`; it never impersonates a worker. CTO root progress belongs in `cto_state`, not in worker submission scope.",
    "Each lead task carries the exact `<!-- omp-cto-slice run=<runId> slice=<sliceId> -->` marker; every roster-worker task repeats it verbatim. A receipt is separate from worker terminal lifecycle, stage readiness, full fan-in, DoD, and approval. The resident CTO verifies trusted receipts and attested worker terminal results only where worker lifecycle applies; orchestrator/tool/document completion comes from its trusted result/callback or engine rendering. Missing or malformed applicable evidence blocks the wave.",
    "Before every native lead dispatch, the CTO MUST pass the exact scope, active wave, current stage/checkpoint, and a safe relative supplemental-evidence directory whose path is unique to (and contains) the exact run id, wave id, and slice id. This directory is for validation/coordination evidence only; it is not a replacement for engine publication, a worker identity, or a canonical stage-output path. Do not derive it from `scope_map`, replace custom scope mappings, or fall back to one shared `.work-state/artifacts/<team>` directory.",
    "Mutable task deliverables (source changes and the configured `teams[].dod_path`) remain separate from native workflow receipts and wave-scoped evidence. Preserve profile-declared output IDs and slot provenance through the engine; never add run/wave/slice prefixes, wrappers, copied paths, or renamed payloads. Historical receipts and evidence remain immutable when a new wave or rework starts.",
    "For every profile stage with a `before_advance` checkpoint, after worker producers have accepted submissions and matching worker terminal outcomes exist where worker lifecycle applies, and after orchestrator/tool/document producers have their trusted result/callback or engine-rendered completion (they have no worker terminal to wait for), the trusted engine evaluates the resolved checkpoint policy. If the current non-hard-human rule and autonomy eligibility permit `policy_auto`, the engine records that exact decision/evidence and the resident root calls `cto_stage_advance({ \"slice_id\": \"<sliceId>\" })`. If the profile requires an actual human (`required_human` or hard-human), the resident root calls the registered `cto_checkpoint_ask({ \"slice_id\": \"<sliceId>\" })` control surface, then calls `cto_stage_advance` after the trusted human decision; the tools derive active run/profile checkpoint/current-result scope and reject ordinary tokens or candidate progress injection. The resident CTO must not write approval/state evidence by hand or substitute a receipt, terminal, DoD, or prose. Only unresolved or root-intervention outcomes send a compact handoff through the existing lead-to-CTO channel.",
    "For a stopped boundary or recovery case, a live/unknown worker or unavailable transport means observe/reconcile/wait through supported host capabilities; it is never a generic timeout/error→replacement trigger. Replacement is permitted only after an attested terminal failure/cancel or attested preflight-not-started result and an authorized bounded recovery. Do not invent reconnect/resume support, create a second writer, or redispatch merely because a handoff/answer is late.",
    "A slice DoD is a supplemental ordinary file, not canonical CTO state: write/read the exact `teams[].dod_path` through the permitted artifact tools. The default file form is `.work-state/artifacts/<team>/dod.json` relative to the workspace root (or the exact configured relative `dod_path`); it must contain non-empty typed `items`. Never write `.work-state/cto/<id>/state.json` by hand, never submit the supplemental sidecar as an undeclared workflow output, and never guess or relocate the DoD path. If the current profile stage explicitly declares `dod` in produces, its assigned producer submits that typed logical output through workflow_submit_result independently of the supplemental sidecar.",
  ].join("\n");
}

function ctoPlanShapeContract(): string {
  return [
    "### Valid TeamPlan and runtime state shapes (do not interchange them)",
    "The registry row is a `TeamDef` (`id`, `name`, `scope`, `profile`, `lead`, `roster`) and is lookup input only.",
    "A `state.plan.teams[]` entry is a `TeamPlanEntry`, for example:",
    "```json",
    "{\"team\":\"frontend\",\"scope\":[\"frontend\"],\"slice\":\"Bounded frontend slice\",\"profile\":\"lightweight\",\"worktree\":\"same_branch\",\"depends_on\":[]}",
    "```",
    "A runtime `state.teams[]` entry is separate, for example:",
    "```json",
    "{\"id\":\"frontend\",\"status\":\"pending\",\"escalations\":{},\"slice_id\":\"frontend-slice\",\"workflow\":\"lightweight\",\"dod_path\":\".work-state/artifacts/frontend/dod.json\"}",
    "```",
    "Do not put TeamDef fields (`name`, `lead`, `roster`) into a TeamPlanEntry or use a TeamPlanEntry as a runtime team record; preserve all engine-owned fields returned by `cto_state(read)`.",
    "For each active slice, bind exactly one runtime team to exactly one plan entry and registered definition: `state.teams[].id === state.plan.teams[].team === TeamDef.id`. A work-specific or new-wave identifier belongs in `slice_id`, not an invented team id. Reuse a completed configured team's current binding for a new wave; never duplicate its plan id, overwrite an unfinished binding, or rewrite unrelated historical rows/evidence to satisfy admission.",
  ].join("\n");
}

/**
 * Render the user-communication channel section. Drives off the single
 * resolved channel profile (cto/channels.ts — architecture-4), which
 * normalizes both legacy {adapter,bidirectional,http,telegram} and explicit
 * `channels[]` configs:
 * - direction "rw" (validated inbound + outbound): messenger mode — ALL user
 *   questions go through the outbox (outbox -> answers/), the `ask` tool is
 *   blocked.
 * - direction "ro" (push-only sink): report-only — `ask` stays available for
 *   interactive checkpoints.
 * - direction "none": use `ask`.
 */
export function renderChannelSection(cwd: string): string {
  const profile = resolveChannelProfile(cwd);
  if (profile.direction === "rw") {
    const ack = profile.ackTarget ? `, ack target \`${profile.ackTarget}\`` : "";
    const primary = profile.primary ? ", primary" : "";
    return [
      "### User channel (messenger, BIDIRECTIONAL) — VALIDATED RW-PRIMARY",
      `Resolved channel profile: direction \`rw\` (transport ${profile.transport ?? "unknown"}, adapter ${profile.adapter ?? "unknown"}${ack}${primary}) —`,
      "validated inbound + outbound. Messenger mode: ALL user communication goes through it:",
      "- Checkpoints and any question: write the escalation to `.work-state/cto/<id>/outbox/<escId>.json`",
      "  (level `question`/`decision`, `timeoutMs` + `default`); answers arrive in `answers/<escId>.json`.",
      "- Inbound tasks/answers arrive via this channel — `[CTO-INBOX]` messages are USER COMMANDS.",
      "- NEVER use the `ask` tool — it is blocked while this channel is active.",
      "- Blocking waits park the team (`background_wait`); everything else continues.",
      "- In standby: tasks arrive as `[CTO-INBOX]` messages — apply the terminal-request precedence in the lifecycle contract first; only ordinary tasks are folded into the run (amend discipline) and followed by return to standby.",
    ].join("\n");
  }
  if (profile.direction === "ro") {
    const adapter = profile.adapter ?? "unknown";
    const firstLine =
      adapter === "http"
        ? "An HTTP channel is configured but it is PUSH-ONLY (no feedback path)."
        : `A report-only channel is configured (adapter ${adapter}) — PUSH-ONLY (no feedback path).`;
    return [
      "### User channel (push-only) — RO-REPORT",
      firstLine,
      "Capability mode RO-REPORT: the channel is a push-only report sink — escalations are advisory and",
      "NEVER inbound; `ask` stays available for interactive checkpoints.",
      "Use `ask` for interactive checkpoints; escalations sent over the channel are advisory.",
    ].join("\n");
  }
  return [
    "### User channel (none) — TERMINAL-ONLY",
    "No escalation channel configured (capability mode TERMINAL-ONLY, direction `none`): no channel exists.",
    "Use the `ask` tool for checkpoints (local ask fallback).",
  ].join("\n");
}

/**
 * Build the CTO resident-wait prompt. In `bootstrap` mode the run has no
 * task yet; in `closed-wave` mode it retains the canonical task,
 * classification, and completed wave while waiting for a new inbox task. The
 * run stays active so inbox routing, amend detection, and the per-turn
 * reminder all key off the exact acquired run.
 */
export function buildStandbyCtoPrompt(cwd: string, opts: CtoPromptOptions = {}): string {
  const closedWave = opts.standbyMode === "closed-wave";
  const runLine = opts.runId
    ? `The registered ingress already acquired run \`${opts.runId}\`; use this exact id and never scan for or create another run.`
    : "The registered ingress already acquired the exact run id; use that id and never scan for or create another run.";
  const taskContext = closedWave
    ? [
      "   This resident run already has a canonical task and a successfully closed wave. Preserve its exact task,",
      "   classification, wave history, completed artifacts, owner fields, and run identity. Do not reset it to the",
      "   no-task bootstrap, reclassify the completed wave, repeat completed work, or start a new wave until a new",
      "   inbox task arrives.",
    ]
    : [
      "   This `autonomous: true` is ENGINE-CREATED — standby has NO user task, so there is nothing to",
      "   classify. The standby state therefore carries NO `classification` field (model-first: a",
      "   classification exists only when a task was classified). It is not a PHASE-0 decision; on wake, first",
      "   apply terminal-request precedence: an unmistakable explicit request to end this resident run itself",
      "   follows the terminal branch and is not classified, amended, spawned, or started as a new wave. Every",
      "   other inbox task is classified by YOU (type, complexity, confidence, autonomous) on wake, exactly",
      "   like a `/cto <task>` invocation.",
    ];
  return [
    closedWave
      ? "/cto RESIDENT WAIT — the previous CTO wave is closed and this run awaits the next task. Execute this contract YOURSELF, in this session."
      : "/cto STANDBY — CTO sub-orchestration is ON with NO task yet. Execute this contract YOURSELF, in this session.",
    "",
    closedWave ? "### You are the CTO (resident, awaiting the next task)" : "### You are the CTO (standby)",
    "You ARE the orchestrator — and you are THE MAIN AGENT of this session, the resident CTO.",
    "Do NOT invent work while waiting. Do NOT delegate the orchestrator role.",
    "The CTO is never spawned: NEVER run `task(agent=cto)` or `task(agent=@cto)` — not mechanically,",
    "not by text. `/cto` executes in-session; this session IS the CTO.",
    "",
    closedWave ? "### Resident wait steps" : "### Standby steps",
    `1. **${closedWave ? "Continue the pre-acquired resident run after its closed wave NOW" : "Continue the pre-acquired standby run NOW"}**: ${runLine}`,
    "   Read the canonical state through the registered `cto_state` tool with `operation: \"read\"` and",
    "   the exact run id; read only this run's `inbox/` directory and answer artifacts directly. The state",
    "   and claim were published atomically before this prompt; do not write a second state directory or",
    "   re-derive ownership from task text. If the exact state is unavailable, stop and report the typed",
    "   lifecycle error.",
    "   The run must exist before waiting: inbox routing, amend detection and the per-turn reminder all",
    "   key off its exact state.",
    ...taskContext,
    "2. On every wake, read the exact run state with `cto_state(operation: \"read\", run_id: <exact-run-id>)`.",
    "   Read this run's `answers/*.json` and escalation records directly from its namespace before applying retry rules.",
    "   A dispatcher-created `.omp/inbox/answer-retry-<sanitized-id>-<sanitized-epoch>.json` marker authorizes one retry only",
    "   when its canonical answer artifact has `delivery_status: \"pre-send-rejected\"` plus matching",
    "   `delivery_run_id`, `delivery_ownership_epoch`, and `delivery_session_id`; the canonical status alone",
    "   is never replay authority. `unknown/in-flight/legacy/accepted` answer artifacts remain advisory/recovery —",
    "   never blind replay them.",
    "3. Read `.omp/teams.json` + `cto.json` profile now (not later) so the wake turn is cheap.",
    "4. Drain the exact run's pending inbox before yielding, then yield and WAIT.",
    "### Tasks arrive two ways",
    "- A `[CTO-INBOX]` user message (injected by the messenger dispatcher), or",
    "- files in `.work-state/cto/<id>/inbox/*.json` ({ id, text, at, by }).",
    "`[CTO-INBOX]` messages ARE USER COMMANDS — direct instructions to you, the main-session CTO:",
    "first apply the terminal-request precedence above; only otherwise treat the payload as a `/cto <task>` command",
    "and fold it into THIS run (amend discipline: re-plan, spawn leads in parallel, integration covers",
    "ALL teams). Multiple ordinary tasks = multiple sequential waves; do not merge them into one team.",
    "A terminal request is not a classification, amend, lead-dispatch, or new-wave trigger; apply the shared",
    "lifecycle termination contract instead.",
    residentNativeRouteContract(),
    "",
    "",
    "### After each wave",
    "Stay on-line when a wave completes — you remain the CTO of this session. Close the wave",
    "(integration + summary), keep the run active, and return to standby: yield and wait for the",
    "next `[CTO-INBOX]` task (or `inbox/` file) to fold in, unless the user explicitly requests ending",
    "the resident run itself; that request follows the terminal branch, not a new wave.",
    "**The run id NEVER changes across follow-up waves.** Every ordinary inbox task is a NEW wave in the SAME",
    "canonical state. An explicit terminal request is not a wave; follow the lifecycle termination contract",
    "instead. Read the exact state with `cto_state(operation: \"read\")`, then commit the",
    "updated `wave_history`, `active_wave_id`, per-slice classification, workflow, and DoD metadata",
    "with `cto_state(operation: \"commit\", expected_state_revision: <revision>, state: <candidate>)`.",
    "Never use Write, Edit, or Bash for canonical CTO state. Close the wave (status `done`|`failed` +",
    "`finished_at`, clear `active_wave_id`) through the same revision-checked commit BEFORE standby resumes.",
    "",
    "### Your rules (abridged)",
    "- Delegate, never code. Teams: pick from the registry, one configured lead per team; leads spawn only workers resolved from that TeamDef.roster.",
    "- Assigned leads/workers publish only their profile-declared outputs with `workflow_submit_result({ \"outputs\": { ... } })`; the native engine validates schemas, returns immutable receipts, and performs fan-in. Never copy worker authority, canonical paths, or receipt fields into `cto_state`.",
    "- Worker submission receipts, worker terminal lifecycle, stage readiness, DoD, and human approval are separate conditions. A lead/CTO cannot fabricate a missing producer result or treat a text summary as terminal/approval.",
    "- Escalation ladder: worker -> configured lead -> resident CTO -> user. Generic exit/timeout/SDK error, missing response, `Still Running`, or transport loss is not terminal: call supported recovery diagnosis/reconciliation, observe/wait, and keep the same native assignment.",
    "- A replacement is legal only after host-attested terminal failure/cancel or attested preflight-not-started plus authorized bounded native recovery. Reuse the configured lead→roster route; never dispatch a worker directly from the resident CTO, invent reconnect support, or replace a live/unknown worker.",
    "",
    renderChannelSection(cwd),
    persistenceContract(opts, false),
    "",
    closedWave
      ? "Begin: use `cto_state(operation: \"read\")` for the pre-acquired resident run, preserve its closed wave, and wait for the next inbox task."
      : "Begin: use `cto_state(operation: \"read\")` for the pre-acquired standby run, read the registry, yield.",
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
  /** Exact canonical CTO id acquired before this prompt was sent. */
  runId?: string;
  /**
   * Resident prompt mode. `bootstrap` is the engine-created no-task inbox
   * run; `closed-wave` preserves the completed task and waits for a new one.
   */
  standbyMode?: "bootstrap" | "closed-wave";
}

/** Persistence and lifecycle contract shared by the CTO standby/task/amend prompts. */
function persistenceContract(opts: CtoPromptOptions, includeClassification = true): string {
  const sessionLine = opts.sessionId ? `\`session: ${opts.sessionId}\``
    : "`session: <your current omp session id>`";
  const runLine = opts.runId
    ? `\`id: ${opts.runId}\` — this exact pre-acquired id is authoritative; never create another CTO run`
    : "`id: <the exact canonical CTO id acquired by the registered /cto ingress>`";
  const classificationLines = includeClassification
    ? [
      "The PHASE-0 classification is a structured state decision:",
      "`classification: { \"type\": ..., \"complexity\": ..., \"confidence\": ..., \"autonomous\": <true|false>,",
      "\"autonomous_reason\": ... }`. `classification.autonomous` is the AUTHORITY; the legacy",
      "top-level `autonomous` line is read-compat only. The `autonomous` value is YOUR model decision,",
      "never the mechanical hint.",
    ]
    : [];
  return [
    "### State persistence (mandatory)",
    "The registered `/cto` ingress has already acquired and published the minimal canonical state and",
    "claim before this prompt. Continue in that exact namespace; do not search for a latest run or create",
    "a second state directory.",
    "Keep `cto_discovery.md`, `team-plan.md`, and `decisions.md` as supplemental artifacts, but mutate",
    "canonical CTO state only through the registered `cto_state` tool: read the exact run first, then",
    "commit the full schema-2 candidate with the exact `state_revision` returned by read. Never use",
    "Write, Edit, or Bash on `.work-state/cto/<id>/state.json`.",
    ...classificationLines,
    "Keep exact run identity fields unchanged; the rendered session label is caller context only:",
    runLine,
    sessionLine,
    "`session` identifies the current caller only; never use it to replace the engine-owned `owner_session`. Preserve the freshly read `owner_session` exactly, including when a standby wake is handled from another session.",
    "### Resident lifecycle",
    "Before any standby wake, inbox, or amend task is routed, check for an unmistakable user request to end this resident run itself. Such a request takes precedence over normal task classification/new-wave routing: do not classify, amend, spawn leads, or start a wave for it. This does not include a completed wave, incidental `done` wording, or ordinary wave-close instructions. Settle genuine pending work first, then follow the terminal branch below.",
    "For a resident run, normal wave completion closes only the wave: settle integration, mark the wave",
    "`done`|`failed` with `finished_at`, clear `active_wave_id`, keep the run active in standby, and wait for the next task.",
    "Registered task-backed `/cto` runs carry the same resident marker as the no-task standby bootstrap; all-teams-done plus integration-done closes their wave, not the run.",
    "Wave closure is not run termination, and `pause.kind: \"none\"` remains nonterminal. A same-run continuation appends a new wave and dispatches only its new or still-unmet slices; completed-wave teams and artifacts are not repeated.",
    "Only an explicit user request to end the resident run may terminate it. First settle all genuine",
    "pending work (including workers, reservations, and barriers); never bypass guards or fabricate",
    "completion. Then read the exact run fresh, commit the full schema-2 candidate with the read's",
    "`state_revision`, preserve engine-owned `id`/run identity, `owner_session` ownership, and the `standby` marker, and set",
    "`pause` exactly to `{ kind: \"done\", reason: <actual user-requested basis> }`.",
    "Never use `completed` as a terminal value. Inspect the actual commit result before announcing",
    "termination: only `ok: true` with `transition: \"terminal\"` and returned `state.pause.kind: \"done\"`",
    "proves success. A rejected or failed commit is not success; do not silently substitute `none`.",
    "After that successful terminal commit, use its receipt and returned terminal state; do not require",
    "an additional authenticated read after the claim is released.",
    "",
  ].join("\n");
}

/**
 * Build the exact-resume prompt for an already active task-backed run. This
 * path is deliberately separate from the new-task prompt: resuming work must
 * preserve the canonical task, classification, wave cursor, and recovery
 * context instead of creating a new PHASE-0 decision.
 */
export function buildCtoResumePrompt(
  cwd: string,
  active: { runId: string; state: CtoState },
  opts: CtoPromptOptions = {},
): string {
  const state = active.state;
  const teamStatuses = state.teams.map((team) => `${team.id}:${team.status}`).join(", ") || "(none)";
  const initialClassificationPending = state.classification === undefined
    && state.plan.teams.length === 0
    && state.teams.length === 0
    && (state.wave_history?.length ?? 0) === 0
    && state.active_wave_id === undefined
    && state.integration.status === "pending"
    && (state.pause?.kind ?? "none") === "none";
  const classificationInstruction = state.classification !== undefined
    ? "The run already has a persisted classification: preserve it exactly and do not create a replacement PHASE-0 decision."
    : initialClassificationPending
      ? "The task has no persisted run classification and no work has started: complete the one unfinished PHASE-0 classification for this exact canonical task, commit it, and then preserve it; do not classify the same task again."
      : "No run classification is persisted for this legacy/in-progress state. Preserve that absence and its existing autonomy/workflow/cursor context; do not invent a late PHASE-0 decision while finishing outstanding work.";
  const pauseKind = state.pause?.kind ?? "none";
  const pauseReason = state.pause?.reason || "no reason";
  return [
    "/cto RESUME — continue the exact active CTO run IN-SESSION; do not create or amend a run.",
    "",
    "### Exact active run",
    `Run: \`${active.runId}\` (already acquired; use this exact id)`,
    `Canonical task: ${state.task}`,
    `Active wave: ${state.active_wave_id ?? "(none recorded)"}`,
    `Integration: ${state.integration.status}`,
    `Teams: ${teamStatuses}`,
    `Pause: ${pauseKind} — ${pauseReason}`,
    "",
    "Read the exact canonical state with `cto_state(operation: \"read\", run_id: <exact-run-id>)` before",
    "any action. This is an exact resume, not a new `/cto <task>` and not an amend:",
    "preserve `task`, `classification`, `plan`, `wave_history`, `active_wave_id`, per-team statuses",
    "and cursors, control-plane fields, artifacts, owner fields, and run identity exactly as read.",
    classificationInstruction,
    "Do not replace the canonical task, repeat completed slices, or reset recovery context. Continue",
    "the active wave from its canonical cursor; if the run is blocked or failed, inspect its actual",
    "recovery context and use the existing escalation route.",
    "An unmistakable explicit request to end this resident run itself takes terminal precedence; it is",
    "not a classification, amend, dispatch, or new-wave trigger.",
    "",
    "When a new ordinary inbox task is actually present, apply the resident lifecycle contract and",
    "fold it into the same run as its own new wave only after reading the exact state again. Keep the",
    "same run id and do not redo completed-wave work.",
    residentNativeRouteContract(),
    "",
    renderChannelSection(cwd),
    persistenceContract(opts, false),
    "",
    "Begin: read the exact run, preserve its canonical task/classification/cursor, then continue the",
    "active or recovery path that the state proves; do not invent a fresh classification.",
  ].join("\n");
}

/**
 * Build the CTO workflow prompt the main agent will execute.
 */
export function buildCtoPrompt(envelope: ParsedCtoEnvelope, cwd: string, opts: CtoPromptOptions = {}): string {
  const profilePath = join(findProfileDir(), "cto.json");
  const profileSection = existsSync(profilePath)
    ? `Workflow profile: \`${profilePath}\` — read exactly this one file for the stage list, gates, checkpoints, produces/consumes.`
    : "Workflow profile: `cto.json` not shipped yet — do not invent stage outputs; use the trusted native profile contract and submit only declared producer values.";

  const issueMeta = envelope.issue ? `Issue: #${envelope.issue}\n` : "";
  const branchMeta = envelope.branch
    ? `Branch: \`${envelope.branch}\` (canonical session branch; persist this exact value)\n`
    : "Branch: (no git work tree; strict workflow transitions cannot start)\n";
  const sessionMeta = opts.sessionId ? `Session: \`${opts.sessionId}\`\n` : "";
  const runMeta = opts.runId ? `CTO run id: \`${opts.runId}\` (already claimed; use this exact id)\n` : "";
  const exactRunId = opts.runId ?? "<exact-run-id>";

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
    `Before any resume/amend dispatch, read the exact run with \`cto_state(operation: "read", run_id: "${exactRunId}")\`; read that run's \`answers/*.json\` and escalation records directly from its namespace.`,
    issueMeta + branchMeta + sessionMeta + runMeta,
    "",
    "### Exact-run reacquisition and answer delivery",
    `This prompt is authorized only for the exact claimed run \`${exactRunId}\`; never scan for a latest run or infer ownership from the task marker.`,
    `Before any resume/amend dispatch, use the registered \`cto_state(operation: "read", run_id: "${exactRunId}")\` route for canonical state; use only that exact run's scoped answer and escalation records, never a sibling-run or latest-run scan.`,
    "Only a dispatcher-created `.omp/inbox/answer-retry-*.json` marker, together with the exact answer artifact's",
    "`delivery_status: \"pre-send-rejected\"` and matching `delivery_run_id`, `delivery_ownership_epoch`,",
    "and `delivery_session_id`, authorizes exactly one retry under the current claim. Canonical status",
    "alone is not replay authority. `unknown/in-flight/legacy/accepted` answer artifacts remain advisory/recovery;",
    "never blind replay them. Transport-only answer markers do not authorize a retry.",
    "",
    "",
    buildClassificationPhaseZero({ label: "leading directive", value: envelope.autonomyHint }),
    "",
    buildWorkflowMatrix(),
    "",
    "### Persist the classification",
    "Read the exact run with `cto_state(operation: \"read\")`, merge your PHASE-0 classification into the",
    "candidate CtoState, and commit it with the returned `state_revision`. Do not write canonical state",
    "with Write, Edit, or Bash. The structured decision is:",
    "`classification: { \"type\": ..., \"complexity\": ..., \"confidence\": ..., \"autonomous\": <true|false>,",
    "\"autonomous_reason\": ... }`. `classification.autonomous` is the AUTHORITY — the legacy",
    "top-level `autonomous: <true|false>` line is read-compat only and never overrides a present",
    "classification. The persisted `autonomous` value is YOUR model decision — never the mechanical hint.",
    "Persist the exact canonical `branch` value from Metadata; do not infer or replace it.",
    persistenceContract(opts),
    residentNativeRouteContract(),
    ctoPlanShapeContract(),
    "",
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
    "   Plan artifacts belong in the run's artifact namespace; canonical CTO state lives only in the",
    "   engine-owned `.work-state/cto/<id>/state.json` and MUST be mutated through `cto_state`.",
    "   Call `cto_state(operation: \"read\", run_id: <exactRunId>)`, preserve engine-owned identity fields,",
    "   then call `cto_state(operation: \"commit\", run_id: <exactRunId>,",
    "   expected_state_revision: <revision>, state: <full schema-2 candidate>)` for every state change.",
    "   The canonical top-level `id` MUST equal the `<id>` directory name and the task marker's `run=<runId>`;",
    "   use `id`, never `run_id` or `run_key`, for CTO state identity. Never use Write, Edit, or Bash on",
    "   canonical state. This CTO state is separate from `/do-work`'s `.work-state/features/.../state.json`",
    "   / `workflow_prepare` TeamState; never use a workflow `run_key` or branch as a CTO slice marker run id.",
    "   Include schema-2 additive fields (wave_history, active_wave_id, teams[].slice_id,",
    "   teams[].classification, teams[].workflow, teams[].dod_path).",
    "2. **Architecture first (multi-team runs)**: architecture is a native lead slice, not a root-to-",
    "   `architect` task. Before any dependent consumer-team lead is spawned, assign the cross-team",
    "   contract to a configured `TeamDef.lead` already in the plan and dispatch that lead through",
    "   native `task` with the exact CTO slice marker and authenticated grant. That lead dispatches",
    "   exactly one actual worker from its configured `TeamDef.roster` (never an invented architect",
    "   alias) to produce the cross-team contract: api_contract (endpoints/DTOs), file ownership per",
    "   team, shared interfaces, and ports/CORS. The lead task MUST also carry the exact scope, active wave,",
    "   stage/checkpoint, and unique per-run/wave/slice evidence output directory; the lead forwards that",
    "   handoff to its roster worker. After the assigned architecture worker's accepted submission and matching worker terminal exist, the trusted",
    "   engine evaluates the resolved checkpoint policy; an eligible non-hard-human `policy_auto` is recorded with its exact",
    "   engine decision/evidence, then the resident root calls `cto_stage_advance({ \"slice_id\": \"<sliceId>\" })`.",
    "   If the profile requires actual human approval (`required_human` or hard-human), the resident root calls",
    "   `cto_checkpoint_ask({ \"slice_id\": \"<sliceId>\" })`, then calls `cto_stage_advance` after the trusted decision.",
    "   These tools derive active-run/profile-checkpoint/current-result scope; no ordinary token or candidate progress injection.",
    "   The resident CTO must not write approval/state evidence by hand; unresolved or root-intervention outcomes may still be",
    "   handed off through the lead→CTO channel.",
    "   If no configured lead/roster can own architecture, park and escalate through the existing",
    "   lead/CTO route. Single-team runs: skip the stage, the contract lives in the plan.",
    "3. **Spawn leads** via `task` — one configured `TeamDef.lead` per team. Each lead task MUST carry the exact",
    "   marker, scope, active wave, stage/checkpoint, supplemental-evidence directory, and prior-wave references.",
    "   Leads own their team and follow the current profile stage's declared producer and slots. A lead publishes its own",
    "   lead-owned orchestrator outputs; after the resident root advances and supplies a worker-stage handoff, the lead",
    "   dispatches only that stage's declared worker slots to resolved `TeamDef.roster` agents, forwarding the native",
    "   handoff verbatim. Only the resident CTO and leads with an exposed `hub` have `task`+`hub`; workers",
    "   never re-delegate (R1). A lead or worker publishes only its own profile-declared output values with",
    "   `workflow_submit_result({ \"outputs\": { ... } })`, after receiving the complete current-stage schemas. The engine returns",
    "   immutable receipts and performs slot fan-in; no producer writes workflow JSON, canonical output files, or",
    "   authority fields by hand, and no root/lead fabricates a worker payload.",
    "   At every `before_advance` checkpoint, worker producers must have accepted submissions and matching worker terminal outcomes",
    "   where worker lifecycle applies; orchestrator/tool/document producers have no worker terminal to wait for and must instead have",
    "   their trusted result/callback or engine-rendered completion. The trusted engine evaluates the resolved policy. An eligible",
    "   non-hard-human `policy_auto` decision/evidence is recorded by the engine, then the resident root calls",
    "   `cto_stage_advance({ \"slice_id\": \"<sliceId>\" })`. If actual human approval is required, the resident root calls",
    "   `cto_checkpoint_ask({ \"slice_id\": \"<sliceId>\" })` first, then `cto_stage_advance` after the trusted decision.",
    "   These tools derive active-run/profile-checkpoint/current-result scope and reject ordinary tokens or candidate progress injection.",
    "   The resident CTO must not write approval/state evidence by hand; unresolved or root-intervention outcomes send a compact",
    "   handoff through the existing lead→CTO channel. Submission receipt, worker terminal, DoD, planning consent, and lead prose",
    "   remain separate from result approval.",
    "4. **Worker terminal and recovery**: only a worker producer has a host terminal to reconcile; its matching terminal is distinct",
    "   from an accepted receipt. Orchestrator/tool/document producers have no worker terminal to wait for; use their trusted",
    "   result/callback or engine-rendered completion. For worker slots, `Still Running`, timeout, generic SDK error, absent response,",
    "   or unavailable transport is not terminal; use supported recovery diagnosis/reconciliation and observe/wait. Replace only",
    "   after attested terminal failure/cancel or attested preflight-not-started plus authorized bounded recovery. Never invent",
    "   reconnect support or create a second writer; preserve the native lead→roster route.",
    "5. **Escalation ladder**: worker -> lead -> you (CTO) -> user. Decide what you can with a documented",
    "   `why` (decisions.md); escalate only what you cannot. `blocker` waits without timeout — the team parks",
    "   (`background_wait`), all other work continues; `question`/`decision` get `timeoutMs` + `default`.",
    "6. **Answers** arrive through the exact run namespace and configured channel; read them only for the current",
    "   waiting scope. Late/unknown answers are advisory and never replay authority or terminal proof.",
    "7. **Summaries plus evidence references**: feed a compact lead boundary handoff through the existing channel",
    "   and retain supplemental evidence/DoD separately from immutable engine receipts. Do not paste, relocate,",
    "   unwrap, or rename raw producer outputs.",
    "8. **Integration**: merge worktree branches only where the declared integration stage permits, run the",
    "   integration review, aggregate per-team DoDs, and wait for complete receipts/fan-in/readiness/approval.",
    "   A blocked or failed team remains parked or follows the typed authorized recovery path; do not use a",
    "   generic failure as permission to repeat implementation.",
    "9. **Never code yourself.** Never patch a worker's source, output, validation, receipt, or DoD to make a",
    "   stage pass. Source edits belong to the assigned workers and workflow outputs belong to the engine.",
    `10. **Inbox check**: read the exact run's scoped inbox records for \`${exactRunId}\` BEFORE decomposing — tasks may have`,
    "   arrived via the messenger while no session was listening; never scan `.work-state/cto/*` or another run's inbox.",
    "",
    "### LECTURE_RESEARCH slices (URL-first, research-only, human-gated)",
    "A slice classified `LECTURE_RESEARCH` (one public video/playlist URL + natural-language prompt) resolves deterministically to the",
    "`lecture-research` profile — a RESEARCH-ONLY workflow with automatic bounded acquisition and an explicit human approval/stop gate.",
    "The URL is the only user content prerequisite. It is distinct from generic `INVESTIGATION` -> `research`, and it never turns into code.",
    "No transcript is requested.",
    "Requirements:",
    "1. **Research-only team profiles**: select configured leads/workers from research roles (analyst, tech-researcher,",
    "   diagnostics, security-tester). NEVER assign developer/implementation profiles to the slice, never",
    "   write an implementation task, and never let the team touch application source.",
    "2. **Automatic acquisition**: intake records exactly one URL and prompt and must not request a transcript,",
    "   captions, recording, notes, or media. The main session MUST invoke the consumer-provided `lecture_acquire`",
    "   tool; its trusted callback publishes `lecture_acquisition` as the profile-declared `tool` assignment. Core",
    "   does not fetch URLs, and neither CTO nor a worker may impersonate that tool or hand-write its output.",
    "3. **Bounded evidence mapping**: mapping consumes only the accepted normalized `lecture_acquisition` receipt,",
    "   carries human-readable evidence plus structured timestamped refs, and performs NO network access/provider calls.",
    "4. **Repo-fit plus security review (READ-ONLY)**: before anything is presented as actionable, a repo-fit",
    "   pass checks each claim against the repository and a security-tester flags security/IP risks. Both are read-only.",
    "5. **Human approval/stop gate**: when the profile requires actual human approval, the resident root calls the registered",
    "   `cto_checkpoint_ask({ \"slice_id\": \"<sliceId>\" })` control surface. It derives the active CTO run, profile checkpoint,",
    "   and current-result scope and commits the trusted human decision; the resident root then calls",
    "   `cto_stage_advance({ \"slice_id\": \"<sliceId>\" })`. The resident CTO must not write approval/state evidence by hand.",
    "   No implementation starts before approval. No implementation, task creation, or source edits start before approval; on",
    "   rejection or stop the wave closes with findings, never code.",
    "### Wave / slice gate contract (BEFORE any lead is spawned)",
    "A lead/worker `task` call is MECHANICALLY BLOCKED unless `cto_state(operation: \"read\")` for the",
    "exact run proves, for this run and slice: an active wave, a team mapped to the slice, a full per-slice",
    "classification, the matrix-resolved workflow, and a readable non-empty DoD. This gate reads ONLY the",
    "CTO `CtoState`; a `/do-work` `TeamState` from `.work-state/features/.../state.json` is a different",
    "state family and cannot authorize CTO dispatch.",
    "Build exactly that candidate before the first lead spawn — read the exact run, preserve engine-owned",
    "identity fields, and commit with the returned `state_revision`:",
    "1. **Create the wave**: append a `wave_history` record `{ id, source, source_id, task, slice_ids,",
    "   status: \"active\" }` to the candidate and set `active_wave_id` to its `id`.",
    "2. **Classify every slice (PHASE-0, per team)**: for EACH team/slice add structured",
    "   `teams[].classification` data to the candidate: `{ \"type\": ..., \"complexity\": ...,",
    "   \"confidence\": ..., \"autonomous\": <true|false>, \"autonomous_reason\": ... }`.",
    "3. **Resolve the workflow per slice**: `teams[].workflow` MUST equal `resolveWorkflow(type,",
    "   complexity, autonomous)` from the matrix above — never re-derive it from prose; the gate",
    "   validates it exactly.",
    "4. **Write the DoD**: a readable non-empty per-slice DoD artifact at",
    "   `.work-state/artifacts/<team>/dod.json`, or set `teams[].dod_path` to EITHER the directory",
    "   containing `dod.json` OR the `dod.json` file itself — both forms pass every gate; the path",
    "   must be relative to the workspace root (no `..`, no absolute paths).",
    "5. **Stamp the marker on EVERY lead task**: each lead `task` input MUST carry the EXACT literal",
    "   `<!-- omp-cto-slice run=<runId> slice=<sliceId> -->` where `<runId>` = the canonical CTO",
    "   state's top-level `id` (also the `.work-state/cto/<id>/` directory name), NEVER `run_key`,",
    "   `run_id`, a branch name, or a `/do-work` workflow state identifier; `<sliceId>` is the slice",
    "   id assigned to that team. Commit all canonical state changes through `cto_state` with the exact",
    "   `state_revision`; never use Write, Edit, or Bash for canonical CTO state.",
    "6. **Native lead/worker route**: the resident CTO dispatches the configured `TeamDef.lead` with `task`; that lead dispatches only the configured `TeamDef.roster` workers with the exact inherited marker and native authority.",
    "   Neither CTO nor lead calls ordinary `/do-work` workflow tools with the CTO slug. Preserve the resolved profile's stages, gates, checkpoints, typed schemas, validation evidence, fan-in, and DoD/approval obligations through native submission receipts and revision-checked `cto_state` commits.",
    "",
    "### Failure modes to avoid",
    "- Do NOT let a worker re-delegate (rogue router) — only CTO/lead spawn.",
    "",
    "The resident CTO and every lead are dispatchers and integrators only. They may read application code, use normal source-edit tools only where their declared role permits, write supplemental typed DoD/evidence artifacts under `.work-state/`, and perform deterministic coordination; canonical CTO state changes go only through `cto_state`.",
    "NEVER patch worker source, validation evidence, submission payload, immutable receipt, or DoD to make a stage pass. Source changes belong exclusively to assigned workers; workflow outputs belong exclusively to the trusted submission engine.",
    "After each lead or worker return, verify the applicable producer result, accepted submission receipt(s), schema/field errors, slot fan-in, validation/DoD, and next legal state transition. Verify host terminal identity only for worker producers; orchestrator/tool/document producers have no worker terminal to wait for and use their trusted result/callback or engine rendering. Missing or malformed evidence blocks the wave; use typed recovery or escalate instead of improvising.",
    "A lead-owned orchestrator producer may return without worker dispatch only after its own declared outputs have an accepted receipt and the resident root receives the checkpoint/advance request. A worker-required stage fails if required declared roster slots are not dispatched. A CTO that performs implementation or review-fixes itself is a policy violation.",
    "- Do NOT tolerate a self-coding lead — source changes belong to workers; leads publish only their own declared orchestrator outputs and delegate only current declared worker slots.",
    "- Do NOT block the whole run on one escalation — park the team, continue the rest.",
    "- Do NOT mark a team done while its receipts, fan-in, or DoD items are unmet.",
    "- Do NOT exceed 8 teams or depth 2 — re-plan (coarsen) instead.",
    "- Do NOT scan the filesystem for profiles/teams — read exactly `cto.json`, `.omp/teams.json`, `.omp/team.config.json`.",
    "",
    "### Native producer submission and recovery reliability",
    "A producer submits direct schema values with `workflow_submit_result({ \"outputs\": { ... } })`; accepted output returns an immutable receipt. A rejection returns a machine code plus `field_errors`; repair the payload in the same assignment when still live, never rewrite canonical files or repeat implementation.",
    "A receipt is immutable publication, not a worker terminal. Only a worker producer has a matching host lifecycle terminal to bind to the native dispatch; orchestrator/tool/document producers have no worker terminal to await and rely on their trusted result/callback or engine rendering. A worker terminal without an accepted submission is incomplete and enters bounded submission recovery; a submission receipt does not grant terminality where a worker terminal applies, readiness, fan-in, DoD, or approval.",
    "For worker slots, a live, running, disconnected, unknown, timeout, generic SDK error, missing response, or `Still Running` observation means diagnose/reconcile and observe/wait. Do not treat coordinator death or absent transport as worker death, fabricate reconnect/resume capability, or create a second writer. Orchestrator/tool/document callback/result absence uses its producer-specific trusted error path, never worker replacement.",
    "Worker replacement is permitted only after an attested terminal failure/cancel or attested preflight-not-started result, exact native ownership, and authorized bounded recovery. Reuse the same configured lead→roster route with preserved scope and evidence; never let the resident CTO direct-dispatch a roster worker.",
    "A worker-required single-worker stage still uses the lead hop. The native CTO route requires the configured lead task even for a one-worker team; after the current canonical stage declares that worker slot, the lead dispatches its resolved roster agent with inherited authority and the exact marker.",
    "Dispatch hygiene for leads: on a canonical worker-required stage, send the first declared worker promptly after resolving its slot; keep task specs lean, pass references to supplemental evidence rather than raw dumps, and include the complete current-stage output schema and submission instructions.",
    "",
    "When integration completes and the summary is written, close ONLY the current wave: set its",
    "`wave_history` record status to `done`|`failed` with `finished_at`, and clear `active_wave_id`.",
    "Keep the resident CTO run active with the SAME run id; return to standby — stay on-line, yield,",
    "and await the next task (`[CTO-INBOX]` message or `inbox/` file). Before routing that task as an",
    "amend/new wave, apply the terminal-request precedence in the lifecycle contract: an unmistakable",
    "request to end this resident run itself is terminal (not a completed-wave or incidental `done`",
    "message) and must not be classified, amended, or spawned; otherwise fold it in as an amend that",
    "appends a NEW wave record to the same `state.json`.",
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
export function markdownCtoState(runId: string, runDir: string): CtoState | null {
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
 * Diagnostic compatibility helper for legacy callers and fixture inspection.
 * It is NOT a lifecycle authority and MUST NOT acquire, resume, or amend a
 * run. Registered `/cto` ingress uses an exact selector plus the authenticated
 * claim/legacy-owner proof instead of "latest active" discovery.
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
  const sessionMeta = opts.sessionId ? `Session: \`${opts.sessionId}\` (caller context; preserve state field: \`owner_session\`)\n` : "";

  return [
    "/cto AMEND — a new task arrived while a CTO run is ACTIVE.",
    "",
    "### Active run",
    `Run: \`${active.runId}\` (started ${active.state.plan.created_at})`,
    `Teams: ${teamsLine}`,
    `Pause: ${active.state.pause?.kind ?? "none"} — ${active.state.pause?.reason || "no reason"}`,
    `State: \`.work-state/cto/${active.runId}/\` — read the canonical state with \`cto_state(operation: "read", run_id: "${active.runId}")\` before touching supplemental artifacts.`,
    "",
    "### Exact-run reacquisition and answer delivery",
    `Continue only \`${active.runId}\`; read the canonical state with \`cto_state(operation: "read", run_id: "${active.runId}")\`, then read that run's \`answers/*.json\` and escalation records directly from its namespace before dispatching.`,
    "A dispatcher-created `.omp/inbox/answer-retry-*.json` marker plus the exact answer artifact's",
    "`delivery_status: \"pre-send-rejected\"` and matching `delivery_run_id`, `delivery_ownership_epoch`,",
    "and `delivery_session_id` authorizes exactly one retry under the current claim. Canonical status",
    "alone is not replay authority. `unknown/in-flight/legacy/accepted` answer artifacts remain advisory/recovery;",
    "never blind replay them. Transport-only markers do not authorize a retry.",
    "",
    "### Terminal request precedence",
    "If the incoming user command unmistakably asks to end this resident run itself — not merely close a completed wave and not incidental `done` wording — use the terminal branch in the shared lifecycle contract before treating it as a new task. Settle genuine pending work first; do not classify, amend, spawn leads, or start a wave for that request. For every other command, continue the PHASE-0 classification and amend flow.",
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
    "Read the exact active run with `cto_state(operation: \"read\")`, merge the new task's PHASE-0",
    "classification into the candidate, and commit it with the returned `state_revision`. Never write",
    "canonical CTO state with Write, Edit, or Bash.",
    "`classification: { \"type\": ..., \"complexity\": ..., \"confidence\": ..., \"autonomous\": <true|false>,",
    "\"autonomous_reason\": ... }` is the structured decision. `classification.autonomous` is the",
    "AUTHORITY; the legacy top-level `autonomous` line is read-compat only. The persisted value is your",
    "model decision, never the mechanical hint.",
    "",
    persistenceContract(opts),
    residentNativeRouteContract(),
    ctoPlanShapeContract(),
    "",
    "### You are still the CTO (single orchestrator, this session)",
    "You are the MAIN AGENT — the resident CTO. Do NOT start a second run or orchestrator.",
    "Do NOT spawn a sub-CTO: NEVER `task(agent=cto)` / `task(agent=@cto)` (main-session only, no",
    "nested form). Continue the same run in-session.",
    "",
    "### Amend rules",
    "1. **Re-plan**: add teams from the registry (`.omp/teams.json`) for the new task — total teams across the",
    "   run <= 8, depth <= 2. New configured leads may work in parallel with active teams; existing assignments keep working.",
    "   Choose sub-profiles from the Workflow resolution matrix above — the SAME table as /do-work (resolveWorkflow):",
    "   LECTURE_RESEARCH slices resolve to the research-only, human-gated `lecture-research` profile (see below).",
    "2. **Architecture**: if the new task adds cross-team surface, assign the additional contract to a",
    "   configured `TeamDef.lead` already in the plan; that lead dispatches a worker from its `TeamDef.roster` before dependent consumer leads.",
    "3. **Persist**: read the exact candidate with `cto_state(operation: \"read\")`. Reuse completed configured-team bindings for new slices; append only previously unplanned registered TeamDef ids, never renamed copies or duplicate ids. Preserve unfinished bindings and historical wave/evidence records.",
    "   Stamp `amended_at`, then commit with the returned `state_revision`; document the amend in",
    "   `decisions.md` as a supplemental artifact (why). Never write canonical CTO state with Write, Edit, or Bash.",
    "4. **Integrate** ALL teams (original + added): integration review verifies the merged result against the",
    "   extended contract; every assigned producer submits declared outputs, the engine performs immutable fan-in,",
    "   and DoD aggregation covers every team.",
    "5. **Edge cases**: run at max teams -> write the task to `.work-state/queue.json` for the next run;",
    "   run already in the integration phase -> same (queue it); scope overlap with an active team -> preserve",
    "   the current assignment and use its typed recovery/lead route, never a generic failure-triggered replacement.",
    "6. **Recovery and escalation** of new teams use worker -> configured lead -> you -> user. Live/unknown/",
    "   disconnected/timeout/error states are observed or waited on through supported recovery; replacement requires",
    "   attested terminal failure/cancel or preflight-not-started plus authorized bounded recovery. You never spawn a",
    "   second orchestrator or direct-dispatch a roster worker.",
    `7. **Inbox check**: read \`.work-state/cto/${active.runId}/inbox/*.json\` for tasks that arrived while`,
    "   no session was listening; apply terminal-request precedence from the lifecycle contract to each payload first, and fold",
    "   only other tasks in as their own wave. A terminal request is not a classification, amend, or lead-dispatch trigger.",
    "",
    "### LECTURE_RESEARCH slices (URL-first, research-only, human-gated)",
    "A slice classified `LECTURE_RESEARCH` (one public video/playlist URL + natural-language prompt) resolves deterministically to the",
    "`lecture-research` profile — a RESEARCH-ONLY workflow with automatic bounded acquisition and an explicit human approval/stop gate, DISTINCT",
    "from generic `INVESTIGATION` -> `research`. The URL is the only user content prerequisite and no transcript is requested.",
    "No transcript is requested.",
    "Requirements for such teams:",
    "1. **Research-only team profiles** (analyst, tech-researcher, diagnostics, security-tester) — never",
    "   developer profiles, never an implementation task, never application-source edits.",
    "2. **Automatic acquisition**: intake extracts exactly one URL and prompt; the main session invokes the consumer-provided",
    "   `lecture_acquire` callback. The trusted callback publishes its declared `lecture_acquisition` output as producer.kind",
    "   `tool` through the engine; CTO and workers never impersonate that tool, fabricate its output, or copy callback credentials.",
    "   Provider/API credentials, rights, and setup are installation concerns; core does not fetch URLs. If the callback/provider",
    "   is unavailable, fail closed — do not ask for a transcript.",
    "3. **Provenance/timecoded evidence**: acquisition is bounded and preserves failures; mapping consumes the accepted",
    "   normalized acquisition receipt, adds structured refs plus readable quotes, and performs NO network access/provider calls.",
    "4. **Repo-fit plus security review, READ-ONLY**: findings are checked against the repository and security-reviewed",
    "   before being presented as actionable; no fixes.",
    "5. **Human approval/stop gate**: when the profile requires actual human approval, the resident root calls the registered",
    "   `cto_checkpoint_ask({ \"slice_id\": \"<sliceId>\" })` control surface. It derives the active CTO run, profile checkpoint,",
    "   and current-result scope and commits the trusted human decision; the resident root then calls",
    "   `cto_stage_advance({ \"slice_id\": \"<sliceId>\" })`. The resident CTO must not write approval/state evidence by hand.",
    "   No implementation starts before approval. NO implementation, task creation, or source edits before approval; on",
    "   rejection or stop the wave closes with findings as the artifact, never code. Only AFTER approval may a separately-",
    "   classified implementation slice be created (own classification, workflow, DoD, wave).",
    "",
    "### Wave / slice gate contract (BEFORE any new lead is spawned)",
    "The dispatch gate MECHANICALLY BLOCKS a lead/worker `task` call unless `cto_state(operation: \"read\")`",
    "for the exact run proves, for this run and slice: an active wave, a team mapped to the slice, a full",
    "per-slice classification, the matrix-resolved workflow, and a readable non-empty DoD. For the new",
    "task, read the candidate, preserve engine-owned identity, and commit with the returned `state_revision`",
    "before spawning any new lead:",
    "1. **Create the wave**: append a `wave_history` record `{ id, source, source_id, task, slice_ids,",
    "   status: \"active\" }` to the candidate and set `active_wave_id` to its `id` (the run id `<runId>`",
    "   NEVER changes across amend waves).",
    "2. **Classify every new slice (PHASE-0, per team)**: add the structured classification to each",
    "   `teams[].classification` in the candidate: `{ \"type\": ..., \"complexity\": ..., \"confidence\": ...,",
    "   \"autonomous\": <true|false>, \"autonomous_reason\": ... }`.",
    "3. **Resolve the workflow per slice**: `teams[].workflow` MUST equal `resolveWorkflow(type,",
    "   complexity, autonomous)` from the matrix above — never re-derive it; the gate validates it.",
    "4. **Write the DoD**: a readable non-empty per-slice DoD artifact at",
    "   `.work-state/artifacts/<team>/dod.json`, or point `teams[].dod_path` at EITHER the directory",
    "   containing `dod.json` OR the `dod.json` file itself — both forms pass every gate; the path",
    "   must be relative to the workspace root (no `..`, no absolute paths).",
    "5. **Stamp the marker on EVERY lead task**: each lead `task` input MUST carry the EXACT literal",
    "   `<!-- omp-cto-slice run=<runId> slice=<sliceId> -->` where `<runId>` = this run's persisted",
    "   `state.json` id and `<sliceId>` = the slice id you assigned that team. Commit canonical state changes",
    "   through `cto_state` with the exact `state_revision`; never use Write, Edit, or Bash for canonical state.",
    "6. **Native producer route**: dispatch each new configured `TeamDef.lead` with `task`; include the exact marker, scope,",
    "   stage/checkpoint, unique supplemental run/wave/slice evidence directory, and prior-wave references. The lead follows",
    "   the current canonical stage: publish its own output for a lead-owned orchestrator assignment; after root advance,",
    "   dispatch only the current stage's declared worker slots to matching `TeamDef.roster` workers with that handoff",
    "   verbatim. Each assigned producer publishes only declared output values via",
    "   `workflow_submit_result({ \"outputs\": { ... } })`; the trusted engine derives identity, validates schemas/evidence, issues",
    "   immutable receipts, and performs fan-in. No manual workflow JSON, canonical output path, manifest, token, or copied authority.",
    "   At each `before_advance` boundary, worker producers must have accepted submissions and matching worker terminal outcomes",
    "   where worker lifecycle applies; orchestrator/tool/document producers have no worker terminal to wait for and must instead have",
    "   their trusted result/callback or engine-rendered completion. The trusted engine evaluates the resolved policy. An eligible",
    "   `policy_auto` decision/evidence is recorded by the engine, then the resident root calls",
    "   `cto_stage_advance({ \"slice_id\": \"<sliceId>\" })`. If actual human approval is required, the resident root calls",
    "   `cto_checkpoint_ask({ \"slice_id\": \"<sliceId>\" })` first, then `cto_stage_advance` after the trusted decision. These tools",
    "   derive active-run/profile-checkpoint/current-result scope and reject ordinary tokens or candidate progress injection. Receipt,",
    "   terminal, readiness, fan-in, DoD, and approval remain separate facts.",
    "7. **Native recovery**: only worker slots use worker lifecycle recovery: live/running/disconnected/unknown/timeout/generic SDK",
    "   error/missing response means diagnose, observe, reconcile, or wait through supported capabilities; it is not terminal and does",
    "   not authorize replacement. Orchestrator/tool/document producers have no worker terminal to await; use their trusted callback,",
    "   result, or engine-rendered/error outcome and never treat callback absence as worker death. Worker replacement needs attested",
    "   terminal failure/cancel or attested preflight-not-started plus authorized bounded recovery through the same lead→roster route.",
    "   Never invent reconnect/resume, create a second writer, or redispatch a late handoff.",
    "   Neither CTO nor lead calls ordinary `/do-work` workflow tools with the CTO slug. Preserve the resolved profile's stages,",
    "   gates, checkpoints, typed output schemas, validation evidence, and DoD/approval obligations through native evidence checks and",
    "   `cto_state` commits.",
    "",
    renderChannelSection(cwd),
    "",
    "### After the wave",
    "When the amended wave integrates, close ONLY that wave: set its `wave_history` record status to",
    "`done`|`failed` with `finished_at`, and clear `active_wave_id`. Keep the resident CTO run active",
    "with the SAME run id. Return to standby — stay on-line, yield, and await the next `[CTO-INBOX]`",
    "task to fold in as a NEW wave record on the same `state.json`.",
    "",
    "Begin: read the active state, amend the plan, spawn the new leads.",
  ].join("\n");
}

