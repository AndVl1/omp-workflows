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
 *   - declared paths are accepted only as authority-relative paths inside
 *     `.work-state`, excluding events.jsonl, vibe-report and
 *     `.work-state/visualize`; the storage authority enforces containment,
 *     traversal and symlink policy;
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
/* <!-- omp-cto-slice run=01a03ee4-7dd6-7580-8ad7-16d26dc886ba slice=workflow-v2-core --> */

import { createHash } from "node:crypto";

import {
  decodeStorageText,
  listStorageEntries,
  readStorageBytes,
  requireReportStorage,
  ReportStorageError,
  statStorage,
  storagePath,
  MAX_STORAGE_ENTRIES,
  type ReportStorageAuthority,
  type StorageStat,
} from "../report/storage.js";

import { loadProfileByIdentity } from "../engine/profile.js";
import { validateProviderCatalog } from "../workflow-v2/descriptor.js";
import { isProviderId, isWorkflowV2Digest, validateProjectIdentity, validateWorkflowRunIdentity } from "../workflow-v2/identity.js";
import { createDiagnostic, isDiagnosticEvidenceRecord } from "../workflow-v2/diagnostics.js";
import type { Profile, TeamState } from "../engine/types.js";
import type {
  EffectivePolicy,
  ProjectIdentity,
  ProviderCatalog,
  WorkflowRunIdentity,
  WorkflowV2Diagnostic,
} from "../workflow-v2/types.js";
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

export interface BuildSessionSnapshotContext {
  readonly project_identity: ProjectIdentity;
  readonly catalog: Readonly<ProviderCatalog>;
  readonly effective_policy?: Readonly<EffectivePolicy>;
}

export interface BuildSessionSnapshotOptions {
  /** --full: bigger bounded body/read caps; never weakens redaction. */
  full?: boolean;
  /** Pre-resolved render config; default: resolveRenderConfig(workflow, full). */
  renderConfig?: RenderConfig;
  /** Validated provider identity and immutable catalog supplied by the host. */
  context: BuildSessionSnapshotContext;
}

/**
 * Options shared by a plural snapshot build. A shared context supports
 * homogeneous batches; contextForEntry is the explicit seam for mixed
 * workflow batches and takes precedence when both are supplied.
 */
export interface BuildSessionSnapshotsOptions extends Omit<BuildSessionSnapshotOptions, "context"> {
  /** Shared validated context for homogeneous batches. */
  context?: BuildSessionSnapshotContext;
  /** Resolve a validated context for each entry; takes precedence over context. */
  contextForEntry?: (entry: SessionSourceEntry) => BuildSessionSnapshotContext;
}

export class VisualizationContextError extends Error {
  readonly diagnostic: WorkflowV2Diagnostic;
  readonly diagnostics: readonly WorkflowV2Diagnostic[];

  constructor(diagnostics: readonly WorkflowV2Diagnostic[]) {
    const first = diagnostics[0] ?? createDiagnostic({
      code: "MIGRATION_REQUIRED",
      operation: "profile.resolve",
      remediation: "Pass the admitted provider identity and immutable profile catalog to visualization.",
    });
    super(`${first.code}: ${first.remediation}`);
    this.name = "VisualizationContextError";
    this.diagnostic = first;
    this.diagnostics = Object.freeze(diagnostics.length > 0 ? [...diagnostics] : [first]);
  }
}

function contextFailure(
  code: WorkflowV2Diagnostic["code"],
  remediation: string,
  evidence: Record<string, unknown> = {},
): never {
  throw new VisualizationContextError([
    createDiagnostic({ code, operation: "profile.resolve", evidence, remediation }),
  ]);
}

function requireSnapshotContext(
  options: { readonly context?: unknown },
  workflow: string,
): BuildSessionSnapshotContext {
  const candidate = options.context;
  if (!isDiagnosticEvidenceRecord(candidate)) {
    return contextFailure("MIGRATION_REQUIRED", "Pass the admitted project identity and immutable profile catalog to visualization.");
  }
  const projectResult = validateProjectIdentity(candidate.project_identity);
  if (!projectResult.ok) {
    return contextFailure("MIGRATION_REQUIRED", "Pass the complete validated project identity to visualization.", {
      provider_id: isDiagnosticEvidenceRecord(candidate.project_identity) ? candidate.project_identity.provider_id : undefined,
    });
  }
  const catalogResult = validateProviderCatalog(candidate.catalog);
  if (!catalogResult.ok) {
    throw new VisualizationContextError(catalogResult.diagnostics);
  }
  const projectIdentity = projectResult.value;
  const catalog = catalogResult.value;
  if (projectIdentity.catalog_content_digest !== catalog.content_digest) {
    return contextFailure("IDENTITY_MISMATCH", "Re-read the immutable profile catalog that matches the admitted project identity.", {
      provider_id: projectIdentity.provider_id,
      expected_digest: projectIdentity.catalog_content_digest,
      actual_digest: catalog.content_digest,
    });
  }
  const effective = candidate.effective_policy;
  if (effective !== undefined) {
    const effectiveRecord = isDiagnosticEvidenceRecord(effective) ? effective : undefined;
    const provider = effectiveRecord && isDiagnosticEvidenceRecord(effectiveRecord.provider)
      ? effectiveRecord.provider
      : undefined;
    const workflowSelection = effectiveRecord && isDiagnosticEvidenceRecord(effectiveRecord.workflow)
      ? effectiveRecord.workflow
      : undefined;
    if (
      provider === undefined
      || workflowSelection === undefined
      || !isProviderId(provider.id)
      || provider.protocol_version !== 2
      || !isWorkflowV2Digest(provider.descriptor_fingerprint)
      || !isWorkflowV2Digest(provider.catalog_content_digest)
      || (workflowSelection.selection !== "fixed" && workflowSelection.selection !== "matrix")
    ) {
      return contextFailure("MIGRATION_REQUIRED", "Pass the validated effective workflow policy selected by the admitted provider runtime.", {
        provider_id: projectIdentity.provider_id,
      });
    }
    if (
      provider.id !== projectIdentity.provider_id
      || provider.descriptor_fingerprint !== projectIdentity.descriptor_fingerprint
      || provider.catalog_content_digest !== projectIdentity.catalog_content_digest
    ) {
      return contextFailure("IDENTITY_MISMATCH", "Pass the effective workflow policy bound to the admitted project identity.", {
        provider_id: projectIdentity.provider_id,
      });
    }
    if (workflowSelection.selection === "fixed") {
      const policyProfile = workflowSelection.profile_identity;
      if (
        !isDiagnosticEvidenceRecord(policyProfile)
        || typeof policyProfile.id !== "string"
        || policyProfile.id.length === 0
        || !isWorkflowV2Digest(policyProfile.fingerprint)
        || !catalog.profiles.some((candidateProfile) =>
          candidateProfile.identity.id === policyProfile.id
          && candidateProfile.identity.fingerprint === policyProfile.fingerprint
        )
      ) {
        return contextFailure("PROFILE_UNAVAILABLE", "The fixed effective-policy profile is not present in the admitted catalog.", {
          provider_id: projectIdentity.provider_id,
        });
      }
    } else if (Object.prototype.hasOwnProperty.call(workflowSelection, "profile_identity")) {
      return contextFailure("CONFIG_MALFORMED", "A matrix effective policy cannot carry a profile identity.", {
        provider_id: projectIdentity.provider_id,
      });
    }
  }
  return {
    project_identity: projectIdentity,
    catalog,
    ...(effective === undefined ? {} : { effective_policy: effective as Readonly<EffectivePolicy> }),
  };
}


function contextForSnapshotEntry(
  options: BuildSessionSnapshotsOptions,
  entry: SessionSourceEntry,
): BuildSessionSnapshotContext {
  const workflow: WorkflowName =
    entry.kind === "cto" ? "cto" : (entry.state?.classification?.workflow ?? "standard");
  const resolver = options.contextForEntry;
  if (resolver !== undefined) {
    if (typeof resolver !== "function") {
      return contextFailure(
        "MIGRATION_REQUIRED",
        "Pass a callable contextForEntry resolver that returns a validated context for every visualization entry.",
        { profile_id: workflow },
      );
    }
    let candidate: unknown;
    try {
      candidate = resolver(entry);
    } catch (error) {
      if (error instanceof VisualizationContextError) throw error;
      return contextFailure(
        "MIGRATION_REQUIRED",
        "The contextForEntry resolver failed; return a validated context for every visualization entry.",
        { profile_id: workflow },
      );
    }
    return requireSnapshotContext({ context: candidate }, workflow);
  }
  return requireSnapshotContext({ context: options.context }, workflow);
}


function profileForSnapshot(
  context: BuildSessionSnapshotContext,
  runIdentity: WorkflowRunIdentity,
  workflow: string,
): Profile {
  const profileIdentity = runIdentity.profile_identity;
  if (profileIdentity.id !== workflow) {
    return contextFailure("IDENTITY_MISMATCH", `Profile ${profileIdentity.id} does not define workflow ${workflow}.`, {
      provider_id: runIdentity.provider_id,
      profile_id: profileIdentity.id,
    });
  }
  const selection = context.effective_policy?.workflow;
  if (
    selection?.selection === "fixed"
    && (
      selection.profile_identity.id !== profileIdentity.id
      || selection.profile_identity.fingerprint !== profileIdentity.fingerprint
    )
  ) {
    return contextFailure("IDENTITY_MISMATCH", "Use the exact fixed profile identity selected by the admitted project policy.", {
      provider_id: runIdentity.provider_id,
      profile_id: profileIdentity.id,
    });
  }
  const loaded = loadProfileByIdentity(context.catalog, profileIdentity);
  if (!loaded.ok) throw new VisualizationContextError(loaded.diagnostics);
  if (loaded.value.name !== workflow) {
    return contextFailure("IDENTITY_MISMATCH", "Use the catalog profile whose declared workflow name matches the run identity.", {
      provider_id: runIdentity.provider_id,
      profile_id: profileIdentity.id,
    });
  }
  return loaded.value;
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

// ── Safe storage access ──────────────────────────────────────────────────────

const MAX_STATE_BYTES = 512 * 1024;

/**
 * Validate a declared artifact reference as a bounded path inside `.work-state`.
 * The storage authority performs the canonical root, symlink and traversal
 * checks; this layer only enforces the report input namespace and exclusions.
 */
function resolveDeclaredPath(
  storage: ReportStorageAuthority,
  ref: string,
): { relativePath: string; label: string } | { invalid: "unsafe-path" | "excluded-path" } {
  let relativePath: string;
  try {
    relativePath = storagePath(ref);
  } catch {
    return { invalid: "unsafe-path" };
  }
  if (relativePath !== WORK_STATE_DIR && !relativePath.startsWith(`${WORK_STATE_DIR}/`)) {
    return { invalid: "unsafe-path" };
  }
  if (isExcludedSourcePath(relativePath)) return { invalid: "excluded-path" };
  return { relativePath, label: relativePath };
}

/**
 * Read one bounded text window after metadata confirms a regular file.
 * Missing, malformed or inaccessible inputs are reported as null so a single
 * artifact cannot abort the complete snapshot.
 */
function readBoundedText(
  storage: ReportStorageAuthority,
  relativePath: string,
  maxBytes: number,
): string | null {
  try {
    const stat = statStorage(storage, relativePath);
    if (!stat.exists || stat.kind !== "file") return null;
    return decodeStorageText(readStorageBytes(storage, relativePath, maxBytes));
  } catch {
    return null;
  }
}

/** Total byte size of an existing authority-relative entry. */
function statSizeOf(storage: ReportStorageAuthority, relativePath: string): number | null {
  try {
    const stat = statStorage(storage, relativePath);
    return stat.exists ? stat.size_bytes : null;
  } catch {
    return null;
  }
}
/** The storage seam labels symlink rejection distinctly without exposing a path. */
function isSymlinkStorageFailure(error: unknown): boolean {
  return error instanceof ReportStorageError
    && error.reason === "UNSAFE_PATH"
    && error.message.toLowerCase().includes("symlink");
}

// ── State content (one bounded read, raw bytes) ──────────────────────────────

interface StateRead {
  /** Canonical state text exactly as read (digest input). */
  text: string;
  /** Safe relative label for the session source descriptor. */
  label: string;
  format: "json" | "markdown";
}

/** Deterministic canonical state text for a session entry (one bounded read). */
function readStateContent(storage: ReportStorageAuthority, entry: SessionSourceEntry): StateRead {
  if (entry.kind === "do-work") {
    if (entry.statePath) {
      const text = readBoundedText(storage, entry.statePath, MAX_STATE_BYTES);
      if (text !== null) return { text, label: entry.statePath, format: "json" };
    }
    return { text: "", label: entry.statePath ?? WORK_STATE_DIR, format: "json" };
  }
  // CTO: state.json first; markdown-state runs use the evidence/finish files.
  if (entry.statePath) {
    const text = readBoundedText(storage, entry.statePath, MAX_STATE_BYTES);
    if (text !== null) return { text, label: entry.statePath, format: "json" };
  }
  const candidates = entry.terminalMarkdown ? [...CTO_MD_FINISH_MARKERS] : [...CTO_MD_EVIDENCE];
  for (const name of candidates) {
    let path: string;
    try {
      path = storagePath(entry.runDir, name);
    } catch {
      continue;
    }
    const text = readBoundedText(storage, path, MAX_STATE_BYTES);
    if (text !== null) return { text, label: entry.runDir, format: "markdown" };
  }
  return { text: "", label: entry.runDir, format: "markdown" };
}

/** First `# ` heading of a markdown state text — the run task. */
function markdownTask(text: string): string {
  const line = text.split("\n").find((l) => l.startsWith("# "));
  return line ? line.replace(/^#\s+/, "").trim() : "";
}

/**
 * Task for a terminal markdown run: derived from the evidence files exactly
 * like markdownCtoState; the finish-marker state text is the digest source.
 */
function terminalMarkdownTask(storage: ReportStorageAuthority, runDir: string): string {
  for (const name of ["cto_discovery.md", "team-plan.md"]) {
    let path: string;
    try {
      path = storagePath(runDir, name);
    } catch {
      continue;
    }
    const text = readBoundedText(storage, path, MAX_STATE_BYTES);
    if (text === null) continue;
    const task = markdownTask(text);
    if (task !== "") return task;
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
  /** Authority-relative path (may not exist → missing/pending/skipped). */
  relativePath?: string;
  /** Safe relative source label (never absolute, never escaping). */
  label?: string;
}

/** Deterministic top-level scan of a directory for JSON artifact files. */
function scanJsonArtifacts(
  storage: ReportStorageAuthority,
  dir: string,
  onEntry: (id: string, relativePath: string) => void,
): void {
  let entries: readonly { name: string; relative_path: string }[];
  try {
    entries = listStorageEntries(storage, dir, MAX_STORAGE_ENTRIES);
  } catch {
    return;
  }
  const ordered = [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const entry of ordered) {
    const { name, relative_path: relativePath } = entry;
    if (EXCLUDED_SOURCE_NAMES[name]) continue;
    if (!name.endsWith(".json")) continue;
    if (isExcludedSourcePath(relativePath)) continue;
    try {
      const stat = statStorage(storage, relativePath);
      if (!stat.exists || stat.kind !== "file") continue;
    } catch {
      continue;
    }
    onEntry(name.slice(0, -".json".length), relativePath);
  }
}


/** Do-work artifact plan: state.artifacts (declared) + artifacts dir extras. */
function planDoWorkArtifacts(
  storage: ReportStorageAuthority,
  entry: Extract<SessionSourceEntry, { kind: "do-work" }>,
  state: TeamState,
  profile: Readonly<Profile>,
): { plans: ArtifactPlan[]; declaredOrder: string[] } {
  const declaredOrder: string[] = [];
  const declaredIds = new Set<string>();
  const producesByStage = new Map<string, string>();
  for (const stage of profile.stages) {
    const produced = Array.isArray(stage.produces) ? stage.produces : stage.produces ? [stage.produces] : [];
    for (const id of produced) {
      if (!declaredIds.has(id)) {
        declaredIds.add(id);
        declaredOrder.push(id);
      }
      producesByStage.set(id, stage.id);
    }
  }
  const declared = new Set(Object.keys(state.artifacts ?? {}));
  const plans = new Map<string, ArtifactPlan>();

  for (const [id, ref] of Object.entries(state.artifacts ?? {})) {
    const owner = producesByStage.get(id) ?? "";
    if (!isSafePathKey(id)) {
      plans.set(id, { id, declared: true, owner, invalid: "unsafe-id" });
      continue;
    }
    const resolved = resolveDeclaredPath(storage, ref);
    if ("invalid" in resolved) {
      plans.set(id, { id, declared: true, owner, invalid: resolved.invalid });
      continue;
    }
    plans.set(id, { id, declared: true, owner, relativePath: resolved.relativePath, label: resolved.label });
  }

  // Discovered extras: slot files attach to their declared base, anything
  // else stays unclaimed. Excluded inputs are never discovered.
  scanJsonArtifacts(storage, entry.artifactsDir, (id, relativePath) => {
    if (declared.has(id)) return;
    const base = slotBaseOf(id, declared);
    const owner = base ? (producesByStage.get(base) ?? "") : "";
    plans.set(id, {
      id,
      declared: false,
      owner,
      ...(base ? { slotFor: base } : {}),
      relativePath,
      label: relativePath,
    });
  });

  return { plans: [...plans.values()], declaredOrder };
}

/** CTO artifact plan: run-local + team compatibility + validated dod_path. */
function planCtoArtifacts(
  storage: ReportStorageAuthority,
  entry: Extract<SessionSourceEntry, { kind: "cto" }>,
  state: CtoState,
  warnings: string[],
  profile: Readonly<Profile>,
): { plans: ArtifactPlan[]; declaredOrder: string[] } {
  const declaredOrder: string[] = [];
  const declaredIds = new Set<string>();
  for (const stage of profile.stages) {
    const produced = Array.isArray(stage.produces) ? stage.produces : stage.produces ? [stage.produces] : [];
    for (const id of produced) {
      if (declaredIds.has(id)) continue;
      declaredIds.add(id);
      declaredOrder.push(id);
    }
  }
  const plans: Map<string, ArtifactPlan> = new Map();
  const add = (id: string, owner: string, relativePath: string, label: string): void => {
    if (plans.has(id)) {
      warnings.push(`artifact ${id} exists in multiple locations: first resolution wins`);
      return;
    }
    plans.set(id, { id, declared: true, owner, relativePath, label });
  };

  // 1. Run-local artifacts: .work-state/cto/<runId>/artifacts/*.json.
  const runArtifacts = storagePath(entry.runDir, "artifacts");
  scanJsonArtifacts(storage, runArtifacts, (id, relativePath) => {
    add(id, "", relativePath, relativePath);
  });

  // 2. Team compatibility dirs: .work-state/artifacts/<teamId>/*.json.
  for (const team of state.teams ?? []) {
    let teamDir: string;
    try {
      teamDir = ctoTeamArtifactsDir(team.id);
    } catch {
      warnings.push(`unsafe team id ${team.id}: excluded from rendering`);
      continue;
    }
    scanJsonArtifacts(storage, teamDir, (id, relativePath) => {
      add(id, team.id, relativePath, relativePath);
    });
  }

  // 3. Validated dod_path per team (id "dod"; first resolution wins).
  for (const team of state.teams ?? []) {
    if (!team.dod_path) continue;
    const resolved = resolveDeclaredPath(storage, team.dod_path);
    if ("invalid" in resolved) {
      warnings.push(`declared path for dod is not a safe relative path: excluded from rendering`);
      continue;
    }
    add("dod", team.id, resolved.relativePath, resolved.label);
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
  storage: ReportStorageAuthority;
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
  const { storage, renderConfig, stageStatuses, warnings, contributions } = ctx;
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
      const size = plan.relativePath ? statSizeOf(storage, plan.relativePath) : null;
      contributions.set(id, {
        id,
        present: size !== null,
        sizeBytes: size ?? 0,
        readBytes: size === null ? 0 : Math.min(size, windowBytes),
      });
      artifacts.push({ id, owner: plan.owner, status: "skipped", ...slotOf(id) });
      continue;
    }
    if (plan.invalid === "unsafe-path" || plan.invalid === "excluded-path") {
      warnings.push(`declared path for ${id} is not a safe relative path: excluded from rendering`);
      contributions.set(id, { id, present: false, sizeBytes: 0, readBytes: 0 });
      artifacts.push({ id, owner: plan.owner, status: "missing", ...slotOf(id) });
      continue;
    }

    const relativePath = plan.relativePath;
    if (!relativePath) {
      contributions.set(id, { id, present: false, sizeBytes: 0, readBytes: 0 });
      artifacts.push({ id, owner: plan.owner, status: "missing", ...slotOf(id) });
      continue;
    }

    let stat: StorageStat | null = null;
    try {
      stat = statStorage(storage, relativePath);
    } catch (error) {
      if (error instanceof ReportStorageError && error.reason === "UNSAFE_PATH") {
        warnings.push(
          isSymlinkStorageFailure(error)
            ? `artifact ${id} escapes the workspace via symlink: skipped`
            : `artifact ${id} escapes the workspace via an unsafe storage path: skipped`,
        );
        contributions.set(id, { id, present: true, sizeBytes: 0, readBytes: 0 });
        artifacts.push({ id, owner: plan.owner, status: "skipped", ...slotOf(id) });
        continue;
      }
    }
    const size = stat?.exists ? stat.size_bytes : null;
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

    let text: string | null;
    try {
      text = decodeStorageText(readStorageBytes(storage, relativePath, windowBytes));
    } catch (error) {
      if (error instanceof ReportStorageError && error.reason === "UNSAFE_PATH") {
        warnings.push(
          isSymlinkStorageFailure(error)
            ? `artifact ${id} escapes the workspace via symlink: skipped`
            : `artifact ${id} escapes the workspace via an unsafe storage path: skipped`,
        );
        contributions.set(id, { id, present: true, sizeBytes: size, readBytes: 0 });
        artifacts.push({ id, owner: plan.owner, status: "skipped", ...slotOf(id) });
        continue;
      }
      text = null;
    }
    if (text === null) {
      // Read failure (IO) — unreadable within the window.
      warnings.push(`artifact ${id} is unreadable: read error`);
      contributions.set(id, { id, present: true, sizeBytes: size, readBytes: 0 });
      artifacts.push({ id, owner: plan.owner, status: "unreadable", errorCategory: "read-error", ...slotOf(id) });
      continue;
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
function sameProjectIdentity(left: ProjectIdentity, right: ProjectIdentity): boolean {
  return (
    left.root_instance_id === right.root_instance_id
    && left.provider_id === right.provider_id
    && left.descriptor_fingerprint === right.descriptor_fingerprint
    && left.executable_provenance.build_fingerprint === right.executable_provenance.build_fingerprint
    && left.executable_provenance.runtime_fingerprint === right.executable_provenance.runtime_fingerprint
    && left.catalog_content_digest === right.catalog_content_digest
    && left.config_byte_sha256 === right.config_byte_sha256
    && left.config_semantic_sha256 === right.config_semantic_sha256
    && left.session.session_id === right.session.session_id
    && left.session.lifecycle_id === right.session.lifecycle_id
  );
}
function sameWorkflowRunIdentity(left: WorkflowRunIdentity, right: WorkflowRunIdentity): boolean {
  return (
    left.run_id === right.run_id
    && left.profile_identity.id === right.profile_identity.id
    && left.profile_identity.fingerprint === right.profile_identity.fingerprint
    && sameProjectIdentity(left, right)
  );
}


function runIdentityForSnapshot(
  context: BuildSessionSnapshotContext,
  entry: SessionSourceEntry,
): WorkflowRunIdentity {
  const candidate = isDiagnosticEvidenceRecord(entry.state) ? entry.state.run_identity : undefined;
  const result = validateWorkflowRunIdentity(candidate);
  if (!result.ok) throw new VisualizationContextError(result.diagnostics);
  const runIdentity = result.value;
  if (!sameProjectIdentity(runIdentity, context.project_identity)) {
    return contextFailure("IDENTITY_MISMATCH", "The persisted run identity does not match the admitted project identity.", {
      provider_id: context.project_identity.provider_id,
      run_id: runIdentity.run_id,
    });
  }
  if (entry.kind === "do-work") {
    const state = entry.state;
    if (!isDiagnosticEvidenceRecord(state)) {
      return contextFailure("MIGRATION_REQUIRED", "The workflow state must carry a durable run identity.", {
        provider_id: runIdentity.provider_id,
        run_id: runIdentity.run_id,
      });
    }
    const stateProject = validateProjectIdentity(state.project_identity);
    if (!stateProject.ok) throw new VisualizationContextError(stateProject.diagnostics);
    if (!sameProjectIdentity(stateProject.value, context.project_identity)) {
      return contextFailure("IDENTITY_MISMATCH", "The persisted workflow project identity does not match the admitted project identity.", {
        provider_id: context.project_identity.provider_id,
        run_id: runIdentity.run_id,
      });
    }
  } else {
    const state = entry.state;
    if (!isDiagnosticEvidenceRecord(state) || !isDiagnosticEvidenceRecord(state.plan) || !Array.isArray(state.teams)) {
      return contextFailure("MIGRATION_REQUIRED", "The CTO state must carry run identities for its plan and teams.", {
        provider_id: runIdentity.provider_id,
        run_id: runIdentity.run_id,
      });
    }
    const nested = [
      state.plan.run_identity,
      ...state.teams.map((team) => (isDiagnosticEvidenceRecord(team) ? team.run_identity : undefined)),
    ];
    for (const candidateIdentity of nested) {
      const nestedResult = validateWorkflowRunIdentity(candidateIdentity);
      if (!nestedResult.ok) throw new VisualizationContextError(nestedResult.diagnostics);
      if (!sameWorkflowRunIdentity(nestedResult.value, runIdentity)) {
        return contextFailure("IDENTITY_MISMATCH", "Every persisted CTO record must carry the exact run identity.", {
          provider_id: runIdentity.provider_id,
          run_id: runIdentity.run_id,
        });
      }
    }
    if (runIdentity.run_id !== entry.id) {
      return contextFailure("IDENTITY_MISMATCH", "The persisted CTO run identity does not match the selected run id.", {
        provider_id: runIdentity.provider_id,
        run_id: runIdentity.run_id,
        selected_run_id: entry.id,
      });
    }
  }
  return runIdentity;
}

/**
 * Build the immutable normalized session model for one discovered session
 * entry. Never mutates canonical state; never throws for corrupt peers.
 */
export function buildSessionSnapshot(
  storage: ReportStorageAuthority,
  entry: SessionSourceEntry,
  generatedAt: string,
  opts: BuildSessionSnapshotOptions,
): VisualizationSession {
  const authority = requireReportStorage(storage);
  const identityBase = identityBaseOf(entry);
  const warnings: string[] = [];
  const contributions = new Map<string, DigestArtifactContribution>();
  const workflow: WorkflowName =
    entry.kind === "cto" ? "cto" : (entry.state?.classification?.workflow ?? "standard");
  const snapshotContext = requireSnapshotContext(opts, workflow);
  const stateRead = readStateContent(authority, entry);
  const renderConfig = opts.renderConfig ?? resolveRenderConfig(workflow, opts.full ?? false);
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
              ? terminalMarkdownTask(authority, entry.runDir)
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
    const runIdentity = runIdentityForSnapshot(snapshotContext, entry);
    const profile = profileForSnapshot(snapshotContext, runIdentity, workflow);


    // ── Readable state: normal model construction. ─────────────────────────
    const stageStatuses = new Map<string, string>();
    let stagesModel: StageProgressEntry[] = [];
    let artifacts: VisualizationArtifact[] = [];
    let declaredOrder: readonly string[] = [];
    let task = "";
    let sourceUpdatedAt: string | undefined;
    const profileHash = runIdentity.profile_identity.fingerprint;

    if (entry.kind === "do-work") {
      const state = entry.state as TeamState;
      task = state.task;
      for (const s of state.stages ?? []) stageStatuses.set(s.id, s.status);
      const planned = planDoWorkArtifacts(authority, entry, state, profile);
      declaredOrder = planned.declaredOrder;
      artifacts = buildArtifactModel(planned.plans, declaredOrder, {
        storage: authority,
        renderConfig,
        stageStatuses,
        warnings,
        contributions,
      });
      stagesModel = buildStages(state, artifacts, declaredOrder);
      if (stateRead.format === "json") sourceUpdatedAt = state.updated_at;
      if (state.profile_hash && state.profile_hash !== profileHash) {
        return contextFailure("IDENTITY_MISMATCH", "The persisted workflow profile hash does not match the run profile identity.", {
          provider_id: runIdentity.provider_id,
          run_id: runIdentity.run_id,
          expected_digest: profileHash,
          actual_digest: state.profile_hash,
        });
      }
      if (artifacts.length === 0) warnings.push("no artifacts yet");
    } else {
      const state = entry.state as CtoState;
      const planned = planCtoArtifacts(authority, entry, state, warnings, profile);
      declaredOrder = planned.declaredOrder;
      artifacts = buildArtifactModel(planned.plans, declaredOrder, {
        storage: authority,
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
  storage: ReportStorageAuthority,
  entries: SessionSourceEntry[],
  generatedAt: string,
  opts: BuildSessionSnapshotsOptions,
): VisualizationSession[] {
  const authority = requireReportStorage(storage);
  if (opts === null || typeof opts !== "object" || Array.isArray(opts)) {
    return contextFailure("MIGRATION_REQUIRED", "Pass visualization options with an admitted context or contextForEntry resolver.");
  }
  if (opts.context === undefined && opts.contextForEntry === undefined) {
    return contextFailure("MIGRATION_REQUIRED", "Pass an admitted context or contextForEntry resolver to visualization.");
  }
  const sorted: SessionSourceEntry[] = [...entries].sort((a, b) =>
    compareSessions(
      { updatedAt: contentUpdatedAtOf(a), kind: sessionKindOf(a), id: a.id },
      { updatedAt: contentUpdatedAtOf(b), kind: sessionKindOf(b), id: b.id },
    ),
  );
  const snapshotOptions: Omit<BuildSessionSnapshotOptions, "context"> = {
    ...(opts.full === undefined ? {} : { full: opts.full }),
    ...(opts.renderConfig === undefined ? {} : { renderConfig: opts.renderConfig }),
  };
  const resolved: Array<{ entry: SessionSourceEntry; context: BuildSessionSnapshotContext }> = sorted.map((entry) => ({
    entry,
    context: contextForSnapshotEntry(opts, entry),
  }));
  return resolved.map(({ entry, context }) =>
    buildSessionSnapshot(authority, entry, generatedAt, { ...snapshotOptions, context }),
  );
}
