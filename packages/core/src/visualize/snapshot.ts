/**
 * Visualize OPT-A — one-read canonical snapshot construction (architecture-3).
 *
 * Builds the immutable normalized session model (VisualizationSession) from
 * canonical workflow state plus discovered artifact files. Reads once:
 * the state text is read once (raw bytes for the digest and source
 * descriptor), every artifact is stat'ed once and read at most once from its
 * bounded head window. No renderers, serializers, HTML, writer or command
 * wiring live here (architecture-4..8).
 *
 * Status vocabulary (frozen in types.ts):
 *   produced  — file present and readable (or oversized head preview);
 *   missing   — declared, no file, and no pending/skipped/consilium rule;
 *   pending   — declaring stage pending, or mid-consilium shared base absent
 *               while its producer is in_progress and slots exist;
 *   skipped   — persisted skipped stage, or an id that is not a safe path
 *               key (never addressed, never read);
 *   unreadable— parse failure within a file fully contained by the read
 *               window, or a read error (IO).
 * A file larger than the read window is NEVER unreadable for content beyond
 * the window: it is `produced` with an explicit preview flag, size/read
 * marker and a session warning. Only parse failures inside a file fully
 * contained by the read window count as unreadable.
 *
 * Safety (security contract):
 *   - ids must be safe path keys (SAFE_PATH_KEY_RE); unsafe ids are skipped;
 *   - declared paths must be safe RELATIVE paths inside `.work-state` that
 *     do not escape via `..`/absolute/backslash segments and are not
 *     excluded inputs (events.jsonl, vibe-report, .work-state/visualize);
 *     symlinked files whose realpath leaves the work-state root are
 *     rejected; excluded inputs are never discovered, never read;
 *   - the snapshot is strictly read-only: canonical state and artifact
 *     files are never written or mutated.
 *
 * Determinism / BG-1 (SLICE-0 pin): the SHA-256 source digest hashes the
 * canonical state content plus per-artifact {id, present, sizeBytes,
 * bounded readBytes} sorted by id; mtime is excluded from the digest, the
 * normalized model and every rendered field by construction. For identical
 * inputs and a fixed `generatedAt` every field is byte-identical except the
 * explicitly volatile fields (generatedAt, provenance.generatedAt,
 * manifest.generatedAt, staleness).
 *
 * Reused contracts: the frozen vocabulary/comparators from types.ts and the
 * extracted source discovery from report/session-source.ts are the single
 * source of truth for layouts, ids, statuses and ordering; nothing here
 * re-implements or conflicts with them.
 */

import { createHash } from "node:crypto";
import { closeSync, existsSync, openSync, readFileSync, readdirSync, readSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import { readDoDFileSafe, type DodSafeFileRead, resolveDodPath } from "../engine/dod.js";
import { loadProfile } from "../engine/profile.js";
import type { TeamState } from "../engine/types.js";
import type { CtoState } from "../cto/types.js";
import {
  CTO_MD_EVIDENCE,
  CTO_MD_FINISH_MARKERS,
  EXCLUDED_SOURCE_NAMES,
  WORK_STATE_DIR,
  ctoTeamArtifactsDir,
  isExcludedSourcePath,
  type SessionSourceEntry,
} from "../report/session-source.js";
import { redactReportBody } from "../report/redact.js";
import {
  BOUNDED_DIGEST_LENGTH,
  DEFAULT_RENDERER_IDENTITY,
  EMPTY_BODY_MARKER,
  LEGACY_ROOT_PATH_KEY,
  MAX_COLLECTION_ITEMS,
  MAX_DEPTH,
  MAX_SCALAR_CHARS,
  REDACTED_MARKER,
  compareArtifactIds,
  compareSessions,
  formatBoundsMarker,
  formatTruncationMarker,
  isSafePathKey,
  isTypedArtifactId,
  serializeDigestInput,
  slotBaseOf,
  stalenessOf,
  type ArtifactStatus,
  type BoundsOmission,
  type DigestArtifactContribution,
  type ErrorCategory,
  type RedactedBody,
  type SessionKind,
  type SourceDescriptor,
  type SourceDigest,
  type StageProgressEntry,
  type VisualizationArtifact,
  type VisualizationSession,
  type WorkflowName,
} from "./types.js";
import { resolveRenderConfig, type RenderConfig } from "./render-config.js";

// ── Options ──────────────────────────────────────────────────────────────────

export interface BuildSessionSnapshotOptions {
  /** ISO timestamp — the only volatile model field (fixed clock in tests). */
  generatedAt: string;
  /** --full: bigger bounded body/read caps; never weakens redaction. */
  full?: boolean;
  /** Pre-resolved render config; default: resolveRenderConfig(workflow, full). */
  renderConfig?: RenderConfig;
}

// ── Deterministic stage titles (architecture-1 golden vocabulary) ───────────

/**
 * Reader-visible stage titles for the well-known stage ids. Unknown stage ids
 * keep `title` absent (StageProgressEntry.title is optional); the map is
 * static and deterministic — profile titles are never loaded into the model.
 */
const STAGE_TITLES: Readonly<Record<string, string>> = {
  intake_repo_map: "Repository intake map",
  requirements_edge_cases: "Requirements and edge cases",
  options_decision_log: "Options and decision log",
  architecture_task_slices: "Architecture and task slices",
  completeness_gate: "Completeness gate",
  handoff: "Handoff",
  discovery: "Discovery",
  diagnose: "Diagnose",
  implementation: "Implementation",
  review: "Review",
  manual_qa: "Manual QA",
  summary: "Summary",
};

// ── Small pure helpers ───────────────────────────────────────────────────────

function asList(value: string | string[] | undefined): string[] {
  if (Array.isArray(value)) return value;
  return value ? [value] : [];
}

/** Map a discovered entry kind (+ legacy flag) onto the model SessionKind. */
function sessionKindOf(entry: SessionSourceEntry): SessionKind {
  if (entry.kind === "cto") return "cto";
  if (entry.kind === "do-work" && entry.isLegacy) return "legacy";
  return "feature";
}

/** Stable session title — derived from validated identity, never raw text. */
function sessionTitleFor(kind: SessionKind, id: string): string {
  return kind === "cto" ? `CTO run ${id}` : `${id} feature worktree`;
}

function cwdRelativeLabel(cwd: string, absPath: string): string {
  const rel = relative(cwd, absPath);
  return rel === "" ? "." : rel;
}

/** Declared id → producing stage id per the workflow profile (produces order). */
function producesByStageOf(workflow: WorkflowName): Map<string, string> {
  const out = new Map<string, string>();
  let profile;
  try {
    profile = loadProfile(workflow);
  } catch {
    profile = null;
  }
  for (const stage of profile?.stages ?? []) {
    for (const id of asList(stage.produces)) out.set(id, stage.id);
  }
  return out;
}

/** Flattened workflow produces order — the declared artifact order contract. */
function declaredOrderOf(workflow: WorkflowName): string[] {
  let profile;
  try {
    profile = loadProfile(workflow);
  } catch {
    profile = null;
  }
  const order: string[] = [];
  for (const stage of profile?.stages ?? []) order.push(...asList(stage.produces));
  return order;
}

// ── Safe file access ─────────────────────────────────────────────────────────

/** Real path of the workspace's `.work-state` root (boundary for escapes). */
function workStateRealRoot(cwd: string): string {
  const ws = resolve(cwd, WORK_STATE_DIR);
  try {
    return existsSync(ws) ? realpathSync(ws) : ws;
  } catch {
    return ws;
  }
}

/**
 * Validate a declared artifact reference: safe relative path inside
 * `.work-state`, no escapes, not an excluded input. Returns the resolved
 * absolute path + safe relative label, or a rejection reason.
 */
function resolveDeclaredPath(
  cwd: string,
  ref: string,
): { absPath: string; label: string } | { invalid: "unsafe-path" | "excluded-path" } {
  if (isAbsolute(ref) || /^[A-Za-z]:[\\/]/.test(ref) || ref.includes("\\")) return { invalid: "unsafe-path" };
  const segments = ref.split("/");
  if (segments.some((s) => s === "" || s === "." || s === "..")) return { invalid: "unsafe-path" };
  const absPath = resolve(cwd, ref);
  const wsRoot = resolve(cwd, WORK_STATE_DIR);
  const rel = relative(wsRoot, absPath);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return { invalid: "unsafe-path" };
  if (isExcludedSourcePath(cwd, absPath)) return { invalid: "excluded-path" };
  return { absPath, label: cwdRelativeLabel(cwd, absPath) };
}

/**
 * True when the artifact file escapes the workspace via a symlink — the file
 * exists but its realpath leaves the real work-state root.
 */
function escapesViaSymlink(cwd: string, absPath: string): boolean {
  if (!existsSync(absPath)) return false;
  let real: string;
  try {
    real = realpathSync(absPath);
  } catch {
    return true; // broken symlink — unusable
  }
  const root = workStateRealRoot(cwd);
  const rel = relative(root, real);
  return rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel);
}

/** Total byte size of an existing file; null when absent/unstatable. */
function statSizeOf(absPath: string): number | null {
  try {
    return statSync(absPath).size;
  } catch {
    return null;
  }
}

/**
 * Read at most `maxBytes` from the head of a file. Returns the bounded head
 * text; null on any read error. The caller has already stat'ed the file, so
 * this is the single read of the artifact's bounded head window.
 */
function readBoundedHead(filePath: string, maxBytes: number): string | null {
  try {
    const fd = openSync(filePath, "r");
    try {
      const size = statSync(filePath).size;
      const want = Math.min(size, Math.max(0, maxBytes));
      const buf = Buffer.allocUnsafe(Math.max(0, want));
      const got = want > 0 ? readSync(fd, buf, 0, want, 0) : 0;
      return got > 0 ? buf.subarray(0, got).toString("utf8") : "";
    } finally {
      try {
        closeSync(fd);
      } catch {
        // descriptor already released — ignore
      }
    }
  } catch {
    return null;
  }
}

// ── State content (one read, raw bytes) ──────────────────────────────────────

interface StateRead {
  /** Canonical state text exactly as read (digest input). */
  text: string;
  /** Safe relative label for the session source descriptor. */
  label: string;
  format: "json" | "markdown";
}

/** Deterministic canonical state text for a session entry (one raw read). */
function readStateContent(cwd: string, entry: SessionSourceEntry): StateRead {
  if (entry.kind === "do-work") {
    if (entry.statePath && existsSync(entry.statePath)) {
      try {
        return { text: readFileSync(entry.statePath, "utf8"), label: cwdRelativeLabel(cwd, entry.statePath), format: "json" };
      } catch {
        // fall through — unreadable state yields an empty canonical text
      }
    }
    return { text: "", label: entry.statePath ? cwdRelativeLabel(cwd, entry.statePath) : ".work-state", format: "json" };
  }
  // CTO: state.json first; markdown-state runs use the evidence/finish files.
  if (entry.statePath && existsSync(entry.statePath)) {
    try {
      return { text: readFileSync(entry.statePath, "utf8"), label: cwdRelativeLabel(cwd, entry.statePath), format: "json" };
    } catch {
      // fall through to the markdown candidates
    }
  }
  const candidates = entry.terminalMarkdown ? [...CTO_MD_FINISH_MARKERS] : [...CTO_MD_EVIDENCE];
  for (const name of candidates) {
    const p = join(entry.runDir, name);
    if (existsSync(p)) {
      try {
        return { text: readFileSync(p, "utf8"), label: `.work-state/cto/${entry.id}`, format: "markdown" };
      } catch {
        continue;
      }
    }
  }
  return { text: "", label: `.work-state/cto/${entry.id}`, format: "markdown" };
}

/** First `# ` heading of a markdown state text — the run task (like markdownCtoState). */
function markdownTask(text: string): string {
  const line = text.split("\n").find((l) => l.startsWith("# "));
  return line ? line.replace(/^#\s+/, "").trim() : "";
}

/**
 * Task for a terminal markdown run: derived from the evidence files exactly
 * like markdownCtoState (cto_discovery.md first, then team-plan.md) — the
 * finish-marker state text (summary.md) is the digest source, not the task.
 */
function terminalMarkdownTask(runDir: string): string {
  for (const name of ["cto_discovery.md", "team-plan.md"]) {
    const p = join(runDir, name);
    if (!existsSync(p)) continue;
    try {
      const task = markdownTask(readFileSync(p, "utf8"));
      if (task !== "") return task;
    } catch {
      // unreadable — try the next evidence file
    }
  }
  return "";
}

// ── Artifact plans ───────────────────────────────────────────────────────────

interface ArtifactPlan {
  id: string;
  /** Declared in canonical state (do-work) or resolved from state (CTO). */
  declared: boolean;
  /** Owning stage id (do-work) / team id (CTO); "" when unclaimed/run-local. */
  owner: string;
  /** Consilium base id when this id is a discovered slot (`<base>-<role>`). */
  slotFor?: string;
  /** Rejection reason; the artifact is never read when set. */
  invalid?: "unsafe-id" | "unsafe-path" | "excluded-path";
  /** Resolved absolute path (may not exist → missing/pending/skipped). */
  absPath?: string;
  /** Safe relative source label (never absolute, never escaping). */
  label?: string;
  /** dod_path artifact: single safe fd-bound read captured at plan time; the render pipeline never reopens the pathname when set. */
  safeRead?: DodSafeFileRead;
}

/**
 * Head window of a safe fd-bound read's raw text (mirrors readBoundedHead's
 * byte cap) so safe-read artifacts keep identical window semantics.
 */
function windowOfSafeRead(read: Extract<DodSafeFileRead, { ok: true }>, windowBytes: number): string {
  return Buffer.from(read.raw, "utf8").subarray(0, Math.min(read.bytes, windowBytes)).toString("utf8");
}

/** Deterministic top-level scan of a directory for JSON artifact files. */
function scanJsonArtifacts(
  cwd: string,
  dir: string,
  onEntry: (id: string, absPath: string) => void,
): void {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  names.sort();
  for (const name of names) {
    if (EXCLUDED_SOURCE_NAMES[name]) continue;
    if (!name.endsWith(".json")) continue;
    const absPath = join(dir, name);
    try {
      if (!statSync(absPath).isFile()) continue;
    } catch {
      continue;
    }
    if (isExcludedSourcePath(cwd, absPath)) continue;
    onEntry(name.slice(0, -".json".length), absPath);
  }
}

/** Do-work artifact plan: state.artifacts (declared) + artifacts dir extras. */
function planDoWorkArtifacts(
  cwd: string,
  entry: Extract<SessionSourceEntry, { kind: "do-work" }>,
  state: TeamState,
): { plans: ArtifactPlan[]; declaredOrder: string[] } {
  const workflow = state.classification.workflow;
  const declaredOrder = declaredOrderOf(workflow);
  const producesByStage = producesByStageOf(workflow);
  const declared = new Set(Object.keys(state.artifacts ?? {}));
  const plans = new Map<string, ArtifactPlan>();

  for (const [id, ref] of Object.entries(state.artifacts ?? {})) {
    const owner = producesByStage.get(id) ?? "";
    if (!isSafePathKey(id)) {
      plans.set(id, { id, declared: true, owner, invalid: "unsafe-id" });
      continue;
    }
    const resolved = resolveDeclaredPath(cwd, ref);
    if ("invalid" in resolved) {
      plans.set(id, { id, declared: true, owner, invalid: resolved.invalid });
      continue;
    }
    plans.set(id, { id, declared: true, owner, absPath: resolved.absPath, label: resolved.label, ...(id === "dod" ? { safeRead: readDoDFileSafe(cwd, resolved.absPath) } : {}) });
  }

  // Discovered extras: slot files attach to their declared base, anything
  // else stays unclaimed. Excluded inputs are never discovered.
  scanJsonArtifacts(cwd, entry.artifactsDir, (id, absPath) => {
    if (declared.has(id)) return;
    const base = slotBaseOf(id, declared);
    const owner = base ? (producesByStage.get(base) ?? "") : "";
    plans.set(id, { id, declared: false, owner, ...(base ? { slotFor: base } : {}), absPath, label: cwdRelativeLabel(cwd, absPath), ...(id === "dod" ? { safeRead: readDoDFileSafe(cwd, absPath) } : {}) });
  });

  return { plans: [...plans.values()], declaredOrder };
}

/** CTO artifact plan: run-local + team compatibility + validated dod_path. */
function planCtoArtifacts(
  cwd: string,
  entry: Extract<SessionSourceEntry, { kind: "cto" }>,
  state: CtoState,
  warnings: string[],
): { plans: ArtifactPlan[]; declaredOrder: string[] } {
  const declaredOrder = declaredOrderOf("cto");
  const plans = new Map<string, ArtifactPlan>();
  const reserved = new Set<string>();
  const add = (id: string, owner: string, absPath: string, label: string, safeRead?: DodSafeFileRead): void => {
    if (reserved.has(id)) return; // fail-closed reservation: no generic fallback
    if (plans.has(id)) {
      warnings.push(`artifact ${id} exists in multiple locations: first resolution wins`);
      return;
    }
    plans.set(id, { id, declared: true, owner, absPath, label, ...(safeRead ? { safeRead } : {}) });
  };

  // 1. Canonical team DoD for EVERY team (explicit dod_path or the unset/
  //    default team artifacts dir), planned BEFORE all generic scans through
  //    the fd-bound safe read. Plan ids are globally unique: the first
  //    canonical claim wins, and an unsafe canonical path RESERVES the dod id
  //    (fail-closed, excluded from rendering) so scans can never provide a
  //    fallback.
  for (const team of state.teams ?? []) {
    // Canonical dod_path resolution (directory containing dod.json OR the
    // dod.json file itself; default team artifacts dir when unset).
    const resolved = resolveDodPath(cwd, team.dod_path, team.id);
    if (!resolved.ok) {
      // Fail closed: warn and RESERVE the dod id so run-local and
      // compatibility scans can never provide a fallback.
      warnings.push(`declared path for dod is not a safe relative path: excluded from rendering`);
      reserved.add("dod");
      continue;
    }
    if (isExcludedSourcePath(cwd, resolved.file)) {
      // Canonical exclusion contract (same predicate as declared paths):
      // generated visualize output, vibe-report documentation and the
      // observability event stream are never artifact inputs — warn and
      // reserve against any generic fallback.
      warnings.push(`declared path for dod is not a safe relative path: excluded from rendering`);
      reserved.add("dod");
      continue;
    }
    const safe = readDoDFileSafe(cwd, resolved.file);
    if (!safe.ok && safe.kind === "missing") {
      // Absent canonical DoD: reserve against generic fallback but keep the
      // prior no-artifact behavior — no missing plan is added.
      reserved.add("dod");
      continue;
    }
    reserved.delete("dod"); // a real canonical file outranks an earlier absence
    add("dod", team.id, resolved.file, cwdRelativeLabel(cwd, resolved.file), safe);
  }

  // 2. Run-local artifacts: .work-state/cto/<runId>/artifacts/*.json. A
  //    discovered dod.json is safe-read, never pathname-read.
  scanJsonArtifacts(cwd, join(entry.runDir, "artifacts"), (id, absPath) => {
    add(id, "", absPath, cwdRelativeLabel(cwd, absPath), id === "dod" ? readDoDFileSafe(cwd, absPath) : undefined);
  });

  // 3. Team compatibility dirs: .work-state/artifacts/<teamId>/*.json (a
  //    discovered dod.json — e.g. the default-dir DoD of a team without a
  //    configured dod_path — is safe-read, never pathname-read).
  for (const team of state.teams ?? []) {
    scanJsonArtifacts(cwd, ctoTeamArtifactsDir(cwd, team.id), (id, absPath) => {
      add(id, team.id, absPath, cwdRelativeLabel(cwd, absPath), id === "dod" ? readDoDFileSafe(cwd, absPath) : undefined);
    });
  }

  return { plans: [...plans.values()], declaredOrder };
}

/** Deterministic model id order: declared produces order → slots → extras. */
function orderedIds(plans: ArtifactPlan[], declaredOrder: readonly string[]): string[] {
  return plans.map((p) => p.id).sort((a, b) => compareArtifactIds(a, b, declaredOrder));
}

// ── Bounded JSON parse (depth/collection/scalar bounds + keys/summary) ───────

interface ParseOutcome {
  ok: boolean;
  keys?: string[];
  summary?: string;
  bounds?: BoundsOmission;
}

/**
 * Deterministic bounded parse of artifact text. `ok: false` means JSON.parse
 * failed (→ unreadable when the file is fully inside the read window).
 * Parsed non-object values are still `ok: true` (a top-level array is valid
 * JSON) but yield no keys/summary. Enforces MAX_DEPTH (8),
 * MAX_COLLECTION_ITEMS (200) and MAX_SCALAR_CHARS (8192) and reports visible
 * omission markers when a bound was exceeded. The walk only derives
 * top-level keys and a bounded summary; it never embeds values.
 */
function boundedParse(text: string): ParseOutcome {
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    return { ok: false };
  }
  const counters = { depthTruncated: false, omittedCollections: 0, omittedScalars: 0 };

  const walk = (node: unknown, depth: number): void => {
    if (depth > MAX_DEPTH) {
      counters.depthTruncated = true;
      return;
    }
    if (Array.isArray(node)) {
      if (node.length > MAX_COLLECTION_ITEMS) counters.omittedCollections += 1;
      for (const item of node.slice(0, MAX_COLLECTION_ITEMS)) walk(item, depth + 1);
      return;
    }
    if (node && typeof node === "object") {
      const entries = Object.entries(node as Record<string, unknown>);
      if (entries.length > MAX_COLLECTION_ITEMS) counters.omittedCollections += 1;
      for (const [, child] of entries.slice(0, MAX_COLLECTION_ITEMS)) walk(child, depth + 1);
      return;
    }
    if (typeof node === "string" && node.length > MAX_SCALAR_CHARS) counters.omittedScalars += 1;
  };
  walk(value, 1);

  const bounds: BoundsOmission | undefined =
    counters.depthTruncated || counters.omittedCollections > 0 || counters.omittedScalars > 0
      ? {
          maxDepth: MAX_DEPTH,
          maxCollectionItems: MAX_COLLECTION_ITEMS,
          maxScalarChars: MAX_SCALAR_CHARS,
          depthTruncated: counters.depthTruncated,
          omittedCollections: counters.omittedCollections,
          omittedScalars: counters.omittedScalars,
          marker: formatBoundsMarker(counters.depthTruncated, counters.omittedCollections, counters.omittedScalars),
        }
      : undefined;

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: true, ...(bounds ? { bounds } : {}) };
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  let summary: string | undefined;
  if (record.summary !== undefined) {
    const raw = String(record.summary);
    summary = raw.length > MAX_SCALAR_CHARS ? raw.slice(0, MAX_SCALAR_CHARS) : raw;
  }
  return {
    ok: true,
    keys,
    ...(summary !== undefined ? { summary } : {}),
    ...(bounds ? { bounds } : {}),
  };
}

// ── Body building (redaction before caps, at every verbosity) ────────────────

/**
 * Redacted, capped, embedded body. Redaction always applies before the cap;
 * `preview: true` means only the bounded head window was ever read. Empty
 * content becomes [empty], fully-redacted content becomes [redacted].
 */
function buildBody(text: string, originalBytes: number, windowBytes: number, capBytes: number): RedactedBody {
  const preview = originalBytes > windowBytes;
  const redacted = redactReportBody(text, capBytes);
  const bodyText = text === "" ? EMPTY_BODY_MARKER : redacted === "" ? REDACTED_MARKER : redacted;
  const truncated = preview || originalBytes > capBytes;
  return {
    text: bodyText,
    truncated,
    originalBytes,
    capBytes,
    preview,
    marker: truncated ? formatTruncationMarker(originalBytes, capBytes) : "",
  };
}

// ── Artifact model construction ──────────────────────────────────────────────

interface BuildContext {
  cwd: string;
  renderConfig: RenderConfig;
  stageStatuses: Map<string, string>;
  warnings: string[];
  contributions: Map<string, DigestArtifactContribution>;
}

/**
 * Classify a declared-but-absent artifact: skipped/pending from the stage
 * rules, or the mid-consilium pending rule when the producer is in_progress
 * and slot files exist. Discovered extras that vanished are `missing`.
 */
function absentStatusOf(
  plan: ArtifactPlan,
  slotsOfBase: ReadonlySet<string>,
  stageStatuses: ReadonlyMap<string, string>,
): ArtifactStatus {
  if (!plan.declared) return "missing";
  const stage = stageStatuses.get(plan.owner);
  if (stage === "skipped") return "skipped";
  if (stage === "pending") return "pending";
  if (stage === "in_progress" && slotsOfBase.has(plan.id)) return "pending";
  return "missing";
}

function buildArtifactModel(plans: ArtifactPlan[], declaredOrder: readonly string[], ctx: BuildContext): VisualizationArtifact[] {
  const { cwd, renderConfig, stageStatuses, warnings, contributions } = ctx;
  const windowBytes = renderConfig.options.readWindowBytes;
  const capBytes = renderConfig.options.bodyCapBytes;
  const bodiesEnabled = renderConfig.bodiesEnabled;
  const ids = orderedIds(plans, declaredOrder);
  const byId = new Map(plans.map((p) => [p.id, p]));

  // Slot bases present among discovered extras (mid-consilium pending rule).
  const slotsOfBase = new Set<string>();
  for (const p of plans) {
    if (p.slotFor) slotsOfBase.add(p.slotFor);
  }

  const slotOf = (id: string): { slotFor: string } | {} => {
    const base = byId.get(id)?.slotFor;
    return base ? { slotFor: base } : {};
  };

  const artifacts: VisualizationArtifact[] = [];
  for (const id of ids) {
    const plan = byId.get(id);
    if (!plan) continue;

    // Rejected ids are skipped and never read (unsafe id / unsafe path).
    if (plan.invalid === "unsafe-id") {
      warnings.push(`artifact id "${id}" is not a safe path key: skipped`);
      const size = plan.absPath ? statSizeOf(plan.absPath) : null;
      contributions.set(id, { id, present: size !== null, sizeBytes: size ?? 0, readBytes: size === null ? 0 : Math.min(size, windowBytes) });
      artifacts.push({ id, owner: plan.owner, status: "skipped", ...slotOf(id) });
      continue;
    }
    if (plan.invalid === "unsafe-path" || plan.invalid === "excluded-path") {
      warnings.push(`declared path for ${id} is not a safe relative path: excluded from rendering`);
      contributions.set(id, { id, present: false, sizeBytes: 0, readBytes: 0 });
      artifacts.push({ id, owner: plan.owner, status: "missing", ...slotOf(id) });
      continue;
    }

    const safeRead = plan.safeRead;
    let size: number | null;
    let text: string | null;

    if (safeRead) {
      // dod_path artifact: read ONCE at plan time via the safe fd-bound read
      // (O_NOFOLLOW, regular-file check, fd/path inode bind, cwd containment).
      // Rendering consumes that result and NEVER reopens the pathname.
      if (!safeRead.ok) {
        if (safeRead.kind === "missing") {
          // Absent — declared rules apply; never unreadable (no path stats).
          const status = absentStatusOf(plan, slotsOfBase, stageStatuses);
          contributions.set(id, { id, present: false, sizeBytes: 0, readBytes: 0 });
          if (status === "pending" && plan.declared && stageStatuses.get(plan.owner) === "in_progress" && slotsOfBase.has(plan.id)) {
            warnings.push(`shared artifact ${plan.id} is pending: producer in_progress, slots present`);
          } else if (status === "missing") {
            warnings.push(`declared artifact ${id} is missing`);
          }
          artifacts.push({ id, owner: plan.owner, status, ...slotOf(id) });
        } else {
          // Symlink / non-regular / boundary / changed — refused at read time; never parsed.
          warnings.push(`artifact ${id} is not a safe regular file inside the workspace: skipped`);
          contributions.set(id, { id, present: true, sizeBytes: 0, readBytes: 0 });
          artifacts.push({ id, owner: plan.owner, status: "skipped", ...slotOf(id) });
        }
        continue;
      }
      size = safeRead.bytes;
      text = windowOfSafeRead(safeRead, windowBytes);
    } else {
      const absPath = plan.absPath;
      if (!absPath) {
        contributions.set(id, { id, present: false, sizeBytes: 0, readBytes: 0 });
        artifacts.push({ id, owner: plan.owner, status: "missing", ...slotOf(id) });
        continue;
      }

      size = statSizeOf(absPath);
      if (size === null) {
        // Absent (or unstatable) — declared rules apply; never unreadable.
        const status = absentStatusOf(plan, slotsOfBase, stageStatuses);
        contributions.set(id, { id, present: false, sizeBytes: 0, readBytes: 0 });
        if (status === "pending" && plan.declared && stageStatuses.get(plan.owner) === "in_progress" && slotsOfBase.has(plan.id)) {
          warnings.push(`shared artifact ${plan.id} is pending: producer in_progress, slots present`);
        } else if (status === "missing") {
          warnings.push(`declared artifact ${id} is missing`);
        }
        artifacts.push({ id, owner: plan.owner, status, ...slotOf(id) });
        continue;
      }

      // Symlink/boundary escape on a resolvable file — rejected, never read.
      if (escapesViaSymlink(cwd, absPath)) {
        warnings.push(`artifact ${id} escapes the workspace via symlink: skipped`);
        contributions.set(id, { id, present: true, sizeBytes: size, readBytes: Math.min(size, windowBytes) });
        artifacts.push({ id, owner: plan.owner, status: "skipped", ...slotOf(id) });
        continue;
      }

      text = readBoundedHead(absPath, windowBytes);
      if (text === null) {
        // Read failure (IO) — unreadable within the window.
        warnings.push(`artifact ${id} is unreadable: read error`);
        contributions.set(id, { id, present: true, sizeBytes: size, readBytes: 0 });
        artifacts.push({ id, owner: plan.owner, status: "unreadable", errorCategory: "read-error", ...slotOf(id) });
        continue;
      }
    }

    contributions.set(id, { id, present: true, sizeBytes: size, readBytes: Math.min(size, windowBytes) });
    const preview = size > windowBytes;
    const parsed = boundedParse(text);
    const base: Pick<VisualizationArtifact, "id" | "owner" | "slotFor"> = { id, owner: plan.owner, ...slotOf(id) };

    // An empty file is empty, not corrupt: produced with the [empty] marker.
    if (text === "") {
      artifacts.push({
        ...base,
        status: "produced",
        source: artifactSource(plan, size, windowBytes),
        bytes: size,
        ...(bodiesEnabled ? { body: buildBody(text, size, windowBytes, capBytes) } : {}),
      });
      continue;
    }

    if (preview) {
      // Oversized: produced with an explicit head preview; never unreadable
      // for content beyond the window. The head is parsed opportunistically.
      warnings.push(`artifact ${id} is larger than the read window: head preview (original bytes > window)`);
      artifacts.push({
        ...base,
        status: "produced",
        source: artifactSource(plan, size, windowBytes),
        bytes: size,
        ...(parsed.keys ? { keys: parsed.keys } : {}),
        ...(parsed.summary !== undefined ? { summary: parsed.summary } : {}),
        ...(parsed.bounds ? { bounds: parsed.bounds } : {}),
        ...(bodiesEnabled ? { body: buildBody(text, size, windowBytes, capBytes) } : {}),
        ...(parsed.ok ? {} : ({ errorCategory: "oversized-unparsed" as ErrorCategory })),
      });
      continue;
    }

    // Fully contained by the read window: parse failure → unreadable.
    if (!parsed.ok) {
      warnings.push(`artifact ${id} is unreadable: invalid JSON within the read window`);
      artifacts.push({
        ...base,
        status: "unreadable",
        errorCategory: "invalid-json",
        source: artifactSource(plan, size, windowBytes),
        bytes: size,
      });
      continue;
    }

    artifacts.push({
      ...base,
      status: "produced",
      source: artifactSource(plan, size, windowBytes),
      bytes: size,
      type: isTypedArtifactId(id) ? id : undefined,
      ...(parsed.keys ? { keys: parsed.keys } : {}),
      ...(parsed.summary !== undefined ? { summary: parsed.summary } : {}),
      ...(parsed.bounds ? { bounds: parsed.bounds } : {}),
      ...(bodiesEnabled ? { body: buildBody(text, size, windowBytes, capBytes) } : {}),
    });
  }
  return artifacts;
}

function artifactSource(plan: ArtifactPlan, bytes: number, windowBytes: number): SourceDescriptor {
  return {
    kind: "artifact",
    label: plan.label ?? plan.id,
    bytes,
    readBytes: Math.min(bytes, windowBytes),
    readWindowBytes: windowBytes,
    format: "json",
  };
}

// ── Digest (SLICE-0/BG-1) ────────────────────────────────────────────────────

/** sha256 over the canonical serialization — the pinned BG-1 rule. */
function computeSourceDigest(stateContent: string, contributions: Iterable<DigestArtifactContribution>): SourceDigest {
  const artifacts = [...contributions].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const serialized = serializeDigestInput({ stateContent, artifacts });
  const full = createHash("sha256").update(serialized, "utf8").digest("hex");
  return {
    algorithm: "sha256",
    full,
    bounded: full.slice(0, BOUNDED_DIGEST_LENGTH),
    inputBytes: Buffer.byteLength(serialized, "utf8"),
  };
}

// ── Stage model ──────────────────────────────────────────────────────────────

/** Ordered stage progress: declared produces + attached slots per stage. */
function buildStages(
  state: TeamState,
  artifacts: VisualizationArtifact[],
  declaredOrder: readonly string[],
): StageProgressEntry[] {
  const byOwner = new Map<string, string[]>();
  for (const a of artifacts) {
    const list = byOwner.get(a.owner) ?? [];
    list.push(a.id);
    byOwner.set(a.owner, list);
  }
  return (state.stages ?? []).map((s) => ({
    stageId: s.id,
    ...(STAGE_TITLES[s.id] ? { title: STAGE_TITLES[s.id] } : {}),
    status: s.status,
    artifactIds: (byOwner.get(s.id) ?? []).sort((a, b) => compareArtifactIds(a, b, declaredOrder)),
  }));
}

// ── Session construction ─────────────────────────────────────────────────────

/** Identity for a session entry — usable even when the state is unreadable. */
function identityBaseOf(entry: SessionSourceEntry): {
  kind: SessionKind;
  id: string;
  pathKey: string;
} {
  const kind = sessionKindOf(entry);
  return {
    kind,
    id: entry.id,
    pathKey: kind === "legacy" ? LEGACY_ROOT_PATH_KEY : entry.id,
  };
}

/**
 * Build the immutable normalized session model for one discovered session
 * entry. Never mutates canonical state; never throws for corrupt peers.
 */
export function buildSessionSnapshot(
  cwd: string,
  entry: SessionSourceEntry,
  generatedAt: string,
  opts?: BuildSessionSnapshotOptions,
): VisualizationSession {
  const identityBase = identityBaseOf(entry);
  const warnings: string[] = [];
  const contributions = new Map<string, DigestArtifactContribution>();
  const stateRead = readStateContent(cwd, entry);
  const workflow: WorkflowName =
    entry.kind === "cto" ? "cto" : (entry.state?.classification?.workflow ?? "standard");
  const renderConfig = opts?.renderConfig ?? resolveRenderConfig(workflow, opts?.full ?? false);
  const windowBytes = renderConfig.options.readWindowBytes;

  const stateBytes = Buffer.byteLength(stateRead.text, "utf8");
  const provenanceFor = (sourceUpdatedAt: string | undefined, profileHash: string | undefined): VisualizationSession["provenance"] => ({
    ...(sourceUpdatedAt !== undefined ? { sourceUpdatedAt } : {}),
    ...(profileHash ? { profileHash } : {}),
    sourceDigest: computeSourceDigest(stateRead.text, contributions.values()),
    generatedAt,
    renderer: DEFAULT_RENDERER_IDENTITY,
    staleness: stalenessOf(sourceUpdatedAt, generatedAt),
  });
  const sessionSource: SourceDescriptor = {
    kind: "state",
    label: stateRead.label,
    bytes: stateBytes,
    readBytes: stateBytes,
    readWindowBytes: windowBytes,
    format: stateRead.format,
  };

  try {
    // ── Degraded projection: no usable state (corrupt JSON / terminal md). ──
    if (entry.state === null) {
      const degradedReasons =
        entry.kind === "cto" && entry.terminalMarkdown === true
          ? ["terminal markdown CTO state: visualization-only projection"]
          : entry.kind === "cto"
            ? ["unreadable state (JSON or markdown); rendering available content"]
            : [entry.error ?? "unreadable state; rendering available content"];
      return {
        schema: 1,
        identity: {
          ...identityBase,
          title: sessionTitleFor(identityBase.kind, identityBase.id),
          task:
            entry.kind === "cto" && entry.terminalMarkdown === true
              ? terminalMarkdownTask(entry.runDir)
              : "",
          workflow,
          sourceFormat: stateRead.format,
          isLegacy: identityBase.kind === "legacy",
          degraded: true,
        },
        status: "degraded",
        stages: [],
        artifacts: [],
        source: sessionSource,
        provenance: provenanceFor(undefined, undefined),
        warnings,
        degradedReasons,
      };
    }

    // ── Readable state: normal model construction. ─────────────────────────
    const stageStatuses = new Map<string, string>();
    let stagesModel: StageProgressEntry[] = [];
    let artifacts: VisualizationArtifact[] = [];
    let declaredOrder: readonly string[] = [];
    let task = "";
    let sourceUpdatedAt: string | undefined;
    let profileHash: string | undefined;

    if (entry.kind === "do-work") {
      const state = entry.state as TeamState;
      for (const s of state.stages ?? []) stageStatuses.set(s.id, s.status);
      const planned = planDoWorkArtifacts(cwd, entry, state);
      declaredOrder = planned.declaredOrder;
      artifacts = buildArtifactModel(planned.plans, declaredOrder, {
        cwd,
        renderConfig,
        stageStatuses,
        warnings,
        contributions,
      });
      stagesModel = buildStages(state, artifacts, declaredOrder);
      task = state.task ?? "";
      if (stateRead.format === "json") sourceUpdatedAt = state.updated_at;
      if (state.profile_hash) profileHash = state.profile_hash;
      if (artifacts.length === 0) warnings.push("no artifacts yet");
    } else {
      const state = entry.state as CtoState;
      const planned = planCtoArtifacts(cwd, entry, state, warnings);
      declaredOrder = planned.declaredOrder;
      artifacts = buildArtifactModel(planned.plans, declaredOrder, {
        cwd,
        renderConfig,
        stageStatuses,
        warnings,
        contributions,
      });
      task = state.task ?? "";
      if (stateRead.format === "json") sourceUpdatedAt = state.updated_at;
    }

    return {
      schema: 1,
      identity: {
        ...identityBase,
        title: sessionTitleFor(identityBase.kind, identityBase.id),
        task,
        workflow,
        sourceFormat: stateRead.format,
        isLegacy: identityBase.kind === "legacy",
        degraded: false,
      },
      status: "complete",
      stages: stagesModel,
      artifacts,
      source: sessionSource,
      provenance: provenanceFor(sourceUpdatedAt, profileHash),
      warnings,
    };
  } catch (error) {
    // Never abort a bundle for one session: a build failure degrades the
    // session with a category-only warning instead of throwing.
    return {
      schema: 1,
      identity: {
        ...identityBase,
        title: sessionTitleFor(identityBase.kind, identityBase.id),
        task: "",
        workflow,
        sourceFormat: stateRead.format,
        isLegacy: identityBase.kind === "legacy",
        degraded: true,
      },
      status: "degraded",
      stages: [],
      artifacts: [],
      source: sessionSource,
      provenance: provenanceFor(undefined, undefined),
      warnings: [`snapshot build failed: ${String((error as Error)?.message ?? error)}`],
      degradedReasons: ["snapshot build failure; rendering available content"],
    };
  }
}

/**
 * Content-derived session timestamp for the total order (F3). Only
 * timestamps that come from canonical state content (`state.updated_at`)
 * participate: agent-written markdown CTO runs carry no content timestamp,
 * so discovery labels them with the newest run-local filesystem mtime —
 * internal discovery metadata that MUST NOT reorder any rendered surface.
 * Such entries sort deterministically as unknown-timestamp (last, then
 * kind, then id), which is exactly the order the manifest derives from
 * `provenance.sourceUpdatedAt` (absent for markdown state), so the snapshot
 * order, both hubs and the manifest always agree.
 */
function contentUpdatedAtOf(entry: SessionSourceEntry): string | undefined {
  if (entry.kind === "cto" && entry.format === "markdown") return undefined;
  return entry.updatedAt ?? undefined;
}

/**
 * Build snapshots for every entry in the total deterministic session order
 * (content-derived updated_at desc, then kind, then id — never filesystem
 * order, never mtime). Markdown-state CTO entries have no content timestamp
 * (run-local mtime is internal discovery metadata only) and sort last, then
 * kind, then id — identical to the manifest's `sourceUpdatedAt` order.
 */
export function buildSessionSnapshots(
  cwd: string,
  entries: SessionSourceEntry[],
  generatedAt: string,
  opts?: BuildSessionSnapshotOptions,
): VisualizationSession[] {
  const sorted = [...entries].sort((a, b) =>
    compareSessions(
      { updatedAt: contentUpdatedAtOf(a), kind: sessionKindOf(a), id: a.id },
      { updatedAt: contentUpdatedAtOf(b), kind: sessionKindOf(b), id: b.id },
    ),
  );
  return sorted.map((entry) => buildSessionSnapshot(cwd, entry, generatedAt, opts));
}
