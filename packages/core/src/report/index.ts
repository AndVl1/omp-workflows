/**
 * Session-report public surface (pragmatic architecture).
 *
 * build → render → write, all dependency-free:
 * - `buildSessionReport` reads + normalizes TeamState/CtoState into
 *   `SessionReport` (state-first; bounded optional telemetry).
 * - `renderReportHtml` is the pure, self-contained HTML renderer
 *   (implemented in html.ts, exported through this barrel).
 * - `writeReport` persists the HTML under `.work-state` with mode 0600 and
 *   rejects any target outside `.work-state`.
 */

export {
  buildSessionReport,
  writeReport,
} from "./assemble.js";
export { renderReportHtml } from "./html.js";
export { renderMarkdownDocumentHtml } from "./markdown.js";
export type { MarkdownDocumentOptions } from "./markdown.js";
export { redactReportBody, redactText, DEFAULT_REDACTION_CONFIG } from "./redact.js";
export type { RedactionConfig } from "./redact.js";
export type {
  SessionKind,
  SessionSelector,
  BuildSessionReportOptions,
  StageInfo,
  EdgeKind,
  SessionEdge,
  ArtifactStatus,
  ReportArtifact,
  ReportTeam,
  ReportIntegration,
  ReportHealth,
  ReportMeta,
  ReportSource,
  ReportTelemetry,
  ChronologyEvent,
  SessionReport,
} from "./types.js";
