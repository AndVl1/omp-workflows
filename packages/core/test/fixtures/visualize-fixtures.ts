/* <!-- omp-cto-slice run=01a03ee4-7dd6-7580-8ad7-16d26dc886ba slice=workflow-v2-core --> */

/**
 * Visualize OPT-A — fixture inventory (architecture-1).
 *
 * Self-contained canonical inputs + hand-built golden normalized models. The
 * inventory covers every required edge: feature/legacy/CTO JSON/CTO
 * markdown-state/mixed sessions, slots, all 22 typed ids, spec-family and
 * regression ids, unknown/freeform ids, missing/pending/skipped/corrupt/
 * unreadable/empty statuses, Unicode/fences/HTML-like/CRLF content,
 * deep/large/hostile payloads, unsafe ids/paths, zero-artifact sessions and
 * excluded inputs (events.jsonl, vibe-report, prior generated output).
 *
 * SLICE-0/BG-1: mtime fields exist on raw inputs ONLY to simulate filesystems
 * and prove they never enter the digest, the model or any rendered field.
 *
 * No fixture imports generated output, events.jsonl or vibe-report; the only
 * source imports are the frozen contract modules, shared workflow-v2 fixture
 * helpers, and the existing report redactor used to compute truthful golden
 * body text.
 */

import { createHash } from "node:crypto";
import { readWorkflowProfile, workflowV2Fixture } from "../workflow-v2-fixtures.js";
import { redactReportBody } from "../../src/report/redact.js";
import {
  BOUNDED_DIGEST_LENGTH,
  DEFAULT_BODY_CAP_BYTES,
  DEFAULT_READ_WINDOW_BYTES,
  EMPTY_BODY_MARKER,
  LEGACY_ROOT_PATH_KEY,
  LEGACY_SESSION_ID,
  TYPED_ARTIFACT_IDS,
  formatTruncationMarker,
  serializeDigestInput,
  type ArtifactCounts,
  type ArtifactStatus,
  type DigestArtifactContribution,
  type PathKey,
  type RedactedBody,
  type RenderOptions,
  type SessionKind,
  type SessionStatus,
  type SourceDigest,
  type SourceDigestInput,
  type SourceFormat,
  type Staleness,
  type VisualizationArtifact,
  type VisualizationManifest,
  type VisualizationSession,
  type VisualizationSnapshot,
  type WorkflowName,
} from "../../src/visualize/types.js";
import type { ProjectIdentity, WorkflowRunIdentity } from "../../src/workflow-v2/types.js";
import type { WorkflowV2TestFixture } from "../workflow-v2-fixtures.js";

/** Fixed clock for every golden expectation (determinism tests). */
export const FIXED_GENERATED_AT = "2026-08-19T12:00:00.000Z";

const WORKFLOW_FIXTURES = new Map<string, WorkflowV2TestFixture>();

/**
 * Resolve a deterministic project/run identity from the same catalog fixture
 * used by workflow-v2 tests. Project pins stay profile-free; the run identity
 * adds the exact catalog profile and durable run id.
 */
function workflowFixtureFor(workflow: WorkflowName, runId: string): WorkflowV2TestFixture {
  const key = `${workflow}\u0000${runId}`;
  const cached = WORKFLOW_FIXTURES.get(key);
  if (cached) return cached;
  const fixture = workflowV2Fixture(readWorkflowProfile(workflow), { runId });
  WORKFLOW_FIXTURES.set(key, fixture);
  return fixture;
}

function identitiesFor(workflow: WorkflowName, runId: string): {
  project_identity: ProjectIdentity;
  run_identity: WorkflowRunIdentity;
} {
  const fixture = workflowFixtureFor(workflow, runId);
  return {
    project_identity: fixture.project_identity,
    run_identity: fixture.run_identity,
  };
}

export type StageStatus = "pending" | "in_progress" | "done" | "skipped" | "failed";

// ── Raw canonical inputs (what discovery reads) ──────────────────────────────

export interface CanonicalArtifactInput {
  id: string;
  /** Safe relative path from the workspace root. */
  relPath: string;
  /** Byte-exact file content. */
  content: string;
  /** Simulated filesystem mtime — MUST never enter digest/model/rendered fields (BG-1). */
  mtime?: string;
}

export interface CanonicalStateInput {
  format: SourceFormat;
  /** Raw file text (JSON state or markdown state). */
  content: string;
  /** state.updated_at when the format carries one. */
  updatedAt?: string;
  /** Simulated filesystem mtime — MUST never enter digest/model/rendered fields (BG-1). */
  mtime?: string;
}

export interface CanonicalSessionInput {
  kind: SessionKind;
  id: string;
  pathKey: PathKey;
  state: CanonicalStateInput;
  workflow: WorkflowName;
  /** id -> declared path exactly as recorded in canonical state (may be absolute/unsafe). */
  declaredArtifacts: Record<string, string>;
  /** Discovered artifact files (safe relative paths). */
  artifacts: CanonicalArtifactInput[];
  /** Paths that must never be discovered (excluded inputs). */
  excludedPaths: string[];
  profileHash?: string;
  expected: ExpectedSession;
}

export interface ExpectedSession {
  status: SessionStatus;
  /** Staleness vs FIXED_GENERATED_AT (AC-11 total rule). */
  staleness: Staleness;
  artifactStatuses: Record<string, ArtifactStatus>;
  warnings?: string[];
  degradedReasons?: string[];
}

export interface FixtureCase {
  id: string;
  title: string;
  /** Edge-group ids this case covers. */
  groups: string[];
  input: CanonicalSessionInput;
}

export interface FixtureInventory {
  schema: 1;
  cases: FixtureCase[];
  /** group id -> case ids (deterministic insertion order). */
  groups: Record<string, string[]>;
}

// ── Hostile content samples ──────────────────────────────────────────────────

export const UNICODE_SAMPLE = [
  "Título — Привет, мир 👋",
  "こんにちは / مرحبا / שלום",
  "Строка с кириллицей: ё, й, ц, ф",
  "Emoji: 😀 🎉 🚀 \u{1F680}",
  "RTL: مرحبا بالعالم",
].join("\n");

export const FENCES_SAMPLE = [
  "Intro before fences.",
  "",
  "```json",
  '{"nested": {"value": 1}}',
  "```",
  "",
  "Inline ```fence``` and a bare fence:",
  "```",
  "raw = true",
  "```",
  "",
  "Trailing text after fences.",
].join("\n");

export const HTML_LIKE_SAMPLE = [
  "<script>alert('xss')</script>",
  '<img src="x" onerror="alert(1)">',
  "<b>bold</b> &amp; &lt;entities&gt;",
  '<a href="javascript:void(0)">js link</a>',
  "<style>body{display:none}</style>",
].join("\n");

export const CRLF_SAMPLE = 'line one\r\nline two\r\n```json\r\n{"crlf": true}\r\n```\r\nline three';

export const SECRET_SAMPLES = [
  'api_key = "sk-abc123"',
  '"api_key": "sk-abc123"',
  "Authorization: Bearer abc.def.ghi",
  "password: hunter2",
  '"token": "t0k3n-secret"',
];

/** Depth 12 nested object — exceeds MAX_DEPTH 8. */
export function deepJson(depth: number): unknown {
  let node: unknown = { leaf: true };
  for (let i = 0; i < depth; i += 1) node = { level: i, child: node };
  return node;
}

export const DEEP_JSON_SAMPLE = JSON.stringify(deepJson(12), null, 2);

/** 250 collection items — exceeds MAX_COLLECTION_ITEMS 200. */
export const LARGE_COLLECTION_SAMPLE = JSON.stringify({ items: Array.from({ length: 250 }, (_, i) => i) });

/** 9000-char scalar — exceeds MAX_SCALAR_CHARS 8192. */
export const LARGE_SCALAR_TEXT = "x".repeat(9000);

export const CORRUPT_JSON_SAMPLE = '{ this is "not" valid json !!';

/**
 * Inject real secret-key lines (`"api_key": "sk-…"`) into a JSON artifact
 * body. Redaction patterns drop WHOLE lines matching quoted JSON keys, so a
 * truthful redaction probe needs the keys unescaped at the JSON top level —
 * secrets nested inside string values are escaped and legitimately survive.
 */
export function withInjectedSecretKeys(baseJson: string): string {
  const lines = baseJson.split("\n");
  const at = lines.findIndex((l) => l.includes('"artifact_id"'));
  if (at < 0) return baseJson;
  lines.splice(
    at + 1,
    0,
    '  "api_key": "sk-abc123",',
    '  "token": "t0k3n-secret",',
    '  "password": "hunter2",',
  );
  return lines.join("\n");
}

/** spec-preparation body: hostile strings plus real secret keys (AC-1, AC-3). */
export function hostileSpecBody(): string {
  const base = JSON.stringify(
    {
      artifact_id: "spec-preparation",
      artifact_type: "spec",
      summary: "Handoff with hostile strings.",
      notes: [UNICODE_SAMPLE, FENCES_SAMPLE, HTML_LIKE_SAMPLE, CRLF_SAMPLE],
    },
    null,
    2,
  );
  return withInjectedSecretKeys(base);
}

// ── Unsafe ids and paths ─────────────────────────────────────────────────────

export const UNSAFE_ARTIFACT_IDS: readonly string[] = [
  "../escape",
  "a/b",
  "a b",
  "a#b",
  "a?b",
  "a%b",
  ".hidden",
  "..",
  "a\u0000b",
] as const;

export const UNSAFE_DECLARED_PATHS: readonly string[] = [
  "/Users/alice/.work-state/features/x/artifacts/a.json",
  "C:\\work\\.work-state\\artifacts\\a.json",
  "../outside/state.json",
  ".work-state/../secret.json",
] as const;

export const SAFE_PATH_KEY_CASES: ReadonlyArray<{ value: string; safe: boolean }> = [
  { value: "visualize", safe: true },
  { value: "legacy-root", safe: true },
  { value: "feature-slug_1.b", safe: true },
  { value: "0abc", safe: true },
  { value: "", safe: false },
  { value: ".", safe: false },
  { value: "..", safe: false },
  { value: ".hidden", safe: false },
  { value: "a/b", safe: false },
  { value: "a\\b", safe: false },
  { value: "a b", safe: false },
  { value: "a#b", safe: false },
  { value: "a?b", safe: false },
  { value: "a%b", safe: false },
  { value: "../x", safe: false },
  { value: "a\u0000b", safe: false },
  { value: "-dash", safe: false },
] as const;

// ── Canonical input builders ─────────────────────────────────────────────────

export function artifact(id: string, relPath: string, content: string, mtime?: string): CanonicalArtifactInput {
  return { id, relPath, content, mtime };
}

export function featureStateJson(opts: {
  task: string;
  workflow: WorkflowName;
  updatedAt: string;
  stages: ReadonlyArray<{ id: string; status: StageStatus }>;
  artifacts: Record<string, string>;
  profileHash?: string;
  runId?: string;
  project_identity?: ProjectIdentity;
  run_identity?: WorkflowRunIdentity;
}): string {
  const fallback = identitiesFor(opts.workflow, opts.runId ?? "visualize");
  const project_identity = opts.project_identity ?? fallback.project_identity;
  const run_identity = opts.run_identity ?? fallback.run_identity;
  const state = {
    schema: 1,
    project_identity,
    run_identity,
    branch: "visualize",
    workflow: opts.workflow,
    classification: {
      type: "SPEC",
      complexity: "MEDIUM",
      confidence: "HIGH",
      workflow: opts.workflow,
      autonomous: false,
    },
    task: opts.task,
    workflow_override: false,
    issue: null,
    stage_cursor: opts.stages[opts.stages.length - 1]?.id ?? "",
    cursor_epoch: "visualize-cursor-epoch",
    stages: opts.stages,
    artifacts: opts.artifacts,
    pause: { kind: "none", reason: "" },
    updated_at: opts.updatedAt,
    ...(opts.profileHash !== undefined ? { profile_hash: run_identity.profile_identity.fingerprint } : {}),
  };
  return JSON.stringify(state, null, 2);
}

export function featureSession(opts: {
  id: string;
  pathKey: PathKey;
  task: string;
  workflow: WorkflowName;
  updatedAt: string;
  stages: ReadonlyArray<{ id: string; status: StageStatus }>;
  declared: Record<string, string>;
  files?: CanonicalArtifactInput[];
  excludedPaths?: string[];
  profileHash?: string;
  expected: ExpectedSession;
  stateMtime?: string;
}): CanonicalSessionInput {
  const identities = identitiesFor(opts.workflow, opts.id);
  const profileHash = opts.profileHash === undefined
    ? undefined
    : identities.run_identity.profile_identity.fingerprint;
  return {
    kind: "feature",
    id: opts.id,
    pathKey: opts.pathKey,
    state: {
      format: "json",
      content: featureStateJson({
        task: opts.task,
        workflow: opts.workflow,
        updatedAt: opts.updatedAt,
        stages: opts.stages,
        artifacts: opts.declared,
        profileHash,
        runId: opts.id,
        project_identity: identities.project_identity,
        run_identity: identities.run_identity,
      }),
      updatedAt: opts.updatedAt,
      mtime: opts.stateMtime,
    },
    workflow: opts.workflow,
    declaredArtifacts: opts.declared,
    artifacts: opts.files ?? [],
    excludedPaths: opts.excludedPaths ?? [],
    profileHash,
    expected: opts.expected,
  };
}

export function ctoStateJson(opts: {
  id: string;
  task: string;
  updatedAt: string;
  teams: ReadonlyArray<{ id: string; status: string; dodPath?: string }>;
  integrationStatus?: "pending" | "in_progress" | "done" | "failed";
  project_identity?: ProjectIdentity;
  run_identity?: WorkflowRunIdentity;
}): string {
  const fallback = identitiesFor("cto", opts.id);
  const project_identity = opts.project_identity ?? fallback.project_identity;
  const run_identity = opts.run_identity ?? fallback.run_identity;
  const ctoFixture = workflowFixtureFor("cto", opts.id);
  const teamProfileIdentity = workflowFixtureFor("standard", "fixture-profile").profile_identity;
  const leadRef = ctoFixture.effective_policy.roles.architect;
  const rosterRefs = [leadRef];
  const state = {
    schema: 2,
    id: opts.id,
    task: opts.task,
    branch: "visualize",
    autonomous: true,
    classification: {
      type: "FEATURE",
      complexity: "COMPLEX",
      confidence: "MEDIUM",
      workflow: "cto",
      autonomous: true,
    },
    project_identity,
    run_identity,
    plan: {
      id: opts.id,
      task: opts.task,
      created_at: "2026-08-19T09:00:00.000Z",
      run_identity,
      teams: opts.teams.map((t) => ({
        team: t.id,
        scope: ["core"],
        slice: t.id,
        profile: "standard",
        profile_identity: teamProfileIdentity,
        lead_ref: leadRef,
        roster_refs: rosterRefs,
        run_identity,
        worktree: "same_branch",
        depends_on: [],
      })),
    },
    teams: opts.teams.map((t) => ({
      id: t.id,
      status: t.status,
      escalations: {},
      run_identity,
      profile_identity: teamProfileIdentity,
      lead_ref: leadRef,
      roster_refs: rosterRefs,
      ...(t.dodPath ? { dod_path: t.dodPath } : {}),
    })),
    integration: { status: opts.integrationStatus ?? "pending", note: "integration review pending" },
    pause: { kind: "none", reason: "" },
    updated_at: opts.updatedAt,
  };
  return JSON.stringify(state, null, 2);
}

export interface MarkdownCtoFiles {
  files: Record<string, string>;
}

/** Recognized agent-written markdown state; finish markers mark a terminal run. */
export function markdownCtoFiles(opts: {
  task: string;
  classificationLine: string;
  withFinishMarker?: boolean;
}): MarkdownCtoFiles {
  const files: Record<string, string> = {
    "cto_discovery.md": [
      `# ${opts.task}`,
      "",
      opts.classificationLine,
      "",
      "## Discovery",
      "",
      "Repository facts and layout notes.",
    ].join("\n"),
    "team-plan.md": [
      "# Team plan",
      "",
      opts.classificationLine,
      "",
      "- team: alpha",
      "  scope: core",
      "  slice: extract shared source discovery",
    ].join("\n"),
    "decisions.md": ["# Decisions", "", "- DEC-1: OPT-A projection first.", "- DEC-2: local-only output."].join("\n"),
  };
  if (opts.withFinishMarker) files["summary.md"] = ["# Summary", "", "Finished run."].join("\n");
  return { files };
}

function specArtifactJson(id: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify(
    {
      artifact_id: id,
      artifact_type: "spec",
      feature: "visualize",
      workflow: "spec-preparation",
      classification: { type: "SPEC", complexity: "MEDIUM", confidence: "HIGH", autonomous: false },
      status: "complete",
      ...extra,
    },
    null,
    2,
  );
}

function slotArtifactJson(base: string, role: string): string {
  return JSON.stringify(
    {
      artifact_id: `${base}-${role}`,
      artifact_type: "slot",
      base,
      role,
      status: "complete",
      findings: ["Deterministic overview", "Bounded redacted bodies"],
    },
    null,
    2,
  );
}

function typedArtifactJson(id: string): string {
  return JSON.stringify(
    { artifact_id: id, artifact_type: id, status: "complete", notes: "typed payload", summary: `Summary of ${id}` },
    null,
    2,
  );
}

// ── Digest helpers (SLICE-0/BG-1) ────────────────────────────────────────────

/** Build a digest input from loose entries; absent `content` ⇒ `present: false`. */
export function digestInputFrom(
  stateContent: string,
  entries: ReadonlyArray<{ id: string; content?: string; sizeBytes?: number; readBytes?: number }>,
  windowBytes: number = DEFAULT_READ_WINDOW_BYTES,
): SourceDigestInput {
  const contributions: DigestArtifactContribution[] = entries.map((e) => {
    if (typeof e.content === "string") {
      const bytes = Buffer.byteLength(e.content, "utf8");
      return { id: e.id, present: true, sizeBytes: bytes, readBytes: Math.min(bytes, windowBytes) };
    }
    return { id: e.id, present: false, sizeBytes: e.sizeBytes ?? 0, readBytes: e.readBytes ?? 0 };
  });
  return { stateContent, artifacts: contributions };
}

/**
 * Deterministic digest input for a canonical session: state content plus every
 * declared/discovered artifact (sorted by id). Slots and extras discovered on
 * disk participate; declared-but-absent files contribute `present: false`.
 * mtime is not a field of the input — it cannot leak into the digest (BG-1).
 */
export function digestInputFor(input: CanonicalSessionInput, windowBytes: number = DEFAULT_READ_WINDOW_BYTES): SourceDigestInput {
  const byId = new Map<string, CanonicalArtifactInput>();
  for (const file of input.artifacts) byId.set(file.id, file);
  const ids = new Set<string>([...Object.keys(input.declaredArtifacts), ...input.artifacts.map((f) => f.id)]);
  const contributions: DigestArtifactContribution[] = [...ids].sort().map((id) => {
    const file = byId.get(id);
    if (!file) return { id, present: false, sizeBytes: 0, readBytes: 0 };
    const bytes = Buffer.byteLength(file.content, "utf8");
    return { id, present: true, sizeBytes: bytes, readBytes: Math.min(bytes, windowBytes) };
  });
  return { stateContent: input.state.content, artifacts: contributions };
}

/** sha256 digest over the canonical serialization — the pinned BG-1 rule. */
export function digestFor(input: CanonicalSessionInput, windowBytes: number = DEFAULT_READ_WINDOW_BYTES): SourceDigest {
  const serialized = serializeDigestInput(digestInputFor(input, windowBytes));
  const full = createHash("sha256").update(serialized, "utf8").digest("hex");
  return {
    algorithm: "sha256",
    full,
    bounded: full.slice(0, BOUNDED_DIGEST_LENGTH),
    inputBytes: Buffer.byteLength(serialized, "utf8"),
  };
}

/** BG-1 invariance pairs: same content + different mtimes must serialize identically. */
export interface DigestInvarianceCase {
  id: string;
  description: string;
  a: SourceDigestInput;
  b: SourceDigestInput;
  /** True → identical serialization expected; false → serialization must differ. */
  identical: boolean;
  windowBytes: number;
}

export const DIGEST_INVARIANCE_CASES: readonly DigestInvarianceCase[] = [
  {
    id: "bg1-touch-invariance",
    description: "identical content with different mtimes serializes identically (mtime excluded)",
    a: digestInputFrom("state-a", [{ id: "x", content: "hello" }, { id: "y", content: "world" }]),
    b: digestInputFrom("state-a", [{ id: "x", content: "hello" }, { id: "y", content: "world" }]),
    identical: true,
    windowBytes: DEFAULT_READ_WINDOW_BYTES,
  },
  {
    id: "bg1-content-mutation",
    description: "content change invalidates the digest",
    a: digestInputFrom("state-a", [{ id: "x", content: "hello" }]),
    b: digestInputFrom("state-a", [{ id: "x", content: "hello!" }]),
    identical: false,
    windowBytes: DEFAULT_READ_WINDOW_BYTES,
  },
  {
    id: "bg1-size-mutation",
    description: "byte-size change (same head window) invalidates the digest",
    a: digestInputFrom("state-a", [{ id: "x", content: "hello" }]),
    b: digestInputFrom("state-a", [{ id: "x", content: "hello " }]),
    identical: false,
    windowBytes: DEFAULT_READ_WINDOW_BYTES,
  },
  {
    id: "bg1-window-mutation",
    description: "bounded read-window change invalidates the digest when the file exceeds the window",
    a: digestInputFrom("state-a", [{ id: "x", content: "y".repeat(20000) }], DEFAULT_READ_WINDOW_BYTES),
    b: digestInputFrom("state-a", [{ id: "x", content: "y".repeat(20000) }], 8192),
    identical: false,
    windowBytes: DEFAULT_READ_WINDOW_BYTES,
  },
  {
    id: "bg1-missing-vs-empty",
    description: "declared-but-missing vs present zero-byte file serialize differently",
    a: digestInputFrom("state-a", [{ id: "x" }]),
    b: digestInputFrom("state-a", [{ id: "x", content: "" }]),
    identical: false,
    windowBytes: DEFAULT_READ_WINDOW_BYTES,
  },
] as const;

/** Session-level mtime pairs: identical canonical inputs differing only in mtimes. */
export interface SessionMtimePair {
  id: string;
  description: string;
  a: CanonicalSessionInput;
  b: CanonicalSessionInput;
}

export function buildMtimePairs(): SessionMtimePair[] {
  const base = featureSession({
    id: "mtime",
    pathKey: "mtime",
    task: "Mtime invariance probe.",
    workflow: "spec-preparation",
    updatedAt: "2026-08-19T10:00:00.000Z",
    stages: [{ id: "handoff", status: "done" }],
    declared: { spec_handoff: ".work-state/features/mtime/artifacts/spec_handoff.json" },
    files: [artifact("spec_handoff", ".work-state/features/mtime/artifacts/spec_handoff.json", "y".repeat(2000), "2026-08-19T08:00:00.000Z")],
    expected: { status: "complete", staleness: "fresh", artifactStatuses: { spec_handoff: "produced" } },
    stateMtime: "2026-08-19T08:00:00.000Z",
  });
  const touched = featureSession({
    id: "mtime",
    pathKey: "mtime",
    task: "Mtime invariance probe.",
    workflow: "spec-preparation",
    updatedAt: "2026-08-19T10:00:00.000Z",
    stages: [{ id: "handoff", status: "done" }],
    declared: { spec_handoff: ".work-state/features/mtime/artifacts/spec_handoff.json" },
    files: [artifact("spec_handoff", ".work-state/features/mtime/artifacts/spec_handoff.json", "y".repeat(2000), "2030-01-01T00:00:00.000Z")],
    expected: { status: "complete", staleness: "fresh", artifactStatuses: { spec_handoff: "produced" } },
    stateMtime: "2030-01-01T00:00:00.000Z",
  });
  return [
    {
      id: "bg1-session-touch-invariance",
      description: "session inputs differing only in mtimes produce identical digests and identical non-volatile models",
      a: base,
      b: touched,
    },
  ];
}

// ── Edge-group contract (REQ/AC coverage) ────────────────────────────────────

/** Every edge group the assignment/acceptance contract requires. */
export const REQUIRED_EDGE_GROUPS: readonly string[] = [
  "feature",
  "legacy",
  "cto-json",
  "cto-markdown",
  "mixed-state",
  "slots",
  "typed-22",
  "spec-family",
  "regression",
  "unknown-freeform",
  "missing",
  "pending",
  "skipped",
  "corrupt",
  "unreadable",
  "empty",
  "unicode",
  "fences",
  "html-like",
  "crlf",
  "deep",
  "large",
  "hostile",
  "unsafe-ids",
  "unsafe-paths",
  "zero-artifacts",
  "excluded-inputs",
  "degraded",
  "mtime-invariance",
  "determinism",
  "scope-partial",
  "scope-all",
] as const;

// ── Inventory cases ──────────────────────────────────────────────────────────

export function buildFixtureInventory(): FixtureInventory {
  const cases: FixtureCase[] = [];

  // 1. feature · spec-preparation · detailed · slots · hostile · missing · oversized
  cases.push({
    id: "feature-spec-preparation",
    title: "spec-preparation feature session: 7 spec artifacts + consilium slots, hostile content, one missing, one oversized preview",
    groups: ["feature", "spec-family", "slots", "missing", "unicode", "fences", "html-like", "crlf", "large", "produced"],
    input: featureSession({
      id: "visualize",
      pathKey: "visualize",
      task: "Visualize workflow specs: readable overview + internal navigation.",
      workflow: "spec-preparation",
      updatedAt: "2026-08-19T10:00:00.000Z",
      profileHash: "fixture-profile",
      stages: [
        { id: "intake_repo_map", status: "done" },
        { id: "requirements_edge_cases", status: "done" },
        { id: "options_decision_log", status: "done" },
        { id: "architecture_task_slices", status: "done" },
        { id: "completeness_gate", status: "in_progress" },
        { id: "handoff", status: "in_progress" },
      ],
      declared: {
        spec_intake_repo_map: ".work-state/features/visualize/artifacts/spec_intake_repo_map.json",
        spec_requirements_edge_cases: ".work-state/features/visualize/artifacts/spec_requirements_edge_cases.json",
        spec_options_decisions: ".work-state/features/visualize/artifacts/spec_options_decisions.json",
        spec_architecture_tasks: ".work-state/features/visualize/artifacts/spec_architecture_tasks.json",
        spec_completeness: ".work-state/features/visualize/artifacts/spec_completeness.json",
        "spec-preparation": ".work-state/features/visualize/artifacts/spec-preparation.json",
        spec_handoff: ".work-state/features/visualize/artifacts/spec_handoff.json",
      },
      files: [
        artifact("spec_intake_repo_map", ".work-state/features/visualize/artifacts/spec_intake_repo_map.json", specArtifactJson("spec_intake_repo_map", { verified_facts: ["22 typed ids", "12 workflow profiles"] })),
        artifact("spec_intake_repo_map-analyst", ".work-state/features/visualize/artifacts/spec_intake_repo_map-analyst.json", slotArtifactJson("spec_intake_repo_map", "analyst")),
        artifact("spec_intake_repo_map-tech-researcher", ".work-state/features/visualize/artifacts/spec_intake_repo_map-tech-researcher.json", slotArtifactJson("spec_intake_repo_map", "tech-researcher")),
        artifact("spec_requirements_edge_cases", ".work-state/features/visualize/artifacts/spec_requirements_edge_cases.json", specArtifactJson("spec_requirements_edge_cases", { edge_cases: ["unsafe ids", "CRLF", "deep JSON"] })),
        artifact("spec_options_decisions", ".work-state/features/visualize/artifacts/spec_options_decisions.json", specArtifactJson("spec_options_decisions", { options: ["OPT-A", "OPT-B", "OPT-C"] })),
        artifact("spec_architecture_tasks", ".work-state/features/visualize/artifacts/spec_architecture_tasks.json", specArtifactJson("spec_architecture_tasks", { task_slices: ["architecture-1", "architecture-2"] })),
        // spec_completeness declared but NOT on disk → missing
        artifact("spec-preparation", ".work-state/features/visualize/artifacts/spec-preparation.json", hostileSpecBody()),
        // 17 KB > default 16 KiB read window → produced with preview at default
        artifact(
          "spec_handoff",
          ".work-state/features/visualize/artifacts/spec_handoff.json",
          JSON.stringify({ artifact_id: "spec_handoff", artifact_type: "spec", padding: "y".repeat(17000) }),
        ),
      ],
      expected: {
        status: "complete",
        staleness: "fresh",
        artifactStatuses: {
          spec_intake_repo_map: "produced",
          "spec_intake_repo_map-analyst": "produced",
          "spec_intake_repo_map-tech-researcher": "produced",
          spec_requirements_edge_cases: "produced",
          spec_options_decisions: "produced",
          spec_architecture_tasks: "produced",
          spec_completeness: "missing",
          "spec-preparation": "produced",
          spec_handoff: "produced",
        },
        warnings: [
          "declared artifact spec_completeness is missing",
          "artifact spec_handoff is larger than the read window: head preview (original bytes > window)",
        ],
      },
    }),
  });

  // 2. feature · bug-fix · compact · typed · missing/skipped/pending
  cases.push({
    id: "feature-bug-fix",
    title: "bug-fix feature session: typed ids, one missing, one skipped stage artifact, two pending",
    groups: ["feature", "bug-fix", "typed", "missing", "skipped", "pending"],
    input: featureSession({
      id: "fix-regression-42",
      pathKey: "fix-regression-42",
      task: "Fix the flaky artifact contract test.",
      workflow: "bug-fix",
      updatedAt: "2026-08-19T09:00:00.000Z",
      stages: [
        { id: "discovery", status: "done" },
        { id: "diagnose", status: "done" },
        { id: "implementation", status: "done" },
        { id: "review", status: "skipped" },
        { id: "manual_qa", status: "pending" },
        { id: "summary", status: "pending" },
      ],
      declared: {
        discovery: ".work-state/features/fix-regression-42/artifacts/discovery.json",
        diagnosis: ".work-state/features/fix-regression-42/artifacts/diagnosis.json",
        dod: ".work-state/features/fix-regression-42/artifacts/dod.json",
        implementation: ".work-state/features/fix-regression-42/artifacts/implementation.json",
        review: ".work-state/features/fix-regression-42/artifacts/review.json",
        manual_qa: ".work-state/features/fix-regression-42/artifacts/manual_qa.json",
        summary: ".work-state/features/fix-regression-42/artifacts/summary.json",
      },
      files: [
        artifact("discovery", ".work-state/features/fix-regression-42/artifacts/discovery.json", typedArtifactJson("discovery")),
        artifact("diagnosis", ".work-state/features/fix-regression-42/artifacts/diagnosis.json", typedArtifactJson("diagnosis")),
        artifact("dod", ".work-state/features/fix-regression-42/artifacts/dod.json", typedArtifactJson("dod")),
        // implementation declared but NOT on disk → missing
        // review: stage skipped → skipped (even though the file is absent)
        // manual_qa, summary: stages pending → pending
      ],
      expected: {
        status: "complete",
        staleness: "fresh",
        artifactStatuses: {
          discovery: "produced",
          diagnosis: "produced",
          dod: "produced",
          implementation: "missing",
          review: "skipped",
          manual_qa: "pending",
          summary: "pending",
        },
        warnings: ["declared artifact implementation is missing"],
      },
    }),
  });

  // 3. feature · unlisted workflow · safe default · freeform/regression/unknown spec_*
  cases.push({
    id: "feature-unlisted",
    title: "unlisted workflow (research): explicit safe default depth, generic fallback ids",
    groups: ["feature", "unlisted", "default-depth", "unknown-freeform", "regression", "spec-family"],
    input: featureSession({
      id: "research-indexing",
      pathKey: "research-indexing",
      task: "Index the lecture corpus.",
      workflow: "research",
      updatedAt: "2026-08-19T07:30:00.000Z",
      stages: [{ id: "survey", status: "done" }],
      declared: {
        freeform_note: ".work-state/features/research-indexing/artifacts/freeform_note.json",
        regression_perf: ".work-state/features/research-indexing/artifacts/regression_perf.json",
        spec_prototype_2026: ".work-state/features/research-indexing/artifacts/spec_prototype_2026.json",
      },
      files: [
        artifact("freeform_note", ".work-state/features/research-indexing/artifacts/freeform_note.json", JSON.stringify({ note: "any shape is fine" })),
        artifact("regression_perf", ".work-state/features/research-indexing/artifacts/regression_perf.json", JSON.stringify({ run: 1, ms: 42 })),
        artifact("spec_prototype_2026", ".work-state/features/research-indexing/artifacts/spec_prototype_2026.json", specArtifactJson("spec_prototype_2026")),
      ],
      expected: {
        status: "complete",
        staleness: "fresh",
        artifactStatuses: { freeform_note: "produced", regression_perf: "produced", spec_prototype_2026: "produced" },
      },
    }),
  });

  // 4. legacy root · stale · excluded events.jsonl at root
  cases.push({
    id: "legacy-root",
    title: "legacy root do-work state: pathKey legacy-root, stale, root events.jsonl excluded",
    groups: ["legacy", "typed", "excluded-inputs", "stale"],
    input: {
      kind: "legacy",
      id: LEGACY_SESSION_ID,
      pathKey: LEGACY_ROOT_PATH_KEY,
      state: {
        format: "json",
        content: featureStateJson({
          task: "Legacy do-work run.",
          workflow: "standard",
          runId: LEGACY_SESSION_ID,
          updatedAt: "2026-08-19T13:00:00.000Z",
          stages: [
            { id: "discovery", status: "done" },
            { id: "summary", status: "done" },
          ],
          artifacts: {
            discovery: ".work-state/artifacts/discovery.json",
            summary: ".work-state/artifacts/summary.json",
          },
        }),
        updatedAt: "2026-08-19T13:00:00.000Z",
      },
      workflow: "standard",
      declaredArtifacts: {
        discovery: ".work-state/artifacts/discovery.json",
        summary: ".work-state/artifacts/summary.json",
      },
      artifacts: [
        artifact("discovery", ".work-state/artifacts/discovery.json", typedArtifactJson("discovery")),
        artifact("summary", ".work-state/artifacts/summary.json", typedArtifactJson("summary")),
      ],
      excludedPaths: [".work-state/events.jsonl", ".work-state/observability/events.jsonl", "vibe-report/legacy-2026-08-19.md"],
      expected: {
        status: "complete",
        staleness: "stale",
        artifactStatuses: { discovery: "produced", summary: "produced" },
      },
    },
  });

  // 5. feature literally named "legacy" — pathKey stays "legacy" (legacy collision contract)
  cases.push({
    id: "feature-named-legacy",
    title: "feature slug 'legacy' keeps pathKey 'legacy' while the legacy root keeps 'legacy-root'",
    groups: ["feature", "unsafe-ids"],
    input: featureSession({
      id: "legacy",
      pathKey: "legacy",
      task: "Feature work in a repository whose slug collides with the legacy session name.",
      workflow: "standard",
      updatedAt: "2026-08-19T06:00:00.000Z",
      stages: [{ id: "implementation", status: "done" }],
      declared: { freeform_note: ".work-state/features/legacy/artifacts/freeform_note.json" },
      files: [artifact("freeform_note", ".work-state/features/legacy/artifacts/freeform_note.json", JSON.stringify({ note: "collision probe" }))],
      expected: { status: "complete", staleness: "fresh", artifactStatuses: { freeform_note: "produced" } },
    }),
  });

  // 6. CTO JSON state · run-local + compatibility artifacts
  cases.push({
    id: "cto-json",
    title: "CTO JSON run: run-local artifacts plus team compatibility location, validated dod_path",
    groups: ["cto-json", "typed", "mixed-state"],
    input: {
      kind: "cto",
      id: "cto-run-7f3a",
      pathKey: "cto-run-7f3a",
      state: {
        format: "json",
        content: ctoStateJson({
          id: "cto-run-7f3a",
          task: "Coordinate the migrate-to-KMP effort.",
          updatedAt: "2026-08-19T11:00:00.000Z",
          teams: [
            { id: "alpha", status: "done", dodPath: ".work-state/cto/cto-run-7f3a/artifacts/alpha/dod.json" },
            { id: "beta", status: "in_progress" },
          ],
          integrationStatus: "in_progress",
        }),
        updatedAt: "2026-08-19T11:00:00.000Z",
      },
      workflow: "cto",
      declaredArtifacts: {
        cto_discovery: ".work-state/cto/cto-run-7f3a/artifacts/cto_discovery.json",
        team_plan: ".work-state/cto/cto-run-7f3a/artifacts/team_plan.json",
        summary: ".work-state/artifacts/alpha/summary.json",
        dod: ".work-state/cto/cto-run-7f3a/artifacts/alpha/dod.json",
      },
      artifacts: [
        artifact("cto_discovery", ".work-state/cto/cto-run-7f3a/artifacts/cto_discovery.json", typedArtifactJson("cto_discovery")),
        artifact("team_plan", ".work-state/cto/cto-run-7f3a/artifacts/team_plan.json", typedArtifactJson("team_plan")),
        artifact("summary", ".work-state/artifacts/alpha/summary.json", typedArtifactJson("summary")),
        artifact("dod", ".work-state/cto/cto-run-7f3a/artifacts/alpha/dod.json", typedArtifactJson("dod")),
      ],
      excludedPaths: [],
      expected: {
        status: "complete",
        staleness: "fresh",
        artifactStatuses: { cto_discovery: "produced", team_plan: "produced", summary: "produced", dod: "produced" },
      },
    },
  });

  // 7. CTO markdown-state · active
  cases.push({
    id: "cto-markdown-active",
    title: "active markdown-state CTO (no state.json, no finish marker): normalized overview",
    groups: ["cto-markdown"],
    input: {
      kind: "cto",
      id: "cto-markdown-live",
      pathKey: "cto-markdown-live",
      state: {
        format: "markdown",
        content: markdownCtoFiles({
          task: "Coordinate a markdown-only CTO run.",
          classificationLine:
            'classification: { "type": "FEATURE", "complexity": "COMPLEX", "confidence": "MEDIUM", "autonomous": true }',
        }).files["team-plan.md"] ?? "",
        updatedAt: undefined,
      },
      workflow: "cto",
      declaredArtifacts: {},
      artifacts: [],
      excludedPaths: [],
      expected: { status: "complete", staleness: "unknown", artifactStatuses: {} },
    },
  });

  // 8. CTO markdown-state · terminal (finish marker) → degraded projection
  cases.push({
    id: "cto-markdown-terminal",
    title: "terminal markdown-state CTO (summary.md finish marker): degraded visualization-only projection",
    groups: ["cto-markdown", "degraded"],
    input: {
      kind: "cto",
      id: "cto-markdown-done",
      pathKey: "cto-markdown-done",
      state: {
        format: "markdown",
        content: markdownCtoFiles({
          task: "A finished markdown CTO run.",
          classificationLine:
            'classification: { "type": "FEATURE", "complexity": "COMPLEX", "confidence": "MEDIUM", "autonomous": false }',
          withFinishMarker: true,
        }).files["summary.md"] ?? "",
        updatedAt: undefined,
      },
      workflow: "cto",
      declaredArtifacts: {},
      artifacts: [],
      excludedPaths: [],
      expected: {
        status: "degraded",
        staleness: "unknown",
        artifactStatuses: {},
        degradedReasons: ["terminal markdown CTO state: visualization-only projection"],
      },
    },
  });

  // 9. CTO · no usable state (no JSON, no markdown) → degraded but still listed
  cases.push({
    id: "cto-markdown-absent",
    title: "CTO run with neither state.json nor markdown state: degraded listing with available artifacts",
    groups: ["cto-markdown", "degraded", "produced"],
    input: {
      kind: "cto",
      id: "cto-orphan",
      pathKey: "cto-orphan",
      state: {
        format: "markdown",
        content: "",
        updatedAt: undefined,
      },
      workflow: "cto",
      declaredArtifacts: { team_artifacts: ".work-state/cto/cto-orphan/artifacts/team_artifacts.json" },
      artifacts: [artifact("team_artifacts", ".work-state/cto/cto-orphan/artifacts/team_artifacts.json", typedArtifactJson("team_artifacts"))],
      excludedPaths: [],
      expected: {
        status: "degraded",
        staleness: "unknown",
        artifactStatuses: { team_artifacts: "produced" },
        degradedReasons: ["no usable CTO state (JSON or markdown) found; rendering available content"],
      },
    },
  });

  // 10. mixed state · AC-1 fixture: typed + freeform hostile + slot + missing + corrupt
  cases.push({
    id: "mixed-state",
    title: "AC-1 fixture: typed, freeform spec with Unicode/fences/HTML-like, slot, declared-but-missing, corrupt JSON",
    groups: ["mixed-state", "typed", "spec-family", "slots", "regression", "unknown-freeform", "missing", "corrupt", "unreadable", "empty", "unicode", "fences", "html-like", "deep"],
    input: featureSession({
      id: "mixed",
      pathKey: "mixed",
      task: "Exercise every artifact shape in one session.",
      workflow: "standard",
      updatedAt: "2026-08-19T05:00:00.000Z",
      stages: [
        { id: "discovery", status: "done" },
        { id: "handoff", status: "done" },
      ],
      declared: {
        discovery: ".work-state/features/mixed/artifacts/discovery.json",
        "discovery-analyst": ".work-state/features/mixed/artifacts/discovery-analyst.json",
        spec_intake_repo_map: ".work-state/features/mixed/artifacts/spec_intake_repo_map.json",
        regression_001: ".work-state/features/mixed/artifacts/regression_001.json",
        notes: ".work-state/features/mixed/artifacts/notes.json",
        dod: ".work-state/features/mixed/artifacts/dod.json",
        corrupt: ".work-state/features/mixed/artifacts/corrupt.json",
        emptydoc: ".work-state/features/mixed/artifacts/emptydoc.json",
      },
      files: [
        artifact("discovery", ".work-state/features/mixed/artifacts/discovery.json", typedArtifactJson("discovery")),
        artifact("discovery-analyst", ".work-state/features/mixed/artifacts/discovery-analyst.json", slotArtifactJson("discovery", "analyst")),
        artifact(
          "spec_intake_repo_map",
          ".work-state/features/mixed/artifacts/spec_intake_repo_map.json",
          withInjectedSecretKeys(
            JSON.stringify(
              { artifact_id: "spec_intake_repo_map", notes: [UNICODE_SAMPLE, FENCES_SAMPLE, HTML_LIKE_SAMPLE] },
              null,
              2,
            ),
          ),
        ),
        artifact("regression_001", ".work-state/features/mixed/artifacts/regression_001.json", JSON.stringify({ run: 1, pass: false })),
        artifact("notes", ".work-state/features/mixed/artifacts/notes.json", JSON.stringify({ note: "freeform unknown id" })),
        // dod declared but NOT on disk → missing
        artifact("corrupt", ".work-state/features/mixed/artifacts/corrupt.json", CORRUPT_JSON_SAMPLE),
        artifact("emptydoc", ".work-state/features/mixed/artifacts/emptydoc.json", ""),
      ],
      expected: {
        status: "complete",
        staleness: "fresh",
        artifactStatuses: {
          discovery: "produced",
          "discovery-analyst": "produced",
          spec_intake_repo_map: "produced",
          regression_001: "produced",
          notes: "produced",
          dod: "missing",
          corrupt: "unreadable",
          emptydoc: "produced",
        },
        warnings: ["declared artifact dod is missing", "artifact corrupt is unreadable: invalid JSON within the read window"],
      },
    }),
  });

  // 11. slots · mid-consilium: shared base absent while producer is in_progress → base pending
  cases.push({
    id: "slots-mid-consilium",
    title: "mid-consilium: base artifact absent while its producer is in_progress and slots exist → base pending, slots produced",
    groups: ["slots", "pending"],
    input: featureSession({
      id: "consilium",
      pathKey: "consilium",
      task: "Run a consilium stage mid-flight.",
      workflow: "spec-preparation",
      updatedAt: "2026-08-19T04:00:00.000Z",
      stages: [{ id: "architecture_task_slices", status: "in_progress" }],
      declared: {
        spec_architecture_tasks: ".work-state/features/consilium/artifacts/spec_architecture_tasks.json",
      },
      files: [
        artifact("spec_architecture_tasks-architect", ".work-state/features/consilium/artifacts/spec_architecture_tasks-architect.json", slotArtifactJson("spec_architecture_tasks", "architect")),
        artifact("spec_architecture_tasks-tech-researcher", ".work-state/features/consilium/artifacts/spec_architecture_tasks-tech-researcher.json", slotArtifactJson("spec_architecture_tasks", "tech-researcher")),
      ],
      expected: {
        status: "complete",
        staleness: "fresh",
        artifactStatuses: {
          spec_architecture_tasks: "pending",
          "spec_architecture_tasks-architect": "produced",
          "spec_architecture_tasks-tech-researcher": "produced",
        },
        warnings: ["shared artifact spec_architecture_tasks is pending: producer in_progress, slots present"],
      },
    }),
  });

  // 12. all 22 typed ids
  cases.push({
    id: "all-22-typed",
    title: "all 22 schema-typed artifact ids present and produced",
    groups: ["typed-22", "produced"],
    input: featureSession({
      id: "typed-all",
      pathKey: "typed-all",
      task: "Cover the full typed schema inventory.",
      workflow: "standard",
      updatedAt: "2026-08-19T03:00:00.000Z",
      stages: [{ id: "synthesis", status: "done" }],
      declared: Object.fromEntries(TYPED_ARTIFACT_IDS.map((id) => [id, `.work-state/features/typed-all/artifacts/${id}.json`])),
      files: TYPED_ARTIFACT_IDS.map((id) => artifact(id, `.work-state/features/typed-all/artifacts/${id}.json`, typedArtifactJson(id))),
      expected: {
        status: "complete",
        staleness: "fresh",
        artifactStatuses: Object.fromEntries(TYPED_ARTIFACT_IDS.map((id) => [id, "produced" as const])),
      },
    }),
  });

  // 13. corrupt / unreadable / empty
  cases.push({
    id: "corrupt-unreadable-empty",
    title: "corrupt JSON → unreadable; empty file and empty object → produced with empty markers",
    groups: ["corrupt", "unreadable", "empty"],
    input: featureSession({
      id: "broken",
      pathKey: "broken",
      task: "Probe corrupt and empty artifacts.",
      workflow: "standard",
      updatedAt: "2026-08-19T02:00:00.000Z",
      stages: [{ id: "discovery", status: "done" }],
      declared: {
        corrupt: ".work-state/features/broken/artifacts/corrupt.json",
        unreadable: ".work-state/features/broken/artifacts/unreadable.json",
        empty: ".work-state/features/broken/artifacts/empty.json",
        emptyobj: ".work-state/features/broken/artifacts/emptyobj.json",
      },
      files: [
        artifact("corrupt", ".work-state/features/broken/artifacts/corrupt.json", CORRUPT_JSON_SAMPLE),
        artifact("unreadable", ".work-state/features/broken/artifacts/unreadable.json", '{"unterminated": '),
        artifact("empty", ".work-state/features/broken/artifacts/empty.json", ""),
        artifact("emptyobj", ".work-state/features/broken/artifacts/emptyobj.json", "{}"),
      ],
      expected: {
        status: "complete",
        staleness: "fresh",
        artifactStatuses: {
          corrupt: "unreadable",
          unreadable: "unreadable",
          empty: "produced",
          emptyobj: "produced",
        },
        warnings: [
          "artifact corrupt is unreadable: invalid JSON within the read window",
          "artifact unreadable is unreadable: invalid JSON within the read window",
        ],
      },
    }),
  });

  // 14. oversized: bigger than the default window, one also bigger than the --full window
  cases.push({
    id: "oversized",
    title: "oversized artifacts: default-window head preview; --full window; hard-cap-beyond preview",
    groups: ["large", "produced"],
    input: featureSession({
      id: "oversized",
      pathKey: "oversized",
      task: "Probe byte caps and head previews.",
      workflow: "standard",
      updatedAt: "2026-08-19T01:00:00.000Z",
      stages: [{ id: "summary", status: "done" }],
      declared: {
        big: ".work-state/features/oversized/artifacts/big.json",
        huge: ".work-state/features/oversized/artifacts/huge.json",
      },
      files: [
        // ~20 KB valid JSON: preview at default window (16 KiB), parses fully under --full (256 KiB)
        artifact("big", ".work-state/features/oversized/artifacts/big.json", JSON.stringify({ data: "y".repeat(19000) })),
        // ~300 KB: preview even under --full
        artifact("huge", ".work-state/features/oversized/artifacts/huge.json", JSON.stringify({ data: "z".repeat(290000) })),
      ],
      expected: {
        status: "complete",
        staleness: "fresh",
        artifactStatuses: { big: "produced", huge: "produced" },
        warnings: [
          "artifact big is larger than the read window: head preview (original bytes > window)",
          "artifact huge is larger than the read window: head preview (original bytes > window)",
        ],
      },
    }),
  });

  // 15. deep / large / hostile content
  cases.push({
    id: "deep-hostile",
    title: "deep JSON, large collections, large scalars, unicode/fences/HTML/CRLF payloads",
    groups: ["deep", "large", "hostile", "unicode", "fences", "html-like", "crlf"],
    input: featureSession({
      id: "hostile",
      pathKey: "hostile",
      task: "Probe depth, collection and scalar bounds plus hostile text.",
      workflow: "standard",
      updatedAt: "2026-08-19T00:30:00.000Z",
      stages: [{ id: "summary", status: "done" }],
      declared: {
        deep: ".work-state/features/hostile/artifacts/deep.json",
        many: ".work-state/features/hostile/artifacts/many.json",
        long: ".work-state/features/hostile/artifacts/long.json",
        crlf: ".work-state/features/hostile/artifacts/crlf.json",
      },
      files: [
        artifact("deep", ".work-state/features/hostile/artifacts/deep.json", DEEP_JSON_SAMPLE),
        artifact("many", ".work-state/features/hostile/artifacts/many.json", LARGE_COLLECTION_SAMPLE),
        artifact("long", ".work-state/features/hostile/artifacts/long.json", JSON.stringify({ text: LARGE_SCALAR_TEXT })),
        artifact("crlf", ".work-state/features/hostile/artifacts/crlf.json", JSON.stringify({ text: CRLF_SAMPLE })),
      ],
      expected: {
        status: "complete",
        staleness: "fresh",
        artifactStatuses: { deep: "produced", many: "produced", long: "produced", crlf: "produced" },
      },
    }),
  });

  // 16. unsafe ids and unsafe declared paths
  cases.push({
    id: "unsafe-ids-paths",
    title: "unsafe artifact ids → skipped; unsafe absolute/escaping declared paths → excluded from rendering",
    groups: ["unsafe-ids", "unsafe-paths", "missing", "skipped"],
    input: featureSession({
      id: "unsafe",
      pathKey: "unsafe",
      task: "Probe unsafe identifiers and absolute paths.",
      workflow: "standard",
      updatedAt: "2026-08-18T23:00:00.000Z",
      stages: [{ id: "implementation", status: "done" }],
      declared: {
        "../escape": "/tmp/escape.json",
        "a b": ".work-state/features/unsafe/artifacts/a b.json",
        ok_id: "/Users/alice/.work-state/features/unsafe/artifacts/ok.json",
        rel_ok: ".work-state/features/unsafe/artifacts/rel_ok.json",
      },
      files: [artifact("rel_ok", ".work-state/features/unsafe/artifacts/rel_ok.json", JSON.stringify({ note: "safe" }))],
      expected: {
        status: "complete",
        staleness: "fresh",
        artifactStatuses: {
          "../escape": "skipped",
          "a b": "skipped",
          ok_id: "missing",
          rel_ok: "produced",
        },
        warnings: [
          'artifact id "../escape" is not a safe path key: skipped',
          'artifact id "a b" is not a safe path key: skipped',
          'declared path for ok_id is not a safe relative path: excluded from rendering',
        ],
      },
    }),
  });

  // 17. zero artifacts
  const zeroInput = featureSession({
    id: "fresh",
    pathKey: "fresh",
    task: "A freshly started session with no artifacts yet.",
    workflow: "standard",
    updatedAt: "2026-08-18T22:00:00.000Z",
    stages: [{ id: "discovery", status: "in_progress" }],
    declared: {},
    expected: { status: "complete", staleness: "fresh", artifactStatuses: {}, warnings: ["no artifacts yet"] },
  });
  cases.push({
    id: "zero-artifacts",
    title: "session with zero declared and zero discovered artifacts: overview-only view",
    groups: ["zero-artifacts"],
    input: zeroInput,
  });

  // 18. excluded inputs
  cases.push({
    id: "excluded-inputs",
    title: "events.jsonl, vibe-report and prior generated output are never discovered",
    groups: ["excluded-inputs"],
    input: {
      kind: "feature",
      id: "noisy",
      pathKey: "noisy",
      state: {
        format: "json",
        content: featureStateJson({
          task: "Session with excluded inputs on disk.",
          workflow: "standard",
          runId: "noisy",
          updatedAt: "2026-08-18T21:00:00.000Z",
          stages: [{ id: "discovery", status: "done" }],
          artifacts: {},
        }),
        updatedAt: "2026-08-18T21:00:00.000Z",
      },
      workflow: "standard",
      declaredArtifacts: {},
      artifacts: [],
      excludedPaths: [
        ".work-state/features/noisy/events.jsonl",
        ".work-state/features/noisy/observability/events.jsonl",
        "vibe-report/noisy-2026-08-18.md",
        ".work-state/visualize/index.html",
        ".work-state/visualize/manifest.json",
        ".work-state/visualize/sessions/feature/noisy.md",
      ],
      expected: { status: "complete", staleness: "fresh", artifactStatuses: {} },
    },
  });

  // 19. BG-1 mtime invariance (raw pairs live in DIGEST_INVARIANCE_CASES / buildMtimePairs)
  const [mtimePair] = buildMtimePairs();
  if (mtimePair) {
    cases.push({
      id: "digest-mtime-invariance",
      title: "BG-1: identical content with different mtimes produces identical digests (touch-invariance)",
      groups: ["mtime-invariance", "determinism"],
      input: mtimePair.a,
    });
  }

  // 20. scope contract: selected is partial, --all is completeness mode
  cases.push({
    id: "scope-selected-all",
    title: "scope contract: selected manifest is visibly partial; --all is completeness mode",
    groups: ["scope-partial", "scope-all"],
    input: zeroInput,
  });

  return { schema: 1, cases, groups: buildGroups(cases) };
}

function buildGroups(cases: FixtureCase[]): Record<string, string[]> {
  const groups: Record<string, string[]> = {};
  for (const c of cases) {
    for (const g of c.groups) {
      const list = groups[g] ?? [];
      list.push(c.id);
      groups[g] = list;
    }
  }
  return groups;
}

// ── Golden expected sessions ─────────────────────────────────────────────────

/** Expected redacted/capped body for a fixture artifact (BG-1 bounded window). */
export function expectedRedactedBody(
  content: string,
  opts: { windowBytes?: number; capBytes?: number } = {},
): RedactedBody {
  const windowBytes = opts.windowBytes ?? DEFAULT_READ_WINDOW_BYTES;
  const capBytes = opts.capBytes ?? DEFAULT_BODY_CAP_BYTES;
  const originalBytes = Buffer.byteLength(content, "utf8");
  // No bytes beyond the bounded read window are ever embedded (BG-1).
  const head = content.slice(0, windowBytes);
  // An empty source is empty, not redacted: redactReportBody maps an empty
  // body to the [redacted] marker, which would mislabel a 0-byte file.
  const text = content === "" ? EMPTY_BODY_MARKER : redactReportBody(head, capBytes);
  const preview = originalBytes > windowBytes;
  const truncated = preview || originalBytes > capBytes;
  return {
    text: text === "" ? EMPTY_BODY_MARKER : text,
    truncated,
    originalBytes,
    capBytes,
    preview,
    marker: truncated ? formatTruncationMarker(originalBytes, capBytes) : "",
  };
}

function provenanceFor(
  input: CanonicalSessionInput,
  generatedAt: string,
  renderOptions: RenderOptions,
): VisualizationSession["provenance"] {
  const digest = digestFor(input, renderOptions.readWindowBytes);
  const sourceUpdatedAt = input.state.updatedAt;
  const staleness: Staleness =
    sourceUpdatedAt === undefined ? "unknown" : sourceUpdatedAt <= generatedAt ? "fresh" : "stale";
  return {
    sourceUpdatedAt,
    ...(input.profileHash ? { profileHash: input.profileHash } : {}),
    sourceDigest: digest,
    generatedAt,
    renderer: { name: "omp-workflows-visualize", version: "1.0.0" },
    staleness,
  };
}

function artifactCountsOf(artifacts: VisualizationArtifact[]): ArtifactCounts {
  const counts: ArtifactCounts = { produced: 0, missing: 0, pending: 0, skipped: 0, unreadable: 0 };
  for (const a of artifacts) counts[a.status] += 1;
  return counts;
}

/** Golden spec-preparation session (detailed policy, bodies enabled by default). */
export function buildExpectedSpecPreparationSession(generatedAt: string = FIXED_GENERATED_AT): VisualizationSession {
  const input = buildFixtureInventory().cases.find((c) => c.id === "feature-spec-preparation")?.input;
  if (!input) throw new Error("missing fixture: feature-spec-preparation");
  const renderOptions: RenderOptions = {
    full: false,
    bodyCapBytes: DEFAULT_BODY_CAP_BYTES,
    readWindowBytes: DEFAULT_READ_WINDOW_BYTES,
    bounds: { maxDepth: 8, maxCollectionItems: 200, maxScalarChars: 8192 },
  };
  const files = new Map(input.artifacts.map((f) => [f.id, f]));
  const artifactById = (id: string, status: ArtifactStatus, owner: string): VisualizationArtifact => {
    const file = files.get(id);
    const base: VisualizationArtifact = { id, owner, status };
    if (status === "produced" && file) {
      const bytes = Buffer.byteLength(file.content, "utf8");
      const body = expectedRedactedBody(file.content, { windowBytes: renderOptions.readWindowBytes, capBytes: renderOptions.bodyCapBytes });
      // keys/summary derive from the ORIGINAL parsed content (redaction drops
      // secret lines, so the redacted text is not parseable — by design).
      const parsed = parseJsonObject(file.content);
      return {
        ...base,
        source: {
          kind: "artifact",
          label: file.relPath,
          bytes,
          readBytes: Math.min(bytes, renderOptions.readWindowBytes),
          readWindowBytes: renderOptions.readWindowBytes,
          format: "json",
        },
        bytes,
        type: isTyped(id) ? id : undefined,
        keys: parsed?.keys,
        summary: parsed?.summary,
        body,
      };
    }
    return base;
  };

  const artifacts: VisualizationArtifact[] = [
    artifactById("spec_intake_repo_map", "produced", "intake_repo_map"),
    artifactById("spec_intake_repo_map-analyst", "produced", "intake_repo_map"),
    artifactById("spec_intake_repo_map-tech-researcher", "produced", "intake_repo_map"),
    artifactById("spec_requirements_edge_cases", "produced", "requirements_edge_cases"),
    artifactById("spec_options_decisions", "produced", "options_decision_log"),
    artifactById("spec_architecture_tasks", "produced", "architecture_task_slices"),
    artifactById("spec_completeness", "missing", "completeness_gate"),
    artifactById("spec-preparation", "produced", "handoff"),
    artifactById("spec_handoff", "produced", "handoff"),
  ];

  return {
    schema: 1,
    identity: {
      kind: "feature",
      id: "visualize",
      pathKey: "visualize",
      title: "visualize feature worktree",
      task: "Visualize workflow specs: readable overview + internal navigation.",
      workflow: "spec-preparation",
      sourceFormat: "json",
      isLegacy: false,
      degraded: false,
    },
    status: "complete",
    stages: [
      { stageId: "intake_repo_map", title: "Repository intake map", status: "done", artifactIds: ["spec_intake_repo_map", "spec_intake_repo_map-analyst", "spec_intake_repo_map-tech-researcher"] },
      { stageId: "requirements_edge_cases", title: "Requirements and edge cases", status: "done", artifactIds: ["spec_requirements_edge_cases"] },
      { stageId: "options_decision_log", title: "Options and decision log", status: "done", artifactIds: ["spec_options_decisions"] },
      { stageId: "architecture_task_slices", title: "Architecture and task slices", status: "done", artifactIds: ["spec_architecture_tasks"] },
      { stageId: "completeness_gate", title: "Completeness gate", status: "in_progress", artifactIds: ["spec_completeness"] },
      { stageId: "handoff", title: "Handoff", status: "in_progress", artifactIds: ["spec-preparation", "spec_handoff"] },
    ],
    artifacts,
    source: {
      kind: "state",
      label: ".work-state/features/visualize/state.json",
      bytes: Buffer.byteLength(input.state.content, "utf8"),
      readBytes: Buffer.byteLength(input.state.content, "utf8"),
      readWindowBytes: renderOptions.readWindowBytes,
      format: "json",
    },
    provenance: provenanceFor(input, generatedAt, renderOptions),
    warnings: input.expected.warnings ?? [],
  };
}

function isTyped(id: string): boolean {
  return (TYPED_ARTIFACT_IDS as readonly string[]).includes(id);
}

/** Parse original artifact content; returns top-level keys + bounded summary. */
function parseJsonObject(content: string): { keys?: string[]; summary?: string } | undefined {
  try {
    const parsed = JSON.parse(content) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    const record = parsed as Record<string, unknown>;
    const summary = record.summary !== undefined ? String(record.summary).slice(0, 8192) : undefined;
    return { keys: Object.keys(record), ...(summary !== undefined ? { summary } : {}) };
  } catch {
    return undefined; // corrupt/preview content never yields keys/summary
  }
}

/** Golden bug-fix session (compact policy, bodies disabled by default). */
export function buildExpectedBugFixSession(generatedAt: string = FIXED_GENERATED_AT): VisualizationSession {
  const input = buildFixtureInventory().cases.find((c) => c.id === "feature-bug-fix")?.input;
  if (!input) throw new Error("missing fixture: feature-bug-fix");
  const files = new Map(input.artifacts.map((f) => [f.id, f]));
  const renderOptions = defaultRenderOptionsFixture(false);
  const mk = (id: string, status: ArtifactStatus, owner: string): VisualizationArtifact => {
    const file = files.get(id);
    if (status === "produced" && file) {
      return {
        id,
        owner,
        status,
        source: {
          kind: "artifact",
          label: file.relPath,
          bytes: Buffer.byteLength(file.content, "utf8"),
          readBytes: Math.min(Buffer.byteLength(file.content, "utf8"), renderOptions.readWindowBytes),
          readWindowBytes: renderOptions.readWindowBytes,
          format: "json",
        },
        bytes: Buffer.byteLength(file.content, "utf8"),
        type: id,
        summary: `Summary of ${id}`,
      };
    }
    return { id, owner, status };
  };
  return {
    schema: 1,
    identity: {
      kind: "feature",
      id: "fix-regression-42",
      pathKey: "fix-regression-42",
      title: "bug-fix feature worktree",
      task: "Fix the flaky artifact contract test.",
      workflow: "bug-fix",
      sourceFormat: "json",
      isLegacy: false,
      degraded: false,
    },
    status: "complete",
    stages: [
      { stageId: "discovery", title: "Discovery", status: "done", artifactIds: ["discovery"] },
      { stageId: "diagnose", title: "Diagnose", status: "done", artifactIds: ["diagnosis", "dod"] },
      { stageId: "implementation", title: "Implementation", status: "done", artifactIds: ["implementation"] },
      { stageId: "review", title: "Review", status: "skipped", artifactIds: ["review"] },
      { stageId: "manual_qa", title: "Manual QA", status: "pending", artifactIds: ["manual_qa"] },
      { stageId: "summary", title: "Summary", status: "pending", artifactIds: ["summary"] },
    ],
    artifacts: [
      mk("discovery", "produced", "discovery"),
      mk("diagnosis", "produced", "diagnose"),
      mk("dod", "produced", "diagnose"),
      mk("implementation", "missing", "implementation"),
      mk("review", "skipped", "review"),
      mk("manual_qa", "pending", "manual_qa"),
      mk("summary", "pending", "summary"),
    ],
    source: {
      kind: "state",
      label: ".work-state/features/fix-regression-42/state.json",
      bytes: Buffer.byteLength(input.state.content, "utf8"),
      readBytes: Buffer.byteLength(input.state.content, "utf8"),
      readWindowBytes: renderOptions.readWindowBytes,
      format: "json",
    },
    provenance: provenanceFor(input, generatedAt, renderOptions),
    warnings: input.expected.warnings ?? [],
  };
}

/** Golden zero-artifact session: overview-only with a no-artifacts note. */
export function buildExpectedZeroArtifactSession(generatedAt: string = FIXED_GENERATED_AT): VisualizationSession {
  const input = buildFixtureInventory().cases.find((c) => c.id === "zero-artifacts")?.input;
  if (!input) throw new Error("missing fixture: zero-artifacts");
  const renderOptions = defaultRenderOptionsFixture(false);
  return {
    schema: 1,
    identity: {
      kind: "feature",
      id: "fresh",
      pathKey: "fresh",
      title: "fresh feature worktree",
      task: "A freshly started session with no artifacts yet.",
      workflow: "standard",
      sourceFormat: "json",
      isLegacy: false,
      degraded: false,
    },
    status: "complete",
    stages: [{ stageId: "discovery", title: "Discovery", status: "in_progress", artifactIds: [] }],
    artifacts: [],
    source: {
      kind: "state",
      label: ".work-state/features/fresh/state.json",
      bytes: Buffer.byteLength(input.state.content, "utf8"),
      readBytes: Buffer.byteLength(input.state.content, "utf8"),
      readWindowBytes: renderOptions.readWindowBytes,
      format: "json",
    },
    provenance: provenanceFor(input, generatedAt, renderOptions),
    warnings: input.expected.warnings ?? [],
  };
}

/** Golden terminal markdown CTO session: degraded projection. */
export function buildExpectedCtoMarkdownTerminalSession(generatedAt: string = FIXED_GENERATED_AT): VisualizationSession {
  const input = buildFixtureInventory().cases.find((c) => c.id === "cto-markdown-terminal")?.input;
  if (!input) throw new Error("missing fixture: cto-markdown-terminal");
  const renderOptions = defaultRenderOptionsFixture(false);
  return {
    schema: 1,
    identity: {
      kind: "cto",
      id: "cto-markdown-done",
      pathKey: "cto-markdown-done",
      title: "CTO run cto-markdown-done",
      task: "A finished markdown CTO run.",
      workflow: "cto",
      sourceFormat: "markdown",
      isLegacy: false,
      degraded: true,
    },
    status: "degraded",
    stages: [],
    artifacts: [],
    source: {
      kind: "state",
      label: ".work-state/cto/cto-markdown-done",
      bytes: Buffer.byteLength(input.state.content, "utf8"),
      readBytes: Buffer.byteLength(input.state.content, "utf8"),
      readWindowBytes: renderOptions.readWindowBytes,
      format: "markdown",
    },
    provenance: provenanceFor(input, generatedAt, renderOptions),
    warnings: [],
    degradedReasons: input.expected.degradedReasons ?? [],
  };
}

function defaultRenderOptionsFixture(full: boolean): RenderOptions {
  return full
    ? { full: true, bodyCapBytes: 256 * 1024, readWindowBytes: 256 * 1024, bounds: { maxDepth: 8, maxCollectionItems: 200, maxScalarChars: 8192 } }
    : { full: false, bodyCapBytes: DEFAULT_BODY_CAP_BYTES, readWindowBytes: DEFAULT_READ_WINDOW_BYTES, bounds: { maxDepth: 8, maxCollectionItems: 200, maxScalarChars: 8192 } };
}

function manifestEntryFor(session: VisualizationSession): VisualizationManifest["sessions"][number] {
  const counts = artifactCountsOf(session.artifacts);
  const stale = session.provenance.staleness === "stale";
  return {
    kind: session.identity.kind,
    id: session.identity.id,
    pathKey: session.identity.pathKey,
    title: session.identity.title,
    task: session.identity.task,
    workflow: session.identity.workflow,
    ...(session.provenance.sourceUpdatedAt ? { updatedAt: session.provenance.sourceUpdatedAt } : {}),
    sourceDigestBounded: session.provenance.sourceDigest.bounded,
    status: session.status,
    staleness: session.provenance.staleness,
    artifacts: counts,
    pages: [
      `sessions/${session.identity.kind}/${session.identity.pathKey}.md`,
      `sessions/${session.identity.kind}/${session.identity.pathKey}.html`,
    ],
    ...(stale ? { regenerateHint: "run the on-demand visualize command to regenerate stale output (source state is newer than the generated view)" } : {}),
  };
}

/** Golden complete snapshot (`--all`): deterministic sessions + manifest. */
export function buildGoldenAllSnapshot(generatedAt: string = FIXED_GENERATED_AT): VisualizationSnapshot {
  const sessions: VisualizationSession[] = [
    buildExpectedSpecPreparationSession(generatedAt),
    buildExpectedBugFixSession(generatedAt),
    buildExpectedZeroArtifactSession(generatedAt),
    buildExpectedCtoMarkdownTerminalSession(generatedAt),
  ];
  const manifest: VisualizationManifest = {
    schema: 1,
    scope: "all",
    generatedAt,
    renderer: { name: "omp-workflows-visualize", version: "1.0.0" },
    sessions: sessions.map(manifestEntryFor),
    counts: {
      discoveredSessions: sessions.length,
      generatedSessions: sessions.length,
      generatedPages: sessions.length * 2 + 2, // session md+html + hub md+html
      staleSessions: sessions.filter((s) => s.provenance.staleness === "stale").length,
      degradedSessions: sessions.filter((s) => s.status === "degraded").length,
      artifactTotal: sessions.reduce((n, s) => n + s.artifacts.length, 0),
      deadLinks: 0,
    },
  };
  return {
    schema: 1,
    scope: "all",
    generatedAt,
    renderer: { name: "omp-workflows-visualize", version: "1.0.0" },
    sessions,
    manifest,
    warnings: [],
  };
}

/** Golden selected-scope manifest: visibly partial (selected/latest rule). */
export function buildSelectedManifest(generatedAt: string = FIXED_GENERATED_AT): VisualizationManifest {
  const session = buildExpectedSpecPreparationSession(generatedAt);
  return {
    schema: 1,
    scope: "selected",
    generatedAt,
    renderer: { name: "omp-workflows-visualize", version: "1.0.0" },
    sessions: [manifestEntryFor(session)],
    counts: {
      discoveredSessions: 1,
      generatedSessions: 1,
      generatedPages: 1 * 2 + 2,
      staleSessions: 0,
      degradedSessions: 0,
      artifactTotal: session.artifacts.length,
      deadLinks: 0,
    },
  };
}
