import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  requireRegistryContext,
  type RegistryContextSnapshot,
  type RegistryRegistrationContext,
} from "../registry/owner.js";
import { CtoAuthorityUnavailableError, findActiveCtoRun } from "../commands/cto.js";
import {
  acknowledgeCtoRunDelivery,
  markCtoRunDeliveryPending,
  mintCtoRuntimeRunOrigin,
  ctoRuntimeRunInitialIdentityDigest,
  hasCtoRuntimeRunOriginHandoffPinned,
  hasValidCtoRuntimeRunOriginPinned,
  hasValidCtoRuntimeStateProofPinned,
  writeCtoRuntimeStateProof,
  refreshCtoRunDeliveryIndexAuthorityPinned,
  readCtoRunDeliveryIndexAuthorityPinned,
  newCtoState,
  publishCtoOutboxDelivery,
  readCtoRunDeliveryActiveCandidatesPinned,
  readCtoRunDeliveryCompletedCandidatesPinned,
  readCtoRunDeliveryIndexPage,
  readCtoRunDeliveryCompletedIndexPage,
  readCtoStatePinned,
  readCtoRuntimeRunOriginHandoffPinned,
  currentOutboxDeliveryStatusPinned,
  recordCtoOutboxDeliveryObligation,
  readCtoOutboxDeliveryObligationsPinned,
  removeCtoOutboxDeliveryObligation,
  type AppendWaveOptions,
  type CtoOutboxDeliveryPublishInput,
  type CtoOutboxDeliveryObligationInput,
  type CtoOutboxDeliveryObligationRead,
  type CtoCurrentOutboxDeliveryInput,
  type CtoCurrentOutboxDeliveryStatus,
  type CtoRunDeliveryCandidatesRead,
  type CtoRunDeliveryIndexPage,
  writeCtoState,
  writeCtoStateLocked,
} from "./state.js";
export type {
  CtoCurrentOutboxDeliveryInput as CtoRuntimeOutboxDeliveryInput,
  CtoRunDeliveryCandidatesRead,
  CtoRunDeliveryIndexEntry,
  CtoRunDeliveryIndexPage,
  CtoRunDeliveryStatus,
} from "./state.js";
import { appendWave } from "./waves.js";
import { withCtoRegistryLock, withCtoRunLock, type CtoRunLockHandle } from "./transaction-lock.js";
import { loadEscalationConfigRaw, normalizeChannelConfigResult, type EscalationConfigInvalidCode, type EscalationConfigLoadResult, type NormalizedEscalationConfig } from "./channels.js";
import { assessRunHealth } from "./health.js";
import { checkBudget } from "./budget.js";
import { recallDecisions } from "./decisions.js";
import { startWaveScheduler, type CtoSchedulerStateAdapter } from "./scheduler.js";
import { PinnedProjectRoot } from "../specification/pinned-root.js";
import type { CtoState, WaveRecord, ScheduledDigest } from "./types.js";
import {
  authenticateCtoRuntimeSessionAuthority,
  attachCtoRuntimeSessionAuthority,
  isCtoRuntimeSessionAuthority,
  ctoRuntimeSessionAuthorityForContext,
  detachCtoRuntimeSessionAuthority,
  type CtoRuntimeSessionAuthority,
} from "./session-authority.js";
export { ctoRuntimeSessionAuthorityForContext };
export {
  assertCtoRuntimeProofAuthorityLive,
  isCtoRuntimeProofAuthority,
  openCtoRuntimeProofAuthority,
  revokeCtoRuntimeProofAuthority,
  signCtoRuntimeProof,
  verifyCtoRuntimeProof,
  MAX_CTO_RUNTIME_PROOF_PAYLOAD_BYTES,
} from "./proof-authority.js";
export type { CtoRuntimeProofAuthority, CtoRuntimeProofDomain } from "./proof-authority.js";

const RUNTIME_CONTEXT_BRAND = Symbol("omp.cto.runtime-access-context");
const SENSITIVE_PROJECTION_KEY = /(?:^|_)(?:answer|body|user|by|raw|token)(?:_|$)/iu;
const MAX_RUNTIME_SESSION_ID_BYTES = 512;
const MAX_RUNTIME_CHANNEL_KIND_BYTES = 128;
const EMPTY_CHANNEL_CONFIGS = Object.freeze([]) as readonly Readonly<Record<string, unknown>>[];
const EMPTY_CHANNEL_KINDS = Object.freeze([]) as readonly string[];
const SAFE_ESCALATION_INVALID_REASONS: Readonly<Record<EscalationConfigInvalidCode, string>> = Object.freeze({
  malformed: "escalation.json is not valid JSON",
  invalid_shape: "escalation config shape is invalid",
  duplicate_id: "channel identifiers are duplicated",
  duplicate_primary: "multiple primary channels are declared",
  invalid_primary_direction: "primary channel direction is invalid",
});

/** Opaque marker for the access capability's internal context. */
export interface CtoRuntimeAccessContext {
  readonly [RUNTIME_CONTEXT_BRAND]: true;
}

export type CtoRuntimeAccessFailureCode =
  | "runtime_access_invalid"
  | "owner_conflict"
  | "activation_revoked"
  | "cto_runtime_transaction_async_unsupported";

export class CtoRuntimeAccessError extends Error {
  readonly code: CtoRuntimeAccessFailureCode;

  constructor(code: CtoRuntimeAccessFailureCode, message: string) {
    super(message);
    this.name = "CtoRuntimeAccessError";
    this.code = code;
  }
}

/** Opaque capability issued by the trusted host session lifecycle. */
export type CtoRuntimeAccessSession = CtoRuntimeSessionAuthority;

export interface CtoRuntimeRunOriginHandoff {
  readonly source_id: string;
  readonly initial_state_sha256: string;
}

export interface CtoRuntimeActiveRunProjection {
  readonly runId: string;
  readonly state: Readonly<Record<string, unknown>>;
}

export interface CtoRunTransactionFacade {
  readState(): CtoState;
  writeState(state: CtoState): string;
  appendWave(options: AppendWaveOptions): CtoState;
  findWaveBySourceId(sourceId: string): WaveRecord | null;
}

export type CtoRuntimeEscalationChannelProjection = readonly Readonly<Record<string, unknown>>[];

export type CtoRuntimeEscalationChannelSnapshot =
  | { readonly status: "absent" }
  | { readonly status: "invalid"; readonly code: EscalationConfigInvalidCode; readonly reason: string }
  | {
    readonly status: "valid";
    readonly config_sha256: string;
    readonly kinds: readonly string[];
    readonly projections: Readonly<Record<string, CtoRuntimeEscalationChannelProjection>>;
  };

export interface CtoRuntimeAccessFacade {
  findActiveRun(): CtoRuntimeActiveRunProjection | null;
  readState(runId: string): Readonly<Record<string, unknown>> | null;
  hasValidStateProof(runId: string): boolean;
  stateDirectory(runId: string): string;
  assertProjectRoot(projectRoot: string): void;
  ensureStandbyRun(): string;
  registerRunOrigin(runId: string, handoff: CtoRuntimeRunOriginHandoff): boolean;
  createRun(state: CtoState, handoff: CtoRuntimeRunOriginHandoff): CtoState;
  readActiveDeliveryCandidates(): Readonly<CtoRunDeliveryCandidatesRead>;
  readCompletedDeliveryCandidates(): Readonly<CtoRunDeliveryCandidatesRead>;
  readDeliveryIndexPage(options?: { after_run_id?: string; startAfter?: string; limit?: number }): Readonly<CtoRunDeliveryIndexPage>;
  readCompletedDeliveryIndexPage(options?: { after_run_id?: string; limit?: number }): Readonly<CtoRunDeliveryIndexPage>;
  markDeliveryPending(runId: string, stateRevision?: number, kind?: "outbox" | "summary" | "retry"): boolean;
  publishOutboxDelivery(input: CtoOutboxDeliveryPublishInput): string | null;
  recordOutboxDeliveryObligation(input: CtoOutboxDeliveryObligationInput): CtoOutboxDeliveryObligationRead | null;
  readOutboxDeliveryObligations(runId?: string): readonly CtoOutboxDeliveryObligationRead[];
  removeOutboxDeliveryObligation(runId: string, entryName: string, envelopeId: string): boolean;
  acknowledgeDelivery(runId: string, expectedRevision: number, options?: { drained: true }): boolean;
  currentOutboxDeliveryStatus(input: CtoCurrentOutboxDeliveryInput): CtoCurrentOutboxDeliveryStatus;
  listEscalationChannelKinds(): readonly string[];
  resolveEscalationChannelSnapshot(): Readonly<CtoRuntimeEscalationChannelSnapshot>;
  resolveEscalationChannelConfigs(kind: string): readonly Readonly<Record<string, unknown>>[];
  buildDigest(runId: string): Readonly<ScheduledDigest> | null;
  withRunTransaction<T>(runId: string, callback: (transaction: CtoRunTransactionFacade) => T): T;
  startScheduler(runId: string, intervalMs: number, onWave: () => void): () => void;
  close(): void;
  assertLive(): void;
}

export type CtoRuntimeBridgeRouteCandidate = Readonly<{
  runId: string;
  ownerSession: string;
  stateRevision: number;
  updatedAt: string;
  status: "active";
  channelProfile: Readonly<Record<string, unknown>>;
}>;

/** Narrow bridge capability: route selection/status only, never generic state mutation. */
export interface CtoRuntimeBridgeRouteAccess {
  assertLive(): void;
  resolveTelegramRoute(): CtoRuntimeBridgeRouteCandidate | null;
  resolveTelegramChannelProfile(): Readonly<Record<string, unknown>> | null;
  resolveCompletedStatus(): Readonly<{ runId: string; summary: Readonly<Record<string, unknown>> }> | null;
  ensureStandbyRun(): string;
  readStatus(runId: string): Readonly<Record<string, unknown>> | null;
  close(): void;
}

export type CtoRuntimeAccessProvider = (canonicalRoot: string, sessionId: string) => CtoRuntimeAccessFacade | null;

export type CtoRuntimeAccessOpenResult =
  | { readonly ok: true; readonly access: CtoRuntimeAccessFacade }
  | { readonly ok: false; readonly code: CtoRuntimeAccessFailureCode; readonly error: string };

type RuntimeCell = {
  context: RegistryRegistrationContext;
  snapshot: RegistryContextSnapshot;
  root: PinnedProjectRoot;
  sessionId: string;
  sessionManager: object;
  sessionFile?: string;
  sessionBasename?: string;
  sessionGeneration?: string | number;
  schedulers: Set<() => void>;
  revoked: boolean;
  access?: object;
  deliveryCapability?: object;
  authority: CtoRuntimeSessionAuthority;
  authorityLease?: () => void;
};

const runtimeCells = new WeakMap<object, RuntimeCell>();
const guardedRuntimeCells = new WeakMap<object, RuntimeCell>();
const deliveryCapabilities = new WeakMap<object, RuntimeCell>();
const bridgeDeliveryCapabilities = new WeakSet<object>();
export const MAX_RUNTIME_ACCESS_SCHEDULERS = 8;
export const MIN_RUNTIME_ACCESS_INTERVAL_MS = 10;
export const MAX_RUNTIME_ACCESS_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const MAX_RUNTIME_ACCESS_PROVIDERS = 256;

/** One bounded session identity policy shared by every native CTO mutator. */
export function isSafeCtoRuntimeSessionId(value: unknown): value is string {
  return typeof value === "string"
    && value.trim().length > 0
    && Buffer.byteLength(value, "utf8") <= MAX_RUNTIME_SESSION_ID_BYTES
    && !/[\u0000-\u001f\u007f-\u009f\p{Cf}\p{Zl}\p{Zp}]/u.test(value);
}

/** Internal verifier used by state.ts; delivery capability is never public. */
export function isCtoRuntimeDeliveryCapability(value: unknown): boolean {
  return typeof value === "object" && value !== null && (deliveryCapabilities.has(value) || bridgeDeliveryCapabilities.has(value));
}

function runtimeCellForFacade(value: unknown): RuntimeCell | null {
  if (!value || typeof value !== "object") return null;
  return runtimeCells.get(value) ?? guardedRuntimeCells.get(value) ?? null;
}

/**
 * Build a null-prototype, core-branded facade that adds a host identity guard
 * without inheriting or consulting any caller-controlled properties. Public API
 * capabilities are same-process loaded-JS trust boundaries, not cryptographic
 * identities for an untrusted runtime.
 */
export function createCtoRuntimeAccessGuardedView(
  genuine: CtoRuntimeAccessFacade,
  assertIdentityLive: () => void,
): CtoRuntimeAccessFacade {
  const cell = genuine && typeof genuine === "object" ? runtimeCells.get(genuine) : undefined;
  if (!cell || typeof assertIdentityLive !== "function") {
    throw new CtoRuntimeAccessError("runtime_access_invalid", "a genuine CTO runtime facade and identity guard are required");
  }
  requireLive(cell);
  assertIdentityLive();
  const guarded = Object.create(null) as CtoRuntimeAccessFacade;
  const methodNames = [
    "findActiveRun", "readState", "hasValidStateProof", "stateDirectory", "assertProjectRoot", "ensureStandbyRun",
    "registerRunOrigin", "createRun", "readActiveDeliveryCandidates", "readCompletedDeliveryCandidates",
    "readDeliveryIndexPage", "readCompletedDeliveryIndexPage", "markDeliveryPending", "publishOutboxDelivery",
    "recordOutboxDeliveryObligation", "readOutboxDeliveryObligations", "removeOutboxDeliveryObligation",
    "acknowledgeDelivery", "currentOutboxDeliveryStatus", "listEscalationChannelKinds",
    "resolveEscalationChannelSnapshot", "resolveEscalationChannelConfigs", "buildDigest", "withRunTransaction",
    "startScheduler", "close", "assertLive",
  ] as const satisfies readonly (keyof CtoRuntimeAccessFacade)[];
  const invoke = (name: keyof CtoRuntimeAccessFacade): ((...args: unknown[]) => unknown) => {
    return (...args: unknown[]): unknown => {
      const method = genuine[name];
      if (typeof method !== "function") throw new CtoRuntimeAccessError("runtime_access_invalid", `runtime facade method '${String(name)}' is unavailable`);
      if (name === "close") return Reflect.apply(method as (...values: unknown[]) => unknown, genuine, args);
      assertIdentityLive();
      const result = Reflect.apply(method as (...values: unknown[]) => unknown, genuine, args);
      if (result && typeof result === "object" && typeof (result as { then?: unknown }).then === "function") {
        return (result as Promise<unknown>).then(
          (value) => { assertIdentityLive(); return value; },
          (error) => { assertIdentityLive(); throw error; },
        );
      }
      assertIdentityLive();
      return result;
    };
  };
  for (const name of methodNames) {
    Object.defineProperty(guarded, name, { enumerable: false, configurable: false, writable: false, value: invoke(name) });
  }
  Object.freeze(guarded);
  guardedRuntimeCells.set(guarded as object, cell);
  return guarded;
}

/** Validates a genuine runtime facade or guarded derived wrapper. */
export function assertCtoRuntimeAccessFacadeLive(
  value: unknown,
  expectedRoot?: string,
  expectedSessionId?: string,
): asserts value is CtoRuntimeAccessFacade {
  const cell = runtimeCellForFacade(value);
  if (!cell) throw new CtoRuntimeAccessError("runtime_access_invalid", "CTO runtime access is not a marker-bound runtime facade");
  requireLive(cell);
  if (expectedRoot !== undefined && cell.root.canonical_root !== expectedRoot) {
    throw new CtoRuntimeAccessError("runtime_access_invalid", "CTO runtime access project root does not match");
  }
  if (expectedSessionId !== undefined && (!isSafeCtoRuntimeSessionId(expectedSessionId) || cell.sessionId !== expectedSessionId)) {
    throw new CtoRuntimeAccessError("runtime_access_invalid", "CTO runtime access session does not match");
  }
}

export function isCtoRuntimeAccessFacade(value: unknown): value is CtoRuntimeAccessFacade {
  return runtimeCellForFacade(value) !== null;
}

const runtimeAccessProviders = new Set<CtoRuntimeAccessProvider>();
export function registerCtoRuntimeAccessProvider(provider: CtoRuntimeAccessProvider): () => void {
  if (typeof provider !== "function") throw new TypeError("CTO runtime access provider must be a function");
  if (!runtimeAccessProviders.has(provider) && runtimeAccessProviders.size >= MAX_RUNTIME_ACCESS_PROVIDERS) {
    throw new CtoRuntimeAccessError("runtime_access_invalid", "CTO runtime access provider registry capacity is exhausted");
  }
  runtimeAccessProviders.add(provider);
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    runtimeAccessProviders.delete(provider);
  };
}

/** Resolve exactly one live, same-root runtime capability without accepting model input. */
export function resolveCtoRuntimeAccessForRoot(root: string, sessionId: string): CtoRuntimeAccessFacade | null {
  if (typeof root !== "string" || root.length === 0 || !isSafeCtoRuntimeSessionId(sessionId)) return null;
  const pinnedRoot = PinnedProjectRoot.open(root);
  if (!pinnedRoot) return null;
  try {
    if (!pinnedRoot.isStable()) return null;
    const canonicalRoot = pinnedRoot.canonical_root;
    const found = new Map<RuntimeCell, CtoRuntimeAccessFacade>();
    for (const provider of runtimeAccessProviders) {
      let candidate: CtoRuntimeAccessFacade | null = null;
      try { candidate = provider(canonicalRoot, sessionId); } catch { continue; }
      if (!candidate) continue;
      try {
        assertCtoRuntimeAccessFacadeLive(candidate, canonicalRoot, sessionId);
        const cell = runtimeCellForFacade(candidate);
        if (cell) found.set(cell, candidate);
      } catch { /* stale or foreign provider result */ }
    }
    if (found.size !== 1 || !pinnedRoot.isStable()) return null;
    return [...found.values()][0] ?? null;
  } finally { pinnedRoot.close(); }
}

function ownString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && Buffer.byteLength(value, "utf8") <= MAX_RUNTIME_SESSION_ID_BYTES
    && !/[\u0000\r\n]/u.test(value);
}

function ownRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object" || !("code" in error)) return undefined;
  const code = error.code;
  return typeof code === "string" ? code : undefined;
}

function openFailure(code: CtoRuntimeAccessFailureCode, error: unknown): CtoRuntimeAccessOpenResult {
  return { ok: false, code, error: error instanceof Error ? error.message : String(error) };
}

function runtimeError(code: CtoRuntimeAccessFailureCode, message: string): CtoRuntimeAccessError {
  return new CtoRuntimeAccessError(code, message);
}

function cloneValue(value: unknown, redact: boolean, seen = new WeakMap<object, unknown>()): unknown {
  if (value === null || typeof value !== "object") return value;
  const object = value as object;
  const prior = seen.get(object);
  if (prior !== undefined) return prior;
  if (ArrayBuffer.isView(value)) {
    const result = new Uint8Array(value.byteLength);
    result.set(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
    seen.set(object, result);
    return result;
  }
  if (value instanceof ArrayBuffer) {
    const result = value.slice(0);
    seen.set(object, result);
    return result;
  }
  if (Array.isArray(value)) {
    const result: unknown[] = [];
    seen.set(object, result);
    for (const entry of value) result.push(cloneValue(entry, redact, seen));
    return Object.freeze(result);
  }
  const result = Object.create(null) as Record<string, unknown>;
  seen.set(object, result);
  for (const [key, entry] of Object.entries(value)) {
    if (redact && SENSITIVE_PROJECTION_KEY.test(key)) continue;
    result[key] = cloneValue(entry, redact, seen);
  }
  return Object.freeze(result);
}

function detachedProjection<T>(value: T): T {
  return cloneValue(value, true) as T;
}

function detachedConfig(value: unknown): Readonly<Record<string, unknown>> {
  return cloneValue(value, false) as Readonly<Record<string, unknown>>;
}

function requireSafeRunId(runId: string): void {
  if (typeof runId !== "string" || !/^[A-Za-z0-9._-]+$/u.test(runId) || runId === "." || runId === ".." || runId.length > 128) {
    throw runtimeError("runtime_access_invalid", "unsafe CTO run id");
  }
}

function requireLive(cell: RuntimeCell): void {
  if (cell.revoked) throw runtimeError("activation_revoked", "CTO runtime access has been revoked");
  const authority = authenticateCtoRuntimeSessionAuthority(cell.authority, cell.context, {
    canonical_root: cell.snapshot.canonical_root,
    dev: cell.snapshot.root_dev,
    ino: cell.snapshot.root_ino,
  });
  if (!authority || authority.sessionId !== cell.sessionId || authority.sessionManager !== cell.sessionManager
    || authority.sessionFile !== cell.sessionFile || authority.sessionBasename !== cell.sessionBasename
    || authority.generation !== cell.sessionGeneration) {
    revoke(cell);
    throw runtimeError("activation_revoked", "CTO runtime session authority has been revoked or rebound");
  }
  let current: RegistryContextSnapshot;
  try {
    current = requireRegistryContext(cell.context, cell.snapshot.canonical_root, "workflow_tools");
  } catch (error) {
    revoke(cell);
    throw runtimeError("activation_revoked", error instanceof Error ? error.message : String(error));
  }
  if (
    current.canonical_root !== cell.snapshot.canonical_root
    || current.root_dev !== cell.snapshot.root_dev
    || current.root_ino !== cell.snapshot.root_ino
    || current.owner_fingerprint !== cell.snapshot.owner_fingerprint
    || current.principal_fingerprint !== cell.snapshot.principal_fingerprint
    || current.claim_generation !== cell.snapshot.claim_generation
    || current.marker_generation !== cell.snapshot.marker_generation
    || current.marker_digest !== cell.snapshot.marker_digest
  ) {
    revoke(cell);
    throw runtimeError("activation_revoked", "CTO runtime activation identity changed");
  }
  if (
    !cell.root.isStable()
    || cell.root.canonical_root !== cell.snapshot.canonical_root
    || cell.root.dev !== cell.snapshot.root_dev
    || cell.root.ino !== cell.snapshot.root_ino
  ) {
    revoke(cell);
    throw runtimeError("activation_revoked", "CTO runtime project root identity changed");
  }
}

function requireTransactionActive(cell: RuntimeCell, activity: { active: boolean }): void {
  if (!activity.active) throw runtimeError("activation_revoked", "CTO run transaction is no longer active");
  requireLive(cell);
}

function revoke(cell: RuntimeCell): void {
  if (cell.revoked) {
    if (cell.access) runtimeCells.delete(cell.access);
    return;
  }
  cell.revoked = true;
  if (cell.authorityLease) detachCtoRuntimeSessionAuthority(cell.authority, cell.authorityLease);
  for (const stop of cell.schedulers) {
    try { stop(); } catch { /* scheduler teardown is best effort */ }
  }
  cell.schedulers.clear();
  cell.root.close();
  if (cell.access) runtimeCells.delete(cell.access);
}

function candidatesProjection(result: CtoRunDeliveryCandidatesRead): Readonly<CtoRunDeliveryCandidatesRead> {
  return detachedProjection(result) as Readonly<CtoRunDeliveryCandidatesRead>;
}

function pageProjection(result: CtoRunDeliveryIndexPage): Readonly<CtoRunDeliveryIndexPage> {
  return detachedProjection(result) as Readonly<CtoRunDeliveryIndexPage>;
}

function readEscalationConfig(root: PinnedProjectRoot): EscalationConfigLoadResult {
  try {
    return loadEscalationConfigRaw(root.canonical_root, { pinnedRoot: root });
  } catch {
    throw runtimeError("runtime_access_invalid", "escalation config could not be read safely");
  }
}

function invalidEscalationConfigError(loaded: Extract<EscalationConfigLoadResult, { status: "invalid" }>): CtoRuntimeAccessError {
  const reason = SAFE_ESCALATION_INVALID_REASONS[loaded.code] ?? "escalation config was rejected";
  return runtimeError("runtime_access_invalid", `escalation config invalid (${loaded.code}): ${reason}`);
}

function channelKindNamesFromConfig(document: NormalizedEscalationConfig): readonly string[] {
  const kinds: string[] = [];
  const seen = new Set<string>();
  const add = (value: unknown): void => {
    if (!ownString(value) || Buffer.byteLength(value, "utf8") > MAX_RUNTIME_CHANNEL_KIND_BYTES || !/^[A-Za-z0-9._-]+$/u.test(value) || seen.has(value)) return;
    seen.add(value);
    kinds.push(value);
  };
  if (Array.isArray(document.channels)) {
    for (const entry of document.channels) {
      if (ownRecord(entry)) add(entry.adapter);
    }
  } else {
    add(document.adapter);
  }
  return kinds.length === 0 ? EMPTY_CHANNEL_KINDS : Object.freeze(kinds);
}

const CHANNEL_PROJECTION_SHARED_KEYS = new Set(["adapter", "id", "name", "mode", "direction", "primary", "subscriptions", "fields", "ackTarget", "chatId", "bidirectional"]);

function channelConfigsForNormalizedConfig(document: NormalizedEscalationConfig, kind: string): readonly Readonly<Record<string, unknown>>[] {
  const ownConfig = (source: Record<string, unknown>): Readonly<Record<string, unknown>> => {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(source)) {
      if (CHANNEL_PROJECTION_SHARED_KEYS.has(key) || key === kind) result[key] = value;
    }
    return detachedConfig(result);
  };
  if (Array.isArray(document.channels)) {
    const result: Readonly<Record<string, unknown>>[] = [];
    for (const entry of document.channels) {
      if (ownRecord(entry) && entry.adapter === kind) result.push(ownConfig(entry));
    }
    return result.length === 0 ? EMPTY_CHANNEL_CONFIGS : Object.freeze(result);
  }
  if (document.adapter !== kind) return EMPTY_CHANNEL_CONFIGS;
  return Object.freeze([ownConfig(document)]);
}

function channelKindNames(root: PinnedProjectRoot): readonly string[] {
  const loaded = readEscalationConfig(root);
  if (loaded.status === "absent") return EMPTY_CHANNEL_KINDS;
  if (loaded.status === "invalid") throw invalidEscalationConfigError(loaded);
  return channelKindNamesFromConfig(loaded.config);
}

function channelSnapshot(root: PinnedProjectRoot): Readonly<CtoRuntimeEscalationChannelSnapshot> {
  const loaded = readEscalationConfig(root);
  if (loaded.status === "absent") return Object.freeze({ status: "absent" });
  if (loaded.status === "invalid") {
    const failure = invalidEscalationConfigError(loaded);
    return Object.freeze({ status: "invalid", code: loaded.code, reason: failure.message });
  }
  const kinds = channelKindNamesFromConfig(loaded.config);
  const projections: Record<string, CtoRuntimeEscalationChannelProjection> = Object.create(null) as Record<string, CtoRuntimeEscalationChannelProjection>;
  for (const kind of kinds) projections[kind] = channelConfigsForNormalizedConfig(loaded.config, kind);
  const config_sha256 = loaded.config_sha256
    ?? createHash("sha256").update(JSON.stringify(loaded.config), "utf8").digest("hex");
  return Object.freeze({ status: "valid", config_sha256, kinds, projections: Object.freeze(projections) });
}

function channelConfigsForKind(root: PinnedProjectRoot, kind: string): readonly Readonly<Record<string, unknown>>[] {
  if (!ownString(kind) || Buffer.byteLength(kind, "utf8") > MAX_RUNTIME_CHANNEL_KIND_BYTES || !/^[A-Za-z0-9._-]+$/u.test(kind)) return EMPTY_CHANNEL_CONFIGS;
  const loaded = readEscalationConfig(root);
  if (loaded.status === "absent") return EMPTY_CHANNEL_CONFIGS;
  if (loaded.status === "invalid") throw invalidEscalationConfigError(loaded);
  return channelConfigsForNormalizedConfig(loaded.config, kind);
}

function makeFacade(cell: RuntimeCell): CtoRuntimeAccessFacade {
  const methods: CtoRuntimeAccessFacade = Object.create(null) as CtoRuntimeAccessFacade;
  Object.defineProperties(methods, {
    findActiveRun: {
      enumerable: false,
      value: (): CtoRuntimeActiveRunProjection | null => {
        requireLive(cell);
        try {
          const authority = readCtoRunDeliveryIndexAuthorityPinned(cell.root);
          const proofPath = join(".work-state", "cto", ".active-run-index.proof.json");
          if (!authority.authenticated && cell.root.pathEntryInfo(proofPath) !== null) {
            throw runtimeError("runtime_access_invalid", "canonical CTO delivery authority is unavailable");
          }
          if (!authority.authenticated && !refreshCtoRunDeliveryIndexAuthorityPinned(cell.root, cell.deliveryCapability, cell.sessionId)) {
            throw runtimeError("runtime_access_invalid", "canonical CTO delivery authority is unavailable");
          }
          const found = findActiveCtoRun(cell.root.canonical_root, { sessionId: cell.sessionId, pinnedRoot: cell.root });
          if (!found) return null;
          if (!refreshCtoRunDeliveryIndexAuthorityPinned(cell.root, cell.deliveryCapability, cell.sessionId)) {
            throw runtimeError("runtime_access_invalid", "canonical CTO delivery authority changed during active-run read");
          }
          const state = detachedProjection(found.state) as unknown as Readonly<Record<string, unknown>>;
          return { runId: found.runId, state };
        } catch (error) {
          if (error instanceof CtoRuntimeAccessError) throw error;
          if (error instanceof CtoAuthorityUnavailableError || (error instanceof Error && /delivery index|proof|state read|authority/i.test(error.message))) {
            throw runtimeError("runtime_access_invalid", "canonical CTO delivery authority is unavailable");
          }
          throw error;
        }
      },
    },
    readState: {
      enumerable: false,
      value: (runId: string): Readonly<Record<string, unknown>> | null => {
        requireLive(cell);
        requireSafeRunId(runId);
        const state = readCtoStatePinned(runId, cell.root);
        if (state === null) return null;
        const projection = detachedProjection(state) as unknown as Readonly<Record<string, unknown>>;
        return projection;
      },
    },
    hasValidStateProof: {
      enumerable: false,
      value: (runId: string): boolean => {
        requireLive(cell);
        requireSafeRunId(runId);
        const state = readCtoStatePinned(runId, cell.root);
        return state !== null && hasValidCtoRuntimeStateProofPinned(cell.root, state);
      },
    },
    stateDirectory: {
      enumerable: false,
      value: (runId: string): string => {
        requireLive(cell);
        requireSafeRunId(runId);
        return join(cell.root.canonical_root, ".work-state", "cto", runId);
      },
    },
    assertProjectRoot: {
      enumerable: false,
      value: (projectRoot: string): void => {
        requireLive(cell);
        if (typeof projectRoot !== "string" || projectRoot.trim().length === 0) throw runtimeError("runtime_access_invalid", "project root is required");
        const supplied = PinnedProjectRoot.open(projectRoot);
        if (!supplied) throw runtimeError("runtime_access_invalid", "project root could not be pinned");
        try {
          if (
            supplied.canonical_root !== cell.root.canonical_root
            || supplied.dev !== cell.root.dev
            || supplied.ino !== cell.root.ino
            || !supplied.isStable()
          ) throw runtimeError("runtime_access_invalid", "project root does not match the marker-bound facade root");
          requireLive(cell);
        } finally {
          supplied.close();
        }
      },
    },
    registerRunOrigin: {
      enumerable: false,
      value: (runId: string, handoff: CtoRuntimeRunOriginHandoff): boolean => {
        requireLive(cell);
        if (!ownString(runId) || !handoff || !ownString(handoff.source_id) || !/^[0-9a-f]{64}$/u.test(handoff.initial_state_sha256)) return false;
        return withCtoRunLock(cell.root.canonical_root, runId, () => {
          requireLive(cell);
          const state = readCtoStatePinned(runId, cell.root);
          if (!state || ctoRuntimeRunInitialIdentityDigest(state) !== handoff.initial_state_sha256) return false;
          return mintCtoRuntimeRunOrigin(cell.root, state, cell.sessionId, handoff.source_id, handoff.initial_state_sha256);
        }, { pinnedRoot: cell.root });
      },
    },
    createRun: {
      enumerable: false,
      value: (state: CtoState, handoff: CtoRuntimeRunOriginHandoff): CtoState => {
        requireLive(cell);
        if (!state || typeof state !== "object" || !ownString(state.id) || !handoff || !ownString(handoff.source_id)
          || !/^[0-9a-f]{64}$/u.test(handoff.initial_state_sha256)
          || ctoRuntimeRunInitialIdentityDigest(state) !== handoff.initial_state_sha256
          || (state.standby !== true && state.owner_session !== cell.sessionId)) {
          throw runtimeError("runtime_access_invalid", "trusted CTO run creation handoff is invalid");
        }
        return withCtoRunLock(cell.root.canonical_root, state.id, () => {
          requireLive(cell);
          const existing = readCtoStatePinned(state.id, cell.root);
          if (existing) {
            if (ctoRuntimeRunInitialIdentityDigest(existing) !== handoff.initial_state_sha256
              || !hasCtoRuntimeRunOriginHandoffPinned(cell.root, existing, cell.sessionId, handoff.source_id, handoff.initial_state_sha256)) {
              throw runtimeError("runtime_access_invalid", "CTO run creation conflicts with an existing authenticated origin");
            }
            if (!hasValidCtoRuntimeStateProofPinned(cell.root, existing)) {
              if (!writeCtoRuntimeStateProof(cell.root, existing) || !hasValidCtoRuntimeStateProofPinned(cell.root, existing)) {
                throw runtimeError("runtime_access_invalid", "CTO run state proof recovery failed");
              }
            }
            if (!refreshCtoRunDeliveryIndexAuthorityPinned(cell.root, cell.deliveryCapability, cell.sessionId)) {
              throw runtimeError("runtime_access_invalid", "CTO delivery index proof recovery failed");
            }
            return existing;
          }
          if (!mintCtoRuntimeRunOrigin(cell.root, state, cell.sessionId, handoff.source_id, handoff.initial_state_sha256)) {
            throw runtimeError("runtime_access_invalid", "CTO run origin proof could not be committed");
          }
          writeCtoStateLocked(state, cell.root.canonical_root, {
            pinnedRoot: cell.root,
            preCommit: ({ pinnedRoot }) => {
              requireLive(cell);
              if (!pinnedRoot.isStable()) throw runtimeError("activation_revoked", "CTO project root changed before run creation");
            },
          });
          const created = readCtoStatePinned(state.id, cell.root);
          if (!created || !hasValidCtoRuntimeRunOriginPinned(cell.root, created)
            || !writeCtoRuntimeStateProof(cell.root, created) || !hasValidCtoRuntimeStateProofPinned(cell.root, created)) {
            throw runtimeError("runtime_access_invalid", "trusted CTO run origin/state proof failed after creation");
          }
          if (!refreshCtoRunDeliveryIndexAuthorityPinned(cell.root, cell.deliveryCapability, cell.sessionId)) {
            throw runtimeError("runtime_access_invalid", "trusted CTO delivery index proof failed after creation");
          }
          return created;
        }, { pinnedRoot: cell.root });
      },
    },
    ensureStandbyRun: {
      enumerable: false,
      value: (): string => {
        requireLive(cell);
        let active: ReturnType<typeof findActiveCtoRun>;
        try {
          const indexPath = join(".work-state", "cto", "active-run-index.json");
          active = cell.root.pathEntryInfo(indexPath) ? findActiveCtoRun(cell.root.canonical_root, { sessionId: cell.sessionId, pinnedRoot: cell.root }) : null;
        } catch (error) {
          if (error instanceof CtoAuthorityUnavailableError || (error instanceof Error && /delivery index|proof|state read|authority/i.test(error.message))) {
            throw runtimeError("runtime_access_invalid", "canonical CTO delivery authority is unavailable");
          }
          throw error;
        }
        if (active) return active.runId;
        try {
          return withCtoRegistryLock(
            cell.root.canonical_root,
            () => {
              requireLive(cell);
              const indexPath = join(".work-state", "cto", "active-run-index.json");
              const current = cell.root.pathEntryInfo(indexPath) ? findActiveCtoRun(cell.root.canonical_root, { sessionId: cell.sessionId, pinnedRoot: cell.root }) : null;
              if (current) return current.runId;

              const runId = `standby-${Date.now()}-${randomUUID().slice(0, 8)}`;
              const runDirectory = join(".work-state", "cto", runId);
              const inboxDirectory = join(runDirectory, "inbox");
              const beforeRun = cell.root.pathEntryInfo(runDirectory);
              const beforeInbox = cell.root.pathEntryInfo(inboxDirectory);
              if (beforeRun && beforeRun.kind !== "directory") throw new Error("standby run directory is not a real directory");
              if (beforeInbox && beforeInbox.kind !== "directory") throw new Error("standby inbox directory is not a real directory");

              let completed = false;
              let createdRun: { dev: number; ino: number } | null = null;
              let createdInbox: { dev: number; ino: number } | null = null;
              try {
                cell.root.ensureDirectories([runDirectory, inboxDirectory]);
                if (!cell.root.isStable()) throw new Error("standby project root changed after directory creation");
                const afterRun = cell.root.pathEntryInfo(runDirectory);
                const afterInbox = cell.root.pathEntryInfo(inboxDirectory);
                if (!afterRun || afterRun.kind !== "directory" || !afterInbox || afterInbox.kind !== "directory") {
                  throw new Error("standby directory identity changed during creation");
                }
                if (!beforeRun) createdRun = { dev: afterRun.dev, ino: afterRun.ino };
                if (!beforeInbox) createdInbox = { dev: afterInbox.dev, ino: afterInbox.ino };

                const now = new Date().toISOString();
                const state = newCtoState({
                  id: runId,
                  task: "standby — awaiting inbox tasks",
                  branch: "",
                  autonomous: true,
                  plan: { id: runId, task: "standby — awaiting inbox tasks", teams: [], created_at: now },
                  standby: true,
                });
                state.pause = { kind: "none", reason: "standby" };
                const sourceId = `standby:${runId}`;
                const initialStateSha256 = ctoRuntimeRunInitialIdentityDigest(state);
                if (!mintCtoRuntimeRunOrigin(cell.root, state, cell.sessionId, sourceId, initialStateSha256)) {
                  throw runtimeError("runtime_access_invalid", "standby run origin proof could not be committed");
                }
                writeCtoStateLocked(state, cell.root.canonical_root, {
                  pinnedRoot: cell.root,
                  preCommit: ({ pinnedRoot }) => {
                    requireLive(cell);
                    if (!pinnedRoot.isStable()) throw runtimeError("activation_revoked", "standby project root changed before state commit");
                  },
                });
                if (!writeCtoRuntimeStateProof(cell.root, state) || !hasValidCtoRuntimeStateProofPinned(cell.root, state)) {
                  throw runtimeError("runtime_access_invalid", "standby run state proof could not be committed");
                }
                if (!refreshCtoRunDeliveryIndexAuthorityPinned(cell.root, cell.deliveryCapability, cell.sessionId)) {
                  throw runtimeError("runtime_access_invalid", "standby delivery index proof could not be committed");
                }
                if (!cell.root.isStable()) throw new Error("standby project root changed after state/index publication");
                const finalRun = cell.root.pathEntryInfo(runDirectory);
                const finalInbox = cell.root.pathEntryInfo(inboxDirectory);
                if (!finalRun || finalRun.kind !== "directory" || !finalInbox || finalInbox.kind !== "directory") {
                  throw new Error("standby path identity changed after state/index publication");
                }
                completed = true;
                return runId;
              } catch (error) {
                if ((error as NodeJS.ErrnoException)?.code === "EEXIST") {
                  const indexPath = join(".work-state", "cto", "active-run-index.json");
                  const winner = cell.root.pathEntryInfo(indexPath) ? findActiveCtoRun(cell.root.canonical_root, { sessionId: cell.sessionId, pinnedRoot: cell.root }) : null;
                  if (winner) {
                    completed = true;
                    return winner.runId;
                  }
                }
                throw error;
              } finally {
                if (!completed && cell.root.isStable()) {
                  if (createdInbox) {
                    try { cell.root.removeEmptyDirectoryIfMatches(inboxDirectory, createdInbox); } catch { /* preserve evidence for recovery */ }
                  }
                  if (createdRun) {
                    try { cell.root.removeEmptyDirectoryIfMatches(runDirectory, createdRun); } catch { /* preserve evidence for recovery */ }
                  }
                }
              }
            },
            { pinnedRoot: cell.root },
          );
        } catch (error) {
          if (error instanceof CtoRuntimeAccessError) throw error;
          let stable = false;
          try { stable = cell.root.isStable(); } catch { /* closed roots are revoked below */ }
          if (!stable) {
            revoke(cell);
            throw runtimeError("activation_revoked", error instanceof Error ? error.message : String(error));
          }
          throw error;
        }
      },
    },
    readActiveDeliveryCandidates: {
      enumerable: false,
      value: (): Readonly<CtoRunDeliveryCandidatesRead> => {
        requireLive(cell);
        return candidatesProjection(readCtoRunDeliveryActiveCandidatesPinned(cell.root));
      },
    },
    readCompletedDeliveryCandidates: {
      enumerable: false,
      value: (): Readonly<CtoRunDeliveryCandidatesRead> => {
        requireLive(cell);
        return candidatesProjection(readCtoRunDeliveryCompletedCandidatesPinned(cell.root));
      },
    },
    readDeliveryIndexPage: {
      enumerable: false,
      value: (options: { after_run_id?: string; startAfter?: string; limit?: number } = {}): Readonly<CtoRunDeliveryIndexPage> => {
        requireLive(cell);
        if (!ownRecord(options) || Object.keys(options).some((key) => key !== "after_run_id" && key !== "startAfter" && key !== "limit")) {
          throw runtimeError("runtime_access_invalid", "delivery index options are invalid");
        }
        if (options.after_run_id !== undefined && options.startAfter !== undefined) {
          throw runtimeError("runtime_access_invalid", "delivery cursors are mutually exclusive");
        }
        const copy: { after_run_id?: string; startAfter?: string; limit?: number } = {};
        if (options.after_run_id !== undefined) {
          if (typeof options.after_run_id !== "string") throw runtimeError("runtime_access_invalid", "delivery cursor is invalid");
          requireSafeRunId(options.after_run_id);
          copy.after_run_id = options.after_run_id;
        }
        if (options.startAfter !== undefined) {
          if (typeof options.startAfter !== "string") throw runtimeError("runtime_access_invalid", "delivery cursor is invalid");
          requireSafeRunId(options.startAfter);
          copy.startAfter = options.startAfter;
        }
        if (options.limit !== undefined) {
          if (!Number.isSafeInteger(options.limit) || options.limit <= 0) throw runtimeError("runtime_access_invalid", "delivery page limit is invalid");
          copy.limit = options.limit;
        }
        return pageProjection(readCtoRunDeliveryIndexPage(cell.root.canonical_root, copy, cell.root));
      },
    },
    readCompletedDeliveryIndexPage: {
      enumerable: false,
      value: (options: { after_run_id?: string; limit?: number } = {}): Readonly<CtoRunDeliveryIndexPage> => {
        requireLive(cell);
        if (!ownRecord(options) || Object.keys(options).some((key) => key !== "after_run_id" && key !== "limit")) {
          throw runtimeError("runtime_access_invalid", "completed delivery page options are invalid");
        }
        const copy: { after_run_id?: string; limit?: number } = {};
        if (options.after_run_id !== undefined) {
          if (typeof options.after_run_id !== "string") throw runtimeError("runtime_access_invalid", "completed delivery cursor is invalid");
          requireSafeRunId(options.after_run_id);
          copy.after_run_id = options.after_run_id;
        }
        if (options.limit !== undefined) {
          if (!Number.isSafeInteger(options.limit) || options.limit <= 0) throw runtimeError("runtime_access_invalid", "completed delivery page limit is invalid");
          copy.limit = options.limit;
        }
        const page = readCtoRunDeliveryCompletedIndexPage(cell.root.canonical_root, copy, cell.root);
        requireLive(cell);
        return detachedProjection(page);
      },
    },
    markDeliveryPending: {
      enumerable: false,
      value: (runId: string, stateRevision?: number, kind: "outbox" | "summary" | "retry" = "outbox"): boolean => {
        requireLive(cell);
        requireSafeRunId(runId);
        if (kind !== "outbox" && kind !== "summary" && kind !== "retry") throw runtimeError("runtime_access_invalid", "delivery kind is invalid");
        if (stateRevision !== undefined && (!Number.isSafeInteger(stateRevision) || stateRevision < 0)) throw runtimeError("runtime_access_invalid", "delivery state revision is invalid");
        return markCtoRunDeliveryPending(cell.root.canonical_root, runId, stateRevision, kind, cell.root, cell.deliveryCapability);
      },
    },
    publishOutboxDelivery: {
      enumerable: false,
      value: (input: CtoOutboxDeliveryPublishInput): string | null => {
        requireLive(cell);
        if (!ownRecord(input)) throw runtimeError("runtime_access_invalid", "outbox delivery input must be a plain object");
        const runId = input.run_id;
        if (typeof runId !== "string") throw runtimeError("runtime_access_invalid", "outbox delivery run id is invalid");
        requireSafeRunId(runId);
        if (!Number.isSafeInteger(input.state_revision) || input.state_revision < 0 || typeof input.entry_name !== "string") {
          throw runtimeError("runtime_access_invalid", "outbox delivery metadata is invalid");
        }
        if (input.legacy_entry_name !== undefined && typeof input.legacy_entry_name !== "string") throw runtimeError("runtime_access_invalid", "legacy delivery name is invalid");
        const json = typeof input.json === "string"
          ? input.json
          : input.json instanceof Uint8Array ? new Uint8Array(input.json) : null;
        if (json === null) throw runtimeError("runtime_access_invalid", "outbox delivery JSON is invalid");
        const copy: CtoOutboxDeliveryPublishInput = {
          run_id: runId,
          state_revision: input.state_revision,
          entry_name: input.entry_name,
          ...(input.legacy_entry_name === undefined ? {} : { legacy_entry_name: input.legacy_entry_name }),
          json,
        };
        return publishCtoOutboxDelivery(cell.root.canonical_root, copy, cell.root, cell.deliveryCapability);
      },
    },
    acknowledgeDelivery: {
      enumerable: false,
      value: (runId: string, expectedRevision: number, options: { drained: true } = { drained: true }): boolean => {
        requireLive(cell);
        requireSafeRunId(runId);
        if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || !ownRecord(options) || options.drained !== true) throw runtimeError("runtime_access_invalid", "delivery acknowledgement is invalid");
        return acknowledgeCtoRunDelivery(cell.root.canonical_root, runId, expectedRevision, { drained: true }, cell.root, cell.deliveryCapability);
      },
    },
    recordOutboxDeliveryObligation: {
      enumerable: false,
      value: (input: CtoOutboxDeliveryObligationInput): CtoOutboxDeliveryObligationRead | null => {
        requireLive(cell);
        if (!ownRecord(input)) throw runtimeError("runtime_access_invalid", "outbox obligation input must be a plain object");
        const result = recordCtoOutboxDeliveryObligation(cell.root.canonical_root, input, cell.root, cell.deliveryCapability);
        return result ? detachedProjection(result) : null;
      },
    },
    readOutboxDeliveryObligations: {
      enumerable: false,
      value: (runId?: string): readonly CtoOutboxDeliveryObligationRead[] => {
        requireLive(cell);
        if (runId !== undefined) requireSafeRunId(runId);
        if (runId === undefined) return Object.freeze([]);
        return detachedProjection(readCtoOutboxDeliveryObligationsPinned(cell.root.canonical_root, runId, cell.root));
      },
    },
    removeOutboxDeliveryObligation: {
      enumerable: false,
      value: (runId: string, entryName: string, envelopeId: string): boolean => {
        requireLive(cell);
        requireSafeRunId(runId);
        if (!ownString(entryName) || !ownString(envelopeId)) throw runtimeError("runtime_access_invalid", "outbox obligation identifiers are invalid");
        return removeCtoOutboxDeliveryObligation(cell.root.canonical_root, runId, entryName, envelopeId, cell.root, cell.deliveryCapability);
      },
    },
    currentOutboxDeliveryStatus: {
      enumerable: false,
      value: (input: CtoCurrentOutboxDeliveryInput): CtoCurrentOutboxDeliveryStatus => {
        requireLive(cell);
        if (!ownRecord(input)) throw runtimeError("runtime_access_invalid", "outbox delivery input must be a plain object");
        return currentOutboxDeliveryStatusPinned(input, cell.root, cell.deliveryCapability);
      },
    },
    listEscalationChannelKinds: {
      enumerable: false,
      value: (): readonly string[] => {
        requireLive(cell);
        return channelKindNames(cell.root);
      },
    },
    resolveEscalationChannelSnapshot: {
      enumerable: false,
      value: (): Readonly<CtoRuntimeEscalationChannelSnapshot> => {
        requireLive(cell);
        return channelSnapshot(cell.root);
      },
    },
    resolveEscalationChannelConfigs: {
      enumerable: false,
      value: (kind: string): readonly Readonly<Record<string, unknown>>[] => {
        requireLive(cell);
        return channelConfigsForKind(cell.root, kind);
      },
    },
    buildDigest: {
      enumerable: false,
      value: (runId: string): Readonly<ScheduledDigest> | null => {
        requireLive(cell);
        requireSafeRunId(runId);
        const state = readCtoStatePinned(runId, cell.root);
        if (!state) return null;
        const health = assessRunHealth(state);
        const digest: ScheduledDigest = {
          run_id: state.id,
          at: new Date().toISOString(),
          health,
          recent_decisions: recallDecisions(state, { limit: 10 }),
          open_escalations: health.pending_escalations,
          budget_status: checkBudget(state).status,
        };
        return detachedProjection(digest);
      },
    },
    withRunTransaction: {
      enumerable: false,
      value: <T>(runId: string, callback: (transaction: CtoRunTransactionFacade) => T): T => {
        requireLive(cell);
        requireSafeRunId(runId);
        if (typeof callback !== "function") throw runtimeError("runtime_access_invalid", "run transaction callback is invalid");
        return withCtoRunLock(cell.root.canonical_root, runId, (handle: CtoRunLockHandle) => {
          requireLive(cell);
          const initial = readCtoStatePinned(runId, cell.root);
          if (!initial) throw runtimeError("runtime_access_invalid", `CTO run '${runId}' is unavailable`);
          let state = structuredClone(initial) as CtoState;
          let dirty = false;
          const activity = { active: true };
          const transaction: CtoRunTransactionFacade = Object.create(null) as CtoRunTransactionFacade;
          Object.defineProperties(transaction, {
            readState: {
              enumerable: false,
              value: (): CtoState => {
                requireTransactionActive(cell, activity);
                return state;
              },
            },
            writeState: {
              enumerable: false,
              value: (next: CtoState): string => {
                requireTransactionActive(cell, activity);
                if (!next || typeof next !== "object" || next.id !== runId) throw runtimeError("runtime_access_invalid", "run transaction state identity does not match the bound run");
                state = structuredClone(next) as CtoState;
                dirty = true;
                return join(cell.root.canonical_root, ".work-state", "cto", runId, "state.json");
              },
            },
            appendWave: {
              enumerable: false,
              value: (options: AppendWaveOptions): CtoState => {
                requireTransactionActive(cell, activity);
                if (!ownRecord(options)) throw runtimeError("runtime_access_invalid", "wave options must be a plain object");
                const next = appendWave(state, options);
                if (next !== state) {
                  state = next;
                  dirty = true;
                }
                return state;
              },
            },
            findWaveBySourceId: {
              enumerable: false,
              value: (sourceId: string): WaveRecord | null => {
                requireTransactionActive(cell, activity);
                requireSafeRunId(sourceId);
                const matches = (state.wave_history ?? []).filter((wave) => wave.source_id === sourceId);
                return matches.length === 1 ? matches[0]! : null;
              },
            },
          });
          Object.freeze(transaction);
          try {
            const result = callback(transaction);
            let then: unknown;
            try {
              if (result !== null && (typeof result === "object" || typeof result === "function")) then = (result as { then?: unknown }).then;
            } catch {
              throw runtimeError("runtime_access_invalid", "run transaction result thenable inspection failed");
            }
            if (typeof then === "function") throw runtimeError("cto_runtime_transaction_async_unsupported", "CTO run transactions must complete synchronously");
            if (dirty) {
              requireTransactionActive(cell, activity);
              const initialOrigin = readCtoRuntimeRunOriginHandoffPinned(cell.root, runId);
              const originTransition = initialOrigin?.standby === true && initialOrigin.owner_session === null
                && state.standby !== true && state.owner_session === cell.sessionId
                ? { ownerSession: cell.sessionId }
                : undefined;
              writeCtoStateLocked(state, cell.root.canonical_root, {
                pinnedRoot: cell.root,
                ...(originTransition ? { originTransition } : {}),
                preCommit: ({ pinnedRoot }) => {
                  requireTransactionActive(cell, activity);
                  if (!pinnedRoot.isStable()) throw runtimeError("activation_revoked", "CTO project root changed before transaction commit");
                },
              });
              if (!refreshCtoRunDeliveryIndexAuthorityPinned(cell.root, cell.deliveryCapability, cell.sessionId)) {
                throw runtimeError("runtime_access_invalid", "CTO delivery index proof failed after transaction commit");
              }
            }
            return result;
          } finally {
            activity.active = false;
          }
        }, { pinnedRoot: cell.root });
      },
    },
    startScheduler: {
      enumerable: false,
      value: (runId: string, intervalMs: number, onWave: () => void): () => void => {
        requireLive(cell);
        requireSafeRunId(runId);
        if (!Number.isSafeInteger(intervalMs) || intervalMs < MIN_RUNTIME_ACCESS_INTERVAL_MS || intervalMs > MAX_RUNTIME_ACCESS_INTERVAL_MS) throw runtimeError("runtime_access_invalid", "scheduler interval must be an integer between configured bounds");
        if (typeof onWave !== "function") throw runtimeError("runtime_access_invalid", "scheduler callback is invalid");
        if (cell.schedulers.size >= MAX_RUNTIME_ACCESS_SCHEDULERS) throw runtimeError("runtime_access_invalid", "runtime scheduler capacity is exhausted");
        const state = readCtoStatePinned(runId, cell.root);
        if (!state) throw runtimeError("runtime_access_invalid", `CTO run '${runId}' is unavailable`);
        let stopped = false;
        let stop: () => void = () => undefined;
        const guardedOnWave = (): void => {
          if (stopped) return;
          try {
            requireLive(cell);
            onWave();
          } catch (error) {
            stop();
            throw error;
          }
        };
        const schedulerAdapter: CtoSchedulerStateAdapter = {
          read: (): CtoState => {
            requireLive(cell);
            const current = readCtoStatePinned(runId, cell.root);
            if (!current) throw runtimeError("runtime_access_invalid", `CTO run '${runId}' is unavailable`);
            return current;
          },
          update: (mutator): CtoState => {
            requireLive(cell);
            const current = readCtoStatePinned(runId, cell.root);
            if (!current) throw runtimeError("runtime_access_invalid", `CTO run '${runId}' is unavailable`);
            const next = mutator(current);
            if (!next || next.id !== runId) throw runtimeError("runtime_access_invalid", "scheduler state identity does not match the bound run");
            writeCtoState(next, cell.root.canonical_root, {
              pinnedRoot: cell.root,
              preCommit: ({ pinnedRoot }) => {
                requireLive(cell);
                if (!pinnedRoot.isStable()) throw runtimeError("activation_revoked", "CTO project root changed before scheduler commit");
              },
            });
            return next;
          },
        };
        stop = startWaveScheduler(state, schedulerAdapter, intervalMs, guardedOnWave);
        const wrappedStop = (): void => {
          if (stopped) return;
          stopped = true;
          stop();
          cell.schedulers.delete(wrappedStop);
        };
        cell.schedulers.add(wrappedStop);
        return wrappedStop;
      },
    },
    close: {
      enumerable: false,
      value: (): void => {
        revoke(cell);
      },
    },
    assertLive: {
      enumerable: false,
      value: (): void => {
        requireLive(cell);
      },
    },
  });
  return Object.freeze(methods);
}

function bridgeRouteProfileKey(profile: Readonly<Record<string, unknown>> | undefined): string | null {
  if (!profile || profile.adapter !== "telegram" || profile.transport !== "telegram" || profile.direction !== "rw" || profile.primary !== true) return null;
  return JSON.stringify({
    adapter: profile.adapter,
    transport: profile.transport,
    direction: profile.direction,
    primary: true,
    id: profile.id ?? null,
    ackTarget: profile.ackTarget ?? null,
    subscriptions: Array.isArray(profile.subscriptions) ? profile.subscriptions : null,
  });
}

function openBridgeRouteFromCell(
  registryContext: RegistryRegistrationContext,
  root: PinnedProjectRoot,
): CtoRuntimeBridgeRouteAccess {
  const assertLive = (): void => {
    if (!root.isStable()) throw runtimeError("activation_revoked", "bridge route project root changed");
    requireRegistryContext(registryContext, root.canonical_root, "workflow_tools");
  };
  const routeProfile = (): Readonly<Record<string, unknown>> | null => {
    assertLive();
    const loaded = loadEscalationConfigRaw(root.canonical_root, { pinnedRoot: root });
    if (loaded.status !== "valid") return null;
    const normalized = normalizeChannelConfigResult(loaded.config, {
      telegram: { canReceiveInbound: true, canSend: true, canSendWithIdempotency: true },
    });
    if (normalized.status !== "valid" || normalized.profiles.length !== 1) return null;
    const profile = normalized.profiles[0];
    if (!profile || !bridgeRouteProfileKey(profile as unknown as Readonly<Record<string, unknown>>)) return null;
    return Object.freeze({ ...profile });
  };
  const route = (): CtoRuntimeBridgeRouteCandidate | null => {
    const profile = routeProfile();
    if (!profile) return null;
    const profileKey = bridgeRouteProfileKey(profile);
    if (!profileKey) return null;
    const candidates = readCtoRunDeliveryActiveCandidatesPinned(root);
    if (!candidates.ok) return null;
    const matches: CtoRuntimeBridgeRouteCandidate[] = [];
    for (const entry of candidates.entries) {
      if (entry.status !== "active" || !Number.isSafeInteger(entry.state_revision) || entry.state_revision < 0) continue;
      const state = readCtoStatePinned(entry.run_id, root) as Readonly<Record<string, unknown>> | null;
      if (!state || state.id !== entry.run_id || state.state_revision !== entry.state_revision || state.updated_at !== entry.updated_at
        || typeof state.owner_session !== "string" || state.owner_session.length === 0 || state.standby === true
        || !hasValidCtoRuntimeStateProofPinned(root, state as unknown as CtoState)) continue;
      const stateProfile = state.channel_profile;
      if (!stateProfile || typeof stateProfile !== "object" || Array.isArray(stateProfile)) continue;
      if (bridgeRouteProfileKey(stateProfile as Readonly<Record<string, unknown>>) !== profileKey) continue;
      matches.push(Object.freeze({ runId: entry.run_id, ownerSession: state.owner_session, stateRevision: entry.state_revision, updatedAt: entry.updated_at, status: "active", channelProfile: profile }));
    }
    if (matches.length !== 1) return null;
    const selected = matches[0];
    if (!selected) return null;
    assertLive();
    const second = readCtoRunDeliveryActiveCandidatesPinned(root);
    if (!second.ok) return null;
    const rebound = second.entries.find((entry) => entry.run_id === selected.runId);
    if (!rebound || rebound.status !== "active" || rebound.state_revision !== selected.stateRevision || rebound.updated_at !== selected.updatedAt) return null;
    const reboundState = readCtoStatePinned(selected.runId, root) as Readonly<Record<string, unknown>> | null;
    if (!reboundState || reboundState.id !== selected.runId || reboundState.state_revision !== selected.stateRevision || reboundState.updated_at !== selected.updatedAt
      || reboundState.owner_session !== selected.ownerSession || !hasValidCtoRuntimeStateProofPinned(root, reboundState as unknown as CtoState)) return null;
    return selected;
  };
  const bridgeDeliveryCapability = Object.freeze({});
  bridgeDeliveryCapabilities.add(bridgeDeliveryCapability);
  const ensureStandbyRun = (): string => {
    assertLive();
    const existing = readCtoRunDeliveryActiveCandidatesPinned(root);
    if (existing.ok) {
      for (const entry of existing.entries) {
        if (entry.status !== "standby") continue;
        const state = readCtoStatePinned(entry.run_id, root);
        if (state && state.id === entry.run_id && state.standby === true && hasValidCtoRuntimeStateProofPinned(root, state)) return entry.run_id;
      }
    }
    return withCtoRegistryLock(root.canonical_root, () => {
      assertLive();
      const rebound = readCtoRunDeliveryActiveCandidatesPinned(root);
      if (rebound.ok) {
        for (const entry of rebound.entries) {
          if (entry.status !== "standby") continue;
          const state = readCtoStatePinned(entry.run_id, root);
          if (state && state.id === entry.run_id && state.standby === true && hasValidCtoRuntimeStateProofPinned(root, state)) return entry.run_id;
        }
      }
      const runId = `standby-${Date.now()}-${randomUUID().slice(0, 8)}`;
      const runDirectory = join(".work-state", "cto", runId);
      const inboxDirectory = join(runDirectory, "inbox");
      try {
        root.ensureDirectories([runDirectory, inboxDirectory]);
        const now = new Date().toISOString();
        const state = newCtoState({ id: runId, task: "standby — awaiting inbox tasks", branch: "", autonomous: true, plan: { id: runId, task: "standby — awaiting inbox tasks", teams: [], created_at: now }, standby: true });
        state.pause = { kind: "none", reason: "standby" };
        const sourceId = `standby:${runId}`;
        const initialDigest = ctoRuntimeRunInitialIdentityDigest(state);
        if (!mintCtoRuntimeRunOrigin(root, state, "cto-bridge", sourceId, initialDigest)) throw runtimeError("runtime_access_invalid", "standby run origin proof could not be committed");
        writeCtoStateLocked(state, root.canonical_root, { pinnedRoot: root, preCommit: () => assertLive() });
        if (!writeCtoRuntimeStateProof(root, state) || !hasValidCtoRuntimeStateProofPinned(root, state)
          || !refreshCtoRunDeliveryIndexAuthorityPinned(root, bridgeDeliveryCapability, "cto-bridge")) throw runtimeError("runtime_access_invalid", "standby delivery authority could not be committed");
        assertLive();
        const finalState = readCtoStatePinned(runId, root);
        if (!finalState || finalState.id !== runId || !hasValidCtoRuntimeStateProofPinned(root, finalState)) throw runtimeError("runtime_access_invalid", "standby state changed during publication");
        return runId;
      } catch (error) {
        for (const path of [join(runDirectory, "state.json"), join(runDirectory, ".runtime-state-proof.json"), join(runDirectory, ".runtime-origin-proof.json")]) {
          try { root.removeEntry(path); } catch { /* rollback is best-effort */ }
        }
        try { root.removeEntry(inboxDirectory); } catch { /* rollback is best-effort */ }
        try { root.removeEntry(runDirectory); } catch { /* rollback is best-effort */ }
        try { if (root.isStable()) refreshCtoRunDeliveryIndexAuthorityPinned(root, bridgeDeliveryCapability, cto-bridge); } catch { /* index recovery remains fail-closed */ }
        throw error;
      }
    }, { pinnedRoot: root });
  };
  const resolveCompletedStatus = (): Readonly<{ runId: string; summary: Readonly<Record<string, unknown>> }> | null => {
    const profile = routeProfile();
    if (!profile) return null;
    assertLive();
    const candidates = readCtoRunDeliveryCompletedCandidatesPinned(root);
    if (!candidates.ok) return null;
    const verified: Array<{ runId: string; summary: Readonly<Record<string, unknown>>; at: number; revision: number }> = [];
    for (const entry of candidates.entries) {
      if (entry.status !== "done" && entry.status !== "failed") continue;
      const at = Date.parse(entry.updated_at);
      if (!Number.isFinite(at) || at > Date.now()) continue;
      const state = readCtoStatePinned(entry.run_id, root) as Readonly<Record<string, unknown>> | null;
      if (!state || state.id !== entry.run_id || state.state_revision !== entry.state_revision || state.updated_at !== entry.updated_at
        || !hasValidCtoRuntimeStateProofPinned(root, state as unknown as CtoState)) continue;
      const pause = state.pause;
      if (!pause || typeof pause !== "object" || Array.isArray(pause) || (pause as Record<string, unknown>).kind !== entry.status) continue;
      const rawWaves = state.wave_history;
      const waves = Array.isArray(rawWaves) ? rawWaves.slice(0, 4096).map((wave) => {
        if (!wave || typeof wave !== "object" || Array.isArray(wave)) return null;
        const item = wave as Record<string, unknown>;
        if (typeof item.id !== "string" || typeof item.status !== "string" || typeof item.started_at !== "string") return null;
        return Object.freeze({ id: item.id, status: item.status, started_at: item.started_at, ...(typeof item.finished_at === "string" ? { finished_at: item.finished_at } : {}), ...(typeof item.outcome === "string" ? { outcome: item.outcome } : {}) });
      }) : [];
      if (waves.some((wave) => wave === null)) continue;
      verified.push({ runId: entry.run_id, at, revision: entry.state_revision, summary: Object.freeze({ status: entry.status, updated_at: entry.updated_at, waves: Object.freeze(waves) }) });
    }
    verified.sort((left, right) => right.at - left.at || right.revision - left.revision || left.runId.localeCompare(right.runId));
    const selected = verified[0];
    if (!selected) return null;
    assertLive();
    return Object.freeze({ runId: selected.runId, summary: selected.summary });
  };
  return Object.freeze({
    assertLive,
    resolveTelegramRoute: route,
    resolveTelegramChannelProfile: routeProfile,
    resolveCompletedStatus,
    ensureStandbyRun,
    readStatus: (runId: string): Readonly<Record<string, unknown>> | null => {
      assertLive();
      if (typeof runId !== "string" || !/^[A-Za-z0-9._-]+$/u.test(runId)) return null;
      const state = readCtoStatePinned(runId, root);
      if (!state || !hasValidCtoRuntimeStateProofPinned(root, state)) return null;
      return Object.freeze({ id: state.id, state_revision: state.state_revision, updated_at: state.updated_at, owner_session: state.owner_session, standby: state.standby === true, channel_profile: state.channel_profile });
    },
    close: (): void => { root.close(); },
  });
}

/** Open a narrow Telegram bridge route capability from an active registry owner. */
export function openCtoRuntimeBridgeRouteAccess(
  registryContext: RegistryRegistrationContext,
  pinnedRoot: PinnedProjectRoot,
): CtoRuntimeBridgeRouteAccess | null {
  if (!pinnedRoot || !pinnedRoot.isStable()) return null;
  let snapshot: RegistryContextSnapshot;
  try { snapshot = requireRegistryContext(registryContext, pinnedRoot.canonical_root, "workflow_tools"); } catch { return null; }
  if (snapshot.canonical_root !== pinnedRoot.canonical_root || snapshot.root_dev !== pinnedRoot.dev || snapshot.root_ino !== pinnedRoot.ino) return null;
  const ownedRoot = PinnedProjectRoot.open(snapshot.canonical_root);
  if (!ownedRoot || ownedRoot.canonical_root !== snapshot.canonical_root || ownedRoot.dev !== pinnedRoot.dev || ownedRoot.ino !== pinnedRoot.ino || !ownedRoot.isStable()) {
    ownedRoot?.close();
    return null;
  }
  return openBridgeRouteFromCell(registryContext, ownedRoot);
}

/**
 * Open one marker-bound, main-session-bound CTO capability. The owner
 * context is the only authorization input; raw claims, marker strings, cwd,
 * and lock handles are intentionally not accepted.
 */
export function openCtoRuntimeAccess(
  registryContext: RegistryRegistrationContext,
  session: CtoRuntimeAccessSession,
  projectRoot: string,
): CtoRuntimeAccessOpenResult {
  if (!isCtoRuntimeSessionAuthority(session)) {
    return openFailure("runtime_access_invalid", "an opaque main-session authority is required");
  }
  if (typeof projectRoot !== "string" || projectRoot.trim().length === 0) return openFailure("runtime_access_invalid", "project root is required");
  let snapshot: RegistryContextSnapshot;
  try {
    snapshot = requireRegistryContext(registryContext, projectRoot, "workflow_tools");
  } catch (error) {
    const code = errorCode(error);
    return openFailure(code === "owner_conflict" ? "owner_conflict" : "activation_revoked", error);
  }
  const root = PinnedProjectRoot.open(snapshot.canonical_root);
  if (!root || root.canonical_root !== snapshot.canonical_root || root.dev !== snapshot.root_dev || root.ino !== snapshot.root_ino || !root.isStable()) {
    root?.close();
    return openFailure("activation_revoked", "project root could not be pinned to the authenticated identity");
  }
  const authority = authenticateCtoRuntimeSessionAuthority(session, registryContext, {
    canonical_root: snapshot.canonical_root,
    dev: snapshot.root_dev,
    ino: snapshot.root_ino,
  });
  if (!authority) {
    root.close();
    return openFailure("runtime_access_invalid", "runtime session authority is forged, stale, or bound to another registry context");
  }
  const cell: RuntimeCell = {
    context: registryContext,
    snapshot,
    root,
    sessionId: authority.sessionId,
    sessionManager: authority.sessionManager,
    ...(authority.sessionFile !== undefined ? { sessionFile: authority.sessionFile } : {}),
    ...(authority.sessionBasename !== undefined ? { sessionBasename: authority.sessionBasename } : {}),
    ...(authority.generation !== undefined ? { sessionGeneration: authority.generation } : {}),
    schedulers: new Set(),
    revoked: false,
    authority: session,
  };
  const access = makeFacade(cell);
  cell.access = access as object;
  const authorityLease = (): void => {
    if (!cell.revoked) revoke(cell);
  };
  if (!attachCtoRuntimeSessionAuthority(session, authorityLease)) {
    root.close();
    return openFailure("runtime_access_invalid", "runtime session facade capacity is exhausted");
  }
  cell.authorityLease = authorityLease;
  const deliveryCapability = Object.freeze({});
  cell.deliveryCapability = deliveryCapability;
  deliveryCapabilities.set(deliveryCapability, cell);
  runtimeCells.set(access as object, cell);
  return { ok: true, access };
}
