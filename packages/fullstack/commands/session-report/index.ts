/**
 * /session-report — one unified surface for the session-state report.
 *
 * Renders ONE explicitly selected canonical ordinary run/revision or CTO run
 * as a self-contained offline HTML report (single file, inline CSS/JS/data,
 * no network):
 *
 *   /session-report do-work id=<runId> [revision=<revisionId>] [--full]
 *   /session-report cto [id=<runId>] [--full]
 *
 * Ordinary legacy state is import-only and returns `migration_required`;
 * it is never selected through `.active-feature`, branch, or mtime.
 *
 * The command is a thin orchestration shell over canonical/core report APIs:
 * `buildCanonicalRunReport`/`buildSessionReport` → `renderReportHtml` →
 * `writeReport`. It never dispatches agents and never embeds raw events.
 *
 * Output paths:
 *   canonical run → .work-state/runs/<runId>[/revisions/<revisionId>]/report.html
 *   cto run       → .work-state/cto/<runId>/report.html
 */

import type { CustomCommand, CustomCommandAPI } from "@oh-my-pi/pi-coding-agent/extensibility/custom-commands/types";
import type { HookCommandContext } from "@oh-my-pi/pi-coding-agent/extensibility/hooks/types";
import {
  buildCanonicalRunReport,
  buildSessionReport,
  listCanonicalRunSources,
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

/** Parse `/session-report [do-work|cto] [id=<runId>] [revision=<revisionId>] [--full]`. */
export function parseSessionReportArgs(args: string[]): ParsedSessionReportArgs {
  let revision_id: string | undefined;
  const selector: SessionSelector = {};
  const options: BuildSessionReportOptions = {};
  for (const token of args) {
    if (token.trim() === "") continue;
    if (token === "--full") {
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
      if (selector.id !== undefined) {
        return { selector, options, error: `duplicate id: ${token}` };
      }
      selector.id = id;
      continue;
    }
    const revisionMatch = /^revision=(.*)$/.exec(token);
    if (revisionMatch) {
      const revision = revisionMatch[1]!.trim();
      if (!revision) return { selector, options, error: "empty revision= value" };
      if (revision_id !== undefined) return { selector, options, error: `duplicate revision: ${token}` };
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
  "  (bare)      choose an explicit canonical run; CTO retains its own namespace",
  "  do-work     report one canonical ordinary run by id",
  "  cto         report one CTO run (or id=<run id>)",
  "  id=<runId>  choose one canonical ordinary run or CTO run",
  "  revision=<revisionId>  choose an immutable canonical revision",
  "  --full      embed sanitized full artifact content (default: summaries)",
  "",
  "Writes a self-contained offline HTML report under .work-state.",
].join("\n");
const CANONICAL_RUN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function canonicalSelection(
  cwd: string,
  selector: SessionSelector,
  revisionId?: string,
): { runId?: string; revisionId?: string; error?: string } {
  if (selector.id && CANONICAL_RUN_ID.test(selector.id)) {
    return { runId: selector.id, ...(revisionId ? { revisionId } : {}) };
  }
  if (selector.kind === "cto") return {};
  const canonical = listCanonicalRunSources(cwd);
  if (canonical.length === 0) return {};
  if (selector.id) {
    const match = canonical.find(entry => entry.run_id === selector.id);
    if (!match) {
      return {
        error: `canonical run '${selector.id}' was not found; choose one of: ${canonical.map(entry => entry.run_id).join(", ")}`,
      };
    }
    return { runId: match.run_id, ...(revisionId ? { revisionId } : {}) };
  }
  if (canonical.length !== 1) {
    return {
      error: `canonical report requires an explicit run id; available runs: ${canonical.map(entry => `${entry.title} [${entry.run_id}]`).join(", ")}`,
    };
  }
  return { runId: canonical[0]!.run_id, ...(revisionId ? { revisionId } : {}) };
}

/** Choose the canonical-run/revision or per-CTO report path. */
export function sessionReportTargetPath(report: SessionReport, revisionId?: string): string {
  if (report.kind === "cto") return `.work-state/cto/${report.source.id}/report.html`;
  if (!CANONICAL_RUN_ID.test(report.source.id)) {
    throw new Error("canonical ordinary run id required for session report output");
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
    "Render one explicitly selected canonical ordinary run/revision or CTO report. /session-report [do-work|cto] [id=<runId>] [revision=<revisionId>] [--full]",
  async execute(args: string[], ctx: HookCommandContext): Promise<string> {
    const cwd = ctx.cwd ?? api.cwd;
    if (!cwd) return "ERROR: no cwd available.";

    const parsed = parseSessionReportArgs(args);
    if (parsed.error) return `ERROR: ${parsed.error}\n\n${USAGE}`;

    const canonical = canonicalSelection(cwd, parsed.selector, parsed.revision_id);
    if (canonical.error) return `ERROR: ${canonical.error}\n\n${USAGE}`;
    if (parsed.selector.kind !== "cto" && !canonical.runId) {
      return (
        "ERROR [migration_required]: no canonical ordinary run is available for this report request. " +
        "Choose an imported run with id=<run_id>; legacy state is not a runtime fallback.\n\n" + USAGE
      );
    }

    let report: SessionReport;
    try {
      if (canonical.runId) {
        const source = resolveCanonicalRunSource(cwd, {
          run_id: canonical.runId,
          ...(canonical.revisionId ? { revision_id: canonical.revisionId } : {}),
        });
        if (source.read.run_id !== canonical.runId) {
          return `ERROR: canonical run '${canonical.runId}' could not be resolved without fallback`;
        }
        report = buildCanonicalRunReport(cwd, {
          run_id: canonical.runId,
          ...(canonical.revisionId ? { revision_id: canonical.revisionId } : {}),
        }, parsed.options);
      } else {
        report = buildSessionReport(cwd, parsed.selector, parsed.options);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return `ERROR: could not build session report: ${message}\n\n${USAGE}`;
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
