/**
 * /workflow-view — on-demand workflow visualization bundle (visualize OPT-A).
 *
 * Renders the workflow specification view as a self-contained offline bundle
 * under `.work-state/visualize` (hub Markdown/HTML, manifest.json, and one
 * Markdown+HTML page per session).
 *
 * Ordinary workflow state is addressed only by an explicit canonical run id
 * and optional revision. CTO state is a separate namespace: an exact
 * `cto id=<id>` or `cto --all` request is allowed, while a bare CTO request
 * never guesses the newest run. Legacy feature/session readers are not used.
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
  isSafePathKey,
  listCanonicalRunSources,
  listCtoSources,
  preflightLinks,
  publishVisualize,
  renderHubHtml,
  renderHubMarkdown,
  renderSessionHtml,
  renderSessionMarkdown,
  resolveCanonicalRunSource,
  resolveCtoSource,
  sessionPagePath,
  type CanonicalRunReportListEntry,
  type CanonicalRunReportSource,
  type CtoSessionSource,
  type VisualizeBundleFile,
  type VisualizePublishResult,
  type VisualizationScope,
  type VisualizationSession,
  type VisualizationSnapshot,
} from "@andvl1/omp-workflows-core";

/** Selector kinds understood by the command. */
export type WorkflowViewKind = "do-work" | "cto" | "legacy";

export interface WorkflowViewSelector {
  kind?: WorkflowViewKind;
  id?: string;
  revision?: string;
  /** --all: completeness mode; mutually exclusive with id=/revision=. */
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
 * Parse `/workflow-view [do-work|cto|legacy] [id=<runId>] [revision=<id>] [--all] [--full]`.
 * Empty, duplicate, unknown and unsafe tokens are rejected before any read or
 * write. A revision is an ordinary canonical-run selector and cannot be used
 * with `--all`.
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
    if (token === "do-work" || token === "cto" || token === "legacy") {
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
      selector.id = id;
      continue;
    }
    const revisionMatch = /^revision=(.*)$/.exec(token);
    if (revisionMatch) {
      const revision = revisionMatch[1]!.trim();
      if (!revision) return { selector, options, error: "empty revision= value" };
      if (selector.revision !== undefined) return { selector, options, error: `duplicate revision: ${token}` };
      if (!isSafePathKey(revision)) return { selector, options, error: `unsafe revision: ${revision}` };
      selector.revision = revision;
      continue;
    }
    return { selector, options, error: `unknown argument: ${token}` };
  }
  if (selector.all !== undefined && selector.id !== undefined) {
    return { selector, options, error: "--all is mutually exclusive with id=" };
  }
  if (selector.all !== undefined && selector.revision !== undefined) {
    return { selector, options, error: "--all is mutually exclusive with revision=" };
  }
  return { selector, options };
}

const USAGE = [
  "Usage: /workflow-view [do-work|cto] [id=<runId>] [revision=<revisionId>] [--all] [--full]",
  "",
  "  do-work id=<runId>  one canonical ordinary run (optional revision=)",
  "  cto id=<runId>      one exact CTO JSON run",
  "  cto --all           deterministic list of exact CTO JSON runs",
  "  --all               complete canonical-run/CTO list snapshot",
  "  --full              embed redacted full artifact bodies (bounded caps)",
  "",
  "Legacy ordinary state is import-only and cannot be rendered at runtime.",
  "Writes a self-contained offline view under .work-state/visualize.",
].join("\n");

const CANONICAL_RUN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
type WorkflowViewEntry = CanonicalRunReportListEntry | CanonicalRunReportSource | CtoSessionSource;
type WorkflowViewSource = CanonicalRunReportSource | CtoSessionSource;

function entryId(entry: WorkflowViewEntry): string {
  return entry.kind === "run" ? entry.run_id : entry.id;
}

function displayKindOf(entry: WorkflowViewEntry): "feature" | "cto" {
  return entry.kind === "cto" ? "cto" : "feature";
}

function matchesKind(kind: WorkflowViewKind, entry: WorkflowViewEntry): boolean {
  if (kind === "cto") return entry.kind === "cto";
  if (kind === "legacy") return false;
  return entry.kind === "run";
}

/** Discoverable sessions as safe `kind/id` labels for selector errors. */
function discoverableLabels(entries: readonly WorkflowViewEntry[]): string {
  return entries.map((entry) => `${displayKindOf(entry)}/${entryId(entry)}`).join(", ");
}

interface Selection {
  entries: WorkflowViewEntry[];
  scope: VisualizationScope;
  error?: string;
  errorCode?: "migration_required" | "canonical-unavailable";
}

/**
 * Resolve only explicit ids or an explicit list snapshot. There is no latest,
 * active-feature, slug or filesystem-order fallback in this helper.
 */
export function selectWorkflowSessions(entries: WorkflowViewEntry[], selector: WorkflowViewSelector): Selection {
  const applyKind = (list: WorkflowViewEntry[]): WorkflowViewEntry[] =>
    selector.kind === undefined ? list : list.filter((entry) => matchesKind(selector.kind!, entry));

  if (selector.kind === "legacy") {
    return {
      entries: [],
      scope: "selected",
      error: "legacy workflow state is import-only; select its canonical run before using workflow-view",
      errorCode: "migration_required",
    };
  }
  if (selector.all !== undefined) {
    const selected = applyKind(entries);
    if (selected.length === 0) {
      return {
        entries: [],
        scope: "all",
        error: selector.kind === "cto" ? "no exact CTO runs are available for workflow-view" : "no canonical ordinary runs are available for workflow-view",
        errorCode: "migration_required",
      };
    }
    return { entries: selected, scope: "all" };
  }
  if (selector.id !== undefined) {
    const matches = entries.filter((entry) => entryId(entry) === selector.id && (selector.kind === undefined || matchesKind(selector.kind, entry)));
    if (matches.length === 0) {
      const kindPart = selector.kind === undefined ? "" : ` (kind ${selector.kind})`;
      const listed = entries.length > 0 ? `; available: ${discoverableLabels(entries)}` : "";
      return {
        entries: [],
        scope: "selected",
        error: `explicit session '${selector.id}' was not found${kindPart}${listed}`,
        errorCode: selector.kind === "cto" ? "canonical-unavailable" : "migration_required",
      };
    }
    return { entries: matches.slice(0, 1), scope: "selected" };
  }

  return {
    entries: [],
    scope: "selected",
    error: selector.kind === "cto"
      ? "CTO workflow-view requires an explicit id=<runId> or --all; latest selection is unavailable"
      : "workflow-view requires an explicit canonical run id or --all; legacy/latest selection is unavailable",
    errorCode: selector.kind === "cto" ? "canonical-unavailable" : "migration_required",
  };
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
  const sessionWarnings = snapshot.sessions.reduce((n, session) => n + session.warnings.length, 0);
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

function migrationError(message: string): string {
  return `ERROR [migration_required]: ${message}\n\n${USAGE}`;
}

function canonicalUnavailable(message: string): string {
  return `ERROR [canonical-unavailable]: ${message}\n\n${USAGE}`;
}

function resolveCanonicalEntries(cwd: string, revision: string | undefined): WorkflowViewSource[] {
  const entries = listCanonicalRunSources(cwd);
  return entries.map((entry) => resolveCanonicalRunSource(cwd, {
    run_id: entry.run_id,
    ...(revision ? { revision_id: revision } : {}),
  }));
}

function explicitCanonicalSource(cwd: string, id: string, revision: string | undefined): CanonicalRunReportSource | null {
  if (!CANONICAL_RUN_ID.test(id)) return null;
  try {
    return resolveCanonicalRunSource(cwd, { run_id: id, ...(revision ? { revision_id: revision } : {}) });
  } catch {
    return null;
  }
}

function sourceEntriesForRequest(cwd: string, selector: WorkflowViewSelector): { entries: WorkflowViewSource[]; error?: string } {
  if (selector.kind === "legacy") return { entries: [], error: migrationError("legacy workflow state is import-only; select its canonical run before using workflow-view.") };
  if (selector.all !== undefined) {
    if (selector.revision !== undefined) return { entries: [], error: migrationError("revision= requires one explicit canonical run id; it cannot be combined with --all.") };
    try {
      if (selector.kind === "cto") return { entries: listCtoSources(cwd) };
      if (selector.kind === "do-work") return { entries: resolveCanonicalEntries(cwd, undefined) };
      return { entries: [...resolveCanonicalEntries(cwd, undefined), ...listCtoSources(cwd)] };
    } catch {
      return { entries: [], error: canonicalUnavailable("the requested canonical list snapshot is unavailable") };
    }
  }
  if (selector.id === undefined) {
    return {
      entries: [],
      error: selector.kind === "cto"
        ? canonicalUnavailable("CTO workflow-view requires an explicit id=<runId> or --all; latest selection is unavailable")
        : migrationError("workflow-view requires an explicit canonical run id or --all; legacy/latest selection is unavailable"),
    };
  }
  if (selector.kind === "cto") {
    if (selector.revision !== undefined) return { entries: [], error: canonicalUnavailable("revision= is only valid for canonical ordinary runs") };
    const source = resolveCtoSource(cwd, selector.id);
    return source ? { entries: [source] } : { entries: [], error: canonicalUnavailable(`exact CTO run '${selector.id}' was not found`) };
  }
  const source = explicitCanonicalSource(cwd, selector.id, selector.revision);
  return source
    ? { entries: [source] }
    : { entries: [], error: migrationError(`'${selector.id}' is not an explicit canonical run id; import/select a canonical run before using workflow-view`) };
}

const factory = (api: CustomCommandAPI): CustomCommand => ({
  name: "workflow-view",
  description:
    "Render explicitly selected canonical ordinary or CTO workflow state as a self-contained offline bundle under .work-state/visualize. /workflow-view [do-work|cto] [id=<runId>] [revision=<revisionId>] [--all] [--full]",
  async execute(args: string[], ctx: HookCommandContext): Promise<string> {
    const cwd = ctx.cwd ?? api.cwd;
    if (!cwd) return "ERROR: no cwd available.";

    const parsed = parseWorkflowViewArgs(args);
    if (parsed.error) return `ERROR: ${parsed.error}\n\n${USAGE}`;

    const requested = sourceEntriesForRequest(cwd, parsed.selector);
    if (requested.error) return requested.error;
    const selection = selectWorkflowSessions(requested.entries, parsed.selector);
    if (selection.error) {
      const error = selection.errorCode === "canonical-unavailable" ? canonicalUnavailable(selection.error) : migrationError(selection.error);
      return error;
    }
    if (selection.entries.length === 0) {
      return migrationError("no canonical workflow sessions are available for this request");
    }

    const generatedAt = new Date().toISOString();
    let sessions: VisualizationSession[];
    try {
      sessions = buildSessionSnapshots(cwd, selection.entries as WorkflowViewSource[], generatedAt, {
        generatedAt,
        full: parsed.options.full,
      });
    } catch {
      return canonicalUnavailable("the selected canonical source could not be rendered");
    }
    if (sessions.length === 0) {
      return migrationError("no canonical workflow sessions are available for this request");
    }

    const manifest = buildManifest(sessions, selection.scope, {
      generatedAt,
      discoveredSessions: requested.entries.length,
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

    const preflight = preflightLinks(htmlPages);
    if (preflight.deadLinks.length > 0) {
      return `ERROR: workflow view link preflight failed (${preflight.deadLinks.length} dead link(s)); nothing written.`;
    }

    let result: VisualizePublishResult;
    try {
      result = publishVisualize(cwd, files);
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
