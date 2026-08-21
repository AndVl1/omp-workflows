/**
 * State machine: read/write `.work-state/team-state.json` with monotonic
 * progress, branch detection, and the per-feature subdir layout.
 *
 * Layout (preserved from claude-plugin):
 *   .work-state/
 *     .active-feature                  (file: slug)
 *     team-state.json                  (legacy root state)
 *     team-state.md                    (human mirror)
 *     artifacts/
 *       <id>.json
 *     features/
 *       <slug>/
 *         state.json
 *         team-state.md
 *         artifacts/<id>.json
 *
 * Resolution order on read:
 *   1. .work-state/.active-feature -> features/<slug>/state.json
 *   2. .work-state/team-state.json (legacy)
 *   3. undefined (no state yet)
 */
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync, readdirSync, realpathSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { readObservabilityPointer } from "../observability/recorder.js";
import { recordStageTransition } from "../observability/hooks.js";
import { activeWave, readCtoState } from "../cto/state.js";
import type { PauseKind, StageStatus, TeamState } from "./types.js";

export const DETACHED_BRANCH = "__omp_detached_head__";
export const NO_GIT_BRANCH = "__omp_no_git__";

/**
 * Resolve the branch binding used by strict workflow transitions.
 * Detached HEAD and non-git directories are explicit invalid bindings;
 * returning a sentinel makes every strict state comparison fail closed.
 */
export function resolveActiveBranch(cwd: string): string {
  try {
    const branch = execFileSync("git", ["-C", cwd, "branch", "--show-current"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (branch) return branch;
    const inside = execFileSync("git", ["-C", cwd, "rev-parse", "--is-inside-work-tree"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return inside === "true" ? DETACHED_BRANCH : NO_GIT_BRANCH;
  } catch {
    return NO_GIT_BRANCH;
  }
}

const WORK_STATE_DIR = ".work-state";
const ACTIVE_FEATURE = ".active-feature";
const LEGACY_STATE = "team-state.json";
const STATE_MD = "team-state.md";
export function isSafeStateSegment(value: string): boolean {
  return value.length > 0 && value !== "." && value !== ".." && /^[A-Za-z0-9._-]+$/.test(value);
}

function isWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !rel.includes("/") && !rel.includes("\\"));
}
function isWithinTree(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * Normalize state written by pre-durable workflow commands. Those states keep
 * `workflow` at the root and track progress as `pending_stages`; the durable
 * engine needs the classification nested and a cursor-shaped state.
 */
function normalizePersistedState(raw: unknown): TeamState | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const state: Record<string, unknown> = { ...(raw as Record<string, unknown>) };
  const rawClassification = state.classification;
  const classification = rawClassification && typeof rawClassification === "object" && !Array.isArray(rawClassification)
    ? { ...(rawClassification as Record<string, unknown>) }
    : null;
  const legacyWorkflow = typeof state.workflow === "string" && state.workflow.length > 0 ? state.workflow : null;
  if (classification && typeof classification.workflow !== "string" && legacyWorkflow) {
    classification.workflow = legacyWorkflow;
    state.classification = classification;
  }

  const hasLegacyCursor = Array.isArray(state.pending_stages) || typeof state.status === "string";
  const hasDurableCursor = Array.isArray(state.stages) && typeof state.stage_cursor === "string";
  if (classification && legacyWorkflow && hasLegacyCursor && !hasDurableCursor) {
    state.schema = 1;
    state.run_key = typeof state.run_key === "string" ? state.run_key : typeof state.branch === "string" ? state.branch : undefined;
    state.stage_cursor = "";
    state.stages = [];
    const rawArtifacts = state.artifacts;
    state.artifacts = rawArtifacts && typeof rawArtifacts === "object" && !Array.isArray(rawArtifacts) ? rawArtifacts : {};
    state.workflow_override = typeof state.workflow_override === "boolean" ? state.workflow_override : false;
    state.issue = "issue" in state ? state.issue : null;
    const rawPause = state.pause;
    state.pause = rawPause && typeof rawPause === "object" && !Array.isArray(rawPause) ? rawPause : { kind: "none", reason: "" };
    state.updated_at = typeof state.updated_at === "string" ? state.updated_at : new Date().toISOString();
  }
  return state as unknown as TeamState;
}



export interface ResolvedState {
  state: TeamState | null;
  statePath: string | null;
  stateDir: string | null;
  artifactsDir: string | null;
  isLegacy: boolean;
  isStale: boolean;
  invalid?: boolean;
}

/**
 * A stale `.active-feature` pointer can survive an upgrade while the
 * orchestrator writes the current classification to the legacy root state.
 * Use that root only when the pointed feature state is incomplete and the
 * root state is a complete, branch-compatible workflow state. A complete
 * feature state remains authoritative; malformed or foreign root state never
 * becomes a fallback.
 */
function resolveLegacyWorkflowFallback(cwd: string, wsDir: string, currentBranch?: string): ResolvedState | null {
  const legacyPath = join(wsDir, LEGACY_STATE);
  if (!existsSync(legacyPath)) return null;
  try {
    const realWorkState = realpathSync(wsDir);
    if (!isWithin(realpathSync(cwd), realWorkState) || !isWithin(realWorkState, realpathSync(legacyPath))) return null;
    const artifactsPath = join(wsDir, "artifacts");
    if (existsSync(artifactsPath) && !isWithin(realWorkState, realpathSync(artifactsPath))) return null;
    const state = normalizePersistedState(JSON.parse(readFileSync(legacyPath, "utf8")));
    if (!state || !state.classification || typeof state.classification.workflow !== "string" || !state.classification.workflow || typeof state.branch !== "string" || !state.branch) return null;
    if (currentBranch && state.branch !== currentBranch) return null;
    return { state, statePath: legacyPath, stateDir: wsDir, artifactsDir: artifactsPath, isLegacy: true, isStale: false };
  } catch {
    return null;
  }
}

export type StateSelector = { kind?: "auto" | "team" | "cto-slice"; runId?: string; sliceId?: string; capabilityId?: string };
export interface ResolvedActiveRun extends ResolvedState {
  kind: "legacy-root" | "feature" | "cto-slice";
  runKey: string;
  branch: string;
  workflow: string;
  profileHash: string;
  stageCursor: string;
  cursorEpoch: string;
  dispatch: unknown;
  staleReason: string | null;
  selectedTeam?: unknown;
}

/** Resolve the one authoritative persisted run. Explicit CTO selectors fail closed.
 * A stale active-feature pointer may use a complete, branch-compatible legacy
 * root only when the pointed feature state is incomplete. */
export function resolveCanonicalRun(cwd: string, selector: StateSelector = {}, currentBranch?: string): ResolvedActiveRun | null {
  const branch = currentBranch;
  if (selector.kind === "cto-slice" || selector.runId || selector.sliceId) {
    if (!selector.runId || !selector.sliceId) throw new Error("cto-slice selector requires runId and sliceId");
    const runId = selector.runId, sliceId = selector.sliceId;
    if (!isSafeStateSegment(runId) || !isSafeStateSegment(sliceId)) throw new Error("cto-slice selector contains an unsafe path segment");
    const cto = readCtoState(runId, cwd);
    if (!cto) throw new Error(`CTO run '${runId}' is missing or unreadable`);
    const wave = activeWave(cto);
    if (!wave) throw new Error(`CTO run '${runId}' has no active wave`);
    const matches = cto.teams.filter((team) => team.slice_id === sliceId);
    if (matches.length !== 1) throw new Error(`CTO slice '${sliceId}' must map to exactly one active team`);
    const team = matches[0]!;
    const execution = (team as unknown as { execution?: unknown }).execution;
    if (!execution) throw new Error(`CTO slice '${sliceId}' has no shared execution capability`);
    const staleReason = branch && cto.branch !== branch ? `branch mismatch: persisted '${cto.branch}', current '${branch}'` : null;
    return { state: cto as any, statePath: join(cwd, WORK_STATE_DIR, "cto", cto.id, "state.json"), stateDir: join(cwd, WORK_STATE_DIR, "cto", cto.id), artifactsDir: join(cwd, WORK_STATE_DIR, "cto", cto.id, "artifacts"), isLegacy: false, isStale: Boolean(staleReason), kind: "cto-slice", runKey: `cto:${cto.id}:${sliceId}`, branch: cto.branch, workflow: team.workflow ?? "cto", profileHash: String((execution as any).profile_hash ?? ""), stageCursor: String((execution as any).stage_cursor ?? ""), cursorEpoch: String((execution as any).cursor_epoch ?? ""), dispatch: execution, staleReason, selectedTeam: team };
  }
  const resolved = resolveState(cwd, branch);
  if (resolved.invalid) throw new Error("workflow state is invalid or unsafe");
  if (!resolved.state || !resolved.statePath) return null;
  const state = resolved.state;
  const kind = resolved.isLegacy ? "legacy-root" : "feature";
  return { ...resolved, kind, runKey: resolved.isLegacy ? `team:${state.branch}:root` : `team:${state.branch}:${basename(resolved.stateDir ?? "")}`, branch: state.branch, workflow: state.classification.workflow, profileHash: state.profile_hash ?? "", stageCursor: state.stage_cursor, cursorEpoch: state.cursor_epoch ?? "", dispatch: state.dispatch_capability ?? null, staleReason: resolved.isStale ? `branch mismatch: persisted '${state.branch}', current '${branch ?? "unknown"}'` : null };
}

export function resolveState(cwd: string, currentBranch?: string): ResolvedState {
  const wsDir = resolve(cwd, WORK_STATE_DIR);
  if (!existsSync(wsDir)) {
    return { state: null, statePath: null, stateDir: null, artifactsDir: null, isLegacy: false, isStale: false };
  }
  try {
    if (!isWithin(realpathSync(cwd), realpathSync(wsDir))) {
      return { state: null, statePath: null, stateDir: null, artifactsDir: null, isLegacy: false, isStale: false, invalid: true };
    }
  } catch {
    return { state: null, statePath: null, stateDir: null, artifactsDir: null, isLegacy: false, isStale: false, invalid: true };
  }

  const activeFile = join(wsDir, ACTIVE_FEATURE);
  if (existsSync(activeFile)) {
    const slug = readFileSync(activeFile, "utf8").trim();
    if (!isSafeStateSegment(slug)) {
      return { state: null, statePath: null, stateDir: null, artifactsDir: null, isLegacy: false, isStale: false, invalid: true };
    }
    const featuresDir = join(wsDir, "features");
    const featureDir = join(featuresDir, slug);
    const statePath = join(featureDir, "state.json");
    if (!existsSync(featuresDir)) return { state: null, statePath: null, stateDir: featureDir, artifactsDir: join(featureDir, "artifacts"), isLegacy: false, isStale: false };
    try {
      const realWorkState = realpathSync(wsDir);
      const realFeatures = realpathSync(featuresDir);
      if (!isWithin(realpathSync(cwd), realWorkState) || !isWithin(realWorkState, realFeatures) || (existsSync(featureDir) && !isWithin(realFeatures, realpathSync(featureDir)))) {
        return { state: null, statePath: null, stateDir: null, artifactsDir: null, isLegacy: false, isStale: false, invalid: true };
      }
    } catch {
      return { state: null, statePath, stateDir: featureDir, artifactsDir: join(featureDir, "artifacts"), isLegacy: false, isStale: false, invalid: true };
    }
    if (!existsSync(statePath)) return { state: null, statePath: null, stateDir: featureDir, artifactsDir: join(featureDir, "artifacts"), isLegacy: false, isStale: false };
    try {
      const realFeature = realpathSync(featureDir);
      if (!isWithin(realFeature, realpathSync(statePath))) {
        return { state: null, statePath, stateDir: featureDir, artifactsDir: join(featureDir, "artifacts"), isLegacy: false, isStale: false, invalid: true };
      }
      const artifactsPath = join(featureDir, "artifacts");
      if (existsSync(artifactsPath) && !isWithin(realFeature, realpathSync(artifactsPath))) {
        return { state: null, statePath, stateDir: featureDir, artifactsDir: artifactsPath, isLegacy: false, isStale: false, invalid: true };
      }
      const state = normalizePersistedState(JSON.parse(readFileSync(statePath, "utf8")));
      if (!state) {
        const legacyFallback = resolveLegacyWorkflowFallback(cwd, wsDir, currentBranch);
        if (legacyFallback) return legacyFallback;
        return { state: null, statePath, stateDir: featureDir, artifactsDir: artifactsPath, isLegacy: false, isStale: false, invalid: true };
      }
      if (!state.classification || typeof state.classification.workflow !== "string" || !state.classification.workflow) {
        const legacyFallback = resolveLegacyWorkflowFallback(cwd, wsDir, currentBranch);
        if (legacyFallback) return legacyFallback;
      }
      return { state, statePath, stateDir: featureDir, artifactsDir: artifactsPath, isLegacy: false, isStale: currentBranch ? state.branch !== currentBranch : false };
    } catch {
      return { state: null, statePath, stateDir: featureDir, artifactsDir: join(featureDir, "artifacts"), isLegacy: false, isStale: false, invalid: true };
    }
  }

  const legacyPath = join(wsDir, LEGACY_STATE);
  if (existsSync(legacyPath)) {
    try {
      const realWorkState = realpathSync(wsDir);
      if (!isWithin(realpathSync(cwd), realWorkState) || !isWithin(realWorkState, realpathSync(legacyPath))) {
        return { state: null, statePath: legacyPath, stateDir: wsDir, artifactsDir: join(wsDir, "artifacts"), isLegacy: true, isStale: false, invalid: true };
      }
      const artifactsPath = join(wsDir, "artifacts");
      if (existsSync(artifactsPath) && !isWithin(realWorkState, realpathSync(artifactsPath))) {
        return { state: null, statePath: legacyPath, stateDir: wsDir, artifactsDir: artifactsPath, isLegacy: true, isStale: false, invalid: true };
      }
      const state = normalizePersistedState(JSON.parse(readFileSync(legacyPath, "utf8")));
      if (!state) return { state: null, statePath: legacyPath, stateDir: wsDir, artifactsDir: artifactsPath, isLegacy: true, isStale: false, invalid: true };
      return { state, statePath: legacyPath, stateDir: wsDir, artifactsDir: artifactsPath, isLegacy: true, isStale: currentBranch ? state.branch !== currentBranch : false };
    } catch {
      return { state: null, statePath: legacyPath, stateDir: wsDir, artifactsDir: join(wsDir, "artifacts"), isLegacy: true, isStale: false, invalid: true };
    }
  }
  return { state: null, statePath: null, stateDir: null, artifactsDir: null, isLegacy: false, isStale: false };
}

export function writeState(
  cwd: string,
  state: TeamState,
  opts: { featureSlug?: string; target?: ResolvedState } = {},
): { statePath: string; artifactsDir: string } {
  const wsDir = resolve(cwd, WORK_STATE_DIR);
  mkdirSync(wsDir, { recursive: true });
  const realWorkState = realpathSync(wsDir);
  if (!isWithin(realpathSync(cwd), realWorkState)) throw new Error("workflow state path escapes project root");
  const target = opts.target;
  if (target?.invalid) throw new Error("cannot write through an invalid workflow state target");
  if (target && (!target.stateDir || !target.statePath || !target.artifactsDir)) throw new Error("workflow state target is incomplete");
  if (target) {
    const targetStateDir = realpathSync(target.stateDir!);
    if (!isWithinTree(realWorkState, targetStateDir)) throw new Error("workflow state target escapes .work-state");
    if (existsSync(target.statePath!) && !isWithin(targetStateDir, realpathSync(target.statePath!))) {
      throw new Error("workflow state target escapes its state directory");
    }
  }

  const featureSlug = target
    ? target.isLegacy ? null : basename(target.stateDir!)
    : opts.featureSlug ?? deriveFeatureSlugFromBranch(state.branch) ?? "default";
  if (featureSlug && !isSafeStateSegment(featureSlug)) throw new Error("unsafe workflow feature slug");
  let stateDir: string;
  let statePath: string;
  let artifactsDir: string;

  if (target) {
    stateDir = target.stateDir!;
    statePath = target.statePath!;
    artifactsDir = target.artifactsDir!;
  } else if (featureSlug) {
    stateDir = join(wsDir, "features", featureSlug);
    statePath = join(stateDir, "state.json");
    artifactsDir = join(stateDir, "artifacts");
  } else {
    stateDir = wsDir;
    statePath = join(wsDir, LEGACY_STATE);
    artifactsDir = join(wsDir, "artifacts");
  }

  if (featureSlug) {
    const featuresDir = join(wsDir, "features");
    mkdirSync(featuresDir, { recursive: true });
    const realFeatures = realpathSync(featuresDir);
    if (!isWithin(realWorkState, realFeatures)) throw new Error("workflow feature path escapes .work-state/features");
    mkdirSync(stateDir, { recursive: true });
    if (!isWithin(realFeatures, realpathSync(stateDir))) throw new Error("workflow feature path escapes .work-state/features");
  } else {
    mkdirSync(stateDir, { recursive: true });
  }

  const realStateDir = realpathSync(stateDir);
  if (!isWithinTree(realWorkState, realStateDir)) throw new Error("workflow state directory escapes .work-state");
  if (!isWithin(realStateDir, realpathSync(dirname(statePath)))) throw new Error("workflow state path escapes its state directory");
  if (!isWithin(realStateDir, realpathSync(dirname(artifactsDir)))) throw new Error("workflow artifacts path escapes its state directory");
  mkdirSync(artifactsDir, { recursive: true });
  if (!isWithin(realStateDir, realpathSync(artifactsDir))) throw new Error("workflow artifacts path escapes its state directory");

  const stamped: TeamState = { ...state, updated_at: new Date().toISOString() };
  // Embed the observability pointer (best-effort: a missing event log is
  // fine for pre-observability features). The recorder file lives under
  // `<featureDir>/observability/events.jsonl`; we read it synchronously
  // here because `writeState` is itself sync and the file is bounded by
  // session length.
  const obsPointer = featureSlug ? readObservabilityPointerSafe(cwd, featureSlug) : null;
  if (obsPointer) {
    stamped.observability = obsPointer;
  } else {
    delete stamped.observability;
  }
  atomicWrite(statePath, JSON.stringify(stamped, null, 2) + "\n");
  writeStateMd(stateDir, stamped);
  if (featureSlug) atomicWrite(join(wsDir, ACTIVE_FEATURE), featureSlug + "\n");

  return { statePath, artifactsDir };
}

function atomicWrite(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  try {
    writeFileSync(tmp, content, "utf8");
    renameSync(tmp, path);
  } catch (error) {
    try {
      unlinkSync(tmp);
    } catch {
      // Best-effort cleanup must not hide the original I/O error.
    }
    throw error;
  }
}
function readObservabilityPointerSafe(cwd: string, featureSlug: string) {
  try {
    return readObservabilityPointer(cwd, featureSlug);
  } catch {
    return null;
  }
}

export function writeStateMd(stateDir: string, state: TeamState): void {
  const lines: string[] = [];
  lines.push("# TEAM STATE");
  lines.push("");
  lines.push("## Classification");
  lines.push(`- Type: ${state.classification.type}`);
  lines.push(`- Complexity: ${state.classification.complexity}`);
  lines.push(`- Workflow: ${state.classification.workflow}`);
  lines.push(`- Confidence: ${state.classification.confidence}`);
  lines.push(`- Autonomous: ${state.classification.autonomous}`);
  if (state.classification.autonomous_reason) {
    lines.push(`- Autonomous reason: ${state.classification.autonomous_reason}`);
  }
  lines.push("");
  lines.push("## Task");
  lines.push(state.task);
  lines.push("");
  lines.push("## Progress");
  for (const s of state.stages) {
    const mark = s.status === "done" ? "[x]" : s.status === "in_progress" ? "[~]" : s.status === "skipped" ? "[s]" : s.status === "failed" ? "[!]" : "[ ]";
    lines.push(`- ${mark} ${s.id} - ${s.status}`);
  }
  lines.push("");
  lines.push("## Pause");
  lines.push(`- kind: ${state.pause.kind}`);
  if (state.pause.reason) lines.push(`- reason: ${state.pause.reason}`);
  lines.push("");
  lines.push("## Branch");
  lines.push(state.branch);
  lines.push("");
  lines.push("## Last update");
  lines.push(`- ${state.updated_at}`);
  lines.push("");
  if (state.observability) {
    const r = state.observability.rollup;
    lines.push("## Observability");
    lines.push(`- events: ${state.observability.eventsPath} (last id: ${state.observability.lastEventId || "none"})`);
    lines.push(`- agent invocations: ${r.agentInvocations}`);
    const subagentEntries = Object.entries(r.subagents).sort((a, b) => b[1] - a[1]);
    if (subagentEntries.length > 0) {
      lines.push("- subagents:");
      for (const [name, count] of subagentEntries) {
        lines.push(`  - ${name}: ${count}`);
      }
    }
    const skillEntries = Object.entries(r.skills).sort((a, b) => b[1] - a[1]);
    if (skillEntries.length > 0) {
      lines.push("- skills:");
      for (const [name, count] of skillEntries) {
        lines.push(`  - ${name}: ${count}`);
      }
    }
    if (r.totalToolCalls > 0) {
      lines.push(`- tool calls: ${r.totalToolCalls} (errors: ${r.totalToolErrors})`);
    }
    if (r.durationMs > 0) {
      lines.push(`- duration: ${r.durationMs}ms (${r.firstEventAt} → ${r.lastEventAt})`);
    }
    lines.push("");
  }

  atomicWrite(join(stateDir, STATE_MD), lines.join("\n"));
}

export function setPause(state: TeamState, kind: PauseKind, reason = ""): TeamState {
  return { ...state, pause: { kind, reason }, updated_at: new Date().toISOString() };
}

export function setStageStatus(
  state: TeamState,
  stageId: string,
  status: StageStatus,
  /** Project root — enables best-effort stage_transition telemetry (optional). */
  cwd?: string,
): TeamState {
  const stages = state.stages.map((s) => (s.id === stageId ? { ...s, status } : s));
  const cursor = status === "in_progress" ? stageId : state.stage_cursor;
  if (cwd) {
    try {
      recordStageTransition(cwd, { stageId, stageStatus: status });
    } catch {
      // best-effort telemetry — never blocks the state transition
    }
  }
  return { ...state, stages, stage_cursor: cursor, updated_at: new Date().toISOString() };
}
const CAPABILITY_STATUSES = ["ready", "dispatched", "joining", "complete", "invalidated"] as const;
const DISPATCH_STATUSES = ["authorized", "running", "succeeded", "failed", "cancelled"] as const;
const TERMINAL_CAPABILITY_STATUSES: Record<string, true> = { complete: true, invalidated: true };
const LIVE_DISPATCH_STATUSES: Record<string, true> = { authorized: true, running: true };

function capabilityAfterReopen(
  state: TeamState,
  targetIndex: number,
): TeamState["dispatch_capability"] {
  const capability = state.dispatch_capability;
  if (!capability) return undefined;
  const issuedFor = capability.issued_for;
  if (!issuedFor || typeof issuedFor.stage_cursor !== "string" || !issuedFor.stage_cursor.trim()) {
    throw new Error("cannot reopen workflow with an invalid dispatch capability binding");
  }
  if (typeof capability.status !== "string" || !CAPABILITY_STATUSES.includes(capability.status as typeof CAPABILITY_STATUSES[number])) {
    throw new Error("cannot reopen workflow with an invalid dispatch capability status");
  }
  const expectedRunKey = state.run_key ?? state.branch;
  if (
    issuedFor.branch !== state.branch ||
    issuedFor.run_key !== expectedRunKey ||
    issuedFor.workflow !== state.classification?.workflow ||
    (state.profile_hash !== undefined && issuedFor.profile_hash !== state.profile_hash) ||
    state.stage_cursor !== issuedFor.stage_cursor ||
    (!TERMINAL_CAPABILITY_STATUSES[capability.status] && state.cursor_epoch !== undefined && state.cursor_epoch !== issuedFor.cursor_epoch)
  ) {
    throw new Error("cannot reopen workflow with a mismatched dispatch capability binding");
  }
  if (typeof capability.capability_id !== "string" || !capability.capability_id.trim() || typeof capability.dispatch_token_hash !== "string" || !/^[0-9a-f]{64}$/.test(capability.dispatch_token_hash) || typeof capability.advance_token_hash !== "string" || !/^[0-9a-f]{64}$/.test(capability.advance_token_hash)) {
    throw new Error("cannot reopen workflow with an invalid dispatch capability");
  }
  const capabilityIndex = state.stages.findIndex((stage) => stage.id === issuedFor.stage_cursor);
  if (capabilityIndex < 0) {
    throw new Error(`cannot reopen workflow with an unknown capability stage: ${issuedFor.stage_cursor}`);
  }
  if (!Array.isArray(capability.dispatches) || capability.dispatches.some((record) => !record || !DISPATCH_STATUSES.includes(record.status as typeof DISPATCH_STATUSES[number]))) {
    throw new Error("cannot reopen workflow with invalid dispatch records");
  }
  if (capabilityIndex < targetIndex) {
    if (!TERMINAL_CAPABILITY_STATUSES[capability.status]) {
      throw new Error("cannot reopen workflow while an upstream dispatch capability is active");
    }
    return capability;
  }
  if (capability.dispatches.some((record) => LIVE_DISPATCH_STATUSES[record.status])) {
    throw new Error("cannot reopen workflow while a dispatch is still resumable");
  }
  return { ...capability, status: "invalidated", dispatches: [] };
}

/**
 * Reopen a completed workflow after user feedback without losing prior state.
 * The affected stage and all downstream stages become pending; upstream
 * artifacts and stage history remain intact.
 */
export function reopenFromFeedback(
  state: TeamState,
  feedback: string,
  stageId: string,
): TeamState {
  const target = stageId;
  const index = state.stages.findIndex((stage) => stage.id === target);
  if (index < 0) throw new Error(`cannot reopen unknown stage: ${target}`);
  const history = [...(state.history ?? []), { task: state.task, feedback, at: new Date().toISOString() }];
  const stages = state.stages.map((stage, i) =>
    i >= index ? { ...stage, status: "pending" as const } : stage,
  );
  return {
    ...state,
    task: `${state.task}\n\nUser feedback: ${feedback}`,
    history,
    stages,
    stage_cursor: target,
    dispatch_capability: capabilityAfterReopen(state, index),
    pause: { kind: "none", reason: "" },
    updated_at: new Date().toISOString(),
  };
}

/**
 * Monotonic check: a stage with `pending` must not precede a stage that is
 * `done` or `in_progress`. The P4 gate in claude-plugin's validate-state.sh.
 */
export function checkMonotonic(state: TeamState): { ok: true } | { ok: false; violation: string } {
  const statuses = state.stages.map((s) => s.status ?? "pending");
  const firstPending = statuses.indexOf("pending");
  if (firstPending === -1) return { ok: true };
  const after = statuses.slice(firstPending + 1).filter((s) => s === "done" || s === "in_progress");
  if (after.length > 0) {
    return {
      ok: false,
      violation: `stage progress is not monotonic — stage ${state.stages[firstPending]?.id ?? "?"} is pending while a later stage is done/in_progress`,
    };
  }
  return { ok: true };
}

function deriveFeatureSlugFromBranch(branch: string): string | null {
  if (!branch) return null;
  return branch.replace(/\//g, "-").replace(/[^a-z0-9._-]/gi, "-").toLowerCase();
}

export function archiveStaleState(statePath: string, state: TeamState): void {
  const archiveDir = join(dirname(statePath), "..", "archive");
  try {
    mkdirSync(archiveDir, { recursive: true });
    const safeBranch = state.branch.replace(/\//g, "-").replace(/[^a-z0-9._-]/gi, "-");
    const dest = join(archiveDir, `${safeBranch}.${Date.now()}.bak.json`);
    writeFileSync(dest, JSON.stringify(state, null, 2));
  } catch {
    // best-effort
  }
}

export function listFeatures(cwd: string): string[] {
  const wsDir = resolve(cwd, WORK_STATE_DIR);
  const featuresDir = join(wsDir, "features");
  if (!existsSync(featuresDir)) return [];
  return readdirSync(featuresDir).filter((name) => {
    if (!isSafeStateSegment(name)) return false;
    const statePath = join(featuresDir, name, "state.json");
    return existsSync(statePath);
  });
}
