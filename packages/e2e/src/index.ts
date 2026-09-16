/**
 * @andvl1/omp-workflows-e2e — interactive UX E2E test framework for
 * omp + omp-workflows. Public surface.
 */

export {
  startTestSession,
  mintToken,
  safeEqual,
  buildOmpArgs,
  pidIsLive,
  assertNoLiveSession,
  readSessionInfo,
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
  SessionInfo,
  ServerMsg,
  AttachResult,
} from './server.js';

export { WsDriver, TranscriptLog, AskStateTracker, answerNativeAsk, answerSelectedAsk, answerSelectedAskWithNote, stripAnsi, waitFor, WaitTimeoutError, wsUrlFromPageUrl, createPlaywrightDriver, isOmpTuiReady, waitForOmpTuiReady } from './driver.js';
export type {
  TerminalDriver,
  TerminalKey,
  WsDriverOptions,
  AskOption,
  AskQuestion,
  AskBlock,
  SelectedAskBlock,
  AskStateRecord,
  AskStateTrackerOptions,
  AnswerReservation,
  ReservationResult,
  AnswerResult,
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
  ScenarioSelectors,
  ScenarioWorkspacePaths,
  ScenarioTranscriptExpectations,
} from './scenario.js';

export { generateReport, DEFECT_FLOORS, UX_DIMENSIONS, AGENT_DIMENSIONS, DEFECT_SEVERITIES } from './report.js';
export type {
  UxE2eReport,
  ReportChildSession,
  ReportInput,
  ReportSessionMeta,
  ReportSelectors,
  ReportScenarioReference,
  ReportWorkspaceEvidence,
  ReportWorkerAttribution,
  ReportRuntimeMarker,
  ReportNextAction,
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

export { deferred, type Deferred } from './util.js';
