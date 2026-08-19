/**
 * Visualize OPT-A — normalized-model contracts (architecture-1).
 *
 * One immutable, renderer-ready snapshot of a workflow session is built from
 * canonical workflow state plus discovered artifact files. This module freezes
 * the dependency-free contracts: vocabulary, normalized session/artifact
 * shapes, source descriptors, statuses, provenance, safe path keys, link
 * targets, render config, manifest/output metadata, and bounded redacted
 * snapshot fields.
 *
 * SLICE-0/BG-1 (contract freeze pin, applied BEFORE architecture-1 fixtures):
 * the source digest hashes canonical state content plus per-artifact
 * {id, byte size, bounded read-window bytes}. File mtimes are NEVER part of
 * the digest, the normalized model, or any rendered field (Markdown, HTML,
 * manifest, status output). Identical content in workspaces with different
 * mtimes therefore produces byte-identical output for a fixed clock; a
 * touch-only change can never invalidate a digest.
 *
 * Determinism: for identical inputs and a fixed `generatedAt`, every field is
 * byte-identical except the explicitly volatile fields enumerated in
 * {@link VOLATILE_FIELDS}. Ordering is a declared total order (never
 * filesystem enumeration order).
 *
 * Boundaries (architecture-1):
 * - types + contract constants + pure predicates only. No fs, crypto, model
 *   or network access; the sha256 primitive itself lands in architecture-3
 *   (snapshot.ts) over {@link serializeDigestInput}.
 * - No imports from report/cto/engine modules; the vocabulary is pinned here
 *   so later slices cannot drift (notably this model is deliberately
 *   mtime-free, unlike ReportArtifact).
 * - events.jsonl, vibe-report and prior generated output under
 *   .work-state/visualize are excluded inputs and are never discovered.
 */

// ── Vocabulary ───────────────────────────────────────────────────────────────

/** Canonical session layouts: per-feature, legacy root, and CTO runs. */
export type SessionKind = "feature" | "legacy" | "cto";

/** How the canonical session state is stored on disk. */
export type SourceFormat = "json" | "markdown";

/**
 * Per-artifact status vocabulary (pinned by the outcome contract).
 * `skipped` means an artifact produced by a persisted skipped stage;
 * `unreadable` covers corrupt JSON and read failures within the read window.
 */
export type ArtifactStatus = "produced" | "missing" | "pending" | "skipped" | "unreadable";

/**
 * Session-level status. `complete` = rendered from full parity content;
 * `degraded` = rendered from available content only with a visible badge
 * (markdown-state CTO fallback, absent/mixed state models).
 */
export type SessionStatus = "complete" | "degraded";

/**
 * Full status vocabulary used by the reader journey:
 * produced/missing/pending/skipped/unreadable/degraded.
 */
export type VisualizationStatus = ArtifactStatus | SessionStatus;

/** Why an artifact is `unreadable` or carries a preview warning. */
export type ErrorCategory =
  /** Parsing failed while the whole file fits the read window → unreadable. */
  | "invalid-json"
  /** The file could not be read at all (IO error). */
  | "read-error"
  /** File exceeds the read window and its head is not complete JSON → produced with preview. */
  | "oversized-unparsed"
  /** State/artifact exists but its format is not a recognized source format. */
  | "unsupported-format";

/** Provenance freshness per the total stale rule (AC-11). */
export type Staleness = "fresh" | "stale" | "unknown";

/** Workflow classification name; unlisted values keep the safe explicit default. */
export type WorkflowName = "spec-preparation" | "bug-fix" | (string & {});

/** Workflow detail policy (MD-4): spec-preparation detailed, bug-fix compact, safe default. */
export type DepthPolicy = "detailed" | "compact" | "default";

/** Bundle scope: selected/latest is visibly partial; `all` is completeness mode. */
export type VisualizationScope = "selected" | "all";

/** Artifact renderer precedence layers (implementation_contract.rendering). */
export type RendererLayer = "workflow-depth" | "exact" | "spec-family" | "typed-schema" | "generic-fallback";

/** Link graph reachability of a generated target (link_contract). */
export type LinkTargetState = "resolved" | "unavailable" | "degraded";

/** Semantic sections reachable from an overview (reader_journey). */
export type SectionId =
  | "overview"
  | "requirements"
  | "decisions"
  | "architecture"
  | "tasks"
  | "artifacts"
  | "status-details";

/** Which links are emitted. */
export type LinkKind = "session" | "artifact" | "stage" | "section" | "status-detail";

// ── Safe path keys ───────────────────────────────────────────────────────────

/**
 * Safe relative identifier used in output paths and links. Contract:
 * - 1–128 chars, ASCII alphanumeric start, then `[A-Za-z0-9._-]` only;
 * - never empty, never `.`/`..`, never a leading dot, never `/`, `\`, space,
 *   `#`, `?`, `%`, control chars — so it can never escape its directory or
 *   break Markdown/HTML/URL structure;
 * - derived from stable session/artifact identity, never from raw user text.
 */
export type PathKey = string;

export const SAFE_PATH_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function isSafePathKey(value: string): value is PathKey {
  return SAFE_PATH_KEY_RE.test(value) && value !== "." && value !== "..";
}

/** Legacy root session identity constants (legacy_collision contract). */
export const LEGACY_SESSION_ID = "legacy" as const;
export const LEGACY_ROOT_PATH_KEY = "legacy-root" as const;

/**
 * Legacy collision rule: the logical legacy session keeps kind `legacy`,
 * id `legacy` and output path key `legacy-root`; a feature slug literally
 * named `legacy` keeps kind `feature`, id `legacy` and path key `legacy`.
 * Kind/id metadata disambiguates all sessions; CTO uses its own kind
 * namespace, so path keys never collide across kinds.
 */

/** Stable fragment anchors — derived from validated identity, never raw ids. */
export function fragmentForSession(pathKey: PathKey): string {
  return `viz-${pathKey}`;
}

export function fragmentForArtifact(pathKey: PathKey, artifactId: string): string {
  // encodeURIComponent is deterministic in Node and keeps the fragment free of
  // Markdown/HTML/URL-breaking characters while staying collision-free.
  return `viz-${pathKey}-${encodeURIComponent(artifactId)}`;
}

// ── Deterministic ordering (implementation_contract.ordering) ────────────────

/**
 * Total session order: `updated_at` descending, then kind ascending, then id
 * ascending. Sessions without an `updated_at` sort last. Never filesystem
 * enumeration order.
 */
export function compareSessions(
  a: { updatedAt?: string; kind: SessionKind; id: string },
  b: { updatedAt?: string; kind: SessionKind; id: string },
): number {
  const ua = a.updatedAt ?? "";
  const ub = b.updatedAt ?? "";
  if (ua !== ub) return ua < ub ? 1 : -1;
  if (a.kind !== b.kind) return a.kind < b.kind ? -1 : 1;
  if (a.id !== b.id) return a.id < b.id ? -1 : 1;
  return 0;
}

/**
 * If `id` is a consilium slot of a declared base (`<base>-<role>`), return the
 * base id. Consilium slot files have the suffix `-<role>`; anything else is
 * not a slot. The longest matching declared base wins so multi-dash roles
 * (e.g. `tech-researcher`) cannot shadow a shorter base.
 */
export function slotBaseOf(id: string, declared: ReadonlySet<string>): string | undefined {
  let best: string | undefined;
  for (const base of declared) {
    if (
      id.length > base.length &&
      id.startsWith(`${base}-`) &&
      (best === undefined || base.length > best.length)
    ) {
      best = base;
    }
  }
  return best;
}

/**
 * Total artifact order: declared ids by workflow produces order, consilium
 * slot files immediately after their base (role-lexicographic), then all
 * undeclared extras lexicographically by id. Never filesystem order.
 */
export function compareArtifactIds(a: string, b: string, declaredOrder: readonly string[]): number {
  const declared = new Set(declaredOrder);
  const rank = (id: string): [number, number] => {
    const base = slotBaseOf(id, declared) ?? id;
    const idx = declaredOrder.indexOf(base);
    if (idx < 0) return [Number.POSITIVE_INFINITY, 0];
    return [idx, id === base ? 0 : 1];
  };
  const ra = rank(a);
  const rb = rank(b);
  if (ra[0] !== rb[0]) return ra[0] - rb[0];
  if (ra[1] !== rb[1]) return ra[1] - rb[1];
  return a < b ? -1 : a > b ? 1 : 0;
}

// ── Renderer registry contract (implementation_contract.rendering) ───────────

/** The 22 typed artifact definitions from workflows/artifacts-schema.json. */
export const TYPED_ARTIFACT_IDS: readonly string[] = [
  "discovery",
  "exploration",
  "clarifications",
  "architecture",
  "diagnosis",
  "implementation",
  "debug",
  "review",
  "summary",
  "manual_qa",
  "qa_tests",
  "feature_spec",
  "dod",
  "cto_discovery",
  "team_plan",
  "team_artifacts",
  "integration_review",
  "lecture_intake",
  "lecture_mapping",
  "lecture_candidates",
  "lecture_repo_fit",
  "lecture_decision",
] as const;

/** The 7 known freeform spec-family ids produced by spec-preparation. */
export const SPEC_FAMILY_IDS: readonly string[] = [
  "spec_intake_repo_map",
  "spec_requirements_edge_cases",
  "spec_options_decisions",
  "spec_architecture_tasks",
  "spec_completeness",
  "spec-preparation",
  "spec_handoff",
] as const;

export function isTypedArtifactId(id: string): boolean {
  return (TYPED_ARTIFACT_IDS as readonly string[]).includes(id);
}

/** Known spec ids plus any other `spec_*`/`spec-*` id (spec-family override). */
export function isSpecFamilyId(id: string): boolean {
  return (SPEC_FAMILY_IDS as readonly string[]).includes(id) || id.startsWith("spec_") || id.startsWith("spec-");
}

/** Freeform regression artifacts — always generic fallback. */
export function isRegressionId(id: string): boolean {
  return id.startsWith("regression_");
}

/**
 * Artifact renderer precedence: workflow depth policy → exact high-value
 * renderer (reserved; none registered in v1) → spec-family → 22 typed schema
 * → bounded generic fallback. `regression_*`, unknown and freeform ids are
 * generic; renderer failures also fall back to generic and increment a
 * warning. No schema additions are allowed.
 */
export function resolveRendererLayer(artifactId: string): Exclude<RendererLayer, "workflow-depth" | "exact"> {
  if (isSpecFamilyId(artifactId)) return "spec-family";
  if (isTypedArtifactId(artifactId)) return "typed-schema";
  return "generic-fallback";
}

// ── Workflow depth policy (MD-4) ─────────────────────────────────────────────

/** Workflows receiving the detailed treatment (bodies enabled by default). */
export const DETAILED_WORKFLOWS: readonly string[] = ["spec-preparation"] as const;

/** Workflows receiving the compact treatment (bodies disabled by default). */
export const COMPACT_WORKFLOWS: readonly string[] = ["bug-fix"] as const;

/** Resolve the depth policy: detailed, compact, or the explicit safe default. */
export function depthPolicyFor(workflow: WorkflowName): DepthPolicy {
  if (workflow === "spec-preparation") return "detailed";
  if (workflow === "bug-fix") return "compact";
  return "default";
}

/** Behavior of a depth policy. `bodiesByDefault` is independent of --full. */
export function depthPolicyBehavior(policy: DepthPolicy): { bodiesByDefault: boolean } {
  return { bodiesByDefault: policy === "detailed" };
}

// ── Render config and bounds ─────────────────────────────────────────────────

/** Default body cap (existing report cap reused): 16 KiB. */
export const DEFAULT_BODY_CAP_BYTES = 16 * 1024;

/** Hard maximum body cap for --full: 256 KiB. Redaction still applies. */
export const FULL_BODY_CAP_BYTES = 256 * 1024;

/** Bounded head read window per artifact: 16 KiB by default. */
export const DEFAULT_READ_WINDOW_BYTES = 16 * 1024;

/** Bounded head read window under --full: 256 KiB. */
export const FULL_READ_WINDOW_BYTES = 256 * 1024;

/** Parsed-JSON depth bound. */
export const MAX_DEPTH = 8;

/** Collection item bound per parsed object/array. */
export const MAX_COLLECTION_ITEMS = 200;

/** Scalar display bound. */
export const MAX_SCALAR_CHARS = 8192;

export interface RenderBounds {
  maxDepth: number;
  maxCollectionItems: number;
  maxScalarChars: number;
}

export const DEFAULT_RENDER_BOUNDS: RenderBounds = {
  maxDepth: MAX_DEPTH,
  maxCollectionItems: MAX_COLLECTION_ITEMS,
  maxScalarChars: MAX_SCALAR_CHARS,
};

export interface RenderOptions {
  /** --full: inclusion changes (bigger window/cap) but redaction never weakens. */
  full: boolean;
  bodyCapBytes: number;
  readWindowBytes: number;
  bounds: RenderBounds;
}

export function defaultRenderOptions(full = false): RenderOptions {
  return full
    ? {
        full: true,
        bodyCapBytes: FULL_BODY_CAP_BYTES,
        readWindowBytes: FULL_READ_WINDOW_BYTES,
        bounds: DEFAULT_RENDER_BOUNDS,
      }
    : {
        full: false,
        bodyCapBytes: DEFAULT_BODY_CAP_BYTES,
        readWindowBytes: DEFAULT_READ_WINDOW_BYTES,
        bounds: DEFAULT_RENDER_BOUNDS,
      };
}

// ── Bounded redacted snapshot fields ─────────────────────────────────────────

export const TRUNCATION_MARKER_PREFIX = "…[truncated ";
export const TRUNCATION_MARKER_SUFFIX = " bytes]";
export const EMPTY_BODY_MARKER = "[empty]";
export const REDACTED_MARKER = "[redacted]";

/** Visible truncation/preview marker carrying original size and applied cap. */
export function formatTruncationMarker(originalBytes: number, capBytes: number): string {
  return `${TRUNCATION_MARKER_PREFIX}${originalBytes}/${capBytes}${TRUNCATION_MARKER_SUFFIX}`;
}

/**
 * Redacted, capped, embedded body. Redaction applies before the cap at every
 * verbosity level; `preview: true` means the source exceeded the read window
 * and only a bounded head was ever read/embedded. `text` is never empty —
 * empty content becomes {@link EMPTY_BODY_MARKER}, fully redacted content
 * becomes {@link REDACTED_MARKER}.
 */
export interface RedactedBody {
  text: string;
  truncated: boolean;
  /** Source byte size before redaction/cap (content-derived). */
  originalBytes: number;
  /** Applied cap (bodyCapBytes). */
  capBytes: number;
  /** True → head preview: no bytes beyond the bounded read window were embedded. */
  preview: boolean;
  /** Visible marker when truncated/preview. */
  marker: string;
}

/** Explicit omission markers for depth/collection/scalar bounds. */
export interface BoundsOmission {
  maxDepth: number;
  maxCollectionItems: number;
  maxScalarChars: number;
  depthTruncated: boolean;
  omittedCollections: number;
  omittedScalars: number;
  marker: string;
}

export function formatBoundsMarker(
  depthTruncated: boolean,
  omittedCollections: number,
  omittedScalars: number,
): string {
  const parts = [`…[bounded: depth ${MAX_DEPTH}`];
  if (depthTruncated) parts.push("truncated");
  if (omittedCollections > 0) parts.push(`+${omittedCollections} collections`);
  if (omittedScalars > 0) parts.push(`+${omittedScalars} scalars`);
  return `${parts.join(" ")}]`;
}

// ── Source descriptors and SLICE-0/BG-1 digest ───────────────────────────────

/**
 * Safe relative descriptor of a canonical input file. `label` and `relPath`
 * are never absolute and never contain path-escape segments; the raw absolute
 * path from state.json is never rendered. `bytes`/`readBytes` are
 * content-derived (stat may be read internally for diagnostics, but neither
 * mtime, mode, inode, nor any other filesystem metadata is ever rendered).
 */
export interface SourceDescriptor {
  kind: "state" | "artifact";
  /** Safe relative label, e.g. `.work-state/features/<slug>/state.json`. */
  label: string;
  /** Total byte size (content-derived). */
  bytes: number;
  /** Bytes actually read from the bounded head window (≤ readWindowBytes). */
  readBytes: number;
  /** Bounded read window applied. */
  readWindowBytes: number;
  format: SourceFormat;
}

/**
 * One artifact's deterministic digest contribution (SLICE-0/BG-1).
 *
 * `present` is pinned so creating/removing a zero-byte file still invalidates
 * the digest. `sizeBytes` is the total byte size; `readBytes` is the number
 * of bytes actually read from the bounded head window. Neither the path, the
 * mtime, nor the inode participates.
 */
export interface DigestArtifactContribution {
  id: string;
  present: boolean;
  sizeBytes: number;
  readBytes: number;
}

/**
 * All inputs of the source digest for one session (SLICE-0/BG-1):
 * hash(canonical state content + per-artifact {id, size in bytes, bounded
 * read-window bytes}). Declared-but-absent artifacts contribute
 * `present: false` with zero bytes so absence is distinguished from an empty
 * file. mtime is excluded by construction.
 */
export interface SourceDigestInput {
  /** Canonical state text exactly as read (JSON file text or markdown state). */
  stateContent: string;
  /** Deterministic artifact contributions, sorted by id ascending. */
  artifacts: DigestArtifactContribution[];
}

const DIGEST_RECORD_SEP = "\u0000";
const DIGEST_UNIT_SEP = "\u0001";

/** Canonical byte serialization of the digest input (BG-1). */
export function serializeDigestInput(input: SourceDigestInput): string {
  const records = [`state${DIGEST_RECORD_SEP}${input.stateContent}`];
  for (const a of input.artifacts) {
    records.push(
      [
        "artifact",
        a.id,
        a.present ? 1 : 0,
        a.sizeBytes,
        a.readBytes,
      ]
        .join(DIGEST_RECORD_SEP),
    );
  }
  return records.join(DIGEST_UNIT_SEP);
}

/** sha256 digest of the canonical serialization (BG-1). */
export interface SourceDigest {
  algorithm: "sha256";
  /** Full 64 lowercase hex chars (verification only, never rendered). */
  full: string;
  /** First 16 hex chars — the ONLY digest form allowed in rendered fields. */
  bounded: string;
  /** Byte length of the canonical serialization (content-derived). */
  inputBytes: number;
}

export const BOUNDED_DIGEST_LENGTH = 16;

// ── Provenance (AC-11) ───────────────────────────────────────────────────────

export interface RendererIdentity {
  name: string;
  version: string;
}

export const DEFAULT_RENDERER_IDENTITY: RendererIdentity = {
  name: "omp-workflows-visualize",
  version: "1.0.0",
};

/**
 * Reader-visible provenance: session identity, source updated_at, a bounded
 * source digest, generated_at, and renderer identity/version. The stale rule
 * is total: state.updated_at later than generated_at → stale; equal
 * timestamps → fresh; absent/unparseable → unknown. mtime never appears.
 */
export interface VisualizationProvenance {
  /** Source state updated_at (content-derived). Absent for markdown state. */
  sourceUpdatedAt?: string;
  /** profile_hash when available. */
  profileHash?: string;
  sourceDigest: SourceDigest;
  /** ISO timestamp — the only volatile provenance field. */
  generatedAt: string;
  renderer: RendererIdentity;
  staleness: Staleness;
}

export function stalenessOf(updatedAt: string | undefined, generatedAt: string): Staleness {
  if (!updatedAt) return "unknown";
  const u = Date.parse(updatedAt);
  const g = Date.parse(generatedAt);
  if (!Number.isFinite(u) || !Number.isFinite(g)) return "unknown";
  return u > g ? "stale" : "fresh";
}

// ── Normalized model (implementation_contract.model) ─────────────────────────

/** One stage of the session with its declared artifact ids in produces order. */
export interface StageProgressEntry {
  stageId: string;
  title?: string;
  status: "pending" | "in_progress" | "done" | "skipped" | "failed";
  phase?: string;
  /** Ids this stage produces/owns, in workflow produces order. */
  artifactIds: string[];
}

/**
 * Stable session identity. kind/id/pathKey disambiguate all sessions (legacy
 * collision, feature-vs-cto namespaces); `degraded` mirrors
 * {@link VisualizationSession.status} for overview rendering.
 */
export interface SessionIdentity {
  kind: SessionKind;
  /** Feature slug, `legacy`, or CTO run id. */
  id: string;
  /** Safe output path key — validated stable identity, never raw text. */
  pathKey: PathKey;
  title: string;
  task: string;
  workflow: WorkflowName;
  sourceFormat: SourceFormat;
  isLegacy: boolean;
  degraded: boolean;
}

/**
 * One normalized artifact. `status` vocabulary is pinned to
 * produced/missing/pending/skipped/unreadable; `source` is absent for
 * missing/pending/unsafe entries. mtime is never a rendered field.
 */
export interface VisualizationArtifact {
  id: string;
  /** Stage/team that declared or owns this artifact. */
  owner: string;
  /** Base artifact id when this is a consilium slot file (`<base>-<role>`). */
  slotFor?: string;
  status: ArtifactStatus;
  /** Safe relative source descriptor; absent when missing/pending/unsafe. */
  source?: SourceDescriptor;
  /** Total byte size of the source file (content-derived). */
  bytes?: number;
  /** Schema type name when the artifact matched a typed definition. */
  type?: string;
  /** Bounded summary; present even for missing/pending when derivable. */
  summary?: string;
  /** Top-level keys when the artifact parsed as a JSON object. */
  keys?: string[];
  /** Redacted, capped embedded body — only when the policy enables bodies. */
  body?: RedactedBody;
  /** Explicit depth/collection/scalar omission markers. */
  bounds?: BoundsOmission;
  /** Why the artifact is unreadable or carries a preview warning. */
  errorCategory?: ErrorCategory;
}

export interface VisualizationSession {
  schema: 1;
  identity: SessionIdentity;
  status: SessionStatus;
  /** Ordered stage progress. */
  stages: StageProgressEntry[];
  /** Deterministic artifact order (declared produces order → extras lexicographic). */
  artifacts: VisualizationArtifact[];
  source: SourceDescriptor;
  provenance: VisualizationProvenance;
  warnings: string[];
  /** Why the session is degraded (markdown fallback, absent/mixed state). */
  degradedReasons?: string[];
}

// ── Link graph (link_contract) ───────────────────────────────────────────────

/** A stable identity-based link target. Anchors come from identity, not raw ids. */
export interface LinkTarget {
  sessionPathKey: PathKey;
  /** Stable artifact/stage id when the link targets one. */
  targetId?: string;
  /** Semantic section when the link targets a section. */
  section?: SectionId;
  /** Validated fragment anchor derived from stable identity. */
  anchor?: string;
}

export interface VisualizationLink {
  id: string;
  kind: LinkKind;
  from: LinkTarget;
  to: LinkTarget;
  label: string;
  /** resolved | unavailable (missing/unreadable) | degraded. */
  state: LinkTargetState;
}

export interface LinkGraph {
  links: VisualizationLink[];
}

export interface LinkCheckResult {
  checked: number;
  /** Fresh-output link-graph check: zero dead internal links allowed (AC-5). */
  deadLinks: VisualizationLink[];
}

// ── Manifest and output metadata (architecture-6 contract) ───────────────────

export interface ArtifactCounts {
  produced: number;
  missing: number;
  pending: number;
  skipped: number;
  unreadable: number;
}

export const REGENERATE_HINT =
  "run the on-demand visualize command to regenerate stale output (source state is newer than the generated view)";

export interface ManifestSessionEntry {
  kind: SessionKind;
  id: string;
  pathKey: PathKey;
  title: string;
  task: string;
  workflow: WorkflowName;
  updatedAt?: string;
  /** Bounded digest — the only digest form rendered (BG-1). */
  sourceDigestBounded: string;
  status: SessionStatus;
  staleness: Staleness;
  artifacts: ArtifactCounts;
  /** Relative output pages for this session (sessionPagePath for md/html). */
  pages: string[];
  /** Set when stale — count plus regenerate hint (REQ-8). */
  regenerateHint?: string;
}

/**
 * Deterministic bundle manifest. `scope: "selected"` is visibly partial;
 * `scope: "all"` is completeness mode. Counts (stale/degraded/pathKey/
 * discovered/generated) are deterministic for identical inputs.
 */
export interface VisualizationManifest {
  schema: 1;
  scope: VisualizationScope;
  /** ISO timestamp — volatile. */
  generatedAt: string;
  renderer: RendererIdentity;
  /** Deterministic session order (compareSessions). */
  sessions: ManifestSessionEntry[];
  counts: {
    discoveredSessions: number;
    generatedSessions: number;
    generatedPages: number;
    staleSessions: number;
    degradedSessions: number;
    artifactTotal: number;
    deadLinks: number;
  };
}

/** Frozen output destinations (implementation_contract.output). */
export const VISUALIZE_OUTPUT_ROOT = ".work-state/visualize" as const;
export const VISUALIZE_OUTPUT_FILES = {
  hubMarkdown: "index.md",
  hubHtml: "index.html",
  manifest: "manifest.json",
} as const;

export type OutputFileExtension = "md" | "html";

/** Session page path: `sessions/<kind>/<pathKey>.<ext>` (kind-namespaced). */
export function sessionPagePath(kind: SessionKind, pathKey: PathKey, ext: OutputFileExtension): string {
  return `sessions/${kind}/${pathKey}.${ext}`;
}

// ── Immutable snapshot (implementation_contract.model) ───────────────────────

/**
 * The immutable normalized snapshot: one read, deterministic ordering,
 * bounded/redacted bodies, provenance and link graph. `generatedAt` (and the
 * staleness derived from it) are the only fields allowed to differ between
 * regenerations of identical inputs.
 */
export interface VisualizationSnapshot {
  schema: 1;
  scope: VisualizationScope;
  /** ISO timestamp — volatile. */
  generatedAt: string;
  renderer: RendererIdentity;
  sessions: VisualizationSession[];
  manifest: VisualizationManifest;
  warnings: string[];
}

/** The complete list of fields allowed to vary across identical-input runs. */
export type VolatileField = "generatedAt" | "provenance.generatedAt" | "manifest.generatedAt" | "staleness";

export const VOLATILE_FIELDS: readonly VolatileField[] = [
  "generatedAt",
  "provenance.generatedAt",
  "manifest.generatedAt",
  "staleness",
] as const;

// ── Excluded inputs (implementation_contract.source_of_truth) ────────────────

/**
 * Canonical inputs are workflow state plus discovered artifact files only.
 * Observability event logs, vibe-report outputs and prior generated
 * visualization output are never discovered, never read, never rendered.
 */
export const EXCLUDED_INPUT_PATTERNS: readonly string[] = [
  ".work-state/visualize",
  "**/events.jsonl",
  "**/observability/events.jsonl",
  "vibe-report/**",
] as const;

export const EXCLUDED_INPUT_NAMES: readonly string[] = ["events.jsonl", "vibe-report"] as const;
