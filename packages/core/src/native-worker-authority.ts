import { isAbsolute, resolve } from "node:path";

import { hasStrictOrchestratorState } from "./gates/orchestrator-write.js";
import { assertCtoSliceDispatchable, parseCtoSliceMarker } from "./cto/slice-gate.js";
import { isCtoRunTerminal, readCtoState } from "./cto/state.js";
import { readRunControlNoRecovery, readRunState, reserveExecutionClaimWorkers, settleCtoExecutionClaimWorkersByToolCall, type DispatchOrigin } from "./engine/run-store.js";
type ManagedCtoGrantAuthority = {
  run_id: string;
  token: string;
  ownership_epoch: string;
  coordinator_session_id: string;
  coordinator_process_id?: number;
};
type LegacyCtoGrantAuthority = {
  legacy: true;
  run_id: string;
  coordinator_session_id: string;
  coordinator: SessionSnapshot;
  namespaceKey: string;
  origin: object;
  current: LegacyAuthorityCurrentResolver;
};
type CtoGrantAuthority = ManagedCtoGrantAuthority | LegacyCtoGrantAuthority;
type LegacyAuthorityCurrentResolver = (origin: object, cwd: string, runId: string, sessionId: string) => boolean;
type LegacyAuthorityResolver = (ctx: unknown, cwd: string, runId: string | undefined) => object | undefined;


const REGISTRY_SYMBOL = Symbol.for("omp-workflows.native-worker-authority");
const REGISTRY_VERSION = 3 as const;
const LIFECYCLE_CHANNEL = "task:subagent:lifecycle";

type NativeActor = "worker" | "lead";
type ParentActor = "orchestrator" | "lead";

type EventBusLike = {
  on?: (channel: string, handler: (data: unknown) => void) => (() => void) | void;
};

type SessionHeaderLike = {
  id?: unknown;
  cwd?: unknown;
  parentSession?: unknown;
};

type SessionManagerLike = {
  getCwd?: () => string;
  getSessionId?: () => string;
  getSessionFile?: () => string | undefined;
  getHeader?: () => SessionHeaderLike | undefined;
};

type SessionSnapshot = {
  manager: SessionManagerLike;
  sessionId: string;
  sessionFile: string;
  cwd: string;
  header: SessionHeaderLike;
};
type StartedLifecycle = {
  id: string;
  parentToolCallId: string;
  index: number;
  agent: string;
  sessionFile: string;
};

type TaskItem = {
  agent?: unknown;
  task?: unknown;
  [key: string]: unknown;
};
type Candidate = {
  key: string;
  slotKey: string;
  owner: symbol;
  namespaceKey: string;
  parent: SessionSnapshot;
  parentActor: ParentActor;
  parentToolCallId: string;
  runId: string;
  ctoRunId?: string;
  ctoAuthority?: CtoGrantAuthority;
  ctoWorkerId?: string;
  input: unknown;
  inputShape: string;
  item: TaskItem;
  index: number;
  expectedAgent?: string;
  ctoSlice?: { runId: string; sliceId: string };
  dispatchOrigin?: DispatchOrigin;
  lifecycle?: StartedLifecycle;
  executionShape?: string;
};

type Grant = {
  slotKey: string;
  generation: number;
  owner: symbol;
  namespaceKey: string;
  parent: SessionSnapshot;
  parentActor: ParentActor;
  parentToolCallId: string;
  runId: string;
  ctoRunId?: string;
  ctoAuthority?: CtoGrantAuthority;
  ctoWorkerId?: string;
  index: number;
  agent: string;
  sessionFile: string;
  lifecycleId: string;
  actor: NativeActor;
  ctoSlice?: { runId: string; sliceId: string };
  dispatchOrigin?: DispatchOrigin;
};

/**
 * A revoked grant no longer authorizes new dispatches. This sparse witness
 * retains only the already-started child's limited continuation and the exact
 * terminal lifecycle proof needed to settle its original CTO reservation
 * after a coordinator handover.
 */
type SettlementWitness = {
  slotKey: string;
  owner: symbol;
  namespaceKey: string;
  cwd: string;
  parentSessionFile: string;
  parentToolCallId: string;
  runId: string;
  ctoAuthority: CtoGrantAuthority;
  ctoWorkerId: string;
  index: number;
  lifecycleId: string;
  sessionFile: string;
  childManager?: SessionManagerLike;
  childSessionId?: string;
  actor: NativeActor;
};

type Binding = {
  owner: symbol;
  namespaceKey: string;
  grant: Grant;
  manager: SessionManagerLike;
  sessionId: string;
  sessionFile: string;
  cwd: string;
};

type OwnerState = {
  candidates: Set<Candidate>;
  grants: Set<Grant>;
  bindings: Set<Binding>;
  settlements: Set<SettlementWitness>;
};

type Registry = {
  version: typeof REGISTRY_VERSION;
  owners: Map<symbol, OwnerState>;
  ownerTokens: Map<symbol, string>;
  nextOwnerToken: number;
  candidates: Map<string, Candidate>;
  grants: Map<string, Grant>;
  bindings: Map<string, Binding>;
  settlements: Map<string, SettlementWitness>;
  generations: Map<string, number>;
};

type RegistrySlot = Record<PropertyKey, unknown>;

export type NativeWorkerResolution = {
  actor: NativeActor;
  kind: "workflow" | "cto";
  runId: string;
};

export type NativeWorkerTaskCall = {
  toolName?: string;
  toolCallId?: string;
  input?: unknown;
};

export type NativeWorkerAuthority = {
  observeToolExecutionStart(event: unknown, ctx: unknown): void;
  observeToolExecutionEnd(event: unknown, ctx: unknown): void;
  admitTaskCall(
    ctx: unknown,
    event: NativeWorkerTaskCall,
    actor: ParentActor,
    runId: string | undefined,
    dispatchOrigins?: readonly DispatchOrigin[],
  ): boolean;
  resolve(ctx: unknown, cwd: string, selectedRunId?: string): NativeWorkerResolution | undefined;
  observeSessionStart(ctx: unknown): void;
  observeSessionShutdown(ctx: unknown): void;
  teardown(): void;
};



function registrySlot(): RegistrySlot {
  return globalThis as unknown as RegistrySlot;
}

function isRegistry(value: unknown): value is Registry {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<Registry>;
  return candidate.version === REGISTRY_VERSION
    && candidate.owners instanceof Map
    && candidate.ownerTokens instanceof Map
    && Number.isInteger(candidate.nextOwnerToken)
    && candidate.candidates instanceof Map
    && candidate.grants instanceof Map
    && candidate.bindings instanceof Map
    && candidate.settlements instanceof Map
    && candidate.generations instanceof Map;
}

/**
 * This registry is deliberately process-local. An existing unknown-version
 * value is never replaced: an extension loaded alongside a newer/older core
 * must fail closed rather than silently mixing authority protocols.
 */
function getRegistry(create: boolean): Registry | undefined {
  const slot = registrySlot();
  const current = slot[REGISTRY_SYMBOL];
  if (current !== undefined) return isRegistry(current) ? current : undefined;
  if (!create) return undefined;
  const next: Registry = {
    version: REGISTRY_VERSION,
    owners: new Map(),
    ownerTokens: new Map(),
    nextOwnerToken: 0,
    candidates: new Map(),
    grants: new Map(),
    bindings: new Map(),
    settlements: new Map(),
    generations: new Map(),
  };
  try {
    Object.defineProperty(slot, REGISTRY_SYMBOL, {
      configurable: false,
      enumerable: false,
      value: next,
      writable: false,
    });
  } catch {
    return undefined;
  }
  const installed = slot[REGISTRY_SYMBOL];
  return isRegistry(installed) ? installed : undefined;
}

function ownerState(registry: Registry, owner: symbol): OwnerState {
  const current = registry.owners.get(owner);
  if (current) return current;
  const state: OwnerState = { candidates: new Set(), grants: new Set(), bindings: new Set(), settlements: new Set() };
  registry.owners.set(owner, state);
  return state;
}
function ownerToken(registry: Registry, owner: symbol): string {
  const existing = registry.ownerTokens.get(owner);
  if (existing) return existing;
  registry.nextOwnerToken += 1;
  const token = String(registry.nextOwnerToken);
  registry.ownerTokens.set(owner, token);
  return token;
}

function managerOf(ctx: unknown): SessionManagerLike | undefined {
  if (!ctx || typeof ctx !== "object") return undefined;
  const manager = (ctx as { sessionManager?: unknown }).sessionManager;
  if (!manager || typeof manager !== "object") return undefined;
  const value = manager as SessionManagerLike;
  if (
    typeof value.getCwd !== "function"
    || typeof value.getSessionId !== "function"
    || typeof value.getSessionFile !== "function"
    || typeof value.getHeader !== "function"
  ) return undefined;
  return value;
}

function readSnapshot(ctx: unknown): SessionSnapshot | undefined {
  const manager = managerOf(ctx);
  if (!manager) return undefined;
  try {
    const sessionId = manager.getSessionId!();
    const sessionFile = manager.getSessionFile!();
    const cwd = manager.getCwd!();
    const header = manager.getHeader!();
    if (
      typeof sessionId !== "string" || sessionId.length === 0
      || typeof sessionFile !== "string" || sessionFile.length === 0 || !isAbsolute(sessionFile)
      || typeof cwd !== "string" || cwd.length === 0
      || !header || typeof header !== "object"
      || header.id !== sessionId
      || typeof header.cwd !== "string" || resolve(header.cwd) !== resolve(cwd)
  ) return undefined;
    return { manager, sessionId, sessionFile: resolve(sessionFile), cwd: resolve(cwd), header };
  } catch {
    return undefined;
  }
}

function snapshotStillCurrent(snapshot: SessionSnapshot): boolean {
  try {
    const currentId = snapshot.manager.getSessionId!();
    const currentFile = snapshot.manager.getSessionFile!();
    const currentCwd = snapshot.manager.getCwd!();
    const currentHeader = snapshot.manager.getHeader!();
    return (
      currentId === snapshot.sessionId
      && typeof currentFile === "string"
      && resolve(currentFile) === snapshot.sessionFile
      && typeof currentCwd === "string"
      && resolve(currentCwd) === snapshot.cwd
      && !!currentHeader
      && currentHeader.id === snapshot.sessionId
      && typeof currentHeader.cwd === "string"
      && resolve(currentHeader.cwd) === snapshot.cwd
    );
  } catch {
    return false;
  }
}
function namespaceKey(bundleLabel: string, cwd: string): string {
  return `${bundleLabel}\u0000${resolve(cwd)}`;
}

function sameParentSnapshot(left: SessionSnapshot, right: SessionSnapshot): boolean {
  return left.manager === right.manager
    && left.sessionId === right.sessionId
    && left.sessionFile === right.sessionFile
    && left.cwd === right.cwd;
}

function sameBindingSnapshot(binding: Binding, snapshot: SessionSnapshot): boolean {
  return binding.manager === snapshot.manager
    && binding.sessionId === snapshot.sessionId
    && binding.sessionFile === snapshot.sessionFile
    && binding.cwd === snapshot.cwd;
}

function snapshotMatchesContext(snapshot: SessionSnapshot, ctx: unknown, cwd: string): boolean {
  const current = readSnapshot(ctx);
  return !!current
    && current.manager === snapshot.manager
    && current.sessionId === snapshot.sessionId
    && current.sessionFile === snapshot.sessionFile
    && current.cwd === resolve(cwd)
    && snapshotStillCurrent(snapshot);
}

function samePath(left: string, right: string): boolean {
  return resolve(left) === resolve(right);
}

function structuralShape(value: unknown, stack = new Set<object>()): string | undefined {
  if (value === null) return "null";
  if (typeof value === "string") return `s:${JSON.stringify(value)}`;
  if (typeof value === "boolean") return value ? "b:1" : "b:0";
  if (typeof value === "number") return Number.isFinite(value) ? `n:${String(value)}` : undefined;
  if (typeof value !== "object") return undefined;
  if (stack.has(value)) return undefined;
  stack.add(value);
  let result: string | undefined;
  if (Array.isArray(value)) {
    const entries = value.map((item) => structuralShape(item, stack));
    result = entries.every((item): item is string => item !== undefined) ? `[${entries.join(",")}]` : undefined;
  } else {
    const object = value as Record<string, unknown>;
    const keys = Object.keys(object).sort();
    const entries = keys.map((key) => {
      const item = structuralShape(object[key], stack);
      return item === undefined ? undefined : `${JSON.stringify(key)}:${item}`;
    });
    result = entries.every((item): item is string => item !== undefined) ? `{${entries.join(",")}}` : undefined;
  }
  stack.delete(value);
  return result;
}

function taskItems(input: unknown): TaskItem[] | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  const object = input as Record<string, unknown>;
  if (Array.isArray(object.tasks)) {
    if (object.tasks.length === 0) return undefined;
    const items = object.tasks.map((item) => item && typeof item === "object" && !Array.isArray(item) ? item as TaskItem : undefined);
    return items.every((item): item is TaskItem => !!item && typeof item.task === "string" && item.task.trim().length > 0)
      ? items as TaskItem[]
      : undefined;
  }
  return typeof object.task === "string" && object.task.trim().length > 0 ? [object as TaskItem] : undefined;
}

function ownerFor(registry: Registry, owner: symbol): OwnerState | undefined {
  return registry.owners.get(owner);
}

function removeCandidate(registry: Registry, candidate: Candidate): void {
  registry.candidates.delete(candidate.key);
  ownerFor(registry, candidate.owner)?.candidates.delete(candidate);
}

function removeBinding(registry: Registry, binding: Binding): void {
  const current = registry.bindings.get(binding.sessionFile);
  if (current === binding) registry.bindings.delete(binding.sessionFile);
  ownerFor(registry, binding.owner)?.bindings.delete(binding);
}

function settlementKey(grant: Grant): string {
  return `${grant.slotKey}\u0000${grant.lifecycleId}\u0000${grant.sessionFile}`;
}

function retainSettlementWitness(registry: Registry, grant: Grant): void {
  if (!grant.ctoAuthority || !grant.ctoWorkerId || !grant.lifecycleId) return;
  const bindings = [...registry.bindings.values()].filter((binding) => binding.grant === grant);
  const childBinding = bindings.length === 1 ? bindings[0] : undefined;
  const key = settlementKey(grant);
  const witness: SettlementWitness = {
    slotKey: grant.slotKey,
    owner: grant.owner,
    namespaceKey: grant.namespaceKey,
    cwd: grant.parent.cwd,
    parentSessionFile: grant.parent.sessionFile,
    parentToolCallId: grant.parentToolCallId,
    runId: grant.ctoAuthority.run_id,
    ctoAuthority: grant.ctoAuthority,
    ctoWorkerId: grant.ctoWorkerId,
    index: grant.index,
    lifecycleId: grant.lifecycleId,
    sessionFile: grant.sessionFile,
    ...(childBinding ? { childManager: childBinding.manager, childSessionId: childBinding.sessionId } : {}),
    actor: grant.actor,
  };
  registry.settlements.set(key, witness);
  ownerFor(registry, grant.owner)?.settlements.add(witness);
}

function removeSettlementWitness(registry: Registry, witness: SettlementWitness): void {
  const key = `${witness.slotKey}\u0000${witness.lifecycleId}\u0000${witness.sessionFile}`;
  if (registry.settlements.get(key) === witness) registry.settlements.delete(key);
  ownerFor(registry, witness.owner)?.settlements.delete(witness);
}

function revokeGrant(registry: Registry, grant: Grant, retainSettlement = false): void {
  if (retainSettlement) retainSettlementWitness(registry, grant);
  const current = registry.grants.get(grant.slotKey);
  if (current === grant) registry.grants.delete(grant.slotKey);
  ownerFor(registry, grant.owner)?.grants.delete(grant);
  for (const binding of [...registry.bindings.values()]) {
    if (binding.grant === grant) removeBinding(registry, binding);
  }
}


function expectedAgentMatches(candidate: Candidate, agent: string): boolean {
  return candidate.expectedAgent === undefined || candidate.expectedAgent === agent;
}

function slotKey(parentSessionId: string, toolCallId: string, index: number, token: string): string {
  return `${parentSessionId}\u0000${toolCallId}\u0000${index}\u0000${token}`;
}

function candidateKey(parentSessionId: string, toolCallId: string, token: string): string {
  return `${parentSessionId}\u0000${toolCallId}\u0000${token}`;
}
function ctoWorkerId(toolCallId: string, ownershipEpoch: string, index: number): string {
  return `cto:${ownershipEpoch}:${toolCallId}:${index}`;
}

function lifecyclePayload(value: unknown): StartedLifecycle | undefined {
  if (!value || typeof value !== "object") return undefined;
  const payload = value as Record<string, unknown>;
  if (
    typeof payload.id !== "string" || payload.id.length === 0
    || typeof payload.parentToolCallId !== "string" || payload.parentToolCallId.length === 0
    || typeof payload.index !== "number" || !Number.isInteger(payload.index) || payload.index < 0
    || typeof payload.agent !== "string" || payload.agent.length === 0
    || typeof payload.sessionFile !== "string" || payload.sessionFile.length === 0 || !isAbsolute(payload.sessionFile)
  ) return undefined;
  return {
    id: payload.id,
    parentToolCallId: payload.parentToolCallId,
    index: payload.index,
    agent: payload.agent,
    sessionFile: resolve(payload.sessionFile),
  };
}
function dispatchOriginCurrent(origin: DispatchOrigin, expectedToolCallId?: string): boolean {
  if (!origin || !origin.cwd || !origin.run_id || !origin.dispatch_id) return false;
  const state = readRunState(origin.cwd, origin.run_id);
  if (!state || state.run_id !== origin.run_id || state.run_key !== origin.run_id) return false;
  const capability = state.dispatch_capability;
  if (!capability || capability.status === "invalidated" || capability.status === "complete") return false;
  if (origin.capability_id !== undefined && capability.capability_id !== origin.capability_id) return false;
  const issued = capability.issued_for;
  if (!issued || issued.run_key !== origin.run_id) return false;
  if (origin.stage_id !== undefined && issued.stage_cursor !== origin.stage_id) return false;
  if (origin.cursor_epoch !== undefined && issued.cursor_epoch !== origin.cursor_epoch) return false;
  const dispatches = Array.isArray(capability.dispatches) ? capability.dispatches : [];
  const record = dispatches.find((candidate) => candidate && candidate.id === origin.dispatch_id);
  if (!record || !["authorized", "running", "pending"].includes(record.status)) return false;
  if (expectedToolCallId !== undefined && record.tool_call_id !== expectedToolCallId) return false;
  if (origin.origin_session_id !== undefined && record.origin_session_id !== origin.origin_session_id) return false;
  const identity = record.work_identity;
  if (!identity) return false;
  if (origin.slot_id !== undefined && identity.slot_id !== origin.slot_id) return false;
  if (origin.task_id !== undefined && identity.task_id !== origin.task_id) return false;
  return true;
}

function leadSliceCurrent(grant: Grant): boolean {
  if (!grant.ctoSlice) return false;
  const state = readCtoState(grant.ctoSlice.runId, grant.parent.cwd);
  if (!state) return false;
  return assertCtoSliceDispatchable(state, {
    sliceId: grant.ctoSlice.sliceId,
    root: grant.parent.cwd,
    markerRunId: grant.ctoSlice.runId,
  }).ok;
}

function currentCtoAuthority(
  cwd: string,
  runId: string | undefined,
  coordinator: SessionSnapshot,
  coordinatorNamespace: string,
  legacyOrigin?: object,
  legacyAuthorityCurrent?: LegacyAuthorityCurrentResolver,
): CtoGrantAuthority | undefined {
  const sessionId = coordinator.sessionId;
  if (
    !runId
    || !/^[A-Za-z0-9._-]+$/.test(runId)
    || runId === "."
    || runId === ".."
    || !sessionId
    || coordinator.cwd !== resolve(cwd)
  ) return undefined;
  try {
    const control = readRunControlNoRecovery(cwd);
    const claim = control.execution_claim;
    if (
      claim
      && claim.owner_kind === "cto"
      && claim.run_id === runId
      && claim.released_at === null
      && claim.coordinator_session_id === sessionId
    ) {
      return {
        run_id: claim.run_id,
        token: claim.token,
        ownership_epoch: claim.ownership_epoch,
        coordinator_session_id: claim.coordinator_session_id,
        ...(claim.coordinator_process_id === undefined ? {} : { coordinator_process_id: claim.coordinator_process_id }),
      };
    }
    if (
      !legacyOrigin
      || !legacyAuthorityCurrent
      || claim !== null
      || Object.prototype.hasOwnProperty.call(control.cto_releases, runId)
      || !snapshotStillCurrent(coordinator)
    ) return undefined;
    const state = readCtoState(runId, cwd);
    if (!state || state.id !== runId || isCtoRunTerminal(state) || state.owner_session !== sessionId) return undefined;
    return {
      legacy: true,
      run_id: runId,
      coordinator_session_id: sessionId,
      coordinator,
      namespaceKey: coordinatorNamespace,
      origin: legacyOrigin,
      current: legacyAuthorityCurrent,
    };
  } catch {
    return undefined;
  }
}

function ctoAuthorityCurrent(
  grant: Grant,
  allowHistorical: boolean,
): boolean {
  const authority = grant.ctoAuthority;
  if (!authority) return false;
  const legacyCoordinator = "legacy" in authority ? authority.coordinator : undefined;
  const authorityCwd = legacyCoordinator?.cwd ?? grant.parent.cwd;
  let control;
  try {
    control = readRunControlNoRecovery(authorityCwd);
  } catch {
    return false;
  }
  if ("legacy" in authority) {
    let originCurrent = false;
    try {
      originCurrent = !!authority.origin
        && snapshotStillCurrent(authority.coordinator)
        && authority.coordinator.sessionId === authority.coordinator_session_id
        && authority.coordinator.cwd === grant.parent.cwd
        && authority.namespaceKey === grant.namespaceKey
        && authority.current(authority.origin, authority.coordinator.cwd, authority.run_id, authority.coordinator_session_id);
    } catch {
      originCurrent = false;
    }
    if (
      !originCurrent
      || control.execution_claim !== null
      || Object.prototype.hasOwnProperty.call(control.cto_releases, authority.run_id)
    ) return false;
    const state = readCtoState(authority.run_id, authorityCwd);
    return !!state
      && state.id === authority.run_id
      && !isCtoRunTerminal(state)
      && state.owner_session === authority.coordinator_session_id;
  }
  const claim = control.execution_claim;
  if (
    claim
    && claim.owner_kind === "cto"
    && claim.run_id === authority.run_id
    && claim.token === authority.token
    && claim.ownership_epoch === authority.ownership_epoch
    && claim.coordinator_session_id === authority.coordinator_session_id
    && (claim.coordinator_process_id ?? undefined) === (authority.coordinator_process_id ?? undefined)
    && claim.released_at === null
  ) return true;
  if (!allowHistorical || !grant.ctoWorkerId || !claim || claim.owner_kind !== "cto" || claim.run_id !== authority.run_id) return false;
  const release = control.cto_releases[authority.run_id];
  if (
    !release
    || release.issuance_token !== authority.token
    || claim.release_receipt !== release.release_receipt
    || !claim.worker_ids.includes(grant.ctoWorkerId)
    || !release.pending_worker_ids.includes(grant.ctoWorkerId)
  ) return false;
  return true;
}

function grantCanonicalCurrent(grant: Grant): boolean {
  if (grant.dispatchOrigin && !dispatchOriginCurrent(grant.dispatchOrigin, grant.parentToolCallId)) return false;
  if (grant.ctoAuthority) return ctoAuthorityCurrent(grant, true) && (!grant.ctoSlice || leadSliceCurrent(grant));
  if (grant.ctoSlice || grant.ctoRunId) return false;
  return hasStrictOrchestratorState(grant.parent.cwd, grant.runId);
}


function lifecycleTerminal(value: unknown): {
  id: string;
  parentToolCallId: string;
  index: number;
  sessionFile: string;
} | undefined {
  if (!value || typeof value !== "object") return undefined;
  const payload = value as Record<string, unknown>;
  if (
    typeof payload.id !== "string" || payload.id.length === 0
    || typeof payload.parentToolCallId !== "string" || payload.parentToolCallId.length === 0
    || typeof payload.index !== "number" || !Number.isInteger(payload.index) || payload.index < 0
    || typeof payload.sessionFile !== "string" || payload.sessionFile.length === 0 || !isAbsolute(payload.sessionFile)
  ) return undefined;
  return {
    id: payload.id,
    parentToolCallId: payload.parentToolCallId,
    index: payload.index,
    sessionFile: resolve(payload.sessionFile),
  };
}

export type NativeWorkerAuthorityOptions = {
  bundleLabel?: string;
  legacyAuthority?: LegacyAuthorityResolver;
  legacyAuthorityCurrent?: LegacyAuthorityCurrentResolver;
};

export function createNativeWorkerAuthority(
  events?: EventBusLike,
  options: NativeWorkerAuthorityOptions = {},
): NativeWorkerAuthority {
  const bundleLabel = typeof options.bundleLabel === "string" && options.bundleLabel.length > 0
    ? options.bundleLabel
    : "omp-workflows";
  const registry = getRegistry(true);
  const legacyAuthorityCurrent = options.legacyAuthorityCurrent;
  const legacyAuthority = options.legacyAuthority;
  const owner = Symbol("native-worker-authority-owner");
  if (registry) ownerState(registry, owner);
  const token = registry ? ownerToken(registry, owner) : "0";

  const promote = (candidate: Candidate): void => {
    if (!registry || !candidate.lifecycle || !candidate.executionShape) return;
    if (!expectedAgentMatches(candidate, candidate.lifecycle.agent)) {
      removeCandidate(registry, candidate);
      return;
    }
    const prior = registry.grants.get(candidate.slotKey);
    if (prior) revokeGrant(registry, prior);
    const generation = (registry.generations.get(candidate.slotKey) ?? 0) + 1;
    registry.generations.set(candidate.slotKey, generation);
    const leadAgent = candidate.expectedAgent === "team-lead" || candidate.expectedAgent === "omp-team-lead";
    const actor: NativeActor = leadAgent && candidate.ctoSlice ? "lead" : "worker";
    const grant: Grant = {
      slotKey: candidate.slotKey,
      generation,
      owner: candidate.owner,
      namespaceKey: candidate.namespaceKey,
      parent: candidate.parent,
      parentActor: candidate.parentActor,
      parentToolCallId: candidate.parentToolCallId,
      runId: candidate.runId,
      ...(candidate.ctoRunId ? { ctoRunId: candidate.ctoRunId } : {}),
      ...(candidate.ctoAuthority ? {
        ctoAuthority: candidate.ctoAuthority,
        ...(candidate.ctoWorkerId ? { ctoWorkerId: candidate.ctoWorkerId } : {}),
      } : {}),
      index: candidate.index,
      agent: candidate.lifecycle.agent,
      sessionFile: candidate.lifecycle.sessionFile,
      lifecycleId: candidate.lifecycle.id,
      actor,
      ...(candidate.ctoSlice ? { ctoSlice: candidate.ctoSlice } : {}),
      ...(candidate.dispatchOrigin ? { dispatchOrigin: candidate.dispatchOrigin } : {}),
    };
    registry.grants.set(grant.slotKey, grant);
    ownerFor(registry, grant.owner)?.grants.add(grant);
    removeCandidate(registry, candidate);
  };

  const handleExecutionStart = (value: unknown, ctx: unknown): void => {
    if (!registry || !value || typeof value !== "object") return;
    const parent = readSnapshot(ctx);
    if (!parent) return;
    const event = value as Record<string, unknown>;
    if (event.toolName !== "task" || typeof event.toolCallId !== "string" || event.toolCallId.length === 0) return;
    const candidates = [...registry.candidates.values()].filter((candidate) =>
      candidate.owner === owner
      && candidate.parentToolCallId === event.toolCallId
      && sameParentSnapshot(candidate.parent, parent)
      && candidate.namespaceKey === namespaceKey(bundleLabel, parent.cwd)
      && snapshotMatchesContext(candidate.parent, ctx, parent.cwd)
    );
    if (candidates.length === 0) return;
    const shape = structuralShape(event.args);
    if (!shape || candidates.some((candidate) => candidate.inputShape !== shape)) {
      for (const candidate of candidates) removeCandidate(registry, candidate);
      return;
    }
    for (const candidate of candidates) {
      candidate.executionShape = shape;
      promote(candidate);
    }
  };

  const handleLifecycle = (value: unknown): void => {
    if (!registry || !value || typeof value !== "object") return;
    const payload = value as Record<string, unknown>;
    const status = payload.status;
    if (status === "started") {
      const lifecycle = lifecyclePayload(value);
      if (!lifecycle) return;
      const candidates = [...registry.candidates.values()].filter((candidate) => {
        if (candidate.owner !== owner) return false;
        if (candidate.parentToolCallId !== lifecycle.parentToolCallId || candidate.index !== lifecycle.index) return false;
        return expectedAgentMatches(candidate, lifecycle.agent);
      });
      if (candidates.length !== 1) return;
      const candidate = candidates[0]!;
      candidate.lifecycle = lifecycle;
      promote(candidate);
      return;
    }
    if (status !== "completed" && status !== "failed" && status !== "aborted") return;
    const terminal = lifecycleTerminal(value);
    if (!terminal) return;
    const grants = [...registry.grants.values()].filter((grant) =>
      grant.owner === owner
      && grant.lifecycleId === terminal.id
      && grant.parentToolCallId === terminal.parentToolCallId
      && grant.index === terminal.index
      && grant.sessionFile === terminal.sessionFile
    );
    const witnesses = [...registry.settlements.values()].filter((witness) =>
      witness.owner === owner
      && witness.lifecycleId === terminal.id
      && witness.parentToolCallId === terminal.parentToolCallId
      && witness.index === terminal.index
      && witness.sessionFile === terminal.sessionFile
    );
    if (grants.length + witnesses.length !== 1) return;
    const grant = grants[0];
    const witness = witnesses[0];
    const authority = grant?.ctoAuthority ?? witness?.ctoAuthority;
    const workerId = grant?.ctoWorkerId ?? witness?.ctoWorkerId;
    if (authority && workerId && !("legacy" in authority)) {
      try {
        settleCtoExecutionClaimWorkersByToolCall(grant?.parent.cwd ?? witness!.cwd, {
          run_id: authority.run_id,
          tool_call_id: grant?.parentToolCallId ?? witness!.parentToolCallId,
          token: authority.token,
          ownership_epoch: authority.ownership_epoch,
          worker_ids: [workerId],
        });
      } catch {
        return;
      }
    }
    if (grant) revokeGrant(registry, grant);
    if (witness) removeSettlementWitness(registry, witness);
    for (const candidate of [...registry.candidates.values()]) {
      if (
        candidate.owner === owner
        && candidate.lifecycle?.id === terminal.id
        && candidate.parentToolCallId === terminal.parentToolCallId
        && candidate.index === terminal.index
        && candidate.lifecycle.sessionFile === terminal.sessionFile
      ) removeCandidate(registry, candidate);
    }
  };

  events?.on?.(LIFECYCLE_CHANNEL, handleLifecycle);

  const handleExecutionEnd = (value: unknown, ctx: unknown): void => {
    if (!registry || !value || typeof value !== "object") return;
    const parent = readSnapshot(ctx);
    if (!parent) return;
    const event = value as Record<string, unknown>;
    if (event.toolName !== "task" || typeof event.toolCallId !== "string" || event.toolCallId.length === 0) return;
    const result = event.result && typeof event.result === "object" ? event.result as Record<string, unknown> : undefined;
    const details = result?.details && typeof result.details === "object" ? result.details as Record<string, unknown> : undefined;
    const state = typeof details?.state === "string" ? details.state : typeof result?.state === "string" ? result.state : undefined;
    const failed = event.isError === true || state === "failed" || state === "aborted" || state === "cancelled";
    if (!failed) return;
    for (const candidate of [...registry.candidates.values()]) {
      if (
        candidate.owner === owner
        && candidate.parentToolCallId === event.toolCallId
        && sameParentSnapshot(candidate.parent, parent)
        && candidate.namespaceKey === namespaceKey(bundleLabel, parent.cwd)
      ) removeCandidate(registry, candidate);
    }
  };
  const authority: NativeWorkerAuthority = {
    observeToolExecutionStart: handleExecutionStart,
    observeToolExecutionEnd: handleExecutionEnd,
    admitTaskCall(ctx, event, actor, runId, dispatchOrigins) {
      if (!registry || event.toolName !== "task" || !event.toolCallId || (actor !== "orchestrator" && actor !== "lead")) return false;
      ownerState(registry, owner);
      const inputShape = structuralShape(event.input);
      const items = taskItems(event.input);
      const parent = readSnapshot(ctx);
      if (!inputShape || !items || !parent) return false;
      const leadMarkers = items.map((item) => parseCtoSliceMarker(typeof item.task === "string" ? item.task : ""));
      const allLeadItems = actor === "orchestrator" && items.every((item, index) => {
        const agent = typeof item.agent === "string" ? item.agent : "";
        const marker = leadMarkers[index];
        return (agent === "team-lead" || agent === "omp-team-lead") && !!marker;
      });
      const leadItemsHaveMarkers = items.every((item, index) => {
        const agent = typeof item.agent === "string" ? item.agent : "";
        return (agent !== "team-lead" && agent !== "omp-team-lead") || !!leadMarkers[index];
      });
      if (!leadItemsHaveMarkers || runId && (!/^[A-Za-z0-9._-]+$/.test(runId) || runId === "." || runId === "..")) return false;
      if (!runId && !allLeadItems) return false;
      const markerRunIds = leadMarkers.filter((marker): marker is { runId: string; sliceId: string } => !!marker).map((marker) => marker.runId);
      const authorityRunId = runId ?? markerRunIds[0];
      let parentBinding: Binding | undefined;
      if (actor === "lead") {
        // A lead runs in its own session, so coordinator-session lookup cannot
        // authenticate this call. Inherit only the original grant's live
        // authority after checking its manager/session binding and current
        // token/epoch; historical worker completion is intentionally not
        // sufficient to arm a new nested dispatch.
        parentBinding = registry.bindings.get(parent.sessionFile);
        const parentGrant = parentBinding?.grant;
        if (
          !parentBinding
          || !parentGrant
          || parentBinding.namespaceKey !== namespaceKey(bundleLabel, parent.cwd)
          || parentBinding.manager !== parent.manager
          || registry.grants.get(parentGrant.slotKey) !== parentGrant
          || parentGrant.actor !== "lead"
          || !snapshotStillCurrent(parentGrant.parent)
          || !grantCanonicalCurrent(parentGrant)
          || !parentGrant.ctoAuthority
          || !ctoAuthorityCurrent(parentGrant, false)
          || !parentGrant.ctoSlice
        ) return false;
        const everyMarkerMatches = items.every((item) => {
          const text = typeof item.task === "string" ? item.task : "";
          const marker = parseCtoSliceMarker(text);
          return !!marker
            && marker.runId === parentBinding!.grant.ctoSlice!.runId
            && marker.sliceId === parentBinding!.grant.ctoSlice!.sliceId;
        });
        if (!everyMarkerMatches) return false;
      }
      const inheritedCtoSlice = actor === "lead" ? parentBinding?.grant.ctoSlice : undefined;
      const inheritedCtoAuthority = actor === "lead" ? parentBinding?.grant.ctoAuthority : undefined;
      // Coordinator admission is authenticated by the current claim session;
      // lead admission above is authenticated by the inherited live grant.
      let legacyOrigin: object | undefined;
      if (actor === "orchestrator" && legacyAuthority) {
        try {
          legacyOrigin = legacyAuthority(ctx, parent.cwd, authorityRunId);
        } catch {
          legacyOrigin = undefined;
        }
      }
      const parentCtoAuthority = actor === "orchestrator"
        ? currentCtoAuthority(
          parent.cwd,
          authorityRunId,
          parent,
          namespaceKey(bundleLabel, parent.cwd),
          legacyOrigin,
          legacyAuthorityCurrent,
        )
        : undefined;
      const ctoAuthority = inheritedCtoAuthority ?? parentCtoAuthority;
      const requestedCtoState = runId ? readCtoState(runId, parent.cwd) : undefined;
      if (
        markerRunIds.length > 0
        && (!ctoAuthority || markerRunIds.some((markerRunId) => markerRunId !== ctoAuthority.run_id))
      ) return false;
      if (requestedCtoState && (!ctoAuthority || ctoAuthority.run_id !== runId)) return false;
      if (allLeadItems && (!ctoAuthority || ctoAuthority.run_id !== authorityRunId)) return false;
      if (ctoAuthority && !("legacy" in ctoAuthority)) {
        try {
          reserveExecutionClaimWorkers(parent.cwd, {
            run_id: ctoAuthority.run_id,
            token: ctoAuthority.token,
            worker_ids: items.map((_item, index) => ctoWorkerId(event.toolCallId!, ctoAuthority.ownership_epoch, index)),
          });
        } catch {
          return false;
        }
      }
      for (const candidate of [...registry.candidates.values()]) {
        if (candidate.owner === owner && sameParentSnapshot(candidate.parent, parent) && candidate.parentToolCallId === event.toolCallId) {
          removeCandidate(registry, candidate);
        }
      }
      items.forEach((item, index) => {
        const expectedAgent = typeof item.agent === "string" && item.agent.length > 0 ? item.agent : undefined;
        const text = typeof item.task === "string" ? item.task : "";
        const marker = parseCtoSliceMarker(text);
        const leadCandidate = actor === "orchestrator"
          && !!marker
          && (expectedAgent === "team-lead" || expectedAgent === "omp-team-lead");
        const candidateRunId = ctoAuthority?.run_id
          ?? inheritedCtoSlice?.runId
          ?? (leadCandidate ? marker!.runId : runId);
        const dispatchOrigin = dispatchOrigins?.[index];
        const workerId = ctoAuthority && !("legacy" in ctoAuthority)
          ? ctoWorkerId(event.toolCallId!, ctoAuthority.ownership_epoch, index)
          : undefined;
        const candidate: Candidate = {
          key: `${candidateKey(parent.sessionId, event.toolCallId!, token)}\u0000${index}`,
          slotKey: slotKey(parent.sessionId, event.toolCallId!, index, token),
          owner,
          namespaceKey: namespaceKey(bundleLabel, parent.cwd),
          parent,
          parentActor: actor,
          parentToolCallId: event.toolCallId!,
          runId: candidateRunId!,
          ...(ctoAuthority ? {
            ctoRunId: ctoAuthority.run_id,
            ctoAuthority,
            ...(workerId ? { ctoWorkerId: workerId } : {}),
          } : {}),
          input: event.input,
          inputShape,
          item,
          index,
          ...(expectedAgent ? { expectedAgent } : {}),
          ...(inheritedCtoSlice ? { ctoSlice: inheritedCtoSlice } : leadCandidate ? { ctoSlice: marker! } : {}),
          ...(dispatchOrigin && samePath(dispatchOrigin.cwd, parent.cwd) ? { dispatchOrigin } : {}),
        };
        registry.candidates.set(candidate.key, candidate);
        ownerFor(registry, owner)?.candidates.add(candidate);
      });
      return true;
    },

    resolve(ctx, cwd, selectedRunId) {
      if (!registry) return undefined;
      ownerState(registry, owner);
      const current = readSnapshot(ctx);
      if (!current || current.cwd !== resolve(cwd)) return undefined;
      const currentNamespace = namespaceKey(bundleLabel, current.cwd);
      let binding = registry.bindings.get(current.sessionFile);

      if (binding && binding.namespaceKey !== currentNamespace) return undefined;
      let grant = binding?.grant;
      if (!binding) {
        const candidates = [...registry.grants.values()]
          .filter((candidate) => candidate.sessionFile === current.sessionFile && candidate.namespaceKey === currentNamespace)
          .sort((left, right) => right.generation - left.generation);
        grant = candidates[0];
        if (!grant) {
          const witnesses = [...registry.settlements.values()].filter((witness) =>
            witness.sessionFile === current.sessionFile && witness.namespaceKey === currentNamespace,
          );
          if (witnesses.length !== 1) return undefined;
          const witness = witnesses[0]!;
          if (
            !snapshotStillCurrent(current)
            || (selectedRunId !== undefined && selectedRunId !== witness.runId)
            || (current.header.parentSession !== undefined && current.header.parentSession !== witness.parentSessionFile)
            || witness.lifecycleId === current.sessionId
            || !witness.childManager
            || witness.childManager !== current.manager
            || witness.childSessionId !== current.sessionId
          ) return undefined;
          // A settlement witness grants only the already-started child's
          // continuation. It never recreates a binding or nested dispatch
          // authority for the revoked parent/lead.
          return { actor: witness.actor, kind: "cto", runId: witness.runId };
        }
        if (
          (current.header.parentSession !== undefined && current.header.parentSession !== grant.parent.sessionFile)
          || grant.lifecycleId === current.sessionId
        ) {
          // A foreign/forked context must not be able to revoke the
          // still-active grant owned by the real child session.
          return undefined;
        }
        binding = {
          owner,
          namespaceKey: currentNamespace,
          grant,
          manager: current.manager,
          sessionId: current.sessionId,
          sessionFile: current.sessionFile,
          cwd: current.cwd,
        };
        registry.bindings.set(binding.sessionFile, binding);
        ownerFor(registry, owner)?.bindings.add(binding);
      }
      if (
        binding.manager !== current.manager
        || binding.sessionId !== current.sessionId
        || binding.cwd !== current.cwd
      ) return undefined;
      grant = registry.grants.get(binding.grant.slotKey);
      if (!grant || grant !== binding.grant || grant.generation !== binding.grant.generation) {
        removeBinding(registry, binding);
        return undefined;
      }
      if (
        !snapshotStillCurrent(current)
        || !snapshotStillCurrent(grant.parent)
        || !grant.runId
        || !grantCanonicalCurrent(grant)
        || (selectedRunId !== undefined && selectedRunId !== grant.runId)
        || (current.header.parentSession !== undefined && current.header.parentSession !== grant.parent.sessionFile)
        || grant.lifecycleId === current.sessionId
      ) {
        // A stale wave/claim revokes dispatch authority but preserves the
        // exact started child settlement witness for its terminal event.
        revokeGrant(registry, grant, true);
        return undefined;
      }
      return {
        actor: grant.actor,
        kind: grant.ctoAuthority || grant.ctoSlice || grant.ctoRunId ? "cto" : "workflow",
        runId: grant.ctoAuthority?.run_id ?? grant.ctoSlice?.runId ?? grant.ctoRunId ?? grant.runId,
      };
    },

    observeSessionStart(ctx) {
      if (!registry) return;
      ownerState(registry, owner);
      const current = readSnapshot(ctx);
      if (!current) return;
      const value = ctx as { mode?: unknown; hasUI?: unknown };
      const headless = value.mode === "print" || value.mode === "json" || (value.mode !== "tui" && value.mode !== "rpc" && value.hasUI === false);
      const replacedOrHeadless = (parent: SessionSnapshot): boolean =>
        parent.manager === current.manager
        && (parent.sessionId !== current.sessionId
          || parent.sessionFile !== current.sessionFile
          || parent.cwd !== current.cwd
          || headless);
      for (const grant of [...registry.grants.values()]) {
        if (grant.owner === owner && replacedOrHeadless(grant.parent)) revokeGrant(registry, grant, true);
      }
      for (const candidate of [...registry.candidates.values()]) {
        if (candidate.owner === owner && replacedOrHeadless(candidate.parent)) removeCandidate(registry, candidate);
      }
    },

    observeSessionShutdown(ctx) {
      const current = getRegistry(false);
      if (!current) return;
      const snapshot = readSnapshot(ctx);
      if (!snapshot) return;
      const state = current.owners.get(owner);
      if (!state) return;
      for (const grant of [...state.grants]) {
        if (sameParentSnapshot(grant.parent, snapshot)) revokeGrant(current, grant, true);
      }
      for (const candidate of [...state.candidates]) {
        if (sameParentSnapshot(candidate.parent, snapshot)) removeCandidate(current, candidate);
      }
      for (const binding of [...state.bindings]) {
        if (!sameBindingSnapshot(binding, snapshot)) continue;
        if (current.grants.get(binding.grant.slotKey) === binding.grant) revokeGrant(current, binding.grant, true);
        else removeBinding(current, binding);
      }

    },
    teardown() {
      const current = getRegistry(false);
      if (!current) return;
      const state = current.owners.get(owner);
      if (!state) return;
      for (const candidate of [...state.candidates]) removeCandidate(current, candidate);
      for (const binding of [...state.bindings]) removeBinding(current, binding);
      for (const grant of [...state.grants]) revokeGrant(current, grant);
      for (const witness of [...state.settlements]) removeSettlementWitness(current, witness);
      current.owners.delete(owner);
    },
  };

  return authority;
}
