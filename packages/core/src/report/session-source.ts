/**
 * Deterministic, safe session-source discovery shared by the session report
 * (assemble.ts) and the visualize projection (visualize architecture-2).
 *
 * Single source of truth for WHERE workflow session state lives and HOW it
 * is resolved:
 *
 *   do-work feature  → .work-state/features/<slug>/state.json
 *   do-work legacy   → .work-state/team-state.json            (+ artifacts/)
 *   cto JSON         → .work-state/cto/<runId>/state.json
 *   cto markdown     → observational evidence only; no authoritative state
 *   cto team         → .work-state/artifacts/<teamId>/  + each team's dod_path
 *
 * Two APIs with deliberately different guarantees:
 *
 * - `resolveDoWorkSource` / `resolveCtoSource` — exact-selector resolution
 *   used by the report. Do-work selectors preserve existing bounded
 *   single-segment names; authoritative CTO selectors additionally require
 *   the canonical safe ASCII run-id token. A corrupt exact-id `state.json`
 *   throws (as it does today), a CTO run with a corrupt or identity-less
 *   `state.json` is invisible, and markdown evidence is never promoted to
 *   authoritative state. Traversal-shaped ids (`../x`, `a/b`, `..`) are
 *   rejected before reaching storage.
 * - `listDoWorkSources` / `listCtoSources` / `listSessions` — safe
 *   enumeration for the visualize projection. Never throws; corrupt /
 *   unreadable states become category-only `degraded`/`error` entries.
 *   Observational markdown entries retain their verbatim safe single-segment
 *   ids, while authoritative CTO JSON entries must carry canonical run ids;
 *   ordering is total and deterministic (updated_at desc, kind, id) —
 *   never filesystem enumeration order.
 *
 * Excluded inputs: events.jsonl (observability stream), vibe-report
 * (human docs) and generated visualize output (.work-state/visualize) are
 * never session sources or artifact inputs (`EXCLUDED_SOURCE_NAMES`,
 * `isExcludedSourcePath`).
 *
 * Collisions are exposed, never aliased: a feature literally named "legacy"
 * keeps its exact id but is flagged `degraded` (the exact id "legacy" is
 * reserved for the legacy root state, matching the report selector), and a
 * CTO run id equal to a feature slug stays a distinct `kind` namespace
 * entry. A removed target is never remapped to another session.
 */
/* <!-- omp-cto-slice run=01a03ee4-7dd6-7580-8ad7-16d26dc886ba slice=workflow-v2-core --> */

import {
  decodeStorageText,
  listStorageEntries,
  readStorageBytes,
  requireReportStorage,
  ReportStorageError,
  statStorage,
  storagePath,
  type ReportStorageAuthority,
  type StorageEntry,
} from "./storage.js";

import { isDiagnosticEvidenceRecord } from "../workflow-v2/diagnostics.js";
import { isSafeCtoId, validateProjectIdentity, validateWorkflowRunIdentity } from "../workflow-v2/identity.js";
import type { WorkflowRunIdentity } from "../workflow-v2/types.js";
import type { TeamState } from "../engine/types.js";
import type { CtoState } from "../cto/types.js";
import { isCtoRunTerminal } from "../cto/state.js";

export const WORK_STATE_DIR = ".work-state";
export const LEGACY_STATE = "team-state.json";
export const CTO_DIR = "cto";
export const FEATURES_DIR = "features";
export const TEAM_ARTIFACTS_DIR = "artifacts"; // .work-state/artifacts/<teamId>/ per the CTO prompt contract

/**
 * Names that are never session sources or artifact inputs (excluded inputs):
 * - "visualize" — generated projection output under `.work-state/visualize`;
 *   derived output is read-only and can never become an input;
 * - "vibe-report" — human E2E/report documentation at the workspace root;
 * - "events.jsonl" — the observability event stream; canonical state and
 *   artifacts are authoritative and telemetry is bounded separately.
 */
export const EXCLUDED_SOURCE_NAMES: Record<string, true> = {
  visualize: true, // generated projection output under .work-state/visualize
  "vibe-report": true, // human E2E/report documentation at the workspace root
  "events.jsonl": true, // observability event stream
};

/**
 * Files that count as markdown run-state evidence for visualization-only
 * degraded projections. They are never parsed into durable CTO state.
 */
export const CTO_MD_EVIDENCE: readonly string[] = ["team-plan.md", "decisions.md", "cto_discovery.md"];

/**
 * Files that mark an agent-written markdown run finished. Such evidence
 * remains observational because no durable WorkflowRunIdentity exists.
 */
export const CTO_MD_FINISH_MARKERS: readonly string[] = [
  "summary.md",
  "summary.json",
  "integration_review.md",
  "integration_review.json",
];

// ── Source model ────────────────────────────────────────────────────────────

/**
 * True when `value` is exactly one safe storage path component. Do-work
 * selectors and observational markdown names preserve bounded unicode/space
 * names, while authoritative CTO run paths use the imported canonical
 * `isSafeCtoId` predicate.
 */
function isSinglePathSegment(value: string): boolean {
  return (
    value.length > 0
    && value !== "."
    && value !== ".."
    && !value.includes("/")
    && !value.includes("\\")
    && !/[\u0000-\u001f\u007f-\u009f]/u.test(value)
  );
}

const MAX_REPORT_FEATURE_ID_CHARS = 512;

/**
 * Report projection of a persisted run identity. Reports consume the same
 * canonical durable identity contract as runtime readers: the run id remains
 * an exact safe ASCII token of at most 128 bytes/chars and is never projected,
 * normalized, or replaced with a surrogate.
 */
export function projectReportWorkflowRunIdentity(value: unknown): WorkflowRunIdentity | null {
  const strict = validateWorkflowRunIdentity(value);
  return strict.ok ? strict.value : null;
}


const CTO_TEAM_STATUSES: readonly string[] = ["pending", "in_progress", "parked", "done", "failed"];
const CTO_INTEGRATION_STATUSES: readonly string[] = ["pending", "in_progress", "done", "failed"];
const CTO_ESCALATION_STATUSES: readonly string[] = ["pending", "answered", "expired", "cancelled", "undelivered"];
const CTO_WORKTREE_STRATEGIES: readonly string[] = ["same_branch", "separate_worktree"];
const CTO_BUDGET_STATUSES: readonly string[] = ["unlimited", "ok", "approaching", "exceeded"];

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isOptionalString(record: Record<string, unknown>, key: string): boolean {
  return record[key] === undefined || typeof record[key] === "string";
}

function isOptionalBoolean(record: Record<string, unknown>, key: string): boolean {
  return record[key] === undefined || typeof record[key] === "boolean";
}

function isReportProfileIdentity(value: unknown): boolean {
  return isDiagnosticEvidenceRecord(value)
    && typeof value.id === "string"
    && typeof value.fingerprint === "string";
}

function isReportAgentRef(value: unknown): boolean {
  return isDiagnosticEvidenceRecord(value)
    && typeof value.registered_name === "string"
    && typeof value.provider_id === "string"
    && typeof value.source_fingerprint === "string";
}

function isReportClassification(value: unknown): boolean {
  if (value === undefined) return true;
  return isDiagnosticEvidenceRecord(value)
    && typeof value.type === "string"
    && typeof value.complexity === "string"
    && typeof value.confidence === "string"
    && typeof value.autonomous === "boolean"
    && isOptionalString(value, "workflow")
    && isOptionalString(value, "autonomous_reason");
}

function isReportEscalations(value: unknown): boolean {
  if (!isDiagnosticEvidenceRecord(value)) return false;
  return Object.values(value).every((entry) =>
    isDiagnosticEvidenceRecord(entry)
    && typeof entry.status === "string"
    && CTO_ESCALATION_STATUSES.includes(entry.status)
  );
}

function isReportPlanEntry(value: unknown): boolean {
  if (!isDiagnosticEvidenceRecord(value)) return false;
  return (
    typeof value.team === "string"
    && (value.scope === undefined || isStringArray(value.scope))
    && (value.slice === undefined || typeof value.slice === "string")
    && (value.profile === undefined || typeof value.profile === "string")
    && (
      value.worktree === undefined
      || (
        typeof value.worktree === "string"
        && CTO_WORKTREE_STRATEGIES.includes(value.worktree)
      )
    )
    && (value.depends_on === undefined || isStringArray(value.depends_on))
    && (value.profile_identity === undefined || isReportProfileIdentity(value.profile_identity))
    && (value.lead_ref === undefined || isReportAgentRef(value.lead_ref))
    && (
      value.roster_refs === undefined
      || (
        Array.isArray(value.roster_refs)
        && value.roster_refs.every((entry) => isReportAgentRef(entry))
      )
    )
    // plan.run_identity is intentionally deferred to assembleCto: a stale
    // or missing nested identity is reportable STATE_STALE evidence.
  );
}

function isReportTeam(value: unknown): boolean {
  if (!isDiagnosticEvidenceRecord(value)) return false;
  return (
    typeof value.id === "string"
    && typeof value.status === "string"
    && CTO_TEAM_STATUSES.includes(value.status)
    && isReportEscalations(value.escalations)
    && isOptionalString(value, "dod_path")
    && isOptionalString(value, "slice_id")
    && isOptionalString(value, "control_plane_status")
    && (value.profile_identity === undefined || isReportProfileIdentity(value.profile_identity))
    && (value.lead_ref === undefined || isReportAgentRef(value.lead_ref))
    && (
      value.roster_refs === undefined
      || (
        Array.isArray(value.roster_refs)
        && value.roster_refs.every((entry) => isReportAgentRef(entry))
      )
    )
    // team.run_identity is intentionally deferred to assembleCto.
  );
}


function isReportIntegration(value: unknown): boolean {
  return isDiagnosticEvidenceRecord(value)
    && typeof value.status === "string"
    && CTO_INTEGRATION_STATUSES.includes(value.status)
    && isOptionalString(value, "note");
}

function isReportPause(value: unknown): boolean {
  return isDiagnosticEvidenceRecord(value)
    && typeof value.kind === "string"
    && TEAM_PAUSE_KINDS.includes(value.kind)
    && typeof value.reason === "string";
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isReportHealth(value: unknown): boolean {
  if (!isDiagnosticEvidenceRecord(value)) return false;
  return (
    typeof value.run_id === "string"
    && typeof value.healthy === "boolean"
    && isFiniteNumber(value.active_teams)
    && isFiniteNumber(value.parked_teams)
    && isFiniteNumber(value.failed_teams)
    && isFiniteNumber(value.pending_escalations)
    && typeof value.budget_status === "string"
    && CTO_BUDGET_STATUSES.includes(value.budget_status)
    && typeof value.last_heartbeat_at === "string"
    && isStringArray(value.issues)
  );
}

function isReportBudget(value: unknown): boolean {
  if (!isDiagnosticEvidenceRecord(value)) return false;
  const policy = value.policy;
  const accounting = value.accounting;
  if (!isDiagnosticEvidenceRecord(policy) || !isDiagnosticEvidenceRecord(accounting)) return false;
  const validLimit = (candidate: unknown): boolean => candidate === null || isFiniteNumber(candidate);
  if (
    !validLimit(policy.token_limit)
    || !validLimit(policy.dollar_limit)
    || !validLimit(policy.time_limit_ms)
    || !isFiniteNumber(accounting.tokens_estimated)
    || !isFiniteNumber(accounting.dollars_estimated)
    || !isFiniteNumber(accounting.elapsed_ms)
    || !isDiagnosticEvidenceRecord(accounting.per_team)
  ) {
    return false;
  }
  return Object.values(accounting.per_team).every((entry) =>
    isDiagnosticEvidenceRecord(entry)
    && isFiniteNumber(entry.tokens)
    && isFiniteNumber(entry.dollars)
    && isFiniteNumber(entry.ms)
  );
}

function isReportLeases(value: unknown): boolean {
  if (!isDiagnosticEvidenceRecord(value)) return false;
  return Object.values(value).every((entry) =>
    isDiagnosticEvidenceRecord(entry)
    && typeof entry.token === "string"
    && typeof entry.acquired_at === "string"
    && typeof entry.heartbeat_at === "string"
    && isFiniteNumber(entry.ttl_ms)
    && typeof entry.pid === "number"
    && Number.isInteger(entry.pid)
    && typeof entry.team_id === "string"
  );
}

/**
 * Report-only structural guard for a canonical CTO state. The root identity
 * is validated by `readObservedCtoState`; nested plan/team identities are not
 * validated here because assembleCto owns the STATE_STALE diagnostic contract.
 * Every field consumed by the assembler is checked before the value is
 * narrowed, and no durable migration or fallback authority is introduced.
 */
function isReportCtoStateShape(value: unknown): value is CtoState {
  if (!isDiagnosticEvidenceRecord(value)) return false;
  const plan = value.plan;
  const teams = value.teams;
  const schema = value.schema;
  return (
    (schema === undefined || schema === 1 || schema === 2)
    && typeof value.id === "string"
    && typeof value.task === "string"
    && typeof value.branch === "string"
    && typeof value.autonomous === "boolean"
    && isReportClassification(value.classification)
    && isDiagnosticEvidenceRecord(plan)
    && typeof plan.id === "string"
    && typeof plan.task === "string"
    && Array.isArray(plan.teams)
    && plan.teams.every((entry) => isReportPlanEntry(entry))
    && typeof plan.created_at === "string"
    && Array.isArray(teams)
    && teams.every((entry) => isReportTeam(entry))
    && isReportIntegration(value.integration)
    && isReportPause(value.pause)
    && typeof value.updated_at === "string"
    && isOptionalBoolean(value, "standby")
    && isOptionalString(value, "owner_session")
    && isOptionalString(value, "amended_at")
    && (value.budget === undefined || isReportBudget(value.budget))
    && (value.leases === undefined || isReportLeases(value.leases))
    && (value.health === undefined || isReportHealth(value.health))
  );
}
const TEAM_STAGE_STATUSES: readonly string[] = ["pending", "in_progress", "done", "skipped", "failed"];
const TEAM_PAUSE_KINDS: readonly string[] = [
  "none",
  "background_wait",
  "user_checkpoint",
  "needs_human",
  "failed",
  "done",
];

/**
 * Report discovery checks the fields it reads before exposing parsed JSON as
 * TeamState. Identity is deliberately validated by report assembly so a
 * missing run binding produces its typed migration diagnostic instead of a
 * source fallback.
 */
function isReportTeamState(value: unknown): value is TeamState {
  if (!isDiagnosticEvidenceRecord(value)) return false;
  const classification = value.classification;
  const pause = value.pause;
  if (
    value.schema !== 1
    || typeof value.branch !== "string"
    || typeof value.task !== "string"
    || typeof value.workflow !== "string"
    || typeof value.stage_cursor !== "string"
    || typeof value.cursor_epoch !== "string"
    || typeof value.workflow_override !== "boolean"
    || typeof value.updated_at !== "string"
    || !isDiagnosticEvidenceRecord(classification)
    || typeof classification.type !== "string"
    || typeof classification.complexity !== "string"
    || typeof classification.confidence !== "string"
    || typeof classification.workflow !== "string"
    || typeof classification.autonomous !== "boolean"
    || !Array.isArray(value.stages)
    || value.stages.some((stage) =>
      !isDiagnosticEvidenceRecord(stage)
      || typeof stage.id !== "string"
      || typeof stage.status !== "string"
      || !TEAM_STAGE_STATUSES.includes(stage.status)
    )
    || !isDiagnosticEvidenceRecord(value.artifacts)
    || Object.values(value.artifacts).some((ref) => typeof ref !== "string")
    || !isDiagnosticEvidenceRecord(pause)
    || typeof pause.kind !== "string"
    || !TEAM_PAUSE_KINDS.includes(pause.kind)
    || typeof pause.reason !== "string"
    || (
      value.issue !== null
      && (
        !isDiagnosticEvidenceRecord(value.issue)
        || typeof value.issue.number !== "number"
        || !Number.isInteger(value.issue.number)
        || (value.issue.url !== undefined && typeof value.issue.url !== "string")
      )
    )
) {
    return false;
  }
  if (
    value.project_identity !== undefined
    && !validateProjectIdentity(value.project_identity).ok
  ) {
    return false;
  }
  if (
    value.run_identity !== undefined
    && !validateWorkflowRunIdentity(value.run_identity).ok
  ) {
    return false;
  }
  return true;
}
export type SessionSourceStatus = "ok" | "degraded" | "error";

/** A discovered do-work session (per-feature or legacy root layout). */
export interface DoWorkSessionSource {
  kind: "do-work";
  /** Safe relative id: the feature slug, or "legacy" for the legacy root. */
  id: string;
  /** Parsed TeamState; null when the state file exists but is unreadable. */
  state: TeamState | null;
  statePath: string;
  stateDir: string;
  /** Run-local artifacts dir (`features/<slug>/artifacts` or root `artifacts`). */
  artifactsDir: string;
  isLegacy: boolean;
  isStale?: boolean;
  status: SessionSourceStatus;
  /** Why the entry is degraded/error (category-only identity; never an alias). */
  error?: string;
  /** state.updated_at, or null when no state could be read. */
  updatedAt: string | null;
}

/** A discovered CTO run (JSON state or agent-written markdown state). */
export interface CtoSessionSource {
  kind: "cto";
  /** Safe relative id: the run directory name. */
  id: string;
  state: CtoState | null;
  /** Canonical state path; null for markdown-state runs. */
  statePath: string | null;
  runDir: string;
  format: "json" | "markdown";
  status: SessionSourceStatus;
  error?: string;
  /**
   * Visualization-only projection: an agent-written markdown run that a
   * summary/integration-review marker has finished. `markdownCtoState`
   * returns null for it (report semantics: such runs are invisible to the
   * report), but the projection keeps it discoverable as degraded so a
   * removed target never resolves to another session.
   */
  terminalMarkdown?: boolean;
  updatedAt: string | null;
}

export type SessionSourceEntry = DoWorkSessionSource | CtoSessionSource;

/** Exact-selector results: the state is guaranteed readable. */
export type ResolvedDoWork = DoWorkSessionSource & { state: TeamState; status: "ok" };
export type ResolvedCto = CtoSessionSource & { state: CtoState; status: "ok" };

// ── Artifact / run-local locations ──────────────────────────────────────────

/**
 * Report input paths are always descriptor-relative. Excluded source checks
 * therefore operate on a relative path, never on a caller-supplied pathname.
 */
export function isExcludedSourcePath(relativePath: string): boolean {
  if (typeof relativePath !== "string" || !relativePath || relativePath.includes("\\") || /[\u0000-\u001f\u007f-\u009f]/u.test(relativePath)) {
    return true;
  }
  const parts = relativePath.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) return true;
  const basename = parts[parts.length - 1];
  if (basename === "events.jsonl") return true;
  return relativePath === "vibe-report"
    || relativePath.startsWith("vibe-report/")
    || relativePath === `${WORK_STATE_DIR}/visualize`
    || relativePath.startsWith(`${WORK_STATE_DIR}/visualize/`);
}

/** CTO team artifacts live under `.work-state/artifacts/<teamId>`. */
export function ctoTeamArtifactsDir(teamId: string): string {
  if (!isSinglePathSegment(teamId)) {
    throw new ReportStorageError("UNSAFE_PATH", "unsafe team id");
  }
  return storagePath(WORK_STATE_DIR, TEAM_ARTIFACTS_DIR, teamId);
}

function listedDirectoryEntries(
  storage: ReportStorageAuthority,
  relativeDirectory: string,
): readonly StorageEntry[] {
  const stat = statStorage(storage, relativeDirectory);
  if (!stat.exists) return [];
  if (stat.kind !== "directory") {
    throw new ReportStorageError("IO", `report storage path is not a directory: ${relativeDirectory}`);
  }
  return listStorageEntries(storage, relativeDirectory, 4096);
}

function readText(
  storage: ReportStorageAuthority,
  relativePath: string,
  maxBytes: number,
): string | null {
  return decodeStorageText(readStorageBytes(storage, relativePath, maxBytes));
}

const MAX_STATE_BYTES = 512 * 1024;

/**
 * Deterministic run-local state/artifact candidates for a CTO run dir:
 * agent-written markdown + json files. Excludes the canonical state.json,
 * observability event stream and inbound answers tree.
 */
export function ctoRunLocalFiles(storage: ReportStorageAuthority, runDir: string): string[] {
  storage = requireReportStorage(storage);
  const out: string[] = [];
  for (const entry of listedDirectoryEntries(storage, runDir)) {
    const name = entry.name;
    if (EXCLUDED_SOURCE_NAMES[name] || name === "state.json" || name === "answers") continue;
    if (!name.endsWith(".md") && !name.endsWith(".json")) continue;
    const stat = statStorage(storage, entry.relative_path);
    if (stat.exists && stat.kind === "file") out.push(name);
  }
  return out.sort();
}

// ── Markdown-state CTO projection (visualization-only evidence) ─────────────

function markdownFiles(storage: ReportStorageAuthority, runDir: string): string[] {
  return listedDirectoryEntries(storage, runDir)
    .map((entry) => entry.name)
    .filter((name) => name.endsWith(".md") || name.endsWith(".json"))
    .sort();
}

/** Newest mtime across the markdown/json files used by the projection. */
function newestMtime(storage: ReportStorageAuthority, runDir: string, files: string[]): string {
  let newest = 0;
  for (const name of files) {
    const stat = statStorage(storage, storagePath(runDir, name));
    if (stat.exists && stat.kind === "file") newest = Math.max(newest, stat.mtime_ms);
  }
  return newest > 0 ? new Date(newest).toISOString() : new Date(0).toISOString();
}

/**
 * Markdown-only CTO runs are observational evidence, never durable state.
 * Without a persisted WorkflowRunIdentity they cannot be converted into a
 * CtoState or selected for amend/report authorization.
 */
export function markdownCtoState(
  storage: ReportStorageAuthority,
  runId: string,
  runDir: string,
): CtoState | null {
  storage = requireReportStorage(storage);
  if (!isSinglePathSegment(runId)) return null;
  const files = markdownFiles(storage, runDir);
  if (!files.some((name) => CTO_MD_EVIDENCE.includes(name))) return null;
  if (files.some((name) => CTO_MD_FINISH_MARKERS.includes(name))) return null;
  return null;
}

/**
 * Report-only canonical-state reader. It validates the root identity and the
 * shape consumed by report assembly, but deliberately leaves nested
 * plan/team identities untouched so assembleCto can emit STATE_STALE evidence.
 */
function readObservedCtoState(storage: ReportStorageAuthority, runId: string): CtoState | null {
  if (!isSafeCtoId(runId)) return null;
  const statePath = storagePath(WORK_STATE_DIR, CTO_DIR, runId, "state.json");
  const stat = statStorage(storage, statePath);
  if (!stat.exists || stat.kind !== "file") return null;
  try {
    const text = readText(storage, statePath, MAX_STATE_BYTES);
    if (text === null) return null;
    const parsed: unknown = JSON.parse(text);
    if (!isReportCtoStateShape(parsed) || parsed.id !== runId) return null;
    const identity = projectReportWorkflowRunIdentity(parsed.run_identity);
    if (!identity || identity.run_id !== runId) return null;
    // Keep report output aligned with the durable schema without invoking the
    // strict durable migrator (which intentionally rejects stale nested ids).
    parsed.schema = 2;
    parsed.run_identity = identity;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Durable discovery reader used by amend/continuation. It keeps strict
 * identity checks while delegating all bytes and metadata to the authority.
 */
function sameDurableRunIdentity(left: WorkflowRunIdentity, right: WorkflowRunIdentity): boolean {
  return left.run_id === right.run_id
    && left.root_instance_id === right.root_instance_id
    && left.provider_id === right.provider_id
    && left.descriptor_fingerprint === right.descriptor_fingerprint
    && left.executable_provenance.build_fingerprint === right.executable_provenance.build_fingerprint
    && left.executable_provenance.runtime_fingerprint === right.executable_provenance.runtime_fingerprint
    && left.catalog_content_digest === right.catalog_content_digest
    && left.config_byte_sha256 === right.config_byte_sha256
    && left.config_semantic_sha256 === right.config_semantic_sha256
    && left.session.session_id === right.session.session_id
    && left.session.lifecycle_id === right.session.lifecycle_id
    && left.profile_identity.id === right.profile_identity.id
    && left.profile_identity.fingerprint === right.profile_identity.fingerprint;
}

function readDurableCtoState(storage: ReportStorageAuthority, runId: string): CtoState | null {
  if (!isSafeCtoId(runId)) return null;
  const statePath = storagePath(WORK_STATE_DIR, CTO_DIR, runId, "state.json");
  try {
    const text = readText(storage, statePath, MAX_STATE_BYTES);
    if (text === null) return null;
    const parsed: unknown = JSON.parse(text);
    if (!isDiagnosticEvidenceRecord(parsed) || parsed.id !== runId) return null;
    const identity = validateWorkflowRunIdentity(parsed.run_identity);
    if (!identity.ok) return null;
    const plan = parsed.plan;
    if (!isDiagnosticEvidenceRecord(plan)) return null;
    const planIdentity = validateWorkflowRunIdentity(plan.run_identity);
    if (!planIdentity.ok || !sameDurableRunIdentity(planIdentity.value, identity.value)) return null;
    return parsed as unknown as CtoState;
  } catch {
    return null;
  }
}
function unreadableFeatureState(slug: string): Error {
  return new Error(`unreadable JSON state for do-work feature "${slug}"`);
}

function readFeatureSource(
  storage: ReportStorageAuthority,
  slug: string,
  exact = false,
): DoWorkSessionSource | null {
  if (!isSinglePathSegment(slug)) return null;
  const featureDir = storagePath(WORK_STATE_DIR, FEATURES_DIR, slug);
  const statePath = storagePath(featureDir, "state.json");
  const stateStat = statStorage(storage, statePath);
  if (!stateStat.exists || stateStat.kind !== "file") return null;
  const base: Omit<DoWorkSessionSource, "state" | "status" | "updatedAt"> = {
    kind: "do-work",
    id: slug,
    statePath,
    stateDir: featureDir,
    artifactsDir: storagePath(featureDir, "artifacts"),
    isLegacy: false,
  };
  try {
    const text = readText(storage, statePath, MAX_STATE_BYTES);
    if (text === null) {
      if (exact) throw unreadableFeatureState(slug);
      return { ...base, state: null, status: "error", error: "unreadable state.json", updatedAt: null };
    }
    const parsed: unknown = JSON.parse(text);
    if (!isReportTeamState(parsed)) {
      if (exact) throw unreadableFeatureState(slug);
      return { ...base, state: null, status: "error", error: "unreadable state.json", updatedAt: null };
    }
    return { ...base, state: parsed, status: "ok", updatedAt: parsed.updated_at };
  } catch (error) {
    if (error instanceof ReportStorageError) throw error;
    if (exact || error instanceof SyntaxError) {
      if (exact) throw unreadableFeatureState(slug);
      return { ...base, state: null, status: "error", error: "unreadable state.json", updatedAt: null };
    }
    throw error;
  }
}

function readLegacySource(storage: ReportStorageAuthority): ResolvedDoWork | null {
  const statePath = storagePath(WORK_STATE_DIR, LEGACY_STATE);
  const stateStat = statStorage(storage, statePath);
  if (!stateStat.exists || stateStat.kind !== "file") return null;
  const text = readText(storage, statePath, MAX_STATE_BYTES);
  if (text === null) return null;
  const parsed: unknown = JSON.parse(text);
  const state = isReportTeamState(parsed) ? parsed : null;
  if (!state) return null;
  return {
    kind: "do-work",
    id: "legacy",
    state,
    statePath,
    stateDir: WORK_STATE_DIR,
    artifactsDir: storagePath(WORK_STATE_DIR, "artifacts"),
    isLegacy: true,
    status: "ok",
    updatedAt: state.updated_at,
  };
}

/**
 * Resolve one do-work session by exact selector. The authority owns the
 * project/run binding; this function only supplies safe `.work-state` paths.
 */
export function resolveDoWorkSource(storage: ReportStorageAuthority, id?: string): ResolvedDoWork | null {
  storage = requireReportStorage(storage);
  if (id && id !== "legacy") {
    if (!isSinglePathSegment(id)) return null;
    const source = readFeatureSource(storage, id, true);
    return source?.state ? source as ResolvedDoWork : null;
  }
  if (id === "legacy") return readLegacySource(storage);
  const workStateStat = statStorage(storage, WORK_STATE_DIR);
  if (!workStateStat.exists || workStateStat.kind !== "directory") return null;
  const activePath = storagePath(WORK_STATE_DIR, ".active-feature");
  const activeStat = statStorage(storage, activePath);
  if (activeStat.exists) {
    if (activeStat.kind !== "file") return null;
    const active = readText(storage, activePath, MAX_REPORT_FEATURE_ID_CHARS + 1)?.trim() ?? "";
    if (!isSinglePathSegment(active) || active.length > MAX_REPORT_FEATURE_ID_CHARS) return null;
    const selected = readFeatureSource(storage, active);
    if (selected?.state) return selected as ResolvedDoWork;
  } else {
    const legacy = readLegacySource(storage);
    if (legacy) return legacy;
  }

  const featuresDir = storagePath(WORK_STATE_DIR, FEATURES_DIR);
  const featuresStat = statStorage(storage, featuresDir);
  if (!featuresStat.exists || featuresStat.kind !== "directory") return null;
  let best: ResolvedDoWork | null = null;
  for (const entry of listedDirectoryEntries(storage, featuresDir)) {
    if (entry.name === "." || entry.name === "..") continue;
    const source = readFeatureSource(storage, entry.name);
    if (!source?.state) continue;
    if (!best || source.state.updated_at > best.state.updated_at) {
      best = source as ResolvedDoWork;
    }
  }
  return best;
}

/**
 * Resolve one CTO run by exact selector. Only a readable canonical
 * `state.json` carrying a durable run identity is authoritative.
 */
export function resolveCtoSource(storage: ReportStorageAuthority, id?: string): ResolvedCto | null {
  storage = requireReportStorage(storage);
  const runsDir = storagePath(WORK_STATE_DIR, CTO_DIR);
  const runsStat = statStorage(storage, runsDir);
  if (!runsStat.exists || runsStat.kind !== "directory") return null;
  const readRun = (runId: string): ResolvedCto | null => {
    if (!isSafeCtoId(runId)) return null;
    const runDir = storagePath(runsDir, runId);
    const runStat = statStorage(storage, runDir);
    if (!runStat.exists || runStat.kind !== "directory") return null;
    const statePath = storagePath(runDir, "state.json");
    const stateStat = statStorage(storage, statePath);
    if (!stateStat.exists || stateStat.kind !== "file") return null;
    const state = readObservedCtoState(storage, runId);
    if (!state) return null;
    return {
      kind: "cto",
      id: runId,
      state,
      statePath,
      runDir,
      format: "json",
      status: "ok",
      updatedAt: state.updated_at,
    };
  };
  if (id) return isSafeCtoId(id) ? readRun(id) : null;
  let best: ResolvedCto | null = null;
  for (const entry of listedDirectoryEntries(storage, runsDir)) {
    const run = readRun(entry.name);
    if (!run) continue;
    if (!best || run.state.updated_at > best.state.updated_at) best = run;
  }
  return best;
}


/**
 * Find the newest active canonical CTO run for amend/continuation discovery.
 * Markdown evidence and malformed/identity-less state are never amendable.
 */
export function findActiveCtoRun(
  storage: ReportStorageAuthority,
  opts: { sessionId?: string } = {},
): { runId: string; state: CtoState } | null {
  storage = requireReportStorage(storage);
  const runsDir = storagePath(WORK_STATE_DIR, CTO_DIR);
  const runsStat = statStorage(storage, runsDir);
  if (!runsStat.exists || runsStat.kind !== "directory") return null;
  let best: { runId: string; state: CtoState } | null = null;
  let bestAt = "";
  const consider = (runId: string, state: CtoState): void => {
    if (isCtoRunTerminal(state) || !isRunOwnedBySession(state, opts.sessionId)) return;
    if (!best || state.updated_at > bestAt || state.updated_at === bestAt && runId < best.runId) {
      best = { runId, state };
      bestAt = state.updated_at;
    }
  };
  for (const entry of listedDirectoryEntries(storage, runsDir)) {
    if (!isSafeCtoId(entry.name)) continue;
    const runDir = storagePath(runsDir, entry.name);
    const runStat = statStorage(storage, runDir);
    if (!runStat.exists || runStat.kind !== "directory") continue;
    const state = readDurableCtoState(storage, entry.name);
    if (state) consider(entry.name, state);
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

// ── Safe enumeration (visualize projection) ─────────────────────────────────


/**
 * Enumerate every do-work session deterministically through the bounded
 * authority. Corrupt states become category-only error entries.
 */
export function listDoWorkSources(storage: ReportStorageAuthority): DoWorkSessionSource[] {
  storage = requireReportStorage(storage);
  const out: DoWorkSessionSource[] = [];
  const legacyPath = storagePath(WORK_STATE_DIR, LEGACY_STATE);
  const legacyStat = statStorage(storage, legacyPath);
  if (legacyStat.exists && legacyStat.kind === "file") {
    const base = {
      kind: "do-work" as const,
      id: "legacy",
      statePath: legacyPath,
      stateDir: WORK_STATE_DIR,
      artifactsDir: storagePath(WORK_STATE_DIR, "artifacts"),
      isLegacy: true,
    };
    try {
      const text = readText(storage, legacyPath, MAX_STATE_BYTES);
      const parsed: unknown = text === null ? null : JSON.parse(text);
      if (!isReportTeamState(parsed)) {
        out.push({ ...base, state: null, status: "error", error: "unreadable team-state.json", updatedAt: null });
      } else {
        out.push({ ...base, state: parsed, status: "ok", updatedAt: parsed.updated_at });
      }
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      out.push({ ...base, state: null, status: "error", error: "unreadable team-state.json", updatedAt: null });
    }
  }
  const featuresDir = storagePath(WORK_STATE_DIR, FEATURES_DIR);
  const featuresStat = statStorage(storage, featuresDir);
  if (featuresStat.exists && featuresStat.kind === "directory") {
    for (const entry of listedDirectoryEntries(storage, featuresDir)) {
      const source = readFeatureSource(storage, entry.name);
      if (!source) continue;
      if (source.id === "legacy") {
        out.push({
          ...source,
          status: "degraded",
          error: "id 'legacy' is reserved for the legacy root state — feature reachable only by category",
        });
      } else {
        out.push(source);
      }
    }
  }
  return sortSources(out);
}

/**
 * Enumerate every CTO run deterministically through the bounded authority.
 * Corrupt JSON is an error entry; markdown evidence remains observational.
 */
export function listCtoSources(storage: ReportStorageAuthority): CtoSessionSource[] {
  storage = requireReportStorage(storage);
  const runsDir = storagePath(WORK_STATE_DIR, CTO_DIR);
  const runsStat = statStorage(storage, runsDir);
  if (!runsStat.exists || runsStat.kind !== "directory") return [];
  const out: CtoSessionSource[] = [];
  for (const entry of listedDirectoryEntries(storage, runsDir)) {
    const runId = entry.name;
    if (!isSinglePathSegment(runId)) continue;
    const runDir = storagePath(runsDir, runId);
    const runStat = statStorage(storage, runDir);
    if (!runStat.exists || runStat.kind !== "directory") continue;
    const statePath = storagePath(runDir, "state.json");
    const stateStat = statStorage(storage, statePath);
    if (stateStat.exists && stateStat.kind === "file") {
      const state = readObservedCtoState(storage, runId);
      if (state) {
        out.push({
          kind: "cto",
          id: runId,
          state,
          statePath,
          runDir,
          format: "json",
          status: "ok",
          updatedAt: state.updated_at,
        });
      } else {
        out.push({
          kind: "cto",
          id: runId,
          state: null,
          statePath,
          runDir,
          format: "json",
          status: "error",
          error: "unreadable state.json",
          updatedAt: null,
        });
      }
      continue;
    }
    const markdownEvidence = markdownFiles(storage, runDir);
    if (
      markdownEvidence.some((name) => CTO_MD_EVIDENCE.includes(name))
      && !markdownEvidence.some((name) => CTO_MD_FINISH_MARKERS.includes(name))
    ) {
      out.push({
        kind: "cto",
        id: runId,
        state: null,
        statePath: null,
        runDir,
        format: "markdown",
        status: "degraded",
        error: "markdown CTO evidence has no durable run identity — projection only",
        updatedAt: newestMtime(storage, runDir, markdownEvidence),
      });
      continue;
    }
    if (isTerminalMarkdownRun(markdownEvidence)) {
      out.push({
        kind: "cto",
        id: runId,
        state: null,
        statePath: null,
        runDir,
        format: "markdown",
        status: "degraded",
        terminalMarkdown: true,
        error: "terminal markdown run (summary/integration-review marker present) — projection only",
        updatedAt: newestRunLocalMtime(storage, runDir, markdownEvidence),
      });
    }
  }
  return sortSources(out);
}

/** Every discoverable session in total deterministic order. */
export function listSessions(storage: ReportStorageAuthority): SessionSourceEntry[] {
  storage = requireReportStorage(storage);
  return sortSources([...listDoWorkSources(storage), ...listCtoSources(storage)]);
}

// ── Deterministic ordering ──────────────────────────────────────────────────

/**
 * Total deterministic order: updated_at descending (entries without a
 * readable state sort last), then kind, then id. Never filesystem
 * enumeration order.
 */
function sortSources<T extends SessionSourceEntry>(entries: T[]): T[] {
  return [...entries].sort((a, b) => {
    const at = a.updatedAt ?? "";
    const bt = b.updatedAt ?? "";
    if (at !== bt) return at < bt ? 1 : -1;
    if (a.kind !== b.kind) return a.kind < b.kind ? -1 : 1;
    if (a.id !== b.id) return a.id < b.id ? -1 : 1;
    return 0;
  });
}

/** True when markdown evidence includes a finish marker. */
function isTerminalMarkdownRun(files: readonly string[]): boolean {
  return files.some((name) => CTO_MD_EVIDENCE.includes(name))
    && files.some((name) => CTO_MD_FINISH_MARKERS.includes(name));
}

/** Newest mtime across run-local markdown/json files. */
function newestRunLocalMtime(
  storage: ReportStorageAuthority,
  runDir: string,
  files: readonly string[],
): string | null {
  let newest = 0;
  for (const name of files) {
    if (!name.endsWith(".md") && !name.endsWith(".json")) continue;
    const stat = statStorage(storage, storagePath(runDir, name));
    if (stat.exists && stat.kind === "file") newest = Math.max(newest, stat.mtime_ms);
  }
  return newest > 0 ? new Date(newest).toISOString() : null;
}
