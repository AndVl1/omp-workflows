/* <!-- omp-cto-slice run=01a03ee4-7dd6-7580-8ad7-16d26dc886ba slice=workflow-v2-fullstack --> */

/**
 * /workflow-view — on-demand workflow visualization bundle (visualize OPT-A).
 *
 * Renders the workflow specification view as a self-contained offline bundle
 * under `.work-state/visualize` (hub Markdown/HTML, manifest.json, and one
 * Markdown+HTML page per session):
 *
 *   /workflow-view [do-work|cto|legacy] [id=<slug|runId>] [--all] [--full]
 *
 *   bare            latest discoverable session (feature/legacy/CTO)
 *   do-work         latest do-work session (feature or legacy)
 *   cto             latest CTO run
 *   legacy          the legacy root session (team-state.json)
 *   id=<slug|runId> pick a specific session id (unsafe ids are rejected)
 *   --all           complete view: every discoverable session
 *   --full          embed redacted full artifact bodies (bounded caps)
 *
 * Selection modes (frozen contract): `selected`/`latest` renders ONE session
 * and a visibly PARTIAL hub; `--all` is the completeness mode. `--all` is
 * mutually exclusive with `id=`. At most one selector kind, one id, one
 * `--all` and one `--full` are accepted; duplicate/unknown/unsafe arguments
 * return `ERROR:` plus usage and write nothing.
 *
 * The command is a thin orchestration shell over the core visualize APIs:
 * `listSessions` (discovery) → `buildSessionSnapshots` (one-read normalized
 * model, redaction/caps) → `buildManifest` (deterministic manifest) →
 * Markdown/HTML serializers (pure projections) → `preflightLinks`
 * (fresh-output zero-dead-link gate) → `publishVisualize` (whole-tree
 * atomic swap, 0600, boundary checks). It never hooks engine transitions,
 * never dispatches agents, never reads excluded inputs (events.jsonl,
 * vibe-report, prior visualize output) and never mutates canonical state.
 *
 * Status output is safe by construction: relative paths and counts only —
 * never absolute paths, raw OS/parser errors, secrets or bodies.
 */

import type { CustomCommand, CustomCommandAPI } from "@oh-my-pi/pi-coding-agent/extensibility/custom-commands/types";
import type { HookCommandContext } from "@oh-my-pi/pi-coding-agent/extensibility/hooks/types";
import {
  DEFAULT_RENDERER_IDENTITY,
  REGENERATE_HINT,
  VISUALIZE_OUTPUT_FILES,
  VISUALIZE_OUTPUT_ROOT,
  VisualizePublishError,
  buildManifest,
  buildSessionSnapshots,
  createReportStorageAuthority,
  isCanonicalRoot,
  isReportTreeStorageAuthority,
  isSafePathKey,
  listSessions,
  preflightLinks,
  publishVisualize,
  renderHubHtml,
  renderHubMarkdown,
  renderSessionHtml,
  renderSessionMarkdown,
  sessionPagePath,
  validateProjectIdentity,
  validateProviderCatalog,
  validateWorkflowRunIdentity,
  type BuildSessionSnapshotContext,
  type ReportStorageOperations,
  type ReportTreeStorageAuthority,
  type SessionSourceEntry,
  type VisualizeBundleFile,
  type VisualizePublishResult,
  type VisualizationScope,
  type VisualizationSession,
  type VisualizationSnapshot,
  type WorkflowRunIdentity,
} from "@andvl1/omp-workflows-core";
import {
  isFullstackStorageAuthority,
  isFullstackTreeStorageAuthority,
  type FullstackStorageAuthority,
} from "@andvl1/omp-workflows-fullstack";

/** Selector kinds understood by the command (frozen grammar). */
export type WorkflowViewKind = "do-work" | "cto";

export interface WorkflowViewSelector {
  kind?: WorkflowViewKind;
  id?: string;
  /** --all: completeness mode; mutually exclusive with id=. */
  all?: boolean;
}

export interface WorkflowViewOptions {
  /** --full: redacted full artifact bodies with bounded caps. */
  full?: boolean;
}

export interface ParsedWorkflowViewArgs {
  selector: WorkflowViewSelector;
  options: WorkflowViewOptions;
  error?: string;
}

/**
 * Parse `/workflow-view [do-work|cto] [id=<slug|runId>] [--all] [--full]`.
 * Accepts at most one kind, one id, one `--all` and one `--full`; duplicate,
 * unknown, empty or unsafe tokens return an error string (with usage handled
 * by the caller). `--all` combined with `id=` is rejected.
 */
export function parseWorkflowViewArgs(args: string[]): ParsedWorkflowViewArgs {
  const selector: WorkflowViewSelector = {};
  const options: WorkflowViewOptions = {};
  for (const token of args) {
    if (token.trim() === "") continue;
    if (token === "--all") {
      if (selector.all !== undefined) return { selector, options, error: "duplicate --all" };
      selector.all = true;
      continue;
    }
    if (token === "--full") {
      if (options.full !== undefined) return { selector, options, error: "duplicate --full" };
      options.full = true;
      continue;
    }
    if (token === "do-work" || token === "cto") {
      if (selector.kind !== undefined) {
        return { selector, options, error: `duplicate session kind: ${token}` };
      }
      selector.kind = token;
      continue;
    }
    const idMatch = /^id=(.*)$/.exec(token);
    if (idMatch) {
      const id = idMatch[1]!.trim();
      if (!id) return { selector, options, error: "empty id= value" };
      if (selector.id !== undefined) return { selector, options, error: `duplicate id: ${token}` };
      if (!isSafePathKey(id)) return { selector, options, error: `unsafe id: ${id}` };
      if (id === "legacy") return { selector, options, error: "legacy workflow sessions are not supported" };
      selector.id = id;
      continue;
    }
    return { selector, options, error: `unknown argument: ${token}` };
  }
  if (selector.all !== undefined && selector.id !== undefined) {
    return { selector, options, error: "--all is mutually exclusive with id=" };
  }
  return { selector, options };
}

const USAGE = [
  "Usage: /workflow-view [do-work|cto] [id=<slug|runId>] [--all] [--full]",
  "",
  "  (bare)      latest discoverable workflow session (partial view)",
  "  do-work     latest do-work session (feature)",
  "  cto         latest CTO run",
  "  id=<...>    pick a specific session id",
  "  --all       complete view: every discoverable session",
  "  --full      embed redacted full artifact bodies (bounded caps)",
  "",
  "Writes a self-contained offline view (index.md, index.html, manifest.json +",
  "session pages) under .work-state/visualize.",
].join("\n");

/** Safe kind label of one discovered source entry (feature/cto). */
function displayKindOf(entry: SessionSourceEntry): "feature" | "cto" {
  if (entry.kind === "cto") return "cto";
  return "feature";
}

/** Exclude migration-only source layouts from the provider command surface. */
function isSupportedSession(entry: SessionSourceEntry): boolean {
  return !(entry.kind === "do-work" && entry.isLegacy);
}

/** Whether an entry matches the requested selector kind. */
function matchesKind(kind: WorkflowViewKind, entry: SessionSourceEntry): boolean {
  if (kind === "cto") return entry.kind === "cto";
  return entry.kind === "do-work";
}

/** Discoverable sessions as safe `kind/id` labels (E-2 error listing). */
function discoverableLabels(entries: readonly SessionSourceEntry[]): string {
  return entries.map((e) => `${displayKindOf(e)}/${e.id}`).join(", ");
}

interface Selection {
  entries: SessionSourceEntry[];
  scope: VisualizationScope;
  error?: string;
}

/**
 * Resolve the selector against supported discovered sessions (deterministic
 * order from `listSessions`). latest = first in total order; `--all` = every
 * supported session (optionally of one kind). Unknown ids return an error
 * listing supported ids; empty workspaces error (E-1).
 */
export function selectWorkflowSessions(entries: SessionSourceEntry[], selector: WorkflowViewSelector): Selection {
  const supportedEntries = entries.filter(isSupportedSession);
  const requestedKind = selector.kind as string | undefined;
  if (requestedKind === "legacy") {
    return { entries: [], scope: "selected", error: "legacy workflow sessions are not supported" };
  }
  if (selector.id === "legacy") {
    return { entries: [], scope: "selected", error: "legacy workflow sessions are not supported" };
  }
  const applyKind = (list: SessionSourceEntry[]): SessionSourceEntry[] =>
    selector.kind === undefined ? list : list.filter((e) => matchesKind(selector.kind!, e));

  if (selector.all !== undefined) {
    return { entries: applyKind(supportedEntries), scope: "all" };
  }
  if (selector.id !== undefined) {
    const matches = supportedEntries.filter((e) => e.id === selector.id && (selector.kind === undefined || matchesKind(selector.kind, e)));
    if (matches.length === 0) {
      const kindPart = selector.kind === undefined ? "" : ` (kind ${selector.kind})`;
      const listed = supportedEntries.length > 0 ? `; discoverable sessions: ${discoverableLabels(supportedEntries)}` : "";
      return { entries: [], scope: "selected", error: `session not found: ${selector.id}${kindPart}${listed}` };
    }
    return { entries: matches.slice(0, 1), scope: "selected" };
  }
  if (selector.kind !== undefined) {
    const matches = applyKind(supportedEntries);
    if (matches.length === 0) {
      return { entries: [], scope: "selected", error: `no ${selector.kind} session found under .work-state` };
    }
    return { entries: matches.slice(0, 1), scope: "selected" };
  }
  if (supportedEntries.length === 0) {
    return { entries: [], scope: "selected", error: "no workflow sessions found under .work-state (nothing to visualize)" };
  }
  return { entries: supportedEntries.slice(0, 1), scope: "selected" };
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

/**
 * Concise status returned to the main agent after a successful publish.
 * Safe by contract: relative paths and deterministic counts only — never
 * absolute paths, bodies, secrets or raw errors.
 */
export function formatWorkflowViewStatus(snapshot: VisualizationSnapshot, result: VisualizePublishResult): string {
  const counts = snapshot.manifest.counts;
  const scopeLabel = snapshot.scope === "all" ? "all sessions (complete)" : "selected/latest (partial)";
  const sessionWarnings = snapshot.sessions.reduce((n, s) => n + s.warnings.length, 0);
  const warnings = sessionWarnings + result.warnings.length;
  const sessionPageCount = snapshot.sessions.length * 2;
  const lines = [
    `Workflow view written: ${VISUALIZE_OUTPUT_ROOT}`,
    `${scopeLabel} — ${plural(counts.generatedSessions, "session")} generated (${counts.discoveredSessions} discovered) · ${plural(counts.artifactTotal, "artifact")} · ${plural(counts.degradedSessions, "degraded")} · ${plural(warnings, "warning")}`,
    `Pages: ${VISUALIZE_OUTPUT_FILES.hubMarkdown} · ${VISUALIZE_OUTPUT_FILES.hubHtml} · ${VISUALIZE_OUTPUT_FILES.manifest} (+ ${plural(sessionPageCount, "session page")})`,
  ];
  if (counts.staleSessions > 0) lines.push(`stale (${counts.staleSessions}): ${REGENERATE_HINT}`);
  lines.push("Open .work-state/visualize/index.html in a browser to view the bundle.");
  return lines.join("\n");
}

type WorkflowViewCommandContext = HookCommandContext & {
  readonly project_identity?: BuildSessionSnapshotContext["project_identity"] | null;
  readonly catalog?: BuildSessionSnapshotContext["catalog"] | null;
  readonly effective_policy?: BuildSessionSnapshotContext["effective_policy"] | null;
  readonly run_identity?: WorkflowRunIdentity | null;
  readonly storage_authority?: FullstackStorageAuthority | null;
};

type AdmissionFailureCode = "CAPABILITY_MISSING" | "MIGRATION_REQUIRED" | "IDENTITY_MISMATCH";

type AdmissionFailure = {
  readonly ok: false;
  readonly code: AdmissionFailureCode;
  readonly message: string;
};

type ContextAdmission =
  | {
    readonly ok: true;
    readonly project_identity: BuildSessionSnapshotContext["project_identity"];
    readonly catalog: BuildSessionSnapshotContext["catalog"];
    readonly effective_policy?: BuildSessionSnapshotContext["effective_policy"];
    readonly run_identity?: WorkflowRunIdentity;
  }
  | AdmissionFailure;

type StorageAdmission =
  | {
    readonly ok: true;
    readonly report_storage: ReportTreeStorageAuthority;
  }
  | AdmissionFailure;

function admissionFailure(code: AdmissionFailureCode, message: string): AdmissionFailure {
  return { ok: false, code, message };
}

function sameProjectIdentity(
  left: BuildSessionSnapshotContext["project_identity"],
  right: BuildSessionSnapshotContext["project_identity"],
): boolean {
  return left.root_instance_id === right.root_instance_id
    && left.provider_id === right.provider_id
    && left.descriptor_fingerprint === right.descriptor_fingerprint
    && left.executable_provenance.build_fingerprint === right.executable_provenance.build_fingerprint
    && left.executable_provenance.runtime_fingerprint === right.executable_provenance.runtime_fingerprint
    && left.catalog_content_digest === right.catalog_content_digest
    && left.config_byte_sha256 === right.config_byte_sha256
    && left.config_semantic_sha256 === right.config_semantic_sha256
    && left.session.session_id === right.session.session_id
    && left.session.lifecycle_id === right.session.lifecycle_id;
}

function sameWorkflowRunIdentity(left: WorkflowRunIdentity, right: WorkflowRunIdentity): boolean {
  return left.run_id === right.run_id
    && left.profile_identity.id === right.profile_identity.id
    && left.profile_identity.fingerprint === right.profile_identity.fingerprint
    && sameProjectIdentity(left, right);
}

/**
 * Validate manager-provided visualization context without touching report
 * storage. Core repeats these checks while constructing snapshots, but this
 * admission gate must run before discovery so missing/foreign context cannot
 * trigger report I/O.
 */
function validateVisualizationContext(context: WorkflowViewCommandContext): ContextAdmission {
  const projectCandidate = context.project_identity;
  const catalogCandidate = context.catalog;
  if (projectCandidate === undefined || projectCandidate === null || catalogCandidate === undefined || catalogCandidate === null) {
    return admissionFailure(
      "MIGRATION_REQUIRED",
      "workflow-view requires the admitted project identity and immutable provider catalog.",
    );
  }

  const project = validateProjectIdentity(projectCandidate);
  if (!project.ok) {
    return admissionFailure(
      "MIGRATION_REQUIRED",
      "workflow-view requires a complete validated project identity.",
    );
  }
  const catalog = validateProviderCatalog(catalogCandidate);
  if (!catalog.ok) {
    return admissionFailure(
      "MIGRATION_REQUIRED",
      "workflow-view requires the immutable provider catalog selected by the manager.",
    );
  }
  if (project.value.catalog_content_digest !== catalog.value.content_digest) {
    return admissionFailure(
      "IDENTITY_MISMATCH",
      "workflow-view catalog does not match the admitted project identity.",
    );
  }

  let runIdentity: WorkflowRunIdentity | undefined;
  if (context.run_identity !== undefined && context.run_identity !== null) {
    const run = validateWorkflowRunIdentity(context.run_identity);
    if (!run.ok) {
      return admissionFailure(
        "IDENTITY_MISMATCH",
        "workflow-view requires a complete admitted workflow run identity.",
      );
    }
    if (!sameProjectIdentity(run.value, project.value)) {
      return admissionFailure(
        "IDENTITY_MISMATCH",
        "workflow-view run identity does not match the admitted project identity.",
      );
    }
    runIdentity = run.value;
  }

  return {
    ok: true,
    project_identity: project.value,
    catalog: catalog.value,
    ...(context.effective_policy === undefined || context.effective_policy === null
      ? {}
      : { effective_policy: context.effective_policy }),
    ...(runIdentity === undefined ? {} : { run_identity: runIdentity }),
  };
}

/**
 * Admit one launcher-issued FullstackStorageAuthority and adapt it exactly
 * once to core's report storage contract. The optional whole-tree primitive is
 * forwarded only when the fullstack authority explicitly exposes it; a
 * generic authority therefore fails closed before list/snapshot/publish.
 */
function validateStorageAuthority(
  value: FullstackStorageAuthority | null | undefined,
  expectedProject: BuildSessionSnapshotContext["project_identity"],
  expectedRun: WorkflowRunIdentity | undefined,
  metadataRoot: string | undefined,
): StorageAdmission {
  if (value === undefined || value === null || !isFullstackStorageAuthority(value)) {
    return admissionFailure(
      "MIGRATION_REQUIRED",
      "workflow-view requires the host-issued descriptor-relative storage authority.",
    );
  }
  if (!isCanonicalRoot(value.project_root)) {
    return admissionFailure(
      "MIGRATION_REQUIRED",
      "workflow-view storage authority does not expose a canonical project root.",
    );
  }
  if (metadataRoot !== undefined && metadataRoot !== value.project_root) {
    return admissionFailure(
      "IDENTITY_MISMATCH",
      "workflow-view storage authority belongs to another canonical project root.",
    );
  }

  const storageRun = validateWorkflowRunIdentity(value.run_identity);
  if (!storageRun.ok || !sameProjectIdentity(storageRun.value, expectedProject)) {
    return admissionFailure(
      "IDENTITY_MISMATCH",
      "workflow-view storage authority does not belong to the admitted project identity.",
    );
  }
  if (expectedRun !== undefined && !sameWorkflowRunIdentity(storageRun.value, expectedRun)) {
    return admissionFailure(
      "IDENTITY_MISMATCH",
      "workflow-view storage authority belongs to another workflow run.",
    );
  }

  const genericOperations: ReportStorageOperations = {
    readBounded: value.readBounded.bind(value),
    readTextBounded: value.readTextBounded.bind(value),
    listBounded: value.listBounded.bind(value),
    statBounded: value.statBounded.bind(value),
    writeExclusive: value.writeExclusive.bind(value),
    writeAtomic: value.writeAtomic.bind(value),
  };

  try {
    const adapted = isFullstackTreeStorageAuthority(value)
      ? createReportStorageAuthority({
        ...genericOperations,
        replaceTreeAtomic: value.replaceTreeAtomic.bind(value),
      })
      : createReportStorageAuthority(genericOperations);
    if (!isReportTreeStorageAuthority(adapted)) {
      return admissionFailure(
        "CAPABILITY_MISSING",
        "workflow-view requires the optional whole-tree atomic storage capability.",
      );
    }
    return { ok: true, report_storage: adapted };
  } catch {
    return admissionFailure(
      "MIGRATION_REQUIRED",
      "workflow-view storage authority does not expose the complete bounded report storage contract.",
    );
  }
}


const factory = (_api: CustomCommandAPI): CustomCommand => ({
  name: "workflow-view",
  description:
    "Render the workflow specification view as a self-contained offline bundle under .work-state/visualize. /workflow-view [do-work|cto] [id=<slug|runId>] [--all] [--full]",
  async execute(args: string[], ctx: HookCommandContext): Promise<string> {
    const commandContext: WorkflowViewCommandContext = ctx;
    const contextAdmission = validateVisualizationContext(commandContext);
    if (!contextAdmission.ok) return `ERROR: ${contextAdmission.code} — ${contextAdmission.message}`;

    const storageAdmission = validateStorageAuthority(
      commandContext.storage_authority,
      contextAdmission.project_identity,
      contextAdmission.run_identity,
      commandContext.cwd,
    );
    if (!storageAdmission.ok) return `ERROR: ${storageAdmission.code} — ${storageAdmission.message}`;

    const visualizationContext: BuildSessionSnapshotContext = {
      project_identity: contextAdmission.project_identity,
      catalog: contextAdmission.catalog,
      ...(contextAdmission.effective_policy === undefined
        ? {}
        : { effective_policy: contextAdmission.effective_policy }),
    };

    const parsed = parseWorkflowViewArgs(args);
    if (parsed.error) return `ERROR: ${parsed.error}\n\n${USAGE}`;

    let discovered: SessionSourceEntry[];
    try {
      discovered = listSessions(storageAdmission.report_storage).filter(isSupportedSession);
    } catch {
      return "ERROR: could not discover workflow sessions: unexpected storage failure\n\n" + USAGE;
    }
    const selection = selectWorkflowSessions(discovered, parsed.selector);
    if (selection.error) return `ERROR: ${selection.error}\n\n${USAGE}`;
    if (selection.entries.length === 0) {
      return "ERROR: no workflow sessions found under .work-state (nothing to visualize)\n\n" + USAGE;
    }

    const generatedAt = new Date().toISOString();
    let sessions: VisualizationSession[];
    try {
      sessions = buildSessionSnapshots(storageAdmission.report_storage, selection.entries, generatedAt, {
        full: parsed.options.full,
        context: visualizationContext,
      });
    } catch {
      // Snapshot building degrades per session by contract; an unexpected
      // whole-build throw is surfaced as a category-only error (never raw).
      return "ERROR: could not build the workflow view: unexpected build failure\n\n" + USAGE;
    }
    if (sessions.length === 0) {
      return "ERROR: no workflow sessions found under .work-state (nothing to visualize)\n\n" + USAGE;
    }

    // F2: in selected/latest scope the hub metadata must report the TOTAL
    // discovered count (not the number of selected entries) so the bundle is
    // honestly partial; generatedSessions stays the selected count. --all
    // generates every discovered session in scope, so discovered == generated
    // there and selection.entries.length remains the correct value.
    const manifest = buildManifest(sessions, selection.scope, {
      generatedAt,
      discoveredSessions: selection.scope === "all" ? selection.entries.length : discovered.length,
    });
    const snapshot: VisualizationSnapshot = {
      schema: 1,
      scope: selection.scope,
      generatedAt,
      renderer: DEFAULT_RENDERER_IDENTITY,
      sessions,
      manifest,
      warnings: [],
    };

    const hubMarkdown = renderHubMarkdown(snapshot);
    const hubHtml = renderHubHtml(snapshot);
    const files: VisualizeBundleFile[] = [
      { relPath: VISUALIZE_OUTPUT_FILES.hubMarkdown, content: hubMarkdown },
      { relPath: VISUALIZE_OUTPUT_FILES.hubHtml, content: hubHtml },
      { relPath: VISUALIZE_OUTPUT_FILES.manifest, content: `${JSON.stringify(manifest, null, 2)}\n` },
    ];
    const htmlPages: Record<string, string> = { [VISUALIZE_OUTPUT_FILES.hubHtml]: hubHtml };
    for (const session of sessions) {
      const mdPath = sessionPagePath(session.identity.kind, session.identity.pathKey, "md");
      const htmlPath = sessionPagePath(session.identity.kind, session.identity.pathKey, "html");
      const md = renderSessionMarkdown(session, { full: parsed.options.full });
      const html = renderSessionHtml(session, { scope: selection.scope });
      files.push({ relPath: mdPath, content: md }, { relPath: htmlPath, content: html });
      htmlPages[htmlPath] = html;
    }

    // Fresh-output link gate: zero dead internal links before any write.
    const preflight = preflightLinks(htmlPages);
    if (preflight.deadLinks.length > 0) {
      return `ERROR: workflow view link preflight failed (${preflight.deadLinks.length} dead link(s)); nothing written.`;
    }

    let result: VisualizePublishResult;
    try {
      result = publishVisualize(storageAdmission.report_storage, files);
    } catch (err) {
      const message = err instanceof VisualizePublishError ? err.message : "publish failed";
      return `ERROR: could not write workflow view: ${message}`;
    }

    ctx.ui?.notify?.(
      `workflow-view: ${selection.scope === "all" ? "all" : "selected/latest"} — ${sessions.length} session(s) → ${VISUALIZE_OUTPUT_ROOT}`,
      "info",
    );
    return formatWorkflowViewStatus(snapshot, result);
  },
});

export default factory;
