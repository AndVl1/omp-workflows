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

export { deferred, type Deferred } from './util.js';
