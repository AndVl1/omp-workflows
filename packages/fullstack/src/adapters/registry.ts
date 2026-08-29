/* <!-- omp-cto-slice run=01a03ee4-7dd6-7580-8ad7-16d26dc886ba slice=workflow-v2-fullstack --> */

import { createHash } from "node:crypto";
import {
  createDiagnostic,
  failureResult,
  isCanonicalRoot,
  isTrustedFsAuthority,
  sanitizeEscalation,
  successResult,
  validateEscalation,
  validateWorkflowRunIdentity,
  type CanonicalRoot,
  type ChannelProfile,
  type DiagnosticResult,
  type Escalation,
  type EscalationAdapter,
  type EscalationAnswer,
  type EscalationInboundMessage,
  type EscalationReceipt,
  type TrustedFsAuthority,
  type WorkflowRunIdentity,
  type WorkflowV2Digest,
  type WorkflowV2Diagnostic,
} from "@andvl1/omp-workflows-core";
import {
  isChannelAdmission,
  isFullstackStorageAuthority,
  type ChannelAdmission,
  type FullstackStorageAuthority,
  type StorageEntry,
  type StorageFailure,
  type StorageLease,
  type StorageResult,
} from "../storage-authority.js";
import { HttpEscalationAdapter, type AdmittedHttpTransport } from "./http.js";
import { MockEscalationAdapter } from "./mock.js";
import { TelegramEscalationAdapter } from "./telegram.js";

/** Explicitly bound project/run context. Filesystem authority is never inferred. */
export interface AdapterRuntimeContext {
  readonly project_root: CanonicalRoot;
  readonly run_identity: WorkflowRunIdentity;
  readonly filesystem_authority: TrustedFsAuthority;
  /** Pinned bounded durable storage; absent means phase-3 capability missing. */
  readonly storage?: FullstackStorageAuthority;
  /** Host/manager-issued immutable channel admission; never read from disk. */
  readonly channel_admission?: ChannelAdmission;
  /** Fixed provider-runtime HTTP capability; absent means HTTP is unavailable. */
  readonly http_transport?: AdmittedHttpTransport;
}

/** Channel configuration is now an opaque manager admission, not a project file. */
export type EscalationConfig = ChannelAdmission;

export interface AdapterFactoryContext extends AdapterRuntimeContext {
  readonly config: EscalationConfig;
  readonly channel_admission: ChannelAdmission;
  readonly channel: Readonly<Record<string, unknown>>;
  readonly storage?: FullstackStorageAuthority;
  /** Already-issued internal transport; arbitrary HTTP callbacks are forbidden. */
  readonly http_transport?: AdmittedHttpTransport;
}
export type EscalationAdapterFactory = (context: AdapterFactoryContext) => EscalationAdapter | null;
export type EscalationAdapterFactories = Map<string, EscalationAdapterFactory>;

export interface ChannelSet {
  readonly context: AdapterRuntimeContext;
  readonly channel_admission: ChannelAdmission;
  readonly profiles: readonly ChannelProfile[];
  readonly profile: ChannelProfile;
  readonly primary: EscalationAdapter | null;
  readonly roSinks: readonly EscalationAdapter[];
}

export interface ChannelSetOptions extends AdapterRuntimeContext {
  readonly channel_admission?: ChannelAdmission;
  readonly factories?: ReadonlyMap<string, EscalationAdapterFactory>;
}

export interface DispatcherOptions {
  readonly onTask?: (task: InboxTask) => Promise<void>;
  readonly onAnswer?: (answer: EscalationAnswer) => void;
  readonly onDiagnostic?: (diagnostic: WorkflowV2Diagnostic) => void;
  readonly intervalMs?: number;
}
export interface DispatcherHandle {
  readonly stop: () => void | Promise<void>;
}
export interface InboxTask extends EscalationInboundMessage { readonly by?: string; }
export type DeliveryIntent = "ack" | "question" | "progress" | "summary";
export type CtoDelivery = Escalation & { readonly intent: DeliveryIntent; readonly target?: string; readonly topic?: string };

const MAX_CHANNELS = 16;
const MAX_DURABLE_TIMESTAMP_BYTES = 128;
const MAX_INBOX_TEXT_LENGTH = 4_000;
const MAX_RECORD_BYTES = 4 * 1024 * 1024;
const MAX_JSON_DEPTH = 64;
const MAX_DIRECTORY_ENTRIES = 512;
const MAX_RETRIES = 8;
const DISPATCHER_INTERVAL_MS = 10_000;
const SAFE_RUN_ID = /^[A-Za-z0-9_-]+$/u;
const SAFE_ID = /^[A-Za-z0-9._:-]+$/u;
const DISPATCHER_LOCK_RELATIVE_PATH = ".omp/cto-dispatcher.lock";
export { MAX_INBOX_TEXT_LENGTH };

function diagnostic(
  code: "ROOT_UNAVAILABLE" | "CONFIG_MALFORMED" | "IDENTITY_MISMATCH" | "CAPABILITY_MISSING" | "ACTIVATION_FAILED" | "MIGRATION_REQUIRED" | "UNSAFE_PATH",
  operation: "root.resolve" | "runtime.activate" | "tool.dispatch" | "policy.read",
  remediation: string,
  evidence: Record<string, string | number | boolean | null | readonly string[]> = {},
): WorkflowV2Diagnostic {
  return createDiagnostic({ code, operation, remediation, evidence });
}

class InboundTaskDispatchError extends Error {
  readonly diagnostic: WorkflowV2Diagnostic;

  constructor(diagnostic: WorkflowV2Diagnostic) {
    super(diagnostic.remediation);
    this.name = "InboundTaskDispatchError";
    this.diagnostic = diagnostic;
  }
}
class DispatcherStopError extends Error {
  readonly diagnostic: WorkflowV2Diagnostic;

  constructor(diagnostic: WorkflowV2Diagnostic) {
    super(diagnostic.remediation);
    this.name = "DispatcherStopError";
    this.diagnostic = diagnostic;
  }
}

function sameRun(left: WorkflowRunIdentity, right: WorkflowRunIdentity): boolean {
  return left.root_instance_id === right.root_instance_id
    && left.provider_id === right.provider_id
    && left.descriptor_fingerprint === right.descriptor_fingerprint
    && left.executable_provenance.build_fingerprint === right.executable_provenance.build_fingerprint
    && left.executable_provenance.runtime_fingerprint === right.executable_provenance.runtime_fingerprint
    && left.catalog_content_digest === right.catalog_content_digest
    && left.config_byte_sha256 === right.config_byte_sha256
    && left.config_semantic_sha256 === right.config_semantic_sha256
    && left.session.session_id === right.session.session_id
    && left.session.lifecycle_id === right.session.lifecycle_id
    && left.run_id === right.run_id
    && left.profile_identity.id === right.profile_identity.id
    && left.profile_identity.fingerprint === right.profile_identity.fingerprint;
}
/**
 * Admit a channel set to a dispatcher only when both were assembled from the
 * same semantic run/root and the same opaque authority objects. This check is
 * deliberately side-effect free and must stay before startDispatcherLoop:
 * that loop acquires the durable dispatcher lease and starts both poll loops.
 *
 * AdapterRuntimeContext has no inventory binding at this seam, so there is no
 * inventory pin to compare here.
 */
function admitChannelSetContext(
  context: AdapterRuntimeContext,
  channelSet: ChannelSet,
): DiagnosticResult<true> {
  if (!context || !channelSet || typeof channelSet !== "object" || !channelSet.context || typeof channelSet.context !== "object") {
    return failureResult(diagnostic("CAPABILITY_MISSING", "runtime.activate", "Provide a channel set carrying its explicit runtime context.", { field: "channel_set.context" }));
  }
  const channelContext = channelSet.context;
  const dispatcherRun = validateWorkflowRunIdentity(context.run_identity);
  const channelRun = validateWorkflowRunIdentity(channelContext.run_identity);
  if (!dispatcherRun.ok || !channelRun.ok
    || context.project_root !== channelContext.project_root
    || !sameRun(channelRun.value, dispatcherRun.value)) {
    return failureResult(diagnostic("IDENTITY_MISMATCH", "runtime.activate", "Use a channel set and dispatcher bound to the exact canonical root and WorkflowRunIdentity.", { field: "channel_set.context" }));
  }
  if (!isTrustedFsAuthority(context.filesystem_authority) || !isTrustedFsAuthority(channelContext.filesystem_authority)) {
    return failureResult(diagnostic("CAPABILITY_MISSING", "runtime.activate", "Provide the launcher-issued trusted filesystem authority for both the channel set and dispatcher.", { field: "filesystem_authority" }));
  }
  if (context.filesystem_authority !== channelContext.filesystem_authority) {
    return failureResult(diagnostic("IDENTITY_MISMATCH", "runtime.activate", "Use the exact filesystem authority that created the channel set.", { field: "filesystem_authority" }));
  }
  if (!isFullstackStorageAuthority(context.storage) || !isFullstackStorageAuthority(channelContext.storage)) {
    return failureResult(diagnostic("CAPABILITY_MISSING", "runtime.activate", "Provide the pinned FullstackStorageAuthority for both the channel set and dispatcher.", { field: "storage" }));
  }
  if (context.storage !== channelContext.storage) {
    return failureResult(diagnostic("IDENTITY_MISMATCH", "runtime.activate", "Use the exact storage authority that created the channel set.", { field: "storage" }));
  }

  const channelAdmission = channelSet.channel_admission;
  const dispatcherAdmission = context.channel_admission;
  if (!isChannelAdmission(channelAdmission) || !isChannelAdmission(dispatcherAdmission)) {
    return failureResult(diagnostic("CAPABILITY_MISSING", "runtime.activate", "Provide the exact manager-issued ChannelAdmission to the dispatcher.", { field: "channel_admission" }));
  }
  if (channelAdmission.project_root !== context.project_root
    || !sameRun(channelAdmission.run_identity, dispatcherRun.value)
    || dispatcherAdmission !== channelAdmission
    || dispatcherAdmission.config_digest !== channelAdmission.config_digest) {
    return failureResult(diagnostic("IDENTITY_MISMATCH", "runtime.activate", "Use the exact channel admission and configuration digest that created the channel set.", { field: "channel_admission" }));
  }
  if (channelContext.channel_admission !== undefined) {
    if (!isChannelAdmission(channelContext.channel_admission)) {
      return failureResult(diagnostic("CAPABILITY_MISSING", "runtime.activate", "Use an issued ChannelAdmission in the channel set context.", { field: "channel_set.context.channel_admission" }));
    }
    if (channelContext.channel_admission !== channelAdmission
      || channelContext.channel_admission.config_digest !== channelAdmission.config_digest) {
      return failureResult(diagnostic("IDENTITY_MISMATCH", "runtime.activate", "Use the exact ChannelAdmission that created the channel set.", { field: "channel_set.context.channel_admission" }));
    }
  }

  const channelHttp = channelContext.http_transport;
  if (channelHttp !== context.http_transport) {
    if (!channelHttp || !context.http_transport) {
      return failureResult(diagnostic("CAPABILITY_MISSING", "runtime.activate", "Provide the exact admitted HTTP transport used to create the channel set.", { field: "http_transport" }));
    }
    return failureResult(diagnostic("IDENTITY_MISMATCH", "runtime.activate", "Use the exact admitted HTTP transport that created the channel set.", { field: "http_transport" }));
  }
  if (channelHttp !== undefined) {
    const transportRun = validateWorkflowRunIdentity(channelHttp.run_identity);
    if (!transportRun.ok
      || channelHttp.canonical_root !== context.project_root
      || !sameRun(transportRun.value, dispatcherRun.value)
      || channelHttp.channel_config_digest !== channelAdmission.config_digest) {
      return failureResult(diagnostic("IDENTITY_MISMATCH", "runtime.activate", "Use an HTTP capability pinned to this root, run, and admitted channel policy.", { field: "http_transport" }));
    }
  }
  return successResult(true);
}


function checkedContext(context: AdapterRuntimeContext): DiagnosticResult<AdapterRuntimeContext> {
  if (!context || !isCanonicalRoot(context.project_root)) return failureResult(diagnostic("ROOT_UNAVAILABLE", "root.resolve", "Provide the canonical root from the root manager; adapters never infer cwd."));
  const run = validateWorkflowRunIdentity(context.run_identity);
  if (!run.ok) return failureResult(diagnostic("IDENTITY_MISMATCH", "runtime.activate", "Provide the complete WorkflowRunIdentity selected by workflow_prepare.", { field: "run_identity" }));
  if (!SAFE_RUN_ID.test(run.value.run_id)) return failureResult(diagnostic("UNSAFE_PATH", "runtime.activate", "Use a safe run id before activating durable adapters.", { field: "run_identity.run_id" }));
  if (!isTrustedFsAuthority(context.filesystem_authority)) return failureResult(diagnostic("CAPABILITY_MISSING", "runtime.activate", "Provide the launcher-issued trusted filesystem authority before durable adapter I/O.", { field: "filesystem_authority" }));
  if (context.storage !== undefined) {
    if (!isFullstackStorageAuthority(context.storage)) return failureResult(diagnostic("CAPABILITY_MISSING", "runtime.activate", "Provide the launcher-issued FullstackStorageAuthority.", { field: "storage" }));
    if (context.storage.project_root !== context.project_root || !sameRun(context.storage.run_identity, run.value)) return failureResult(diagnostic("IDENTITY_MISMATCH", "runtime.activate", "Pin storage to the exact canonical root and WorkflowRunIdentity.", { field: "storage" }));
  }
  if (context.channel_admission !== undefined) {
    if (!isChannelAdmission(context.channel_admission)) return failureResult(diagnostic("CAPABILITY_MISSING", "runtime.activate", "Provide the opaque manager-issued channel admission.", { field: "channel_admission" }));
    if (context.channel_admission.project_root !== context.project_root || !sameRun(context.channel_admission.run_identity, run.value)) return failureResult(diagnostic("IDENTITY_MISMATCH", "runtime.activate", "Use channel configuration admitted for the exact canonical root and workflow run.", { field: "channel_admission" }));
  }
  return successResult(Object.freeze({ ...context, run_identity: run.value }));
}

function requireStorage(context: AdapterRuntimeContext): DiagnosticResult<FullstackStorageAuthority> {
  const checked = checkedContext(context);
  if (!checked.ok) return checked as DiagnosticResult<FullstackStorageAuthority>;
  if (!checked.value.storage) return failureResult(diagnostic("CAPABILITY_MISSING", "runtime.activate", "Inject the phase-3 pinned and bounded FullstackStorageAuthority before durable I/O.", { field: "storage" }));
  return successResult(checked.value.storage);
}

function requireAdmission(context: AdapterRuntimeContext, admission: ChannelAdmission | undefined): DiagnosticResult<ChannelAdmission> {
  const checked = checkedContext(context);
  if (!checked.ok) return checked as DiagnosticResult<ChannelAdmission>;
  if (!admission || !isChannelAdmission(admission)) return failureResult(diagnostic("CAPABILITY_MISSING", "runtime.activate", "Inject the opaque manager-issued immutable channel admission; project config is not an authority.", { field: "channel_admission" }));
  if (admission.project_root !== checked.value.project_root || !sameRun(admission.run_identity, checked.value.run_identity)) return failureResult(diagnostic("IDENTITY_MISMATCH", "runtime.activate", "Use an admission bound to the exact canonical root and WorkflowRunIdentity.", { field: "channel_admission" }));
  if (admission.channels.length === 0 || admission.channels.length > MAX_CHANNELS) return failureResult(diagnostic("CONFIG_MALFORMED", "runtime.activate", "Use a bounded admitted channel set."));
  return successResult(admission);
}

function storageFailure<T>(result: StorageFailure): DiagnosticResult<T> {
  const code = result.reason === "CAPABILITY_MISSING" || result.reason === "MIGRATION_REQUIRED" || result.reason === "IDENTITY_MISMATCH" || result.reason === "UNSAFE_PATH"
    ? result.reason
    : "ACTIVATION_FAILED";
  return failureResult(diagnostic(code, "runtime.activate", result.message ?? "The pinned storage capability rejected the operation."));
}

const SURROUNDING_CONTROL = /(?:^\p{Cc})|(?:\p{Cc}$)/u;

export function isDurableTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0) return false;
  if (Buffer.byteLength(value, "utf8") > MAX_DURABLE_TIMESTAMP_BYTES) return false;
  if (SURROUNDING_CONTROL.test(value)) return false;
  return Number.isFinite(Date.parse(value));
}

function durableFilenameKey(value: string): string {
  return createHash("sha256").update(Buffer.from(value, "utf8")).digest("hex");
}

function digestOf(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("non-finite JSON number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  if (typeof value !== "object") throw new TypeError("non-JSON value");
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

function bytesOf(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

function exactRecord(left: unknown, right: unknown): boolean {
  try { return canonicalJson(left) === canonicalJson(right); } catch { return false; }
}
const dispatcherTaskClaimBrand = Symbol("dispatcherTaskClaimBrand");
interface DispatcherTaskClaim {
  readonly [dispatcherTaskClaimBrand]: "DispatcherTaskClaim";
  readonly storage: FullstackStorageAuthority;
  readonly run_identity: WorkflowRunIdentity;
  readonly lease: StorageLease;
}
type InboxTaskDispatchResult = DiagnosticResult<string | null>;
type InboundTaskDispatcher = (task: InboxTask) => Promise<InboxTaskDispatchResult>;
interface InboxTaskFlightKey {
  readonly task_id: string;
  readonly key: string;
}
interface InboxTaskFlight {
  readonly key: InboxTaskFlightKey;
  readonly promise: Promise<InboxTaskDispatchResult>;
}

function createDispatcherTaskClaim(
  storage: FullstackStorageAuthority,
  run: WorkflowRunIdentity,
  lease: StorageLease,
): DispatcherTaskClaim {
  return Object.freeze({
    [dispatcherTaskClaimBrand]: "DispatcherTaskClaim" as const,
    storage,
    run_identity: run,
    lease,
  });
}

function hasDispatcherTaskClaim(
  claim: DispatcherTaskClaim | undefined,
  storage: FullstackStorageAuthority,
  run: WorkflowRunIdentity,
): boolean {
  return claim !== undefined
    && claim[dispatcherTaskClaimBrand] === "DispatcherTaskClaim"
    && claim.storage === storage
    && sameRun(claim.run_identity, run)
    && claim.lease.relative_path === DISPATCHER_LOCK_RELATIVE_PATH
    && sameRun(claim.lease.run_identity, run)
    && typeof claim.lease.lease_id === "string"
    && claim.lease.lease_id.length > 0;
}

function inboxTaskFlightKey(task: InboxTask, run: WorkflowRunIdentity): InboxTaskFlightKey | undefined {
  const record = validateInboundTaskRecord(task, run);
  if (!record) return undefined;
  try {
    return { task_id: record.id, key: `${durableFilenameKey(record.id)}:${digestOf(record)}` };
  } catch {
    return undefined;
  }
}

function entryPath(entry: StorageEntry): string { return entry.relative_path; }

function runBase(run: WorkflowRunIdentity): string { return `.work-state/cto/${run.run_id}`; }
function outboxRelative(run: WorkflowRunIdentity): string { return `${runBase(run)}/outbox`; }
function inboxRelative(run: WorkflowRunIdentity): string { return `${runBase(run)}/inbox`; }
function answerRelative(run: WorkflowRunIdentity): string { return `${runBase(run)}/answers`; }
function answerProcessedRelative(run: WorkflowRunIdentity): string { return `${answerRelative(run)}/processed`; }
function answerProcessedPath(run: WorkflowRunIdentity, answerId: string): string { return `${answerProcessedRelative(run)}/answer-${durableFilenameKey(answerId)}.json`; }
function answerPendingPath(run: WorkflowRunIdentity, answerId: string): string { return `${answerRelative(run)}/answer-${durableFilenameKey(answerId)}.json`; }
function localDropRelative(): string { return ".omp/inbox"; }
function validateConfig(config: ChannelAdmission): DiagnosticResult<ChannelAdmission> {
  if (!isChannelAdmission(config)) return failureResult(diagnostic("CAPABILITY_MISSING", "runtime.activate", "Provide the opaque manager-issued channel admission."));
  if (config.channels.length === 0 || config.channels.length > MAX_CHANNELS) return failureResult(diagnostic("CONFIG_MALFORMED", "runtime.activate", "Use a bounded admitted channels[] configuration."));
  if (config.config_digest.length !== 71 || !/^sha256:[0-9a-f]{64}$/u.test(config.config_digest)) return failureResult(diagnostic("CONFIG_MALFORMED", "runtime.activate", "Use the manager-computed channel configuration digest."));
  return successResult(config);
}

function stringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string") ? [...value] as string[] : undefined;
}


function isChannelEntry(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;
  return typeof entry.adapter === "string" && entry.adapter.length > 0 && (entry.direction === "read-write" || entry.direction === "read-only");
}

/**
 * RO sink subscriptions are bound by the manager-issued channel profile, not
 * inferred from the adapter implementation. Adapters passed directly to
 * drainOutbox (legacy callers/tests) have no marker and therefore receive all
 * summary topics.
 */
const RO_SINK_SUBSCRIPTIONS = Symbol("omp-cto-ro-sink-subscriptions");

interface RoSinkMarker {
  [RO_SINK_SUBSCRIPTIONS]?: readonly string[];
}

function builtinFactories(): EscalationAdapterFactories {
  return new Map<string, EscalationAdapterFactory>([
    ["http", ({ channel, channel_admission, run_identity, http_transport }) => {
      if (!http_transport) return null;
      const channelId = typeof channel.id === "string" ? channel.id : undefined;
      return new HttpEscalationAdapter({
        transport: http_transport,
        run_identity,
        channel_admission,
        ...(channelId ? { channel_id: channelId } : {}),
      });
    }],
    ["telegram", ({ channel, project_root, run_identity, storage, channel_admission }) => {
      if (typeof channel.token !== "string" || typeof channel.chatId !== "string" || !storage) return null;
      return new TelegramEscalationAdapter({
        token: channel.token,
        chatId: channel.chatId,
        project_root,
        run_identity,
        storage,
        channel_admission,
        allowedChatIds: channel_admission.allowed_chat_ids,
        allowedSenderIds: channel_admission.allowed_sender_ids,
        ...(typeof channel.id === "string" ? { channel_id: channel.id } : {}),
        pollIntervalMs: typeof channel.pollIntervalMs === "number" ? channel.pollIntervalMs : undefined,
      });
    }],
  ]);
}

export function createAdapterFactories(): EscalationAdapterFactories { return builtinFactories(); }

export function registerEscalationAdapterFactory(factories: EscalationAdapterFactories, kind: string, factory: EscalationAdapterFactory): DiagnosticResult<true> {
  if (!(factories instanceof Map) || !SAFE_ID.test(kind) || typeof factory !== "function" || kind === "http") {
    return failureResult(diagnostic("CONFIG_MALFORMED", "runtime.activate", "HTTP is owned by the fixed provider-runtime transport; register only non-HTTP test/host factories."));
  }
  factories.set(kind, factory);
  return successResult(true);
}

function createAdapterForEntry(
  context: AdapterRuntimeContext,
  admission: ChannelAdmission,
  entry: Record<string, unknown>,
  factories?: ReadonlyMap<string, EscalationAdapterFactory>,
): DiagnosticResult<EscalationAdapter> {
  const builtins = builtinFactories();
  const factory = entry.adapter === "http"
    ? builtins.get("http")
    : (factories ?? builtins).get(String(entry.adapter));
  if (!factory) return failureResult(diagnostic("CAPABILITY_MISSING", "runtime.activate", "The requested transport has no explicit factory; test doubles require explicit factory injection.", { field: String(entry.adapter) }));
  const needsStorage = entry.adapter === "telegram" || entry.adapter === "mock" || entry.direction === "read-write";
  const storage = context.storage ?? undefined;
  if (needsStorage && !storage) {
    const checked = requireStorage(context);
    return checked as DiagnosticResult<EscalationAdapter>;
  }
  try {
    const adapter = factory({ ...context, config: admission, channel_admission: admission, channel: entry, storage, http_transport: context.http_transport });
    if (adapter) return successResult(adapter);
    const code = entry.adapter === "http" ? "CAPABILITY_MISSING" : "ACTIVATION_FAILED";
    const remediation = entry.adapter === "http"
      ? "Inject the already-issued fixed provider-runtime HTTP transport capability; phase 2 has no network fallback."
      : "The explicit escalation transport could not be activated.";
    return failureResult(diagnostic(code, "runtime.activate", remediation, { field: String(entry.adapter) }));
  } catch {
    const code = entry.adapter === "http" ? "CAPABILITY_MISSING" : "ACTIVATION_FAILED";
    const remediation = entry.adapter === "http"
      ? "Inject the already-issued fixed provider-runtime HTTP transport capability; phase 2 has no network fallback."
      : "The explicit escalation transport factory failed closed.";
    return failureResult(diagnostic(code, "runtime.activate", remediation, { field: String(entry.adapter) }));
  }
}

export function createEscalationAdapter(context: AdapterRuntimeContext, config: EscalationConfig, factories?: ReadonlyMap<string, EscalationAdapterFactory>): DiagnosticResult<EscalationAdapter> {
  const checked = checkedContext(context);
  if (!checked.ok) return checked as DiagnosticResult<EscalationAdapter>;
  const admission = requireAdmission(checked.value, config);
  if (!admission.ok) return admission as DiagnosticResult<EscalationAdapter>;
  const validated = validateConfig(admission.value);
  if (!validated.ok) return validated as DiagnosticResult<EscalationAdapter>;
  const entry = validated.value.channels[0];
  if (!entry || !isChannelEntry(entry)) return failureResult(diagnostic("CONFIG_MALFORMED", "runtime.activate", "Provide an explicit admitted channel entry."));
  return createAdapterForEntry(checked.value, validated.value, entry, factories);
}

function profileFor(entry: Record<string, unknown>, context: AdapterRuntimeContext, adapter: EscalationAdapter): ChannelProfile {
  const rw = entry.direction === "read-write" && typeof adapter.sendPlainText === "function" && (typeof adapter.pollOnce === "function" || typeof adapter.setPlainMessageHandler === "function");
  return Object.freeze({
    direction: rw ? "rw" : "ro",
    transport: String(entry.adapter),
    adapter: String(entry.adapter),
    ...(typeof entry.id === "string" ? { id: entry.id } : {}),
    ...(typeof entry.ackTarget === "string" ? { ackTarget: entry.ackTarget } : {}),
    primary: entry.primary === true,
    ...(stringArray(entry.subscriptions) ? { subscriptions: stringArray(entry.subscriptions) } : {}),
    run_identity: context.run_identity,
  });
}

export function createChannelSet(options: ChannelSetOptions): DiagnosticResult<ChannelSet> {
  const checked = checkedContext(options);
  if (!checked.ok) return checked as DiagnosticResult<ChannelSet>;
  const admission = requireAdmission(checked.value, options.channel_admission ?? checked.value.channel_admission);
  if (!admission.ok) return admission as DiagnosticResult<ChannelSet>;
  const factories = options.factories ?? builtinFactories();
  const entries: Array<{ profile: ChannelProfile; adapter: EscalationAdapter }> = [];
  for (const entry of admission.value.channels) {
    if (!isChannelEntry(entry)) return failureResult(diagnostic("CONFIG_MALFORMED", "runtime.activate", "Each admitted channel must contain an adapter and explicit direction."));
    const built = createAdapterForEntry({ ...checked.value, channel_admission: admission.value }, admission.value, entry, factories);
    if (!built.ok) return built as DiagnosticResult<ChannelSet>;
    entries.push({ profile: profileFor(entry, checked.value, built.value), adapter: built.value });
  }
  const rw = entries.filter((entry) => entry.profile.direction === "rw");
  const ro = entries.filter((entry) => entry.profile.direction === "ro");
  const chosen = rw.find((entry) => entry.profile.primary) ?? rw[0] ?? ro.find((entry) => entry.profile.primary) ?? ro[0];
  const profile = chosen?.profile ?? Object.freeze({ direction: "none" as const, run_identity: checked.value.run_identity });
  const roSinks = ro.map((entry) => {
    Object.defineProperty(entry.adapter, RO_SINK_SUBSCRIPTIONS, {
      value: entry.profile.subscriptions,
      enumerable: false,
      configurable: true,
    });
    return entry.adapter;
  });
  return successResult(Object.freeze({ context: checked.value, channel_admission: admission.value, profiles: Object.freeze(entries.map((entry) => entry.profile)), profile, primary: chosen && chosen.profile.direction === "rw" ? chosen.adapter : null, roSinks: Object.freeze(roSinks) }));
}

export function isBidirectionalChannel(options: ChannelSetOptions): boolean {
  const result = createChannelSet(options);
  return result.ok && result.value.profile.direction === "rw" && result.value.primary !== null;
}

export function sha256Hex(text: string): WorkflowV2Digest {
  return `sha256:${createHash("sha256").update(text.trim(), "utf8").digest("hex")}`;
}

export function queueCtoDelivery(context: AdapterRuntimeContext, delivery: CtoDelivery): DiagnosticResult<string | null> {
  const checked = checkedContext(context);
  if (!checked.ok) return checked as DiagnosticResult<string | null>;
  const storage = requireStorage(checked.value);
  if (!storage.ok) return storage as DiagnosticResult<string | null>;
  if (!sameRun(delivery.run_identity, checked.value.run_identity)) return failureResult(diagnostic("IDENTITY_MISMATCH", "runtime.activate", "Queue delivery under the exact prepared run identity.", { field: "delivery.run_identity" }));
  if (validateEscalation(delivery)) return failureResult(diagnostic("CONFIG_MALFORMED", "runtime.activate", "Queue only a valid escalation envelope."));
  const run = checked.value.run_identity;
  const relativePath = `${outboxRelative(run)}/${durableFilenameKey(delivery.id)}.json`;
  const record = { ...delivery, run_identity: run };
  const bytes = bytesOf(record);
  const archivePaths = [
    `${outboxRelative(run)}/sent/${durableFilenameKey(delivery.id)}.json`,
    `${outboxRelative(run)}/skipped/${durableFilenameKey(delivery.id)}.json`,
  ];
  const inspectArchives = (): DiagnosticResult<string | null> | undefined => {
    let found = false;
    for (const archivePath of archivePaths) {
      const existing = storage.value.readJsonBounded(archivePath, MAX_RECORD_BYTES, MAX_JSON_DEPTH);
      if (!existing.ok) return storageFailure<string | null>(existing);
      if (existing.value === null) continue;
      found = true;
      if (!exactRecord(existing.value, record)) {
        return failureResult(diagnostic("IDENTITY_MISMATCH", "runtime.activate", "A terminal outbox key contains a conflicting exact record.", { field: "delivery.id" }));
      }
    }
    return found ? successResult(null) : undefined;
  };
  const archived = inspectArchives();
  if (archived) return archived;
  const written = storage.value.writeJsonExclusive(relativePath, bytes);
  if (written.ok) return successResult(relativePath);
  const active = storage.value.readJsonBounded(relativePath, MAX_RECORD_BYTES, MAX_JSON_DEPTH);
  if (!active.ok) return storageFailure(active);
  if (active.value !== null) {
    if (exactRecord(active.value, record)) return successResult(null);
    return storageFailure(written);
  }
  const archivedAfter = inspectArchives();
  if (archivedAfter) return archivedAfter;
  return storageFailure(written);

}

export async function handleInboxTask(
  context: AdapterRuntimeContext,
  task: InboxTask,
  onTask?: (task: InboxTask) => Promise<void>,
  signal?: AbortSignal,
): Promise<DiagnosticResult<string | null>> {
  return handleInboxTaskInternal(context, task, onTask, signal);
}

async function handleInboxTaskInternal(
  context: AdapterRuntimeContext,
  task: InboxTask,
  onTask: ((task: InboxTask) => Promise<void>) | undefined,
  signal: AbortSignal | undefined,
  claim?: DispatcherTaskClaim,
): Promise<DiagnosticResult<string | null>> {
  const checked = checkedContext(context);
  if (!checked.ok) return checked as DiagnosticResult<string | null>;
  const storage = requireStorage(checked.value);
  if (!storage.ok) return storage as DiagnosticResult<string | null>;
  const run = validateWorkflowRunIdentity(task.run_identity);
  if (!run.ok || !sameRun(run.value, checked.value.run_identity)) return failureResult(diagnostic("IDENTITY_MISMATCH", "runtime.activate", "Route inbound work only to the exact active run.", { field: "task.run_identity" }));
  const record = validateInboundTaskRecord(task, checked.value.run_identity);
  if (!record) return failureResult(diagnostic("CONFIG_MALFORMED", "runtime.activate", "Reject inbound tasks with an incomplete or invalid durable record."));
  if (signal?.aborted) return failureResult(diagnostic("ACTIVATION_FAILED", "runtime.activate", "Dispatcher stopped before inbound task processing completed; the exact durable record remains pending."));
  if (onTask !== undefined && !hasDispatcherTaskClaim(claim, storage.value, checked.value.run_identity)) {
    return failureResult(diagnostic("CAPABILITY_MISSING", "runtime.activate", "Inbound task callback execution requires an active leased dispatcher; the durable source remains pending."));
  }
  const name = `${durableFilenameKey(record.id)}.json`;
  const relativePath = `${inboxRelative(checked.value.run_identity)}/${name}`;
  const processedPath = `${inboxRelative(checked.value.run_identity)}/processed/${name}`;
  const processed = storage.value.readJsonBounded(processedPath, MAX_RECORD_BYTES, MAX_JSON_DEPTH);
  if (!processed.ok) return storageFailure(processed);
  if (processed.value !== null) {
    return exactRecord(processed.value, record) ? successResult(null) : failureResult(diagnostic("IDENTITY_MISMATCH", "runtime.activate", "A processed inbound key contains a conflicting exact record."));
  }
  const written = storage.value.writeJsonExclusive(relativePath, bytesOf(record));
  if (!written.ok) {
    const existing = storage.value.readJsonBounded(relativePath, MAX_RECORD_BYTES, MAX_JSON_DEPTH);
    if (!existing.ok || existing.value === null || !exactRecord(existing.value, record)) return storageFailure(written);
  }
  if (onTask === undefined) {
    if (signal?.aborted) {
      return failureResult(diagnostic("ACTIVATION_FAILED", "runtime.activate", "Dispatcher stopped before inbound task processing completed; the exact durable record remains pending."));
    }
    return successResult(written.ok ? relativePath : null);
  }
  const callbackFailure = failureResult<string | null>(
    diagnostic("ACTIVATION_FAILED", "runtime.activate", "Inbound filing succeeded but its callback failed; the exact durable record is retained for retry."),
  );
  const complete = (): DiagnosticResult<string | null> => {
    if (signal?.aborted) return callbackFailure;
    const moved = storage.value.moveExclusive(relativePath, processedPath);
    if (!moved.ok) {
      const processedAfter = storage.value.readJsonBounded(processedPath, MAX_RECORD_BYTES, MAX_JSON_DEPTH);
      if (!processedAfter.ok || processedAfter.value === null || !exactRecord(processedAfter.value, record)) return storageFailure(moved);
    }
    return successResult(written.ok ? relativePath : null);
  };
  try {
    await onTask(record);
  } catch {
    return callbackFailure;
  }
  if (signal?.aborted) return callbackFailure;
  return complete();
}

function reportDiagnostic(
  onDiagnostic: ((diagnostic: WorkflowV2Diagnostic) => void) | undefined,
  value: WorkflowV2Diagnostic,
  signal?: AbortSignal,
): void {
  if (signal?.aborted) return;
  try { onDiagnostic?.(value); } catch { /* diagnostics must not break the dispatcher */ }
}

function operationDiagnostic(result: StorageFailure | undefined, fallback: string): WorkflowV2Diagnostic {
  const code = result?.reason === "CAPABILITY_MISSING" || result?.reason === "MIGRATION_REQUIRED" || result?.reason === "IDENTITY_MISMATCH" || result?.reason === "UNSAFE_PATH" ? result.reason : "ACTIVATION_FAILED";
  return diagnostic(code, "runtime.activate", result?.message ?? fallback);
}
function quarantineLocalDrop(storage: FullstackStorageAuthority, entry: StorageEntry, reason: string): StorageResult<void> {
  return storage.moveExclusive(entryPath(entry), `${localDropRelative()}/quarantine/${entry.name}.${digestOf(reason)}.json`);
}
export function validateInboundTaskRecord(value: unknown, identity: WorkflowRunIdentity): InboxTask | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (
    typeof raw.id !== "string"
    || raw.id.length === 0
    || raw.id.length > 512
    || typeof raw.text !== "string"
    || raw.text.trim().length === 0
    || raw.text.length > MAX_INBOX_TEXT_LENGTH
    || !isDurableTimestamp(raw.at)
  ) return null;
  const run = validateWorkflowRunIdentity(raw.run_identity);
  if (!run.ok || !sameRun(run.value, identity)) return null;
  if (raw.by !== undefined && (typeof raw.by !== "string" || raw.by.length === 0 || raw.by.length > MAX_INBOX_TEXT_LENGTH)) return null;
  return { id: raw.id, text: raw.text.trim(), at: raw.at, run_identity: identity, ...(typeof raw.by === "string" ? { by: raw.by } : {}) };
}

export function validateInboundAnswerRecord(value: unknown, identity: WorkflowRunIdentity): EscalationAnswer | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (
    typeof raw.id !== "string"
    || raw.id.length === 0
    || raw.id.length > 512
    || typeof raw.answer !== "string"
    || raw.answer.trim().length === 0
    || raw.answer.length > MAX_INBOX_TEXT_LENGTH
    || !isDurableTimestamp(raw.at)
    || typeof raw.by !== "string"
    || raw.by.length === 0
    || raw.by.length > MAX_INBOX_TEXT_LENGTH
  ) return null;
  const run = validateWorkflowRunIdentity(raw.run_identity);
  if (!run.ok || !sameRun(run.value, identity)) return null;
  return { id: raw.id, answer: raw.answer, at: raw.at, by: raw.by, ...(raw.stale === true ? { stale: true } : {}), run_identity: identity };
}

async function processLocalDrop(
  context: AdapterRuntimeContext,
  onTask: ((task: InboxTask) => Promise<void>) | undefined,
  onAnswer: ((answer: EscalationAnswer) => void) | undefined,
  onDiagnostic: ((diagnostic: WorkflowV2Diagnostic) => void) | undefined,
  signal?: AbortSignal,
  taskDispatcher?: InboundTaskDispatcher,
): Promise<WorkflowV2Diagnostic[]> {
  const storage = requireStorage(context);
  if (!storage.ok) return [storage.diagnostics[0]!];
  const listed = storage.value.listJsonBounded(localDropRelative(), MAX_DIRECTORY_ENTRIES);
  if (!listed.ok) return listed.reason === "IO" ? [] : [operationDiagnostic(listed, "The local inbound drop could not be listed.")];
  const diagnostics: WorkflowV2Diagnostic[] = [];
  for (const entry of listed.value) {
    if (signal?.aborted) break;
    const raw = storage.value.readJsonBounded(entryPath(entry), MAX_RECORD_BYTES, MAX_JSON_DEPTH);
    if (!raw.ok) {
      if (signal?.aborted) break;
      const moved = quarantineLocalDrop(storage.value, entry, raw.message ?? "malformed local inbound record");
      const d = operationDiagnostic(raw, "Malformed or oversized local inbound record was quarantined.");
      diagnostics.push(d);
      reportDiagnostic(onDiagnostic, d, signal);
      if (!moved.ok) reportDiagnostic(onDiagnostic, operationDiagnostic(moved, "Malformed local inbound record could not be quarantined."), signal);
      continue;
    }
    if (raw.value === null) continue;
    const rawRecord = raw.value && typeof raw.value === "object" && !Array.isArray(raw.value) ? raw.value as Record<string, unknown> : null;
    const rawKind = rawRecord?.kind;
    if (rawKind !== undefined && rawKind !== "answer" && rawKind !== "task") {
      if (signal?.aborted) break;
      const moved = quarantineLocalDrop(storage.value, entry, "unknown local inbound kind");
      const d = diagnostic("CONFIG_MALFORMED", "runtime.activate", "Unknown local inbound record kind was quarantined.");
      diagnostics.push(d);
      reportDiagnostic(onDiagnostic, d, signal);
      if (!moved.ok) reportDiagnostic(onDiagnostic, operationDiagnostic(moved, "Unknown local inbound record could not be quarantined."), signal);
      continue;
    }
    if (rawKind === "answer") {
      const answer = validateInboundAnswerRecord(raw.value, context.run_identity);
      if (!answer) {
        if (signal?.aborted) break;
        const moved = quarantineLocalDrop(storage.value, entry, "malformed local answer marker");
        const d = diagnostic("CONFIG_MALFORMED", "runtime.activate", "Malformed or foreign answer marker was quarantined.");
        diagnostics.push(d);
        reportDiagnostic(onDiagnostic, d, signal);
        if (!moved.ok) reportDiagnostic(onDiagnostic, operationDiagnostic(moved, "Malformed answer marker could not be quarantined."), signal);
        continue;
      }
      if (!onAnswer) {
        const d = diagnostic("CAPABILITY_MISSING", "runtime.activate", "Answer marker has no answer consumer; it remains pending for retry.");
        diagnostics.push(d);
        reportDiagnostic(onDiagnostic, d, signal);
        continue;
      }
      if (signal?.aborted) continue;
      try { onAnswer(answer); } catch {
        const d = diagnostic("ACTIVATION_FAILED", "runtime.activate", "Answer callback failed; the exact marker remains pending for retry.");
        diagnostics.push(d);
        reportDiagnostic(onDiagnostic, d, signal);
        continue;
      }
      if (signal?.aborted) continue;
      const moved = storage.value.moveExclusive(entryPath(entry), `${localDropRelative()}/processed/${entry.name}`);
      if (!moved.ok) {
        const d = operationDiagnostic(moved, "Processed answer marker could not be moved after callback success.");
        diagnostics.push(d);
        reportDiagnostic(onDiagnostic, d, signal);
      }
      continue;
    }
    const task = validateInboundTaskRecord(raw.value, context.run_identity);
    if (!task) {
      if (signal?.aborted) break;
      const moved = quarantineLocalDrop(storage.value, entry, "malformed local task");
      const d = diagnostic("CONFIG_MALFORMED", "runtime.activate", "Malformed or foreign inbound task was quarantined.");
      diagnostics.push(d);
      reportDiagnostic(onDiagnostic, d, signal);
      if (!moved.ok) reportDiagnostic(onDiagnostic, operationDiagnostic(moved, "Malformed task could not be quarantined."), signal);
      continue;
    }
    if (!onTask) {
      const d = diagnostic("CAPABILITY_MISSING", "runtime.activate", "Inbound task has no task consumer; it remains pending for retry.");
      diagnostics.push(d);
      reportDiagnostic(onDiagnostic, d, signal);
      continue;
    }
    const filed = taskDispatcher
      ? await taskDispatcher(task)
      : await handleInboxTask(context, task, onTask, signal);
    if (!filed.ok) {
      diagnostics.push(filed.diagnostics[0]!);
      reportDiagnostic(onDiagnostic, filed.diagnostics[0]!, signal);
      continue;
    }
    if (signal?.aborted) break;
    const moved = storage.value.moveExclusive(entryPath(entry), `${localDropRelative()}/processed/${entry.name}`);
    if (!moved.ok) {
      const d = operationDiagnostic(moved, "Processed inbound task could not be moved after callback success.");
      diagnostics.push(d);
      reportDiagnostic(onDiagnostic, d, signal);
    }
  }
  return diagnostics;
}

export async function pollInbox(
  context: AdapterRuntimeContext,
  adapter: EscalationAdapter | null,
  onTask?: (task: InboxTask) => Promise<void>,
  onAnswer?: (answer: EscalationAnswer) => void,
  onDiagnostic?: (diagnostic: WorkflowV2Diagnostic) => void,
  signal?: AbortSignal,
): Promise<DiagnosticResult<void>> {
  return pollInboxInternal(context, adapter, onTask, onAnswer, onDiagnostic, signal);
}

async function pollInboxInternal(
  context: AdapterRuntimeContext,
  adapter: EscalationAdapter | null,
  onTask: ((task: InboxTask) => Promise<void>) | undefined,
  onAnswer: ((answer: EscalationAnswer) => void) | undefined,
  onDiagnostic: ((diagnostic: WorkflowV2Diagnostic) => void) | undefined,
  signal: AbortSignal | undefined,
  taskDispatcher?: InboundTaskDispatcher,
): Promise<DiagnosticResult<void>> {
  const checked = checkedContext(context);
  if (!checked.ok) return checked as DiagnosticResult<void>;
  const storage = requireStorage(checked.value);
  if (!storage.ok) return storage as DiagnosticResult<void>;
  if (signal?.aborted) return successResult(undefined);
  const diagnostics = await processLocalDrop(checked.value, onTask, onAnswer, onDiagnostic, signal, taskDispatcher);
  if (signal?.aborted) return successResult(undefined, diagnostics);
  if (adapter?.pollOnce) {
    try {
      const polled = await adapter.pollOnce();
      if (signal?.aborted) return successResult(undefined, diagnostics);
      if (!Array.isArray(polled)) throw new Error("adapter returned a malformed answer list");
      for (const candidate of polled) {
        if (signal?.aborted) break;
        const answer = validateInboundAnswerRecord(candidate, checked.value.run_identity);
        if (!answer) {
          const d = diagnostic("IDENTITY_MISMATCH", "runtime.activate", "Ignore malformed or foreign inbound answer from the explicitly bound channel.");
          diagnostics.push(d);
          reportDiagnostic(onDiagnostic, d, signal);
          continue;
        }
        const staged = stageChannelAnswer(storage.value, checked.value.run_identity, answer);
        if (!staged.ok) {
          const d = operationDiagnostic(staged, "The channel answer could not be durably staged before callback delivery.");
          diagnostics.push(d);
          reportDiagnostic(onDiagnostic, d, signal);
          continue;
        }
      }
    } catch {
      if (!signal?.aborted) {
        const d = diagnostic("ACTIVATION_FAILED", "runtime.activate", "The explicitly bound inbox poll failed; retry on the next lifecycle tick.");
        diagnostics.push(d);
        reportDiagnostic(onDiagnostic, d, signal);
      }
    }
  }
  if (signal?.aborted) return successResult(undefined, diagnostics);
  diagnostics.push(...processChannelAnswers(checked.value, onAnswer, onDiagnostic, signal));
  return successResult(undefined, diagnostics);
}

function answerRecord(answer: EscalationAnswer): Record<string, unknown> {
  return { kind: "answer", ...answer };
}

function stageChannelAnswer(storage: FullstackStorageAuthority, run: WorkflowRunIdentity, answer: EscalationAnswer): StorageResult<string | null> {
  const path = answerPendingPath(run, answer.id);
  const record = answerRecord(answer);
  const written = storage.writeJsonExclusive(path, bytesOf(record));
  if (written.ok) return { ok: true, value: path };
  const existing = storage.readJsonBounded(path, MAX_RECORD_BYTES, MAX_JSON_DEPTH);
  if (!existing.ok) return existing;
  const replay = existing.value === null ? null : validateInboundAnswerRecord(existing.value, run);
  if (replay && exactRecord(replay, answer)) return { ok: true, value: null };
  return written;
}

function quarantineChannelAnswer(storage: FullstackStorageAuthority, entry: StorageEntry, reason: string, run: WorkflowRunIdentity): StorageResult<void> {
  return storage.moveExclusive(entryPath(entry), `${answerRelative(run)}/quarantine/${entry.name}.${digestOf(reason)}.json`);
}

function processChannelAnswers(
  context: AdapterRuntimeContext,
  onAnswer: ((answer: EscalationAnswer) => void) | undefined,
  onDiagnostic: ((diagnostic: WorkflowV2Diagnostic) => void) | undefined,
  signal?: AbortSignal,
): WorkflowV2Diagnostic[] {
  const storage = requireStorage(context);
  if (!storage.ok) return [storage.diagnostics[0]!];
  const listed = storage.value.listJsonBounded(answerRelative(context.run_identity), MAX_DIRECTORY_ENTRIES);
  if (!listed.ok) {
    if (listed.reason === "IO") return [];
    const d = operationDiagnostic(listed, "The durable channel answer directory could not be listed.");
    reportDiagnostic(onDiagnostic, d, signal);
    return [d];
  }
  const diagnostics: WorkflowV2Diagnostic[] = [];
  for (const entry of listed.value) {
    if (signal?.aborted) break;
    const raw = storage.value.readJsonBounded(entryPath(entry), MAX_RECORD_BYTES, MAX_JSON_DEPTH);
    if (!raw.ok) {
      if (signal?.aborted) break;
      const moved = quarantineChannelAnswer(storage.value, entry, raw.message ?? "malformed channel answer", context.run_identity);
      const d = operationDiagnostic(raw, "Malformed or oversized channel answer was quarantined.");
      diagnostics.push(d);
      reportDiagnostic(onDiagnostic, d, signal);
      if (!moved.ok) reportDiagnostic(onDiagnostic, operationDiagnostic(moved, "Malformed channel answer could not be quarantined."), signal);
      continue;
    }
    if (raw.value === null) continue;
    const answer = validateInboundAnswerRecord(raw.value, context.run_identity);
    if (!answer) {
      if (signal?.aborted) break;
      const moved = quarantineChannelAnswer(storage.value, entry, "foreign or malformed channel answer", context.run_identity);
      const d = diagnostic("IDENTITY_MISMATCH", "runtime.activate", "Foreign or malformed channel answer was quarantined.");
      diagnostics.push(d);
      reportDiagnostic(onDiagnostic, d, signal);
      if (!moved.ok) reportDiagnostic(onDiagnostic, operationDiagnostic(moved, "Foreign channel answer could not be quarantined."), signal);
      continue;
    }
    const processedPath = answerProcessedPath(context.run_identity, answer.id);
    const processed = storage.value.readJsonBounded(processedPath, MAX_RECORD_BYTES, MAX_JSON_DEPTH);
    if (!processed.ok) {
      const d = operationDiagnostic(processed, "The processed channel answer marker could not be checked.");
      diagnostics.push(d);
      reportDiagnostic(onDiagnostic, d, signal);
      continue;
    }
    if (processed.value !== null) {
      const previous = validateInboundAnswerRecord(processed.value, context.run_identity);
      if (previous && exactRecord(previous, answer)) {
        if (signal?.aborted) continue;
        const removed = storage.value.removeIfOwned(entryPath(entry), context.run_identity);
        if (!removed.ok) {
          const d = operationDiagnostic(removed, "A duplicate channel answer could not be removed after exact replay.");
          diagnostics.push(d);
          reportDiagnostic(onDiagnostic, d, signal);
        }
      } else {
        if (signal?.aborted) continue;
        const moved = quarantineChannelAnswer(storage.value, entry, "conflicting processed channel answer", context.run_identity);
        const d = diagnostic("IDENTITY_MISMATCH", "runtime.activate", "A channel answer key conflicts with its processed exact record.");
        diagnostics.push(d);
        reportDiagnostic(onDiagnostic, d, signal);
        if (!moved.ok) reportDiagnostic(onDiagnostic, operationDiagnostic(moved, "Conflicting channel answer could not be quarantined."), signal);
      }
      continue;
    }
    if (!onAnswer) {
      const d = diagnostic("CAPABILITY_MISSING", "runtime.activate", "Provide an answer consumer before consuming the durable channel answer; it remains pending for retry.");
      diagnostics.push(d);
      reportDiagnostic(onDiagnostic, d, signal);
      continue;
    }
    if (signal?.aborted) continue;
    try { onAnswer(answer); } catch {
      const d = diagnostic("ACTIVATION_FAILED", "runtime.activate", "Answer callback failed; the exact durable channel answer remains pending for retry.");
      diagnostics.push(d);
      reportDiagnostic(onDiagnostic, d, signal);
      continue;
    }
    if (signal?.aborted) continue;
    const moved = storage.value.moveExclusive(entryPath(entry), processedPath);
    if (!moved.ok) {
      const after = storage.value.readJsonBounded(processedPath, MAX_RECORD_BYTES, MAX_JSON_DEPTH);
      const afterAnswer = after.ok && after.value !== null ? validateInboundAnswerRecord(after.value, context.run_identity) : null;
      if (afterAnswer && exactRecord(afterAnswer, answer)) {
        if (signal?.aborted) continue;
        const removed = storage.value.removeIfOwned(entryPath(entry), context.run_identity);
        if (removed.ok) continue;
      }
      const d = operationDiagnostic(moved, "Delivered channel answer could not be moved to its processed marker; it remains pending for retry.");
      diagnostics.push(d);
      reportDiagnostic(onDiagnostic, d, signal);
    }
  }
  return diagnostics;
}

export function startDispatcher(context: AdapterRuntimeContext, adapter: EscalationAdapter | null, options: DispatcherOptions = {}): DiagnosticResult<DispatcherHandle> {
  return startDispatcherLoop(context, adapter, [], options);
}

export function startChannelDispatcher(context: AdapterRuntimeContext, channelSet: ChannelSet, options: DispatcherOptions = {}): DiagnosticResult<DispatcherHandle> {
  const admitted = admitChannelSetContext(context, channelSet);
  if (!admitted.ok) return admitted as DiagnosticResult<DispatcherHandle>;
  return startDispatcherLoop(context, channelSet.primary, channelSet.roSinks, options);
}


function startDispatcherLoop(context: AdapterRuntimeContext, primary: EscalationAdapter | null, roSinks: readonly EscalationAdapter[], options: DispatcherOptions): DiagnosticResult<DispatcherHandle> {
  const checked = checkedContext(context);
  if (!checked.ok) return checked as DiagnosticResult<DispatcherHandle>;
  const storage = requireStorage(checked.value);
  if (!storage.ok) return storage as DiagnosticResult<DispatcherHandle>;
  const lease = storage.value.acquireLease(DISPATCHER_LOCK_RELATIVE_PATH, checked.value.run_identity);
  if (!lease.ok) return storageFailure(lease);
  const taskClaim = createDispatcherTaskClaim(storage.value, checked.value.run_identity, lease.value);

  let stopped = false;
  let inboundTimer: NodeJS.Timeout | undefined;
  let outboundTimer: NodeJS.Timeout | undefined;
  let inboundFlight: Promise<void> | undefined;
  let outboundFlight: Promise<void> | undefined;
  let stopPromise: Promise<void> | undefined;
  const stopController = new AbortController();
  const taskFlights = new Map<string, InboxTaskFlight>();
  const activeTaskIds = new Map<string, string>();
  const interval = Number.isFinite(options.intervalMs) && (options.intervalMs ?? 0) > 0 ? Math.min(options.intervalMs!, 86_400_000) : DISPATCHER_INTERVAL_MS;
  const dispatchClaimedTask: InboundTaskDispatcher = (task): Promise<InboxTaskDispatchResult> => {
    if (stopped) return Promise.resolve(failureResult(diagnostic("ACTIVATION_FAILED", "runtime.activate", "Dispatcher stopped before inbound task processing completed; the exact durable record remains pending.")));
    const flightKey = inboxTaskFlightKey(task, checked.value.run_identity);
    if (!flightKey) return handleInboxTaskInternal(checked.value, task, options.onTask, stopController.signal, taskClaim);
    const activeKey = activeTaskIds.get(flightKey.task_id);
    if (activeKey !== undefined) {
      if (activeKey === flightKey.key) {
        const activeFlight = taskFlights.get(activeKey);
        if (activeFlight) return activeFlight.promise;
        return Promise.resolve(failureResult(diagnostic("ACTIVATION_FAILED", "runtime.activate", "Inbound task flight state was lost before callback settlement; the exact durable record remains pending.")));
      }
      return Promise.resolve(failureResult(diagnostic("IDENTITY_MISMATCH", "runtime.activate", "A concurrent inbound task with the same id has a conflicting exact record; its durable source remains pending.")));
    }
    let resolveFlight!: (result: InboxTaskDispatchResult) => void;
    let rejectFlight!: (reason: unknown) => void;
    const promise = new Promise<InboxTaskDispatchResult>((resolve, reject) => {
      resolveFlight = resolve;
      rejectFlight = reject;
    });
    taskFlights.set(flightKey.key, { key: flightKey, promise });
    activeTaskIds.set(flightKey.task_id, flightKey.key);
    const clearFlight = (): void => {
      const activeFlight = taskFlights.get(flightKey.key);
      if (activeFlight?.promise !== promise) return;
      taskFlights.delete(flightKey.key);
      if (activeTaskIds.get(flightKey.task_id) === flightKey.key) activeTaskIds.delete(flightKey.task_id);
    };
    void handleInboxTaskInternal(checked.value, task, options.onTask, stopController.signal, taskClaim).then(resolveFlight, rejectFlight);
    void promise.then(clearFlight, clearFlight);
    return promise;
  };
  const dispatchTask = async (task: InboxTask): Promise<void> => {
    if (stopped) return;
    const filed = await dispatchClaimedTask(task);
    if (filed.ok) return;
    const taskDiagnostic = filed.diagnostics[0]!;
    reportDiagnostic(options.onDiagnostic, taskDiagnostic, stopController.signal);
    throw new InboundTaskDispatchError(taskDiagnostic);
  };
  const inboundTaskHandler = options.onTask === undefined
    ? undefined
    : async (task: InboxTask): Promise<void> => {
      if (stopped) throw new Error("dispatcher stopped");
      await options.onTask!(task);
    };
  const inboundAnswerHandler = options.onAnswer === undefined
    ? undefined
    : (answer: EscalationAnswer): void => {
      if (stopped) throw new Error("dispatcher stopped");
      options.onAnswer!(answer);
    };
  let setupStage = "primary.setPlainMessageHandler";
  try {
    primary?.setPlainMessageHandler?.(dispatchTask);
    const runInbound = (): void => {
      if (stopped || inboundFlight) return;
      const operation = (async (): Promise<void> => {
        try {
          await pollInboxInternal(checked.value, primary, inboundTaskHandler, inboundAnswerHandler, options.onDiagnostic, stopController.signal, dispatchClaimedTask);
        } catch {
          if (!stopped) {
            reportDiagnostic(options.onDiagnostic, diagnostic("ACTIVATION_FAILED", "runtime.activate", "The dispatcher inbox loop failed; retry on the next lifecycle tick."), stopController.signal);
          }
        }
      })();
      inboundFlight = operation;
      void operation.then(
        () => { if (inboundFlight === operation) inboundFlight = undefined; },
        () => { if (inboundFlight === operation) inboundFlight = undefined; },
      );
    };
    const runOutbound = (): void => {
      if (stopped || outboundFlight) return;
      const operation = (async (): Promise<void> => {
        try {
          await drainOutbox(checked.value, primary, MAX_RETRIES, roSinks, options.onDiagnostic, stopController.signal);
        } catch {
          if (!stopped) {
            reportDiagnostic(options.onDiagnostic, diagnostic("ACTIVATION_FAILED", "runtime.activate", "The dispatcher outbox loop failed; retry on the next lifecycle tick."), stopController.signal);
          }
        }
      })();
      outboundFlight = operation;
      void operation.then(
        () => { if (outboundFlight === operation) outboundFlight = undefined; },
        () => { if (outboundFlight === operation) outboundFlight = undefined; },
      );
    };
    setupStage = "inbound.setInterval";
    inboundTimer = setInterval(runInbound, interval);
    inboundTimer.unref?.();
    setupStage = "outbound.setInterval";
    outboundTimer = setInterval(runOutbound, interval);
    outboundTimer.unref?.();
    runInbound();
    runOutbound();
  } catch {
    stopped = true;
    stopController.abort();
    if (inboundTimer) clearInterval(inboundTimer);
    inboundTimer = undefined;
    if (outboundTimer) clearInterval(outboundTimer);
    outboundTimer = undefined;
    try {
      primary?.setPlainMessageHandler?.(async () => undefined);
    } catch {
      /* Setup rollback is best effort; the stopped guard remains authoritative. */
    }
    const d = diagnostic("ACTIVATION_FAILED", "runtime.activate", "The dispatcher failed during setup; its lease was rolled back.", { field: setupStage });
    try {
      storage.value.releaseLease(lease.value.relative_path, checked.value.run_identity);
    } catch {
      /* Setup already failed; retain the typed setup diagnostic rather than leaking a release exception. */
    }
    reportDiagnostic(options.onDiagnostic, d);
    return failureResult(d);
  }
  return successResult({
    stop: (): Promise<void> => {
      if (stopPromise) return stopPromise;
      stopped = true;
      stopController.abort();
      if (inboundTimer) clearInterval(inboundTimer);
      inboundTimer = undefined;
      if (outboundTimer) clearInterval(outboundTimer);
      outboundTimer = undefined;
      let detachFailed = false;
      try {
        primary?.setPlainMessageHandler?.(async () => undefined);
      } catch {
        detachFailed = true;
      }
      const flights = [
        ...(inboundFlight ? [inboundFlight] : []),
        ...(outboundFlight ? [outboundFlight] : []),
        ...[...taskFlights.values()].map((flight) => flight.promise),
      ];
      const stopping = (async (): Promise<void> => {
        let releaseFailure: StorageFailure | undefined;
        let releaseThrew = false;
        try {
          await Promise.allSettled(flights);
        } finally {
          try {
            const released = storage.value.releaseLease(lease.value.relative_path, checked.value.run_identity);
            if (!released.ok) releaseFailure = released;
          } catch {
            releaseThrew = true;
          }
        }
        const stopDiagnostic = detachFailed
          ? diagnostic("ACTIVATION_FAILED", "runtime.activate", "The dispatcher could not detach the primary channel handler during shutdown.", { field: "primary.setPlainMessageHandler" })
          : releaseFailure
            ? operationDiagnostic(releaseFailure, "The dispatcher lease could not be released after shutdown.")
            : releaseThrew
              ? diagnostic("ACTIVATION_FAILED", "runtime.activate", "The dispatcher lease release failed after shutdown.", { field: "storage.releaseLease" })
              : undefined;
        if (!stopDiagnostic) return;
        reportDiagnostic(options.onDiagnostic, stopDiagnostic);
        throw new DispatcherStopError(stopDiagnostic);
      })();
      stopPromise = stopping;
      return stopping;
    },
  });
}

export interface DrainOutboxResult { readonly escId: string; readonly sent: boolean; readonly error?: string; }

function quarantineOutbox(storage: FullstackStorageAuthority, entry: StorageEntry, run: WorkflowRunIdentity, reason: string): void {
  const target = `${outboxRelative(run)}/quarantine/${entry.name}.${digestOf(reason)}.json`;
  storage.moveExclusive(entryPath(entry), target);
}

function skipOutbox(storage: FullstackStorageAuthority, entry: StorageEntry, run: WorkflowRunIdentity, record: CtoDelivery): StorageResult<void> {
  const target = `${outboxRelative(run)}/skipped/${entry.name}`;
  const moved = storage.moveExclusive(entryPath(entry), target);
  if (moved.ok) return moved;
  const existing = storage.readJsonBounded(target, MAX_RECORD_BYTES, MAX_JSON_DEPTH);
  if (!existing.ok || existing.value === null || !exactRecord(existing.value, record)) return moved;
  const removed = storage.removeIfOwned(entryPath(entry), run);
  return removed.ok ? { ok: true, value: undefined } : removed;
}

export async function drainOutbox(
  context: AdapterRuntimeContext,
  adapter: EscalationAdapter | null,
  maxRetries = 3,
  roSinks: readonly EscalationAdapter[] = [],
  onDiagnostic?: (diagnostic: WorkflowV2Diagnostic) => void,
  signal?: AbortSignal,
): Promise<DrainOutboxResult[]> {
  const checked = checkedContext(context);
  if (!checked.ok) return [];
  const storage = requireStorage(checked.value);
  if (!storage.ok) {
    reportDiagnostic(onDiagnostic, storage.diagnostics[0]!, signal);
    return [];
  }
  if (signal?.aborted) return [];
  const retries = Number.isFinite(maxRetries) && maxRetries > 0
    ? Math.max(1, Math.min(Math.floor(maxRetries), MAX_RETRIES))
    : 1;
  const listed = storage.value.listJsonBounded(outboxRelative(checked.value.run_identity), MAX_DIRECTORY_ENTRIES);
  if (!listed.ok) return [];
  const results: DrainOutboxResult[] = [];
  for (const entry of listed.value) {
    if (signal?.aborted) break;
    const fallbackId = entry.name.endsWith(".json") ? entry.name.slice(0, -5) : entry.name;
    const raw = storage.value.readJsonBounded(entryPath(entry), MAX_RECORD_BYTES, MAX_JSON_DEPTH);
    if (!raw.ok || raw.value === null) {
      const d = operationDiagnostic(raw.ok ? undefined : raw, "Malformed or oversized outbox record was quarantined.");
      reportDiagnostic(onDiagnostic, d, signal);
      if (signal?.aborted) break;
      quarantineOutbox(storage.value, entry, checked.value.run_identity, d.remediation);
      results.push({ escId: fallbackId, sent: false, error: d.remediation });
      continue;
    }
    const candidate = raw.value as CtoDelivery;
    const run = validateWorkflowRunIdentity(candidate.run_identity);
    if (!run.ok || !sameRun(run.value, checked.value.run_identity) || validateEscalation(candidate)) {
      const d = diagnostic("IDENTITY_MISMATCH", "runtime.activate", "Foreign or malformed outbox record was quarantined.");
      reportDiagnostic(onDiagnostic, d, signal);
      if (signal?.aborted) break;
      quarantineOutbox(storage.value, entry, checked.value.run_identity, d.remediation);
      results.push({ escId: fallbackId, sent: false, error: d.remediation });
      continue;
    }
    const escId = typeof candidate.id === "string" && candidate.id.length > 0 ? candidate.id : fallbackId;
    const clean: CtoDelivery = { ...candidate, id: escId, run_identity: checked.value.run_identity };
    const outcomes: Array<{ readonly target: string; readonly sent: boolean; readonly error?: string }> = [];
    const roFailures: number[] = [];
    const deliver = async (
      target: string,
      sink: EscalationAdapter,
      attemptLimit = retries,
    ): Promise<{ readonly target: string; readonly sent: boolean; readonly error?: string } | undefined> => {
      let receipt: EscalationReceipt | undefined;
      for (let attempt = 0; attempt < attemptLimit; attempt += 1) {
        if (signal?.aborted) return undefined;
        try {
          receipt = await sink.send(clean);
          if (signal?.aborted) return undefined;
          if (receipt.sent && sameRun(receipt.run_identity, checked.value.run_identity)) break;
        } catch {
          /* Retry the same exact envelope; durable record remains pending. */
        }
      }
      if (signal?.aborted) return undefined;
      const delivered = Boolean(receipt?.sent && sameRun(receipt.run_identity, checked.value.run_identity));
      const outcome = { target, sent: delivered, ...(delivered ? {} : { error: "delivery failed" }) };
      outcomes.push(outcome);
      return outcome;
    };
    if (candidate.intent === "summary") {
      const eligibleRoSinks = roSinks
        .map((sink, index) => ({ sink, index }))
        .filter(({ sink }) => {
          const subscriptions = (sink as RoSinkMarker)[RO_SINK_SUBSCRIPTIONS];
          return subscriptions === undefined
            || (candidate.topic !== undefined && candidate.topic.length > 0 && subscriptions.includes(candidate.topic));
        });
      if (!adapter && eligibleRoSinks.length === 0) {
        const skipError = "no eligible subscriber for summary topic";
        if (signal?.aborted) break;
        const skipped = skipOutbox(storage.value, entry, checked.value.run_identity, candidate);
        if (!skipped.ok) {
          const d = operationDiagnostic(skipped, "A summary with no eligible subscriber could not be archived for reconciliation.");
          reportDiagnostic(onDiagnostic, d, signal);
          results.push({ escId, sent: false, error: d.remediation });
        } else {
          const d = diagnostic("ACTIVATION_FAILED", "runtime.activate", skipError);
          reportDiagnostic(onDiagnostic, d, signal);
          results.push({ escId, sent: false, error: skipError });
        }
        continue;
      }
      if (adapter) {
        const primaryOutcome = await deliver("primary", adapter);
        if (signal?.aborted) break;
        if (!primaryOutcome?.sent) {
          results.push({
            escId,
            sent: false,
            error: `${primaryOutcome?.target ?? "primary"}: ${primaryOutcome?.error ?? "delivery failed"}`,
          });
          continue;
        }
      }
      for (const { sink, index } of eligibleRoSinks) {
        const outcome = await deliver(`ro[${index}]`, sink, 1);
        if (signal?.aborted) break;
        if (outcome && !outcome.sent) roFailures.push(index);
      }
    } else if (adapter) {
      await deliver("primary", adapter);
    }
    if (signal?.aborted) break;
    if (outcomes.length === 0) {
      outcomes.push({ target: "primary", sent: false, error: "no explicitly bound delivery target" });
    }
    const sent = candidate.intent === "summary"
      ? (adapter ? outcomes[0]?.sent === true : outcomes.some((outcome) => outcome.sent))
      : outcomes.every((outcome) => outcome.sent);
    for (const index of roFailures) {
      reportDiagnostic(
        onDiagnostic,
        diagnostic(
          "ACTIVATION_FAILED",
          "runtime.activate",
          sent
            ? `Read-only sink ro[${index}] failed to deliver the summary; best-effort fanout was archived.`
            : `Read-only sink ro[${index}] failed to deliver the summary; all eligible read-only sinks failed and the exact outbox record remains pending for retry.`,
          { profile_id: `ro-${index}`, order: index, status: "failed" },
        ),
        signal,
      );
    }
    if (sent) {
      if (signal?.aborted) break;
      const moved = storage.value.moveExclusive(entryPath(entry), `${outboxRelative(checked.value.run_identity)}/sent/${entry.name}`);
      if (!moved.ok) {
        const d = operationDiagnostic(moved, "Sent outbox record could not be moved atomically; it remains pending for explicit reconciliation.");
        reportDiagnostic(onDiagnostic, d, signal);
        results.push({ escId, sent: false, error: d.remediation });
        continue;
      }
    }
    results.push({
      escId,
      sent,
      ...(sent ? {} : { error: outcomes.filter((outcome) => !outcome.sent).map((outcome) => `${outcome.target}: ${outcome.error ?? "delivery failed"}`).join("; ") }),
    });
  }
  return results;
}

export function dispatcherLockPath(_context: AdapterRuntimeContext): string { return DISPATCHER_LOCK_RELATIVE_PATH; }
export function bridgeLockPath(_context: AdapterRuntimeContext): string { return ".omp/bridge.lock"; }

export function isBridgeAlive(context: AdapterRuntimeContext): boolean {
  const checked = checkedContext(context);
  if (!checked.ok || !checked.value.storage) return false;
  const raw = checked.value.storage.readJsonBounded(bridgeLockPath(checked.value), 64 * 1024, 16);
  if (!raw.ok || !raw.value || typeof raw.value !== "object" || Array.isArray(raw.value)) return false;
  const lock = raw.value as Record<string, unknown>;
  const run = validateWorkflowRunIdentity(lock.run_identity);
  if (!run.ok || !sameRun(run.value, checked.value.run_identity) || typeof lock.pid !== "number" || !Number.isSafeInteger(lock.pid) || lock.pid <= 0) return false;
  try { process.kill(lock.pid, 0); return true; } catch { return false; }
}

export function writeBridgeLock(context: AdapterRuntimeContext): DiagnosticResult<true> {
  const checked = checkedContext(context);
  if (!checked.ok) return checked as DiagnosticResult<true>;
  const storage = requireStorage(checked.value);
  if (!storage.ok) return storage as DiagnosticResult<true>;
  const record = { pid: process.pid, run_identity: checked.value.run_identity, startedAt: new Date().toISOString() };
  const written = storage.value.writeJsonExclusive(bridgeLockPath(checked.value), bytesOf(record));
  if (written.ok) return successResult(true);
  const existing = storage.value.readJsonBounded(bridgeLockPath(checked.value), 64 * 1024, 16);
  if (existing.ok && existing.value !== null && exactRecord(existing.value, record)) return successResult(true);
  return storageFailure(written);
}

export function clearBridgeLock(context: AdapterRuntimeContext): void {
  const checked = checkedContext(context);
  if (!checked.ok || !checked.value.storage) return;
  checked.value.storage.removeIfOwned(bridgeLockPath(checked.value), checked.value.run_identity);
}
