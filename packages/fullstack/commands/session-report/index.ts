/**
 * /session-report — one unified surface for the session-state report.
 *
 * Renders ONE explicitly selected canonical ordinary run/revision or CTO run
 * as a self-contained offline HTML report (single file, inline CSS/JS/data,
 * no network). Ordinary legacy state is import-only and returns
 * `migration_required`; it is never selected through a slug, `.active-feature`,
 * branch or mtime. CTO remains a separate exact-id namespace.
 */

import type { CustomCommand, CustomCommandAPI } from "@oh-my-pi/pi-coding-agent/extensibility/custom-commands/types";
import type { HookCommandContext } from "@oh-my-pi/pi-coding-agent/extensibility/hooks/types";
import {
  buildCanonicalRunReport,
  buildSessionReport,
  renderReportHtml,
  resolveCanonicalRunSource,
  writeReport,
} from "@andvl1/omp-workflows-core";
import type {
  BuildSessionReportOptions,
  SessionReport,
  SessionSelector,
} from "@andvl1/omp-workflows-core";

export interface ParsedSessionReportArgs {
  selector: SessionSelector;
  revision_id?: string;
  options: BuildSessionReportOptions;
  error?: string;
}

const SAFE_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SAFE_REVISION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const CANONICAL_RUN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Parse `/session-report [do-work|cto] [id=<runId>] [revision=<revisionId>] [--full]`. */
export function parseSessionReportArgs(args: string[]): ParsedSessionReportArgs {
  let revision_id: string | undefined;
  const selector: SessionSelector = {};
  const options: BuildSessionReportOptions = {};
  for (const token of args) {
    if (token.trim() === "") continue;
    if (token === "--full") {
      if (options.includeFullArtifacts) return { selector, options, error: "duplicate --full" };
      options.includeFullArtifacts = true;
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
      if (!SAFE_SESSION_ID.test(id)) return { selector, options, error: `unsafe id: ${id}` };
      selector.id = id;
      continue;
    }
    const revisionMatch = /^revision=(.*)$/.exec(token);
    if (revisionMatch) {
      const revision = revisionMatch[1]!.trim();
      if (!revision) return { selector, options, error: "empty revision= value" };
      if (revision_id !== undefined) return { selector, options, error: `duplicate revision: ${token}` };
      if (!SAFE_REVISION_ID.test(revision)) return { selector, options, error: `unsafe revision: ${revision}` };
      revision_id = revision;
      continue;
    }
    return { selector, options, error: `unknown argument: ${token}` };
  }
  return { selector, ...(revision_id ? { revision_id } : {}), options };
}

const USAGE = [
  "Usage: /session-report [do-work|cto] [id=<runId>] [revision=<revisionId>] [--full]",
  "",
  "  do-work id=<runId>  report one canonical ordinary run",
  "  revision=<id>       select an immutable canonical revision",
  "  cto id=<runId>      report one exact CTO run",
  "  --full              embed sanitized full artifact content (default: summaries)",
  "",
  "Legacy ordinary state is import-only and cannot be reported at runtime.",
  "Writes a self-contained offline HTML report under .work-state.",
].join("\n");

function canonicalSelection(
  selector: SessionSelector,
  revisionId?: string,
): { runId?: string; revisionId?: string; error?: string } {
  if (selector.kind === "cto") {
    if (revisionId !== undefined) return { error: "canonical-unavailable: revision= is only valid for ordinary canonical runs" };
    return {};
  }
  if (!selector.id) {
    return { error: "migration_required: an explicit canonical ordinary run id is required; latest/legacy selectors are unavailable" };
  }
  if (!CANONICAL_RUN_ID.test(selector.id)) {
    return { error: `migration_required: '${selector.id}' is not a canonical run id; import/select a canonical run before reporting` };
  }
  return { runId: selector.id, ...(revisionId ? { revisionId } : {}) };
}

/** Choose the canonical-run/revision or per-CTO report path. */
export function sessionReportTargetPath(report: SessionReport, revisionId?: string): string {
  if (report.kind === "cto") return `.work-state/cto/${report.source.id}/report.html`;
  if (!CANONICAL_RUN_ID.test(report.source.id)) {
    throw new Error("canonical ordinary run id required for session report output");
  }
  if (revisionId !== undefined && !SAFE_REVISION_ID.test(revisionId)) {
    throw new Error("unsafe revision selector");
  }
  return revisionId
    ? `.work-state/runs/${report.source.id}/revisions/${revisionId}/report.html`
    : `.work-state/runs/${report.source.id}/report.html`;
}

/** Concise status line returned to the main agent after a successful write. */
export function formatSessionReportStatus(report: SessionReport, targetPath: string): string {
  const warnings = report.warnings.length;
  const lines = [
    `Session report written: ${targetPath}`,
    `${report.meta.title} (${report.kind} · ${report.source.id})`,
    `${report.stages.length} stages · ${report.artifacts.length} artifacts · ${report.chronology.length} chronology entries${warnings ? ` · ${warnings} warning(s)` : ""}`,
    "Open the file in a browser to view the report.",
  ];
  return lines.join("\n");
}

const factory = (api: CustomCommandAPI): CustomCommand => ({
  name: "session-report",
  description:
    "Render one explicitly selected canonical ordinary run/revision or exact CTO report. /session-report [do-work|cto] id=<runId> [revision=<revisionId>] [--full]",
  async execute(args: string[], ctx: HookCommandContext): Promise<string> {
    const cwd = ctx.cwd ?? api.cwd;
    if (!cwd) return "ERROR: no cwd available.";

    const parsed = parseSessionReportArgs(args);
    if (parsed.error) return `ERROR: ${parsed.error}\n\n${USAGE}`;
    if (parsed.selector.kind === "cto" && !parsed.selector.id) {
      return `ERROR [canonical-unavailable]: CTO report requires an explicit id=<runId>; latest selection is unavailable\n\n${USAGE}`;
    }

    const canonical = canonicalSelection(parsed.selector, parsed.revision_id);
    if (canonical.error) return `ERROR: ${canonical.error}\n\n${USAGE}`;

    let report: SessionReport;
    try {
      if (canonical.runId) {
        const source = resolveCanonicalRunSource(cwd, {
          run_id: canonical.runId,
          ...(canonical.revisionId ? { revision_id: canonical.revisionId } : {}),
        });
        if (source.read.run_id !== canonical.runId) {
          return `ERROR [canonical-unavailable]: canonical run '${canonical.runId}' could not be resolved without fallback`;
        }
        report = buildCanonicalRunReport(cwd, {
          run_id: canonical.runId,
          ...(canonical.revisionId ? { revision_id: canonical.revisionId } : {}),
        }, parsed.options);
      } else {
        report = buildSessionReport(cwd, parsed.selector, parsed.options);
      }
    } catch {
      return `ERROR [canonical-unavailable]: selected canonical source is unavailable\n\n${USAGE}`;
    }

    const target = sessionReportTargetPath(report, canonical.revisionId);
    let absolutePath: string;
    try {
      absolutePath = writeReport(cwd, target, renderReportHtml(report));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return `ERROR: could not write report: ${message}`;
    }

    ctx.ui?.notify?.(`session-report: ${report.meta.title} → ${target}`, "info");
    return formatSessionReportStatus(report, absolutePath);
  },
});

export default factory;
