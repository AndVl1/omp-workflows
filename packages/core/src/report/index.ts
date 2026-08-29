/**
 * Session-report public surface.
 *
 * Report assembly and publication consume an instance-issued,
 * descriptor-relative storage authority. Callers must adapt their owning
 * project/run authority through `createReportStorageAuthority`; report code
 * never discovers a root or accepts a pathname authority.
 */

export {
  buildSessionReport,
  writeReport,
} from "./assemble.js";
export {
  createReportStorageAuthority,
  isReportStorageAuthority,
  isReportTreeStorageAuthority,
  replaceStorageTreeAtomic,
} from "./storage.js";
export type {
  ReportStorageAuthority,
  ReportStorageOperations,
  ReportTreeStorageAuthority,
  ReportTreeStorageOperations,
  StorageEntry,
  StorageFailure,
  StorageFailureReason,
  StorageResult,
  StorageStat,
  StorageTreeEntry,
  StorageTreeLimits,
  StorageTreePublishResult,
} from "./storage.js";
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
