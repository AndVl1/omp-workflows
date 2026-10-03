/**
 * @andvl1/omp-workflows-e2e — interactive UX E2E test framework for
 * omp + omp-workflows. Public surface.
 */

export {
  startTestSession,
  mintToken,
  safeEqual,
  buildOmpArgs,
  killProcessTree,
  pidIsLive,
  assertNoLiveSession,
  readSessionRecord,
  RateLimiter,
  IdleTimer,
  securityHeaders,
  cspHeader,
  attachSession,
  MAX_INBOUND_WS_BYTES,
} from './server.js';
export type {
  TestSession,
  TestSessionOptions,
  ScenarioRef,
  TranscriptFrame,
  RateLimitOptions,
  IdleTimerOptions,
  OmpLaunchConfig,
  KillProcessTreeOptions,
  SessionInfo,
  ServerMsg,
  AttachResult,
} from './server.js';

export { WsDriver, TranscriptLog, AskStateTracker, stripAnsi, waitFor, WaitTimeoutError, wsUrlFromPageUrl, createPlaywrightDriver } from './driver.js';
export type {
  TerminalDriver,
  WsDriverOptions,
  AskBlock,
  AskStateRecord,
  AnswerResult,
  WaitForOptions,
} from './driver.js';

export { loadScenario, expandTemplate } from './scenario.js';
export type {
  ScenarioDefinition,
  ScenarioStage,
  ScenarioTiming,
  ScenarioRatings,
  ScenarioTask,
  AskExpectation,
  ScreenshotTrigger,
} from './scenario.js';

export { generateReport, DEFECT_FLOORS, UX_DIMENSIONS, AGENT_DIMENSIONS, DEFECT_SEVERITIES } from './report.js';
export type {
  UxE2eReport,
  ReportInput,
  ReportSessionMeta,
  UxStep,
  UxDefect,
  AgentQuality,
  Overall,
  UxDimension,
  DefectSeverity,
  AgentDimension,
  Verdict,
  Recommendation,
  GenerateReportOptions,
  GenerateReportResult,
} from './report.js';
export { readManifest, verifyManifest, writeManifest, manifestDigest, ManifestError } from './manifest.js';
export type { RunManifest, SessionRecord, ProcessReceipt, RunRoots, ManifestAuth, NativeHostBrokerAuth } from './manifest.js';
export { prepareRun, doctorRun, cleanupPartialRun, validatePrepareConfig, getRunRoot } from './prepare.js';
export type { PrepareConfig, PrepareResult, DoctorResult } from './prepare.js';
export { inspectInstalledRuntime, snapshotRuntime, verifyRuntimeSnapshot } from './runtime.js';
export { managedBrokerStatus, stopManagedBroker } from './broker.js';

export { deferred, type Deferred } from './util.js';
