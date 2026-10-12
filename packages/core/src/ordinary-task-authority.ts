import { isAbsolute, resolve } from "node:path";

import { readSnapshot, snapshotStillCurrent, structuralShape, taskItems } from "./native-worker-authority.js";
import type { SessionSnapshot } from "./native-worker-authority.js";
import type { AdmissionDiagnosticCode } from "./actor-admission-diagnostics.js";

const REGISTRY_SYMBOL = Symbol.for("omp-workflows.ordinary-task-authority");
const REGISTRY_VERSION = 2;
const IDENTITY_DENIED: AdmissionDiagnosticCode = "session_identity_mismatch";

type EventBus = {
  on?: (channel: string, handler: (payload: unknown) => void) => unknown;
};
type TaskCall = { toolName?: string; toolCallId?: string; input?: unknown };
type Root = {
  snapshot: SessionSnapshot;
  readCurrent: () => true | AdmissionDiagnosticCode;
  active: boolean;
  denial?: AdmissionDiagnosticCode;
};
type Lifecycle = {
  id: string;
  parentToolCallId: string;
  index: number;
  agent: string;
  sessionFile?: string;
};
type Started = Lifecycle & { sessionFile: string };
type Slot = {
  agent?: string;
  started?: Started;
  acknowledgement?: { id: string; agent: string };
  grant?: Grant;
  rejected: boolean;
};
type Call = {
  owner: symbol;
  label: string;
  calls: Map<string, Call>;
  closedIds: Set<string>;
  parent: SessionSnapshot;
  parentGrant?: Grant;
  root: Root;
  toolCallId: string;
  shape: string;
  executing: boolean;
  ended: boolean;
  slots: Slot[];
};
type Grant = {
  call: Call;
  slot: Slot;
  lifecycle: Started;
  active: boolean;
  child?: SessionSnapshot;
  dependents?: Set<Grant>;
};
type Registry = {
  version: number;
  sessions: Map<string, Grant>;
  deniedFiles: Map<string, AdmissionDiagnosticCode>;
  bindings: WeakMap<object, Grant | AdmissionDiagnosticCode>;
};

/** Internal provenance only; never an actor, claim, or workflow credential. */
export type OrdinaryTaskAuthority = {
  resolve(ctx: unknown, cwd: string): SessionSnapshot | AdmissionDiagnosticCode | "unknown";
  admitTaskCall(ctx: unknown, event: TaskCall, readRootCurrent?: () => true | AdmissionDiagnosticCode): true | AdmissionDiagnosticCode;
  observeSessionStart(ctx: unknown): void;
  observeToolExecutionStart(event: unknown, ctx: unknown): void;
  observeToolExecutionEnd(event: unknown, ctx: unknown): void;
  observeSessionSwitch(ctx: unknown): void;
  observeSessionShutdown(ctx: unknown): void;
};

function registry(): Registry | undefined {
  // Shared only between the actual same-process SDK extension instances.
  const globals = globalThis as unknown as Record<PropertyKey, unknown>;
  const current = globals[REGISTRY_SYMBOL];
  if (current !== undefined) {
    if (!current || typeof current !== "object") return undefined;
    const value = current as Partial<Registry>;
    return value.version === REGISTRY_VERSION && value.sessions instanceof Map
      && value.deniedFiles instanceof Map && value.bindings instanceof WeakMap
      ? value as Registry : undefined;
  }
  const value: Registry = {
    version: REGISTRY_VERSION, sessions: new Map(), deniedFiles: new Map(), bindings: new WeakMap(),
  };
  try {
    Object.defineProperty(globals, REGISTRY_SYMBOL, { value, enumerable: false, writable: false, configurable: false });
    return value;
  } catch {
    return undefined;
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function managerOf(ctx: unknown): object | undefined {
  if (!record(ctx)) return undefined;
  const manager = ctx.sessionManager;
  return record(manager) ? manager : undefined;
}
function lifecycleOf(value: Record<string, unknown>): Lifecycle | undefined {
  if (typeof value.id !== "string" || !value.id
    || typeof value.parentToolCallId !== "string" || !value.parentToolCallId
    || typeof value.agent !== "string" || !value.agent
    || typeof value.index !== "number" || !Number.isSafeInteger(value.index) || value.index < 0
    || (value.sessionFile !== undefined && (typeof value.sessionFile !== "string" || !isAbsolute(value.sessionFile)))) return undefined;
  return { id: value.id, parentToolCallId: value.parentToolCallId, agent: value.agent,
    index: value.index, ...(typeof value.sessionFile === "string" ? { sessionFile: resolve(value.sessionFile) } : {}) };
}
function callKey(parent: SessionSnapshot, toolCallId: string): string {
  return `${parent.sessionFile}\u0000${parent.sessionId}\u0000${toolCallId}`;
}
function sameSnapshot(left: SessionSnapshot, right: SessionSnapshot): boolean {
  return left.manager === right.manager && left.sessionId === right.sessionId
    && left.sessionFile === right.sessionFile && left.cwd === right.cwd;
}
function rootCurrent(root: Root): boolean {
  if (!root.active) return false;
  try {
    const decision = snapshotStillCurrent(root.snapshot) ? root.readCurrent() : IDENTITY_DENIED;
    if (decision === true) return true;
    root.denial = decision;
  } catch {
    root.denial = "session_controller_resolution_failed";
  }
  root.active = false;
  return false;
}
function forgetCall(call: Call): void {
  call.calls.delete(callKey(call.parent, call.toolCallId));
  call.closedIds.add(call.toolCallId);
}
function retire(shared: Registry, grant: Grant, reason: AdmissionDiagnosticCode): void {
  grant.active = false;
  shared.deniedFiles.set(grant.lifecycle.sessionFile, reason);
  if (shared.sessions.get(grant.lifecycle.sessionFile) === grant) shared.sessions.delete(grant.lifecycle.sessionFile);
  if (grant.child) shared.bindings.set(grant.child.manager, reason);
  grant.slot.rejected = true;
  grant.slot.grant = undefined;
  grant.call.parentGrant?.dependents?.delete(grant);
  if (grant.dependents) {
    for (const dependent of grant.dependents) retire(shared, dependent, reason);
    grant.dependents.clear();
    grant.dependents = undefined;
  }
  if (grant.call.slots.every((slot) => slot.rejected)) forgetCall(grant.call);
}
function reject(shared: Registry, call: Call, reason: AdmissionDiagnosticCode = IDENTITY_DENIED): void {
  for (const slot of call.slots) {
    slot.rejected = true;
    if (slot.grant) retire(shared, slot.grant, reason);
  }
  forgetCall(call);
}
function grantCurrent(shared: Registry, grant: Grant): boolean {
  const root = grant.call.root;
  if (!rootCurrent(root)) {
    retire(shared, grant, root.denial ?? IDENTITY_DENIED);
    return false;
  }
  for (let current: Grant | undefined = grant; current; current = current.call.parentGrant) {
    if (!current.active || current.call.root !== root || !snapshotStillCurrent(current.call.parent)
      || (current.child && !snapshotStillCurrent(current.child))) {
      retire(shared, current, IDENTITY_DENIED);
      retire(shared, grant, IDENTITY_DENIED);
      return false;
    }
  }
  return true;
}

/** An async task ACK is not terminal: queued children can start after the tool returns. */
function acknowledgePending(shared: Registry, call: Call, result: unknown): void {
  const details = record(result) && record(result.details) ? result.details : undefined;
  const async = details && record(details.async) ? details.async : undefined;
  const progress = details && Array.isArray(details.progress) ? details.progress : undefined;
  if (!async || async.type !== "task" || async.state !== "running"
    || typeof async.jobId !== "string" || !async.jobId || !progress) return;
  const ids = new Set<string>();
  const indexes = new Set<number>();
  for (const value of progress) {
    if (!record(value) || typeof value.id !== "string" || !value.id
      || typeof value.index !== "number" || !Number.isSafeInteger(value.index)
      || value.index < 0 || typeof value.agent !== "string" || !value.agent) continue;
    if (ids.has(value.id) || indexes.has(value.index)) {
      reject(shared, call);
      return;
    }
    ids.add(value.id);
    indexes.add(value.index);
  }
  for (const value of progress) {
    if (!record(value) || typeof value.id !== "string" || !value.id
      || typeof value.index !== "number" || !Number.isSafeInteger(value.index)
      || value.index < 0 || typeof value.agent !== "string" || !value.agent) continue;
    const slot = call.slots[value.index];
    if (!slot) continue;
    if (slot.grant && (slot.grant.lifecycle.id !== value.id || slot.grant.lifecycle.agent !== value.agent)) {
      retire(shared, slot.grant, IDENTITY_DENIED);
    }
    if (slot.grant || slot.rejected || (slot.agent !== undefined && slot.agent !== value.agent)
      || (value.status !== "pending" && value.status !== "running")) continue;
    slot.acknowledgement = { id: value.id, agent: value.agent };
  }
}

/** Teardown can emit late started slots; retain strings, never live SDK grants. */
function retiredTaskObserver(shared: Registry, closedIds: ReadonlySet<string>): (payload: unknown) => void {
  return (payload) => {
    if (!record(payload) || payload.status !== "started") return;
    const lifecycle = lifecycleOf(payload);
    if (!lifecycle?.sessionFile || !closedIds.has(lifecycle.parentToolCallId)) return;
    const prior = shared.sessions.get(lifecycle.sessionFile);
    if (prior) retire(shared, prior, IDENTITY_DENIED);
    shared.deniedFiles.set(lifecycle.sessionFile, IDENTITY_DENIED);
  };
}

export function createOrdinaryTaskAuthority(events: EventBus | undefined, label: string): OrdinaryTaskAuthority {
  const shared = registry();
  const owner = Symbol("ordinary-task-owner");
  const calls = new Map<string, Call>();
  const closedIds = new Set<string>();
  let sessionManager: object | undefined;
  let disposed = false;

  const denyFile = (file: string, reason: AdmissionDiagnosticCode = IDENTITY_DENIED): void => {
    if (!shared) return;
    const prior = shared.sessions.get(file);
    if (prior) retire(shared, prior, reason);
    shared.deniedFiles.set(file, reason);
  };
  const promote = (call: Call, slot: Slot): void => {
    if (!shared || !call.executing || slot.rejected || !slot.started || slot.grant) return;
    if (!rootCurrent(call.root) || !snapshotStillCurrent(call.parent)
      || (call.parentGrant && !grantCurrent(shared, call.parentGrant))) {
      slot.rejected = true;
      denyFile(slot.started.sessionFile, call.root.denial ?? IDENTITY_DENIED);
      return;
    }
    if (shared.sessions.has(slot.started.sessionFile) || shared.deniedFiles.has(slot.started.sessionFile)) {
      slot.rejected = true;
      denyFile(slot.started.sessionFile);
      return;
    }
    const grant: Grant = { call, slot, lifecycle: slot.started, active: true };
    slot.grant = grant;
    shared.sessions.set(slot.started.sessionFile, grant);
    if (call.parentGrant) (call.parentGrant.dependents ??= new Set()).add(grant);
  };
  const resolveChild = (ctx: unknown, cwd: string): SessionSnapshot | AdmissionDiagnosticCode | "unknown" => {
    if (!shared) return IDENTITY_DENIED;
    let current: SessionSnapshot | undefined;
    let bound: Grant | AdmissionDiagnosticCode | undefined;
    try {
      const manager = managerOf(ctx);
      if (!disposed) sessionManager ??= manager;
      if (manager) bound = shared.bindings.get(manager);
      if (typeof bound === "string") return bound;
      current = readSnapshot(ctx);
      if (!current) {
        const file = record(manager) && typeof manager.getSessionFile === "function"
          ? manager.getSessionFile() : undefined;
        if (typeof file === "string") {
          const reason = shared.deniedFiles.get(resolve(file));
          if (reason) return reason;
          if (shared.sessions.has(resolve(file))) return IDENTITY_DENIED;
        }
        return bound ? IDENTITY_DENIED : "unknown";
      }
    } catch {
      return IDENTITY_DENIED;
    }
    const reason = shared.deniedFiles.get(current.sessionFile);
    if (reason) return reason;
    const grant = shared.sessions.get(current.sessionFile);
    if (current.cwd !== resolve(cwd)) return bound || grant ? "worktree_mismatch" : "unknown";
    if (!grant) return bound ? IDENTITY_DENIED : "unknown";
    if (disposed) return IDENTITY_DENIED;
    if (grant.call.label !== label || (bound && bound !== grant)) return IDENTITY_DENIED;
    if (!grantCurrent(shared, grant)) return grant.call.root.denial ?? IDENTITY_DENIED;
    const parentFile = current.header.parentSession;
    if (current.manager === grant.call.parent.manager || current.sessionId === grant.call.parent.sessionId
      || current.sessionId === grant.lifecycle.id
      || (parentFile !== undefined && (typeof parentFile !== "string" || !isAbsolute(parentFile)
        || resolve(parentFile) !== grant.call.parent.sessionFile))) return IDENTITY_DENIED;
    if (grant.child) return sameSnapshot(grant.child, current) ? grant.call.root.snapshot : IDENTITY_DENIED;
    // The actual SDK supplies this context/manager, not model input or a copied flag.
    grant.child = current;
    shared.bindings.set(current.manager, grant);
    return grant.call.root.snapshot;
  };

  const onLifecycle = (payload: unknown): void => {
    if (!shared || disposed || !record(payload)) return;
    const lifecycle = lifecycleOf(payload);
    if (!lifecycle) return;
    let match: Call | undefined;
    for (const call of calls.values()) {
      if (call.toolCallId !== lifecycle.parentToolCallId) continue;
      if (!call.slots[lifecycle.index]) continue;
      if (match) { reject(shared, match); reject(shared, call); return; }
      match = call;
    }
    if (!match) {
      if (payload.status === "started" && lifecycle.sessionFile && closedIds.has(lifecycle.parentToolCallId)) {
        denyFile(lifecycle.sessionFile);
      }
      return;
    }
    const slot = match.slots[lifecycle.index]!;
    if (payload.status === "started") {
      if (!lifecycle.sessionFile) return;
      if (slot.started) {
        if (slot.started.id !== lifecycle.id || slot.started.sessionFile !== lifecycle.sessionFile
          || slot.started.agent !== lifecycle.agent) {
          slot.rejected = true;
          if (slot.grant) retire(shared, slot.grant, IDENTITY_DENIED);
          denyFile(lifecycle.sessionFile);
        }
        return;
      }
      if (!match.executing || slot.rejected || (slot.agent !== undefined && slot.agent !== lifecycle.agent)
        || (match.ended && (!slot.acknowledgement || slot.acknowledgement.id !== lifecycle.id
          || slot.acknowledgement.agent !== lifecycle.agent))) {
        slot.rejected = true;
        denyFile(lifecycle.sessionFile);
        if (match.slots.every((item) => item.rejected)) forgetCall(match);
        return;
      }
      slot.started = { ...lifecycle, sessionFile: lifecycle.sessionFile };
      promote(match, slot);
      return;
    }
    if (payload.status !== "completed" && payload.status !== "failed" && payload.status !== "aborted") return;
    const grant = slot.grant;
    if (grant) {
      if (grant.call.owner !== owner || grant.lifecycle.id !== lifecycle.id
        || grant.lifecycle.agent !== lifecycle.agent || grant.lifecycle.sessionFile !== lifecycle.sessionFile) return;
      retire(shared, grant, IDENTITY_DENIED);
    } else if (slot.acknowledgement?.id === lifecycle.id && slot.acknowledgement.agent === lifecycle.agent) {
      slot.rejected = true;
      slot.acknowledgement = undefined;
      if (lifecycle.sessionFile) denyFile(lifecycle.sessionFile);
      if (match.slots.every((item) => item.rejected)) forgetCall(match);
    }
  };
  let unsubscribe = events?.on?.("task:subagent:lifecycle", onLifecycle);
  let unsubscribeRetired: unknown;

  return {
    observeSessionStart(ctx) {
      const manager = managerOf(ctx);
      if (!manager) return;
      if (disposed) {
        if (typeof unsubscribeRetired === "function") unsubscribeRetired();
        unsubscribeRetired = undefined;
        disposed = false;
        unsubscribe = events?.on?.("task:subagent:lifecycle", onLifecycle);
      }
      sessionManager ??= manager;
    },
    resolve: resolveChild,
    admitTaskCall(ctx, event, readRootCurrent) {
      if (!shared || disposed || event.toolName !== "task" || !event.toolCallId) return IDENTITY_DENIED;
      if (closedIds.has(event.toolCallId)) return IDENTITY_DENIED;
      const parent = readSnapshot(ctx);
      const items = taskItems(event.input);
      const shape = structuralShape(event.input);
      if (!parent || !items || !shape) return IDENTITY_DENIED;
      const key = callKey(parent, event.toolCallId);
      const prior = calls.get(key);
      if (prior) {
        if (!sameSnapshot(prior.parent, parent) || prior.shape !== shape || prior.ended) {
          reject(shared, prior);
          return IDENTITY_DENIED;
        }
        return rootCurrent(prior.root) ? true : prior.root.denial ?? IDENTITY_DENIED;
      }
      let root: Root;
      let parentGrant: Grant | undefined;
      if (readRootCurrent) {
        root = { snapshot: parent, readCurrent: readRootCurrent, active: true };
        if (!rootCurrent(root)) return root.denial ?? IDENTITY_DENIED;
        sessionManager = parent.manager;
      } else {
        const resolution = resolveChild(ctx, parent.cwd);
        if (typeof resolution !== "object") return resolution === "unknown" ? IDENTITY_DENIED : resolution;
        const bound = shared.bindings.get(parent.manager);
        if (!bound || typeof bound === "string") return IDENTITY_DENIED;
        parentGrant = bound;
        root = parentGrant.call.root;
      }
      const slots: Slot[] = [];
      for (const item of items) {
        const agent = typeof item.agent === "string" ? item.agent.trim() : undefined;
        slots.push({ ...(agent ? { agent } : {}), rejected: false });
      }
      calls.set(key, { owner, label, calls, closedIds, parent, parentGrant, root, toolCallId: event.toolCallId,
        shape, slots, executing: false, ended: false });
      return true;
    },
    observeToolExecutionStart(event, ctx) {
      if (!shared || disposed || !record(event) || event.toolName !== "task" || typeof event.toolCallId !== "string") return;
      const parent = readSnapshot(ctx);
      if (!parent) return;
      const call = calls.get(callKey(parent, event.toolCallId));
      if (!call || !sameSnapshot(call.parent, parent)) return;
      if (call.ended || structuralShape(event.args) !== call.shape || !rootCurrent(call.root)) {
        reject(shared, call, call.root.denial ?? IDENTITY_DENIED);
        return;
      }
      call.executing = true;
    },
    observeToolExecutionEnd(event, ctx) {
      if (!shared || disposed || !record(event) || event.toolName !== "task" || typeof event.toolCallId !== "string") return;
      const parent = readSnapshot(ctx);
      if (!parent) return;
      const call = calls.get(callKey(parent, event.toolCallId));
      if (!call || !sameSnapshot(call.parent, parent) || call.ended) return;
      call.ended = true;
      if (event.isError === true || !call.executing) { reject(shared, call); return; }
      acknowledgePending(shared, call, event.result);
      for (const slot of call.slots) if (!slot.grant && !slot.acknowledgement) slot.rejected = true;
      if (call.slots.every((slot) => slot.rejected)) forgetCall(call);
    },
    observeSessionSwitch(ctx) {
      if (!shared || disposed || !sessionManager || managerOf(ctx) !== sessionManager) return;
      for (const call of calls.values()) {
        if (!snapshotStillCurrent(call.parent)) reject(shared, call);
      }
      for (const grant of shared.sessions.values()) {
        if (grant.child && grant.child.manager === sessionManager && !snapshotStillCurrent(grant.child)) {
          retire(shared, grant, IDENTITY_DENIED);
        }
      }
    },
    observeSessionShutdown(ctx) {
      if (!shared || disposed) return;
      const manager = managerOf(ctx);
      if (!manager) return;
      for (const grant of shared.sessions.values()) {
        if (grant.call.root.snapshot.manager === manager) {
          grant.call.root.active = false;
          retire(shared, grant, IDENTITY_DENIED);
        } else if (grant.child?.manager === manager) retire(shared, grant, IDENTITY_DENIED);
      }
      if (manager !== sessionManager) return;
      disposed = true;
      for (const call of calls.values()) reject(shared, call);
      sessionManager = undefined;
      if (typeof unsubscribe === "function") unsubscribe();
      unsubscribe = undefined;
      if (closedIds.size > 0) {
        unsubscribeRetired = events?.on?.("task:subagent:lifecycle", retiredTaskObserver(shared, closedIds));
      }
    },
  };
}
