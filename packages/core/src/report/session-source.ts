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
 *   cto markdown     → never a discoverable execution/report source
 *   cto team         → .work-state/artifacts/<teamId>/  + each team's dod_path
 *
 * Two APIs with deliberately different guarantees:
 *
 * - `resolveDoWorkSource` / `resolveCtoSource` — exact-selector resolution
 *   used by the report. They preserve buildSessionReport semantics verbatim:
 *   a corrupt exact-id `state.json` throws (as it does today), and a CTO run
 *   without a valid canonical `state.json` is invisible. A selector must be a single non-traversal path segment:
 *   traversal-shaped ids (`../x`, `a/b`, `..`) are rejected (they can never
 *   name a real directory entry, so nothing discoverable is hidden), while
 *   previously valid exotic names (unicode, spaces) resolve verbatim —
 *   never aliased.
 *
 * - `listDoWorkSources` / `listCtoSources` / `listSessions` — safe
 *   enumeration for the visualize projection. Never throws; corrupt /
 *   unreadable states become category-only `degraded`/`error` entries with
 *   verbatim single-segment ids (the same non-traversal rule is applied
 *   defensively — readdir entries are single segments by construction);
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

import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";

import { PinnedProjectRoot, PinnedRootError } from "../specification/pinned-root.js";
import { MAX_PERSISTED_STATE_BYTES } from "../engine/state.js";
import type { TeamState } from "../engine/types.js";
import { isBoundedLineInert, isSafeWorkflowIdentifier, MAX_ADVANCE_FIELD_BYTES } from "../engine/durable.js";
import { MAX_CTO_STATE_READ_BYTES, isSafeCtoRunId, parsePersistedCtoState } from "../cto/state.js";
import { MAX_CTO_SPECIFICATION_TEXT_BYTES } from "../cto/types.js";
import type { CtoState } from "../cto/types.js";

const MAX_POINTER_BYTES = 4096;
const MAX_TEAM_STATE_COLLECTION_BYTES = 256 * 1024;
const MAX_TEAM_STATE_COLLECTION_ITEMS = 256;
const MAX_TEAM_STATE_JSON_DEPTH = 8;
const MAX_TEAM_STATE_JSON_NODES = 4096;
const MAX_TEAM_STATE_JSON_KEYS = 256;
const MAX_TEAM_STATE_JSON_TOTAL_KEYS = 4096;
const MAX_SESSION_SOURCES = 4096;

interface TeamStateGraphFrame {
  value: unknown;
  depth: number;
  exit?: boolean;
}

interface TeamStateGraphBudget {
  bytes: number;
  items: number;
  nodes: number;
  keys: number;
}

const STAGE_STATUSES: Record<string, true> = {
  pending: true,
  in_progress: true,
  done: true,
  skipped: true,
  failed: true,
};
const TASK_TYPES: Record<string, true> = {
  FEATURE: true,
  REFACTOR: true,
  OPS: true,
  BUG_FIX: true,
  SPEC: true,
  REGRESS: true,
  INVESTIGATION: true,
  LECTURE_RESEARCH: true,
  REVIEW: true,
  HOTFIX: true,
  PRODUCT_DISCOVERY: true,
};
const COMPLEXITIES: Record<string, true> = { QUICK: true, MEDIUM: true, COMPLEX: true, CRITICAL: true };
const CONFIDENCES: Record<string, true> = { HIGH: true, MEDIUM: true, LOW: true };
const PAUSE_KINDS: Record<string, true> = {
  none: true,
  background_wait: true,
  user_checkpoint: true,
  needs_human: true,
  failed: true,
  done: true,
};
const BOUNDED_ID_FIELDS: Record<string, true> = {
  id: true,
  run_id: true,
  run_key: true,
  session_id: true,
  wave_id: true,
  slice_id: true,
  feature_id: true,
  stage_id: true,
  stage_cursor: true,
  capability_id: true,
  capability_epoch: true,
  slot_id: true,
  task_id: true,
  dispatch_id: true,
  worker_id: true,
  artifact_id: true,
  phase: true,
  profile_hash: true,
  config_hash: true,
};


function ownsPin(cwd: string, supplied?: PinnedProjectRoot): { pin: PinnedProjectRoot; owned: boolean } | null {
  const pin = supplied ?? PinnedProjectRoot.open(cwd);
  if (!pin) return null;
  return { pin, owned: supplied === undefined };
}

function sourcePath(cwd: string, relativePath: string): string {
  return resolve(cwd, relativePath);
}

function readUtf8(pin: PinnedProjectRoot, relativePath: string, maxBytes: number): string {
  if (!pin.isStable()) throw new PinnedRootError("changed", "pinned project root changed before report read");
  const read = pin.readFile(relativePath, { maxBytes });
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(read.bytes);
  } catch (error) {
    throw new Error(`invalid UTF-8 in ${relativePath}: ${String(error)}`);
  }
  if (!pin.isStable()) throw new PinnedRootError("changed", "pinned project root changed after report read");
  return text;
}

function invalidTeamState(): never {
  throw new Error("state.json has an invalid TeamState shape");
}

function boundedText(value: unknown, maxBytes: number, allowEmpty = false): value is string {
  if (typeof value !== "string") return false;
  if (value.length === 0) return allowEmpty;
  return isBoundedLineInert(value, maxBytes);
}
function boundedId(value: unknown): value is string {
  return typeof value === "string" && isSafeWorkflowIdentifier(value, MAX_ADVANCE_FIELD_BYTES);
}

function validateTeamStateValues(value: unknown, budget: TeamStateGraphBudget): void {
  const active = new WeakSet<object>();
  const stack: TeamStateGraphFrame[] = [{ value, depth: 0 }];
  const accountString = (text: string): void => {
    const bytes = Buffer.byteLength(text, "utf8");
    if (bytes > MAX_CTO_SPECIFICATION_TEXT_BYTES) invalidTeamState();
    budget.bytes += bytes;
    if (budget.bytes > MAX_TEAM_STATE_COLLECTION_BYTES) invalidTeamState();
  };

  while (stack.length > 0) {
    const frame = stack.pop()!;
    if (frame.exit) {
      if (frame.value !== null && typeof frame.value === "object") active.delete(frame.value);
      continue;
    }
    if (++budget.nodes > MAX_TEAM_STATE_JSON_NODES || frame.depth > MAX_TEAM_STATE_JSON_DEPTH) invalidTeamState();
    if (typeof frame.value === "string") {
      if (!boundedText(frame.value, MAX_CTO_SPECIFICATION_TEXT_BYTES, true)) invalidTeamState();
      accountString(frame.value);
      continue;
    }
    const node = frame.value;
    if (node === null || typeof node === "boolean") continue;
    if (typeof node === "number") {
      if (!Number.isFinite(node)) invalidTeamState();
      continue;
    }
    if (typeof node !== "object") invalidTeamState();
    if (active.has(node)) invalidTeamState();
    active.add(node);
    stack.push({ value: node, depth: frame.depth, exit: true });

    const prototype = Object.getPrototypeOf(node);
    if (Object.getOwnPropertySymbols(node).length > 0) invalidTeamState();
    if (Array.isArray(node)) {
      if (prototype !== Array.prototype || node.length > MAX_TEAM_STATE_COLLECTION_ITEMS) invalidTeamState();
      const keys = Object.keys(node);
      const propertyNames = Object.getOwnPropertyNames(node);
      if (
        propertyNames.length !== keys.length + 1
        || keys.length !== node.length
        || keys.some((key) => !/^(?:0|[1-9]\d*)$/u.test(key) || Number(key) >= node.length)
      ) invalidTeamState();
      budget.items += node.length;
      if (budget.items > MAX_TEAM_STATE_COLLECTION_ITEMS) invalidTeamState();
      for (let index = node.length - 1; index >= 0; index -= 1) {
        const descriptor = Object.getOwnPropertyDescriptor(node, String(index));
        if (!descriptor || !("value" in descriptor)) invalidTeamState();
        stack.push({ value: descriptor.value, depth: frame.depth + 1 });
      }
      continue;
    }
    if (prototype !== Object.prototype && prototype !== null) invalidTeamState();
    const record = node as Record<string, unknown>;
    const keys = Object.keys(record);
    if (Object.getOwnPropertyNames(record).length !== keys.length) invalidTeamState();
    if (keys.length > MAX_TEAM_STATE_JSON_KEYS) invalidTeamState();
    budget.keys += keys.length;
    if (budget.keys > MAX_TEAM_STATE_JSON_TOTAL_KEYS) invalidTeamState();
    for (let index = keys.length - 1; index >= 0; index -= 1) {
      const key = keys[index]!;
      if (!boundedText(key, 256)) invalidTeamState();
      accountString(key);
      if (BOUNDED_ID_FIELDS[key] === true) {
        const entry = record[key];
        if (entry !== null && entry !== undefined && !boundedId(entry)) invalidTeamState();
      }
      const descriptor = Object.getOwnPropertyDescriptor(record, key);
      if (!descriptor || !("value" in descriptor)) invalidTeamState();
      stack.push({ value: descriptor.value, depth: frame.depth + 1 });
    }
  }
}

function parseTeamState(text: string): TeamState {
  const parsed: unknown = JSON.parse(text);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) invalidTeamState();
  const value = parsed as Record<string, unknown>;
  const classification = value.classification;
  const classificationRecord = classification && typeof classification === "object" && !Array.isArray(classification)
    ? classification as Record<string, unknown>
    : null;
  const pause = value.pause;
  const pauseRecord = pause && typeof pause === "object" && !Array.isArray(pause)
    ? pause as Record<string, unknown>
    : null;
  const issue = value.issue;
  const issueRecord = issue && typeof issue === "object" && !Array.isArray(issue)
    ? issue as Record<string, unknown>
    : null;
  if (
    value.schema !== 1
    || !boundedText(value.branch, MAX_ADVANCE_FIELD_BYTES)
    || !boundedText(value.task, MAX_CTO_SPECIFICATION_TEXT_BYTES)
    || !classificationRecord
    || TASK_TYPES[String(classificationRecord.type)] !== true
    || COMPLEXITIES[String(classificationRecord.complexity)] !== true
    || CONFIDENCES[String(classificationRecord.confidence)] !== true
    || !boundedId(classificationRecord.workflow)
    || typeof classificationRecord.autonomous !== "boolean"
    || typeof value.workflow_override !== "boolean"
    || (issue !== null && !issueRecord)
    || (issueRecord !== null && (!Number.isSafeInteger(issueRecord.number) || (issueRecord.url !== undefined && !boundedText(issueRecord.url, MAX_ADVANCE_FIELD_BYTES))))
    || !boundedId(value.stage_cursor)
    || !Array.isArray(value.stages)
    || value.stages.length > MAX_TEAM_STATE_COLLECTION_ITEMS
    || !value.artifacts || typeof value.artifacts !== "object" || Array.isArray(value.artifacts)
    || !pauseRecord
    || PAUSE_KINDS[String(pauseRecord.kind)] !== true
    || !boundedText(pauseRecord.reason, MAX_CTO_SPECIFICATION_TEXT_BYTES, true)
    || !boundedText(value.updated_at, MAX_ADVANCE_FIELD_BYTES)
  ) invalidTeamState();
  for (const stage of value.stages) {
    if (!stage || typeof stage !== "object" || Array.isArray(stage)) invalidTeamState();
    const record = stage as Record<string, unknown>;
    if (!boundedId(record.id) || typeof record.status !== "string" || STAGE_STATUSES[record.status] !== true) invalidTeamState();
  }
  for (const [artifactId, artifactPath] of Object.entries(value.artifacts)) {
    if (!boundedText(artifactId, MAX_ADVANCE_FIELD_BYTES) || !boundedText(artifactPath, MAX_ADVANCE_FIELD_BYTES)) invalidTeamState();
  }
  validateTeamStateValues(value, { bytes: 0, items: 0, nodes: 0, keys: 0 });
  return value as unknown as TeamState;
}

function parseCtoState(text: string): CtoState | null {
  const parsed: unknown = JSON.parse(text);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  return parsePersistedCtoState(parsed as Record<string, unknown>);
}

function pathKind(pin: PinnedProjectRoot, relativePath: string): "file" | "directory" | "symlink" | "other" | null {
  return pin.pathEntryInfo(relativePath)?.kind ?? null;
}

function isRegularState(pin: PinnedProjectRoot, relativePath: string): boolean {
  return pathKind(pin, relativePath) === "file";
}

function isSafeDirectory(pin: PinnedProjectRoot, relativePath: string): boolean {
  const kind = pathKind(pin, relativePath);
  return kind === null || kind === "directory";
}

function stateFeatureIdentity(state: TeamState, slug: string): boolean {
  const candidate = (state as TeamState & { feature_id?: unknown }).feature_id
    ?? (state.work_identity as { feature_id?: unknown } | undefined)?.feature_id;
  return candidate === undefined || candidate === slug;
}

function sourceFromTeamState(
  cwd: string,
  pin: PinnedProjectRoot,
  id: string,
  state: TeamState,
  stateRelative: string,
  stateDirRelative: string,
  artifactsRelative: string,
  isLegacy: boolean,
): ResolvedDoWork {
  if (!isLegacy && !stateFeatureIdentity(state, id)) throw new Error("state feature identity does not match directory name");
  if (!isSafeDirectory(pin, artifactsRelative)) throw new PinnedRootError("path_unauthorized", "artifacts directory must not be a symlink");
  return {
    kind: "do-work",
    id,
    state,
    statePath: sourcePath(cwd, stateRelative),
    stateDir: sourcePath(cwd, stateDirRelative),
    artifactsDir: sourcePath(cwd, artifactsRelative),
    isLegacy,
    status: "ok",
    updatedAt: state.updated_at,
  };
}

function resolveFeaturePinned(cwd: string, pin: PinnedProjectRoot, slug: string): ResolvedDoWork | null {
  const featureRelative = join(WORK_STATE_DIR, FEATURES_DIR, slug);
  if (pathKind(pin, featureRelative) !== "directory") return null;
  const stateRelative = join(featureRelative, "state.json");
  if (!isRegularState(pin, stateRelative)) return null;
  const state = parseTeamState(readUtf8(pin, stateRelative, MAX_PERSISTED_STATE_BYTES));
  return sourceFromTeamState(cwd, pin, slug, state, stateRelative, featureRelative, join(featureRelative, "artifacts"), false);
}

function resolveLegacyPinned(cwd: string, pin: PinnedProjectRoot): ResolvedDoWork | null {
  const stateRelative = join(WORK_STATE_DIR, LEGACY_STATE);
  if (!isRegularState(pin, stateRelative)) return null;
  const state = parseTeamState(readUtf8(pin, stateRelative, MAX_PERSISTED_STATE_BYTES));
  return sourceFromTeamState(cwd, pin, "legacy", state, stateRelative, WORK_STATE_DIR, join(WORK_STATE_DIR, "artifacts"), true);
}

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

// ── Source model ────────────────────────────────────────────────────────────

/**
 * True when `value` is exactly one path segment that cannot traverse or
 * escape its parent when joined into a path: non-empty, not `.`/`..`, and
 * free of `/`, the current platform's separator and NUL. On POSIX a
 * backslash is a legal filename character, so `a\b` is a single segment
 * there and addressable exactly as it appears; on Windows `\` is a
 * separator and such a selector is rejected.
 *
 * Deliberately weaker than the engine's `isSafeStateSegment` (ASCII slugs
 * for the write path): boundary safety only needs a single segment, and the
 * report/discovery contract is to preserve previously valid exotic names
 * verbatim (unicode, spaces). A traversal-shaped selector can never name a
 * real single directory entry, so rejecting it never hides a discoverable
 * session — while rejecting exotic-but-single-segment names would. The same
 * rule is applied defensively during enumeration (readdir entries are
 * single segments by construction), so the projection stays safe and
 * deterministic without ever aliasing a name.
 */
function isSinglePathSegment(value: string): boolean {
  return (
    value.length > 0 &&
    value !== "." &&
    value !== ".." &&
    !value.includes("/") &&
    !value.includes(sep) &&
    !value.includes("\0")
  );
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
  /** Canonical state path. */
  statePath: string;
  runDir: string;
  format: "json";
  status: SessionSourceStatus;
  error?: string;
  updatedAt: string | null;
}

export type SessionSourceEntry = DoWorkSessionSource | CtoSessionSource;

/** Exact-selector results: the state is guaranteed readable. */
export type ResolvedDoWork = DoWorkSessionSource & { state: TeamState; status: "ok" };
export type ResolvedCto = CtoSessionSource & { state: CtoState; status: "ok" };

// ── Artifact / run-local locations ──────────────────────────────────────────

/**
 * True when an absolute path must never be treated as a session source or
 * artifact input: generated visualize output, vibe-report documentation, or
 * the observability event stream.
 */
export function isExcludedSourcePath(cwd: string, absPath: string): boolean {
  const p = resolve(absPath);
  if (basename(p) === "events.jsonl") return true;
  for (const root of [resolve(cwd, WORK_STATE_DIR, "visualize"), resolve(cwd, "vibe-report")]) {
    const rel = relative(root, p);
    if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) return true;
  }
  return false;
}

/** CTO team artifacts live under `.work-state/artifacts/<teamId>/`. */
export function ctoTeamArtifactsDir(cwd: string, teamId: string): string {
  return join(cwd, WORK_STATE_DIR, TEAM_ARTIFACTS_DIR, teamId);
}

/**
 * Deterministic run-local state/artifact candidates for a CTO run dir:
 * agent-written markdown + json files. Excludes the canonical state.json
 * (state is authoritative, never an artifact), the observability event
 * stream (events.jsonl) and the inbound answers/ tree. Sorted
 * lexicographically — never filesystem enumeration order.
 */
export function ctoRunLocalFiles(runDir: string, suppliedPin?: PinnedProjectRoot): string[] {
  const rootCandidate = resolve(runDir, "..", "..", "..");
  const opened = ownsPin(rootCandidate, suppliedPin);
  if (!opened) return [];
  const { pin, owned } = opened;
  try {
    const relativeRunDir = pin.relativePath(runDir);
    if (!relativeRunDir || !pin.isStable()) return [];
    const names = pin.listDirectory(relativeRunDir, { maxEntries: 4096, maxNameBytes: 512 * 1024 });
    const out: string[] = [];
    for (const name of names) {
      if (EXCLUDED_SOURCE_NAMES[name] || name === "state.json" || name === "answers") continue;
      if (!name.endsWith(".md") && !name.endsWith(".json")) continue;
      if (pathKind(pin, join(relativeRunDir, name)) === "file") out.push(name);
    }
    return out.sort();
  } catch {
    return [];
  } finally {
    if (owned) pin.close();
  }
}

// ── Exact-selector resolution (report semantics, verbatim) ──────────────────

/**
 * Resolve one do-work session by exact selector, preserving report
 * semantics:
 * - id === "legacy" → the legacy root `team-state.json` only;
 * - any other id → `.work-state/features/<id>/state.json` only (the id must
 *   be a single non-traversal path segment — exotic names such as unicode
 *   or spaces stay verbatim and never alias; a corrupt exact-id state
 *   throws, matching `buildSessionReport` today);
 * - no id → the report's "latest": the `.active-feature` pointer via
 *   `resolveState`, then the legacy root, then the newest per-feature state.
 * Returns null when the session does not exist — callers turn that into the
 * same "not found" error the report throws today.
 */
export function resolveDoWorkSource(cwd: string, id?: string, suppliedPin?: PinnedProjectRoot): ResolvedDoWork | null {
  const opened = ownsPin(cwd, suppliedPin);
  if (!opened) return null;
  const { pin, owned } = opened;
  try {
    if (!pin.isStable()) return null;
    if (id && id !== "legacy") {
      if (!isSinglePathSegment(id)) return null;
      try {
        return resolveFeaturePinned(cwd, pin, id);
      } catch (error) {
        if (error instanceof PinnedRootError
          && (error.code === "not_found" || error.code === "path_unauthorized" || error.code === "not_regular" || error.code === "changed")) return null;
        throw error;
      }
    }
    if (id === "legacy") {
      try {
        return resolveLegacyPinned(cwd, pin);
      } catch (error) {
        if (error instanceof PinnedRootError
          && (error.code === "not_found" || error.code === "path_unauthorized" || error.code === "not_regular" || error.code === "changed")) return null;
        throw error;
      }
    }

    const activeRelative = join(WORK_STATE_DIR, ".active-feature");
    const activeKind = pathKind(pin, activeRelative);
    if (activeKind !== null) {
      if (activeKind !== "file") return null;
      const active = readUtf8(pin, activeRelative, MAX_POINTER_BYTES).trim();
      if (!isSinglePathSegment(active)) return null;
      try {
        const selected = resolveFeaturePinned(cwd, pin, active);
        if (selected) return selected;
      } catch (error) {
        if (!(error instanceof PinnedRootError
          && (error.code === "not_found" || error.code === "path_unauthorized" || error.code === "not_regular" || error.code === "changed"))) throw error;
      }
    }

    try {
      const legacy = resolveLegacyPinned(cwd, pin);
      if (legacy) return legacy;
    } catch (error) {
      if (!(error instanceof PinnedRootError
        && (error.code === "not_found" || error.code === "path_unauthorized" || error.code === "not_regular" || error.code === "changed"))) throw error;
    }

    const featuresRelative = join(WORK_STATE_DIR, FEATURES_DIR);
    if (pathKind(pin, featuresRelative) !== "directory") return null;
    let names: string[];
    try {
      names = pin.listDirectory(featuresRelative, { maxEntries: 4096, maxNameBytes: 512 * 1024 }).sort();
    } catch {
      return null;
    }
    let best: ResolvedDoWork | null = null;
    for (const slug of names) {
      if (!isSinglePathSegment(slug)) continue;
      try {
        const entry = resolveFeaturePinned(cwd, pin, slug);
        if (entry && (best === null || (entry.updatedAt ?? "") > (best.updatedAt ?? ""))) best = entry;
      } catch (error) {
        if (error instanceof PinnedRootError
          && (error.code === "not_found" || error.code === "path_unauthorized" || error.code === "not_regular" || error.code === "changed")) continue;
        // The latest selector skips malformed peers, preserving report parity.
      }
    }
    return best;
  } finally {
    if (owned) pin.close();
  }
}

/**
 * Resolve one CTO run by exact selector from canonical `state.json`; a
 * markdown-only run is inactive and never becomes report authority. No id →
 * the newest run by updated_at. A corrupt `state.json` makes the run
 * invisible (no markdown fallback), matching the report. Run ids must be
 * single non-traversal path segments: traversal-shaped selectors are
 * rejected, while previously valid exotic ids (unicode, spaces) resolve
 * verbatim when the state is readable.
 */
export function resolveCtoSource(cwd: string, id?: string, suppliedPin?: PinnedProjectRoot): ResolvedCto | null {
  const opened = ownsPin(cwd, suppliedPin);
  if (!opened) return null;
  const { pin, owned } = opened;
  const runsRelative = join(WORK_STATE_DIR, CTO_DIR);
  const readRun = (runId: string): ResolvedCto | null => {
    const runRelative = join(runsRelative, runId);
    if (pathKind(pin, runRelative) !== "directory") return null;
    const stateRelative = join(runRelative, "state.json");
    if (!isRegularState(pin, stateRelative)) return null;
    const state = parseCtoState(readUtf8(pin, stateRelative, MAX_CTO_STATE_READ_BYTES));
    if (!state || state.id !== runId) return null;
    return {
      kind: "cto",
      id: runId,
      state,
      statePath: sourcePath(cwd, stateRelative),
      runDir: sourcePath(cwd, runRelative),
      format: "json",
      status: "ok",
      updatedAt: state.updated_at,
    };
  };
  try {
    if (!pin.isStable()) return null;
    if (id) {
      if (!isSafeCtoRunId(id)) return null;
      try {
        return readRun(id);
      } catch (error) {
        if (error instanceof PinnedRootError
          && (error.code === "not_found" || error.code === "path_unauthorized" || error.code === "not_regular" || error.code === "changed")) return null;
        return null;
      }
    }
    if (pathKind(pin, runsRelative) !== "directory") return null;
    let names: string[];
    try {
      names = pin.listDirectory(runsRelative, { maxEntries: 4096, maxNameBytes: 512 * 1024 }).sort();
    } catch {
      return null;
    }
    let best: ResolvedCto | null = null;
    for (const runId of names) {
      if (!isSafeCtoRunId(runId)) continue;
      try {
        const run = readRun(runId);
        if (run && (best === null || (run.updatedAt ?? "") > (best.updatedAt ?? ""))) best = run;
      } catch {
        // Enumeration is fail-closed for malformed or racing peers.
      }
    }
    return best;
  } finally {
    if (owned) pin.close();
  }
}

// ── Safe enumeration (visualize projection) ─────────────────────────────────

/**
 * Read one per-feature source. Null when the feature dir has no state.json
 * (a dir without state is not a session). A corrupt state.json becomes an
 * `error` entry here — enumeration never throws; the report's exact-id probe
 * keeps throwing instead (see resolveDoWorkSource).
 */
function readFeatureSource(cwd: string, pin: PinnedProjectRoot, slug: string): DoWorkSessionSource | null {
  if (!isSinglePathSegment(slug)) return null;
  const featureRelative = join(WORK_STATE_DIR, FEATURES_DIR, slug);
  if (pathKind(pin, featureRelative) !== "directory") return null;
  const stateRelative = join(featureRelative, "state.json");
  const statePath = sourcePath(cwd, stateRelative);
  const featureDir = sourcePath(cwd, featureRelative);
  const artifactsRelative = join(featureRelative, "artifacts");
  const base = {
    kind: "do-work" as const,
    id: slug,
    statePath,
    stateDir: featureDir,
    artifactsDir: sourcePath(cwd, artifactsRelative),
    isLegacy: false,
  };
  const stateKind = pathKind(pin, stateRelative);
  if (stateKind === null) return null;
  if (stateKind !== "file") {
    return { ...base, state: null, status: "error", error: "state.json is not a regular file", updatedAt: null };
  }
  try {
    const state = parseTeamState(readUtf8(pin, stateRelative, MAX_PERSISTED_STATE_BYTES));
    if (!stateFeatureIdentity(state, slug)) {
      return { ...base, state: null, status: "error", error: "state feature identity does not match directory name", updatedAt: null };
    }
    const artifactsKind = pathKind(pin, artifactsRelative);
    if (artifactsKind !== null && artifactsKind !== "directory") {
      return { ...base, state, status: "degraded", error: "artifacts directory is not a regular directory", updatedAt: state.updated_at };
    }
    return { ...base, state, status: "ok", updatedAt: state.updated_at };
  } catch {
    return { ...base, state: null, status: "error", error: "unreadable state.json", updatedAt: null };
  }
}

function listLegacySource(cwd: string, pin: PinnedProjectRoot): DoWorkSessionSource | null {
  const stateRelative = join(WORK_STATE_DIR, LEGACY_STATE);
  const statePath = sourcePath(cwd, stateRelative);
  const stateDir = sourcePath(cwd, WORK_STATE_DIR);
  const artifactsRelative = join(WORK_STATE_DIR, "artifacts");
  const base = {
    kind: "do-work" as const,
    id: "legacy",
    statePath,
    stateDir,
    artifactsDir: sourcePath(cwd, artifactsRelative),
    isLegacy: true,
  };
  const stateKind = pathKind(pin, stateRelative);
  if (stateKind === null) return null;
  if (stateKind !== "file") return { ...base, state: null, status: "error", error: "unreadable team-state.json", updatedAt: null };
  try {
    const state = parseTeamState(readUtf8(pin, stateRelative, MAX_PERSISTED_STATE_BYTES));
    const artifactsKind = pathKind(pin, artifactsRelative);
    if (artifactsKind !== null && artifactsKind !== "directory") {
      return { ...base, state, status: "degraded", error: "artifacts directory is not a regular directory", updatedAt: state.updated_at };
    }
    return { ...base, state, status: "ok", updatedAt: state.updated_at };
  } catch {
    return { ...base, state: null, status: "error", error: "unreadable team-state.json", updatedAt: null };
  }
}

/**
 * Enumerate every do-work session deterministically: the legacy root (when
 * `team-state.json` exists) plus every per-feature state. Corrupt states are
 * `error` entries. A feature literally named "legacy" is never aliased: the
 * exact id "legacy" is reserved for the legacy root (report selector), so
 * the feature is exposed as a degraded, category-only entry with its real
 * id. Ordering: updated_at desc, then id — never filesystem enumeration
 * order.
 */
export function listDoWorkSources(cwd: string, suppliedPin?: PinnedProjectRoot): DoWorkSessionSource[] {
  const opened = ownsPin(cwd, suppliedPin);
  if (!opened) return [];
  const { pin, owned } = opened;
  try {
    if (!pin.isStable()) return [];
    const out: DoWorkSessionSource[] = [];
    const legacy = listLegacySource(cwd, pin);
    if (legacy) out.push(legacy);
    const featuresRelative = join(WORK_STATE_DIR, FEATURES_DIR);
    if (pathKind(pin, featuresRelative) === "directory") {
      let names: string[] = [];
      try {
        names = pin.listDirectory(featuresRelative, { maxEntries: 4096, maxNameBytes: 512 * 1024 });
      } catch {
        names = [];
      }
      for (const slug of names.sort()) {
        const entry = readFeatureSource(cwd, pin, slug);
        if (!entry) continue;
        if (entry.id === "legacy") {
          out.push({
            ...entry,
            status: "degraded",
            error: "id 'legacy' is reserved for the legacy root state — feature reachable only by category",
          });
        } else {
          out.push(entry);
        }
      }
    }
    return sortSources(out);
  } catch {
    return [];
  } finally {
    if (owned) pin.close();
  }
}

/**
 * Enumerate every CTO run deterministically. JSON runs are `ok`; a corrupt
 * `state.json` is an `error` entry (category-only — the report path skips
 * it). Markdown-only directories are not sessions. Ordering: updated_at desc,
 * then id — never filesystem enumeration order.
 */
export function listCtoSources(cwd: string, suppliedPin?: PinnedProjectRoot): CtoSessionSource[] {
  const opened = ownsPin(cwd, suppliedPin);
  if (!opened) return [];
  const { pin, owned } = opened;
  try {
    if (!pin.isStable()) return [];
    const runsRelative = join(WORK_STATE_DIR, CTO_DIR);
    if (pathKind(pin, runsRelative) !== "directory") return [];
    let names: string[];
    try {
      names = pin.listDirectory(runsRelative, { maxEntries: 4096, maxNameBytes: 512 * 1024 });
    } catch {
      return [];
    }
    const out: CtoSessionSource[] = [];
    for (const runId of names.sort()) {
      if (!isSinglePathSegment(runId)) continue;
      const runRelative = join(runsRelative, runId);
      if (pathKind(pin, runRelative) !== "directory") continue;
      const stateRelative = join(runRelative, "state.json");
      const statePath = sourcePath(cwd, stateRelative);
      const runDir = sourcePath(cwd, runRelative);
      if (!isSafeCtoRunId(runId)) {
        if (pathKind(pin, stateRelative) !== null) {
          out.push({ kind: "cto", id: runId, state: null, statePath, runDir, format: "json", status: "error", error: "unsafe run id", updatedAt: null });
        }
        continue;
      }
      if (pathKind(pin, stateRelative) === null) continue;
      const base = { kind: "cto" as const, id: runId, statePath, runDir, format: "json" as const };
      try {
        if (!isRegularState(pin, stateRelative)) {
          out.push({ ...base, state: null, status: "error", error: "unreadable state.json", updatedAt: null });
          continue;
        }
        const state = parseCtoState(readUtf8(pin, stateRelative, MAX_CTO_STATE_READ_BYTES));
        if (!state || state.id !== runId) {
          out.push({ ...base, state: null, status: "error", error: "state identity does not match run directory", updatedAt: null });
          continue;
        }
        out.push({ ...base, state, status: "ok", updatedAt: state.updated_at });
      } catch {
        out.push({ ...base, state: null, status: "error", error: "unreadable state.json", updatedAt: null });
      }
    }
    return sortSources(out);
  } catch {
    return [];
  } finally {
    if (owned) pin.close();
  }
}

/**
 * Every discoverable session (do-work + cto) in the total deterministic
 * order — the visualize entry point for the "all sessions" scope. The
 * returned cross-category view is capped at MAX_SESSION_SOURCES.
 */
export function listSessions(cwd: string, suppliedPin?: PinnedProjectRoot): SessionSourceEntry[] {
  const opened = ownsPin(cwd, suppliedPin);
  if (!opened) return [];
  const { pin, owned } = opened;
  try {
    if (!pin.isStable()) return [];
    // Both category readers return the same total order. Merge only the
    // bounded prefix so a project with many valid sessions never retains or
    // sorts an unbounded cross-category array.
    return mergeSortedSources(
      listDoWorkSources(cwd, pin),
      listCtoSources(cwd, pin),
      MAX_SESSION_SOURCES,
    );
  } finally {
    if (owned) pin.close();
  }
}

// ── Deterministic ordering ──────────────────────────────────────────────────

function compareSources(a: SessionSourceEntry, b: SessionSourceEntry): number {
  const at = a.updatedAt ?? "";
  const bt = b.updatedAt ?? "";
  if (at !== bt) return at < bt ? 1 : -1;
  if (a.kind !== b.kind) return a.kind < b.kind ? -1 : 1;
  if (a.id !== b.id) return a.id < b.id ? -1 : 1;
  return 0;
}

function mergeSortedSources(
  left: readonly SessionSourceEntry[],
  right: readonly SessionSourceEntry[],
  limit: number,
): SessionSourceEntry[] {
  const merged: SessionSourceEntry[] = [];
  let leftIndex = 0;
  let rightIndex = 0;
  while (merged.length < limit && (leftIndex < left.length || rightIndex < right.length)) {
    const leftEntry = left[leftIndex];
    const rightEntry = right[rightIndex];
    if (rightEntry === undefined || (leftEntry !== undefined && compareSources(leftEntry, rightEntry) <= 0)) {
      merged.push(leftEntry!);
      leftIndex += 1;
    } else {
      merged.push(rightEntry);
      rightIndex += 1;
    }
  }
  return merged;
}

/**
 * Total deterministic order: updated_at descending (entries without a
 * readable state sort last), then kind, then id. Never filesystem
 * enumeration order.
 */
function sortSources<T extends SessionSourceEntry>(entries: T[]): T[] {
  return [...entries].sort(compareSources);
}


