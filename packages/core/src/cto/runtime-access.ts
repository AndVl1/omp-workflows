import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  requireRegistryContext,
  type RegistryContextSnapshot,
  type RegistryRegistrationContext,
} from "../registry/owner.js";
import { findActiveCtoRun } from "../commands/cto.js";
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
  newCtoState,
  publishCtoOutboxDelivery,
  readCtoRunDeliveryActiveCandidatesPinned,
  readCtoRunDeliveryCompletedCandidatesPinned,
  readCtoRunDeliveryIndexPage,
  readCtoRunDeliveryCompletedIndexPage,
  readCtoStatePinned,
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
  CtoRunDeliveryCandidatesRead,
  CtoRunDeliveryIndexEntry,
  CtoRunDeliveryIndexPage,
  CtoRunDeliveryStatus,
} from "./state.js";
import { appendWaveUnderLock } from "./waves.js";
import { withCtoRegistryLock, withCtoRunLock, type CtoRunLockHandle } from "./transaction-lock.js";
import { loadEscalationConfigRaw, type EscalationConfigInvalidCode, type EscalationConfigLoadResult, type NormalizedEscalationConfig } from "./channels.js";
import { assessRunHealth } from "./health.js";
import { checkBudget } from "./budget.js";
import { recallDecisions } from "./decisions.js";
import { startWaveScheduler, type CtoSchedulerStateAdapter } from "./scheduler.js";
import { PinnedProjectRoot } from "../specification/pinned-root.js";
import type { CtoState, WaveRecord, ScheduledDigest } from "./types.js";
import {
  authenticateCtoRuntimeSessionAuthority,
  ctoRuntimeSessionAuthorityForContext,
  revokeCtoRuntimeSessionAuthority,
  type CtoRuntimeSessionAuthority,
} from "./session-authority.js";
export { ctoRuntimeSessionAuthorityForContext };

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
    readonly kinds: readonly string[];
    readonly projections: Readonly<Record<string, CtoRuntimeEscalationChannelProjection>>;
  };

export interface CtoRuntimeAccessFacade {
  findActiveRun(): CtoRuntimeActiveRunProjection | null;
  readState(runId: string): Readonly<Record<string, unknown>> | null;
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
  sessionGeneration?: string | number;
  schedulers: Set<() => void>;
  revoked: boolean;
  access?: object;
  deliveryCapability?: object;
  authority: CtoRuntimeSessionAuthority;
};

const runtimeCells = new WeakMap<object, RuntimeCell>();
const deliveryCapabilities = new WeakMap<object, RuntimeCell>();
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
  return typeof value === "object" && value !== null && deliveryCapabilities.has(value);
}

function runtimeCellForFacade(value: unknown): RuntimeCell | null {
  let current = typeof value === "object" && value !== null ? value : null;
  const seen = new Set<object>();
  while (current && !seen.has(current)) {
    seen.add(current);
    const cell = runtimeCells.get(current);
    if (cell) return cell;
    try { current = Object.getPrototypeOf(current) as object | null; } catch { return null; }
  }
  return null;
}

/** Validates a genuine runtime facade or guarded derived wrapper. */
export function assertCtoRuntimeAccessFacadeLive(
  value: unknown,
  expectedRoot?: string,
  expectedSessionId?: string,
): asserts value is CtoRuntimeAccessFacade {
  const cell = runtimeCellForFacade(value);
  if (!cell) throw new CtoRuntimeAccessError("runtime_access_invalid", "CTO runtime access is not an authenticated facade");
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
  if (!authority || authority.sessionId !== cell.sessionId || authority.sessionManager !== cell.sessionManager || authority.generation !== cell.sessionGeneration) {
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
  revokeCtoRuntimeSessionAuthority(cell.authority);
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
  return Object.freeze({ status: "valid", kinds, projections: Object.freeze(projections) });
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
        const found = findActiveCtoRun(cell.root.canonical_root, { sessionId: cell.sessionId, pinnedRoot: cell.root });
        if (!found) return null;
        const state = detachedProjection(found.state) as unknown as Readonly<Record<string, unknown>>;
        return { runId: found.runId, state };
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
          ) throw runtimeError("runtime_access_invalid", "project root does not match the authenticated facade root");
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
        const active = findActiveCtoRun(cell.root.canonical_root, { sessionId: cell.sessionId, pinnedRoot: cell.root });
        if (active) return active.runId;
        try {
          return withCtoRegistryLock(
            cell.root.canonical_root,
            () => {
              requireLive(cell);
              const current = findActiveCtoRun(cell.root.canonical_root, { sessionId: cell.sessionId, pinnedRoot: cell.root });
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
                writeCtoState(state, cell.root.canonical_root, { pinnedRoot: cell.root, preCommit: ({ pinnedRoot }) => {
                  requireLive(cell);
                  if (!pinnedRoot.isStable()) throw runtimeError("activation_revoked", "standby project root changed before state commit");
                } });
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
                  const winner = findActiveCtoRun(cell.root.canonical_root, { sessionId: cell.sessionId, pinnedRoot: cell.root });
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
        if (!ownRecord(options)) throw runtimeError("runtime_access_invalid", "delivery index options must be a plain object");
        const copy: { after_run_id?: string; startAfter?: string; limit?: number } = {};
        if (options.after_run_id !== undefined) {
          if (typeof options.after_run_id !== "string") throw runtimeError("runtime_access_invalid", "delivery cursor is invalid");
          copy.after_run_id = options.after_run_id;
        }
        if (options.startAfter !== undefined) {
          if (typeof options.startAfter !== "string") throw runtimeError("runtime_access_invalid", "delivery cursor is invalid");
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
          let state = readCtoStatePinned(runId, cell.root);
          if (!state) throw runtimeError("runtime_access_invalid", `CTO run '${runId}' is unavailable`);
          const activity = { active: true };
          const transaction: CtoRunTransactionFacade = Object.create(null) as CtoRunTransactionFacade;
          Object.defineProperties(transaction, {
            readState: {
              enumerable: false,
              value: (): CtoState => {
                requireTransactionActive(cell, activity);
                return state!;
              },
            },
            writeState: {
              enumerable: false,
              value: (next: CtoState): string => {
                requireTransactionActive(cell, activity);
                if (!next || typeof next !== "object" || next.id !== runId) throw runtimeError("runtime_access_invalid", "run transaction state identity does not match the bound run");
                const path = writeCtoStateLocked(next, cell.root.canonical_root, {
                  pinnedRoot: cell.root,
                  preCommit: ({ pinnedRoot }) => {
                    requireTransactionActive(cell, activity);
                    if (!pinnedRoot.isStable()) throw runtimeError("activation_revoked", "CTO project root changed before state commit");
                  },
                });
                state = next;
                return path;
              },
            },
            appendWave: {
              enumerable: false,
              value: (options: AppendWaveOptions): CtoState => {
                requireTransactionActive(cell, activity);
                if (!ownRecord(options)) throw runtimeError("runtime_access_invalid", "wave options must be a plain object");
                const next = appendWaveUnderLock(state!, options, handle);
                if (next !== state) {
                  requireTransactionActive(cell, activity);
                  writeCtoStateLocked(next, cell.root.canonical_root, { pinnedRoot: cell.root });
                  state = next;
                }
                return state!;
              },
            },
            findWaveBySourceId: {
              enumerable: false,
              value: (sourceId: string): WaveRecord | null => {
                requireTransactionActive(cell, activity);
                requireSafeRunId(sourceId);
                const matches = (state!.wave_history ?? []).filter((wave) => wave.source_id === sourceId);
                return matches.length === 1 ? matches[0]! : null;
              },
            },
          });
          Object.freeze(transaction);
          try {
            const result = callback(transaction);
            let then: unknown;
            try {
              if (result !== null && (typeof result === "object" || typeof result === "function")) {
                then = (result as { then?: unknown }).then;
              }
            } catch {
              throw runtimeError("runtime_access_invalid", "run transaction result thenable inspection failed");
            }
            if (typeof then === "function") {
              throw runtimeError("cto_runtime_transaction_async_unsupported", "CTO run transactions must complete synchronously");
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
        if (!Number.isFinite(intervalMs) || intervalMs <= 0 || typeof onWave !== "function") throw runtimeError("runtime_access_invalid", "scheduler arguments are invalid");
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

/**
 * Open one owner-authenticated, main-session-bound CTO capability. The owner
 * context is the only authorization input; raw claims, marker strings, cwd,
 * and lock handles are intentionally not accepted.
 */
export function openCtoRuntimeAccess(
  registryContext: RegistryRegistrationContext,
  session: CtoRuntimeAccessSession,
  projectRoot: string,
): CtoRuntimeAccessOpenResult {
  if (!session || typeof session !== "object") {
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
    ...(authority.generation !== undefined ? { sessionGeneration: authority.generation } : {}),
    schedulers: new Set(),
    revoked: false,
    authority: session,
  };
  const access = makeFacade(cell);
  cell.access = access as object;
  const deliveryCapability = Object.freeze({});
  cell.deliveryCapability = deliveryCapability;
  deliveryCapabilities.set(deliveryCapability, cell);
  runtimeCells.set(access as object, cell);
  return { ok: true, access };
}
