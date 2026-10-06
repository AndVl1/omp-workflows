import { isAbsolute, resolve } from "node:path";

import { hasStrictOrchestratorState } from "./gates/orchestrator-write.js";
import { assertCtoSliceDispatchable, parseCtoSliceMarker } from "./cto/slice-gate.js";
import { isCtoRunTerminal, readCtoState } from "./cto/state.js";
import { bindNativeStageAssignment, reserveNativeStageAssignmentsBatch, settleNativeStageWorkerTerminal, type NativeAcceptedStageReceiptLineage } from "./cto/native-stage.js";
import type { NativeStagePreflightTerminalSignal } from "./cto/types.js";
import { loadTeamDefs } from "./cto/plan.js";
import { readRunControlNoRecovery, readRunState, reserveNativeExecutionClaimWorkers, settleCtoExecutionClaimWorkersByToolCall, settleExecutionClaimWorkers, type DispatchOrigin, type NativeRecoveryReservationPermit } from "./engine/run-store.js";
import { resolveAgentForRole, resolveConfig, type ResolvedConfig } from "./engine/config.js";
import type { TeamDef } from "./cto/types.js";
import type { CtoClaimScope, TrustedExecutionContext, WorkIdentity } from "./engine/types.js";
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
export class NativeWorkerRouteError extends Error {
  readonly code = "native_authority_route_denied" as const;

  constructor() {
    super("native worker configured CTO route denied");
    this.name = "NativeWorkerRouteError";
  }
}

type NativeActor = "worker" | "lead";
type ParentActor = "orchestrator" | "lead";

type EventBusLike = {
  on?: (channel: string, handler: (data: unknown) => void | Promise<void>) => (() => void) | void;
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
type CtoTeamRoute = {
  runId: string;
  sliceId: string;
  teamId: string;
  lead: string;
  roster: ReadonlySet<string>;
};
type CtoRouteResolution =
  | { ok: true; route: CtoTeamRoute }
  | { ok: false; kind: "canonical" | "binding" };


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
  ctoTeamId?: string;
  input: unknown;
  inputShape: string;
  item: TaskItem;
  index: number;
  expectedAgent?: string;
  assignedIdentity?: WorkIdentity;
  ctoSlice?: { runId: string; sliceId: string };
  ctoActor?: NativeActor;
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
  ctoTeamId?: string;
  index: number;
  agent: string;
  sessionFile: string;
  lifecycleId: string;
  actor: NativeActor;
  assignedIdentity?: WorkIdentity;
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

type RootAuthorityEntry = {
  readonly authority_owner: symbol;
  readonly owner: object;
  read: (runId?: string) => NativeRootAuthoritySnapshot | undefined;
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
  rootAuthorities?: Map<string, RootAuthorityEntry[]>;
};

type RegistrySlot = Record<PropertyKey, unknown>;

export type NativeWorkerResolution = {
  actor: NativeActor;
  kind: "workflow" | "cto";
  runId: string;
};

/**
 * Private claim witness carried only by a verified native CTO binding. It is
 * never accepted from model input and is not serialized into stage receipts.
 */
export type NativeWorkerPublicationOwner = {
  run_id: string;
  claim_token: string;
  ownership_epoch: string;
  coordinator_session_id: string;
  coordinator_process_id?: number;
  worker_id: string;
  assignment_dispatch_id: string;
};

/**
 * Host-attested assignment details for a currently bound child session.
 *
 * The model never receives or supplies these fields.  They are exposed only
 * to engine-owned lifecycle services after `resolve` has verified the exact
 * session-manager/header lineage and active grant.
 */
export type NativeWorkerBinding = {
  resolution: NativeWorkerResolution;
  session_id: string;
  session_file: string;
  cwd: string;
  parent_session_file: string;
  parent_tool_call_id: string;
  agent: string;
  lifecycle_id: string;
  assigned_identity?: WorkIdentity;
  /** Verified CTO claim/assignment witness for native receipt publication. */
  publication_owner?: NativeWorkerPublicationOwner;
  dispatch_origin?: DispatchOrigin;
  cto_slice?: { runId: string; sliceId: string };
  cto_team_id?: string;
};
/**
 * Root context is host-attested by the callback. Ordinary integrations may
 * omit the authority discriminator; CTO integrations must provide coordinator.
 */
export type NativeRootAuthorityContext = Omit<TrustedExecutionContext, "authority"> & {
  readonly authority?: TrustedExecutionContext["authority"];
};

/**
 * Private live-root authority snapshots used only by cold-revive host routing.
 * The callback that produces one must reread the actual root SDK context and
 * current controller claim on every lookup; these fields are never model-facing.
 */
export type NativeRootAuthoritySnapshot =
  | {
      readonly authority: "ordinary";
      readonly root_ctx: unknown;
      readonly context: NativeRootAuthorityContext;
      readonly run_id: string;
    }
  | {
      readonly authority: "cto";
      readonly root_ctx: unknown;
      readonly context: NativeRootAuthorityContext;
      readonly run_id: string;
      readonly claim_scope: CtoClaimScope;
    };

export type NativeRootAuthorityRegistration = {
  readonly cwd: string;
  readonly owner: object;
  readonly read: (runId?: string) => NativeRootAuthoritySnapshot | undefined;
};


export type NativeWorkerTaskCall = {
  toolName?: string;
  toolCallId?: string;
  input?: unknown;
};
export type NativePreflightRejectionInput = {
  ctx: unknown;
  event: NativeWorkerTaskCall;
  actor: ParentActor;
  runId: string | undefined;
  dispatchOrigins?: readonly DispatchOrigin[];
  terminal_signal: NativeStagePreflightTerminalSignal;
};

export type NativePreflightRejectionResult =
  | { ok: true; identities: readonly WorkIdentity[] }
  | { ok: false; code: string; error: string };

export type NativeWorkerAuthority = {
  observeToolExecutionStart(event: unknown, ctx: unknown): void;
  observeToolExecutionEnd(event: unknown, ctx: unknown): void;
  admitTaskCall(
    ctx: unknown,
    event: NativeWorkerTaskCall,
    actor: ParentActor,
    runId: string | undefined,
    dispatchOrigins?: readonly DispatchOrigin[],
    preflightTerminalSignal?: NativeStagePreflightTerminalSignal,
  ): boolean | NativePreflightRejectionResult;
  rejectTaskPreflight(input: NativePreflightRejectionInput): Promise<NativePreflightRejectionResult>;
  resolve(ctx: unknown, cwd: string, selectedRunId?: string): NativeWorkerResolution | undefined;
  binding(ctx: unknown, cwd: string, selectedRunId?: string): NativeWorkerBinding | undefined;
  /** Internal host-only live root registration for cold-revive routing. */
  registerRootAuthority(input: NativeRootAuthorityRegistration): boolean;
  unregisterRootAuthority(input: { readonly cwd: string; readonly owner: object }): void;
  resolveRootAuthority(cwd: string, runId?: string): NativeRootAuthoritySnapshot | undefined;
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
    rootAuthorities: new Map(),
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
function rootAuthorityEntries(registry: Registry): Map<string, RootAuthorityEntry[]> {
  if (registry.rootAuthorities instanceof Map) return registry.rootAuthorities;
  const entries = new Map<string, RootAuthorityEntry[]>();
  registry.rootAuthorities = entries;
  return entries;
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
/**
 * Return the host-attested child lineage tuple used by the read-only native
 * accepted-receipt resolver. This deliberately exposes no claim credential;
 * the caller must still authenticate the current root owner separately.
 */
export function nativeReadonlyReplayLineage(
  ctx: unknown,
  cwd: string,
): NativeAcceptedStageReceiptLineage | undefined {
  const snapshot = readSnapshot(ctx);
  if (!snapshot || resolve(snapshot.cwd) !== resolve(cwd) || !snapshotStillCurrent(snapshot)) return undefined;
  const parentSession = snapshot.header.parentSession;
  if (typeof parentSession !== "string" || !isAbsolute(parentSession)) return undefined;
  return {
    session_id: snapshot.sessionId,
    session_file: snapshot.sessionFile,
    parent_session_file: resolve(parentSession),
  };
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
function nativeRootAuthorityKey(bundleLabel: string, cwd: string): string | undefined {
  if (typeof cwd !== "string" || cwd.length === 0) return undefined;
  return namespaceKey(bundleLabel, cwd);
}

function validNativeRootAuthoritySnapshot(
  snapshot: NativeRootAuthoritySnapshot | undefined,
  cwd: string,
  runId?: string,
): snapshot is NativeRootAuthoritySnapshot {
  if (
    !snapshot
    || !snapshot.root_ctx
    || typeof snapshot.root_ctx !== "object"
    || Array.isArray(snapshot.root_ctx)
    || (snapshot.authority !== "ordinary" && snapshot.authority !== "cto")
    || typeof snapshot.run_id !== "string"
    || snapshot.run_id.length === 0
    || !/^[A-Za-z0-9._-]+$/.test(snapshot.run_id)
    || snapshot.run_id === "."
    || snapshot.run_id === ".."
    || runId !== undefined && snapshot.run_id !== runId
  ) return false;
  const context = snapshot.context;
  if (
    !context
    || context.caller !== "host"
    || typeof context.session_id !== "string"
    || context.session_id.length === 0
    || typeof context.worktree !== "string"
    || resolve(context.worktree) !== resolve(cwd)
    || typeof context.branch !== "string"
    || context.branch.length === 0
  ) return false;
  if (snapshot.authority === "ordinary") {
    if (
      context.authority !== undefined
      && context.authority !== "coordinator"
      && context.authority !== "read"
    ) return false;
    return !Object.hasOwn(snapshot, "claim_scope");
  }
  if (context.authority !== "coordinator") return false;
  const scope = snapshot.claim_scope;
  return (
    !!scope
    && scope.run_id === snapshot.run_id
    && typeof scope.ownership_epoch === "string"
    && scope.ownership_epoch.length > 0
  );
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
function resolvedRosterAgent(role: string, config: ResolvedConfig): string | undefined {
  if (typeof role !== "string" || role.length === 0) return undefined;
  if (config.agent_mapping) {
    const mapped = config.agent_mapping.resolved_roles[role];
    return typeof mapped === "string" && mapped.length > 0 ? mapped : undefined;
  }
  if (!Object.prototype.hasOwnProperty.call(config.roles, role)) return undefined;
  const configured = resolveAgentForRole(role, config);
  return typeof configured === "string" && configured.length > 0 ? configured : undefined;
}

/**
 * Resolve a CTO slice through the same canonical links used to construct
 * runtime state: runtime team id -> plan.team -> consumer TeamDef. The
 * marker, title, scope, and agent names are never used as substitutes for
 * those links.
 */
function configuredCtoRoute(cwd: string, runId: string, sliceId: string): CtoRouteResolution {
  if (
    !/^[A-Za-z0-9._-]+$/.test(runId) || runId === "." || runId === ".."
    || !/^[A-Za-z0-9._-]+$/.test(sliceId) || sliceId === "." || sliceId === ".."
  ) return { ok: false, kind: "canonical" };
  try {
    const state = readCtoState(runId, cwd);
    if (!state || state.id !== runId || isCtoRunTerminal(state)) return { ok: false, kind: "canonical" };
    if (!assertCtoSliceDispatchable(state, { sliceId, root: cwd, markerRunId: runId }).ok) {
      return { ok: false, kind: "canonical" };
    }
    const runtimeMatches = state.teams.filter((team) => team && team.slice_id === sliceId);
    if (runtimeMatches.length !== 1) return { ok: false, kind: "binding" };
    const runtimeTeam = runtimeMatches[0]!;
    const runtimeIdMatches = state.teams.filter((team) => team && team.id === runtimeTeam.id);
    if (runtimeIdMatches.length !== 1) return { ok: false, kind: "binding" };
    const planMatches = state.plan.teams.filter((entry) => entry && entry.team === runtimeTeam.id);
    if (planMatches.length !== 1) return { ok: false, kind: "binding" };
    const defMatches = loadTeamDefs(cwd).filter((def) => def.id === planMatches[0]!.team);
    if (defMatches.length !== 1) return { ok: false, kind: "binding" };
    const def: TeamDef = defMatches[0]!;
    if (typeof def.lead !== "string" || def.lead.length === 0 || !Array.isArray(def.roster)) {
      return { ok: false, kind: "binding" };
    }
    const config = resolveConfig(cwd);
    const roster = new Set<string>();
    for (const role of def.roster) {
      const agent = resolvedRosterAgent(role, config);
      if (!agent) return { ok: false, kind: "binding" };
      roster.add(agent);
    }
    return {
      ok: true,
      route: {
        runId,
        sliceId,
        teamId: runtimeTeam.id,
        lead: def.lead,
        roster,
      },
    };
  } catch {
    return { ok: false, kind: "canonical" };
  }
}
function configuredCtoAssignment(cwd: string, route: CtoTeamRoute, agent: string): WorkIdentity | undefined {
  try {
    const state = readCtoState(route.runId, cwd);
    const team = state?.teams.find((entry) => entry.id === route.teamId && entry.slice_id === route.sliceId);
    const identity = team?.pending?.identity ?? team?.work_identity;
    if (!identity || (identity.slot_id !== agent && identity.worker_id !== agent)) return undefined;
    return structuredClone(identity);
  } catch {
    return undefined;
  }
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

function ctoWorkerToolCallId(workerId: string): string | undefined {
  if (!workerId.startsWith("cto:")) return undefined;
  const firstSeparator = workerId.indexOf(":", 4);
  const lastSeparator = workerId.lastIndexOf(":");
  if (lastSeparator <= 4 || lastSeparator === workerId.length - 1) return undefined;
  const indexText = workerId.slice(lastSeparator + 1);
  if (!/^(0|[1-9][0-9]*)$/.test(indexText)) return undefined;
  const toolCallId = firstSeparator === lastSeparator
    ? workerId.slice(4, lastSeparator)
    : workerId.slice(firstSeparator + 1, lastSeparator);
  return toolCallId || undefined;
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

function resolveCurrentCtoAuthority(
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
  agent?: string;
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
    ...(typeof payload.agent === "string" && payload.agent.length > 0 ? { agent: payload.agent } : {}),
  };
}
function publicationOwnerForGrant(grant: Grant, identity: WorkIdentity): NativeWorkerPublicationOwner | undefined {
  const authority = grant.ctoAuthority;
  if (
    !authority
    || "legacy" in authority
    || !ctoAuthorityCurrent(grant, false)
    || !grant.ctoWorkerId
    || authority.run_id !== grant.runId
    || authority.run_id !== identity.run_id
    || grant.ctoWorkerId !== identity.worker_id
    || grant.assignedIdentity?.dispatch_id !== identity.dispatch_id
  ) return undefined;
  return {
    run_id: authority.run_id,
    claim_token: authority.token,
    ownership_epoch: authority.ownership_epoch,
    coordinator_session_id: authority.coordinator_session_id,
    ...(authority.coordinator_process_id === undefined ? {} : { coordinator_process_id: authority.coordinator_process_id }),
    worker_id: grant.ctoWorkerId,
    assignment_dispatch_id: identity.dispatch_id,
  };
}


export type OrdinaryWorkerTerminalSettlement = {
  cwd: string;
  run_id: string;
  dispatch_id: string;
  tool_call_id: string;
  dispatch_origin: DispatchOrigin;
  parent_session_id: string;
  parent_session_file: string;
  parent_manager: object;
  lifecycle_id: string;
  agent: string;
  index: number;
  session_file: string;
  outcome: "succeeded" | "failed" | "cancelled";
};

export type OrdinaryWorkerTerminalSettlementCallback = (
  settlement: OrdinaryWorkerTerminalSettlement,
) => void | Promise<void>;

export type NativeWorkerTerminalSettlement = {
  cwd: string;
  run_id: string;
  dispatch_id: string;
  tool_call_id: string;
  identity: WorkIdentity;
  outcome: "succeeded" | "failed" | "cancelled";
  worker_terminal_required: boolean;
};

/**
 * Optional host callback invoked only after a canonical native worker
 * assignment has been settled. The payload contains no claim authority or
 * model-supplied fields; it is derived from the matched lifecycle grant.
 */
export type NativeWorkerTerminalSettlementCallback = (
  settlement: NativeWorkerTerminalSettlement,
) => void | Promise<void>;

export type NativeWorkerAuthorityOptions = {
  bundleLabel?: string;
  legacyAuthority?: LegacyAuthorityResolver;
  legacyAuthorityCurrent?: LegacyAuthorityCurrentResolver;
  onTerminalSettlement?: NativeWorkerTerminalSettlementCallback;
  onOrdinaryTerminalSettlement?: OrdinaryWorkerTerminalSettlementCallback;
};

export function createNativeWorkerAuthority(
  events?: EventBusLike,
  options: NativeWorkerAuthorityOptions = {},
): NativeWorkerAuthority {
  const bundleLabel = typeof options.bundleLabel === "string" && options.bundleLabel.length > 0
    ? options.bundleLabel
    : "omp-workflows";
  const onTerminalSettlement = options.onTerminalSettlement;
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
    const actor: NativeActor = candidate.ctoActor ?? "worker";
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
      ...(candidate.ctoTeamId ? { ctoTeamId: candidate.ctoTeamId } : {}),
      index: candidate.index,
      agent: candidate.lifecycle.agent,
      sessionFile: candidate.lifecycle.sessionFile,
      lifecycleId: candidate.lifecycle.id,
      actor,
      ...(candidate.ctoSlice ? { ctoSlice: candidate.ctoSlice } : {}),
      ...(candidate.assignedIdentity ? { assignedIdentity: candidate.assignedIdentity } : {}),
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

  const handleLifecycle = async (value: unknown): Promise<void> => {
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
      && (!grant.dispatchOrigin || grant.agent === terminal.agent)
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
    const terminalOutcome = status === "completed" ? "succeeded" : status === "failed" ? "failed" : "cancelled";
    const origin = grant?.dispatchOrigin;
    if (
      grant
      && origin
      && !grant.ctoAuthority
      && !grant.ctoRunId
      && !grant.ctoSlice
      && terminal.agent === grant.agent
      && origin.origin_session_id === grant.parent.sessionId
      && grantCanonicalCurrent(grant)
      && options.onOrdinaryTerminalSettlement
    ) {
      try {
        await options.onOrdinaryTerminalSettlement({
          cwd: grant.parent.cwd,
          run_id: origin.run_id,
          dispatch_id: origin.dispatch_id,
          tool_call_id: grant.parentToolCallId,
          dispatch_origin: structuredClone(origin),
          parent_session_id: grant.parent.sessionId,
          parent_session_file: grant.parent.sessionFile,
          parent_manager: grant.parent.manager,
          lifecycle_id: terminal.id,
          agent: terminal.agent,
          index: terminal.index,
          session_file: terminal.sessionFile,
          outcome: terminalOutcome,
        });
      } catch {
        // A rejected ordinary canonical join must not manufacture another writer.
      }
    }
    // The grant witness is private process state; the canonical settlement below rechecks it under lock.
    if (grant && grant.assignedIdentity && authority && workerId && !("legacy" in authority)) {
      const terminalSettlement = settleNativeStageWorkerTerminal(grant.parent.cwd, {
        run_id: authority.run_id,
        claim_token: authority.token,
        ownership_epoch: authority.ownership_epoch,
        coordinator_session_id: authority.coordinator_session_id,
        ...(authority.coordinator_process_id === undefined ? {} : { coordinator_process_id: authority.coordinator_process_id }),
        dispatch_id: grant.assignedIdentity.dispatch_id,
        worker_id: workerId,
      });
      if (terminalSettlement.ok && terminalSettlement.worker_terminal_required && onTerminalSettlement) {
        try {
          await onTerminalSettlement({
            cwd: grant.parent.cwd,
            run_id: authority.run_id,
            dispatch_id: grant.assignedIdentity.dispatch_id,
            tool_call_id: grant.parentToolCallId,
            identity: structuredClone(grant.assignedIdentity),
            outcome: terminalOutcome,
            worker_terminal_required: terminalSettlement.worker_terminal_required,
          });
        } catch {
          // Host persistence is best-effort; canonical terminal and cleanup
          // must retain their existing failure behavior.
        }
      }
    }
    if (authority && workerId && !("legacy" in authority)) {
      const toolCallId = ctoWorkerToolCallId(workerId);
      if (toolCallId) try {
        settleCtoExecutionClaimWorkersByToolCall(grant?.parent.cwd ?? witness!.cwd, {
          run_id: authority.run_id,
          tool_call_id: toolCallId,
          token: authority.token,
          ownership_epoch: authority.ownership_epoch,
          worker_ids: [workerId],
        });
      } catch {
        // A stale claim must not preserve a process-local grant. The
        // release-aware provenance check remains the source of truth.
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
    admitTaskCall(ctx, event, actor, runId, dispatchOrigins, preflightTerminalSignal) {
      if (
        preflightTerminalSignal !== undefined
        && preflightTerminalSignal !== "preflight:missing_prompt"
        && preflightTerminalSignal !== "preflight:invalid_arguments"
      ) return { ok: false, code: "native_preflight_invalid", error: "unsupported native preflight terminal signal" };
      if (!registry || event.toolName !== "task" || !event.toolCallId || (actor !== "orchestrator" && actor !== "lead")) return false;
      ownerState(registry, owner);
      const inputShape = structuralShape(event.input);
      const items = taskItems(event.input);
      const parent = readSnapshot(ctx);
      if (!inputShape || !items || !parent) return false;
      const leadMarkers = items.map((item) => parseCtoSliceMarker(typeof item.task === "string" ? item.task : ""));
      const routeCache = new Map<string, CtoRouteResolution>();
      const routeResolutions = leadMarkers.map((marker) => {
        if (!marker) return undefined;
        const key = `${marker.runId}\u0000${marker.sliceId}`;
        if (!routeCache.has(key)) routeCache.set(key, configuredCtoRoute(parent.cwd, marker.runId, marker.sliceId));
        return routeCache.get(key);
      });
      const leadRoutes = routeResolutions.map((resolution) => resolution?.ok ? resolution.route : undefined);
      const allLeadItems = actor === "orchestrator" && items.every((item, index) => {
        const agent = typeof item.agent === "string" ? item.agent : "";
        const marker = leadMarkers[index];
        const route = leadRoutes[index];
        return !!marker && !!route && agent === route.lead;
      });
      if (runId && (!/^[A-Za-z0-9._-]+$/.test(runId) || runId === "." || runId === "..")) return false;
      if (!runId && !allLeadItems) return false;
      const markerRunIds = leadMarkers
        .filter((marker): marker is { runId: string; sliceId: string } => !!marker)
        .map((marker) => marker.runId);
      const routeBindingFailure = leadMarkers.some((marker, index) => {
        if (!marker) return false;
        const resolution = routeResolutions[index];
        return !!resolution && !resolution.ok && resolution.kind === "binding";
      });
      const routeCanonicalFailure = leadMarkers.some((marker, index) => {
        if (!marker) return false;
        const resolution = routeResolutions[index];
        return !!resolution && !resolution.ok && resolution.kind === "canonical";
      });
      const routeRoleMismatch = items.some((item, index) => {
        const marker = leadMarkers[index];
        const resolution = routeResolutions[index];
        if (!marker || !resolution?.ok) return false;
        const agent = typeof item.agent === "string" ? item.agent : "";
        return agent !== resolution.route.lead;
      });
      const authorityRunId = runId ?? markerRunIds[0];
      let parentBinding: Binding | undefined;
      let inheritedRoute: CtoTeamRoute | undefined;
      let inheritedRouteResolution: CtoRouteResolution | undefined;
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
        const inheritedSlice = parentGrant.ctoSlice;
        if (!inheritedSlice) return false;
        const everyMarkerMatches = items.every((item) => {
          const text = typeof item.task === "string" ? item.task : "";
          const marker = parseCtoSliceMarker(text);
          return !!marker
            && marker.runId === inheritedSlice.runId
            && marker.sliceId === inheritedSlice.sliceId;
        });
        if (!everyMarkerMatches) return false;
        inheritedRouteResolution = configuredCtoRoute(
          parent.cwd,
          inheritedSlice.runId,
          inheritedSlice.sliceId,
        );
        if (!inheritedRouteResolution.ok) {
          if (inheritedRouteResolution.kind === "binding") throw new NativeWorkerRouteError();
          return false;
        }
        inheritedRoute = inheritedRouteResolution.route;
        if (
          parentBinding.grant.agent !== inheritedRoute.lead
          || parentBinding.grant.ctoTeamId !== inheritedRoute.teamId
        ) throw new NativeWorkerRouteError();
        if (!items.every((item) => {
          const agent = typeof item.agent === "string" ? item.agent : "";
          return agent.length > 0 && inheritedRoute!.roster.has(agent);
        })) throw new NativeWorkerRouteError();
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
        ? resolveCurrentCtoAuthority(
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
      if (actor === "orchestrator" && ctoAuthority && !allLeadItems) {
        if (markerRunIds.length > 0 && !routeCanonicalFailure && (routeBindingFailure || routeRoleMismatch)) {
          throw new NativeWorkerRouteError();
        }
        return false;
      }
      if (allLeadItems && (!ctoAuthority || ctoAuthority.run_id !== authorityRunId)) return false;
      const currentCtoAuthority = ctoAuthority && !("legacy" in ctoAuthority) ? ctoAuthority : undefined;
      const provisionalWorkerIds = currentCtoAuthority
        ? items.map((_item, index) => ctoWorkerId(event.toolCallId!, currentCtoAuthority.ownership_epoch, index))
        : [];
      const newlyReservedWorkerIds = new Set<string>();
      const nativeClaimReservation = currentCtoAuthority && preflightTerminalSignal === undefined
        ? {
            reserve: (input: { readonly worker_ids: readonly string[]; readonly recovery_permits: readonly NativeRecoveryReservationPermit[] }) => {
              const newlyReserved = reserveNativeExecutionClaimWorkers(parent.cwd, {
                run_id: currentCtoAuthority.run_id,
                token: currentCtoAuthority.token,
                worker_ids: [...input.worker_ids],
                recovery_permits: [...input.recovery_permits],
              });
              for (const workerId of newlyReserved) newlyReservedWorkerIds.add(workerId);
              return newlyReserved;
            },
            settle: (workerIds: readonly string[]) => {
              settleExecutionClaimWorkers(parent.cwd, {
                run_id: currentCtoAuthority.run_id,
                token: currentCtoAuthority.token,
                worker_ids: [...workerIds],
              });
              for (const workerId of workerIds) newlyReservedWorkerIds.delete(workerId);
            },
          }
        : undefined;
      const nativeAssignments = new Map<number, WorkIdentity>();
      if (currentCtoAuthority) {
        const nativeGroups = new Map<string, {
          readonly route: CtoTeamRoute;
          readonly leadCandidate: boolean;
          readonly items: Array<{ index: number; agent: string; worker_id: string }>;
        }>();
        for (const [index, item] of items.entries()) {
          const expectedAgent = typeof item.agent === "string" && item.agent.length > 0 ? item.agent : "";
          const text = typeof item.task === "string" ? item.task : "";
          const marker = parseCtoSliceMarker(text);
          const leadCandidate = actor === "orchestrator"
            && !!marker
            && !!leadRoutes[index]
            && expectedAgent === leadRoutes[index]!.lead;
          const route = leadCandidate ? leadRoutes[index] : inheritedRoute;
          if (!route) throw new NativeWorkerRouteError();
          const routeKey = [
            route.teamId,
            route.sliceId,
            leadCandidate ? "lead" : "worker",
            route.lead,
            [...route.roster].sort().join("\u0000"),
          ].join("\u0000");
          let group = nativeGroups.get(routeKey);
          if (!group) {
            group = { route, leadCandidate, items: [] };
            nativeGroups.set(routeKey, group);
          }
          group.items.push({
            index,
            agent: expectedAgent,
            worker_id: provisionalWorkerIds[index]!,
          });
        }
        const groups = [...nativeGroups.values()];
        const assignments = reserveNativeStageAssignmentsBatch(groups.map((group) => ({
          cwd: parent.cwd,
          runId: currentCtoAuthority.run_id,
          teamId: group.route.teamId,
          sliceId: group.route.sliceId,
          actor: group.leadCandidate ? "lead" : "worker",
          lead: group.route.lead,
          roster: [...group.route.roster],
          toolCallId: event.toolCallId!,
          ownershipEpoch: currentCtoAuthority.ownership_epoch,
          parentSessionId: parent.sessionId,
          preflight_terminal_signal: preflightTerminalSignal,
          items: group.items,
          claim_reservation: nativeClaimReservation,
        })));
        if (assignments.some((assignment) => !assignment.ok)) {
          if (preflightTerminalSignal === undefined && newlyReservedWorkerIds.size > 0) try {
            nativeClaimReservation?.settle([...newlyReservedWorkerIds]);
          } catch {
            // The original admission failure remains authoritative.
          }
          throw new NativeWorkerRouteError();
        }
        for (const [groupIndex, assignment] of assignments.entries()) {
          const group = groups[groupIndex]!;
          if (!assignment.ok) continue;
          for (const [offset, groupItem] of group.items.entries()) {
            const identity = assignment.identities[offset];
            if (identity) nativeAssignments.set(groupItem.index, identity);
          }
        }
        // These IDs are now backed by the persisted canonical assignments.
        newlyReservedWorkerIds.clear();
      }
      for (const candidate of [...registry.candidates.values()]) {
        if (candidate.owner === owner && sameParentSnapshot(candidate.parent, parent) && candidate.parentToolCallId === event.toolCallId) {
          removeCandidate(registry, candidate);
        }
      }
      if (preflightTerminalSignal !== undefined) {
        if (nativeAssignments.size === 0) return { ok: false, code: "native_preflight_missing_receipt", error: "native preflight produced no canonical native identity" };
        return { ok: true, identities: [...nativeAssignments.values()] };
      }
      const assignedIdentities = new Map<number, WorkIdentity>();
      for (const [index, item] of items.entries()) {
        const expectedAgent = typeof item.agent === "string" && item.agent.length > 0 ? item.agent : undefined;
        const text = typeof item.task === "string" ? item.task : "";
        const marker = parseCtoSliceMarker(text);
        const leadCandidate = actor === "orchestrator"
          && !!marker
          && !!leadRoutes[index]
          && expectedAgent === leadRoutes[index]!.lead;
        const assignmentRoute = !leadCandidate ? inheritedRoute : undefined;
        const assignedIdentity = nativeAssignments.get(index)
          ?? (assignmentRoute && expectedAgent ? configuredCtoAssignment(parent.cwd, assignmentRoute, expectedAgent) : undefined);
        if (assignmentRoute && !assignedIdentity) {
          if (currentCtoAuthority && newlyReservedWorkerIds.size > 0) try {
            nativeClaimReservation?.settle([...newlyReservedWorkerIds]);
          } catch {
            // The original route failure remains authoritative.
          }
          throw new NativeWorkerRouteError();
        }
        if (assignedIdentity) assignedIdentities.set(index, assignedIdentity);
      }
      

      items.forEach((item, index) => {
        const expectedAgent = typeof item.agent === "string" && item.agent.length > 0 ? item.agent : undefined;
        const text = typeof item.task === "string" ? item.task : "";
        const marker = parseCtoSliceMarker(text);
        const leadCandidate = actor === "orchestrator"
          && !!marker
          && !!leadRoutes[index]
          && expectedAgent === leadRoutes[index]!.lead;
        const candidateRunId = ctoAuthority?.run_id
          ?? inheritedCtoSlice?.runId
          ?? (leadCandidate ? marker!.runId : runId);
        const dispatchOrigin = dispatchOrigins?.[index];
        const assignedIdentity = assignedIdentities.get(index);
        const workerId = currentCtoAuthority
          ? (assignedIdentity?.worker_id ?? provisionalWorkerIds[index])
          : undefined;
        const assignmentRoute = !leadCandidate ? inheritedRoute : undefined;
        if (assignmentRoute && !assignedIdentity) throw new NativeWorkerRouteError();
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
          ...(assignedIdentity ? { assignedIdentity } : {}),
          ...(inheritedCtoSlice ? { ctoSlice: inheritedCtoSlice } : leadCandidate ? { ctoSlice: marker! } : {}),
          ...(leadCandidate
            ? { ctoActor: "lead" as const, ctoTeamId: leadRoutes[index]!.teamId }
            : inheritedRoute ? { ctoTeamId: inheritedRoute.teamId } : {}),
          ...(dispatchOrigin && samePath(dispatchOrigin.cwd, parent.cwd) ? { dispatchOrigin } : {}),
        };
        registry.candidates.set(candidate.key, candidate);
        ownerFor(registry, owner)?.candidates.add(candidate);
      });
      return true;
    },
    async rejectTaskPreflight(input) {
      const result = authority.admitTaskCall(
        input.ctx,
        input.event,
        input.actor,
        input.runId,
        input.dispatchOrigins,
        input.terminal_signal,
      );
      if (typeof result === "object") return result;
      if (!result) return { ok: false, code: "native_preflight_denied", error: "native task preflight was not admitted" };
      return { ok: false, code: "native_preflight_missing_receipt", error: "native task preflight did not produce a canonical receipt" };
    },
    registerRootAuthority(input) {
      if (!registry || !input || typeof input.owner !== "object" || input.owner === null || typeof input.read !== "function") return false;
      const key = nativeRootAuthorityKey(bundleLabel, input.cwd);
      if (!key) return false;
      const entriesByKey = rootAuthorityEntries(registry);
      const entries = entriesByKey.get(key) ?? [];
      const existing = entries.find((entry) => entry.owner === input.owner);
      if (existing) {
        if (existing.authority_owner !== owner) return false;
        existing.read = input.read;
        return true;
      }
      entries.push({ authority_owner: owner, owner: input.owner, read: input.read });
      entriesByKey.set(key, entries);
      return true;
    },
    unregisterRootAuthority(input) {
      if (!registry || !input || typeof input.owner !== "object" || input.owner === null) return;
      const key = nativeRootAuthorityKey(bundleLabel, input.cwd);
      if (!key) return;
      const entriesByKey = rootAuthorityEntries(registry);
      const entries = entriesByKey.get(key);
      if (!entries) return;
      const kept = entries.filter((entry) => entry.owner !== input.owner || entry.authority_owner !== owner);
      if (kept.length === 0) entriesByKey.delete(key);
      else entriesByKey.set(key, kept);
    },
    resolveRootAuthority(cwd, runId) {
      const current = getRegistry(false);
      if (!current) return undefined;
      const key = nativeRootAuthorityKey(bundleLabel, cwd);
      if (!key) return undefined;
      const entries = rootAuthorityEntries(current).get(key);
      if (!entries || entries.length === 0) return undefined;
      const snapshots: NativeRootAuthoritySnapshot[] = [];
      for (const entry of entries) {
        let snapshot: NativeRootAuthoritySnapshot | undefined;
        try {
          snapshot = entry.read(runId);
        } catch {
          snapshot = undefined;
        }
        if (validNativeRootAuthoritySnapshot(snapshot, cwd, runId)) snapshots.push(snapshot);
      }
      if (snapshots.length !== 1) return undefined;
      const snapshot = snapshots[0]!;
      return snapshot.authority === "cto"
        ? {
            authority: "cto" as const,
            root_ctx: snapshot.root_ctx,
            context: { ...snapshot.context },
            run_id: snapshot.run_id,
            claim_scope: { ...snapshot.claim_scope },
          }
        : {
            authority: "ordinary" as const,
            root_ctx: snapshot.root_ctx,
            context: { ...snapshot.context },
            run_id: snapshot.run_id,
          };
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
    binding(ctx, cwd, selectedRunId) {
      const resolution = this.resolve(ctx, cwd, selectedRunId);
      if (!resolution || !registry) return undefined;
      const current = readSnapshot(ctx);
      if (!current) return undefined;
      const currentBinding = registry.bindings.get(current.sessionFile);
      const grant = currentBinding ? registry.grants.get(currentBinding.grant.slotKey) : undefined;
      if (!currentBinding || !grant || grant !== currentBinding.grant) return undefined;
      const boundIdentity = resolution.kind === "cto" && grant.assignedIdentity
        ? bindNativeStageAssignment(current.cwd, resolution.runId, grant.assignedIdentity.dispatch_id, current.sessionId) ?? grant.assignedIdentity
        : grant.assignedIdentity;
      const publicationOwner = resolution.kind === "cto" && boundIdentity
        ? publicationOwnerForGrant(grant, boundIdentity)
        : undefined;
      return {
        resolution,
        session_id: grant.sessionFile === current.sessionFile ? current.sessionId : grant.sessionFile,
        session_file: grant.sessionFile,
        cwd: current.cwd,
        parent_session_file: grant.parent.sessionFile,
        parent_tool_call_id: grant.parentToolCallId,
        agent: grant.agent,
        lifecycle_id: grant.lifecycleId,
        ...(boundIdentity ? { assigned_identity: structuredClone(boundIdentity) } : {}),
        ...(publicationOwner ? { publication_owner: publicationOwner } : {}),
        ...(grant.dispatchOrigin ? { dispatch_origin: grant.dispatchOrigin } : {}),
        ...(grant.ctoSlice ? { cto_slice: grant.ctoSlice } : {}),
        ...(grant.ctoTeamId ? { cto_team_id: grant.ctoTeamId } : {}),
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
      const entriesByKey = rootAuthorityEntries(current);
      for (const [key, entries] of entriesByKey) {
        const kept = entries.filter((entry) => entry.authority_owner !== owner);
        if (kept.length === 0) entriesByKey.delete(key);
        else if (kept.length !== entries.length) entriesByKey.set(key, kept);
      }
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
