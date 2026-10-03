/**
 * Report generation — ux-e2e JSON + manual_qa-compatible markdown.
 *
 * `generateReport()` clamps step ratings against defect severity floors
 * (a CRITICAL defect caps the step at 1, HIGH at 2, MEDIUM at 3, LOW at 4)
 * and warns on every clamp, so the score can never outrun the defects.
 */

import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  existsSync,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
  type Dirent,
  type Stats,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';

import { readManifest, validateProcessReceipt, verifyManifest, type RunManifest, type SessionRecord } from './manifest.js';
import { readManagedBrokerToken } from './broker.js';
import {
  assertSafeRunPath,
  isCleanSessionTermination,
  readPersistedRunLeaseOwnership,
  readSessionRecord,
  sessionPaths,
  validateSessionRecordEnvelope,
  type SessionPaths,
} from './environment.js';

const REDACTED = '[REDACTED]';
const EMPTY_SECRETS: ReadonlySet<string> = new Set();
const SENSITIVE_KEY = /(?:api[_-]?key|token|secret|password|authorization|bearer|oauth|credential|refresh[_-]?token|access[_-]?token|private[_-]?connection)/iu;
const PRIVATE_KEY = /(?:private|connection|auth[_-]?cache|refresh[_-]?token|oauth[_-]?credential|owner[_-]?nonce)/iu;
const NATIVE_EVIDENCE_FILENAME = 'live-native-events.jsonl';
const NATIVE_WORKFLOW_RESOURCE_PATH = /^xd:\/\/workflow_[a-z_]+$/u;
const NATIVE_WORKFLOW_OPERATIONS: Readonly<Record<string, true>> = {
  workflow_prepare: true, workflow_status: true, workflow_instructions: true, workflow_begin: true,
  workflow_complete: true, workflow_checkpoint: true, workflow_checkpoint_ask: true, workflow_advance: true,
};
const ANSI_CSI = /(?:\u001b|\\+u001[bB])\[[0-?]*[ -/]*[@-~]/gu;
/**
 * Evidence formats produced by the E2E runner that are safe to decode as
 * text. Keep this an allowlist so unknown files (including screenshots) are
 * copied byte-for-byte rather than accidentally rewritten as UTF-8.
 */
const TEXT_EVIDENCE = /\.(?:json|jsonl|log|txt|md|ndjson)$/iu;
const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

const SESSION_DISPLAY_FIELDS = [
  'slug',
  'omp_version',
  'profile',
  'tty',
  'finished_at',
  'task_prompt',
  'scenario',
] as const;
const SESSION_ENVELOPE_OPTIONAL_FIELDS = [
  'start_marker',
  'lease_marker',
  'process',
  'ready',
  'readiness',
  'native_signals',
  'exit_code',
  'exit_signal',
  'termination',
] as const;
const SESSION_RECORD_FIELDS = [
  'id',
  'status',
  'pid',
  'start_marker',
  'lease_marker',
  'process',
  'transcript_path',
  'log_path',
  'private_connection_path',
  'started_at',
  'ready',
  'readiness',
  'native_signals',
  'exit_code',
  'exit_signal',
  'termination',
] as const;
const SESSION_RECORD_REQUIRED_FIELDS = [
  'id',
  'status',
  'pid',
  'transcript_path',
  'log_path',
  'private_connection_path',
  'started_at',
] as const;


/**
 * Redact terminal/auth credentials before a value is written to report
 * JSON, markdown, or an exported text evidence file. Exact values are
 * supplied by the non-private session metadata when available; pattern
 * rules cover credential forms recognizable without them.
 */
function redactText(value: string, secretValues: ReadonlySet<string> = EMPTY_SECRETS): string {
  // Decode styling boundaries before recognizing credentials, including CSI
  // controls serialized inside copied JSONL. Colors may split labels or values.
  let redacted = value.replace(ANSI_CSI, '');
  const exact = [...secretValues]
    .filter(secret => secret.length > 0)
    .sort((a, b) => b.length - a.length);
  for (const secret of exact) {
    redacted = redacted.split(secret).join(REDACTED);
  }
  redacted = redacted
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/giu, `Bearer ${REDACTED}`)
    .replace(/(\bhttps?:\/\/)[^/\s:@]+:[^@\s]+@/giu, `$1${REDACTED}@`)
    .replace(/([?&](?:token|access_token|refresh_token|api[_-]?key|key|secret|code)=)[^&#\s]+/giu, `$1${REDACTED}`)
    .replace(
      /(\b(?:OPENAI_API_KEY|ANTHROPIC_API_KEY|GEMINI_API_KEY|OMP_AUTH_BROKER_TOKEN|(?:[a-z][a-z0-9_-]*)?(?:token|nonce)|api[_-]?key|secret|password|authorization)(?:\\*["'`])?\s*[:=]\s*)(\\*["'`]?)[^"'`\s,;&}]+?(?=\\*["'`]|[\s,;&}]|$)/giu,
      `$1$2${REDACTED}`,
    )
    .replace(
      /(\b[A-Z][A-Z0-9_]*(?:TOKEN|API[_-]?KEY|SECRET|PASSWORD)\s*[:=]\s*)(["']?)[^"'\s,;&}]+/gu,
      `$1$2${REDACTED}`,
    )
    .replace(/\b(?:sk|rk|pk)-[A-Za-z0-9][A-Za-z0-9._~-]{7,}\b/giu, REDACTED)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/gu, '');
  return redacted;
}

function addSecretValue(value: unknown, output: Set<string>): void {
  if (typeof value === 'string' && value.length > 0) output.add(value);
}

/**
 * Connection/session metadata is private bearer metadata, not a general
 * secret source. Keep this allowlist narrow: report generation must not
 * turn arbitrary session fields into exact redaction values.
 */
function collectBearerMetadata(value: unknown, output: Set<string>, key?: string): void {
  if (typeof value === 'string') {
    const normalizedKey = key?.toLowerCase().replace(/-/gu, '_') ?? '';
    if (
      normalizedKey === 'token' ||
      normalizedKey === 'bearer' ||
      normalizedKey === 'access_token' ||
      normalizedKey === 'ws_token' ||
      normalizedKey === 'session_token'
    ) {
      addSecretValue(value, output);
    }
    if (normalizedKey === 'url' || normalizedKey === 'ws_url' || normalizedKey === 'ws_path') {
      try {
        const parsed = new URL(value);
        for (const name of ['token', 'access_token', 'bearer']) {
          for (const candidate of parsed.searchParams.getAll(name)) addSecretValue(candidate, output);
        }
      } catch {
        /* Non-URL metadata carries no query parameter to inspect. */
      }
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectBearerMetadata(item, output, key);
    return;
  }
  if (typeof value !== 'object' || value === null) return;
  for (const [childKey, childValue] of Object.entries(value)) {
    collectBearerMetadata(childValue, output, childKey);
  }
}

function redactUnknown(
  value: unknown,
  secretValues: ReadonlySet<string>,
  omitPrivate = false,
  key?: string,
  opaqueText = false,
): unknown {
  if (key !== undefined && omitPrivate && PRIVATE_KEY.test(key)) return undefined;
  if (key !== undefined && SENSITIVE_KEY.test(key)) return REDACTED;
  if (typeof value === 'string') return opaqueText ? REDACTED : redactText(value, secretValues);
  if (Array.isArray(value)) {
    return value
      .map(item => redactUnknown(item, secretValues, omitPrivate, undefined, opaqueText))
      .filter(item => item !== undefined);
  }
  if (typeof value !== 'object' || value === null) return value;
  const result: Record<string, unknown> = {};
  for (const [childKey, childValue] of Object.entries(value)) {
    const safe = redactUnknown(childValue, secretValues, omitPrivate, childKey, opaqueText);
    if (safe !== undefined) result[childKey] = safe;
  }
  return result;
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

export interface ReportScenario {
  readonly id: string;
  readonly path?: string;
  readonly digest?: string;
  readonly title?: string;
}

export interface RuntimeReceipt {
  readonly binary: string;
  readonly version: string;
  readonly digest: string;
  readonly platform: string;
}

export interface ArtifactReceipt {
  readonly root: string;
  readonly digest: string;
  readonly version?: string;
}

export interface ProcessObservationReceipt {
  readonly id?: string;
  readonly kind?: string;
  readonly status?: string;
  readonly command?: string;
  readonly marker?: string;
  readonly observed?: boolean;
  readonly details?: string;
  readonly [key: string]: unknown;
}

export interface ReportReceipts {
  readonly runtime: RuntimeReceipt | null;
  readonly artifacts: { readonly core: ArtifactReceipt | null; readonly fullstack: ArtifactReceipt | null };
  /** Process checks and native category signals; never a complete loaded-resource inventory. */
  readonly process_observations: ProcessObservationReceipt[];
  readonly native_signals: unknown[];
  readonly inventory_scope: 'process-observation';
  readonly inventory_complete: false;
  readonly omitted_raw_evidence: boolean;
  /** Executed suite verdict is bound to its exact checks and session records. */
  readonly verification?: {
    readonly suite: string;
    readonly checks: Readonly<Record<string, boolean | string>>;
    readonly session_ids: readonly string[];
  };
}

export interface ReportSessionMeta {
  readonly id: string | null;
  readonly slug: string;
  readonly scratch_dir: string;
  readonly omp_version: string;
  readonly profile: string;
  readonly tty: { readonly cols: number; readonly rows: number; readonly term: string };
  readonly started_at: string | null;
  readonly finished_at: string | null;
  readonly task_prompt: string | null;
  readonly scenario: { readonly id: string; readonly title?: string } | null;
  readonly transcript: string;
  readonly session_jsonl: string;
  readonly events_jsonl: string;
  readonly omp_log: string;
}

export interface UxE2eReport {
  readonly type: 'ux-e2e';
  readonly schema_version: 1;
  readonly verdict: Verdict;
  readonly mode: 'ui';
  readonly run_id: string;
  readonly auth: { readonly mode: 'none' | 'api-key-env' | 'broker' | 'native-host-broker' };
  readonly model: string | null;
  readonly scenario: ReportScenario | null;
  readonly receipts: ReportReceipts;
  readonly errors: readonly { readonly code: string }[];
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
  readonly verification?: {
    readonly suite: string;
    readonly checks: Readonly<Record<string, boolean | string>>;
    readonly session_ids: readonly string[];
  };
}

export interface GenerateReportOptions {
  /** Markdown output directory. Default `<roots.evidence>/markdown`. */
  readonly mdDir?: string;
  /** Mirror sanitized evidence files to `<mdDir>/evidence/<slug>/`. */
  readonly copyEvidence?: boolean;
  /** Select one registered session; omitted means all records for the run. */
  readonly sessionId?: string;
  /** Separate retention namespace for cleanup's unassessed archive report. */
  readonly outputId?: string;
}

export type ReportManifestSource = string | RunManifest;

export interface GenerateReportResult {
  readonly jsonPath: string;
  readonly mdPath: string;
  readonly warnings: string[];
}

/* ------------------------------------------------------------------ */
/* Session metadata                                                    */
/* ------------------------------------------------------------------ */

type JsonObject = Record<string, unknown>;

interface RegisteredSessionRecords {
  readonly records: SessionRecord[];
  readonly recordPaths: string[];
  readonly sessionIdByRecordPath: ReadonlyMap<string, string>;
  readonly metadataById: ReadonlyMap<string, JsonObject>;
  readonly ownerIdentityExplicitById: ReadonlyMap<string, boolean>;
}

interface ReportContext {
  readonly manifest: RunManifest;
  readonly root: string;
  readonly registeredRoots: string[];
  readonly privateRoots: string[];
  readonly sessions: SessionRecord[];
  readonly sessionJsonPaths: string[];
  readonly sessionIdByRecordPath: ReadonlyMap<string, string>;
  readonly sessionMetadataById: ReadonlyMap<string, JsonObject>;
  readonly ownerIdentityExplicitById: ReadonlyMap<string, boolean>;
  readonly unsafeRawText: boolean;
  readonly secretValues: ReadonlySet<string>;
}

function asObject(value: unknown): JsonObject | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as JsonObject) : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function readObjectFile(path: string): JsonObject | null {
  if (!existsSync(path)) return null;
  try {
    return asObject(JSON.parse(readFileSync(path, 'utf8')));
  } catch {
    return null;
  }
}

function pathInside(root: string, candidate: string): boolean {
  const child = relative(root, candidate);
  return child === '' || (!child.startsWith('..') && !isAbsolute(child));
}

function reportError(code: string): Error {
  return new Error(code);
}

function assertDirectory(path: string, code: string): void {
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    throw reportError(code);
  }
  if (stat.isSymbolicLink()) throw reportError(code);
  if (!stat.isDirectory()) throw reportError(code);
}

/**
 * Walk a report destination without following directory links. Missing
 * descendants are created one component at a time so a pre-existing link
 * cannot redirect recursive mkdir outside the run.
 */
function ensureOutputDirectory(trustedRoot: string, target: string): string {
  const root = resolve(trustedRoot);
  const candidate = resolve(target);
  if (!pathInside(root, candidate)) throw reportError('report_output_outside_run');
  assertDirectory(root, 'report_run_root_invalid');
  let current = root;
  const child = relative(root, candidate);
  for (const component of child.split('/').flatMap(part => part.split('\\')).filter(Boolean)) {
    current = join(current, component);
    let stat;
    try {
      stat = lstatSync(current);
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') {
        throw reportError('report_output_unavailable');
      }
      mkdirSync(current, { mode: 0o700 });
      chmodSync(current, 0o700);
      stat = lstatSync(current);
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw reportError('report_output_symlink');
  }
  return candidate;
}

function validateTrustedRoots(root: string, roots: readonly string[]): void {
  assertDirectory(root, 'report_run_root_invalid');
  const rootActual = realpathSync(root);
  for (const candidate of roots) {
    if (!pathInside(root, candidate)) throw reportError('report_manifest_root_outside_run');
    if (!existsSync(candidate)) continue;
    assertDirectory(candidate, 'report_manifest_root_invalid');
    let actual: string;
    try {
      actual = realpathSync(candidate);
    } catch {
      throw reportError('report_manifest_root_invalid');
    }
    if (!pathInside(rootActual, actual)) throw reportError('report_manifest_root_outside_run');
  }
}

function privateRegisteredPath(
  value: unknown,
  context: Pick<ReportContext, 'root' | 'privateRoots'>,
): string | null {
  const raw = stringValue(value);
  if (raw === null) return null;
  const candidate = resolve(isAbsolute(raw) ? raw : join(context.root, raw));
  if (!existsSync(candidate)) return null;
  try {
    const actual = realpathSync(candidate);
    const privateActual = context.privateRoots.flatMap(root => {
      try {
        return [realpathSync(root)];
      } catch {
        return [];
      }
    });
    return privateActual.some(root => pathInside(root, actual)) ? candidate : null;
  } catch {
    return null;
  }
}

function registeredPath(
  value: unknown,
  context: Pick<ReportContext, 'root' | 'registeredRoots' | 'privateRoots'>,
): string | null {
  const raw = stringValue(value);
  if (raw === null) return null;
  const candidate = resolve(isAbsolute(raw) ? raw : join(context.root, raw));
  if (!existsSync(candidate)) return null;
  try {
    const actual = realpathSync(candidate);
    const privateActual = context.privateRoots.flatMap(root => {
      try {
        return [realpathSync(root)];
      } catch {
        return [];
      }
    });
    const registeredActual = context.registeredRoots.flatMap(root => {
      try {
        return [realpathSync(root)];
      } catch {
        return [];
      }
    });
    if (privateActual.some(root => pathInside(root, actual))) return null;
    if (!registeredActual.some(root => pathInside(root, actual))) return null;
    return candidate;
  } catch {
    return null;
  }
}

function sessionRecordPathValues(value: unknown, key: string | undefined, output: string[]): void {
  if (typeof value === 'string') {
    const normalizedKey = key?.toLowerCase() ?? '';
    if (
      normalizedKey.includes('transcript') ||
      normalizedKey.includes('log') ||
      normalizedKey.includes('receipt') ||
      normalizedKey.includes('evidence') ||
      normalizedKey.includes('observation')
    ) {
      output.push(value);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) sessionRecordPathValues(item, key, output);
    return;
  }
  const object = asObject(value);
  if (object === null) return;
  for (const [childKey, childValue] of Object.entries(object)) {
    if (childKey === 'private_connection_path') continue;
    sessionRecordPathValues(childValue, childKey, output);
  }
}

function sessionLifecycleRecord(
  manifest: RunManifest,
  sessionId: string,
  raw: JsonObject,
  listed: SessionRecord | undefined,
): SessionRecord {
  if (raw.id !== sessionId) throw new Error('session_record_id_mismatch');
  const paths = sessionPaths(manifest, sessionId);
  const hasOwn = (key: string): boolean => Object.prototype.hasOwnProperty.call(raw, key);
  const hasPresentationFields = Object.keys(raw).some(
    field => !(SESSION_RECORD_FIELDS as readonly string[]).includes(field),
  );
  if (!hasPresentationFields && SESSION_RECORD_REQUIRED_FIELDS.every(hasOwn)) {
    const record = readSessionRecord(manifest, sessionId);
    if (record === null) throw new Error('session_record_missing');
    return record as unknown as SessionRecord;
  }
  const envelope: JsonObject = {
    id: sessionId,
    status: hasOwn('status') ? raw.status : listed?.status,
    pid: hasOwn('pid') ? raw.pid : listed?.pid ?? null,
    transcript_path: paths.transcript,
    log_path: paths.log,
    private_connection_path: paths.connection,
    started_at: hasOwn('started_at')
      ? raw.started_at
      : manifest.updated_at ?? manifest.created_at ?? 'manifest',
  };
  for (const field of SESSION_ENVELOPE_OPTIONAL_FIELDS) {
    if (hasOwn(field)) {
      envelope[field] = raw[field];
    } else if (field === 'start_marker' && listed?.start_marker !== undefined) {
      envelope[field] = listed.start_marker;
    } else if (field === 'process' && listed?.process !== undefined) {
      envelope[field] = listed.process;
    }
  }
  return validateSessionRecordEnvelope(manifest, sessionId, envelope) as unknown as SessionRecord;
}

function failedSessionRecord(sessionId: string, paths: SessionPaths): SessionRecord {
  return {
    id: sessionId,
    status: 'failed',
    pid: null,
    transcript_path: paths.transcript,
    log_path: paths.log,
    private_connection_path: paths.connection,
  };
}

function explicitlyBoundOwnerIdentity(record: JsonObject): boolean {
  return Object.prototype.hasOwnProperty.call(record, 'pid') &&
    typeof record.pid === 'number' &&
    Number.isSafeInteger(record.pid) &&
    record.pid > 0 &&
    Object.prototype.hasOwnProperty.call(record, 'start_marker') &&
    typeof record.start_marker === 'string' &&
    record.start_marker.length > 0;
}

function readRegisteredSessionRecords(manifest: RunManifest): RegisteredSessionRecords {
  const direct = Array.isArray(manifest.sessions)
    ? manifest.sessions.filter((record): record is SessionRecord => asObject(record) !== null)
    : [];
  const recordsById = new Map(direct.map(record => [record.id, record] as const));
  const metadataById = new Map<string, JsonObject>();
  const ownerIdentityExplicitById = new Map(direct.map(record => [
    record.id,
    explicitlyBoundOwnerIdentity(record as unknown as JsonObject),
  ] as const));
  const sessionsRoot = resolve(manifest.roots.sessions);
  const recordPaths: string[] = [];
  const sessionIdByRecordPath = new Map<string, string>();
  if (!existsSync(sessionsRoot)) {
    return { records: [...recordsById.values()], recordPaths, sessionIdByRecordPath, metadataById, ownerIdentityExplicitById };
  }
  let entries: Dirent[];
  try {
    entries = readdirSync(sessionsRoot, { withFileTypes: true });
  } catch {
    return { records: [...recordsById.values()], recordPaths, sessionIdByRecordPath, metadataById, ownerIdentityExplicitById };
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !SESSION_ID_RE.test(entry.name)) continue;
    let paths: SessionPaths;
    try {
      paths = sessionPaths(manifest, entry.name);
    } catch {
      continue;
    }
    let stat: Stats;
    try {
      stat = lstatSync(paths.record);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      recordsById.set(entry.name, failedSessionRecord(entry.name, paths));
      ownerIdentityExplicitById.set(entry.name, false);
      continue;
    }
    if (!stat.isFile() || stat.isSymbolicLink()) {
      recordsById.set(entry.name, failedSessionRecord(entry.name, paths));
      ownerIdentityExplicitById.set(entry.name, false);
      continue;
    }
    try {
      if (!pathInside(realpathSync(sessionsRoot), realpathSync(paths.record))) {
        recordsById.set(entry.name, failedSessionRecord(entry.name, paths));
        ownerIdentityExplicitById.set(entry.name, false);
        continue;
      }
    } catch {
      recordsById.set(entry.name, failedSessionRecord(entry.name, paths));
      ownerIdentityExplicitById.set(entry.name, false);
      continue;
    }
    const raw = readObjectFile(paths.record);
    if (raw === null) {
      recordsById.set(entry.name, failedSessionRecord(entry.name, paths));
      ownerIdentityExplicitById.set(entry.name, false);
      continue;
    }
    try {
      const record = sessionLifecycleRecord(manifest, entry.name, raw, recordsById.get(entry.name));
      recordsById.set(entry.name, record);
      metadataById.set(entry.name, raw);
      ownerIdentityExplicitById.set(entry.name, explicitlyBoundOwnerIdentity(raw));
      recordPaths.push(paths.record);
      sessionIdByRecordPath.set(paths.record, entry.name);
    } catch {
      recordsById.set(entry.name, failedSessionRecord(entry.name, paths));
      ownerIdentityExplicitById.set(entry.name, false);
    }
  }
  return {
    records: [...recordsById.values()].sort((left, right) => left.id.localeCompare(right.id)),
    recordPaths: recordPaths.sort((left, right) => left.localeCompare(right)),
    sessionIdByRecordPath,
    metadataById,
    ownerIdentityExplicitById,
  };
}

function makeReportContext(source: ReportManifestSource, sessionId: string | undefined): ReportContext {
  let manifest: RunManifest;
  try {
    manifest = typeof source === 'string' ? readManifest(resolve(source)) : source;
    verifyManifest(manifest);
  } catch {
    throw new Error('report_manifest_invalid');
  }

  const root = resolve(manifest.roots.run);
  const rootValues = Object.values(manifest.roots).filter((value): value is string => typeof value === 'string');
  const registeredRoots = [...new Set(rootValues.map(value => resolve(value)))];
  try {
    validateTrustedRoots(root, registeredRoots);
  } catch {
    throw new Error('report_manifest_invalid');
  }
  const privateRoot = resolve(manifest.roots.private);
  const privateRoots = registeredRoots.filter(candidate => pathInside(privateRoot, candidate));
  const scope: Pick<ReportContext, 'root' | 'registeredRoots' | 'privateRoots'> = { root, registeredRoots, privateRoots };
  const discovered = readRegisteredSessionRecords(manifest);
  const sessions = sessionId === undefined
    ? discovered.records
    : discovered.records.filter(record => record.id === sessionId);
  if (sessionId !== undefined && sessions.length === 0) throw new Error('report_session_not_found');

  const sessionJsonPaths: string[] = [];
  const sessionIdByRecordPath = new Map<string, string>();
  for (const path of discovered.recordPaths) {
    const id = discovered.sessionIdByRecordPath.get(path);
    if (id === undefined || (sessionId !== undefined && id !== sessionId)) continue;
    const scoped = registeredPath(path, scope);
    if (scoped === null) continue;
    sessionJsonPaths.push(scoped);
    sessionIdByRecordPath.set(scoped, id);
  }
  const scopedMetadataById = new Map(
    [...discovered.metadataById].filter(([id]) => sessionId === undefined || id === sessionId),
  );

  const secretValues = new Set<string>();
  const authSecretNames = manifest.auth.mode === 'api-key-env'
    ? manifest.auth.keys.map(key => key.env_name)
    : manifest.auth.mode === 'broker'
      ? [manifest.auth.token_env]
      : [];
  let authSecretUnavailable = false;
  for (const name of authSecretNames) {
    const value = process.env[name];
    if (typeof value !== 'string' || value.length === 0) {
      authSecretUnavailable = true;
    } else {
      secretValues.add(value);
    }
  }
  if (manifest.auth.mode === 'native-host-broker') {
    try {
      const token = readManagedBrokerToken(manifest);
      if (token === null) authSecretUnavailable = true;
      else secretValues.add(token);
    } catch {
      authSecretUnavailable = true;
    }
  }

  for (const [path, id] of sessionIdByRecordPath) {
    const metadata = scopedMetadataById.get(id);
    if (metadata !== undefined) collectBearerMetadata(metadata, secretValues);
  }

  let privateBearerUnavailable = false;
  for (const record of sessions) {
    const rawMetadata = scopedMetadataById.get(record.id);
    const hasRegisteredConnection = (manifest.sessions ?? []).some(session => session.id === record.id) ||
      (rawMetadata !== undefined && Object.prototype.hasOwnProperty.call(rawMetadata, 'private_connection_path'));
    if (!hasRegisteredConnection) continue;
    if (stringValue(record.private_connection_path) === null) continue;
    const connectionPath = privateRegisteredPath(record.private_connection_path, scope);
    if (connectionPath === null) {
      privateBearerUnavailable = true;
      continue;
    }
    const metadata = readObjectFile(connectionPath);
    if (metadata === null) {
      privateBearerUnavailable = true;
      continue;
    }
    const privateSecrets = new Set<string>();
    collectBearerMetadata(metadata, privateSecrets);
    if (privateSecrets.size === 0) {
      privateBearerUnavailable = true;
      continue;
    }
    for (const secret of privateSecrets) secretValues.add(secret);
  }

  return {
    manifest,
    root,
    registeredRoots,
    privateRoots,
    sessions,
    sessionJsonPaths,
    sessionIdByRecordPath,
    sessionMetadataById: scopedMetadataById,
    ownerIdentityExplicitById: discovered.ownerIdentityExplicitById,
    secretValues,
    unsafeRawText: authSecretUnavailable ||
      privateBearerUnavailable ||
      (manifest.errors ?? []).some(error => /^(?:auth|broker)[_-]/iu.test(error.code)),
  };
}

function writeNoFollowFile(path: string, data: string | Uint8Array): void {
  let fd: number | undefined;
  try {
    try {
      const existing = lstatSync(path);
      if (!existing.isFile() || existing.isSymbolicLink() || existing.nlink !== 1) {
        throw reportError('report_output_symlink');
      }
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
    }
    const noFollow = fsConstants.O_NOFOLLOW;
    if (typeof noFollow !== 'number') throw reportError('report_output_no_follow_unavailable');
    fd = openSync(path, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC | noFollow, 0o600);
    fchmodSync(fd, 0o600);
    writeFileSync(fd, data);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('report_output_')) throw error;
    throw reportError('report_output_unavailable');
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/* ------------------------------------------------------------------ */
/* Defect floors + clamping                                            */
/* ------------------------------------------------------------------ */

/** Effective rating for a dimension given the step's worst defect floor. */
function clampRating(rating: number | undefined, floor: number, warnings: string[], where: string): number | undefined {
  if (rating === undefined) return undefined;
  if (rating < 1) {
    warnings.push(`${where}: rating ${rating} clamped up to 1`);
    return 1;
  }
  if (rating > 5) {
    warnings.push(`${where}: rating ${rating} clamped down to 5`);
    return 5;
  }
  if (rating > floor) {
    warnings.push(`${where}: rating ${rating} clamped down to defect floor ${floor}`);
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

/* ------------------------------------------------------------------ */
/* Evidence collection                                                 */
/* ------------------------------------------------------------------ */

function nativeEvidencePaths(context: ReportContext): ReadonlyMap<string, string> {
  const paths = new Map<string, string>();
  for (const session of context.sessions) {
    try {
      const root = sessionPaths(context.manifest, session.id).root;
      const path = assertSafeRunPath(context.root, join(root, NATIVE_EVIDENCE_FILENAME), 'native event evidence');
      const scoped = registeredPath(path, context);
      if (scoped === null) continue;
      const stat = lstatSync(scoped);
      if (stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 &&
        (stat.mode & 0o777) === 0o600 &&
        (typeof process.getuid !== 'function' || stat.uid === process.getuid())) {
        paths.set(session.id, scoped);
      }
    } catch {
      // Missing or unsafe native evidence is not eligible for export.
    }
  }
  return paths;
}

function redactNativeEvents(text: string, context: ReportContext): string {
  const records: string[] = [];
  for (const line of text.split('\n')) {
    if (line.length === 0) continue;
    const event = asObject(JSON.parse(line) as unknown);
    const kind = event?.kind;
    if (event === null || event.schema_version !== 1 ||
      (kind !== 'session_start' && kind !== 'before_agent_start' && kind !== 'message_end' && kind !== 'agent_end')) {
      throw reportError('report_native_evidence_invalid');
    }
    const model = asObject(event.model);
    let message: unknown;
    if (kind === 'message_end') {
      const source = asObject(event.message);
      if (source?.role === 'toolResult') {
        message = {
          role: 'toolResult',
          isError: source.isError,
          ...(typeof source.workflow_operation === 'string' && NATIVE_WORKFLOW_OPERATIONS[source.workflow_operation] === true
            && typeof source.workflow_error === 'boolean'
            ? { workflow_operation: source.workflow_operation, workflow_error: source.workflow_error } : {}),
        };
      } else if (source?.role === 'assistant') {
        const usage = asObject(source.usage);
        const content: JsonObject[] = [];
        if (Array.isArray(source.content)) {
          for (const item of source.content) {
            const part = asObject(item);
            if (part?.type === 'text' && typeof part.text === 'string') {
              content.push({ type: 'text', text: part.text });
            } else if (part?.type === 'toolCall' && typeof part.name === 'string') {
              const toolCall: JsonObject = { type: 'toolCall', name: part.name };
              if (typeof part.resourcePath === 'string' && NATIVE_WORKFLOW_RESOURCE_PATH.test(part.resourcePath)) {
                toolCall.resourcePath = part.resourcePath;
              }
              content.push(toolCall);
            }
          }
        }
        message = {
          role: 'assistant', provider: source.provider, model: source.model, api: source.api,
          usage: usage === null ? undefined : { input: usage.input, output: usage.output },
          timestamp: source.timestamp, stopReason: source.stopReason, provider_error: source.provider_error, content,
        };
      } else {
        throw reportError('report_native_evidence_invalid');
      }
    }
    records.push(JSON.stringify(redactUnknown({
      schema_version: event.schema_version, timestamp: event.timestamp,
      native_session_id: event.native_session_id, session_directory: event.session_directory,
      model: model === null ? undefined : { provider: model.provider, id: model.id }, kind,
      ...(kind === 'before_agent_start' ? { task_sha256: event.task_sha256 } : {}),
      ...(kind === 'message_end' ? { message } : {}),
    }, context.secretValues, true)));
  }
  return records.join('\n') + '\n';
}

function collectEvidence(context: ReportContext, screenshots: readonly string[], nativePaths: ReadonlySet<string>): string[] {
  const candidates: string[] = [...context.sessionJsonPaths];
  for (const receipt of context.manifest.receipts ?? []) {
    sessionRecordPathValues(receipt, undefined, candidates);
  }
  for (const record of context.sessions) {
    const values: string[] = [];
    sessionRecordPathValues(record, undefined, values);
    candidates.push(...values);
  }
  for (const screenshot of screenshots) {
    const scoped = registeredPath(screenshot, context);
    if (scoped !== null) candidates.push(scoped);
  }
  candidates.push(...nativePaths);
  const evidence: string[] = [];
  for (const candidate of candidates) {
    const scoped = registeredPath(candidate, context);
    if (scoped !== null && basename(scoped) === NATIVE_EVIDENCE_FILENAME && !nativePaths.has(scoped)) continue;
    if (scoped !== null && !evidence.includes(scoped)) evidence.push(scoped);
  }
  return evidence;
}

interface EvidenceCopyResult {
  readonly paths: string[];
  readonly bySource: ReadonlyMap<string, string>;
  readonly omittedRaw: boolean;
}

function copyEvidence(
  evidence: readonly string[],
  targetDir: string,
  context: ReportContext,
  warnings: string[],
  nativePaths: ReadonlySet<string>,
): EvidenceCopyResult {
  ensureOutputDirectory(context.root, targetDir);
  const transcriptPaths = new Set<string>();
  for (const session of context.sessions) {
    const path = registeredPath(session.transcript_path, context);
    if (path !== null) transcriptPaths.add(path);
  }
  const basenameCounts = new Map<string, number>();
  for (const src of evidence) {
    const name = basename(src);
    basenameCounts.set(name, (basenameCounts.get(name) ?? 0) + 1);
  }
  const copied: string[] = [];
  const bySource = new Map<string, string>();
  let omittedRaw = false;
  for (const src of evidence) {
    const isSessionMetadata = context.sessionJsonPaths.includes(src);
    if (!TEXT_EVIDENCE.test(src)) {
      omittedRaw = true;
      warnings.push('binary evidence omitted: screenshots cannot be safely redacted');
      continue;
    }
    if (context.unsafeRawText && !isSessionMetadata) {
      omittedRaw = true;
      warnings.push('raw evidence omitted for secret safety');
      continue;
    }
    try {
      const sourceRelative = relative(context.root, src);
      const duplicateBasename = (basenameCounts.get(basename(src)) ?? 0) > 1;
      const destinationRelative = duplicateBasename && sourceRelative !== '' && pathInside(context.root, src)
        ? sourceRelative
        : basename(src);
      const dst = join(targetDir, destinationRelative);
      ensureOutputDirectory(context.root, dirname(dst));
      if (isSessionMetadata) {
        const id = context.sessionIdByRecordPath.get(src);
        const record = context.sessions.find(session => session.id === id);
        const metadata = id === undefined ? undefined : context.sessionMetadataById.get(id);
        if (record === undefined) throw new Error('report_session_metadata_unavailable');
        const safe = redactUnknown(
          { ...(metadata ?? {}), ...(record as unknown as JsonObject) },
          context.secretValues,
          true,
          undefined,
          context.unsafeRawText,
        );
        writeNoFollowFile(dst, JSON.stringify(safe, null, 2) + '\n');
      } else if (nativePaths.has(src)) {
        const fd = openSync(src, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
        try {
          const stat = fstatSync(fd);
          if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600 ||
            (typeof process.getuid === 'function' && stat.uid !== process.getuid())) {
            throw reportError('report_native_evidence_invalid');
          }
          writeNoFollowFile(dst, redactNativeEvents(readFileSync(fd, 'utf8'), context));
        } finally {
          closeSync(fd);
        }
      } else if (transcriptPaths.has(src)) {
        let safeTranscript = '';
        for (const line of readFileSync(src, 'utf8').split('\n')) {
          if (line.trim().length === 0) continue;
          safeTranscript += JSON.stringify(redactUnknown(JSON.parse(line), context.secretValues)) + '\n';
        }
        writeNoFollowFile(dst, safeTranscript);
      } else {
        writeNoFollowFile(dst, redactText(readFileSync(src, 'utf8'), context.secretValues));
      }
      copied.push(dst);
      bySource.set(src, dst);
    } catch {
      warnings.push('evidence copy failed');
    }
  }
  return { paths: copied, bySource, omittedRaw };
}

function artifactReceipt(value: unknown, secretValues: ReadonlySet<string>): ArtifactReceipt | null {
  const object = asObject(value);
  if (object === null) return null;
  const root = stringValue(object.root);
  const digest = stringValue(object.digest);
  if (root === null || digest === null) return null;
  const version = stringValue(object.version);
  return version === null
    ? { root: redactText(root, secretValues), digest }
    : { root: redactText(root, secretValues), digest, version: redactText(version, secretValues) };
}

function processReceipt(value: unknown, secretValues: ReadonlySet<string>): ProcessObservationReceipt | null {
  const object = asObject(value);
  if (object === null) return null;
  const redacted = redactUnknown(object, secretValues, true);
  const safe = asObject(redacted);
  if (safe === null) return null;
  for (const key of Object.keys(safe)) {
    if (/(?:path|url|token|secret|password|credential|connection|auth[_-]?cache)/iu.test(key)) delete safe[key];
    if (/(?:details?|message|error|output|stderr|stdout)/iu.test(key)) delete safe[key];
  }
  return safe as ProcessObservationReceipt;
}

function buildReceipts(context: ReportContext, omittedRawEvidence: boolean): ReportReceipts {
  const manifest = asObject(context.manifest);
  const runtimeValue = asObject(manifest?.runtime);
  const runtime = runtimeValue === null
    ? null
    : {
      binary: redactText(stringValue(runtimeValue.binary) ?? '', context.secretValues),
      version: redactText(stringValue(runtimeValue.version) ?? 'unknown', context.secretValues),
      digest: stringValue(runtimeValue.digest) ?? 'unknown',
      platform: redactText(stringValue(runtimeValue.platform) ?? 'unknown', context.secretValues),
    };
  const artifactsValue = asObject(manifest?.artifacts);
  const artifacts = {
    core: artifactReceipt(artifactsValue?.core, context.secretValues),
    fullstack: artifactReceipt(artifactsValue?.fullstack, context.secretValues),
  };
  const processObservations: ProcessObservationReceipt[] = [];
  const nativeSignals: unknown[] = [];
  const addValues = (value: unknown, native: boolean): void => {
    const values = Array.isArray(value) ? value : [value];
    for (const item of values) {
      const safe = native ? redactUnknown(item, context.secretValues, true) : processReceipt(item, context.secretValues);
      if (safe === null || safe === undefined) continue;
      if (native) nativeSignals.push(safe);
      else processObservations.push(safe as ProcessObservationReceipt);
    }
  };
  addValues(manifest?.receipts, false);
  addValues(manifest?.process_observations, false);
  addValues(manifest?.observations, false);
  addValues(runtimeValue?.capabilities, true);
  for (const record of context.sessions) {
    const object = asObject(record);
    const metadata = context.sessionMetadataById.get(record.id);
    addValues(metadata?.process_observations, false);
    addValues(metadata?.observations, false);
    addValues(object?.process, false);
    addValues(object?.native_signals, true);
    addValues(metadata?.command_signals, true);
  }
  return {
    runtime,
    artifacts,
    process_observations: processObservations,
    native_signals: nativeSignals,
    inventory_scope: 'process-observation',
    inventory_complete: false,
    omitted_raw_evidence: omittedRawEvidence,
  };
}

function sessionMetadata(context: ReportContext, selected: SessionRecord | undefined): JsonObject {
  if (selected === undefined) return {};
  const metadata = context.sessionMetadataById.get(selected.id);
  if (metadata === undefined) return {};
  const display: JsonObject = {};
  for (const field of SESSION_DISPLAY_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(metadata, field)) display[field] = metadata[field];
  }
  return display;
}

function displaySession(context: ReportContext): SessionRecord | undefined {
  return [...context.sessions].sort((left, right) => {
    const leftAt = Date.parse(stringValue(asObject(left)?.started_at) ?? '');
    const rightAt = Date.parse(stringValue(asObject(right)?.started_at) ?? '');
    if (Number.isFinite(leftAt) && Number.isFinite(rightAt) && leftAt !== rightAt) return rightAt - leftAt;
    if (Number.isFinite(leftAt) !== Number.isFinite(rightAt)) return Number.isFinite(rightAt) ? 1 : -1;
    return left.id.localeCompare(right.id);
  })[0];
}

function recordPath(record: SessionRecord | undefined, key: string, context: ReportContext): string {
  if (record === undefined) return '';
  const object = record as unknown as JsonObject;
  const path = registeredPath(object[key], context);
  return path === null ? '' : context.unsafeRawText ? REDACTED : redactText(path, context.secretValues);
}
/** Runtime-narrowed tty metadata from session.json (defaults when absent). */
function readTty(raw: unknown, context: ReportContext): { cols: number; rows: number; term: string } {
  if (typeof raw !== 'object' || raw === null) {
    return { cols: 100, rows: 30, term: 'xterm-256color' };
  }
  const cols = 'cols' in raw && typeof raw.cols === 'number' ? raw.cols : 100;
  const rows = 'rows' in raw && typeof raw.rows === 'number' ? raw.rows : 30;
  const term = 'term' in raw && typeof raw.term === 'string' && raw.term.length > 0
    ? reportText(raw.term, context)
    : 'xterm-256color';
  return { cols, rows, term };
}

/** Runtime-narrowed scenario reference from session.json (null when absent). */
function readScenarioRef(raw: unknown, context: ReportContext): { id: string; title?: string } | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const id = 'id' in raw && typeof raw.id === 'string' ? reportText(raw.id, context) : 'unknown';
  const title = 'title' in raw && typeof raw.title === 'string' ? reportText(raw.title, context) : undefined;
  return title !== undefined ? { id, title } : { id };
}

function reportText(value: string, context: ReportContext): string {
  return context.unsafeRawText ? REDACTED : redactText(value, context.secretValues);
}

function transcriptExitIssue(path: string, expectedSignal?: number, expectedCode = 0): string | null {
  let content: string;
  try {
    content = readFileSync(path, 'utf8');
  } catch {
    return 'session_transcript_unavailable';
  }
  const frames: JsonObject[] = [];
  for (const line of content.split(/\r?\n/u)) {
    if (line.trim().length === 0) continue;
    let frame: JsonObject | null;
    try {
      frame = asObject(JSON.parse(line));
    } catch {
      return 'session_transcript_invalid';
    }
    if (frame === null || typeof frame.ts !== 'string' || frame.ts.length === 0 || typeof frame.t !== 'string') {
      return 'session_transcript_invalid';
    }
    const keys = Object.keys(frame).sort();
    if (frame.t === 'o' || frame.t === 'i') {
      if (keys.join(',') !== `d,t,ts` || typeof frame.d !== 'string') return 'session_transcript_invalid';
    } else if (frame.t === 'err') {
      if ((keys.join(',') !== 'code,t,ts' && keys.join(',') !== 'code,message,t,ts') || typeof frame.code !== 'string') {
        return 'session_transcript_invalid';
      }
      if ('message' in frame && typeof frame.message !== 'string') return 'session_transcript_invalid';
    } else if (frame.t === 'exit') {
      if ((keys.join(',') !== 'code,t,ts' && keys.join(',') !== 'code,signal,t,ts') ||
        typeof frame.code !== 'number' || !Number.isSafeInteger(frame.code) || frame.code < 0 ||
        ('signal' in frame && (typeof frame.signal !== 'number' || !Number.isSafeInteger(frame.signal) || frame.signal < 0))) {
        return 'session_transcript_invalid';
      }
    } else {
      return 'session_transcript_invalid';
    }
    frames.push(frame);
  }
  if (frames.length === 0) return 'session_exit_missing';
  const exits = frames.filter(frame => frame.t === 'exit');
  if (exits.length === 0) return 'session_exit_missing';
  if (exits.length > 1) return 'session_exit_duplicate';
  if (frames[frames.length - 1] !== exits[0]) return 'session_exit_not_final';
  const exit = exits[0]!;
  const hasSignal = Object.prototype.hasOwnProperty.call(exit, 'signal');
  if (expectedSignal === undefined ? hasSignal : !hasSignal || exit.signal !== expectedSignal) {
    return 'session_exit_signal';
  }
  if (exit.code !== expectedCode) return 'session_exit_nonzero';
  return null;
}

function sessionOutcomeIssue(
  context: ReportContext,
  selected: SessionRecord | undefined,
): string | null {
  if (context.manifest.status === 'failed') return 'run_failed';
  if (selected === undefined) return 'session_unavailable';
  const status = selected.status as string;
  if (!['preparing', 'ready', 'running', 'stopped', 'failed', 'cleaned', 'stop_refused'].includes(status)) return 'session_status_unknown';
  if (context.manifest.status === 'preparing') return 'run_not_ready';
  if (selected.status === 'failed' || selected.status === 'stop_refused') return 'session_failed';
  if (selected.status === 'preparing' || selected.status === 'ready' || selected.status === 'running') {
    return 'session_not_finished';
  }
  if (selected.status === 'cleaned') return 'session_unavailable';

  const selectedObject = selected as unknown as JsonObject;
  const exitCode = selectedObject.exit_code;
  if (typeof exitCode !== 'number') return 'session_exit_missing';
  const exitSignal = selectedObject.exit_signal;
  if (exitSignal !== undefined && typeof exitSignal !== 'number') return 'session_exit_signal';
  const termination = selectedObject.termination;
  const processValue = selectedObject.process;
  let processReceiptValid = false;
  if (processValue !== undefined) {
    try {
      const receipt = validateProcessReceipt(processValue);
      const ownerPrefix = `${context.manifest.run_id}:${selected.id}:`;
      const recordPid = selectedObject.pid;
      const recordStartMarker = selectedObject.start_marker;
      const ownerStop = asObject(termination)?.requested === 'owner';
      const ownerLeaseBound = !ownerStop || (
        context.ownerIdentityExplicitById.get(selected.id) === true &&
        readPersistedRunLeaseOwnership(context.manifest, selected.id)?.ownerNonce === receipt.owner_nonce
      );
      processReceiptValid =
        typeof recordPid === 'number' &&
        Number.isSafeInteger(recordPid) &&
        recordPid > 0 &&
        receipt.pid === recordPid &&
        typeof recordStartMarker === 'string' &&
        recordStartMarker.length > 0 &&
        receipt.start_marker === recordStartMarker &&
        receipt.owner_nonce.startsWith(ownerPrefix) &&
        receipt.owner_nonce.length > ownerPrefix.length &&
        ownerLeaseBound;
    } catch {
      processReceiptValid = false;
    }
  }
  if (processValue !== undefined && !processReceiptValid) return 'session_termination_unverified';
  if (!isCleanSessionTermination(exitCode, exitSignal, termination, processReceiptValid)) {
    if (exitCode !== 0) return 'session_exit_nonzero';
    if (typeof exitSignal === 'number') return 'session_exit_signal';
    return 'session_termination_unverified';
  }
  const ready = selectedObject.ready;
  if (ready === false) return 'session_not_ready';
  const readiness = asObject(selectedObject.readiness);
  if (readiness?.ok === false || readiness?.ready === false || readiness?.typed_rpc_ready !== true) return 'session_not_ready';
  if (ready !== true || readiness === null) return 'session_not_ready';

  let canonicalTranscript: string;
  try {
    canonicalTranscript = sessionPaths(context.manifest, selected.id).transcript;
  } catch {
    return 'session_transcript_unavailable';
  }
  if (resolve(selected.transcript_path) !== resolve(canonicalTranscript)) return 'session_transcript_unavailable';
  const transcript = registeredPath(canonicalTranscript, context);
  if (transcript === null) return 'session_transcript_unavailable';
  return transcriptExitIssue(
    transcript,
    typeof exitSignal === 'number' ? exitSignal : undefined,
    exitCode,
  );
}

/* ------------------------------------------------------------------ */
/* Markdown                                                            */
/* ------------------------------------------------------------------ */

function formatTty(tty: ReportSessionMeta['tty']): string {
  return `${tty.cols}x${tty.rows} ${tty.term}`;
}

function renderMarkdown(report: UxE2eReport): string {
  const lines: string[] = [];
  lines.push(`# UX E2E Report — ${report.session.slug}`);
  lines.push('');
  lines.push(`**Verdict:** ${report.verdict}  `);
  lines.push(`**Overall:** ${report.overall.score.toFixed(1)}/5 — ${report.overall.recommendation}  `);
  lines.push(`**Generated:** ${report.generated_at}`);
  lines.push('');
  lines.push('## Session');
  lines.push('');
  lines.push(`- slug: \`${report.session.slug}\``);
  lines.push(`- scratch dir: \`${report.session.scratch_dir}\``);
  lines.push(`- omp version: \`${report.session.omp_version}\``);
  lines.push(`- profile: \`${report.session.profile}\``);
  lines.push(`- tty: \`${formatTty(report.session.tty)}\``);
  lines.push(`- started: \`${report.session.started_at ?? 'n/a'}\``);
  lines.push(`- finished: \`${report.session.finished_at ?? 'n/a'}\``);
  if (report.session.scenario !== null) {
    lines.push(`- scenario: \`${report.session.scenario.id}\`${report.session.scenario.title !== undefined ? ` — ${report.session.scenario.title}` : ''}`);
  }
  if (report.session.task_prompt !== null) {
    lines.push('');
    lines.push('### Task prompt');
    lines.push('');
    lines.push('```');
    lines.push(report.session.task_prompt.slice(0, 2000));
    lines.push('```');
  }
  lines.push('');
  lines.push('## Run receipts');
  lines.push('');
  lines.push(`- run: \`${report.run_id}\``);
  lines.push(`- auth mode: \`${report.auth.mode}\``);
  lines.push(`- model: \`${report.model ?? 'none'}\``);
  if (report.receipts.runtime !== null) {
    lines.push(`- runtime: \`${report.receipts.runtime.version}\` (${report.receipts.runtime.platform})`);
    lines.push(`- runtime digest: \`${report.receipts.runtime.digest}\``);
  }
  for (const [name, artifact] of Object.entries(report.receipts.artifacts)) {
    if (artifact !== null) lines.push(`- artifact ${name}: \`${artifact.digest}\``);
  }
  lines.push(`- process observations: ${report.receipts.process_observations.length}`);
  lines.push(`- native signals: ${report.receipts.native_signals.length} (category-only)`);
  if (report.receipts.omitted_raw_evidence) {
    lines.push('- raw transcript/log evidence omitted because private connection credentials were unavailable for safe redaction');
  }
  lines.push('');
  if (report.errors.length > 0) {
    lines.push('## Diagnostics');
    lines.push('');
    for (const error of report.errors) lines.push(`- \`${error.code}\``);
    lines.push('');
  }
  lines.push('## Overall');
  lines.push('');
  lines.push(`**Score:** ${report.overall.score.toFixed(1)}/5  `);
  lines.push(`**Recommendation:** ${report.overall.recommendation}`);
  lines.push('');
  lines.push(report.overall.summary);
  lines.push('');
  if (report.regressions.length > 0) {
    lines.push('## Regressions');
    lines.push('');
    for (const r of report.regressions) lines.push(`- ${r}`);
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
    lines.push(`| ${step.order} | ${step.name} | ${ratings || 'n/a'} | ${step.defects.join(', ') || '—'} |`);
  }
  lines.push('');
  lines.push('## Defects');
  lines.push('');
  if (report.defects.length === 0) {
    lines.push('No defects recorded.');
  } else {
    for (const d of report.defects) {
      lines.push(`### ${d.id} [${d.severity}] ${d.title}`);
      lines.push('');
      lines.push(`- dimension: \`${d.dimension}\``);
      lines.push(`- step: \`${d.step}\``);
      if (d.repro !== undefined) lines.push(`- repro: \`${d.repro}\``);
      if (d.notes !== undefined) lines.push(`- notes: ${d.notes}`);
      if (d.evidence.length > 0) {
        lines.push('');
        lines.push('Evidence:');
        for (const e of d.evidence) lines.push(`  - \`${e}\``);
      }
      lines.push('');
    }
  }
  lines.push('## Agent quality');
  lines.push('');
  lines.push(`**Rating:** ${report.agent_quality.rating}/5  `);
  lines.push('');
  lines.push(report.agent_quality.rationale);
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
  for (const e of report.evidence) lines.push(`- \`${e}\``);
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
 * Build a scoped ux-e2e report from a prepared run manifest and its
 * registered session records. The manifest is the authority for every
 * path read by this function; host profiles and global omp logs are not
 * consulted.
 */
export function generateReport(
  source: ReportManifestSource,
  input: ReportInput,
  opts: GenerateReportOptions = {},
): GenerateReportResult {
  const context = makeReportContext(source, opts.sessionId);
  const manifest = context.manifest;
  const reportDir = resolve(manifest.roots.evidence);
  ensureOutputDirectory(context.root, reportDir);
  const mdDir = resolve(opts.mdDir ?? join(reportDir, 'markdown'));
  if (!pathInside(reportDir, mdDir)) throw reportError('report_output_outside_run');
  ensureOutputDirectory(context.root, mdDir);

  const selectedSession = displaySession(context);
  const displayMetadata = sessionMetadata(context, selectedSession);
  const selectedLifecycle = asObject(selectedSession);
  const secretValues = context.secretValues;
  const warnings: string[] = [];
  const nativeBySession = nativeEvidencePaths(context);
  const nativePaths = new Set(nativeBySession.values());
  const isolationWithoutSession = selectedSession === undefined
    && input.verification?.suite === 'isolation'
    && context.manifest.status !== 'failed'
    && context.manifest.status !== 'preparing'
    && input.verification.checks.evidence_receipt_written === true
    && input.verification.checks.owned_processes_reaped === true
    && input.verification.checks.rpc_responses_successful === true
    && input.verification.checks.provider_free_selected_model === true
    && input.verification.checks.no_llm === true
    && (manifest.receipts ?? []).some(receipt => {
      const observed = asObject(receipt);
      const path = registeredPath(observed?.evidence_path, context);
      const saved = path === null ? null : readObjectFile(path);
      return observed?.kind === 'process-observation'
        && observed.suite === 'isolation'
        && observed.rpc_responses_successful === true
        && observed.process_exit_clean === true
        && observed.provider_free_model === 'e2e-offline/no-request'
        && observed.provider_free_selected_model === true
        && saved?.kind === 'process-observation'
        && saved.suite === 'isolation'
        && saved.rpc_responses_successful === true
        && saved.process_exit_clean === true
        && saved.provider_free_model === 'e2e-offline/no-request'
        && saved.provider_free_selected_model === true;
    });
  const scopedSessions = opts.sessionId === undefined
    ? context.sessions
    : selectedSession === undefined ? [] : [selectedSession];
  const firstOutcomeIssue = scopedSessions
    .map(session => sessionOutcomeIssue(context, session))
    .find((issue): issue is string => issue !== null);
  const outcomeIssue = isolationWithoutSession
    ? null
    : firstOutcomeIssue ?? (scopedSessions.length === 0 ? 'session_unavailable' : null);
  const unsafePassIssue = outcomeIssue ?? (context.unsafeRawText ? 'report_redaction_unavailable' : null);
  const requestedVerdict = input.verdict === 'PASS' || input.verdict === 'FAIL' || input.verdict === 'CONDITIONAL'
    ? input.verdict
    : 'FAIL';
  let verdict: Verdict = requestedVerdict;
  if (verdict === 'PASS' && unsafePassIssue !== null) {
    verdict = 'FAIL';
    warnings.push(`verdict PASS refused: ${unsafePassIssue}`);
  }
  const rawSlug = context.unsafeRawText
    ? manifest.run_id
    : stringValue(displayMetadata.slug) ?? `run-${manifest.run_id}`;
  const slug = redactText(rawSlug, secretValues)
    .replace(/[^A-Za-z0-9._-]+/gu, '-')
    .replace(/^-+|-+$/gu, '') || 'ux-e2e';

  const defects: UxDefect[] = input.defects.map((defect, index) => ({
    id: reportText(defect.id ?? `D${index + 1}`, context),
    severity: DEFECT_SEVERITIES.includes(defect.severity) ? defect.severity : 'HIGH',
    dimension: UX_DIMENSIONS.includes(defect.dimension) ? defect.dimension : 'error_handling',
    title: reportText(defect.title, context),
    step: reportText(defect.step, context),
    evidence: defect.evidence.map(value => reportText(value, context)),
    ...(defect.repro === undefined ? {} : { repro: reportText(defect.repro, context) }),
    ...(defect.notes === undefined ? {} : { notes: reportText(defect.notes, context) }),
  }));
  const steps: UxStep[] = input.steps.map((step, index) => ({
    id: reportText(step.id ?? `S${index + 1}`, context),
    name: reportText(step.name, context),
    order: typeof step.order === 'number' && Number.isFinite(step.order) ? step.order : index + 1,
    ratings: Object.fromEntries(
      UX_DIMENSIONS
        .filter(dimension => typeof step.ratings[dimension] === 'number')
        .map(dimension => [dimension, step.ratings[dimension]]),
    ) as Partial<Record<UxDimension, number>>,
    defects: step.defects.map(value => reportText(value, context)),
    screenshots: step.screenshots.map(value => reportText(value, context)),
    ...(step.transcript_excerpt === undefined ? {} : { transcript_excerpt: reportText(step.transcript_excerpt, context) }),
    ...(step.notes === undefined ? {} : { notes: reportText(step.notes, context) }),
  }));

  const clampedSteps: UxStep[] = steps.map(step => {
    const floor = floorForStep(defects, step.id);
    const ratings: Partial<Record<UxDimension, number>> = {};
    for (const dim of UX_DIMENSIONS) {
      const value = clampRating(step.ratings[dim], floor, warnings, `${step.id}.${dim}`);
      if (value !== undefined) ratings[dim] = value;
    }
    return { ...step, ratings };
  });

  const allRatings = clampedSteps.flatMap(step =>
    UX_DIMENSIONS.map(dimension => step.ratings[dimension]).filter((value): value is number => value !== undefined),
  );
  let score: number;
  if (input.overall.score !== undefined) {
    score = input.overall.score;
  } else if (allRatings.length > 0) {
    score = allRatings.reduce((a, b) => a + b, 0) / allRatings.length;
  } else {
    score = 4;
  }
  const worstFloor = defects.reduce<number>((floor, defect) => {
    const candidate = DEFECT_FLOORS[defect.severity] ?? 5;
    return candidate < floor ? candidate : floor;
  }, 5);
  score = Math.min(Math.max(score, 1), 5);
  if (score > worstFloor) {
    warnings.push(`overall.score ${score.toFixed(2)} clamped down to defect floor ${worstFloor}`);
    score = worstFloor;
  }
  const requestedRecommendation = input.overall.recommendation;
  const recommendation: Recommendation =
    requestedRecommendation === 'ship' || requestedRecommendation === 'fix-high' || requestedRecommendation === 'rework'
      ? requestedRecommendation
      : score >= 4 ? 'ship' : score >= 3 ? 'fix-high' : 'rework';
  const rawAgentRating = typeof input.agent_quality.rating === 'number' && Number.isFinite(input.agent_quality.rating)
    ? input.agent_quality.rating
    : 0;
  const agentRating = Math.min(Math.max(Math.round(rawAgentRating), 0), 5);
  if (agentRating !== input.agent_quality.rating) {
    warnings.push('agent_quality.rating clamped to a safe range');
  }

  const scenarioValue = asObject(manifest.scenario);
  const scenario: ReportScenario = {
    id: redactText(stringValue(scenarioValue?.id) ?? 'unknown', secretValues),
    path: stringValue(scenarioValue?.path) === null ? undefined : redactText(stringValue(scenarioValue?.path) ?? '', secretValues),
    digest: stringValue(scenarioValue?.digest) ?? undefined,
  };
  const sessionScenario = readScenarioRef(displayMetadata.scenario, context) ?? { id: scenario.id };
  const transcript = recordPath(selectedSession, 'transcript_path', context);
  const log = recordPath(selectedSession, 'log_path', context);
  const sessionJsonl = recordPath(selectedSession, 'session_jsonl', context);
  const nativeEventsSource = selectedSession === undefined ? undefined : nativeBySession.get(selectedSession.id);
  const eventsJsonl = nativeEventsSource === undefined
    ? recordPath(selectedSession, 'events_jsonl', context)
    : reportText(nativeEventsSource, context);
  const evidenceCandidates = collectEvidence(context, clampedSteps.flatMap(step => step.screenshots), nativePaths);
  const unsafeEvidence = context.unsafeRawText && evidenceCandidates.some(candidate =>
    TEXT_EVIDENCE.test(candidate) &&
    !context.sessionJsonPaths.includes(candidate),
  );
  let evidence = context.unsafeRawText
    ? evidenceCandidates.filter(candidate =>
      !TEXT_EVIDENCE.test(candidate) ||
      context.sessionJsonPaths.includes(candidate),
    )
    : evidenceCandidates;
  let omittedRawEvidence = unsafeEvidence;
  let copiedEvidence: ReadonlyMap<string, string> | null = null;
  if (opts.copyEvidence === true) {
    const copied = copyEvidence(evidenceCandidates, join(mdDir, 'evidence', slug), context, warnings, nativePaths);
    evidence = copied.paths;
    copiedEvidence = copied.bySource;
    omittedRawEvidence = unsafeEvidence || copied.omittedRaw;
  }
  const exportedEvidencePath = (path: string): string => copiedEvidence === null || path.length === 0
    ? path
    : copiedEvidence.get(path) ?? '';

  const report: UxE2eReport = {
    type: 'ux-e2e',
    schema_version: 1,
    verdict,
    mode: 'ui',
    run_id: redactText(manifest.run_id, secretValues),
    auth: { mode: manifest.auth.mode },
    model: manifest.model === null ? null : redactText(manifest.model, secretValues),
    scenario,
    receipts: {
      ...buildReceipts(context, omittedRawEvidence),
      ...(input.verification === undefined ? {} : {
        verification: {
          suite: reportText(input.verification.suite, context),
          checks: Object.fromEntries(Object.entries(input.verification.checks)
            .filter(([name]) => /^[A-Za-z0-9_]+$/u.test(name))
            .map(([name, value]) => [name, typeof value === 'string' ? reportText(value, context) : value])),
          session_ids: input.verification.session_ids.map(id => reportText(id, context)),
        },
      }),
    },
    errors: (manifest.errors ?? []).map(error => ({ code: redactText(error.code, secretValues) })),
    regressions: (input.regressions ?? []).map(value => reportText(value, context)),
    session: {
      id: selectedSession === undefined ? null : reportText(selectedSession.id, context),
      slug,
      scratch_dir: redactText(context.root, secretValues),
      omp_version: reportText(stringValue(displayMetadata.omp_version) ?? manifest.runtime.version, context),
      profile: reportText(stringValue(displayMetadata.profile) ?? 'isolated', context),
      tty: readTty(displayMetadata.tty, context),
      started_at: stringValue(selectedLifecycle?.started_at) === null
        ? null
        : reportText(stringValue(selectedLifecycle?.started_at) ?? '', context),
      finished_at: stringValue(displayMetadata.finished_at) === null
        ? null
        : reportText(stringValue(displayMetadata.finished_at) ?? '', context),
      task_prompt: stringValue(displayMetadata.task_prompt) === null
        ? null
        : reportText(stringValue(displayMetadata.task_prompt) ?? '', context),
      scenario: sessionScenario,
      transcript: exportedEvidencePath(transcript),
      session_jsonl: exportedEvidencePath(sessionJsonl),
      events_jsonl: exportedEvidencePath(eventsJsonl),
      omp_log: exportedEvidencePath(log),
    },
    steps: copiedEvidence === null ? clampedSteps : clampedSteps.map(step => ({
      ...step,
      screenshots: step.screenshots
        .map(path => registeredPath(path, context))
        .filter((path): path is string => path !== null)
        .map(path => copiedEvidence.get(path))
        .filter((path): path is string => path !== undefined),
    })),
    defects,
    agent_quality: {
      rating: agentRating,
      rationale: reportText(input.agent_quality.rationale, context),
      ...(input.agent_quality.dimensions === undefined
        ? {}
        : {
            dimensions: Object.fromEntries(
              AGENT_DIMENSIONS
                .filter(dimension => typeof input.agent_quality.dimensions?.[dimension] === 'number')
                .map(dimension => [dimension, input.agent_quality.dimensions?.[dimension]]),
            ) as Partial<Record<AgentDimension, number>>,
          }),
    },
    overall: {
      score,
      summary: reportText(input.overall.summary, context),
      recommendation,
    },
    evidence: evidence.map(path => context.unsafeRawText ? REDACTED : redactText(path, secretValues)),
    generated_at: new Date().toISOString(),
  };

  const safeReport = redactUnknown(report, secretValues, true) as UxE2eReport;
  if (opts.outputId !== undefined && !SESSION_ID_RE.test(opts.outputId)) throw reportError('report_output_id_invalid');
  const reportSessionDir = ensureOutputDirectory(context.root, join(reportDir, opts.outputId ?? selectedSession?.id ?? 'run'));
  const jsonPath = join(reportSessionDir, 'report.json');
  const mdPath = join(mdDir, `${slug}-ux-e2e-${todayStamp()}.md`);
  writeNoFollowFile(jsonPath, JSON.stringify(safeReport, null, 2) + '\n');
  writeNoFollowFile(mdPath, renderMarkdown(safeReport));
  return { jsonPath, mdPath, warnings };
}
