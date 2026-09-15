/**
 * Report generation — ux-e2e JSON + manual_qa-compatible markdown.
 *
 * `generateReport()` clamps step ratings against defect severity floors
 * (a CRITICAL defect caps the step at 1, HIGH at 2, MEDIUM at 3, LOW at 4)
 * and warns on every clamp, so the score can never outrun the defects.
 */

import { createHash } from 'node:crypto';
import {
  closeSync,
  constants as fsConstants,
  lstatSync,
  opendirSync,
  realpathSync,
  type Dir,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type {
  ScenarioSelectors,
  ScenarioWorkspacePaths,
  ScenarioTranscriptExpectations,
} from './scenario.js';
import {
  closePinnedDirectory,
  closePinnedFile,
  MAX_PINNED_READ_BYTES,
  openPinnedFile,
  notifyBeforeSourcePin,
  pinDirectory,
  pinOrCreateDirectory,
  pinChildDirectory,
  pinnedChildEntryExists,
  pinnedDirectoryIsStable,
  readPinnedEvidence,
  readPinnedFile,
  readPinnedFileFull,
  setFsSafetyTestHooks,
  writePinnedFile,
  withPinnedExclusiveLock,
  unlinkPinnedFileIfExact,
  type FsSafetyTestHooks,
  type PinnedDirectory,
} from './fs-safety.js';

/**
 * Strip terminal controls before any value reaches human-readable report
 * output. Evidence files remain raw and are referenced, never rendered.
 */
function sanitizeForJson(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(
    /(?:\u001b(?:\][^\u0007]*(?:\u0007|\u001b\\)|(?:P|X|\^|_)[^\u001b]*(?:\u001b\\)|\[[0-?]*[ -/]*[@-~]|[ -/]*[@-~])|\u009d[^\u0007]*(?:\u0007|\u001b\\)|[\u0090\u0098\u009e\u009f][^\u001b]*(?:\u001b\\)|\u009b[0-?]*[ -/]*[@-~]|[\u0080-\u009c]|[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f])/gu,
    '',
  ).replace(/\r\n?/gu, '\n').replace(/\t/gu, '  ');
}

function sanitizeMarkdownInline(value: string): string {
  return sanitizeForJson(value)
    .replace(/\\/gu, '\\\\')
    .replace(/`/gu, '\\`')
    .replace(/([*_{}\[\]<>|#])/gu, '\\$1');
}

function sanitizeMarkdownBlock(value: string): string {
  return sanitizeMarkdownInline(value);
}

function sanitizeOutput(value: unknown, key = ''): unknown {
  if (typeof value === 'string') return key === 'evidence' ? value : sanitizeForJson(value);
  if (Array.isArray(value)) return value.map(item => sanitizeOutput(item, key));
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([name, child]) => [name, sanitizeOutput(child, name)]));
  }
  return value;
}
/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

export type UxDimension =
  | 'message_clarity'
  | 'feedback_timing'
  | 'error_handling'
  | 'layout'
  | 'interactivity'
  | 'visual_rendering';

export type DefectSeverity = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';

export type AgentDimension = 'task_fidelity' | 'communication' | 'tool_discipline' | 'output_quality' | 'recovery';

export type Verdict = 'PASS' | 'FAIL' | 'CONDITIONAL';

export type Recommendation = 'ship' | 'fix-high' | 'rework';

export const UX_DIMENSIONS: readonly UxDimension[] = [
  'message_clarity',
  'feedback_timing',
  'error_handling',
  'layout',
  'interactivity',
  'visual_rendering',
];

export const AGENT_DIMENSIONS: readonly AgentDimension[] = [
  'task_fidelity',
  'communication',
  'tool_discipline',
  'output_quality',
  'recovery',
];

export const DEFECT_SEVERITIES: readonly DefectSeverity[] = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'];

/**
 * Defect floors: the highest rating a step may carry given its worst
 * attached defect. A step with no defects has no floor (5).
 */
export const DEFECT_FLOORS: Readonly<Record<DefectSeverity, number>> = {
  CRITICAL: 1,
  HIGH: 2,
  MEDIUM: 3,
  LOW: 4,
};

export interface UxDefect {
  readonly id: string;
  readonly severity: DefectSeverity;
  readonly dimension: UxDimension;
  readonly title: string;
  /** Step id the defect belongs to. */
  readonly step: string;
  readonly evidence: string[];
  readonly repro?: string;
  readonly notes?: string;
}

export interface UxStep {
  readonly id: string;
  readonly name: string;
  readonly order: number;
  readonly ratings: Partial<Record<UxDimension, number>>;
  /** Defect ids attached to this step. */
  readonly defects: string[];
  readonly screenshots: string[];
  readonly transcript_excerpt?: string;
  readonly notes?: string;
}

export interface AgentQuality {
  readonly rating: number;
  readonly rationale: string;
  readonly dimensions?: Partial<Record<AgentDimension, number>>;
}

export interface Overall {
  readonly score: number;
  readonly summary: string;
  readonly recommendation: Recommendation;
}

export interface ReportWorkerAttribution {
  readonly phase: string | null;
  readonly dispatch_id: string;
  readonly role: string | null;
  readonly agent: string | null;
  /** Project-relative immutable record containing the attribution. */
  readonly evidence: string;
}

export interface ReportRuntimeMarker {
  readonly kind: 'interruption' | 'resume';
  readonly value: string;
  readonly evidence: string;
}

export interface ReportWorkspaceEvidence {
  /** Project-relative `specs/<feature-id>` location. */
  readonly path: string;
  /** Project-relative feature state location. */
  readonly state_path: string;
  /** Existing readable phase documents and status projections. */
  readonly documents: string[];
  /** Existing validation, revision-history, handoff, and immutable records. */
  readonly validation: string[];
  readonly history: string[];
  readonly handoff: string[];
  readonly artifacts: string[];
  /** Durable checkpoint records and real PTY answer/transcript ledgers. */
  readonly checkpoints: string[];
  readonly checkpoint_transcripts: string[];
  /** Worker provenance retained by immutable phase versions. */
  readonly worker_attribution: ReportWorkerAttribution[];
  /** Durable pause/cursor evidence used to prove interruption and exact resume. */
  readonly interruption_resume: ReportRuntimeMarker[];
}

export interface ReportNextAction {
  readonly kind: string;
  readonly command: string | null;
  readonly reason: string | null;
}

export interface ReportSelectors {
  readonly feature_id: string | null;
  readonly run_key: string | null;
}

export interface ReportScenarioReference {
  readonly id: string;
  readonly title?: string;
  readonly selectors?: ScenarioSelectors;
  readonly workspace?: ScenarioWorkspacePaths;
  readonly transcript?: ScenarioTranscriptExpectations;
  readonly invalid_declarations?: string[];
}

export interface ReportChildSession {
  readonly slug: string;
  readonly scratch_dir: string;
  readonly status: 'starting' | 'running' | 'shutdown_failed' | 'stopped' | null;
  readonly scenario: ReportScenarioReference | null;
  readonly transcript: string;
  readonly session_jsonl: string;
  readonly events_jsonl: string;
  readonly omp_log: string;
  readonly evidence: string[];
  readonly verdict: Verdict;
  readonly overall: Overall;
  readonly selectors?: ReportSelectors;
  readonly workspace?: ReportWorkspaceEvidence;
  readonly next_action?: ReportNextAction;
}

export interface ReportSessionMeta {
  readonly slug: string;
  readonly scratch_dir: string;
  readonly omp_version: string;
  readonly profile: string;
  readonly tty: { readonly cols: number; readonly rows: number; readonly term: string };
  readonly status: 'starting' | 'running' | 'shutdown_failed' | 'stopped' | null;
  readonly started_at: string | null;
  readonly stopped_at: string | null;
  readonly finished_at: string | null;
  readonly shutdown_error: string | null;
  readonly task_prompt: string | null;
  readonly scenario: ReportScenarioReference | null;
  readonly transcript: string;
  readonly session_jsonl: string;
  readonly events_jsonl: string;
  readonly omp_log: string;
  readonly selectors?: ReportSelectors;
  readonly workspace?: ReportWorkspaceEvidence;
  readonly next_action?: ReportNextAction;
  readonly child_sessions?: ReportChildSession[];
}

export interface UxE2eReport {
  readonly type: 'ux-e2e';
  readonly schema_version: 1;
  readonly verdict: Verdict;
  readonly mode: 'ui';
  readonly regressions: string[];
  readonly session: ReportSessionMeta;
  readonly steps: UxStep[];
  readonly defects: UxDefect[];
  readonly agent_quality: AgentQuality;
  readonly overall: Overall;
  readonly evidence: string[];
  readonly generated_at: string;
}

export interface ReportInput {
  readonly steps: ReadonlyArray<Omit<UxStep, 'id'> & { readonly id?: string }>;
  readonly defects: ReadonlyArray<Omit<UxDefect, 'id'> & { readonly id?: string }>;
  readonly agent_quality: AgentQuality;
  readonly verdict: Verdict;
  readonly overall: { readonly summary: string; readonly recommendation?: Recommendation; readonly score?: number };
  readonly regressions?: readonly string[];
}

export interface GenerateReportOptions {
  /** Markdown output directory. Default `<cwd>/vibe-report`. */
  readonly mdDir?: string;
  /** Mirror evidence files to `<mdDir>/evidence/<slug>/`. */
  readonly copyEvidence?: boolean;
}

export interface GenerateReportResult {
  readonly jsonPath: string;
  readonly mdPath: string;
  readonly warnings: string[];
}


export type ReportSelectorResolutionFailure = 'invalid' | 'partial' | 'conflicting' | 'unresolved';

/** Raised when report attribution cannot be bound to one feature/run pair. */
export class ReportSelectorResolutionError extends Error {
  readonly code = 'ux-e2e-report-selector-resolution-failed';
  readonly reason: ReportSelectorResolutionFailure;

  constructor(reason: ReportSelectorResolutionFailure, detail: string) {
    super('ux-e2e: report selector resolution failed (' + reason + '): ' + detail);
    this.name = 'ReportSelectorResolutionError';
    this.reason = reason;
  }
}

/* ------------------------------------------------------------------ */
/* Session metadata                                                    */
/* ------------------------------------------------------------------ */
interface RawSessionJson {
  readonly schema_version?: unknown;
  readonly slug?: unknown;
  readonly url?: unknown;
  readonly token?: unknown;
  readonly wsPath?: unknown;
  readonly pid?: unknown;
  readonly pty_start_identity?: unknown;
  readonly server_start_nonce?: unknown;
  readonly started_at?: unknown;
  readonly stopped_at?: unknown;
  readonly finished_at?: unknown;
  readonly status?: unknown;
  readonly pty_exit_observed?: unknown;
  readonly shutdown_completed_at?: unknown;
  readonly shutdown_error?: unknown;
  readonly omp_version?: unknown;
  readonly profile?: unknown;
  readonly tty?: unknown;
  readonly task_prompt?: unknown;
  readonly scenario?: unknown;
  readonly feature_id?: unknown;
  readonly run_key?: unknown;
  readonly selectors?: unknown;
  readonly workspace?: unknown;
  readonly next_action?: unknown;
  readonly omp_log_binding?: unknown;
  readonly omp_log_snapshot?: unknown;
}
interface RawOmpLogSnapshot {
  readonly relative_path?: unknown;
  readonly size?: unknown;
  readonly sha256?: unknown;
}
function validSnapshotName(value: unknown): value is string {
  return typeof value === 'string' && /^omp-log\.[0-9a-f]{64}\.log$/u.test(value);
}
function readSessionMeta(scratchDir: string): RawSessionJson {
  const p = join(scratchDir, '.work-state', 'ux-e2e', 'session.json');
  const root = pinDirectory(dirname(p));
  if (root === null) return {};
  try {
    const bytes = readPinnedFileFull(root, basename(p), 1024 * 1024);
    if (bytes === null) return {};
    const value = JSON.parse(bytes.toString('utf8')) as RawSessionJson;
    return value.schema_version === 2 ? value : {};
  } catch {
    return {};
  } finally {
    closePinnedDirectory(root);
  }
}
type ReportSessionStatus = 'starting' | 'running' | 'shutdown_failed' | 'stopped';

function rawLifecycleTimestamp(raw: RawSessionJson, key: 'stopped_at' | 'finished_at' | 'shutdown_completed_at'): string | null {
  const value = raw[key];
  if (typeof value !== 'string' || value.length === 0 || value.length > 64 || Number.isNaN(Date.parse(value))) return null;
  return value;
}

function rawSessionStatus(raw: RawSessionJson): ReportSessionStatus | null {
  const value = raw.status;
  return value === 'starting' || value === 'running' || value === 'shutdown_failed' || value === 'stopped' ? value : null;
}

function rawShutdownError(raw: RawSessionJson): string | null {
  if (raw.shutdown_error === undefined || raw.shutdown_error === null) return null;
  return typeof raw.shutdown_error === 'string' && raw.shutdown_error.length <= 1024
    ? sanitizeForJson(raw.shutdown_error)
    : 'invalid shutdown metadata';
}
function ompLogForSession(scratchDir: string, raw: RawSessionJson): string | null {
  const snapshot = raw.omp_log_snapshot;
  if (typeof snapshot !== 'object' || snapshot === null || Array.isArray(snapshot)) return null;
  const candidate = snapshot as RawOmpLogSnapshot;
  if (!validSnapshotName(candidate.relative_path)
    || typeof candidate.size !== 'number'
    || !Number.isSafeInteger(candidate.size)
    || candidate.size < 0
    || candidate.size > MAX_PINNED_READ_BYTES
    || typeof candidate.sha256 !== 'string'
    || !/^[0-9a-f]{64}$/u.test(candidate.sha256)) return null;
  const stateDir = join(scratchDir, '.work-state', 'ux-e2e');
  const root = pinDirectory(stateDir);
  if (root === null) return null;
  try {
    const info = lstatSync(join(stateDir, candidate.relative_path));
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size !== candidate.size) return null;
    const bytes = readPinnedFileFull(root, candidate.relative_path, MAX_PINNED_READ_BYTES);
    if (bytes === null || bytes.length !== candidate.size
      || createHash('sha256').update(bytes).digest('hex') !== candidate.sha256) return null;
    return join(stateDir, candidate.relative_path);
  } catch {
    return null;
  } finally {
    closePinnedDirectory(root);
  }
}

/* ------------------------------------------------------------------ */
/* Defect floors + clamping                                            */
/* ------------------------------------------------------------------ */

/** Effective rating for a dimension given the step's worst defect floor. */
function clampRating(rating: number | undefined, floor: number, warnings: string[], where: string): number | undefined {
  if (rating === undefined) return undefined;
  const safeWhere = sanitizeForJson(where).slice(0, 256);
  if (rating < 1) {
    warnings.push(`${safeWhere}: rating ${rating} clamped up to 1`);
    return 1;
  }
  if (rating > 5) {
    warnings.push(`${safeWhere}: rating ${rating} clamped down to 5`);
    return 5;
  }
  if (rating > floor) {
    warnings.push(`${safeWhere}: rating ${rating} clamped down to defect floor ${floor}`);
    return floor;
  }
  return rating;
}

function floorForStep(defects: readonly UxDefect[], stepId: string): number {
  let floor = 5;
  for (const d of defects) {
    if (d.step !== stepId) continue;
    const f = DEFECT_FLOORS[d.severity] ?? 5;

    if (f < floor) floor = f;
  }
  return floor;
}

const MAX_EVIDENCE_FILES = 4096;
/** Maximum bytes accepted for one evidence file by the pinned reader. */
const MAX_EVIDENCE_FILE_BYTES = MAX_PINNED_READ_BYTES;
/** Maximum bytes copied across all evidence files. */
const MAX_EVIDENCE_BYTES = 64 * 1024 * 1024;
/** Maximum bytes aggregated across all child sessions in one suite report. */
const MAX_SUITE_EVIDENCE_BYTES = MAX_EVIDENCE_BYTES;
/** Maximum evidence entries aggregated across one suite report. */
const MAX_SUITE_EVIDENCE_FILES = MAX_EVIDENCE_FILES;

function boundedFileSize(path: string): number | null {
  const absolute = resolve(path);
  const root = pinDirectory(dirname(absolute));
  if (root === null) return null;
  const file = openPinnedFile(root, basename(absolute), fsConstants.O_RDONLY);
  if (file === null) {
    closePinnedDirectory(root);
    return null;
  }
  try {
    return Number.isSafeInteger(file.size)
      && file.size >= 0
      && file.size <= MAX_EVIDENCE_FILE_BYTES
      ? file.size
      : null;
  } finally {
    closePinnedFile(file);
    closePinnedDirectory(root);
  }
}

function boundedReadableFile(path: string): boolean {
  return boundedFileSize(path) !== null;
}

/* ------------------------------------------------------------------ */
/* Evidence collection                                                 */
/* ------------------------------------------------------------------ */

function isCredentialBearingEvidence(scratchDir: string, path: string): boolean {
  return projectRelative(scratchDir, resolve(path)) === '.work-state/ux-e2e/session.json';
}

function evidenceCandidates(
  scratchDir: string,
  screenshots: readonly string[],
  workspaceEvidence: readonly string[] = [],
  ompLog: string | null = null,
): string[] {
  const stateDir = join(scratchDir, '.work-state', 'ux-e2e');
  const candidates: string[] = [];
  const addCandidate = (value: string): void => {
    if (candidates.length < MAX_EVIDENCE_FILES && value.length > 0 && !isCredentialBearingEvidence(scratchDir, value)) candidates.push(value);
  };
  addCandidate(join(stateDir, 'transcript.jsonl'));
  // session.json contains bearer/control/startup credentials. Its terminal
  // lifecycle projection is retained in report.session; never publish raw
  // metadata through evidence paths or copyEvidence.
  addCandidate(join(stateDir, 'session.jsonl'));
  addCandidate(join(stateDir, 'events.jsonl'));
  for (const screenshot of screenshots) addCandidate(screenshot);
  for (const path of workspaceEvidence) addCandidate(path);
  if (ompLog !== null) addCandidate(ompLog);
  return [...new Set(candidates.map(path => resolve(path)))].slice(0, MAX_EVIDENCE_FILES);
}

function collectEvidence(candidates: readonly string[]): string[] {
  return candidates.filter(path => boundedReadableFile(path));
}

function normalizeEvidencePath(root: PinnedDirectory, evidencePath: string): string {
  return isAbsolute(evidencePath)
    ? resolve(evidencePath)
    : resolve(root.lexicalPath, evidencePath);
}

function assertMandatoryEvidenceReadable(
  root: PinnedDirectory,
  requiredEvidence: readonly string[],
  phase: string,
): void {
  for (const evidencePath of requiredEvidence) {
    const absolute = evidencePath.length === 0 ? null : normalizeEvidencePath(root, evidencePath);
    if (absolute === null || projectRelative(root.lexicalPath, absolute) === null || readPinnedEvidence(root, absolute) === null) {
      throw new Error(`ux-e2e: PASS mandatory evidence is missing or unsafe ${phase}`);
    }
  }
}

function mandatoryEvidencePaths(report: UxE2eReport): string[] {
  const workspace = report.session.workspace;
  const workspacePaths = workspace === undefined ? [] : [
    ...workspace.documents,
    ...workspace.validation,
    ...workspace.history,
    ...workspace.handoff,
    ...workspace.artifacts,
    ...workspace.checkpoints,
    ...workspace.checkpoint_transcripts,
    ...workspace.worker_attribution.map(worker => worker.evidence),
    ...workspace.interruption_resume.map(marker => marker.evidence),
  ];
  return [...new Set([
    report.session.transcript,
    ...workspacePaths,
    ...report.steps.flatMap(step => step.screenshots),
  ].filter(path => path.length > 0))];
}

export interface EvidenceCopyTestHooks extends FsSafetyTestHooks {
  readonly beforeSuitePathStat?: (path: string) => void;
}

let reportTestHooks: EvidenceCopyTestHooks | null = null;

export function setEvidenceCopyTestHooks(hooks: EvidenceCopyTestHooks | null): void {
  reportTestHooks = hooks;
  setFsSafetyTestHooks(hooks);
}
function copyEvidence(evidence: readonly string[], targetDir: string, scratchDir: string, maxBytes = MAX_EVIDENCE_BYTES, retainedSourceRoot?: PinnedDirectory, created?: Map<string, Buffer>, createdRoots?: Map<string, PinnedDirectory>, retainedTargetRoot?: PinnedDirectory, retainedDestinationRoots?: Set<PinnedDirectory>): string[] {
  notifyBeforeSourcePin(scratchDir);
  const sourceRoot = retainedSourceRoot ?? pinDirectory(scratchDir);
  const ownsSourceRoot = retainedSourceRoot === undefined;
  const targetRoot = retainedTargetRoot ?? pinOrCreateDirectory(targetDir);
  const ownsTargetRoot = retainedTargetRoot === undefined;
  if (sourceRoot === null || targetRoot === null) {
    if (sourceRoot !== null && ownsSourceRoot) closePinnedDirectory(sourceRoot);
    if (targetRoot !== null && ownsTargetRoot) closePinnedDirectory(targetRoot);
    return [];
  }
  try {
    const copied: string[] = [];
    let totalBytes = 0;
    for (const source of evidence) {
      if (copied.length >= MAX_EVIDENCE_FILES || totalBytes >= maxBytes) break;
      if (isCredentialBearingEvidence(scratchDir, source)) continue;
      const bytes = readPinnedEvidence(sourceRoot, source);
      if (bytes === null
        || bytes.length > MAX_EVIDENCE_FILE_BYTES
        || bytes.length > maxBytes - totalBytes) continue;
      totalBytes += bytes.length;
      const relativeSource = projectRelative(scratchDir, resolve(source));
      const sourceParts = relativeSource === null ? ['external'] : relativeSource.split('/');
      const sourceName = sourceParts.pop() ?? 'evidence';
      const directories = sourceParts.filter(safeFilenameSegment);
      const digest = createHash('sha256').update(bytes).digest('hex').slice(0, 16);
      const baseName = safeFilenameSegment(sourceName) ? sourceName.slice(0, 100) : 'evidence';
      const filename = `${baseName}.${digest}`;
      const destinationRoot = directories.length === 0
        ? targetRoot
        : pinChildDirectory(targetRoot, directories);
      if (destinationRoot === null) continue;
      const destinationDir = destinationRoot.lexicalPath;
      const ownsDestinationRoot = destinationRoot !== targetRoot;
      let retainDestinationRoot = false;
      if (retainedDestinationRoots !== undefined) {
        retainedDestinationRoots.add(destinationRoot);
        retainDestinationRoot = true;
      }
      try {
        const existingFile = openPinnedFile(destinationRoot, filename, fsConstants.O_RDONLY);
        if (existingFile !== null) {
          try {
            const existing = existingFile.size === bytes.length
              ? readPinnedFileFull(destinationRoot, filename, MAX_PINNED_READ_BYTES)
              : null;
            if (existing === null || !existing.equals(bytes)) {
              throw new Error(`ux-e2e: evidence destination collision: ${join(destinationDir, filename)}`);
            }
            copied.push(join(destinationDir, filename));
            continue;
          } finally {
            closePinnedFile(existingFile);
          }
        }
        let published = false;
        const enrollPublication = (): void => {
          const publishedPath = join(destinationDir, filename);
          created?.set(publishedPath, bytes);
          if (createdRoots !== undefined) {
            createdRoots.set(publishedPath, destinationRoot);
            retainDestinationRoot = true;
          }
          copied.push(publishedPath);
        };
        const stable = writePinnedFile(destinationRoot, filename, bytes, {
          replaceExisting: false,
          onPublished: () => { published = true; },
        });
        if (!stable) {
          if (published) {
            enrollPublication();
            throw new Error(`ux-e2e: evidence destination changed after publication: ${join(destinationDir, filename)}`);
          }
          continue;
        }
        enrollPublication();
      } finally {
        if (ownsDestinationRoot && !retainDestinationRoot) closePinnedDirectory(destinationRoot);
      }
    }
    if (!pinnedDirectoryIsStable(sourceRoot)
      || !pinnedDirectoryIsStable(targetRoot)
      || [...(retainedDestinationRoots ?? [])].some(root => !pinnedDirectoryIsStable(root))) {
      throw new Error('ux-e2e: evidence source or destination root changed during evidence collection');
    }
    return copied;
  } finally {
    if (ownsSourceRoot) closePinnedDirectory(sourceRoot);
    if (ownsTargetRoot) closePinnedDirectory(targetRoot);
  }
}
type JsonRecord = Record<string, unknown>;

interface ResolvedFeatureState {
  readonly feature_id: string;
  readonly run_key: string;
  readonly state_path: string;
  readonly state: JsonRecord;
}

interface CollectedWorkspaceEvidence {
  readonly report: ReportWorkspaceEvidence;
  readonly absolute_paths: string[];
}

function asRecord(value: unknown): JsonRecord | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as JsonRecord
    : null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function safeFilenameSegment(value: string): boolean {
  return value.length > 0
    && value.length <= 128
    && /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/u.test(value);
}

function safeFeatureId(value: string): boolean {
  return safeFilenameSegment(value);
}

function safeRunKey(value: string): boolean {
  return value.length > 0
    && Buffer.byteLength(value, 'utf8') <= 4096
    && !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value);
}

function readJsonRecord(path: string): JsonRecord | null {
  const absolute = resolve(path);
  const root = pinDirectory(dirname(absolute));
  if (root === null) return null;
  try {
    const bytes = readPinnedFileFull(root, basename(absolute), 8 * 1024 * 1024);
    return bytes === null ? null : asRecord(JSON.parse(bytes.toString('utf8')));
  } catch {
    return null;
  } finally {
    closePinnedDirectory(root);
  }
}

function isWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..');
}

function boundedFiles(root: string): string[] {
  const rootHandle = pinDirectory(root);
  if (rootHandle === null) return [];
  const realRoot = rootHandle.physicalPath;
  const files: string[] = [];
  let totalBytes = 0;
  let nodes = 0;
  let directories = 0;
  const maxFiles = 2048;
  const maxNodes = 8192;
  const maxDirectories = 2048;
  const maxDepth = 12;
  const maxAggregateBytes = 32 * 1024 * 1024;
  const visit = (directory: string, depth: number): void => {
    if (
      depth > maxDepth
      || files.length >= maxFiles
      || nodes >= maxNodes
      || directories >= maxDirectories
      || totalBytes >= maxAggregateBytes
    ) return;
    directories += 1;
    let handle: Dir | null = null;
    try {
      handle = opendirSync(directory);
      for (;;) {
        if (files.length >= maxFiles || nodes >= maxNodes || totalBytes >= maxAggregateBytes) return;
        const entry = handle.readSync();
        if (entry === null) return;
        nodes += 1;
        if (entry.isSymbolicLink()) continue;
        const candidate = join(directory, entry.name);
        try {
          const info = lstatSync(candidate);
          if (info.isSymbolicLink()) continue;
          const real = realpathSync(candidate);
          if (!isWithin(realRoot, real)) continue;
          if (info.isDirectory()) visit(candidate, depth + 1);
          else if (info.isFile() && info.size <= maxAggregateBytes - totalBytes) {
            files.push(resolve(candidate));
            totalBytes += info.size;
          }
        } catch {
          /* Skip evidence that changed or became unreadable during collection. */
        }
      }
    } catch {
      return;
    } finally {
      try { handle?.closeSync(); } catch { /* best effort */ }
    }
  };
  try {
    visit(root, 0);
    return files.sort();
  } finally {
    closePinnedDirectory(rootHandle);
  }
}

function projectRelative(scratchDir: string, path: string): string | null {
  const rel = relative(scratchDir, path);
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`)) return null;
  return rel.split(sep).join('/');
}

interface SelectorPair {
  readonly feature_id: string;
  readonly run_key: string;
}

interface SelectorSource {
  readonly name: string;
  readonly present: boolean;
  readonly pair: SelectorPair | null;
  readonly invalid: boolean;
}

interface DeclaredSelectorResolution {
  readonly selectors: ReportSelectors;
  readonly pair: SelectorPair | null;
}

function hasOwn(record: JsonRecord, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function selectorSourceFromRecord(name: string, value: unknown, present: boolean): SelectorSource {
  if (!present) return { name, present: false, pair: null, invalid: false };
  const record = asRecord(value);
  if (record === null) return { name, present: true, pair: null, invalid: true };
  const hasFeature = hasOwn(record, 'feature_id');
  const hasRun = hasOwn(record, 'run_key');
  const featureId = nonEmptyString(record.feature_id);
  const runKey = nonEmptyString(record.run_key);
  if (!hasFeature || !hasRun || featureId === null || runKey === null || !safeFeatureId(featureId) || !safeRunKey(runKey)) {
    return { name, present: true, pair: null, invalid: true };
  }
  return { name, present: true, pair: { feature_id: featureId, run_key: runKey }, invalid: false };
}

function selectorSourceFromTopLevel(raw: RawSessionJson): SelectorSource {
  const record = raw as unknown as JsonRecord;
  const present = hasOwn(record, 'feature_id') || hasOwn(record, 'run_key');
  if (!present) return { name: 'session top-level', present: false, pair: null, invalid: false };
  const featureId = nonEmptyString(raw.feature_id);
  const runKey = nonEmptyString(raw.run_key);
  if (featureId === null || runKey === null || !safeFeatureId(featureId) || !safeRunKey(runKey)) {
    return { name: 'session top-level', present: true, pair: null, invalid: true };
  }
  return { name: 'session top-level', present: true, pair: { feature_id: featureId, run_key: runKey }, invalid: false };
}

function declaredSelectorResolution(raw: RawSessionJson): DeclaredSelectorResolution {
  const rawRecord = raw as unknown as JsonRecord;
  const scenario = asRecord(raw.scenario);
  const sources = [
    selectorSourceFromRecord('session.selectors', raw.selectors, hasOwn(rawRecord, 'selectors')),
    selectorSourceFromRecord('scenario.selectors', scenario?.selectors, scenario !== null && hasOwn(scenario, 'selectors')),
    selectorSourceFromTopLevel(raw),
  ];
  const present = sources.filter(source => source.present);
  const invalid = present.find(source => source.invalid);
  if (invalid !== undefined) {
    throw new ReportSelectorResolutionError('partial', `${invalid.name} must declare feature_id and run_key as one complete pair`);
  }
  const pairs = present.flatMap(source => source.pair === null ? [] : [source.pair]);
  const first = pairs[0];
  if (first === undefined) {
    return { selectors: { feature_id: null, run_key: null }, pair: null };
  }
  if (pairs.some(pair => pair.feature_id !== first.feature_id || pair.run_key !== first.run_key)) {
    throw new ReportSelectorResolutionError('conflicting', 'declared selector sources do not identify one exact feature_id/run_key pair');
  }
  return { selectors: first, pair: first };
}

function stateSelectorPair(state: JsonRecord, featureId: string, statePath: string): SelectorPair | null {
  const specificationValue = state.specification;
  const specification = specificationValue === undefined
    ? null
    : asRecord(specificationValue);
  if (specificationValue !== undefined && specification === null) {
    throw new ReportSelectorResolutionError('unresolved', `state ${statePath} has an invalid specification object`);
  }
  const featureValues: Array<string | null> = [];
  const runValues: Array<string | null> = [];
  if (hasOwn(state, 'feature_id')) featureValues.push(nonEmptyString(state.feature_id));
  if (specification !== null && hasOwn(specification, 'feature_id')) featureValues.push(nonEmptyString(specification.feature_id));
  if (hasOwn(state, 'run_key')) runValues.push(nonEmptyString(state.run_key));
  if (specification !== null && hasOwn(specification, 'run_key')) runValues.push(nonEmptyString(specification.run_key));
  const featurePresent = featureValues.length > 0;
  const runPresent = runValues.length > 0;
  if (!featurePresent && !runPresent) return null;
  if (!featurePresent || !runPresent || featureValues.some(value => value === null) || runValues.some(value => value === null)) {
    throw new ReportSelectorResolutionError('unresolved', `state ${statePath} does not contain one complete feature_id/run_key pair`);
  }
  const uniqueFeatures = new Set(featureValues);
  const uniqueRuns = new Set(runValues);
  if (uniqueFeatures.size !== 1 || uniqueRuns.size !== 1) {
    throw new ReportSelectorResolutionError('conflicting', `state ${statePath} contains conflicting selector values`);
  }
  const resolvedFeature = featureValues[0];
  const resolvedRun = runValues[0];
  if (resolvedFeature === undefined || resolvedRun === undefined || resolvedFeature === null || resolvedRun === null) {
    throw new ReportSelectorResolutionError('unresolved', `state ${statePath} could not resolve selectors`);
  }
  if (resolvedFeature === null || resolvedRun === null || !safeFeatureId(resolvedFeature) || !safeRunKey(resolvedRun)) {
    throw new ReportSelectorResolutionError('unresolved', `state ${statePath} could not resolve bounded selectors`);
  }
  if (resolvedFeature !== featureId) {
    throw new ReportSelectorResolutionError('conflicting', `state ${statePath} is stored under ${featureId} but declares ${resolvedFeature}`);
  }
  return { feature_id: resolvedFeature, run_key: resolvedRun };
}

function sameSelectorPair(left: SelectorPair, right: SelectorPair): boolean {
  return left.feature_id === right.feature_id && left.run_key === right.run_key;
}

function resolveFeatureState(scratchDir: string, raw: RawSessionJson): ResolvedFeatureState | null {
  const declared = declaredSelectorResolution(raw);
  const stateRoot = join(scratchDir, '.work-state', 'features');
  const stateFiles = new Set(boundedFiles(stateRoot).map(path => resolve(path)));
  const featureIds: string[] = [];
  if (declared.pair !== null) {
    if (!safeFeatureId(declared.pair.feature_id)) {
      throw new ReportSelectorResolutionError('invalid', `feature_id ${declared.pair.feature_id} is not a safe feature selector`);
    }
    featureIds.push(declared.pair.feature_id);
  } else {
    const discovered = new Set<string>();
    for (const path of stateFiles) {
      const first = relative(stateRoot, path).split(sep)[0];
      if (first !== undefined && safeFeatureId(first)) discovered.add(first);
    }
    featureIds.push(...discovered);
  }

  const candidates: ResolvedFeatureState[] = [];
  for (const featureId of featureIds) {
    const statePath = resolve(join(stateRoot, featureId, 'state.json'));
    const state = readJsonRecord(statePath);
    if (state === null) {
      if (stateFiles.has(statePath)) {
        throw new ReportSelectorResolutionError('unresolved', `state ${statePath} is unreadable or malformed`);
      }
      continue;
    }
    const statePair = stateSelectorPair(state, featureId, statePath);
    if (statePair === null) continue;
    if (declared.pair !== null && !sameSelectorPair(declared.pair, statePair)) {
      throw new ReportSelectorResolutionError('conflicting', `declared selectors do not match authoritative state ${statePath}`);
    }
    candidates.push({ feature_id: statePair.feature_id, run_key: statePair.run_key, state_path: statePath, state });
  }
  if (candidates.length === 1) return candidates[0] ?? null;
  if (declared.pair === null && featureIds.length > 0) {
    throw new ReportSelectorResolutionError('unresolved', 'feature state files did not resolve to one exact selector pair');
  }
  return null;
}

function collectWorkerAttribution(
  value: unknown,
  evidence: string,
  output: ReportWorkerAttribution[],
  seen: Set<string>,
  depth = 0,
): void {
  if (depth > 32 || output.length >= 2048) return;
  if (Array.isArray(value)) {
    for (const item of value) {
      if (output.length >= 2048) return;
      collectWorkerAttribution(item, evidence, output, seen, depth + 1);
    }
    return;
  }
  const record = asRecord(value);
  if (record === null) return;
  const dispatchId = nonEmptyString(record.dispatch_id);
  if (dispatchId !== null) {
    const identity = asRecord(record.work_identity);
    const phase = nonEmptyString(record.phase);
    const role = nonEmptyString(identity?.role) ?? nonEmptyString(record.role);
    const agent = nonEmptyString(identity?.agent) ?? nonEmptyString(record.agent);
    const key = `${dispatchId}\u0000${evidence}`;
    if (!seen.has(key)) {
      seen.add(key);
      output.push({ phase, dispatch_id: dispatchId, role, agent, evidence });
    }
  }
  for (const child of Object.values(record)) {
    if (output.length >= 2048) return;
    collectWorkerAttribution(child, evidence, output, seen, depth + 1);
  }
}

function collectWorkspaceEvidence(scratchDir: string, resolvedState: ResolvedFeatureState): CollectedWorkspaceEvidence {
  const featureId = resolvedState.feature_id;
  const workspaceRoot = join(scratchDir, 'specs', featureId);
  const featureStateRoot = join(scratchDir, '.work-state', 'features', featureId);
  const readable = boundedFiles(workspaceRoot);
  const stateFiles = boundedFiles(featureStateRoot);
  const rel = (paths: readonly string[]): string[] => paths
    .map(path => projectRelative(scratchDir, path))
    .filter((path): path is string => path !== null)
    .sort();

  const documents = rel(readable.filter(path => {
    const local = relative(workspaceRoot, path).split(sep);
    return local.length === 1 && path.endsWith('.md') && local[0] !== 'handoff.md';
  }));
  const validation = rel(readable.filter(path => relative(workspaceRoot, path).split(sep)[0] === 'validation'));
  const history = rel(readable.filter(path => relative(workspaceRoot, path).split(sep)[0] === 'history'));
  const handoff = rel(readable.filter(path => basename(path) === 'handoff.md'));
  const artifacts = rel(stateFiles.filter(path => relative(featureStateRoot, path).split(sep)[0] === 'artifacts'));
  const stateRel = projectRelative(scratchDir, resolvedState.state_path);
  const checkpoints = rel(stateFiles.filter(path => /checkpoint|decision|answer/iu.test(relative(featureStateRoot, path))));
  if (stateRel !== null && !checkpoints.includes(stateRel)) checkpoints.unshift(stateRel);

  const uxState = join(scratchDir, '.work-state', 'ux-e2e');
  const checkpointTranscripts = rel([
    join(uxState, 'transcript.jsonl'),
    join(uxState, 'ask-state.jsonl'),
    join(uxState, 'session.jsonl'),
  ].filter(path => boundedReadableFile(path)));

  const attribution: ReportWorkerAttribution[] = [];
  const seenAttribution = new Set<string>();
  if (stateRel !== null) collectWorkerAttribution(resolvedState.state, stateRel, attribution, seenAttribution);
  for (const path of stateFiles.filter(candidate => candidate.endsWith('.json'))) {
    const value = readJsonRecord(path);
    const evidence = projectRelative(scratchDir, path);
    if (value !== null && evidence !== null) collectWorkerAttribution(value, evidence, attribution, seenAttribution);
  }
  attribution.sort((a, b) => a.evidence.localeCompare(b.evidence) || a.dispatch_id.localeCompare(b.dispatch_id));

  const markers: ReportRuntimeMarker[] = [];
  const pause = asRecord(resolvedState.state.pause);
  const pauseKind = nonEmptyString(pause?.kind);
  const pauseReason = nonEmptyString(pause?.reason);
  if (stateRel !== null && (pauseKind !== null || pauseReason !== null)) {
    markers.push({ kind: 'interruption', value: [pauseKind, pauseReason].filter(Boolean).join(': '), evidence: stateRel });
  }
  const stageCursor = nonEmptyString(resolvedState.state.stage_cursor);
  const cursorEpoch = nonEmptyString(resolvedState.state.cursor_epoch)
    ?? nonEmptyString(asRecord(asRecord(resolvedState.state.dispatch_capability)?.issued_for)?.cursor_epoch);
  if (stateRel !== null && stageCursor !== null) {
    markers.push({ kind: 'resume', value: `stage_cursor=${stageCursor}`, evidence: stateRel });
  }
  if (stateRel !== null && cursorEpoch !== null) {
    markers.push({ kind: 'resume', value: `cursor_epoch=${cursorEpoch}`, evidence: stateRel });
  }
  const report: ReportWorkspaceEvidence = {
    path: `specs/${featureId}`,
    state_path: `.work-state/features/${featureId}/state.json`,
    documents,
    validation,
    history,
    handoff,
    artifacts,
    checkpoints,
    checkpoint_transcripts: checkpointTranscripts,
    worker_attribution: attribution,
    interruption_resume: markers,
  };
  return {
    report,
    absolute_paths: [...new Set([...readable, ...stateFiles, ...checkpointTranscripts.map(path => join(scratchDir, path))])].sort(),
  };
}

function readNextAction(raw: RawSessionJson, resolvedState: ResolvedFeatureState | null): ReportNextAction | undefined {
  const specification = resolvedState === null ? null : asRecord(resolvedState.state.specification);
  const candidate = asRecord(specification?.next_action) ?? asRecord(raw.next_action);
  if (candidate === null) return undefined;
  const kind = nonEmptyString(candidate.kind);
  if (kind === null) return undefined;
  const command = candidate.command === null ? null : nonEmptyString(candidate.command);
  const reason = candidate.reason === null ? null : nonEmptyString(candidate.reason);
  return { kind, command, reason };
}

/** Runtime-narrowed tty metadata from session.json (defaults when absent). */
function readTty(raw: unknown): { cols: number; rows: number; term: string } {
  if (typeof raw !== 'object' || raw === null) {
    return { cols: 100, rows: 30, term: 'xterm-256color' };
  }
  const cols = 'cols' in raw && typeof raw.cols === 'number' ? raw.cols : 100;
  const rows = 'rows' in raw && typeof raw.rows === 'number' ? raw.rows : 30;
  const term = 'term' in raw && typeof raw.term === 'string' && raw.term.length > 0 ? raw.term : 'xterm-256color';
  return { cols, rows, term };
}
/** Runtime-narrowed scenario reference from session.json (null when absent). */
function scenarioPath(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= 2048 && sanitizeForJson(value) === value ? value : undefined;
}

function scenarioPathList(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.length > 4096) return undefined;
  const paths = value.map(scenarioPath).filter((path): path is string => path !== undefined);
  return paths.length === value.length ? paths : undefined;
}

function readScenarioWorkspace(raw: unknown): ScenarioWorkspacePaths | undefined {
  const record = asRecord(raw);
  if (record === null) return undefined;
  const result: ScenarioWorkspacePaths = {
    ...(scenarioPath(record.path) !== undefined ? { path: scenarioPath(record.path) } : {}),
    ...(scenarioPath(record.state_path) !== undefined ? { state_path: scenarioPath(record.state_path) } : {}),
    ...(scenarioPathList(record.documents) !== undefined ? { documents: scenarioPathList(record.documents) } : {}),
    ...(scenarioPathList(record.validation) !== undefined ? { validation: scenarioPathList(record.validation) } : {}),
    ...(scenarioPathList(record.history) !== undefined ? { history: scenarioPathList(record.history) } : {}),
    ...(scenarioPathList(record.handoff) !== undefined ? { handoff: scenarioPathList(record.handoff) } : {}),
    ...(scenarioPathList(record.checkpoints) !== undefined ? { checkpoints: scenarioPathList(record.checkpoints) } : {}),
    ...(scenarioPathList(record.evidence) !== undefined ? { evidence: scenarioPathList(record.evidence) } : {}),
  };
  return Object.keys(result).length === 0 ? undefined : result;
}

function readScenarioTranscript(raw: unknown): ScenarioTranscriptExpectations | undefined {
  const record = asRecord(raw);
  if (record === null) return undefined;
  const result: ScenarioTranscriptExpectations = {
    ...(scenarioPathList(record.checkpoints) !== undefined ? { checkpoints: scenarioPathList(record.checkpoints) } : {}),
    ...(scenarioPathList(record.workers) !== undefined ? { workers: scenarioPathList(record.workers) } : {}),
    ...(scenarioPathList(record.validation) !== undefined ? { validation: scenarioPathList(record.validation) } : {}),
    ...(scenarioPathList(record.history) !== undefined ? { history: scenarioPathList(record.history) } : {}),
    ...(scenarioPathList(record.handoff) !== undefined ? { handoff: scenarioPathList(record.handoff) } : {}),
    ...(scenarioPathList(record.interruption) !== undefined ? { interruption: scenarioPathList(record.interruption) } : {}),
    ...(scenarioPathList(record.resume) !== undefined ? { resume: scenarioPathList(record.resume) } : {}),
    ...(scenarioPathList(record.next_actions) !== undefined ? { next_actions: scenarioPathList(record.next_actions) } : {}),
  };
  return Object.keys(result).length === 0 ? undefined : result;
}

function readScenarioRef(raw: unknown): ReportScenarioReference | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const record = raw as Record<string, unknown>;
  const id = scenarioPath(record.id) ?? 'unknown';
  const title = scenarioPath(record.title);
  const selectorsRecord = asRecord(record.selectors);
  const featureId = nonEmptyString(selectorsRecord?.['feature_id']);
  const runKey = nonEmptyString(selectorsRecord?.['run_key']);
  const selectorFieldsPresent = selectorsRecord !== null && (hasOwn(selectorsRecord, 'feature_id') || hasOwn(selectorsRecord, 'run_key'));
  if (selectorFieldsPresent && (featureId === null || runKey === null || !safeFeatureId(featureId) || !safeRunKey(runKey))) {
    throw new ReportSelectorResolutionError('invalid', 'scenario selectors must be bounded safe feature_id/run_key values');
  }
  const selectors = featureId !== null && runKey !== null
    ? { feature_id: featureId, run_key: runKey }
    : undefined;
  const invalidDeclarations: string[] = [];
  const workspaceRecord = asRecord(record.workspace);
  if (record.workspace !== undefined && workspaceRecord === null) invalidDeclarations.push('workspace');
  for (const key of ['path', 'state_path', 'documents', 'validation', 'history', 'handoff', 'checkpoints', 'evidence'] as const) {
    if (workspaceRecord !== null && hasOwn(workspaceRecord, key) && (key === 'path' || key === 'state_path' ? scenarioPath(workspaceRecord[key]) === undefined : scenarioPathList(workspaceRecord[key]) === undefined)) invalidDeclarations.push(`workspace.${key}`);
  }
  const transcriptRecord = asRecord(record.transcript);
  if (record.transcript !== undefined && transcriptRecord === null) invalidDeclarations.push('transcript');
  for (const key of ['checkpoints', 'workers', 'validation', 'history', 'handoff', 'interruption', 'resume', 'next_actions'] as const) {
    if (transcriptRecord !== null && hasOwn(transcriptRecord, key) && scenarioPathList(transcriptRecord[key]) === undefined) invalidDeclarations.push(`transcript.${key}`);
  }
  const workspace = readScenarioWorkspace(record.workspace);
  const transcript = readScenarioTranscript(record.transcript);
  return {
    id,
    ...(title !== undefined ? { title } : {}),
    ...(selectors !== undefined ? { selectors } : {}),
    ...(workspace !== undefined ? { workspace } : {}),
    ...(transcript !== undefined ? { transcript } : {}),
    ...(invalidDeclarations.length > 0 ? { invalid_declarations: invalidDeclarations } : {}),
  };
}
interface DeclaredScenarioEvidence {
  readonly observed: string[];
  readonly missing: number;
}

function declaredScenarioEvidencePaths(
  scratchDir: string,
  scenario: ReportScenarioReference | null,
): DeclaredScenarioEvidence {
  if (scenario === null) return { observed: [], missing: 0 };
  const declared: unknown[] = [];
  const workspace = scenario.workspace;
  const transcript = scenario.transcript;
  if (workspace !== undefined) {
    declared.push(
      workspace.state_path,
      ...(workspace.documents ?? []),
      ...(workspace.validation ?? []),
      ...(workspace.history ?? []),
      ...(workspace.handoff ?? []),
      ...(workspace.checkpoints ?? []),
      ...(workspace.evidence ?? []),
    );
  }
  if (transcript !== undefined) {
    declared.push(
      ...(transcript.checkpoints ?? []),
      ...(transcript.workers ?? []),
      ...(transcript.validation ?? []),
      ...(transcript.history ?? []),
      ...(transcript.handoff ?? []),
      ...(transcript.interruption ?? []),
      ...(transcript.resume ?? []),
      ...(transcript.next_actions ?? []),
    );
  }
  const observed: string[] = [];
  let missing = scenario.invalid_declarations?.length ?? 0;
  for (const value of declared) {
    if (typeof value !== 'string' || value.length === 0 || value.length > 2048) {
      missing += 1;
      continue;
    }
    const absolute = resolve(scratchDir, value);
    if (isCredentialBearingEvidence(scratchDir, absolute)) {
      missing += 1;
      continue;
    }
    if (projectRelative(scratchDir, absolute) === null || !boundedReadableFile(absolute)) {
      missing += 1;
      continue;
    }
    observed.push(absolute);
  }
  return { observed: [...new Set(observed)].sort(), missing };
}
function hasSymlinkAncestor(scratchDir: string, absolutePath: string): boolean {
  const projectPath = projectRelative(scratchDir, absolutePath);
  if (projectPath === null) return false;
  let current = resolve(scratchDir);
  for (const segment of projectPath.split('/')) {
    current = join(current, segment);
    try {
      if (lstatSync(current).isSymbolicLink()) return true;
    } catch {
      return false;
    }
  }
  return false;
}
function assertPassReadiness(
  scratchDir: string,
  rawSession: RawSessionJson,
  declaredEvidence: DeclaredScenarioEvidence,
  screenshots: readonly string[],
  candidates: readonly string[],
  requiredEvidence: readonly string[],
): void {
  const status = rawSessionStatus(rawSession);
  const stoppedAt = rawLifecycleTimestamp(rawSession, 'stopped_at');
  const finishedAt = rawLifecycleTimestamp(rawSession, 'finished_at');
  const shutdownCompletedAt = rawLifecycleTimestamp(rawSession, 'shutdown_completed_at');
  const shutdownError = rawShutdownError(rawSession);
  if (status !== 'stopped'
    || rawSession.pty_exit_observed !== true
    || stoppedAt === null
    || finishedAt === null
    || shutdownCompletedAt === null
    || stoppedAt !== finishedAt
    || stoppedAt !== shutdownCompletedAt
    || shutdownError !== null) {
    throw new Error('ux-e2e: PASS requires a stopped session with exact shutdown proof and no shutdown error');
  }
  if (declaredEvidence.missing > 0) {
    throw new Error(`ux-e2e: PASS requires all declared scenario evidence (${String(declaredEvidence.missing)} missing)`);
  }
  const missingScreenshots = screenshots.filter(path => {
    const absolute = resolve(path);
    if (isCredentialBearingEvidence(scratchDir, absolute) || projectRelative(scratchDir, absolute) === null || hasSymlinkAncestor(scratchDir, absolute)) return true;
    try {
      const info = lstatSync(absolute);
      if (info.isSymbolicLink() || !info.isFile()) return true;
    } catch {
      return true;
    }
    return !boundedReadableFile(absolute);
  });
  if (missingScreenshots.length > 0) {
    throw new Error(`ux-e2e: PASS requires all declared screenshots (${String(missingScreenshots.length)} missing)`);
  }

  const required = new Set(requiredEvidence.map(path => resolve(path)));
  const candidateSet = new Set(candidates);
  if ([...required].some(path => !candidateSet.has(path))) {
    throw new Error('ux-e2e: PASS requires all declared evidence within the evidence file limit');
  }
  let totalBytes = 0;
  for (const path of candidates) {
    const size = boundedFileSize(path);
    if (size === null) {
      if (required.has(path)) {
        throw new Error('ux-e2e: PASS requires all mandatory evidence to be bounded and readable');
      }
      continue;
    }
    if (size > MAX_EVIDENCE_BYTES - totalBytes) {
      if (required.has(path)) {
        throw new Error('ux-e2e: PASS requires all declared evidence within the aggregate evidence byte limit');
      }
      continue;
    }
    totalBytes += size;
  }
}


/* ------------------------------------------------------------------ */
/* Markdown                                                            */
/* ------------------------------------------------------------------ */

function formatTty(tty: ReportSessionMeta['tty']): string {
  return `${tty.cols}x${tty.rows} ${tty.term}`;
}

function renderMarkdown(report: UxE2eReport): string {
  const lines: string[] = [];
  lines.push(`# UX E2E Report — ${sanitizeMarkdownInline(report.session.slug)}`);
  lines.push('');
  lines.push(`**Verdict:** ${report.verdict}  `);
  lines.push(`**Overall:** ${report.overall.score.toFixed(1)}/5 — ${report.overall.recommendation}  `);
  lines.push(`**Generated:** ${sanitizeMarkdownInline(report.generated_at)}`);
  lines.push('');
  lines.push('## Session');
  lines.push('');
  lines.push(`- status: \`${sanitizeMarkdownInline(report.session.status ?? 'unknown')}\``);
  lines.push(`- stopped: \`${sanitizeMarkdownInline(report.session.stopped_at ?? 'n/a')}\``);
  if (report.session.shutdown_error !== null) {
    lines.push(`- shutdown error: ${sanitizeMarkdownInline(report.session.shutdown_error)}`);
  }
  lines.push(`- slug: \`${sanitizeMarkdownInline(report.session.slug)}\``);
  lines.push(`- scratch dir: \`${sanitizeMarkdownInline(report.session.scratch_dir)}\``);
  lines.push(`- omp version: \`${sanitizeMarkdownInline(report.session.omp_version)}\``);
  lines.push(`- profile: \`${sanitizeMarkdownInline(report.session.profile)}\``);
  lines.push(`- tty: \`${sanitizeMarkdownInline(formatTty(report.session.tty))}\``);
  lines.push(`- started: \`${sanitizeMarkdownInline(report.session.started_at ?? 'n/a')}\``);
  lines.push(`- finished: \`${sanitizeMarkdownInline(report.session.finished_at ?? 'n/a')}\``);
  if (report.session.scenario !== null) {
    lines.push(`- scenario: \`${sanitizeMarkdownInline(report.session.scenario.id)}\`${report.session.scenario.title !== undefined ? ` — ${sanitizeMarkdownInline(report.session.scenario.title)}` : ''}`);
  }
  if (report.session.selectors !== undefined) {
    lines.push(`- feature_id: \`${sanitizeMarkdownInline(report.session.selectors.feature_id ?? 'n/a')}\``);
    lines.push(`- run_key: \`${sanitizeMarkdownInline(report.session.selectors.run_key ?? 'n/a')}\``);
  }
  if (report.session.workspace !== undefined) {
    const workspace = report.session.workspace;
    lines.push(`- specification workspace: \`${sanitizeMarkdownInline(workspace.path)}\``);
    lines.push(`- specification state: \`${sanitizeMarkdownInline(workspace.state_path)}\``);
  }
  if (report.session.next_action !== undefined) {
    const action = report.session.next_action;
    lines.push(`- next action: \`${sanitizeMarkdownInline(action.kind)}\`${action.command !== null ? ` — \`${sanitizeMarkdownInline(action.command)}\`` : ''}${action.reason !== null ? ` — ${sanitizeMarkdownInline(action.reason)}` : ''}`);
  }
  if (report.session.child_sessions !== undefined) {
    lines.push('## Child sessions');
    lines.push('');
    for (const child of report.session.child_sessions) {
      lines.push('### ' + sanitizeMarkdownInline(child.slug));
      lines.push('');
      lines.push('- status: `' + sanitizeMarkdownInline(child.status ?? 'unknown') + '`');
      lines.push('- verdict: `' + sanitizeMarkdownInline(child.verdict) + '`');
      lines.push('- scratch dir: `' + sanitizeMarkdownInline(child.scratch_dir) + '`');
      lines.push('- transcript: `' + sanitizeMarkdownInline(child.transcript) + '`');
      if (child.scenario !== null) lines.push('- scenario: `' + sanitizeMarkdownInline(child.scenario.id) + '`');
      if (child.evidence.length > 0) {
        lines.push('- evidence:');
        for (const evidence of child.evidence) lines.push('  - `' + sanitizeMarkdownInline(evidence) + '`');
      }
      lines.push('');
    }
  }
  if (report.session.task_prompt !== null) {
    lines.push('');
    lines.push('### Task prompt');
    lines.push('');
    lines.push('```');
    lines.push(sanitizeMarkdownBlock(report.session.task_prompt.slice(0, 2000)));
    lines.push('```');
  }
  lines.push('');
  if (report.session.workspace !== undefined) {
    const workspace = report.session.workspace;
    lines.push('## Specification evidence');
    lines.push('');
    const groups: ReadonlyArray<readonly [string, readonly string[]]> = [
      ['Documents', workspace.documents],
      ['Validation', workspace.validation],
      ['History', workspace.history],
      ['Handoff', workspace.handoff],
      ['Immutable artifacts', workspace.artifacts],
      ['Checkpoint records', workspace.checkpoints],
      ['Checkpoint transcripts', workspace.checkpoint_transcripts],
    ];
    for (const [label, paths] of groups) {
      if (paths.length === 0) continue;
      lines.push(`### ${label}`);
      lines.push('');
      for (const path of paths) lines.push(`- \`${sanitizeMarkdownInline(path)}\``);
      lines.push('');
    }
    if (workspace.worker_attribution.length > 0) {
      lines.push('### Worker attribution');
      lines.push('');
      for (const worker of workspace.worker_attribution) {
        lines.push(`- \`${sanitizeMarkdownInline(worker.phase ?? 'unknown')}\` / \`${sanitizeMarkdownInline(worker.dispatch_id)}\` — role \`${sanitizeMarkdownInline(worker.role ?? 'unknown')}\`, agent \`${sanitizeMarkdownInline(worker.agent ?? 'unknown')}\` (\`${sanitizeMarkdownInline(worker.evidence)}\`)`);
      }
      lines.push('');
    }
    if (workspace.interruption_resume.length > 0) {
      lines.push('### Interruption and resume');
      lines.push('');
      for (const marker of workspace.interruption_resume) {
        lines.push(`- ${sanitizeMarkdownInline(marker.kind)}: \`${sanitizeMarkdownInline(marker.value)}\` (\`${sanitizeMarkdownInline(marker.evidence)}\`)`);
      }
      lines.push('');
    }
  }
  lines.push('## Overall');
  lines.push('');
  lines.push(`**Score:** ${report.overall.score.toFixed(1)}/5  `);
  lines.push(`**Recommendation:** ${report.overall.recommendation}`);
  lines.push('');
  lines.push(sanitizeMarkdownBlock(report.overall.summary));
  lines.push('');
  if (report.regressions.length > 0) {
    lines.push('## Regressions');
    lines.push('');
    for (const r of report.regressions) lines.push(`- ${sanitizeMarkdownBlock(r)}`);
    lines.push('');
  }
  lines.push('## Steps');
  lines.push('');
  lines.push('| # | Step | Rating | Defects |');
  lines.push('|---|------|--------|---------|');
  for (const step of report.steps) {
    const ratings = UX_DIMENSIONS.filter(d => step.ratings[d] !== undefined)
      .map(d => `${d}: ${String(step.ratings[d])}`)
      .join(', ');
    lines.push(`| ${step.order} | ${sanitizeMarkdownInline(step.name)} | ${ratings || 'n/a'} | ${step.defects.map(sanitizeMarkdownInline).join(', ') || '—'} |`);
  }
  lines.push('');
  lines.push('## Defects');
  lines.push('');
  if (report.defects.length === 0) {
    lines.push('No defects recorded.');
  } else {
    for (const d of report.defects) {
      lines.push(`### ${sanitizeMarkdownInline(d.id)} [${d.severity}] ${sanitizeMarkdownInline(d.title)}`);
      lines.push('');
      lines.push(`- dimension: \`${sanitizeMarkdownInline(d.dimension)}\``);
      lines.push(`- step: \`${sanitizeMarkdownInline(d.step)}\``);
      if (d.repro !== undefined) lines.push(`- repro: \`${sanitizeMarkdownInline(d.repro)}\``);
      if (d.notes !== undefined) lines.push(`- notes: ${sanitizeMarkdownBlock(d.notes)}`);
      if (d.evidence.length > 0) {
        lines.push('');
        lines.push('Evidence:');
        for (const e of d.evidence) lines.push(`  - \`${sanitizeMarkdownInline(e)}\``);
      }
      lines.push('');
    }
  }
  lines.push('## Agent quality');
  lines.push('');
  lines.push(`**Rating:** ${report.agent_quality.rating}/5  `);
  lines.push('');
  lines.push(sanitizeMarkdownBlock(report.agent_quality.rationale));
  if (report.agent_quality.dimensions !== undefined) {
    lines.push('');
    for (const dim of AGENT_DIMENSIONS) {
      const v = report.agent_quality.dimensions[dim];
      if (v !== undefined) lines.push(`- ${dim}: ${v}`);
    }
  }
  lines.push('');
  lines.push('## Evidence');
  lines.push('');
  for (const e of report.evidence) lines.push(`- \`${sanitizeMarkdownInline(e)}\``);
  lines.push('');
  return lines.join('\n');
}

/* ------------------------------------------------------------------ */
/* generateReport                                                      */
/* ------------------------------------------------------------------ */

function todayStamp(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Build the ux-e2e report from structured step/defect input, clamping
 * ratings against defect floors, and write both the JSON report and a
 * manual_qa-compatible markdown.
 *
 * @param sessionDir Scratch project directory (the `<scratch>` in the
 *                   contract — session.json lives under its `.work-state`).
 */
interface InternalGenerateReportOptions extends GenerateReportOptions {
  readonly writeOutputs?: boolean;
  readonly evidenceTargetDir?: string;
  readonly retainedRoot?: PinnedDirectory;
  readonly retainedReportRoot?: PinnedDirectory;
  readonly retainedEvidenceRoot?: PinnedDirectory;
}

interface InternalGenerateReportResult extends GenerateReportResult {
  readonly report: UxE2eReport;
}

function generateSingleReport(
  sessionDir: string,
  input: ReportInput,
  opts: InternalGenerateReportOptions = {},
  expectedDiscovery?: SuiteDiscovery,
): InternalGenerateReportResult {
  const scratchDir = resolve(sessionDir);
  const scratchRoot = expectedDiscovery?.root ?? opts.retainedRoot ?? pinDirectory(scratchDir);
  const ownsScratchRoot = expectedDiscovery === undefined && opts.retainedRoot === undefined;
  const ownsReportDestination = opts.retainedReportRoot === undefined;
  if (scratchRoot === null) throw new Error('ux-e2e: session root must be a stable directory');
  let stateDestination: PinnedDirectory | null = null;
  const createdEvidence = new Map<string, Buffer>();
  const createdEvidenceRoots = new Map<string, PinnedDirectory>();
  const retainedEvidenceRoots: PinnedDirectory[] = [];
  const retainedEvidenceDestinationRoots = new Set<PinnedDirectory>();
  const rollbackEvidence = (): void => {
    for (const [path, bytes] of createdEvidence) {
      const retainedParent = createdEvidenceRoots.get(path);
      if (retainedParent !== undefined) {
        unlinkPinnedFileIfExact(retainedParent, basename(path), bytes, { requireStable: false });
        continue;
      }
      const parent = pinDirectory(dirname(path));
      if (parent === null) continue;
      try { unlinkPinnedFileIfExact(parent, basename(path), bytes, { requireStable: false }); } finally { closePinnedDirectory(parent); }
    }
  };
  try {
    const warnings: string[] = [];
  const rawSession = readSessionMeta(scratchDir);
  const rawSlug = typeof rawSession.slug === 'string' && rawSession.slug.length > 0 ? rawSession.slug : null;
  const slug = rawSlug ?? (basename(scratchDir).replace(/^omp-ux-e2e-/u, '') || 'ux-e2e');
  if (!safeFilenameSegment(slug)) {
    throw new Error('ux-e2e: session slug must be a bounded safe filename segment');
  }

  // Assign stable ids when the caller omitted them.
  const defects: UxDefect[] = input.defects.map((d, i) => ({
    ...d,
    id: d.id ?? `D${i + 1}`,
  }));
  const steps: UxStep[] = input.steps.map((s, i) => ({
    ...s,
    id: s.id ?? `S${i + 1}`,
  }));

  // Clamp step ratings against the worst defect floor per step.
  const clampedSteps: UxStep[] = steps.map(step => {
    const floor = floorForStep(defects, step.id);
    const ratings: Partial<Record<UxDimension, number>> = {};
    for (const dim of UX_DIMENSIONS) {
      const v = clampRating(step.ratings[dim], floor, warnings, `${step.id}.${dim}`);
      if (v !== undefined) ratings[dim] = v;
    }
    return { ...step, ratings };
  });

  // Overall score: caller's value, else the mean of all step ratings,
  // clamped by the worst defect floor in the whole run.
  const allRatings = clampedSteps.flatMap(s => UX_DIMENSIONS.map(d => s.ratings[d]).filter((v): v is number => v !== undefined));
  let score: number;
  if (input.overall.score !== undefined) {
    score = input.overall.score;
  } else if (allRatings.length > 0) {
    score = allRatings.reduce((a, b) => a + b, 0) / allRatings.length;
  } else {
    // No ratings supplied: neutral-good baseline (no defects -> no floor).
    score = 4;
  }
  const worstFloor = defects.reduce<number>((floor, d) => {
    const f = DEFECT_FLOORS[d.severity] ?? 5;
    return f < floor ? f : floor;
  }, 5);
  score = Math.min(Math.max(score, 1), 5);
  if (score > worstFloor) {
    warnings.push(`overall.score ${score.toFixed(2)} clamped down to defect floor ${worstFloor}`);
    score = worstFloor;
  }

  const recommendation: Recommendation =
    input.overall.recommendation ?? (score >= 4 ? 'ship' : score >= 3 ? 'fix-high' : 'rework');

  const agentRating = Math.min(Math.max(Math.round(input.agent_quality.rating), 0), 5);
  if (agentRating !== input.agent_quality.rating) {
    warnings.push(`agent_quality.rating ${String(input.agent_quality.rating)} clamped to ${agentRating}`);
  }

  const stateDir = join(scratchDir, '.work-state', 'ux-e2e');
  const transcript = join(stateDir, 'transcript.jsonl');
  const eventsJsonl = join(stateDir, 'events.jsonl');
  const sessionJsonl = join(stateDir, 'session.jsonl');

  const declared = declaredSelectorResolution(rawSession);
  const resolvedState = resolveFeatureState(scratchDir, rawSession);
  const selectors: ReportSelectors | undefined = resolvedState === null
    ? (declared.pair === null ? undefined : declared.selectors)
    : { feature_id: resolvedState.feature_id, run_key: resolvedState.run_key };
  const scenario = readScenarioRef(rawSession.scenario);
  if (scenario?.invalid_declarations !== undefined && input.verdict !== 'PASS') warnings.push('ignored malformed scenario declarations: ' + scenario.invalid_declarations.join(', '));
  const collectedWorkspace = resolvedState === null ? undefined : collectWorkspaceEvidence(scratchDir, resolvedState);
  // Scenario workspace/transcript values are declarations only. They remain
  // under session.scenario and become observed evidence only when the bounded
  // collector independently reads the corresponding files.
  const workspace = collectedWorkspace?.report;
  const declaredEvidence = declaredScenarioEvidencePaths(scratchDir, scenario);
  const observedWorkspacePaths = [...new Set([
    ...(collectedWorkspace?.absolute_paths ?? []),
    ...declaredEvidence.observed,
  ])];
  const nextAction = readNextAction(rawSession, resolvedState);

  const screenshots = clampedSteps.flatMap(s => s.screenshots);
  const normalizedScreenshots = screenshots.map(path => normalizeEvidencePath(scratchRoot, path));
  const ompLog = ompLogForSession(scratchDir, rawSession);
  const candidates = evidenceCandidates(scratchDir, normalizedScreenshots, observedWorkspacePaths, ompLog);
  const requiredEvidence = [transcript, ...observedWorkspacePaths, ...normalizedScreenshots];
  if (input.verdict === 'PASS') {
    assertPassReadiness(scratchDir, rawSession, declaredEvidence, normalizedScreenshots, candidates, requiredEvidence);
  }
  const sessionStatus = rawSessionStatus(rawSession);
  const sessionStoppedAt = rawLifecycleTimestamp(rawSession, 'stopped_at');
  const sessionFinishedAt = rawLifecycleTimestamp(rawSession, 'finished_at');
  const sessionShutdownError = rawShutdownError(rawSession);

    const mdDir = resolve(opts.mdDir ?? join(process.cwd(), 'vibe-report'));
    if (expectedDiscovery !== undefined) assertSuiteDiscoveryStable(scratchDir, expectedDiscovery, 'before report output');
    if (!pinnedDirectoryIsStable(scratchRoot)) throw new Error('ux-e2e: session root changed before report output');
    const reportDestination = opts.writeOutputs === false ? null : opts.retainedReportRoot ?? pinOrCreateDirectory(mdDir);
    if (opts.writeOutputs !== false && reportDestination === null) {
      throw new Error('ux-e2e: report destination root must be a stable non-symlink directory');
    }
    try {
      if (!pinnedDirectoryIsStable(scratchRoot)) throw new Error('ux-e2e: session root changed before evidence collection');
      if (expectedDiscovery !== undefined) assertSuiteDiscoveryStable(scratchDir, expectedDiscovery, 'before evidence collection');
      let evidence = collectEvidence(candidates);
      if (input.verdict === 'PASS') {
        assertMandatoryEvidenceReadable(scratchRoot, requiredEvidence, 'after evidence collection');
      }
    if (opts.copyEvidence === true) {
      const evidenceTarget = opts.evidenceTargetDir ?? join(mdDir, 'evidence', slug);
      const evidenceTargetRoot = opts.retainedEvidenceRoot
        ?? (opts.retainedReportRoot !== undefined && opts.evidenceTargetDir === undefined
          ? pinChildDirectory(opts.retainedReportRoot, ['evidence', slug])
          : pinOrCreateDirectory(evidenceTarget));
      if (evidenceTargetRoot === null) throw new Error('ux-e2e: report evidence destination root must be a stable non-symlink directory');
      retainedEvidenceRoots.push(evidenceTargetRoot);
      evidence = copyEvidence(evidence, evidenceTargetRoot.lexicalPath, scratchDir, MAX_EVIDENCE_BYTES, scratchRoot, createdEvidence, createdEvidenceRoots, evidenceTargetRoot, retainedEvidenceDestinationRoots);
    }
    if ([...retainedEvidenceDestinationRoots].some(root => !pinnedDirectoryIsStable(root))) throw new Error('ux-e2e: evidence destination changed before report output');
    const report = sanitizeOutput({
      type: 'ux-e2e',
      schema_version: 1,
      verdict: input.verdict,
      mode: 'ui',
      regressions: [...(input.regressions ?? [])],
      session: {
        slug,
        scratch_dir: scratchDir,
        omp_version: typeof rawSession.omp_version === 'string' ? rawSession.omp_version : 'unknown',
        profile: typeof rawSession.profile === 'string' && rawSession.profile.length > 0 ? rawSession.profile : 'default',
        tty: readTty(rawSession.tty),
        status: sessionStatus,
        started_at: typeof rawSession.started_at === 'string' ? rawSession.started_at : null,
        stopped_at: sessionStoppedAt,
        finished_at: sessionFinishedAt,
        shutdown_error: sessionShutdownError,
        task_prompt: typeof rawSession.task_prompt === 'string' ? sanitizeForJson(rawSession.task_prompt) : null,
        scenario,
        transcript,
        session_jsonl: sessionJsonl,
        events_jsonl: eventsJsonl,
        omp_log: ompLog ?? '',
        ...(selectors !== undefined ? { selectors } : {}),
        ...(workspace !== undefined ? { workspace } : {}),
        ...(nextAction !== undefined ? { next_action: nextAction } : {}),
      },
      steps: clampedSteps,
      defects,
      agent_quality: { ...input.agent_quality, rating: agentRating },
      overall: { score, summary: input.overall.summary, recommendation },
      evidence,
      generated_at: new Date().toISOString(),
    }, '') as UxE2eReport;

    const jsonPath = join(stateDir, 'report.json');
    if (opts.writeOutputs === false) {
      return { jsonPath, mdPath: '', warnings, report };
    }
    const mdFilename = `${slug}-ux-e2e-${todayStamp()}.md`;
    const mdPath = join(mdDir, mdFilename);
    const previousMarkdown = readPinnedFileFull(reportDestination!, mdFilename);
    if (previousMarkdown === null) {
      const existingMarkdown = openPinnedFile(reportDestination!, mdFilename, fsConstants.O_RDONLY);
      if (existingMarkdown !== null || pinnedChildEntryExists(reportDestination!, mdFilename)) {
        if (existingMarkdown !== null) closePinnedFile(existingMarkdown);
        throw new Error('ux-e2e: existing markdown exceeds exact rollback snapshot bound or is unsafe');
      }
    }
      if (expectedDiscovery !== undefined) assertSuiteDiscoveryStable(scratchDir, expectedDiscovery, 'before report JSON output');
      if (!pinnedDirectoryIsStable(scratchRoot)) throw new Error('ux-e2e: session root changed before report JSON output');
      if ([...retainedEvidenceDestinationRoots].some(root => !pinnedDirectoryIsStable(root))) throw new Error('ux-e2e: evidence destination changed before report JSON output');
      if (input.verdict === 'PASS') assertMandatoryEvidenceReadable(scratchRoot, requiredEvidence, 'before first publication');
    let jsonBytes: Buffer | null = null;
    let previousJson: Buffer | null = null;
    stateDestination = pinChildDirectory(scratchRoot, ['.work-state', 'ux-e2e']);
      if (stateDestination === null) {
        throw new Error('ux-e2e: session report directory must be a stable non-symlink directory');
      }
      jsonBytes = Buffer.from(JSON.stringify(report, null, 2) + '\n');
      previousJson = readPinnedFileFull(stateDestination, 'report.json');
      if (previousJson === null) {
        const existingJson = openPinnedFile(stateDestination, 'report.json', fsConstants.O_RDONLY);
        if (existingJson !== null || pinnedChildEntryExists(stateDestination, 'report.json')) {
          if (existingJson !== null) closePinnedFile(existingJson);
          throw new Error('ux-e2e: existing report.json exceeds exact rollback snapshot bound or is unsafe');
        }
      }
      if (!writePinnedFile(stateDestination, 'report.json', jsonBytes) || !pinnedDirectoryIsStable(scratchRoot)) {
        if (unlinkPinnedFileIfExact(stateDestination, 'report.json', jsonBytes, { requireStable: false }) && previousJson !== null) {
          writePinnedFile(stateDestination, 'report.json', previousJson, { requireStable: false });
        }
        throw new Error('ux-e2e: failed to write report.json inside the session directory');
      }

    const rollbackJson = (): void => {
      if (jsonBytes === null) return;
      if (stateDestination === null) return;
      if (unlinkPinnedFileIfExact(stateDestination, 'report.json', jsonBytes, { requireStable: false }) && previousJson !== null) {
        writePinnedFile(stateDestination, 'report.json', previousJson, { requireStable: false });
      }
    };
    try {
      if (reportDestination === null) throw new Error('ux-e2e: report destination root is unavailable');
      if (expectedDiscovery !== undefined) assertSuiteDiscoveryStable(scratchDir, expectedDiscovery, 'before markdown output');
      if (!pinnedDirectoryIsStable(scratchRoot)) throw new Error('ux-e2e: session root changed before markdown output');
      if ([...retainedEvidenceDestinationRoots].some(root => !pinnedDirectoryIsStable(root))) throw new Error('ux-e2e: evidence destination changed before markdown output');
    } catch (error) {
      rollbackJson();
      throw error;
    }
    const markdownBytes = Buffer.from(renderMarkdown(report));
      // previousMarkdown was captured before JSON publication with an exact-size read.
      try {
        if (!writePinnedFile(reportDestination, mdFilename, markdownBytes) || !pinnedDirectoryIsStable(scratchRoot)) {
          throw new Error('ux-e2e: failed to write markdown inside the report destination');
        }
        if (expectedDiscovery !== undefined) assertSuiteDiscoveryStable(scratchDir, expectedDiscovery, 'after report output');
        if ([...retainedEvidenceDestinationRoots].some(root => !pinnedDirectoryIsStable(root))) throw new Error('ux-e2e: evidence destination changed after report output');
        if (input.verdict === 'PASS') assertMandatoryEvidenceReadable(scratchRoot, requiredEvidence, 'after final publication');
      } catch (error) {
        if (unlinkPinnedFileIfExact(reportDestination, mdFilename, markdownBytes, { requireStable: false }) && previousMarkdown !== null) {
          writePinnedFile(reportDestination, mdFilename, previousMarkdown, { requireStable: false });
        }
        rollbackJson();
        throw error;
      }
      return { jsonPath, mdPath, warnings, report };
  } catch (error) {
    rollbackEvidence();
    throw error;
  } finally {
    try {
      if (reportDestination !== null && ownsReportDestination) closeSync(reportDestination.fd);
      if (stateDestination !== null) closeSync(stateDestination.fd);
    } catch {
      /* Ignore cleanup failures. */
    }
    for (const root of createdEvidenceRoots.values()) closePinnedDirectory(root);
    for (const root of retainedEvidenceDestinationRoots) closePinnedDirectory(root);
    for (const root of retainedEvidenceRoots) closePinnedDirectory(root);
    if (ownsScratchRoot) closePinnedDirectory(scratchRoot);
  }
}


const REPORT_LOCK_TIMEOUT_MS = 5000;
const REPORT_LOCK_NAME = '.omp-ux-e2e-report.lock';
function verifiedReportLockEntry(root: PinnedDirectory): boolean {
  try {
    const info = lstatSync(join(root.lexicalPath, REPORT_LOCK_NAME));
    return info.isFile() && !info.isSymbolicLink() && info.nlink === 1 && pinnedDirectoryIsStable(root);
  } catch {
    return false;
  }
}
function comparePinnedRoots(left: PinnedDirectory, right: PinnedDirectory): number {
  if (left.physicalPath < right.physicalPath) return -1;
  if (left.physicalPath > right.physicalPath) return 1;
  if (left.identity.dev !== right.identity.dev) return left.identity.dev < right.identity.dev ? -1 : 1;
  if (left.identity.ino !== right.identity.ino) return left.identity.ino < right.identity.ino ? -1 : 1;
  return 0;
}

const MAX_SUITE_CHILDREN = 64;
const MAX_SUITE_DIRECTORY_ENTRIES = 1024;

interface SuiteChild {
  readonly name: string;
  readonly scratchDir: string;
  readonly childDev: number;
  readonly childIno: number;
  readonly sessionDev: number;
  readonly sessionIno: number;
  readonly sessionDigest: string;
  readonly root: PinnedDirectory;
}

interface RootSessionMarker {
  readonly present: boolean;
  readonly valid: boolean;
  readonly dev: number;
  readonly ino: number;
  readonly digest: string;
}

interface SuiteDiscovery {
  readonly root: PinnedDirectory;
  readonly children: SuiteChild[];
  readonly single: boolean;
  readonly rootSession: RootSessionMarker;
}

function existingPath(path: string): { readonly isDirectory: boolean; readonly isSymbolicLink: boolean; readonly isFile: boolean; readonly dev: number; readonly ino: number } | null {
  try {
    reportTestHooks?.beforeSuitePathStat?.(path);
    const info = lstatSync(path);
    return { isDirectory: info.isDirectory(), isSymbolicLink: info.isSymbolicLink(), isFile: info.isFile(), dev: info.dev, ino: info.ino };
  } catch (error) {
    const code = typeof error === 'object' && error !== null && 'code' in error
      ? (error as { readonly code?: unknown }).code
      : undefined;
    if (code === 'ENOENT' || code === 'ENOTDIR') return null;
    throw error;
  }
}

function sessionDescriptor(sessionPath: string): { readonly dev: number; readonly ino: number; readonly digest: string } | null {
  const parent = pinDirectory(dirname(sessionPath));
  if (parent === null) return null;
  try {
    const bytes = readPinnedFileFull(parent, basename(sessionPath), 1024 * 1024);
    if (bytes === null) return null;
    const info = lstatSync(sessionPath);
    if (info.isSymbolicLink() || !info.isFile() || !pinnedDirectoryIsStable(parent)) return null;
    return { dev: info.dev, ino: info.ino, digest: createHash('sha256').update(bytes).digest('hex') };
  } catch {
    return null;
  } finally {
    closePinnedDirectory(parent);
  }
}

function discoverSuiteChildren(suiteRoot: string): SuiteDiscovery | null {
  const rootSessionPath = join(suiteRoot, '.work-state', 'ux-e2e', 'session.json');
  const rootSessionInfo = existingPath(rootSessionPath);
  const rootDescriptor = rootSessionInfo !== null && rootSessionInfo.isFile && !rootSessionInfo.isSymbolicLink
    ? sessionDescriptor(rootSessionPath)
    : null;
  const rootSession = rootDescriptor !== null && readSessionMeta(suiteRoot).schema_version === 2;
  const rootSessionMarker: RootSessionMarker = {
    present: rootSessionInfo !== null,
    valid: rootSession,
    dev: rootDescriptor?.dev ?? rootSessionInfo?.dev ?? 0,
    ino: rootDescriptor?.ino ?? rootSessionInfo?.ino ?? 0,
    digest: rootDescriptor?.digest ?? '',
  };
  const root = pinDirectory(suiteRoot);
  if (root === null) return null;
  let retainRoot = false;
  const children: SuiteChild[] = [];
  try {
    if (!pinnedDirectoryIsStable(root)) throw new Error('ux-e2e: suite root changed during child enumeration');
    const names: string[] = [];
    let entryCount = 0;
    const handle = opendirSync(root.lexicalPath);
    try {
      for (;;) {
        const entry = handle.readSync();
        if (entry === null) break;
        if (entry.name === REPORT_LOCK_NAME) {
          if (!entry.isFile() || !verifiedReportLockEntry(root)) {
            throw new Error('ux-e2e: reserved report lock entry is not a verified harness lock file');
          }
          continue;
        }
        entryCount += 1;
        if (entryCount > MAX_SUITE_DIRECTORY_ENTRIES) throw new Error('ux-e2e: suite has too many immediate directory entries');
        if (entry.isSymbolicLink()) {
          if (rootSession) continue;
          throw new Error('ux-e2e: suite child ' + entry.name + ' must not be a symlink');
        }
        if (entry.isDirectory()) names.push(entry.name);
      }
    } finally {
      try { handle.closeSync(); } catch { /* best effort */ }
    }
    names.sort();
    for (const name of names) {
      const child = join(suiteRoot, name);
      const childState = join(child, '.work-state', 'ux-e2e');
      const stateInfo = existingPath(childState);
      // Ordinary real directories (for example .git or report output) do not
      // claim session ownership and are intentionally ignored.
      if (stateInfo === null) continue;
      if (stateInfo.isSymbolicLink || !stateInfo.isDirectory) throw new Error('ux-e2e: malformed suite child ' + name + ' state directory');
      if (!safeFilenameSegment(name)) throw new Error('ux-e2e: suite child name is unsafe: ' + name);
      if (children.length >= MAX_SUITE_CHILDREN) throw new Error('ux-e2e: suite has more than ' + String(MAX_SUITE_CHILDREN) + ' child sessions');
      const sessionPath = join(childState, 'session.json');
      const sessionInfo = existingPath(sessionPath);
      if (sessionInfo === null || sessionInfo.isSymbolicLink || !sessionInfo.isFile) {
        throw new Error('ux-e2e: malformed suite child ' + name + ' session metadata');
      }
      const descriptor = sessionDescriptor(sessionPath);
      if (descriptor === null || readSessionMeta(child).schema_version !== 2) throw new Error('ux-e2e: malformed suite child ' + name + ' session metadata');
      const childInfo = existingPath(child);
      if (childInfo === null || childInfo.isSymbolicLink || !childInfo.isDirectory) throw new Error('ux-e2e: malformed suite child ' + name + ' directory');
      const childRoot = pinDirectory(child);
      if (childRoot === null) throw new Error('ux-e2e: malformed suite child ' + name + ' directory');
      children.push({ name, scratchDir: resolve(child), childDev: childInfo.dev, childIno: childInfo.ino, sessionDev: descriptor.dev, sessionIno: descriptor.ino, sessionDigest: descriptor.digest, root: childRoot });
    }
    if (!pinnedDirectoryIsStable(root)) throw new Error('ux-e2e: suite root changed during child enumeration');
    if (rootSession && children.length > 0) throw new Error('ux-e2e: ambiguous suite root and child session ownership');
    if (children.length === 0) {
      retainRoot = true;
      return { root, children, single: true, rootSession: rootSessionMarker };
    }
    retainRoot = true;
    return { root, children, single: false, rootSession: rootSessionMarker };
  } finally {
    if (!retainRoot) {
      for (const child of children) closePinnedDirectory(child.root);
      closePinnedDirectory(root);
    }
  }
}

function closeSuiteDiscovery(discovery: SuiteDiscovery): void {
  for (const child of discovery.children) closePinnedDirectory(child.root);
  closePinnedDirectory(discovery.root);
}

function sameSuiteChildren(left: readonly SuiteChild[], right: readonly SuiteChild[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((child, index) => {
    const other = right[index];
    return other !== undefined
      && child.name === other.name
      && child.childDev === other.childDev
      && child.childIno === other.childIno
      && child.sessionDev === other.sessionDev
      && child.sessionIno === other.sessionIno
      && child.sessionDigest === other.sessionDigest;
  });
}

function sameRootSessionMarker(left: RootSessionMarker, right: RootSessionMarker): boolean {
  return left.present === right.present
    && left.valid === right.valid
    && left.dev === right.dev
    && left.ino === right.ino
    && left.digest === right.digest;
}

function assertSuiteDiscoveryStable(suiteRoot: string, expected: SuiteDiscovery, phase: string): void {
  if (!pinnedDirectoryIsStable(expected.root)) throw new Error(`ux-e2e: suite root changed ${phase}`);
  const current = discoverSuiteChildren(suiteRoot);
  if (current === null) throw new Error(`ux-e2e: suite child membership changed ${phase}`);
  try {
    if (!pinnedDirectoryIsStable(expected.root) || expected.single !== current.single || !sameRootSessionMarker(expected.rootSession, current.rootSession) || !sameSuiteChildren(expected.children, current.children)) {
      throw new Error(`ux-e2e: suite child membership changed ${phase}`);
    }
  } finally {
    closeSuiteDiscovery(current);
  }
}
function childSessionEntry(report: UxE2eReport, evidence: readonly string[]): ReportChildSession {
  return {
    slug: report.session.slug,
    scratch_dir: report.session.scratch_dir,
    status: report.session.status,
    scenario: report.session.scenario,
    transcript: report.session.transcript,
    session_jsonl: report.session.session_jsonl,
    events_jsonl: report.session.events_jsonl,
    omp_log: report.session.omp_log,
    evidence: [...evidence],
    verdict: report.verdict,
    overall: report.overall,
    ...(report.session.selectors !== undefined ? { selectors: report.session.selectors } : {}),
    ...(report.session.workspace !== undefined ? { workspace: report.session.workspace } : {}),
    ...(report.session.next_action !== undefined ? { next_action: report.session.next_action } : {}),
  };
}

function writeSuiteReport(
  suiteRoot: string,
  discovery: SuiteDiscovery,
  mdDir: string,
  report: UxE2eReport,
  warnings: readonly string[],
  retainedEvidenceDestinationRoots: Iterable<PinnedDirectory>,
  mandatoryEvidence: readonly { readonly root: PinnedDirectory; readonly paths: readonly string[] }[],
  retainedReportRoot?: PinnedDirectory,
): GenerateReportResult {
  const suiteRootHandle = discovery.root;
  if (!pinnedDirectoryIsStable(suiteRootHandle)) throw new Error('ux-e2e: suite root changed before report output');
  const reportRoot = retainedReportRoot ?? pinOrCreateDirectory(mdDir);
  const ownsReportRoot = retainedReportRoot === undefined;
  if (reportRoot === null) throw new Error('ux-e2e: report destination root must be a stable non-symlink directory');
  let stateRoot: PinnedDirectory | null = null;
  let jsonTouched = false;
  let markdownTouched = false;
  let jsonBytes: Buffer | null = null;
  let markdownBytes: Buffer | null = null;
  let previousJson: Buffer | null = null;
  let previousMarkdown: Buffer | null = null;
  let mdFilename = '';
  const assertEvidenceDestinationsStable = (phase: string): void => {
    for (const root of retainedEvidenceDestinationRoots) {
      if (!pinnedDirectoryIsStable(root)) throw new Error(`ux-e2e: evidence destination changed ${phase}`);
    }
  };
  const assertMandatoryEvidenceStable = (phase: string): void => {
    for (const entry of mandatoryEvidence) assertMandatoryEvidenceReadable(entry.root, entry.paths, phase);
  };
  const rollback = (): void => {
    if (markdownTouched && markdownBytes !== null) {
      if (unlinkPinnedFileIfExact(reportRoot, mdFilename, markdownBytes, { requireStable: false }) && previousMarkdown !== null) writePinnedFile(reportRoot, mdFilename, previousMarkdown, { requireStable: false });
    }
    if (stateRoot !== null && jsonTouched && jsonBytes !== null) {
      if (unlinkPinnedFileIfExact(stateRoot, 'report.json', jsonBytes, { requireStable: false }) && previousJson !== null) writePinnedFile(stateRoot, 'report.json', previousJson, { requireStable: false });
    }
  };
  try {
    const stateDir = join(suiteRoot, '.work-state', 'ux-e2e');
    stateRoot = pinChildDirectory(suiteRootHandle, ['.work-state', 'ux-e2e']);
    if (stateRoot === null) throw new Error('ux-e2e: suite report directory must be a stable non-symlink directory');
    jsonBytes = Buffer.from(JSON.stringify(report, null, 2) + '\n');
    mdFilename = report.session.slug + '-ux-e2e-' + todayStamp() + '.md';
    markdownBytes = Buffer.from(renderMarkdown(report));
    previousJson = readPinnedFileFull(stateRoot, 'report.json');
    if (previousJson === null) {
      const existingJson = openPinnedFile(stateRoot, 'report.json', fsConstants.O_RDONLY);
      if (existingJson !== null || pinnedChildEntryExists(stateRoot, 'report.json')) {
        if (existingJson !== null) closePinnedFile(existingJson);
        throw new Error('ux-e2e: existing report.json exceeds exact rollback snapshot bound or is unsafe');
      }
    }
    previousMarkdown = readPinnedFileFull(reportRoot, mdFilename);
    if (previousMarkdown === null) {
      const existingMarkdown = openPinnedFile(reportRoot, mdFilename, fsConstants.O_RDONLY);
      if (existingMarkdown !== null || pinnedChildEntryExists(reportRoot, mdFilename)) {
        if (existingMarkdown !== null) closePinnedFile(existingMarkdown);
        throw new Error('ux-e2e: existing markdown exceeds exact rollback snapshot bound or is unsafe');
      }
    }
    assertSuiteDiscoveryStable(suiteRoot, discovery, 'before report JSON output');
    assertEvidenceDestinationsStable('before suite report JSON output');
    if (report.verdict === 'PASS') assertMandatoryEvidenceStable('before first suite publication');
    jsonTouched = true;
    if (!writePinnedFile(stateRoot, 'report.json', jsonBytes)) throw new Error('ux-e2e: failed to write suite report.json');
    assertSuiteDiscoveryStable(suiteRoot, discovery, 'after report JSON output');
    assertEvidenceDestinationsStable('after suite report JSON output');
    assertSuiteDiscoveryStable(suiteRoot, discovery, 'before report markdown output');
    assertEvidenceDestinationsStable('before suite report markdown output');
    markdownTouched = true;
    if (!writePinnedFile(reportRoot, mdFilename, markdownBytes)) throw new Error('ux-e2e: failed to write suite markdown report');
    assertSuiteDiscoveryStable(suiteRoot, discovery, 'after report output');
    assertEvidenceDestinationsStable('after suite report markdown output');
    if (report.verdict === 'PASS') assertMandatoryEvidenceStable('after final suite publication');
    return { jsonPath: join(stateDir, 'report.json'), mdPath: join(mdDir, mdFilename), warnings: [...warnings] };
  } catch (error) {
    rollback();
    throw error;
  } finally {
    if (stateRoot !== null) closeSync(stateRoot.fd);
    if (ownsReportRoot) closeSync(reportRoot.fd);
  }
}
function generateSuiteReport(
  suiteRoot: string,
  discovery: SuiteDiscovery,
  input: ReportInput,
  opts: InternalGenerateReportOptions,
): GenerateReportResult {
  const children = discovery.children;
  const childReports: Array<{ readonly child: SuiteChild; readonly result: InternalGenerateReportResult }> = [];
  const warnings: string[] = [];
  for (const child of children) {
    const result = generateSingleReport(child.scratchDir, input, { ...opts, copyEvidence: false, writeOutputs: false, retainedRoot: child.root });
    childReports.push({ child, result });
    warnings.push(...result.warnings.map(warning => child.name + ': ' + warning));
  }
  const copiedEvidence = new Map<string, Buffer>();
  const copiedEvidenceRoots = new Map<string, PinnedDirectory>();
  const retainedEvidenceRoots: PinnedDirectory[] = [];
  const retainedEvidenceDestinationRoots = new Set<PinnedDirectory>();
  const rollbackCopiedEvidence = (): void => {
    for (const [path, bytes] of copiedEvidence) {
      const retainedParent = copiedEvidenceRoots.get(path);
      if (retainedParent !== undefined) {
        unlinkPinnedFileIfExact(retainedParent, basename(path), bytes, { requireStable: false });
        continue;
      }
      const parent = pinDirectory(dirname(path));
      if (parent === null) continue;
      try { unlinkPinnedFileIfExact(parent, basename(path), bytes, { requireStable: false }); } finally { closePinnedDirectory(parent); }
    }
  };
  try {
  const mdDir = resolve(opts.mdDir ?? join(process.cwd(), 'vibe-report'));
  const childEntries: ReportChildSession[] = [];
  const aggregateEvidence: string[] = [];
  let aggregateEvidenceBytes = 0;
  let aggregateEvidenceFiles = 0;
  for (const { child, result } of childReports) {
    let childEvidenceBytes = 0;
    if (input.verdict === 'PASS') {
      assertMandatoryEvidenceReadable(child.root, mandatoryEvidencePaths(result.report), 'after suite evidence collection');
    }
    if (result.report.evidence.length > MAX_SUITE_EVIDENCE_FILES - aggregateEvidenceFiles) throw new Error('ux-e2e: suite has too many evidence files');
    for (const evidencePath of result.report.evidence) {
      const size = boundedFileSize(evidencePath);
      if (size === null) continue;
      if (size > MAX_SUITE_EVIDENCE_BYTES - aggregateEvidenceBytes - childEvidenceBytes) {
        throw new Error('ux-e2e: suite evidence exceeds the aggregate byte limit');
      }
      childEvidenceBytes += size;
    }
    let childEvidence: string[];
    if (opts.copyEvidence === true) {
      const targetRoot = opts.retainedReportRoot !== undefined
        ? pinChildDirectory(opts.retainedReportRoot, ['evidence', child.name])
        : pinOrCreateDirectory(join(mdDir, 'evidence', child.name));
      if (targetRoot === null) throw new Error('ux-e2e: report evidence destination root must be a stable non-symlink directory');
      retainedEvidenceRoots.push(targetRoot);
      childEvidence = copyEvidence(result.report.evidence, targetRoot.lexicalPath, child.scratchDir, MAX_SUITE_EVIDENCE_BYTES - aggregateEvidenceBytes, child.root, copiedEvidence, copiedEvidenceRoots, targetRoot, retainedEvidenceDestinationRoots);
    } else {
      childEvidence = [...result.report.evidence];
    }
    aggregateEvidenceBytes += childEvidenceBytes;
    if (childEvidence.length > MAX_SUITE_EVIDENCE_FILES - aggregateEvidenceFiles) throw new Error('ux-e2e: suite has too many evidence files');
    aggregateEvidenceFiles += childEvidence.length;
    childEntries.push(childSessionEntry(result.report, childEvidence));
    aggregateEvidence.push(...childEvidence);
  }
  const first = childReports[0]?.result.report;
  if (first === undefined) throw new Error('ux-e2e: suite has no child sessions');
  const rootSlug = basename(resolve(suiteRoot)).replace(/^omp-ux-e2e-/u, '') || 'ux-e2e-suite';
  if (!safeFilenameSegment(rootSlug)) throw new Error('ux-e2e: suite root slug must be a bounded safe filename segment');
  const currentDiscovery = discoverSuiteChildren(suiteRoot);
  if (currentDiscovery === null) throw new Error('ux-e2e: suite child membership changed before report output');
  try {
    if (!pinnedDirectoryIsStable(discovery.root) || !sameSuiteChildren(discovery.children, currentDiscovery.children)) {
      throw new Error('ux-e2e: suite child membership changed before report output');
    }
  } finally {
    closeSuiteDiscovery(currentDiscovery);
  }
  if ([...retainedEvidenceDestinationRoots].some(root => !pinnedDirectoryIsStable(root))) throw new Error('ux-e2e: evidence destination changed before suite report output');
  const report = sanitizeOutput({
    type: 'ux-e2e',
    schema_version: 1,
    verdict: input.verdict,
    mode: 'ui',
    regressions: [...(input.regressions ?? [])],
    session: {
      slug: rootSlug,
      scratch_dir: resolve(suiteRoot),
      omp_version: 'suite',
      profile: 'suite',
      tty: { cols: 0, rows: 0, term: 'unknown' },
      status: null,
      started_at: null,
      stopped_at: null,
      finished_at: null,
      shutdown_error: null,
      task_prompt: null,
      scenario: null,
      transcript: '',
      session_jsonl: '',
      events_jsonl: '',
      omp_log: '',
      child_sessions: childEntries,
    },
    steps: first.steps,
    defects: first.defects,
    agent_quality: first.agent_quality,
    overall: first.overall,
    evidence: aggregateEvidence,
    generated_at: new Date().toISOString(),
  }, '') as UxE2eReport;
  return writeSuiteReport(suiteRoot, discovery, mdDir, report, warnings, retainedEvidenceDestinationRoots,
    childReports.map(({ child, result }) => ({ root: child.root, paths: mandatoryEvidencePaths(result.report) })),
    opts.retainedReportRoot);
  } catch (error) {
    rollbackCopiedEvidence();
    throw error;
  } finally {
    for (const root of copiedEvidenceRoots.values()) closePinnedDirectory(root);
    for (const root of retainedEvidenceDestinationRoots) closePinnedDirectory(root);
    for (const root of retainedEvidenceRoots) closePinnedDirectory(root);
  }
}

export function generateReport(
  sessionDir: string,
  input: ReportInput,
  opts: GenerateReportOptions = {},
): GenerateReportResult {
  const suiteRoot = resolve(sessionDir);
  const discovery = discoverSuiteChildren(suiteRoot);
  if (discovery === null) throw new Error('ux-e2e: failed to write report.json inside the session directory');
  const mdDir = resolve(opts.mdDir ?? join(process.cwd(), 'vibe-report'));
  const externalRoot = pinOrCreateDirectory(mdDir);
  if (externalRoot === null) {
    closeSuiteDiscovery(discovery);
    throw new Error('ux-e2e: report destination root must be a stable non-symlink directory');
  }
  const roots = [discovery.root, externalRoot];
  const targets = roots
    .filter((root, index, all) => all.findIndex(candidate => candidate.identity.dev === root.identity.dev && candidate.identity.ino === root.identity.ino) === index)
    .sort(comparePinnedRoots);
  let closed = false;
  const closeDiscovery = (): void => {
    if (closed) return;
    closed = true;
    closeSuiteDiscovery(discovery);
  };
  const execute = (): GenerateReportResult => {
    try {
      if (discovery.single) {
        const result = generateSingleReport(suiteRoot, input, { ...opts, retainedReportRoot: externalRoot }, discovery);
        return { jsonPath: result.jsonPath, mdPath: result.mdPath, warnings: result.warnings };
      }
      return generateSuiteReport(suiteRoot, discovery, input, { ...opts, retainedReportRoot: externalRoot });
    } finally {
      closeDiscovery();
    }
  };
  const runLocked = (index: number): GenerateReportResult => {
    const root = targets[index];
    if (root === undefined) return execute();
    return withPinnedExclusiveLock(root, REPORT_LOCK_NAME, () => runLocked(index + 1), REPORT_LOCK_TIMEOUT_MS);
  };
  try {
    return runLocked(0);
  } finally {
    closeDiscovery();
    closePinnedDirectory(externalRoot);
  }
}
