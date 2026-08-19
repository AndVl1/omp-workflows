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
 *   cto markdown     → .work-state/cto/<runId>/{team-plan,decisions,cto_discovery}.md
 *                      (agent-written runs with no state.json)
 *   cto team         → .work-state/artifacts/<teamId>/  + each team's dod_path
 *
 * Two APIs with deliberately different guarantees:
 *
 * - `resolveDoWorkSource` / `resolveCtoSource` — exact-selector resolution
 *   used by the report. They preserve buildSessionReport semantics verbatim:
 *   a corrupt exact-id `state.json` throws (as it does today), a CTO run
 *   with a corrupt `state.json` is invisible (no markdown fallback), and
 *   terminal markdown runs are invisible because `markdownCtoState` returns
 *   null for them. A selector must be a single non-traversal path segment:
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

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";

import { resolveState } from "../engine/state.js";
import type { TeamState } from "../engine/types.js";
import { readCtoState } from "../cto/state.js";
import type { CtoState } from "../cto/types.js";
import { markdownCtoState } from "../commands/cto.js";

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
 * Files that count as markdown run-state evidence (mirror of the
 * active-evidence list in commands/cto.ts — the report path always calls
 * `markdownCtoState`; this list only labels the terminal projection).
 */
export const CTO_MD_EVIDENCE: readonly string[] = ["team-plan.md", "decisions.md", "cto_discovery.md"];

/**
 * Files that mark an agent-written markdown run FINISHED (mirror of
 * FINISH_MARKERS in commands/cto.ts). A run without state.json stays active
 * until one of these markers appears.
 */
export const CTO_MD_FINISH_MARKERS: readonly string[] = [
  "summary.md",
  "summary.json",
  "integration_review.md",
  "integration_review.json",
];

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
export function ctoRunLocalFiles(runDir: string): string[] {
  let names: string[];
  try {
    names = readdirSync(runDir);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const name of names) {
    if (EXCLUDED_SOURCE_NAMES[name]) continue;
    if (name === "state.json" || name === "answers") continue;
    if (!name.endsWith(".md") && !name.endsWith(".json")) continue;
    try {
      if (statSync(join(runDir, name)).isFile()) out.push(name);
    } catch {
      // missing/racy — skip
    }
  }
  return out.sort();
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
export function resolveDoWorkSource(cwd: string, id?: string): ResolvedDoWork | null {
  const wsDir = resolve(cwd, WORK_STATE_DIR);
  if (id && id !== "legacy") {
    if (!isSinglePathSegment(id)) return null; // traversal-shaped selector can never address a real feature
    const featureDir = join(wsDir, FEATURES_DIR, id);
    const statePath = join(featureDir, "state.json");
    if (!existsSync(statePath)) return null;
    // Throws on corrupt state — exact-id report parity (buildSessionReport
    // surfaces the JSON.parse error unchanged).
    const state = JSON.parse(readFileSync(statePath, "utf8")) as TeamState;
    return {
      kind: "do-work",
      id,
      state,
      statePath,
      stateDir: featureDir,
      artifactsDir: join(featureDir, "artifacts"),
      isLegacy: false,
      status: "ok",
      updatedAt: state.updated_at,
    };
  }
  if (id === "legacy") {
    const statePath = join(wsDir, LEGACY_STATE);
    if (!existsSync(statePath)) return null;
    const state = JSON.parse(readFileSync(statePath, "utf8")) as TeamState;
    return {
      kind: "do-work",
      id: "legacy",
      state,
      statePath,
      stateDir: wsDir,
      artifactsDir: join(wsDir, "artifacts"),
      isLegacy: true,
      status: "ok",
      updatedAt: state.updated_at,
    };
  }
  const resolved = resolveState(cwd);
  if (resolved.state && resolved.statePath) {
    const slug = resolved.isLegacy ? "legacy" : basename(resolved.stateDir ?? "");
    return {
      kind: "do-work",
      id: slug,
      state: resolved.state,
      statePath: resolved.statePath,
      stateDir: resolved.stateDir ?? wsDir,
      artifactsDir: resolved.artifactsDir ?? join(wsDir, "artifacts"),
      isLegacy: resolved.isLegacy,
      isStale: resolved.isStale,
      status: "ok",
      updatedAt: resolved.state.updated_at,
    };
  }
  // "Latest" fallback: no active-feature pointer and no legacy state — scan
  // per-feature states and pick the newest by updated_at. Corrupt states are
  // skipped (same as the report's scan).
  const featuresDir = join(wsDir, FEATURES_DIR);
  if (!existsSync(featuresDir)) return null;
  let best: ResolvedDoWork | null = null;
  try {
    for (const slug of readdirSync(featuresDir)) {
      const entry = readFeatureSource(wsDir, slug);
      if (!entry || !entry.state) continue;
      if (!best || entry.state.updated_at > best.state.updated_at) {
        best = { ...entry, state: entry.state, status: "ok" };
      }
    }
  } catch {
    // unreadable features dir — no do-work session available
  }
  return best;
}

/**
 * Resolve one CTO run by exact selector, preserving report semantics:
 * `state.json` first (JSON format); when absent, the agent-written markdown
 * fallback via `markdownCtoState` (ACTIVE runs only — a terminal markdown
 * run returns null here and stays invisible to the report; see
 * `listCtoSources` for the visualization-only terminal projection). No id →
 * the newest run by updated_at. A corrupt `state.json` makes the run
 * invisible (no markdown fallback), matching the report. Run ids must be
 * single non-traversal path segments: traversal-shaped selectors are
 * rejected, while previously valid exotic ids (unicode, spaces) resolve
 * verbatim when the state is readable.
 */
export function resolveCtoSource(cwd: string, id?: string): ResolvedCto | null {
  const runsDir = join(cwd, WORK_STATE_DIR, CTO_DIR);
  if (!existsSync(runsDir)) return null;
  const readRun = (runId: string): ResolvedCto | null => {
    const runDir = join(runsDir, runId);
    if (!existsSync(runDir)) return null;
    const statePath = join(runDir, "state.json");
    if (existsSync(statePath)) {
      const state = readCtoState(runId, cwd);
      if (!state) return null; // corrupt state.json — invisible to the report (unchanged)
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
    }
    const mdState = markdownCtoState(runId, runDir);
    if (!mdState) return null;
    return {
      kind: "cto",
      id: runId,
      state: mdState,
      statePath: null,
      runDir,
      format: "markdown",
      status: "ok",
      updatedAt: mdState.updated_at,
    };
  };
  if (id) {
    if (!isSinglePathSegment(id)) return null; // traversal-shaped selector can never name a real run
    return readRun(id);
  }
  let best: ResolvedCto | null = null;
  try {
    for (const runId of readdirSync(runsDir)) {
      if (!isSinglePathSegment(runId)) continue; // defensive — readdir entries are single segments
      const run = readRun(runId);
      if (!run) continue;
      if (!best || run.state.updated_at > best.state.updated_at) best = run;
    }
  } catch {
    // unreadable runs dir — no CTO session available
  }
  return best;
}

// ── Safe enumeration (visualize projection) ─────────────────────────────────

/**
 * Read one per-feature source. Null when the feature dir has no state.json
 * (a dir without state is not a session). A corrupt state.json becomes an
 * `error` entry here — enumeration never throws; the report's exact-id probe
 * keeps throwing instead (see resolveDoWorkSource).
 */
function readFeatureSource(wsDir: string, slug: string): DoWorkSessionSource | null {
  if (!isSinglePathSegment(slug)) return null; // defensive — readdir entries are single segments
  const featureDir = join(wsDir, FEATURES_DIR, slug);
  const statePath = join(featureDir, "state.json");
  if (!existsSync(statePath)) return null;
  const base = {
    kind: "do-work" as const,
    id: slug,
    statePath,
    stateDir: featureDir,
    artifactsDir: join(featureDir, "artifacts"),
    isLegacy: false,
  };
  try {
    const state = JSON.parse(readFileSync(statePath, "utf8")) as TeamState;
    return { ...base, state, status: "ok" as const, updatedAt: state.updated_at };
  } catch {
    return { ...base, state: null, status: "error" as const, error: "unreadable state.json", updatedAt: null };
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
export function listDoWorkSources(cwd: string): DoWorkSessionSource[] {
  const wsDir = resolve(cwd, WORK_STATE_DIR);
  const out: DoWorkSessionSource[] = [];
  const legacyPath = join(wsDir, LEGACY_STATE);
  if (existsSync(legacyPath)) {
    try {
      const state = JSON.parse(readFileSync(legacyPath, "utf8")) as TeamState;
      out.push({
        kind: "do-work",
        id: "legacy",
        state,
        statePath: legacyPath,
        stateDir: wsDir,
        artifactsDir: join(wsDir, "artifacts"),
        isLegacy: true,
        status: "ok",
        updatedAt: state.updated_at,
      });
    } catch {
      out.push({
        kind: "do-work",
        id: "legacy",
        state: null,
        statePath: legacyPath,
        stateDir: wsDir,
        artifactsDir: join(wsDir, "artifacts"),
        isLegacy: true,
        status: "error",
        error: "unreadable team-state.json",
        updatedAt: null,
      });
    }
  }
  const featuresDir = join(wsDir, FEATURES_DIR);
  if (existsSync(featuresDir)) {
    let names: string[];
    try {
      names = readdirSync(featuresDir);
    } catch {
      names = [];
    }
    for (const slug of names) {
      const entry = readFeatureSource(wsDir, slug);
      if (!entry) continue;
      if (entry.id === "legacy") {
        out.push({
          ...entry,
          status: "degraded",
          error: "id 'legacy' is reserved for the legacy root state — feature reachable only by category",
        });
        continue;
      }
      out.push(entry);
    }
  }
  return sortSources(out);
}

/**
 * Enumerate every CTO run deterministically. JSON runs are `ok`; a corrupt
 * `state.json` is an `error` entry (category-only — the report path skips
 * it); agent-written markdown runs are `ok` while active and become a
 * degraded `terminalMarkdown` projection once a summary/integration-review
 * marker finishes them. Ordering: updated_at desc, then id — never
 * filesystem enumeration order.
 */
export function listCtoSources(cwd: string): CtoSessionSource[] {
  const runsDir = join(cwd, WORK_STATE_DIR, CTO_DIR);
  if (!existsSync(runsDir)) return [];
  let names: string[];
  try {
    names = readdirSync(runsDir);
  } catch {
    return []; // unreadable runs dir — no CTO sessions
  }
  const out: CtoSessionSource[] = [];
  for (const runId of names) {
    if (!isSinglePathSegment(runId)) continue; // defensive — readdir entries are single segments; exotic names are kept verbatim, never aliased
    const runDir = join(runsDir, runId);
    let isDir = false;
    try {
      isDir = statSync(runDir).isDirectory();
    } catch {
      continue;
    }
    if (!isDir) continue; // a stray file under cto/ is not a run
    const statePath = join(runDir, "state.json");
    if (existsSync(statePath)) {
      let state: CtoState | null = null;
      try {
        state = readCtoState(runId, cwd);
      } catch {
        state = null;
      }
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
    const mdState = markdownCtoState(runId, runDir);
    if (mdState) {
      out.push({
        kind: "cto",
        id: runId,
        state: mdState,
        statePath: null,
        runDir,
        format: "markdown",
        status: "ok",
        updatedAt: mdState.updated_at,
      });
      continue;
    }
    if (isTerminalMarkdownRun(runDir)) {
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
        updatedAt: newestRunLocalMtime(runDir),
      });
    }
    // No state at all (no state.json, no markdown evidence) — not a session.
  }
  return sortSources(out);
}

/**
 * Every discoverable session (do-work + cto) in the total deterministic
 * order — the visualize entry point for the "all sessions" scope.
 */
export function listSessions(cwd: string): SessionSourceEntry[] {
  return sortSources([...listDoWorkSources(cwd), ...listCtoSources(cwd)]);
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

/**
 * True when an agent-written markdown run was finished by a
 * summary/integration-review marker (i.e. `markdownCtoState` returns null
 * for the finish-marker reason, not the missing-evidence reason).
 */
function isTerminalMarkdownRun(runDir: string): boolean {
  let names: string[];
  try {
    names = readdirSync(runDir);
  } catch {
    return false;
  }
  return (
    names.some((n) => CTO_MD_EVIDENCE.includes(n)) &&
    names.some((n) => CTO_MD_FINISH_MARKERS.includes(n))
  );
}

/** Newest mtime across run-local .md/.json files (mirrors markdownCtoState's updated_at). */
function newestRunLocalMtime(runDir: string): string | null {
  let newest = 0;
  let names: string[];
  try {
    names = readdirSync(runDir);
  } catch {
    return null;
  }
  for (const name of names) {
    if (!name.endsWith(".md") && !name.endsWith(".json")) continue;
    try {
      newest = Math.max(newest, statSync(join(runDir, name)).mtimeMs);
    } catch {
      // missing/racy — skip
    }
  }
  return newest > 0 ? new Date(newest).toISOString() : null;
}
