/**
 * Report assembly: read + normalize TeamState (schema 1) / CtoState (schema 2)
 * into the shared SessionReport model (pragmatic architecture).
 *
 * State/artifacts are authoritative; telemetry is bounded and optional.
 * Chronology uses event timestamps first, artifact mtime, state.updated_at,
 * then ordinal placement. Missing/corrupt optional inputs (telemetry, event
 * log, artifacts) produce explicit `warnings` — the only hard error is "no
 * session found", which is a caller error (nothing to report).
 *
 * Raw events/transcripts are never embedded: telemetry carries only the
 * bounded rollup + per-kind counts, and artifact bodies are redacted and
 * byte-capped.
 */

import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  readSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { PinnedProjectRoot, PinnedRootError } from "../specification/pinned-root.js";

import { isSafeStateSegment } from "../engine/state.js";
import { loadProfile } from "../engine/profile.js";
import { resolveConfig, resolveAgentForRole } from "../engine/config.js";
import type { Profile, RoleConfig, StageDef, StageStatus, TeamState } from "../engine/types.js";
import { resolveDodPath, type DodSafeFileRead } from "../engine/dod.js";
import { assessRunHealth } from "../cto/health.js";
import { loadTeamDefs } from "../cto/plan.js";
import type { CtoState, RunHealth, TeamDef, TeamRunStatus } from "../cto/types.js";
import { rollupFromEvents } from "../observability/recorder.js";
import type { ObservabilityEvent, ObservabilityPointer } from "../observability/events.js";
import { MAX_ARTIFACT_AGGREGATE_BYTES } from "../engine/artifacts.js";
import { redactReportBody, truncateUtf8 } from "./redact.js";
import {
  resolveCtoSource,
  resolveDoWorkSource,
  TEAM_ARTIFACTS_DIR,
  FEATURES_DIR,
  WORK_STATE_DIR,
} from "./session-source.js";
import type {
  BuildSessionReportOptions,
  ChronologyEvent,
  ReportArtifact,
  ReportHealth,
  ReportIntegration,
  ReportMeta,
  ReportSource,
  ReportTeam,
  ReportTelemetry,
  SessionEdge,
  SessionKind,
  SessionReport,
  SessionSelector,
  StageAgentInfo,
  StageInfo,
} from "./types.js";

// Session-source layout constants and resolution live in session-source.ts
// (single source of truth for feature/legacy/CTO discovery — architecture-2).
const DEFAULT_MAX_ARTIFACT_BYTES = 16 * 1024;
export const MIN_REPORT_ARTIFACT_BYTES = 1;
export const MAX_REPORT_ARTIFACT_BYTES = 8 * 1024 * 1024;
const MAX_EVENT_BYTES = 2 * 1024 * 1024;
const MAX_EVENT_LINES = 5000;
const MAX_PINNED_ARTIFACT_BYTES = MAX_REPORT_ARTIFACT_BYTES;
const MAX_PINNED_EVENT_BYTES = 8 * 1024 * 1024;
const SUMMARY_CAP_FACTOR = 4;

const REPORT_HTML_SHELL_BUDGET_BYTES = 4 * 1024 * 1024;
const REPORT_HTML_ESCAPED_COPY_FACTOR = 7;

/**
 * Hard UTF-8 ceiling for a persisted report document.
 *
 * Canonical artifact writers bound one artifact set to
 * `MAX_ARTIFACT_AGGREGATE_BYTES` (8 MiB).  The renderer can represent
 * sanitized artifact content twice (the escaped `<pre>` and the JSON data
 * island), with a conservative sevenfold UTF-8/escaping allowance.  A 4 MiB
 * allowance covers the fixed shell and bounded graph / metadata, yielding a
 * 60 MiB canonical-input budget.  The cap is rounded up to the pinned
 * writer's 64 MiB atomic-write ceiling; documents beyond it fail before any
 * filesystem mutation rather than being silently truncated.
 */
export const MAX_REPORT_HTML_BYTES = Math.max(
  64 * 1024 * 1024,
  REPORT_HTML_SHELL_BUDGET_BYTES + MAX_ARTIFACT_AGGREGATE_BYTES * REPORT_HTML_ESCAPED_COPY_FACTOR,
);

/** Stable fail-closed error raised before a report target is touched. */
export class ReportHtmlLimitError extends Error {
  readonly code = "REPORT_HTML_TOO_LARGE" as const;
  readonly byteLength: number;
  readonly maxBytes = MAX_REPORT_HTML_BYTES;

  constructor(byteLength: number) {
    super(
      `writeReport: report HTML exceeds ${MAX_REPORT_HTML_BYTES} UTF-8 bytes (actual ${byteLength}); code=REPORT_HTML_TOO_LARGE`,
    );
    this.name = "ReportHtmlLimitError";
    this.byteLength = byteLength;
  }
}

function assertReportHtmlWithinLimit(html: string): void {
  const byteLength = Buffer.byteLength(html, "utf8");
  if (byteLength > MAX_REPORT_HTML_BYTES) throw new ReportHtmlLimitError(byteLength);
}
function pinnedRegularRelative(pin: PinnedProjectRoot, filePath: string): string | null {
  const relativePath = pin.relativePath(filePath);
  if (!relativePath) return null;
  try {
    return pin.pathEntryInfo(relativePath)?.kind === "file" ? relativePath : null;
  } catch {
    return null;
  }
}

// ── Session selection ───────────────────────────────────────────────────────

interface DoWorkResolved {
  id: string;
  state: TeamState;
  statePath: string;
  stateDir: string;
  artifactsDir: string;
  isLegacy: boolean;
  isStale?: boolean;
}

interface CtoResolved {
  id: string;
  state: CtoState;
  statePath: string | null;
  runDir: string;
  format: "json" | "markdown";
}

/** Resolve a do-work TeamState; null when not found (id probe or empty work-state). */
function resolveDoWork(cwd: string, id: string | undefined, pin: PinnedProjectRoot): DoWorkResolved | null {
  return resolveDoWorkSource(cwd, id, pin);
}

/** Resolve a CTO run; null when not found (id probe or no runs). */
function resolveCto(cwd: string, id: string | undefined, pin: PinnedProjectRoot): CtoResolved | null {
  return resolveCtoSource(cwd, id, pin);
}

/** Auto-detect: the newest of the best do-work state and best CTO run. */
function guessKind(cwd: string, id: string | undefined, pin: PinnedProjectRoot): SessionKind {
  if (id) {
    if (resolveDoWork(cwd, id, pin)) return "do-work";
    if (resolveCto(cwd, id, pin)) return "cto";
    throw new Error(`no do-work or cto session found for id "${id}" under ${resolve(cwd, WORK_STATE_DIR)}`);
  }
  const dw = resolveDoWork(cwd, undefined, pin);
  const cto = resolveCto(cwd, undefined, pin);
  if (dw && cto) return cto.state.updated_at > dw.state.updated_at ? "cto" : "do-work";
  if (dw) return "do-work";
  if (cto) return "cto";
  throw new Error(`no do-work or cto session found under ${resolve(cwd, WORK_STATE_DIR)}`);
}

// ── Entry point ─────────────────────────────────────────────────────────────

function validateReportOptions(options: BuildSessionReportOptions): void {
  const value = options.maxArtifactBytes;
  if (value === undefined) return;
  if (!Number.isSafeInteger(value) || value < MIN_REPORT_ARTIFACT_BYTES || value > MAX_REPORT_ARTIFACT_BYTES) {
    throw new TypeError(
      `maxArtifactBytes must be an integer between ${MIN_REPORT_ARTIFACT_BYTES} and ${MAX_REPORT_ARTIFACT_BYTES}`,
    );
  }
}

export function buildSessionReportPinned(
  cwd: string,
  selector: SessionSelector = {},
  options: BuildSessionReportOptions = {},
  pin: PinnedProjectRoot,
): SessionReport {
  if (resolve(cwd) !== pin.lexical_root) throw new Error("project root pin does not match report cwd");
  validateReportOptions(options);
  const kind = selector.kind ?? guessKind(cwd, selector.id, pin);
  if (kind === "cto") {
    const run = resolveCto(cwd, selector.id, pin);
    if (!run) {
      const id = selector.id ?? "latest";
      throw new Error(`cto session "${id}" not found (no state.json and no markdown fallback)`);
    }
    return assembleCto(cwd, run, options, pin);
  }
  const dw = resolveDoWork(cwd, selector.id, pin);
  if (!dw) {
    const id = selector.id ?? "latest";
    throw new Error(`do-work session "${id}" not found (no per-feature or legacy state.json)`);
  }
  return assembleDoWork(cwd, dw, options, pin);
}

export function buildSessionReport(
  cwd: string,
  selector: SessionSelector = {},
  options: BuildSessionReportOptions = {},
): SessionReport {
  validateReportOptions(options);
  const pin = PinnedProjectRoot.open(cwd);
  if (!pin) throw new Error("project root cannot be pinned for report read");
  try {
    return buildSessionReportPinned(cwd, selector, options, pin);
  } finally {
    pin.close();
  }
}

// ── Stage provenance (agents / inputs / outputs) ────────────────────────────

/**
 * Truthful entry for orchestrator stages: they run in the main session, not
 * via a spawned role. The literal descriptor avoids inventing an agent/model.
 */
const ORCHESTRATOR_AGENT: StageAgentInfo = { name: "main session", role: "orchestrator", source: "workflow" };

/**
 * True when a role is still an unresolved `${scope.*}` template. The stage
 * runner resolves these from a touched-file scope scan at execution time;
 * the report deliberately performs no such scan, so a template role cannot
 * be resolved to a truthful agent here. Such roles are unavailable — never
 * guessed, and the literal placeholder is never emitted.
 */
function isUnresolvedTemplateRole(role: string): boolean {
  return role.includes("${");
}

/**
 * Optional profile metadata copied verbatim from `StageDef` — the stage
 * detail the renderer shows under a disclosure. Only declared fields with
 * non-empty values are emitted; custom/legacy stages (no def) keep every
 * field absent. Profile/config metadata only — never raw prompts, event
 * data, unbounded artifact content, or rendered document bodies (the
 * `document` entry carries the typed format/renderer/path contract only).
 */
function stageProfileMeta(
  def: StageDef | undefined,
): Partial<Pick<StageInfo, "description" | "checkpoint" | "gate" | "autonomous" | "document">> {
  if (!def) return {};
  return {
    ...(def.description ? { description: def.description } : {}),
    ...(def.checkpoint ? { checkpoint: def.checkpoint } : {}),
    ...(def.gate ? { gate: def.gate } : {}),
    ...(def.autonomous ? { autonomous: def.autonomous } : {}),
    ...(def.document ? { document: def.document } : {}),
  };
}

const STAGE_PROMPT_PREVIEW_MAX_CHARS = 4096;
// Task text is the largest variable in a preview: clip it before the
// stage-specific lines are appended so a multi-KB task cannot crowd the
// agents/inputs/outputs/checkpoint/gate/autonomous metadata past the cap.
const STAGE_PROMPT_TASK_MAX_CHARS = 1024;

/** Clip `text` to at most `max` chars; the `…` marker counts toward `max`. */
function clipTo(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/**
 * Bounded, deterministic reconstruction of the shape of a stage prompt.
 * This is explicitly NOT the literal runtime prompt — per-stage task text is
 * generated dynamically by the agent run and is never persisted, so the
 * preview is assembled only from persisted metadata: the stage definition
 * (title/id/type, declared input/output ids, checkpoint/gate/autonomous),
 * the session task, and truthful resolved agent/role provenance. Raw
 * artifact JSON, event/transcript data, tool arguments, and secrets are
 * never interpolated. Roles that remain unresolved `${scope.*}` templates
 * are omitted (the caller passes the same roster `stageAgents` resolved, so
 * no resolved agent is ever claimed where no scope evidence exists).
 */
function stagePromptPreview(def: StageDef, task: string, agents: StageAgentInfo[] | undefined): string {
  const lines = [`${def.title} [${def.id}] type: ${def.type}`];
  if (task) lines.push(`task: ${clipTo(task, STAGE_PROMPT_TASK_MAX_CHARS)}`);
  if (agents && agents.length > 0) {
    lines.push(
      `agents: ${agents
        .map((a) => (a.role && a.role !== a.name ? `${a.role} -> ${a.name}` : a.name))
        .join(", ")}`,
    );
  }
  const consumes = asList(def.consumes);
  if (consumes.length > 0) lines.push(`inputs: ${consumes.join(", ")}`);
  const produces = asList(def.produces);
  if (produces.length > 0) lines.push(`outputs: ${produces.join(", ")}`);
  if (def.checkpoint) lines.push(`checkpoint: ${def.checkpoint}`);
  if (def.gate) lines.push(`gate: ${def.gate}`);
  if (def.autonomous) lines.push(`autonomous: ${def.autonomous}`);
  const text = lines.join("\n");
  // Strict final cap: the `…` marker is counted inside the budget, so the
  // preview never exceeds STAGE_PROMPT_PREVIEW_MAX_CHARS characters.
  return clipTo(text, STAGE_PROMPT_PREVIEW_MAX_CHARS);
}

/**
 * Provenance for a profile stage. `source` is always "workflow": the entry
 * is derived from the loaded profile + resolved role config. Runtime
 * observations (global agent/tool counts) are never stage-correlated here
 * and are therefore never claimed. Returns undefined when no truthful roster
 * exists (custom/legacy stages, def without roles, or a roster of only
 * unresolved template roles).
 */
function stageAgents(def: StageDef, config: RoleConfig): StageAgentInfo[] | undefined {
  if (def.type === "orchestrator") return [ORCHESTRATOR_AGENT];
  const roster = effectiveRoster(def, config);
  if (roster.length === 0) return undefined;
  return roster.map((role) => ({
    name: resolveAgentForRole(role, config),
    role,
    source: "workflow" as const,
  }));
}

/**
 * Effective role roster for a stage: profile roles (consilium `roles` /
 * single `role`) + configured `roster_overrides` (replace/add/remove) from
 * team.config.json. Profile `conditional` additions (`if: scope.has_…`) are
 * NOT evaluated — scope needs a file scan the report does not have, so they
 * are only applied when the project config declares them statically. Roles
 * that remain unresolved `${scope.*}` templates are dropped for the same
 * reason: the report cannot claim an agent it has no scope evidence for.
 */
function effectiveRoster(def: StageDef, config: RoleConfig): string[] {
  let roster: string[];
  if (def.roles && def.roles.length > 0) roster = [...def.roles];
  else if (def.role) roster = [def.role];
  else return [];
  const override = config.roster_overrides?.[def.id];
  if (override) {
    if (Array.isArray(override.replace)) roster = [...override.replace];
    if (Array.isArray(override.add)) roster.push(...override.add);
    if (Array.isArray(override.remove)) roster = roster.filter((r) => !override.remove!.includes(r));
  }
  return roster.filter((r) => !isUnresolvedTemplateRole(r));
}

/**
 * Lead provenance for a CTO team stage, from the consumer-owned
 * `.omp/teams.json` registry (`loadTeamDefs` — missing/malformed → no
 * entries, never throws). No registry entry → undefined: the lead agent is
 * not invented. The `lead` is a configured agent name, never a model claim.
 */
function teamLeadAgents(teamId: string, teamDefs: Map<string, TeamDef>): StageAgentInfo[] | undefined {
  const def = teamDefs.get(teamId);
  if (!def) return undefined;
  return [{ name: def.lead, role: "team-lead", source: "workflow" as const }];
}

// ── do-work assembly ────────────────────────────────────────────────────────
function assembleDoWork(cwd: string, r: DoWorkResolved, options: BuildSessionReportOptions, pin: PinnedProjectRoot): SessionReport {
  const warnings: string[] = [];
  const state = r.state;
  const profile = loadProfile(state.classification.workflow);
  const stageDefs = new Map<string, StageDef>();
  if (profile) for (const s of profile.stages) stageDefs.set(s.id, s);
  const config = resolveConfig(cwd);

  const { telemetry, events } = doWorkTelemetry(cwd, r, warnings, pin);
  const stageEventTimes = latestTransitionTimes(events, (e) => e.stageId);
  const artifactEventTimes = latestTransitionTimes(events, (e) => e.artifactId);

  // Artifacts first — stage `at` falls back to the produced artifact's time.
  const declaredProduces = new Map<string, string>(); // artifactId -> owner stage
  if (profile) {
    for (const s of profile.stages) for (const id of asList(s.produces)) declaredProduces.set(id, s.id);
  }
  const artifacts: ReportArtifact[] = [];
  const artifactMtimes = new Map<string, string>(); // artifactId -> iso
  const builtIds = new Set<string>();

  const pushArtifact = (input: ArtifactInput) => {
    if (builtIds.has(input.id)) return;
    builtIds.add(input.id);
    const art = buildArtifact(input, options, warnings, pin);
    artifacts.push(art);
    if (art.mtime) artifactMtimes.set(input.id, art.mtime);
  };

  for (const [artifactId, ownerStage] of declaredProduces) {
    const stageStatus = state.stages.find((s) => s.id === ownerStage)?.status ?? "pending";
    const filePath = artifactFilePath(cwd, r, artifactId);
    pushArtifact({
      id: artifactId,
      owner: ownerStage,
      filePath,
      status: !filePath || pinnedRegularRelative(pin, filePath) === null ? (stageStatus === "skipped" ? "skipped" : "missing") : "produced",
    });
  }
  // Undeclared artifacts agents wrote directly (honest extras).
  const artifactsRelative = pin.relativePath(r.artifactsDir);
  if (artifactsRelative && pin.pathEntryInfo(artifactsRelative)?.kind === "directory") {
    try {
      for (const file of pin.listDirectory(artifactsRelative, { maxEntries: 4096, maxNameBytes: 512 * 1024 })) {
        if (!file.endsWith(".json")) continue;
        const artifactId = file.replace(/\.json$/, "");
        if (declaredProduces.has(artifactId)) continue;
        const filePath = join(r.artifactsDir, file);
        if (pinnedRegularRelative(pin, filePath) === null) continue;
        pushArtifact({ id: artifactId, owner: "extra", filePath, status: "produced" });
      }
    } catch {
      warnings.push(`artifacts dir unreadable: ${r.artifactsDir}`);
    }
  }

  const stages: StageInfo[] = (state.stages ?? []).map((s) => {
    const def = stageDefs.get(s.id);
    const produced = declaredProduces.size > 0
      ? [...declaredProduces.entries()].filter(([, owner]) => owner === s.id).map(([id]) => id)
      : [];
    const artifactTime = produced.map((id) => artifactEventTimes.get(id) ?? artifactMtimes.get(id)).find(Boolean);
    const agents = def ? stageAgents(def, config) : undefined;
    return {
      id: s.id,
      title: def?.title,
      status: s.status,
      phase: state.classification.workflow,
      type: def?.type,
      at: stageEventTimes.get(s.id) ?? artifactTime ?? state.updated_at,
      // Declared artifact ids are preserved even when files are missing;
      // custom/legacy stages (no def) keep the fields absent.
      ...stageProfileMeta(def),
      ...(def ? { promptPreview: stagePromptPreview(def, state.task, agents) } : {}),
      ...(def ? { inputs: [...(def.consumes ?? [])] } : {}),
      ...(def ? { outputs: asList(def.produces) } : {}),
      ...(agents ? { agents } : {}),
    };
  });

  const edges = doWorkEdges(state, profile);

  const meta: ReportMeta = {
    title: taskTitle(state.task, state.issue),
    task: state.task,
    branch: state.branch,
    workflow: state.classification.workflow,
    classification: {
      type: state.classification.type,
      complexity: state.classification.complexity,
      confidence: state.classification.confidence,
      workflow: state.classification.workflow,
      autonomous: state.classification.autonomous,
      ...(state.classification.autonomous_reason ? { autonomous_reason: state.classification.autonomous_reason } : {}),
    },
    issue: state.issue ?? null,
    pause: state.pause,
    updated_at: state.updated_at,
    generated_at: new Date().toISOString(),
    autonomous: state.classification.autonomous,
  };

  const chronology = sortedChronology([
    ...events.flatMap((e): ChronologyEvent[] => {
      if (e.kind === "stage_transition") {
        return [{
          kind: "stage", at: e.ts, eventKind: "stage_transition",
          label: `stage ${e.stageId ?? "?"} → ${e.stageStatus ?? "?"}`,
          ref: e.stageId, source: "event" as const,
        }];
      }
      if (e.kind === "artifact_written") {
        return [{
          kind: "artifact", at: e.ts, eventKind: "artifact_written",
          label: `artifact ${e.artifactId ?? "?"} written`,
          ref: e.artifactId, source: "event" as const,
        }];
      }
      return [];
    }),
    ...artifacts
      .filter((a) => a.mtime && !artifactEventTimes.has(a.id) && a.status === "produced")
      .map((a): ChronologyEvent => ({
        kind: "artifact", at: a.mtime!, label: `artifact ${a.id} produced`, ref: a.id, source: "mtime",
      })),
    { kind: "state", at: state.updated_at, label: "state updated", source: "state" },
  ]);

  return {
    schema: 1,
    kind: "do-work",
    meta,
    source: {
      kind: "do-work",
      id: r.id,
      statePath: r.statePath,
      format: "json",
      isLegacy: r.isLegacy,
      isStale: r.isStale,
      stateDir: r.stateDir,
      artifactsDir: r.artifactsDir,
    } satisfies ReportSource,
    stages,
    edges,
    artifacts,
    telemetry,
    chronology,
    warnings,
  };
}

function doWorkEdges(state: TeamState, profile: Profile | null): SessionEdge[] {
  const edges: SessionEdge[] = [];
  if (profile) {
    for (const s of profile.stages) {
      for (const id of asList(s.produces)) edges.push({ from: s.id, to: id, kind: "produces" });
      for (const id of s.consumes ?? []) edges.push({ from: id, to: s.id, kind: "consumes" });
    }
    return edges;
  }
  // No profile for this workflow (custom/legacy) — ordinal transition spine.
  for (let i = 0; i < state.stages.length - 1; i++) {
    edges.push({ from: state.stages[i]!.id, to: state.stages[i + 1]!.id, kind: "transition" });
  }
  return edges;
}

// ── CTO assembly ────────────────────────────────────────────────────────────

function assembleCto(cwd: string, r: CtoResolved, options: BuildSessionReportOptions, pin: PinnedProjectRoot): SessionReport {
  const warnings: string[] = [];
  const state = r.state;
  const profile = loadProfile("cto");
  const stageDefs = new Map<string, StageDef>();
  if (profile) for (const s of profile.stages) stageDefs.set(s.id, s);
  const config = resolveConfig(cwd);
  const teamDefs = new Map(loadTeamDefs(cwd).map((d) => [d.id, d]));

  const { telemetry, events } = ctoTelemetry(cwd, r, warnings, pin);
  const teamIds = new Set(state.teams.map((t) => t.id));
  const relevant = events.filter(
    (e) => e.runId === r.id || (e.runId === undefined && teamIds.has(e.stageId ?? "")),
  );
  const teamEventTimes = latestTransitionTimes(relevant, (e) => e.stageId);
  const artifactEventTimes = latestTransitionTimes(relevant, (e) => e.artifactId);

  // Teams / integration / health first — stages derive from them.
  const planByTeam = new Map(state.plan.teams.map((t) => [t.team, t]));
  const teams: ReportTeam[] = state.teams.map((t) => {
    const plan = planByTeam.get(t.id);
    return {
      id: t.id,
      status: t.status,
      ...(plan?.scope ? { scope: plan.scope } : {}),
      ...(plan?.slice ? { slice: plan.slice } : {}),
      ...(plan?.profile ? { profile: plan.profile } : {}),
      ...(plan?.worktree ? { worktree: plan.worktree } : {}),
      ...(plan?.depends_on ? { depends_on: plan.depends_on } : {}),
      ...(t.dod_path ? { dod_path: t.dod_path } : {}),
      escalations: Object.keys(t.escalations).length,
    };
  });
  const integration: ReportIntegration = { status: state.integration.status, ...(state.integration.note ? { note: state.integration.note } : {}) };
  const health: ReportHealth = mapHealth(state.health ?? assessRunHealth(state));

  const stages: StageInfo[] = [];
  for (const def of profile?.stages ?? []) {
    const agents = stageAgents(def, config);
    stages.push({
      id: def.id,
      title: def.title,
      status: ctoStageStatus(state, def.id),
      phase: "cto",
      type: def.type,
      at: teamEventTimes.get(def.id) ?? state.updated_at,
      ...stageProfileMeta(def),
      promptPreview: stagePromptPreview(def, state.task, agents),
      inputs: [...(def.consumes ?? [])],
      outputs: asList(def.produces),
      ...(agents ? { agents } : {}),
    });
  }
  for (const t of state.teams) {
    const agents = teamLeadAgents(t.id, teamDefs);
    stages.push({
      id: `team:${t.id}`,
      title: `Team ${t.id}`,
      status: t.status,
      phase: "cto",
      type: "team",
      team: t.id,
      at: teamEventTimes.get(t.id) ?? state.updated_at,
      ...(agents ? { agents } : {}),
    });
  }

  const edges = ctoEdges(state, profile);

  const { artifacts, artifactMtimes } = ctoArtifacts(cwd, state, options, warnings, pin);

  const meta: ReportMeta = {
    title: taskTitle(state.task, null),
    task: state.task,
    branch: state.branch,
    ...(state.classification ? { workflow: "cto", classification: state.classification } : {}),
    issue: null,
    pause: state.pause,
    updated_at: state.updated_at,
    generated_at: new Date().toISOString(),
    autonomous: state.autonomous,
    ...(state.standby === true ? { standby: true } : {}),
    ...(state.owner_session ? { owner_session: state.owner_session } : {}),
    ...(state.amended_at ? { amended_at: state.amended_at } : {}),
  };

  const chronology = sortedChronology([
    ...relevant.flatMap((e): ChronologyEvent[] => {
      if (e.kind === "stage_transition") {
        return [{
          kind: "team", at: e.ts, eventKind: "stage_transition",
          label: `team ${e.stageId ?? "?"} → ${e.stageStatus ?? "?"}`,
          ref: e.stageId, source: "event" as const,
        }];
      }
      if (e.kind === "artifact_written") {
        return [{
          kind: "artifact", at: e.ts, eventKind: "artifact_written",
          label: `artifact ${e.artifactId ?? "?"} written`,
          ref: e.artifactId, source: "event" as const,
        }];
      }
      return [];
    }),
    ...state.teams
      .filter((t) => !teamEventTimes.has(t.id))
      .map((t): ChronologyEvent => ({
        kind: "team", at: state.updated_at, label: `team ${t.id} → ${t.status}`, ref: t.id, source: "state",
      })),
    ...artifacts
      .filter((a) => a.mtime && !artifactEventTimes.has(a.id) && a.status === "produced")
      .map((a): ChronologyEvent => ({
        kind: "artifact", at: a.mtime!, label: `artifact ${a.id} produced`, ref: a.id, source: "mtime",
      })),
    { kind: "integration", at: state.updated_at, label: `integration ${state.integration.status}`, source: "state" },
    { kind: "state", at: state.updated_at, label: "state updated", source: "state" },
  ]);

  return {
    schema: 1,
    kind: "cto",
    meta,
    source: {
      kind: "cto",
      id: r.id,
      statePath: r.statePath,
      format: r.format,
      isLegacy: false,
      stateDir: r.runDir,
    } satisfies ReportSource,
    stages,
    edges,
    artifacts,
    teams,
    integration,
    health,
    telemetry,
    chronology,
    warnings,
  };
}

/** Deterministic CTO workflow-stage status derived from CtoState (no stages array). */
function ctoStageStatus(state: CtoState, stageId: string): StageInfo["status"] {
  switch (stageId) {
    case "cto_discovery":
      return state.standby ? "pending" : "done";
    case "decomposition":
      if (state.plan.teams.length > 0) return "done";
      return state.standby ? "pending" : "in_progress";
    case "architecture":
      return state.teams.some((t) => t.status !== "pending") ? "done" : "pending";
    case "teams":
      if (state.teams.length === 0) return "not_started";
      if (state.teams.some((t) => t.status === "in_progress")) return "in_progress";
      if (state.teams.some((t) => t.status === "parked")) return "parked";
      if (state.teams.some((t) => t.status === "failed")) return "failed";
      if (state.teams.every((t) => t.status === "done")) return "done";
      return "pending";
    case "integration_review":
      return state.integration.status;
    case "cto_summary":
      return state.integration.status === "done" ? "done" : "pending";
    default:
      return "not_started";
  }
}

function ctoEdges(state: CtoState, profile: Profile | null): SessionEdge[] {
  const edges: SessionEdge[] = [];
  if (profile) {
    for (const s of profile.stages) {
      for (const id of asList(s.produces)) edges.push({ from: s.id, to: id, kind: "produces" });
      for (const id of s.consumes ?? []) edges.push({ from: id, to: s.id, kind: "consumes" });
    }
  } else {
    const chain = ["cto_discovery", "decomposition", "architecture", "teams", "integration_review", "cto_summary"];
    for (let i = 0; i < chain.length - 1; i++) {
      edges.push({ from: chain[i]!, to: chain[i + 1]!, kind: "transition" });
    }
  }
  for (const entry of state.plan.teams) {
    for (const dep of entry.depends_on ?? []) {
      edges.push({ from: `team:${dep}`, to: `team:${entry.team}`, kind: "depends_on", label: "depends_on" });
    }
    edges.push({ from: `team:${entry.team}`, to: "integration_review", kind: "integration" });
  }
  return edges;
}

/** Team artifacts under `.work-state/artifacts/<teamId>/` + each team's dod_path. */
function ctoArtifacts(
  cwd: string,
  state: CtoState,
  options: BuildSessionReportOptions,
  warnings: string[],
  pin: PinnedProjectRoot,
): { artifacts: ReportArtifact[]; artifactMtimes: Map<string, string> } {
  const artifacts: ReportArtifact[] = [];
  const artifactMtimes = new Map<string, string>();
  const seen = new Set<string>();
  for (const team of state.teams) {
    const dir = join(cwd, WORK_STATE_DIR, TEAM_ARTIFACTS_DIR, team.id);
    // Canonical team DoD FIRST (the configured dod_path, else the default
    // team artifacts dir): read ONCE through the fd-bound safe read. The
    // generic scan below never pathname-reads dod.json — the canonical
    // result replaces it (owner-scoped first-wins via the seen key).
    const canonical = resolveDodPath(cwd, team.dod_path, team.id);
    if (!canonical.ok) {
      warnings.push(`team ${team.id} dod_path unusable: ${canonical.reason}`);
      seen.add(`${team.id}/dod`);
    } else {
      const canonicalRelative = pinnedRegularRelative(pin, canonical.file);
      if (!canonicalRelative) {
        if (pin.relativePath(canonical.file) !== null && pin.pathEntryInfo(pin.relativePath(canonical.file)!)?.kind !== undefined) {
          warnings.push(`artifact dod (${team.id}) unreadable: path is not a regular in-project file`);
        }
      } else {
        const art = buildArtifact({ id: "dod", owner: team.id, filePath: canonical.file, status: "produced" }, options, warnings, pin);
        artifacts.push(art);
        if (art.mtime) artifactMtimes.set("dod", art.mtime);
      }
      seen.add(`${team.id}/dod`);
    }
    const relativeDir = pin.relativePath(dir);
    if (relativeDir && pin.pathEntryInfo(relativeDir)?.kind === "directory") {
      try {
        for (const file of pin.listDirectory(relativeDir, { maxEntries: 4096, maxNameBytes: 512 * 1024 })) {
          if (!file.endsWith(".json")) continue;
          const artifactId = file.replace(/\.json$/, "");
          const key = `${team.id}/${artifactId}`;
          if (seen.has(key)) continue;
          seen.add(key);
          const filePath = join(dir, file);
          if (pinnedRegularRelative(pin, filePath) === null) continue;
          const art = buildArtifact({ id: artifactId, owner: team.id, filePath, status: "produced" }, options, warnings, pin);
          artifacts.push(art);
          if (art.mtime) artifactMtimes.set(artifactId, art.mtime);
        }
      } catch {
        warnings.push(`team artifacts dir unreadable: ${dir}`);
      }
    }
  }
  return { artifacts, artifactMtimes };
}

function mapHealth(h: RunHealth): ReportHealth {
  return {
    healthy: h.healthy,
    issues: h.issues,
    budget_status: h.budget_status,
    active_teams: h.active_teams,
    parked_teams: h.parked_teams,
    failed_teams: h.failed_teams,
    pending_escalations: h.pending_escalations,
  };
}

// ── Artifacts ───────────────────────────────────────────────────────────────

interface ArtifactInput {
  id: string;
  owner: string;
  filePath: string | null;
  status: "produced" | "missing" | "skipped";
}

function buildArtifact(
  input: ArtifactInput,
  options: BuildSessionReportOptions,
  warnings: string[],
  pin: PinnedProjectRoot,
): ReportArtifact {
  const maxBytes = options.maxArtifactBytes ?? DEFAULT_MAX_ARTIFACT_BYTES;
  const base: ReportArtifact = {
    id: input.id,
    path: input.filePath ?? input.id,
    owner: input.owner,
    status: input.status,
  };
  if (!input.filePath) {
    base.summary = input.status === "skipped" ? "skipped — artifact not produced" : "not produced";
    return base;
  }
  const relativePath = pinnedRegularRelative(pin, input.filePath);
  if (!relativePath) {
    base.summary = input.status === "skipped" ? "skipped — artifact not produced" : "not produced";
    return base;
  }
  try {
    const read = pin.readFile(relativePath, { maxBytes: MAX_PINNED_ARTIFACT_BYTES });
    const raw = new TextDecoder("utf-8", { fatal: true }).decode(read.bytes);
    const summaryCap = Math.max(maxBytes * SUMMARY_CAP_FACTOR, 64 * 1024);
    return finishArtifact(
      base,
      input,
      truncateUtf8(raw, summaryCap),
      read.bytes.byteLength,
      pin.pathEntryInfo(relativePath)?.mtimeMs ?? null,
      maxBytes,
      options,
      warnings,
    );
  } catch {
    warnings.push(`artifact ${input.id} (${input.owner}) unreadable`);
    base.summary = "unreadable artifact";
    return base;
  }

}
/**
 * Assemble the report artifact from a SAFE fd-bound DoD read result: content,
 * size and mtime come from the safe read — the resolved pathname is never
 * reopened. Content beyond the summary cap is truncated exactly like the
 * path-based reader (readBounded) so capped files keep the same diagnostics.
 */
function buildArtifactFromRead(
  input: ArtifactInput,
  read: Extract<DodSafeFileRead, { ok: true }>,
  options: BuildSessionReportOptions,
  warnings: string[],
): ReportArtifact {
  const maxBytes = options.maxArtifactBytes ?? DEFAULT_MAX_ARTIFACT_BYTES;
  const summaryCap = Math.max(maxBytes * SUMMARY_CAP_FACTOR, 64 * 1024);
  const base: ReportArtifact = { id: input.id, path: input.filePath ?? input.id, owner: input.owner, status: input.status };
  const raw =
    truncateUtf8(read.raw, summaryCap);
  return finishArtifact(base, input, raw, read.bytes, read.mtimeMs, maxBytes, options, warnings);
}

/** Shared tail: bytes/mtime stamping, bounded parse, summary and body. */
function finishArtifact(
  base: ReportArtifact,
  input: ArtifactInput,
  raw: string,
  size: number,
  mtimeMs: number | null,
  maxBytes: number,
  options: BuildSessionReportOptions,
  warnings: string[],
): ReportArtifact {
  base.bytes = size;
  if (mtimeMs !== null) base.mtime = new Date(mtimeMs).toISOString();
  let data: unknown = null;
  try {
    data = JSON.parse(raw);
  } catch {
    warnings.push(`artifact ${input.id} (${input.owner}) is not valid JSON (or exceeds the summary cap)`);
    base.summary = "unreadable artifact (not JSON)";
    return base;
  }
  const { summary, type, keys } = summarizeArtifact(data);
  base.summary = redactReportBody(summary, 500);
  if (type) base.type = type;
  if (keys && keys.length > 0) base.keys = keys;
  if (options.includeFullArtifacts) {
    if (size > maxBytes) {
      warnings.push(`artifact ${input.id} truncated to ${maxBytes} bytes (maxArtifactBytes)`);
    }
    base.body = redactReportBody(raw, maxBytes);
  }
  return base;
}

function artifactFilePath(cwd: string, r: DoWorkResolved, artifactId: string): string | null {
  const mapped = r.state.artifacts?.[artifactId];
  if (mapped) return resolveArtifactPath(cwd, mapped);
  return join(r.artifactsDir, `${artifactId}.json`);
}

/**
 * Resolve a persisted artifact reference from `TeamState.artifacts`.
 *
 * The do-work orchestration stamps state-relative refs
 * (`features/<slug>/artifacts/<id>.json`, `artifacts/<id>.json`) rooted at
 * `.work-state` — the engine's per-feature layout (`writeState`). Accepted:
 * - absolute paths — kept as-is;
 * - `.work-state/…` — cwd-relative (CTO `dod_path` / legacy-root style);
 * - any other relative form — resolved against `.work-state`.
 * References escaping `.work-state` (e.g. `../../…`) are rejected (null).
 */
function resolveArtifactPath(cwd: string, ref: string): string | null {
  if (isAbsolute(ref)) return ref;
  if (ref === WORK_STATE_DIR || ref.startsWith(`${WORK_STATE_DIR}/`) || ref.startsWith(`${WORK_STATE_DIR}${sep}`)) {
    return resolve(cwd, ref);
  }
  const wsRoot = resolve(cwd, WORK_STATE_DIR);
  const candidate = resolve(wsRoot, ref);
  const rel = relative(wsRoot, candidate);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null;
  return candidate;
}

function summarizeArtifact(data: unknown): { summary: string; type?: string; keys?: string[] } {
  if (data === null || data === undefined) return { summary: "empty artifact" };
  if (typeof data === "string") {
    const t = data.trim();
    return { summary: t ? (t.length > 200 ? `${t.slice(0, 200)}…` : t) : "empty artifact" };
  }
  if (Array.isArray(data)) return { summary: `array (${data.length} items)` };
  if (typeof data === "object") {
    const obj = data as Record<string, unknown>;
    const type = typeof obj.type === "string" && obj.type ? obj.type : undefined;
    const keys = Object.keys(obj).slice(0, 16);
    const title = typeof obj.title === "string" ? obj.title : undefined;
    const own = typeof obj.summary === "string" ? obj.summary : undefined;
    return {
      summary: title ?? own ?? (type ? `${type} artifact (${keys.length} fields)` : `artifact (${keys.length} fields)`),
      ...(type ? { type } : {}),
      ...(keys.length > 0 ? { keys } : {}),
    };
  }
  return { summary: String(data) };
}

// ── Telemetry (bounded; never raw events) ───────────────────────────────────

function doWorkTelemetry(
  cwd: string,
  r: DoWorkResolved,
  warnings: string[],
  pin: PinnedProjectRoot,
): { telemetry: ReportTelemetry; events: ObservabilityEvent[] } {
  const slug = r.isLegacy ? (deriveFeatureSlug(r.state.branch) ?? "default") : r.id;
  let pointer = r.state.observability as ObservabilityPointer | undefined;
  if (!pointer) {
    const relativePath = join(WORK_STATE_DIR, FEATURES_DIR, slug, "observability", "events.jsonl");
    if (pin.pathEntryInfo(relativePath)?.kind === "file") {
      pointer = { eventsPath: "observability/events.jsonl", lastEventId: "", rollupThroughId: "", rollup: rollupFromEvents([]) };
    }
  }
  if (!pointer) {
    warnings.push("no telemetry available for this session");
    return { telemetry: { rollup: null }, events: [] };
  }
  return buildTelemetry(cwd, slug, pointer, warnings, pin);

}
const CTO_TELEMETRY_POINTER = "pointer.json";
const CTO_TELEMETRY_EVENTS = "events.jsonl";
const CTO_TELEMETRY_MAX_POINTER_BYTES = 64 * 1024;

function ctoTelemetryEmpty(warnings: string[], reason: string): { telemetry: ReportTelemetry; events: ObservabilityEvent[] } {
  warnings.push(reason);
  return { telemetry: { rollup: null }, events: [] };
}

function ctoIdentityField(record: Record<string, unknown>, names: readonly string[]): string | undefined {
  for (const name of names) {
    const value = record[name];
    if (value !== undefined) return typeof value === "string" ? value : undefined;
  }
  return undefined;
}

function parseCtoTelemetryPointer(
  bytes: Uint8Array,
  runId: string,
  sessionId: string,
): { pointer: ObservabilityPointer; eventsPath: string } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const envelope = parsed as Record<string, unknown>;
  const nested = envelope.pointer;
  const pointer = nested && typeof nested === "object" && !Array.isArray(nested)
    ? nested as Record<string, unknown>
    : envelope;
  const pointerRunId = ctoIdentityField(envelope, ["cto_run_id", "run_id", "runId"])
    ?? ctoIdentityField(pointer, ["cto_run_id", "run_id", "runId"]);
  const pointerSessionId = ctoIdentityField(envelope, ["session_id", "sessionId"])
    ?? ctoIdentityField(pointer, ["session_id", "sessionId"]);
  if ((pointerRunId !== undefined && pointerRunId !== runId)
    || (pointerSessionId !== undefined && pointerSessionId !== sessionId)) return null;
  const rawEventsPath = pointer.eventsPath ?? pointer.events_path;
  if (rawEventsPath !== "observability/events.jsonl"
    || typeof pointer.lastEventId !== "string"
    || typeof pointer.rollupThroughId !== "string"
    || !pointer.rollup || typeof pointer.rollup !== "object" || Array.isArray(pointer.rollup)) return null;
  return {
    pointer: pointer as unknown as ObservabilityPointer,
    eventsPath: rawEventsPath,
  };
}

function ctoTelemetry(
  cwd: string,
  r: CtoResolved,
  warnings: string[],
  pin: PinnedProjectRoot,
): { telemetry: ReportTelemetry; events: ObservabilityEvent[] } {
  const sessionId = r.state.owner_session;
  if (typeof sessionId !== "string" || !isSafeStateSegment(sessionId) || Buffer.byteLength(sessionId, "utf8") > 128) {
    return ctoTelemetryEmpty(warnings, "no telemetry available for this CTO run (owner session identity is missing or invalid)");
  }
  const sessionRoot = join(WORK_STATE_DIR, FEATURES_DIR, sessionId, "observability");
  const pointerPath = join(sessionRoot, CTO_TELEMETRY_POINTER);
  let pointerBytes: Uint8Array;
  try {
    if (!pin.isStable() || pin.pathEntryInfo(pointerPath)?.kind !== "file") {
      return ctoTelemetryEmpty(warnings, "no telemetry available for this CTO run (session pointer is missing)");
    }
    pointerBytes = pin.readFile(pointerPath, { maxBytes: CTO_TELEMETRY_MAX_POINTER_BYTES }).bytes;
    if (!pin.isStable()) throw new PinnedRootError("changed", "pinned project root changed after CTO telemetry pointer read");
  } catch {
    return ctoTelemetryEmpty(warnings, "CTO telemetry pointer is unreadable or changed");
  }
  const parsed = parseCtoTelemetryPointer(pointerBytes, r.id, sessionId);
  if (!parsed) return ctoTelemetryEmpty(warnings, "CTO telemetry pointer is malformed or belongs to another run/session");
  const eventsPath = join(sessionRoot, CTO_TELEMETRY_EVENTS);
  let allEvents: ObservabilityEvent[];
  try {
    allEvents = readEventsBounded(pin, eventsPath, warnings);
    if (!pin.isStable()) throw new PinnedRootError("changed", "pinned project root changed after CTO telemetry read");
  } catch {
    return ctoTelemetryEmpty(warnings, "CTO telemetry event log is unreadable or changed");
  }
  const events = allEvents.filter((event) =>
    event.runId === r.id && (event.sessionId === undefined || event.sessionId === sessionId),
  );
  const eventCounts: Record<string, number> = {};
  for (const event of events) eventCounts[event.kind] = (eventCounts[event.kind] ?? 0) + 1;
  return {
    telemetry: {
      eventsPath,
      lastEventId: parsed.pointer.lastEventId,
      rollup: events.length > 0 ? rollupFromEvents(events) : null,
      eventCounts,
    },
    events,
  };
}

function buildTelemetry(
  cwd: string,
  slug: string,
  pointer: ObservabilityPointer,
  warnings: string[],
  pin: PinnedProjectRoot,
): { telemetry: ReportTelemetry; events: ObservabilityEvent[] } {
  const eventsPath = resolve(cwd, WORK_STATE_DIR, "features", slug, pointer.eventsPath);
  const relativePath = pin.relativePath(eventsPath);
  const events = relativePath ? readEventsBounded(pin, relativePath, warnings) : [];
  if (!relativePath) warnings.push("event log path is outside the pinned project root");
  const eventCounts: Record<string, number> = {};
  for (const e of events) eventCounts[e.kind] = (eventCounts[e.kind] ?? 0) + 1;
  return {
    telemetry: {
      eventsPath: pointer.eventsPath,
      lastEventId: pointer.lastEventId,
      rollup: pointer.rollup ?? rollupFromEvents(events),
      eventCounts,
    },
    events,
  };

}
function readEventsBounded(pin: PinnedProjectRoot, relativePath: string, warnings: string[]): ObservabilityEvent[] {
  let text: string;
  let startsMidLine = false;
  try {
    const info = pin.pathEntryInfo(relativePath);
    if (!info) {
      warnings.push("event log missing — chronology falls back to artifact mtime/state timestamps");
      return [];
    }
    if (info.kind !== "file") throw new PinnedRootError("not_regular", "event log is not a regular file");
    const read = pin.readFile(relativePath, { maxBytes: MAX_PINNED_EVENT_BYTES });
    const bytes = Buffer.from(read.bytes);
    if (bytes.byteLength > MAX_EVENT_BYTES) {
      const offset = bytes.byteLength - MAX_EVENT_BYTES;
      const windowStart = offset > 0 ? offset - 1 : 0;
      const prefix = bytes.subarray(windowStart, offset);
      startsMidLine = offset > 0 && prefix[0] !== 0x0a;
      text = bytes.subarray(offset).toString("utf8");
      warnings.push(`event log exceeds the telemetry cap — only the final ${MAX_EVENT_BYTES} bytes (tail) were read`);
    } else {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    }
  } catch {
    warnings.push("event log unreadable — chronology falls back to artifact mtime/state timestamps");
    return [];
  }
  const out: ObservabilityEvent[] = [];
  let corrupt = 0;
  for (const line of text.split("\n")) {
    if (startsMidLine) {
      startsMidLine = false;
      continue;
    }
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as ObservabilityEvent;
      if (parsed && typeof parsed === "object" && typeof parsed.ts === "string" && typeof parsed.kind === "string") out.push(parsed);
      else corrupt += 1;
    } catch {
      corrupt += 1;
    }
  }
  if (corrupt > 0) warnings.push(`${corrupt} corrupt event line(s) skipped`);
  if (out.length > MAX_EVENT_LINES) {
    warnings.push(`event log truncated to ${MAX_EVENT_LINES} events (bounded telemetry)`);
    return out.slice(out.length - MAX_EVENT_LINES);
  }
  return out;
}

/** Latest event ts per key (stageId/artifactId) — the current transition time. */
function latestTransitionTimes(
  events: ObservabilityEvent[],
  keyOf: (e: ObservabilityEvent) => string | undefined,
): Map<string, string> {
  const times = new Map<string, string>();
  for (const e of events) {
    const key = keyOf(e);
    if (!key) continue;
    const prev = times.get(key);
    if (!prev || e.ts > prev) times.set(key, e.ts);
  }
  return times;
}

// ── Chronology ──────────────────────────────────────────────────────────────

function sortedChronology(entries: ChronologyEvent[]): ChronologyEvent[] {
  const timed = entries.filter((e) => Number.isFinite(Date.parse(e.at)));
  const untimed = entries.filter((e) => !Number.isFinite(Date.parse(e.at)));
  timed.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  return [...timed, ...untimed.map((e) => ({ ...e, source: "ordinal" as const }))];
}

// ── Report writer (containment + 0600) ──────────────────────────────────────

/**
 * Write the report HTML under `.work-state` through a borrowed pinned root.
 * The caller owns the pin and must keep it open for the whole render/write
 * transaction.  Parent directories and the leaf are opened without following
 * links; the final file is staged, fsynced and atomically published as 0600.
 */
export function writeReportPinned(
  cwd: string,
  targetPath: string,
  html: string,
  pin: PinnedProjectRoot,
): string {
  // Check the exact bytes before any directory creation or atomic-write setup.
  assertReportHtmlWithinLimit(html);
  const wsRoot = resolve(cwd, WORK_STATE_DIR);
  const target = resolve(cwd, targetPath);
  if (resolve(cwd) !== pin.lexical_root || !isUnderWorkState(wsRoot, target)) {
    throw new Error(`writeReport: target must be under ${wsRoot} (got ${targetPath})`);
  }
  const workspaceReal = realish(wsRoot);
  const targetParent = dirname(target);
  const targetParentReal = realish(targetParent);
  const parentRelative = pin.relativePath(targetParentReal);
  const targetPhysical = join(targetParentReal, basename(target));
  const targetRelative = pin.relativePath(targetPhysical);
  if (parentRelative === null || targetRelative === null) {
    throw new Error(`writeReport: target must be under ${wsRoot} (got ${targetPath})`);
  }
  const ensureStable = (): void => {
    if (
      !pin.isStable()
      || realish(wsRoot) !== workspaceReal
      || realish(targetParent) !== targetParentReal
    ) {
      throw new Error("writeReport: project boundary changed during write");
    }
  };
  try {
    ensureStable();
    pin.ensureDirectory(parentRelative);
    ensureStable();
    pin.writeAtomic(targetRelative, html);
    ensureStable();
  } catch (error) {
    if (error instanceof Error && (
      error.message.startsWith("writeReport:")
      || (error instanceof PinnedRootError && error.code === "invalid" && /not valid UTF-8/u.test(error.message))
    )) throw error;
    throw new Error("writeReport: report could not be written safely");
  }
  return target;
}

/**
 * Standalone report writer.  A caller that already owns a report/session pin
 * must use {@link writeReportPinned} instead so render and publication share
 * one lifetime.
 */
export function writeReport(cwd: string, targetPath: string, html: string): string {
  // Keep the standalone path fail-closed even before opening a project pin.
  assertReportHtmlWithinLimit(html);
  const pin = PinnedProjectRoot.open(cwd);
  if (!pin) throw new Error("writeReport: project root cannot be pinned");
  try {
    return writeReportPinned(cwd, targetPath, html, pin);
  } finally {
    pin.close();
  }
}

function isUnderWorkState(wsRoot: string, target: string): boolean {
  // Resolve real paths for BOTH sides (deepest existing ancestor + missing
  // suffix) so symlinked parents that escape `.work-state` are rejected, and
  // platforms where the tmp root itself is a symlink (/var → /private/var on
  // macOS) compare consistently.
  const rootReal = realish(wsRoot);
  const candidate = join(realish(dirname(target)), basename(target));
  const rel = relative(rootReal, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** Realpath the deepest existing ancestor, appending the missing suffix. */
function realish(p: string): string {
  let ancestor = p;
  const missing: string[] = [];
  while (!existsSync(ancestor)) {
    const parent = dirname(ancestor);
    if (parent === ancestor) break;
    missing.unshift(basename(ancestor));
    ancestor = parent;
  }
  let ancestorReal = ancestor;
  try {
    ancestorReal = realpathSync(ancestor);
  } catch {
    // keep lexical
  }
  return join(ancestorReal, ...missing);
}

// ── Small helpers ───────────────────────────────────────────────────────────

function asList(produces: string | string[] | undefined): string[] {
  if (!produces) return [];
  return Array.isArray(produces) ? produces : [produces];
}

function taskTitle(task: string, issue: { number: number; url?: string } | null): string {
  const firstLine = task.split("\n").find((l) => l.trim()) ?? task;
  const truncated = firstLine.length > 120 ? `${firstLine.slice(0, 120)}…` : firstLine;
  return issue?.number ? `#${issue.number}: ${truncated}` : truncated;
}

function deriveFeatureSlug(branch: string): string | null {
  if (!branch) return null;
  return branch.replace(/\//g, "-").replace(/[^a-z0-9._-]/gi, "-").toLowerCase();
}

/** Read at most `maxBytes` from the head of a file; null on any error. */
function readBounded(filePath: string, maxBytes: number): string | null {
  try {
    const size = statSync(filePath).size;
    const fd = openSync(filePath, "r");
    try {
      const len = Math.min(size, maxBytes);
      const buf = Buffer.alloc(len);
      const n = readSync(fd, buf, 0, len, 0);
      return buf.subarray(0, n).toString("utf8");
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }
}

/**
 * Read the final `maxBytes` window of a file (tail), reporting whether the
 * window begins mid-line (its first line is then a partial JSONL fragment).
 * Null on any error.
 */
function readBoundedTail(
  filePath: string,
  maxBytes: number,
): { text: string; startsMidLine: boolean } | null {
  try {
    const size = statSync(filePath).size;
    const fd = openSync(filePath, "r");
    try {
      const offset = Math.max(0, size - maxBytes);
      // Read one byte before the window so we can tell whether it starts at
      // a line boundary; that byte is skipped when decoding the window.
      const windowStart = offset > 0 ? offset - 1 : 0;
      const len = size - windowStart;
      const buf = Buffer.alloc(len);
      const n = readSync(fd, buf, 0, len, windowStart);
      const bytes = buf.subarray(0, n);
      const startsMidLine = offset > 0 && bytes[0] !== 0x0a;
      const text = bytes.subarray(offset > 0 ? 1 : 0).toString("utf8");
      return { text, startsMidLine };
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }
}
