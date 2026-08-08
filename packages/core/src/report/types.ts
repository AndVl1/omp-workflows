/**
 * Normalized session-state report model (pragmatic architecture).
 *
 * One selected/latest do-work (TeamState schema 1) or CTO (CtoState schema 2)
 * session is normalized into a single read-only `SessionReport`. The model is
 * deliberately dependency-free (no OMP, no DOM, no browser): the HTML renderer
 * is a pure function over this shape, and the fullstack command only glues
 * build → render → write.
 *
 * Contract notes (clarified scope):
 * - State/artifacts are authoritative; telemetry is bounded and optional.
 * - Chronology uses event timestamps first, artifact mtime, state.updated_at,
 *   then ordinal placement — never raw events/transcripts embedded.
 * - Sanitized expandable artifact content is opt-in (`includeFullArtifacts`)
 *   and byte-capped (`maxArtifactBytes`).
 * - Missing/corrupt optional inputs produce explicit `warnings`, never throws.
 */

import type { PauseKind, StageStatus } from "../engine/types.js";
import type { TeamRunStatus } from "../cto/types.js";
import type { ObservabilityRollup } from "../observability/events.js";

// ── Selection & options ─────────────────────────────────────────────────────

export type SessionKind = "do-work" | "cto";

export interface SessionSelector {
  /**
   * Which session family to report. Omitted → auto-detect: the latest
   * (by updated_at) of the best CTO run and the best do-work state.
   */
  kind?: SessionKind;
  /**
   * Session id. For do-work: a feature slug (or "legacy" for the legacy
   * root `team-state.json`). For cto: the run id directory name. Omitted →
   * latest by updated_at.
   */
  id?: string;
}

export interface BuildSessionReportOptions {
  /**
   * Include sanitized full artifact content (expandable in the renderer).
   * Default: false → summaries only.
   */
  includeFullArtifacts?: boolean;
  /**
   * Byte cap for a full artifact body. Larger artifacts are truncated and a
   * warning is recorded. Default: 16 KiB.
   */
  maxArtifactBytes?: number;
}

// ── Normalized model ────────────────────────────────────────────────────────

/**
 * Agent/role provenance attached to a stage.
 *
 * `source: "workflow"` means the entry was derived from the loaded workflow
 * profile / resolved role config — never a runtime observation. `observed`
 * is reserved for deterministic stage-correlated runtime evidence; global
 * agent/tool counts are NOT stage evidence and must never be claimed as
 * such. Missing artifacts/rosters stay missing — entries are never
 * synthesized.
 */
export interface StageAgentInfo {
  /** Resolved agent name (role→agent mapping, or the truthful descriptor). */
  name: string;
  /** Original role from the workflow profile (e.g. "architect_minimal"). */
  role?: string;
  /** "workflow" = profile/config-derived; "observed" = runtime-correlated. */
  source: "workflow" | "observed";
}

/** One stage of the session (do-work profile stage or derived CTO stage). */
export interface StageInfo {
  id: string;
  title?: string;
  /**
   * do-work stages use StageStatus; CTO stages reuse TeamRunStatus; a CTO
   * stage that has not begun is "not_started".
   */
  status: StageStatus | TeamRunStatus | "not_started";
  /** Workflow phase the stage belongs to (profile name / "cto"). */
  phase?: string;
  /** Stage type from the workflow profile (orchestrator/single/consilium/...). */
  type?: string;
  /** For CTO team stages: the team id this stage maps to. */
  team?: string;
  /** Best-available transition time (event ts → artifact mtime → updated_at). */
  at?: string;
  /** Raw/unmapped status text when it did not fit the known vocabulary. */
  detail?: string;
  /**
   * Agents/roles that run this stage — profile/config-derived provenance.
   * Absent when the stage has no profile definition (custom/legacy) or no
   * truthful roster is available.
   */
  agents?: StageAgentInfo[];
  /** Artifact ids this stage consumes (`StageDef.consumes`); absent without a def. */
  inputs?: string[];
  /** Artifact ids this stage produces (`StageDef.produces`); absent without a def. */
  outputs?: string[];
  /** Stage description from the workflow profile; absent without a def. */
  description?: string;
  /** Human checkpoint label from the workflow profile (e.g. "confirm_understanding"). */
  checkpoint?: string;
  /** Gate condition from the workflow profile; must hold for the stage to be `done`. */
  gate?: string;
  /** Autonomous branch decision text from the workflow profile (checkpoint auto-decision). */
  autonomous?: string;
  /**
   * Bounded, RECONSTRUCTED preview of the stage prompt — NEVER the literal
   * runtime prompt (per-stage task text is generated dynamically by the
   * agent run and is not persisted). Assembled deterministically from the
   * persisted stage definition (title/id/type, declared inputs/outputs,
   * checkpoint/gate/autonomous), the session task, and truthful resolved
   * agent/role provenance only. Never contains raw artifact JSON, event or
   * transcript data, tool arguments, or secrets. Absent for custom/legacy
   * stages and derived stages without a StageDef.
   */
  promptPreview?: string;
}

export type EdgeKind = "produces" | "consumes" | "depends_on" | "integration" | "transition";

/** Directed dependency/transition edge between stages or teams. */
export interface SessionEdge {
  from: string;
  to: string;
  kind: EdgeKind;
  label?: string;
}

export type ArtifactStatus = "produced" | "missing" | "skipped";

export interface ReportArtifact {
  /** Artifact id (workflow `produces` id, or the file stem). */
  id: string;
  /** Resolved path relative to the project root. */
  path: string;
  /** Stage/team that declared or owns this artifact. */
  owner: string;
  status: ArtifactStatus;
  bytes?: number;
  mtime?: string;
  /** Artifact JSON type name when the payload carries one. */
  type?: string;
  /** Bounded summary (always present, even when the artifact is missing). */
  summary?: string;
  /** Sanitized full content — only when `includeFullArtifacts` and within cap. */
  body?: string;
  /** Top-level keys when the artifact parsed as a JSON object. */
  keys?: string[];
}

export interface ReportTeam {
  id: string;
  status: TeamRunStatus;
  scope?: string[];
  slice?: string;
  profile?: string;
  worktree?: string;
  depends_on?: string[];
  dod_path?: string;
  /** Number of recorded escalations for this team. */
  escalations?: number;
}

export interface ReportIntegration {
  status: "pending" | "in_progress" | "done" | "failed";
  note?: string;
}

export interface ReportHealth {
  healthy: boolean;
  issues: string[];
  budget_status?: string;
  active_teams?: number;
  parked_teams?: number;
  failed_teams?: number;
  pending_escalations?: number;
}

export interface ReportMeta {
  title: string;
  task: string;
  branch: string;
  workflow?: string;
  classification?: {
    type: string;
    complexity: string;
    confidence: string;
    workflow?: string;
    autonomous: boolean;
    autonomous_reason?: string;
  };
  issue?: { number: number; url?: string } | null;
  pause: { kind: PauseKind; reason: string };
  updated_at: string;
  generated_at: string;
  /** Resolved autonomy (model-first). */
  autonomous?: boolean;
  standby?: boolean;
  owner_session?: string;
  amended_at?: string;
}

export interface ReportSource {
  kind: SessionKind;
  id: string;
  /** State file path; null for markdown-fallback CTO runs. */
  statePath: string | null;
  /** How the state was read: JSON on disk, or agent-written markdown. */
  format: "json" | "markdown";
  /** do-work: legacy root layout vs per-feature layout. */
  isLegacy: boolean;
  isStale?: boolean;
  stateDir?: string;
  artifactsDir?: string;
}

export interface ReportTelemetry {
  /** Relative events path when an event log was found. */
  eventsPath?: string;
  lastEventId?: string;
  /** Bounded rollup; null when telemetry is absent or corrupt. */
  rollup: ObservabilityRollup | null;
  /** Event counts by kind (bounded; never the raw events). */
  eventCounts?: Record<string, number>;
}

export interface ChronologyEvent {
  /** ISO timestamp (best available). */
  at: string;
  /** What the entry refers to: an event, a stage, an artifact, state, a team. */
  kind: "event" | "stage" | "artifact" | "state" | "team" | "integration";
  /** Event kind when `kind === "event"`. */
  eventKind?: string;
  /** Human label, e.g. "stage implementation → done". */
  label: string;
  /** Stage/artifact/team id the entry refers to. */
  ref?: string;
  /** Where the timestamp came from. */
  source: "event" | "mtime" | "state" | "ordinal";
}

/** The normalized, renderer-ready report. */
export interface SessionReport {
  schema: 1;
  kind: SessionKind;
  meta: ReportMeta;
  source: ReportSource;
  stages: StageInfo[];
  edges: SessionEdge[];
  artifacts: ReportArtifact[];
  /** CTO only. */
  teams?: ReportTeam[];
  /** CTO only. */
  integration?: ReportIntegration;
  /** CTO only (derived from state; deterministic). */
  health?: ReportHealth;
  /** Bounded telemetry; absent/corrupt → rollup null + warning. */
  telemetry: ReportTelemetry;
  /** Ordered chronology; untimed entries appended by ordinal. */
  chronology: ChronologyEvent[];
  warnings: string[];
}
