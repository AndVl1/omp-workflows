/**
 * /session-report — one unified surface for the session-state report.
 *
 * Renders ONE selected or latest do-work/CTO session as a self-contained
 * offline HTML report (single file, inline CSS/JS/data, no network):
 *
 *   /session-report [do-work|cto] [id=<slug|runId>] [--full]
 *
 *   bare            auto-detect the latest do-work or CTO session
 *   do-work|cto     restrict to one session family (latest within it)
 *   id=<slug|runId> pick a specific feature slug (do-work) or run id (cto)
 *   --full          embed sanitized full artifact content (byte-capped)
 *
 * The command is a thin orchestration shell over the core report API:
 * `buildSessionReport` (normalization/redaction) → `renderReportHtml`
 * (pure renderer) → `writeReport` (enforces the .work-state boundary and
 * restrictive permissions). It never dispatches agents and never embeds
 * raw events/transcripts.
 *
 * Output paths (chosen here, enforced by core writeReport):
 *   do-work feature → .work-state/features/<slug>/report.html
 *   do-work legacy  → .work-state/report.html
 *   cto run         → .work-state/cto/<runId>/report.html
 */

import type { CustomCommand, CustomCommandAPI } from "@oh-my-pi/pi-coding-agent/extensibility/custom-commands/types";
import type { HookCommandContext } from "@oh-my-pi/pi-coding-agent/extensibility/hooks/types";
import { buildSessionReport, renderReportHtml, writeReport } from "@andvl1/omp-workflows-core";
import type {
  BuildSessionReportOptions,
  SessionReport,
  SessionSelector,
} from "@andvl1/omp-workflows-core";

export interface ParsedSessionReportArgs {
  selector: SessionSelector;
  options: BuildSessionReportOptions;
  error?: string;
}

/** Parse `/session-report [do-work|cto] [id=<slug|runId>] [--full]`. */
export function parseSessionReportArgs(args: string[]): ParsedSessionReportArgs {
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
    return { selector, options, error: `unknown argument: ${token}` };
  }
  return { selector, options };
}

const USAGE = [
  "Usage: /session-report [do-work|cto] [id=<slug|runId>] [--full]",
  "",
  "  (bare)      auto-detect the latest do-work or CTO session",
  "  do-work     latest do-work session (or id=<feature slug>)",
  "  cto         latest CTO run (or id=<run id>)",
  "  id=<...>    pick a specific session id",
  "  --full      embed sanitized full artifact content (default: summaries)",
  "",
  "Writes a self-contained offline HTML report under .work-state.",
].join("\n");

/** Choose the per-feature or per-CTO `.work-state` report path. */
export function sessionReportTargetPath(report: SessionReport): string {
  if (report.kind === "cto") return `.work-state/cto/${report.source.id}/report.html`;
  if (report.source.isLegacy) return `.work-state/report.html`;
  return `.work-state/features/${report.source.id}/report.html`;
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
    "Render one selected or latest do-work/CTO session as a self-contained offline HTML report. /session-report [do-work|cto] [id=<slug|runId>] [--full]",
  async execute(args: string[], ctx: HookCommandContext): Promise<string> {
    const cwd = ctx.cwd ?? api.cwd;
    if (!cwd) return "ERROR: no cwd available.";

    const parsed = parseSessionReportArgs(args);
    if (parsed.error) return `ERROR: ${parsed.error}\n\n${USAGE}`;

    let report: SessionReport;
    try {
      report = buildSessionReport(cwd, parsed.selector, parsed.options);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return `ERROR: could not build session report: ${message}\n\n${USAGE}`;
    }

    const target = sessionReportTargetPath(report);
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
