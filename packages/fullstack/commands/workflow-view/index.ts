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
  isSafePathKey,
  listSessions,
  preflightLinks,
  publishVisualize,
  renderHubHtml,
  renderHubMarkdown,
  renderSessionHtml,
  renderSessionMarkdown,
  sessionPagePath,
  type SessionSourceEntry,
  type VisualizeBundleFile,
  type VisualizePublishResult,
  type VisualizationScope,
  type VisualizationSession,
  type VisualizationSnapshot,
} from "@andvl1/omp-workflows-core";

/** Selector kinds understood by the command (frozen grammar). */
export type WorkflowViewKind = "do-work" | "cto" | "legacy";

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
 * Parse `/workflow-view [do-work|cto|legacy] [id=<slug|runId>] [--all] [--full]`.
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
    return { selector, options, error: `unknown argument: ${token}` };
  }
  if (selector.all !== undefined && selector.id !== undefined) {
    return { selector, options, error: "--all is mutually exclusive with id=" };
  }
  return { selector, options };
}

const USAGE = [
  "Usage: /workflow-view [do-work|cto|legacy] [id=<slug|runId>] [--all] [--full]",
  "",
  "  (bare)      latest discoverable workflow session (partial view)",
  "  do-work     latest do-work session (feature or legacy)",
  "  cto         latest CTO run",
  "  legacy      the legacy root session (team-state.json)",
  "  id=<...>    pick a specific session id",
  "  --all       complete view: every discoverable session",
  "  --full      embed redacted full artifact bodies (bounded caps)",
  "",
  "Writes a self-contained offline view (index.md, index.html, manifest.json +",
  "session pages) under .work-state/visualize.",
].join("\n");

/** Safe kind label of one discovered source entry (feature/legacy/cto). */
function displayKindOf(entry: SessionSourceEntry): "feature" | "legacy" | "cto" {
  if (entry.kind === "cto") return "cto";
  return entry.isLegacy ? "legacy" : "feature";
}

/** Whether an entry matches the requested selector kind. */
function matchesKind(kind: WorkflowViewKind, entry: SessionSourceEntry): boolean {
  if (kind === "cto") return entry.kind === "cto";
  if (kind === "legacy") return entry.kind === "do-work" && entry.isLegacy;
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
 * Resolve the selector against the discovered sessions (deterministic total
 * order from `listSessions`). latest = first in total order; selected =
 * exact kind/id (the legacy root wins `id=legacy`, matching the report
 * selector); `--all` = every session (optionally of one kind). Unknown ids
 * return an error listing discoverable ids; empty workspaces error (E-1).
 */
export function selectWorkflowSessions(entries: SessionSourceEntry[], selector: WorkflowViewSelector): Selection {
  const applyKind = (list: SessionSourceEntry[]): SessionSourceEntry[] =>
    selector.kind === undefined ? list : list.filter((e) => matchesKind(selector.kind!, e));

  if (selector.all !== undefined) {
    return { entries: applyKind(entries), scope: "all" };
  }
  if (selector.id !== undefined) {
    const matches = entries.filter((e) => e.id === selector.id && (selector.kind === undefined || matchesKind(selector.kind, e)));
    if (matches.length === 0) {
      const kindPart = selector.kind === undefined ? "" : ` (kind ${selector.kind})`;
      const listed = entries.length > 0 ? `; discoverable sessions: ${discoverableLabels(entries)}` : "";
      return { entries: [], scope: "selected", error: `session not found: ${selector.id}${kindPart}${listed}` };
    }
    // id=legacy is reserved for the legacy root (report selector parity);
    // the degraded feature literally named "legacy" never shadows it.
    if (selector.id === "legacy") {
      const root = matches.find((e) => e.kind === "do-work" && e.isLegacy);
      if (root !== undefined) return { entries: [root], scope: "selected" };
    }
    return { entries: matches.slice(0, 1), scope: "selected" };
  }
  if (selector.kind !== undefined) {
    const matches = applyKind(entries);
    if (matches.length === 0) {
      return { entries: [], scope: "selected", error: `no ${selector.kind} session found under .work-state` };
    }
    return { entries: matches.slice(0, 1), scope: "selected" };
  }
  if (entries.length === 0) {
    return { entries: [], scope: "selected", error: "no workflow sessions found under .work-state (nothing to visualize)" };
  }
  return { entries: entries.slice(0, 1), scope: "selected" };
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

const factory = (api: CustomCommandAPI): CustomCommand => ({
  name: "workflow-view",
  description:
    "Render the workflow specification view as a self-contained offline bundle under .work-state/visualize. /workflow-view [do-work|cto|legacy] [id=<slug|runId>] [--all] [--full]",
  async execute(args: string[], ctx: HookCommandContext): Promise<string> {
    const cwd = ctx.cwd ?? api.cwd;
    if (!cwd) return "ERROR: no cwd available.";

    const parsed = parseWorkflowViewArgs(args);
    if (parsed.error) return `ERROR: ${parsed.error}\n\n${USAGE}`;

    const discovered = listSessions(cwd);
    const selection = selectWorkflowSessions(discovered, parsed.selector);
    if (selection.error) return `ERROR: ${selection.error}\n\n${USAGE}`;
    if (selection.entries.length === 0) {
      return "ERROR: no workflow sessions found under .work-state (nothing to visualize)\n\n" + USAGE;
    }

    const generatedAt = new Date().toISOString();
    let sessions: VisualizationSession[];
    try {
      sessions = buildSessionSnapshots(cwd, selection.entries, generatedAt, { generatedAt, full: parsed.options.full });
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
