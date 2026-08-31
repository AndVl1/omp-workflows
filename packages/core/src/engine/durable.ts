import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, readFileSync, realpathSync, unlinkSync } from "node:fs";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { loadProfile, profileHash } from "./profile.js";
import { normalizePersistedState, resolveState, isSafeStateSegment, resolveActiveBranch, updateStateAtomically, type ResolvedState, type StateMutation, type StateUpdateResult } from "./state.js";
import { agentMappingIssueForRole, resolveConfig, resolveAgentForRole, type ResolvedConfig } from "./config.js";
import { validateAgentMappingState, type AgentMappingDiagnostic, type AgentMappingState } from "./agent-mapping.js";
import { resolveScope, type ScopeFlags } from "./scope.js";
import { resolveStageDispatchSlots, selectRoster, type RosterSelectionContext } from "./stage.js";
import { readArtifact, writeArtifact } from "./artifacts.js";
import { isDoDComplete, isRootCauseDocumented, readDoD } from "./dod.js";
import { validationGate } from "../gates/validation.js";
import { buildDispatchMarker, dispatchTaskId } from "../gates/dispatch.js";
import { validateActiveCapabilityStateBinding, validateActiveDispatchCapabilityValue, validateDispatchCapabilityValue } from "./control-plane-contract.js";
import { evaluatePredicate } from "./predicate.js";
import {
  activeRunIdOf,
  appendCheckpointDecision,
  checkpointDecisionKey,
  checkpointPolicyHash,
  currentCheckpointScope,
  checkpointProofOf,
  decisionScopeOf,
  findHistoricalCheckpointDecision,
  recordTrustedCheckpointAnswer,
  resolveCheckpointDeclaration,
  validateCheckpointDecision,
  validateCheckpointForAdvance,
  unresolvedCheckpointError,
  type CheckpointDeclarationResolution,
} from "./checkpoints.js";
import { loopIterationForStage, loopExhaustionKind, loopIterationRecord, loopReentryDecision, loopStateFor, resolveBackToStage } from "./loops.js";
import {
  DEFAULT_FAN_IN_POLICY,
  isNamespacedArtifactId,
  namespacedArtifactId,
  synthesizeArtifacts,
  type FanInPolicy,
} from "./fan-in.js";
import {
  artifactSchemaFor,
  validateConsumedArtifacts,
  validateProducedArtifact,
  DEFAULT_ARTIFACT_CONTRACT_POLICY,
  type ArtifactContractPolicy,
} from "./artifact-contract.js";
import type {
  CapabilityBinding,
  CheckpointAnswerProof,
  CheckpointRuleKind,
  CheckpointDeclaration,
  CheckpointDecision,
  CheckpointPolicy,
  CheckpointPolicyBinding,
  CheckpointRule,
  CheckpointScope,
  ChildJoin,
  CompletionArtifactRef,
  CompletionEnvelope,
  DispatchCompletion,
  DispatchRecord,
  LoopState,
  PendingState,
  RosterSelection,
  StageDef,
  TeamState,
  TrustedCheckpointAnswer,
  TypedCheckpointDecision,
  WorkIdentity,
} from "./types.js";
import { PRD_SOURCE_ARTIFACT_IDS, writeProductPrdDocument } from "./product-prd.js";

export type DispatchAuth = {
  token: string;
  capability_id: string;
  run_key: string;
  branch: string;
  workflow: string;
  profile_hash: string;
  stage_cursor: string;
  cursor_epoch: string;
  /**
   * Loop iteration of the handoff that armed this capability. A mismatch
   * with the active capability binding rejects the transition, so a handoff
   * replayed across a loop re-entry can never authorize the new iteration.
   */
  loop_iteration?: number;
  role?: string;
  slot_id?: string;
  task_id?: string;
  retry_of?: string;
  evidence?: string;
  agent?: string;
  expected_count?: number;
  tool_call_id?: string;
  pending?: boolean;
  pending_reason?: PendingState["pending_reason"];
  provider_ref?: string;
};

/**
 * Semantic roster selection accepted at capability begin: role, facet, focus
 * and reason occurrences drawn from the stage's allowed pool. Concrete agent
 * ids are never caller authority — every selected role must resolve through
 * the live registered agent mapping before dispatch.
 */
export type RosterBeginSelection = {
  rationale?: string;
  evidence?: string[];
  occurrences: Array<{
    role: string;
    facet?: string | null;
    focus?: string;
    reason?: string;
  }>;
};
type ActiveCapability = {
  capability_id: string; dispatch_token_hash: string; advance_token_hash: string;
  issued_for: CapabilityBinding;
  kind: "none" | "single" | "consilium"; expected_roles: string[]; expected_count: number;
  expected_roster: Array<{ role: string; agent: string }>;
  /** Frozen selection carried by roster-policy capabilities (masked on completion). */
  roster_selection?: RosterSelection;
  work_identity?: WorkIdentity;
  status: "ready" | "dispatched" | "joining" | "complete" | "invalidated"; dispatches: DispatchRecord[]; pending?: PendingState[];
};
/**
 * Keep the profile binding model-safe without weakening its identity.
 *
 * The full SHA-256 remains persisted in state. Workflow control calls carry a
 * compact first-30/last-2 fingerprint because long hashes are routinely
 * abbreviated by an LLM when copied through a long-running session.
 */
const profileHashFingerprint = (value: string): string =>
  value.length > 32 ? `${value.slice(0, 30)}${value.slice(-2)}` : value;

const profileHashMatches = (expected: string, provided: string): boolean =>
  provided === expected || provided === profileHashFingerprint(expected);

const activeCapability = (value: TeamState["dispatch_capability"]): ActiveCapability | null => {
  if (!value) return null;
  // COMPLETE active validation (control-plane-contract): the full persisted
  // shape plus every field a transition dereferences — secret hashes, the
  // roster arrays/count, the dispatch ledger and the loop-scoped binding. A
  // shape-valid but partial capability yields null (a structured rejection
  // upstream), never a TypeError at the cast or the iteration below.
  // Genuinely legacy (pre-loop-scope) capabilities stay readable through the
  // shape validator but are not active: they must be re-issued via
  // workflow_begin before they can authorize anything.
  if (!validateActiveDispatchCapabilityValue(value).ok) return null;
  const cap = value as ActiveCapability;
  // Sequence invariant beyond per-record shape: a role may repeat only after
  // its latest record reached a terminal failure or cancellation.
  const latestByRole = new Map<string, DispatchRecord>();
  for (const record of cap.dispatches) {
    const previous = latestByRole.get(record.role);
    if (previous && previous.status !== "failed" && previous.status !== "cancelled") return null;
    latestByRole.set(record.role, record);
  }
  return cap;
};

/** Issued capability secrets plus the persisted capability state (see createCapability). */
export type IssuedCapability = {
  capability_id: string;
  dispatch_token: string;
  advance_token: string;
  state: NonNullable<TeamState["dispatch_capability"]>;
};

export type TransitionResult = { ok: true; state: TeamState; record?: DispatchRecord; handoff?: CapabilityHandoff; child_join?: ChildJoin } | { ok: false; error: string; state?: TeamState; child_join?: ChildJoin };

export interface CapabilityHandoff {
  capability_id: string;
  dispatch_token: string;
  advance_token: string;
  run_key: string;
  branch: string;
  workflow: TeamState["classification"]["workflow"];
  /** Compact first-30/last-2 binding fingerprint; the full hash stays state-only. */
  profile_hash: string;
  stage_cursor: string;
  cursor_epoch: string;
  /** 1-based loop iteration of the issued capability. */
  loop_iteration: number;
  /** Active-stage checkpoint policy hash at issue time; null when none. */
  checkpoint_policy_hash: string | null;
  kind: "none" | "single" | "consilium";
  expected_roster: Array<{ role: string; agent: string }>;
  dispatch_markers: Array<{ role: string; agent: string; marker: string }>;
}

function handoffFromState(
  state: TeamState,
  secrets: { capability_id: string; dispatch_token: string; advance_token: string },
  stage: StageDef,
): CapabilityHandoff | undefined {
  const cap = activeCapability(state.dispatch_capability);
  if (!cap) return undefined;
  const roles = cap.expected_roster.map(({ role }) => role);
  const dispatch_markers = cap.kind === "none"
    ? []
    : cap.expected_roster.map(({ role, agent }) => ({
      role,
      agent,
      marker: buildDispatchMarker(
        cap.issued_for.run_key,
        stage,
        roles,
        role,
        cap.issued_for.cursor_epoch,
        cap.capability_id,
        role,
        expectedTaskId(cap, role),
      ),
    }));
  return {
    capability_id: secrets.capability_id,
    dispatch_token: secrets.dispatch_token,
    advance_token: secrets.advance_token,
    run_key: cap.issued_for.run_key,
    branch: cap.issued_for.branch,
    workflow: cap.issued_for.workflow,
    profile_hash: profileHashFingerprint(cap.issued_for.profile_hash),
    stage_cursor: cap.issued_for.stage_cursor,
    cursor_epoch: cap.issued_for.cursor_epoch,
    loop_iteration: cap.issued_for.loop_iteration,
    checkpoint_policy_hash: cap.issued_for.checkpoint_policy_hash ?? null,
    kind: cap.kind,
    expected_roster: cap.expected_roster,
    dispatch_markers,
  };
}


const hash = (value: string): string => createHash("sha256").update(value).digest("hex");
const now = (): string => new Date().toISOString();
/**
 * THE single durable control-plane transition seam. EVERY mutation that
 * participates in the durable workflow (begin/reissue, authorize, pending,
 * complete, cursor advance, loop re-entry, child joins) runs as one
 * cross-process transaction through `updateStateAtomically`: the workspace
 * lock serializes writers, the state is RE-READ under the lock (never a
 * pre-lock snapshot), authentication and capability validation run against
 * that fresh snapshot, and the commit is guarded by the revision/raw-hash
 * CAS. A mutation either commits, discards without writing, or fails with a
 * domain code — persisting a pre-lock snapshot is impossible by
 * construction.
 */
type RecordCore =
  | { write: true; state: TeamState; result: TransitionResult }
  | { write: false; result: TransitionResult };

type TransitionMutation = StateMutation<TransitionResult>;

function failTransition(code: string, error: string): TransitionMutation {
  return { op: "fail", code, error };
}

/** Reject without writing; the fresh state still rides the result for context. */
function rejectTransition(error: string, state: TeamState): RecordCore {
  return { write: false, result: { ok: false, error, state } };
}

/** Succeed without writing (exact replay / idempotent re-issue). */
function replayTransition(result: TransitionResult): RecordCore {
  return { write: false, result };
}

function commitTransition(next: TeamState, result: TransitionResult): RecordCore {
  return { write: true, state: next, result };
}

function toMutation(core: RecordCore): TransitionMutation {
  return core.write
    ? { op: "commit", state: core.state, value: core.result }
    : { op: "discard", value: core.result };
}

function runTransition(cwd: string, mutate: (state: TeamState, target: ResolvedState) => RecordCore): TransitionResult {
  const outcome = updateStateAtomically<TransitionResult>(cwd, (snapshot) => {
    if (!snapshot.state) return failTransition("state_missing", "state not found");
    if (snapshot.target.isStale) {
      // A stale branch binding writes nothing but still carries the state
      // for tool summaries (the pre-transaction behavior).
      return { op: "discard", value: { ok: false, error: "workflow state is stale for the active branch", state: snapshot.state } };
    }
    return toMutation(mutate(snapshot.state, snapshot.target));
  });
  if (!outcome.ok) return { ok: false, error: outcome.error };
  if (!outcome.value) return { ok: false, error: "state transaction completed without a result" };
  // The returned state is the COMMITTED, normalized and revision-stamped
  // state on disk — never the pre-normalization mutation output.
  if (outcome.committed && outcome.state && outcome.value.state !== undefined) {
    return { ...outcome.value, state: outcome.state };
  }
  return outcome.value;
}
function stableIdentitySeed(state: TeamState, cap: Pick<ActiveCapability, "issued_for" | "capability_id">): string {
  return `${cap.capability_id}|${cap.issued_for.run_key}|${cap.issued_for.branch}|${cap.issued_for.workflow}|${cap.issued_for.stage_cursor}`;
}

function workIdentityFor(
  state: TeamState,
  cap: Pick<ActiveCapability, "issued_for" | "capability_id">,
  role: string,
  agent: string,
  dispatchId: string,
  attempt: number,
  taskId?: string,
): WorkIdentity {
  // Unbound base fields are never inherited: a stale identity from a prior
  // stage/epoch/iteration must not name this dispatch's run/wave/session —
  // only an identity fully bound to THIS capability (id, epoch, stage,
  // iteration) is authoritative.
  const base = state.work_identity;
  const baseBound = base !== undefined
    && base.capability_id === cap.capability_id
    && base.capability_epoch === cap.issued_for.cursor_epoch
    && base.stage_id === cap.issued_for.stage_cursor
    && base.loop_iteration === cap.issued_for.loop_iteration;
  const seed = stableIdentitySeed(state, cap);
  return {
    run_id: baseBound ? base.run_id : cap.issued_for.run_key,
    wave_id: baseBound ? base.wave_id : `wave-${hash(seed).slice(0, 20)}`,
    slice_id: baseBound ? base.slice_id : cap.issued_for.stage_cursor,
    session_id: baseBound ? base.session_id : `session-${hash(`${seed}|session`).slice(0, 20)}`,
    workflow: cap.issued_for.workflow,
    stage_id: cap.issued_for.stage_cursor,
    stage_cursor: cap.issued_for.stage_cursor,
    capability_id: cap.capability_id,
    capability_epoch: cap.issued_for.cursor_epoch,
    loop_iteration: cap.issued_for.loop_iteration,
    slot_id: role,
    task_id: taskId ?? dispatchTaskId(cap.capability_id, cap.issued_for.run_key, cap.issued_for.branch, cap.issued_for.workflow, cap.issued_for.stage_cursor, role),
    dispatch_id: dispatchId,
    attempt,
    worker_id: agent,
  };
}

/**
 * Only a single-worker capability has one unambiguous dispatch identity that
 * can be projected onto the root state. Consilium identities remain on their
 * dispatch records and lifecycle log; choosing one slot as the root identity
 * would make sibling completion order authorization material.
 */
function projectsRootIdentity(cap: Pick<ActiveCapability, "kind" | "expected_count">): boolean {
  return cap.kind === "single" && cap.expected_count === 1;
}

type IdentityProjectingCapability = Pick<ActiveCapability, "kind" | "expected_count"> & { work_identity?: WorkIdentity };

function projectCapabilityIdentity(cap: IdentityProjectingCapability, identity: WorkIdentity): void {
  if (projectsRootIdentity(cap)) cap.work_identity = identity;
  else delete cap.work_identity;
}

function projectRootLifecycle(
  state: TeamState,
  cap: Pick<ActiveCapability, "kind" | "expected_count">,
  projection: { identity: WorkIdentity; envelope: CompletionEnvelope; pending?: PendingState },
): void {
  if (!projectsRootIdentity(cap)) {
    delete state.work_identity;
    delete state.pending;
    delete state.completion_envelope;
    return;
  }
  state.work_identity = projection.identity;
  state.completion_envelope = projection.envelope;
  if (projection.pending) state.pending = projection.pending;
  else delete state.pending;
}

function pendingFor(
  identity: WorkIdentity,
  status: PendingState["status"],
  reason?: PendingState["pending_reason"],
  providerRef?: string,
  retryOf?: string | null,
): PendingState {
  return {
    identity,
    status,
    ...(reason ? { pending_reason: reason } : {}),
    ...(providerRef ? { provider_ref: providerRef } : {}),
    ...(status === "pending" ? { lease: { token: randomUUID(), observed_at: now(), revoked_at: null } } : {}),
    terminal_signal: status === "pending" ? null : undefined,
    retry_of: retryOf ?? null,
    updated_at: now(),
  };
}

function completionArtifactRefs(
  artifactsDir: string,
  artifactIds: string[],
): CompletionArtifactRef[] {
  return artifactIds.map((artifactId) => {
    const value = readArtifact(artifactsDir, artifactId);
    return {
      artifact_id: artifactId,
      path: `${artifactId}.json`,
      sha256: hash(JSON.stringify(value)),
      schema_status: value === null ? "failed" : "met",
      dod_status: value === null ? "failed" : "met",
    };
  });
}

function completionEnvelopeFor(
  identity: WorkIdentity,
  outcome: CompletionEnvelope["outcome"],
  terminalSignal: CompletionEnvelope["terminal_signal"],
  artifactRefs: CompletionArtifactRef[],
  evidence: string,
  completedBy: CompletionEnvelope["completed_by"],
): CompletionEnvelope {
  return {
    schema_version: 1,
    identity,
    outcome,
    terminal_signal: terminalSignal,
    artifact_refs: artifactRefs,
    evidence_ref: evidence.trim() ? `evidence/${identity.dispatch_id}` : null,
    conflict_ref: null,
    completed_by: completedBy,
    emitted_at: now(),
  };
}

export function hashDispatchSecret(secret: string): string { return hash(secret); }

/**
 * Declared checkpoint policy hash of a stage, resolved from the registered
 * profile (`stage.checkpoint_policy` first, then the profile policy). Null
 * when the workflow is unregistered or the stage declares no checkpoint.
 * Direct factory callers therefore produce a binding that is coherent with
 * the stage's declared policy by default; engine transitions always pass
 * the state-resolved declaration hash explicitly.
 */
function declaredCheckpointPolicyHash(workflow: TeamState["classification"]["workflow"], stageCursor: string): string | null {
  const profile = loadProfile(workflow);
  const stage = profile?.stages.find((candidate) => candidate.id === stageCursor);
  if (!stage?.checkpoint) return null;
  const policy = stage.checkpoint_policy ?? profile!.checkpoint_policy;
  return policy ? checkpointPolicyHash(policy) : null;
}

export function createCapability(input: {
  run_key: string; branch: string; workflow: TeamState["classification"]["workflow"]; profile_hash: string;
  stage_cursor: string; cursor_epoch?: string; kind: "none" | "single" | "consilium"; expected_roles?: string[];
  dispatch_secret?: string; advance_secret?: string;
  expected_roster?: Array<{ role: string; agent: string; slot_id?: string; semantic_role?: string; occurrence?: number; facet?: string | null }>;
  roster_selection?: TeamState["roster_selection"];
  /** 1-based loop iteration; defaults to 1 for stages outside a loop window. */
  loop_iteration?: number;
  /** Checkpoint policy hash of the armed stage's declaration; null when none. */
  checkpoint_policy_hash?: string | null;
}): IssuedCapability {
  if (!input.run_key || !input.branch || !input.workflow || !input.profile_hash || !input.stage_cursor) throw new Error("invalid capability binding");
  const cursor_epoch = input.cursor_epoch ?? randomUUID();
  const dispatch_token = input.dispatch_secret ?? randomUUID();
  const advance_token = input.advance_secret ?? randomUUID();
  // Default the binding's policy hash to the armed stage's own declared
  // checkpoint policy; an explicit input always wins.
  const declaredPolicyHash = input.checkpoint_policy_hash ?? declaredCheckpointPolicyHash(input.workflow, input.stage_cursor);
  const roster = (input.expected_roster ?? (input.expected_roles ?? []).map((role) => ({ role, agent: role }))).map((entry) => ({ ...entry, role: entry.role, agent: entry.agent }));
  const expected_roles = roster.map((entry) => entry.role);
  if ((input.kind === "none" && roster.length !== 0) || (input.kind === "single" && roster.length !== 1) || (input.kind === "consilium" && roster.length === 0)) throw new Error("capability roster does not match dispatch kind");
  if (new Set(expected_roles).size !== expected_roles.length || roster.some((entry) => !entry.role || !entry.agent)) throw new Error("invalid capability roster");
  const state = {
    capability_id: randomUUID(),
    dispatch_token_hash: hash(dispatch_token),
    advance_token_hash: hash(advance_token),
    issued_for: {
      run_key: input.run_key, branch: input.branch, workflow: input.workflow, profile_hash: input.profile_hash,
      stage_cursor: input.stage_cursor, cursor_epoch,
      loop_iteration: input.loop_iteration ?? 1,
      checkpoint_policy_hash: declaredPolicyHash,
    },
    kind: input.kind,
    expected_roles,
    expected_count: roster.length,
    expected_roster: roster,
    ...(input.roster_selection ? { roster_selection: input.roster_selection } : {}),
    status: "ready" as const,
    dispatches: [],
  };
  return { capability_id: state.capability_id, dispatch_token, advance_token, state };
}
function reissueActiveCapability(cap: ActiveCapability, checkpointPolicyHash?: string | null): IssuedCapability {
  const dispatch_token = randomUUID();
  const advance_token = randomUUID();
  return {
    capability_id: cap.capability_id,
    dispatch_token,
    advance_token,
    state: {
      ...cap,
      dispatch_token_hash: hash(dispatch_token),
      advance_token_hash: hash(advance_token),
      // A re-issue rebinds the CURRENT stage declaration: a policy that
      // drifted since the original issue must not leave the reissued
      // capability permanently incoherent with the stage it arms.
      issued_for: { ...cap.issued_for, ...(checkpointPolicyHash !== undefined ? { checkpoint_policy_hash: checkpointPolicyHash } : {}) },
    },
  };
}

/** Remove one stale slot snapshot only after validating it stays in the target artifact tree. */
function removeClearedArtifactFile(target: ResolvedState, candidate: string): void {
  const artifactsDir = target.artifactsDir;
  if (!artifactsDir || !isAbsolute(candidate)) return;
  try {
    const realRoot = realpathSync(artifactsDir);
    if (!existsSync(candidate) || !lstatSync(candidate).isFile()) return;
    const realCandidate = realpathSync(candidate);
    const rel = relative(realRoot, realCandidate);
    if (rel === "" || rel === ".." || rel.startsWith(".." + sep) || isAbsolute(rel)) return;
    unlinkSync(candidate);
  } catch {
    // Stale cleanup is intentionally best-effort; capability reset remains authoritative.
  }
}

function resetReopenedStageState(
  state: TeamState,
  target: ResolvedState,
  profile: NonNullable<ReturnType<typeof loadProfile>>,
  stageId: string,
  existing: ActiveCapability | null,
): TeamState {
  const index = state.stages.findIndex((entry) => entry.id === stageId);
  if (index < 0) return state;
  const clearedStageIds = new Set(state.stages.slice(index).map((entry) => entry.id));
  const profileIndex = profile.stages.findIndex((entry) => entry.id === stageId);
  if (profileIndex >= 0) {
    for (const stage of profile.stages.slice(profileIndex)) clearedStageIds.add(stage.id);
  }
  const clearedProduced = new Set(
    profileIndex < 0 ? [] : profile.stages.slice(profileIndex).flatMap((stage) => stageProduces(stage)),
  );
  const staleFiles = new Set<string>();
  const clearedArtifactIds = new Set<string>();
  for (const clearedStageId of clearedStageIds) {
    const records = state.slot_artifacts?.[clearedStageId];
    for (const slotRecords of Object.values(records?.slots ?? {})) {
      for (const [artifactId, record] of Object.entries(slotRecords ?? {})) {
        clearedArtifactIds.add(artifactId);
        if (record && typeof record.path === "string") staleFiles.add(record.path);
      }
    }
  }
  if (existing && clearedStageIds.has(existing.issued_for.stage_cursor)) {
    for (const record of existing.dispatches) {
      for (const id of record.completion?.artifact_ids ?? []) {
        clearedArtifactIds.add(id);
        if (clearedProduced.has(id) && target.artifactsDir) staleFiles.add(join(target.artifactsDir, id + ".json"));
      }
    }
  }
  for (const path of staleFiles) removeClearedArtifactFile(target, path);

  const retainedSlotArtifacts = Object.fromEntries(
    Object.entries(state.slot_artifacts ?? {}).filter(([id]) => !clearedStageIds.has(id)),
  );
  // Upstream mappings are intentionally retained; only artifacts named by cleared records are stale.
  const retainedArtifacts = Object.fromEntries(
    Object.entries(state.artifacts ?? {}).filter(([id]) => !clearedArtifactIds.has(id)),
  );
  return {
    ...state,
    artifacts: retainedArtifacts,
    slot_artifacts: Object.keys(retainedSlotArtifacts).length > 0 ? retainedSlotArtifacts : undefined,
  };
}

/**
 * Strict role -> agent resolution for roster-policy stages: only a trusted
 * live registered mapping may name the concrete agent. An empty string means
 * "no registered agent" and fails closed downstream — project config
 * fallbacks and identity (role-name-as-agent) fallbacks never apply here.
 */
function liveRosterAgent(config: ResolvedConfig, role: string): string {
  return config.agent_mapping?.resolved_roles[role] ?? "";
}

/**
 * Optional trusted live agent-mapping handoff (additive). When supplied, the
 * in-memory mapping from host discovery is authoritative for role
 * availability: the persisted workspace mapping file is never consulted for
 * this transition, and a malformed handoff fails closed instead of silently
 * falling back to the persisted file.
 */
export type TrustedMappingOptions = { trustedMapping?: AgentMappingState };
/**
 * Bind the trusted handoff over the resolved workspace configuration: the
 * persisted `agent_mapping` is replaced in memory, never re-read. Only an
 * explicit `undefined` means "no handoff" and keeps the persisted-mapping
 * fallback; any other value — including runtime `null` — is treated as a
 * handoff attempt and must pass the one complete `AgentMappingState`
 * validator (resolved agents present in `available_agents`, diagnostics and
 * `unresolved_roles` invariants) or the transition fails closed. `trusted`
 * records whether a handoff is bound: when it is, every role resolution of
 * this transition is strict to the handoff's `resolved_roles`.
 */
function bindTrustedMapping(
  config: ResolvedConfig,
  trustedMapping: unknown,
): { ok: true; config: ResolvedConfig; trusted: boolean } | { ok: false; error: string } {
  if (trustedMapping === undefined) return { ok: true, config, trusted: false };
  const validated = validateAgentMappingState(trustedMapping);
  if (!validated.ok) {
    return {
      ok: false,
      error: `trusted agent mapping handoff is malformed (${validated.error}); refusing to fall back to the persisted workspace mapping`,
    };
  }
  return { ok: true, config: { ...config, agent_mapping: validated.mapping }, trusted: true };
}

/**
 * Dispatch-slot agent resolution at the trusted boundary. With a handoff
 * bound, the slot role must resolve through the handoff's `resolved_roles`
 * (`available_agents` membership is already guaranteed by the shared
 * validator) — a missing or unavailable role returns `null` and the caller
 * fails closed instead of falling back to config or the role name. Without
 * a handoff the persisted-mapping fallback stays valid.
 */
function trustedSlotAgent(role: string, config: ResolvedConfig, trusted: boolean): string | null {
  if (!trusted) return resolveAgentForRole(role, config);
  return liveRosterAgent(config, role) || null;
}

/**
 * Prefix match between a caller's requested semantic composition and the
 * frozen selection. Slots the engine deterministically appends (minimum
 * worker bound, risk triggers) are engine-owned, so a requested composition
 * matches when it is a prefix of the frozen one; any other difference is a
 * changed selection. Occurrences are numbered by position among same-role
 * entries, exactly as `selectRoster` freezes them.
 */
function selectionCompositionMatchesFrozen(
  requested: Array<{ role: string; facet?: string | null }>,
  frozen: Array<{ role: string; occurrence: number; facet: string | null }>,
): boolean {
  if (requested.length > frozen.length) return false;
  const seen = new Map<string, number>();
  return requested.every((occurrence, index) => {
    const entry = frozen[index];
    if (!entry) return false;
    const occurrenceNumber = (seen.get(occurrence.role) ?? 0) + 1;
    seen.set(occurrence.role, occurrenceNumber);
    return entry.role === occurrence.role
      && entry.occurrence === occurrenceNumber
      && (entry.facet ?? null) === (occurrence.facet ?? null);
  });
}

/** Live registered agent for a role, or null when the mapping does not name one. */
function requestedSelectionOccurrences(selection: RosterBeginSelection): RosterSelectionContext["selected_occurrences"] {
  return selection.occurrences.map((occurrence) => ({
    role: occurrence.role,
    facet: occurrence.facet ?? null,
    ...(occurrence.focus !== undefined ? { focus: occurrence.focus } : {}),
    ...(occurrence.reason !== undefined ? { reason: occurrence.reason } : {}),
  }));
}

/**
 * Active-stage checkpoint policy projection: the declaration is authoritative,
 * the state mirror is rebound to THIS stage in the same transaction, and a
 * stage without a checkpoint clears both the mirror and its binding.
 */
function policyProjectionFor(
  declaration: CheckpointDeclaration | null,
  stageId: string,
  profileHash: string,
): { checkpoint_policy?: CheckpointPolicy; checkpoint_policy_binding?: CheckpointPolicyBinding } {
  // A stage without a declaration projects NOTHING: absent keys, never own
  // undefined values (persisted-state normalization rejects own undefined
  // fields, so an own-undefined mirror would make every no-checkpoint
  // transition throw instead of persisting).
  if (!declaration) return {};
  return {
    checkpoint_policy: declaration.policy,
    checkpoint_policy_binding: { stage_id: stageId, profile_hash: profileHash, policy_hash: declaration.policy_hash },
  };
}

/**
 * Clear the policy mirrors of a prior stage by DELETING their keys: a stage
 * without a checkpoint declaration carries no checkpoint policy at all, and
 * a stale mirror must be dropped by the same transition that moves the
 * cursor. Optional mirrors are always omitted or deleted — never written as
 * own `undefined` properties.
 */
function clearPolicyProjection(next: TeamState): void {
  delete next.checkpoint_policy;
  delete next.checkpoint_policy_binding;
}

/**
 * Create the opaque dispatch capability after the model has persisted the
 * classification and stage list. This is the entry point for the native
 * `/do-work` prompt; the interpreter path uses `createCapability` directly.
 * An optional semantic roster selection (never concrete agent ids) is
 * validated against the stage's allowed pool and the live registered agent
 * mapping, then frozen on the issued capability.
 *
 * `options.trustedMapping` carries a fresh in-memory `AgentMappingState`
 * from host discovery straight into begin authorization: when supplied it
 * replaces the persisted workspace mapping for every role-availability
 * decision here, and a malformed handoff fails closed. Callers without a
 * handoff keep the persisted-mapping fallback.
 */
export function beginCapability(cwd: string, requested?: RosterBeginSelection, options?: TrustedMappingOptions): TransitionResult {
  return runTransition(cwd, (state, target) => {
    if (!target.statePath) return rejectTransition("workflow state not found", state);
    const workflow = state.classification?.workflow;
    if (!workflow) return rejectTransition("workflow classification is missing", state);
    const profile = loadProfile(workflow);
    if (!profile) return rejectTransition(`workflow '${workflow}' is unavailable`, state);
    const persistedHash = profileHash(profile);
    if (state.profile_hash && state.profile_hash !== persistedHash) return rejectTransition("workflow profile hash is stale", state);
    if (!Array.isArray(state.stages)) return rejectTransition("workflow stages are missing", state);
    const stages = state.stages.length > 0
      ? state.stages
      : profile.stages.map((candidate) => ({ id: candidate.id, status: "pending" as const }));
    const stageId = state.stage_cursor || profile.stages[0]?.id;
    const stage = profile.stages.find((candidate) => candidate.id === stageId);
    if (!stage) return rejectTransition(`workflow stage '${stageId ?? ""}' is unavailable`, state);
    const stageEntry = stages.find((candidate) => candidate.id === stage.id);
    if (!stageEntry) return rejectTransition(`workflow stage '${stage.id}' is not persisted`, state);
    if (stageEntry.status === "done" || stageEntry.status === "skipped") return rejectTransition(`workflow stage '${stage.id}' is already ${stageEntry.status}`, state);

    const rawCapability = state.dispatch_capability;
    const existing = activeCapability(rawCapability);
    // State<->capability coherence is enforced on every mutation: a modern
    // capability whose binding no longer matches the persisted state can be
    // re-issued only after the state itself is repaired.
    if (existing) {
      const coherence = capabilityStateCoherenceError(state, existing);
      if (coherence) return rejectTransition(coherence, state);
    }
    // Only genuinely pre-loop-scope capabilities are legacy/readable and
    // replaceable. A modern capability with loop scope whose nested identity
    // bindings fail active validation is malformed, not "legacy", and cannot
    // use workflow_begin as an authorization bypass.
    const legacyCapability = Boolean(
      rawCapability
      && !existing
      && rawCapability.issued_for?.loop_iteration === undefined
      && validateDispatchCapabilityValue(rawCapability).ok,
    );
    if (state.policy?.strict_orchestrator === true && rawCapability && !existing && !legacyCapability) return rejectTransition("workflow dispatch capability is malformed", state);
    const existingDispatches = existing?.issued_for.stage_cursor === stage.id ? existing.dispatches : [];
    const stageIteration = loopIterationForStage(state, profile, stage.id);
    if (!stageIteration.ok) return rejectTransition(stageIteration.error, state);
    const stageDeclaration = resolveCheckpointDeclaration(stage, profile.checkpoint_policy, state, "rebind");
    if (!stageDeclaration.ok) return rejectTransition(`${stageDeclaration.code}: ${stageDeclaration.error}`, state);
    const config = resolveConfig(cwd);
    const trusted = bindTrustedMapping(config, options?.trustedMapping);
    if (!trusted.ok) return rejectTransition(trusted.error, state);
    const effectiveConfig = trusted.config;
    const flags = state.scope ?? resolveScope([], config);
    const kind: "none" | "single" | "consilium" = stage.type === "single" || stage.type === "consilium" ? stage.type : "none";
    const reuseSelection = stage.roster_policy
      ? state.roster_selection?.stage_id === stage.id
        ? state.roster_selection
        : state.roster_selections?.[stage.id]
      : undefined;
    const capabilityEpoch = existing?.issued_for.stage_cursor === stage.id
      ? existing.issued_for.cursor_epoch
      : state.cursor_epoch ?? randomUUID();
    let rosterSelection = reuseSelection;
    let slots: ReturnType<typeof resolveStageDispatchSlots> = [];
    let expectedRoster: Array<{ role: string; agent: string; slot_id?: string; semantic_role?: string; occurrence?: number; facet?: string | null }> = [];
    if (kind === "none") {
      slots = [];
    } else if (stage.roster_policy) {
      if (!effectiveConfig.agent_mapping) {
        return rejectTransition(
          `workflow stage '${stage.id}' requires a live registered agent mapping before dispatch; none is trusted for the current configuration (regenerate the agent mapping from host discovery)`,
          state,
        );
      }
      if (requested) {
        if (requested.occurrences.some((occurrence) => "agent" in occurrence)) {
          return rejectTransition(`workflow stage '${stage.id}' accepts only semantic role/facet/reason selections; concrete agent ids are never caller authority`, state);
        }
        if (requested.occurrences.some((occurrence) => typeof occurrence.role !== "string" || occurrence.role.trim() === "")) {
          return rejectTransition(`workflow stage '${stage.id}' roster selection requires a non-empty semantic role for every occurrence`, state);
        }
        const unmapped = [...new Set(requested.occurrences.map((occurrence) => occurrence.role))].filter((role) => !effectiveConfig.agent_mapping?.resolved_roles[role]);
        if (unmapped.length > 0) {
          return rejectTransition(`workflow stage '${stage.id}' selected roles have no live registered agent mapping: ${unmapped.map((role) => `'${role}'`).join(", ")}`, state);
        }
      }
      const frozen = reuseSelection;
      const frozenActive = Boolean(
        frozen
        && frozen.capability_epoch === capabilityEpoch
        && existing?.issued_for.stage_cursor === stage.id
        && existing.status !== "complete"
        && existing.status !== "invalidated",
      );
      if (frozenActive && frozen && requested && !selectionCompositionMatchesFrozen(requested.occurrences, frozen.selected)) {
        return rejectTransition(
          `workflow stage '${stage.id}' roster selection is frozen for the active capability (snapshot '${frozen.snapshot_id}'); a changed selection is rejected — re-issue the identical semantic selection or wait for the capability to complete`,
          state,
        );
      }
      const requestedOccurrences = requested && !frozenActive ? requestedSelectionOccurrences(requested) : undefined;
      const selection = requestedOccurrences
        ? selectRoster(stage, {
            cwd,
            flags,
            resolveDevAgent: () => flags.dev_agent,
            state,
            profile_hash: persistedHash,
            run_key: state.run_key ?? state.branch,
            workflow,
            capability_epoch: capabilityEpoch,
            resolveAgent: (role) => liveRosterAgent(effectiveConfig, role),
            selected_occurrences: requestedOccurrences,
            ...(requested?.rationale !== undefined ? { rationale: requested.rationale } : {}),
            ...(requested?.evidence !== undefined ? { evidence: requested.evidence } : {}),
          } satisfies RosterSelectionContext)
        : reuseSelection && reuseSelection.capability_epoch === capabilityEpoch
          ? {
              ok: true as const,
              selection: reuseSelection,
              slots: reuseSelection.selected.map((entry) => ({ slot: entry.slot_id, slot_id: entry.slot_id, role: entry.role, occurrence: entry.occurrence, facet: entry.facet })),
              expected_roster: reuseSelection.selected.map((entry) => ({ role: entry.slot_id, agent: entry.agent })),
            }
          : selectRoster(stage, {
              cwd,
              flags,
              resolveDevAgent: () => flags.dev_agent,
              state,
              profile_hash: persistedHash,
              run_key: state.run_key ?? state.branch,
              workflow,
              capability_epoch: capabilityEpoch,
              resolveAgent: (role) => liveRosterAgent(effectiveConfig, role),
            } satisfies RosterSelectionContext);
      if (selection.ok === false) return rejectTransition(`workflow stage '${stage.id}' roster selection failed: ${selection.error}`, state);
      rosterSelection = selection.selection;
      slots = selection.slots;
      expectedRoster = selection.expected_roster;
    } else {
      try {
        slots = resolveStageDispatchSlots(stage, { cwd, flags, resolveDevAgent: () => flags.dev_agent });
        for (const slot of slots) {
          const agent = trustedSlotAgent(slot.role, effectiveConfig, trusted.trusted);
          if (agent === null) {
            return rejectTransition(
              `workflow stage '${stage.id}' dispatch roster unresolved: role '${slot.role}' is missing or unavailable in the trusted agent mapping handoff's resolved_roles`,
              state,
            );
          }
          expectedRoster.push({ role: slot.slot, agent });
        }
      } catch (error) {
        return rejectTransition(`workflow stage '${stage.id}' dispatch roster unresolved: ${String(error)}`, state);
      }
    }
    if ((kind === "single" && slots.length !== 1) || (kind === "consilium" && slots.length === 0)) return rejectTransition(`workflow stage '${stage.id}' has an invalid dispatch roster`, state);
    const mappingIssues: Array<{ role: string; diagnostic: AgentMappingDiagnostic }> = [];
    for (const slot of slots) {
      const diagnostic = agentMappingIssueForRole(slot.role, effectiveConfig);
      if (diagnostic) mappingIssues.push({ role: slot.role, diagnostic });
    }
    if (mappingIssues.length > 0) {
      const details = mappingIssues.map(({ role, diagnostic }) => `role '${role}' requested '${diagnostic.requested}' (candidates: ${diagnostic.candidates.join(", ")})`).join("; ");
      return rejectTransition(`workflow stage '${stage.id}' has no available agent mapping: ${details}`, state);
    }

    if (existing && existing.issued_for.stage_cursor === stage.id && existing.issued_for.loop_iteration === stageIteration.iteration && stageEntry.status === "in_progress" && existing.status !== "complete" && existing.status !== "invalidated") {
      const rosterChanged = JSON.stringify(existing.expected_roster) !== JSON.stringify(expectedRoster);
      if (existingDispatches.length > 0 && rosterChanged) return rejectTransition("active dispatch capability roster is inconsistent", state);
      if (!rosterChanged) {
        const reissued = reissueActiveCapability(existing, stageDeclaration.declaration?.policy_hash ?? null);
        const pendingActive = (reissued.state.dispatches ?? []).some((record) => record.status === "pending" || record.status === "running");
        const next: TeamState = {
          ...state,
          ...policyProjectionFor(stageDeclaration.declaration, stage.id, persistedHash),
          run_key: state.run_key ?? state.branch,
          profile_hash: persistedHash,
          cursor_epoch: reissued.state.issued_for!.cursor_epoch,
          stage_cursor: stage.id,
          scope: flags,
          policy: { ...(state.policy ?? {}), strict_orchestrator: true },
          stages: stages.map((entry) => entry.id === stage.id ? { ...entry, status: "in_progress" as const } : entry),
          ...(rosterSelection ? { roster_selection: rosterSelection, roster_selections: { ...(state.roster_selections ?? {}), [stage.id]: rosterSelection } } : {}),
          dispatch_capability: { ...reissued.state, roster_selection: rosterSelection ?? reissued.state.roster_selection },
          pause: pendingActive ? { kind: "background_wait", reason: "provider work remains pending" } : { kind: "none", reason: "" },
          updated_at: now(),
        };
        if (!stageDeclaration.declaration) clearPolicyProjection(next);
        return commitTransition(next, { ok: true, state: next, handoff: handoffFromState(next, { capability_id: reissued.capability_id, dispatch_token: reissued.dispatch_token, advance_token: reissued.advance_token }, stage) });
      }
    }
    const resetState = stageEntry.status === "in_progress" ? state : resetReopenedStageState(state, target, profile, stage.id, existing);
    const retainedDispatches = stageEntry.status === "in_progress" ? existingDispatches : [];
    const issued = createCapability({
      run_key: resetState.run_key ?? resetState.branch,
      branch: resetState.branch,
      workflow,
      profile_hash: persistedHash,
      stage_cursor: stage.id,
      cursor_epoch: capabilityEpoch,
      kind,
      expected_roster: expectedRoster,
      roster_selection: rosterSelection,
      loop_iteration: stageIteration.iteration,
      checkpoint_policy_hash: stageDeclaration.declaration?.policy_hash ?? null,
    });
    // A freshly issued capability starts with no root lifecycle projection.
    // Single dispatch authorization will create the sole valid projection;
    // consilium identities always remain per-dispatch.
    const next: TeamState = {
      ...resetState,
      ...policyProjectionFor(stageDeclaration.declaration, stage.id, persistedHash),
      run_key: resetState.run_key ?? resetState.branch,
      profile_hash: persistedHash,
      cursor_epoch: issued.state.issued_for!.cursor_epoch,
      stage_cursor: stage.id,
      scope: flags,
      policy: { ...(resetState.policy ?? {}), strict_orchestrator: true },
      stages: stages.map((entry) => entry.id === stage.id ? { ...entry, status: "in_progress" as const } : entry),
      ...(rosterSelection ? { roster_selection: rosterSelection, roster_selections: { ...(resetState.roster_selections ?? {}), [stage.id]: rosterSelection } } : {}),
      dispatch_capability: { ...issued.state, status: retainedDispatches.length > 0 ? "dispatched" as const : "ready" as const, dispatches: retainedDispatches },
      pause: { kind: "none", reason: "" },
      updated_at: now(),
    };
    delete next.work_identity;
    delete next.pending;
    delete next.completion_envelope;
    if (!stageDeclaration.declaration) clearPolicyProjection(next);
    return commitTransition(next, {
      ok: true,
      state: next,
      handoff: handoffFromState(next, { capability_id: issued.capability_id, dispatch_token: issued.dispatch_token, advance_token: issued.advance_token }, stage),
    });
  });
}

function auth(cap: ActiveCapability, a: DispatchAuth, secretHash: string): string | null {
  if (!a.capability_id || a.capability_id !== cap.capability_id) return "capability identity mismatch";
  if (!a.token || hash(a.token) !== secretHash) return "invalid secret";
  const b = cap.issued_for;
  if (a.run_key !== b.run_key || a.branch !== b.branch || a.workflow !== b.workflow || !profileHashMatches(b.profile_hash, a.profile_hash) || a.stage_cursor !== b.stage_cursor || a.cursor_epoch !== b.cursor_epoch) return "capability binding mismatch";
  // A modern (loop-scoped) capability requires the caller's iteration
  // binding: omission can never authorize, so an iteration-2 capability
  // cannot be driven by an iteration-less replay. Legacy capabilities
  // without the binding stay verifiable for read/migration callers only.
  if (b.loop_iteration !== undefined && a.loop_iteration !== b.loop_iteration) return "capability binding mismatch";
  return null;
}

function expectedTaskId(cap: ActiveCapability, role: string): string {
  return dispatchTaskId(cap.capability_id, cap.issued_for.run_key, cap.issued_for.branch, cap.issued_for.workflow, cap.issued_for.stage_cursor, role);
}

function authorizeRecord(
  state: TeamState,
  target: ResolvedState,
  cap: ActiveCapability,
  input: DispatchAuth,
): RecordCore {
  if (cap.status === "invalidated" || cap.status === "complete") return rejectTransition("capability invalidated", state);
  const role = input.slot_id ?? input.role ?? "";
  const rosterEntry = cap.expected_roster.find((entry) => entry.role === role);
  if (!rosterEntry) return rejectTransition("role/slot not expected", state);
  if (input.role !== undefined && input.role !== role) return rejectTransition("slot identity mismatch", state);
  if (input.expected_count !== undefined && input.expected_count !== cap.expected_count) return rejectTransition("cardinality mismatch", state);
  const taskId = expectedTaskId(cap, role);
  if (input.task_id !== undefined && input.task_id !== taskId) return rejectTransition("task identity mismatch", state);
  const recordsForRole = cap.dispatches.filter((record) => record.role === role);
  const latest = recordsForRole[recordsForRole.length - 1];
  if (latest && latest.status !== "failed" && latest.status !== "cancelled") {
    const sameTool = Boolean(input.tool_call_id && latest.tool_call_id === input.tool_call_id);
    const sameTask = Boolean(input.task_id && latest.work_identity?.task_id === input.task_id);
    if (sameTask && !latest.tool_call_id && input.tool_call_id) {
      const rebound: DispatchRecord = { ...latest, tool_call_id: input.tool_call_id };
      const reboundState: TeamState = {
        ...state,
        dispatch_capability: { ...cap, dispatches: cap.dispatches.map((candidate) => candidate.id === latest.id ? rebound : candidate) },
        updated_at: now(),
      };
      return commitTransition(reboundState, { ok: true, state: reboundState, record: rebound });
    }
    if ((sameTool || sameTask) && (!input.task_id || latest.work_identity?.task_id === input.task_id)) return replayTransition({ ok: true, state, record: latest });
  }
  if (latest && (!input.retry_of || input.retry_of !== latest.id || (latest.status !== "failed" && latest.status !== "cancelled"))) {
    return rejectTransition("retry requires an explicit terminal failure linkage", state);
  }
  const dispatchId = randomUUID();
  const attempt = latest ? latest.attempt + 1 : 1;
  const identity = workIdentityFor(state, cap, role, rosterEntry.agent, dispatchId, attempt, taskId);
  const pending = pendingFor(identity, "authorized", undefined, undefined, latest?.id ?? null);
  const envelope = completionEnvelopeFor(identity, "pending", null, [], "authorized", "engine_task_caller");
  const record: DispatchRecord = {
    id: dispatchId,
    role,
    agent: rosterEntry.agent,
    tool_call_id: input.tool_call_id,
    status: "authorized",
    attempt,
    created_at: now(),
    work_identity: identity,
    pending,
    completion_envelope: envelope,
  };
  const nextCapability: ActiveCapability = {
    ...cap,
    status: "dispatched",
    dispatches: [...cap.dispatches, record],
    pending: [...(cap.pending ?? []), pending],
  };
  projectCapabilityIdentity(nextCapability, identity);
  const next: TeamState = {
    ...state,
    dispatch_capability: nextCapability,
  };
  projectRootLifecycle(next, cap, { identity, envelope });
  return commitTransition(next, { ok: true, state: next, record });
}

/** Persist authorization before any native task is executed: one cross-process transaction. */
export function authorizeDispatch(cwd: string, authInput: DispatchAuth): TransitionResult {
  return runTransition(cwd, (state, target) => {
    const cap = activeCapability(state.dispatch_capability);
    if (!cap) return rejectTransition("dispatch capability unavailable", state);
    // Authentication runs against the FRESH snapshot under the lock — a
    // concurrent transition that rotated the capability rejects here
    // instead of authorizing against a stale read.
    const error = auth(cap, authInput, cap.dispatch_token_hash);
    if (error) return rejectTransition(error, state);
    const coherence = authorizeCoherenceError(state, cap);
    if (coherence) return rejectTransition(coherence, state);
    return authorizeRecord(state, target, cap, authInput);
  });
}

export interface TrustedDispatchInput {
  capability_id: string;
  run_key: string;
  branch: string;
  workflow: string;
  profile_hash: string;
  stage_cursor: string;
  cursor_epoch: string;
  /** Loop iteration of the live capability binding; present on modern capabilities. */
  loop_iteration?: number;
  role: string;
  slot_id?: string;
  task_id?: string;
  agent: string;
  tool_call_id: string;
  expected_count?: number;
  retry_of?: string;
}

/** Authorize a task after the trusted runtime gate validated its marker: one cross-process transaction. */
export function authorizeDispatchTrusted(cwd: string, input: TrustedDispatchInput): TransitionResult {
  return runTransition(cwd, (state, target) => {
    const cap = activeCapability(state.dispatch_capability);
    if (!cap) return rejectTransition("dispatch capability unavailable", state);
    const binding = cap.issued_for;
    if (
      input.capability_id !== cap.capability_id
      || input.run_key !== binding.run_key
      || input.branch !== binding.branch
      || input.workflow !== binding.workflow
      || input.profile_hash !== binding.profile_hash
      || input.stage_cursor !== binding.stage_cursor
      || input.cursor_epoch !== binding.cursor_epoch
    ) return rejectTransition("capability binding mismatch", state);
    if (!input.tool_call_id) return rejectTransition("tool call identity required", state);
    const coherence = authorizeCoherenceError(state, cap);
    if (coherence) return rejectTransition(coherence, state);
    return authorizeRecord(state, target, cap, {
      token: "__trusted_gate__",
      capability_id: input.capability_id,
      run_key: input.run_key,
      branch: input.branch,
      workflow: input.workflow,
      profile_hash: input.profile_hash,
      stage_cursor: input.stage_cursor,
      cursor_epoch: input.cursor_epoch,
      role: input.role,
      slot_id: input.slot_id,
      task_id: input.task_id,
      agent: input.agent,
      tool_call_id: input.tool_call_id,
      expected_count: input.expected_count,
      retry_of: input.retry_of,
      ...(input.loop_iteration !== undefined ? { loop_iteration: input.loop_iteration } : {}),
    });
  });
}

type CompletionInput = {
  outcome: DispatchCompletion["outcome"];
  evidence: string;
  artifact_ids?: string[];
  completed_by?: DispatchCompletion["completed_by"];
  terminal_signal?: CompletionEnvelope["terminal_signal"];
};

function pendingRecord(
  state: TeamState,
  cap: ActiveCapability,
  record: DispatchRecord,
  reason: PendingState["pending_reason"] = "provider_running",
  providerRef?: string,
): RecordCore {
  if (record.status === "succeeded" || record.status === "failed" || record.status === "cancelled") return rejectTransition("terminal dispatch cannot become pending", state);
  const identity = record.work_identity ?? workIdentityFor(state, cap, record.role, record.agent, record.id, record.attempt);
  const previous = record.pending;
  if (previous?.status === "pending" && previous.provider_ref === providerRef && previous.pending_reason === reason) return replayTransition({ ok: true, state, record });
  if (previous?.status === "pending" && previous.provider_ref !== providerRef) return rejectTransition("conflicting pending replay", state);
  const pending = pendingFor(identity, "pending", reason, providerRef, previous?.retry_of ?? null);
  const envelope = completionEnvelopeFor(identity, "pending", null, [], providerRef ?? reason, "engine_task_caller");
  const updated: DispatchRecord = {
    ...record,
    status: "pending",
    work_identity: identity,
    pending,
    completion_envelope: envelope,
  };
  const nextCapability: ActiveCapability = {
    ...cap,
    status: "dispatched",
    dispatches: cap.dispatches.map((candidate) => candidate.id === record.id ? updated : candidate),
    pending: [...(cap.pending ?? []).filter((candidate) => candidate.identity.dispatch_id !== record.id), pending],
  };
  projectCapabilityIdentity(nextCapability, identity);
  const next: TeamState = {
    ...state,
    dispatch_capability: nextCapability,
    pause: { kind: "background_wait", reason: providerRef ? `provider work pending (${providerRef})` : "provider work remains pending" },
    updated_at: now(),
  };
  projectRootLifecycle(next, cap, { identity, pending, envelope });
  return commitTransition(next, { ok: true, state: next, record: updated });
}

/** Persist a neutral provider-running state: one cross-process transaction. */
export function persistPendingDispatch(
  cwd: string,
  input: DispatchAuth & { dispatch_id: string; pending_reason?: PendingState["pending_reason"]; provider_ref?: string },
): TransitionResult {
  return runTransition(cwd, (state) => {
    const cap = activeCapability(state.dispatch_capability);
    if (!cap) return rejectTransition("dispatch capability unavailable", state);
    const error = auth(cap, input, cap.dispatch_token_hash);
    if (error) return rejectTransition(error, state);
    const coherence = authorizeCoherenceError(state, cap);
    if (coherence) return rejectTransition(coherence, state);
    const record = cap.dispatches.find((candidate) => candidate.id === input.dispatch_id);
    if (!record) return rejectTransition("unknown dispatch", state);
    if (input.role !== undefined && input.role !== record.role) return rejectTransition("dispatch slot mismatch", state);
    return pendingRecord(state, cap, record, input.pending_reason, input.provider_ref);
  });
}

/** Alias retained for adapters that name the transition as a lifecycle update. */
export const markDispatchPending = persistPendingDispatch;

function completeRecord(
  state: TeamState,
  target: ResolvedState,
  cap: ActiveCapability,
  record: DispatchRecord,
  input: CompletionInput,
): RecordCore {
  if (cap.status === "invalidated" || cap.status === "complete") return rejectTransition("capability invalidated", state);
  if (!input.evidence.trim()) return rejectTransition("completion evidence required", state);
  const artifact_ids = input.artifact_ids ?? [];
  const artifactDir = target.artifactsDir ?? "";
  const declaredArtifacts = state.artifacts ?? {};
  const unsafeArtifacts = new Set(artifact_ids).size !== artifact_ids.length || artifact_ids.some((id) => !isSafeStateSegment(id));
  const previousCompletion = record.completion;
  const sameOutcome = previousCompletion?.outcome === input.outcome;
  const sameArtifacts = previousCompletion !== undefined && JSON.stringify(previousCompletion.artifact_ids) === JSON.stringify(artifact_ids);
  const deferredNativeArtifacts = previousCompletion?.completed_by === "synchronous_tool_result"
    && sameOutcome
    && previousCompletion.artifact_ids.length === 0
    && artifact_ids.length > 0;
  const missingArtifacts = artifact_ids.some((id) => !existsSync(join(artifactDir, `${id}.json`)) && !Object.prototype.hasOwnProperty.call(declaredArtifacts, id));
  if (unsafeArtifacts || (missingArtifacts && !deferredNativeArtifacts)) return rejectTransition("declared artifact missing or unsafe", state);
  if (previousCompletion && !(sameOutcome && sameArtifacts) && !deferredNativeArtifacts) return rejectTransition("conflicting replay", state);
  const identity = record.work_identity ?? workIdentityFor(state, cap, record.role, record.agent, record.id, record.attempt);
  const completedBy = input.completed_by ?? "workflow_complete";
  const terminalSignal = input.terminal_signal ?? (completedBy === "synchronous_tool_result" ? "native_tool_result" : "workflow_complete");
  const snapshotted = snapshotSlotArtifacts(state, cap, record, artifact_ids, artifactDir);
  if (snapshotted.ok === false) {
    if (snapshotted.retryable && previousCompletion) {
      const identity = record.work_identity ?? workIdentityFor(state, cap, record.role, record.agent, record.id, record.attempt);
      const deferredCompletion: DispatchCompletion = {
        ...previousCompletion,
        artifact_ids,
        evidence: input.evidence,
        work_identity: identity,
      };
      const deferredEnvelope = completionEnvelopeFor(identity, input.outcome, "native_tool_result", completionArtifactRefs(artifactDir, artifact_ids), input.evidence, "synchronous_tool_result");
      const deferredRecord: DispatchRecord = { ...record, work_identity: identity, completion: deferredCompletion, completion_envelope: deferredEnvelope };
      const deferredCapability: ActiveCapability = {
        ...cap,
        dispatches: cap.dispatches.map((candidate) => candidate.id === record.id ? deferredRecord : candidate),
      };
      projectCapabilityIdentity(deferredCapability, identity);
      const deferredState: TeamState = {
        ...state,
        dispatch_capability: deferredCapability,
        updated_at: now(),
      };
      projectRootLifecycle(deferredState, cap, { identity, envelope: deferredEnvelope });
      return commitTransition(deferredState, { ok: true, state: deferredState, record: deferredRecord });
    }
    return rejectTransition(snapshotted.error, state);
  }
  if (previousCompletion && sameOutcome && sameArtifacts) {
    const replayEnvelope = record.completion_envelope;
    if (!replayEnvelope) return rejectTransition("terminal dispatch completion envelope is missing", state);
    const replayedRecord: DispatchRecord = { ...record, work_identity: identity };
    const replayedCapability: ActiveCapability = {
      ...cap,
      dispatches: cap.dispatches.map((candidate) => candidate.id === record.id ? replayedRecord : candidate),
    };
    projectCapabilityIdentity(replayedCapability, identity);
    const replayedState: TeamState = {
      ...snapshotted.state,
      dispatch_capability: replayedCapability,
      updated_at: now(),
    };
    projectRootLifecycle(replayedState, cap, {
      identity,
      ...(record.pending?.status === "pending" ? { pending: record.pending } : {}),
      envelope: replayEnvelope,
    });
    return commitTransition(replayedState, { ok: true, state: replayedState, record: replayedRecord });
  }
  const completedAt = now();
  const completion: DispatchCompletion = {
    dispatch_id: record.id,
    cursor_epoch: cap.issued_for.cursor_epoch,
    outcome: input.outcome,
    artifact_ids,
    evidence: input.evidence,
    completed_by: completedBy,
    completed_at: completedAt,
    work_identity: identity,
  };
  const envelope = completionEnvelopeFor(identity, input.outcome, terminalSignal, completionArtifactRefs(artifactDir, artifact_ids), input.evidence, completedBy);
  const terminalPending = pendingFor(identity, input.outcome, undefined, undefined, record.pending?.retry_of ?? null);
  const updated: DispatchRecord = {
    ...record,
    status: input.outcome,
    completed_at: completedAt,
    work_identity: identity,
    pending: terminalPending,
    completion,
    completion_envelope: envelope,
  };
  const nextCapability: ActiveCapability = {
    ...cap,
    dispatches: cap.dispatches.map((candidate) => candidate.id === record.id ? updated : candidate),
    pending: [...(cap.pending ?? []).filter((candidate) => candidate.identity.dispatch_id !== record.id), terminalPending],
  };
  projectCapabilityIdentity(nextCapability, identity);
  // A single capability mirrors its sole still-active work item. A consilium
  // never selects one slot as the root identity; its complete lifecycle stays
  // in dispatches/pending and the root projection remains absent.
  const activeRecord = nextCapability.dispatches.find((candidate) =>
    (candidate.status === "pending" || candidate.status === "running")
    && candidate.pending !== undefined
    && candidate.work_identity !== undefined);
  const mirrors = activeRecord && activeRecord.pending && activeRecord.work_identity
    ? {
        identity: activeRecord.work_identity,
        pending: activeRecord.pending,
        envelope: activeRecord.completion_envelope
          ?? completionEnvelopeFor(activeRecord.work_identity, "pending", null, [], "provider work remains pending", "engine_task_caller"),
      }
    : null;
  const next: TeamState = {
    ...snapshotted.state,
    dispatch_capability: nextCapability,
    pause: activeRecord ? { kind: "background_wait", reason: "provider work remains pending" } : { kind: "none", reason: "" },
    updated_at: now(),
  };
  projectRootLifecycle(next, cap, mirrors ?? { identity, envelope });
  return commitTransition(next, { ok: true, state: next, record: updated });
}

/**
 * For multi-slot consilium stages, capture each slot's artifact content into
 * a namespaced snapshot (`<id>-<slot>.json`) at completion time, before a
 * later slot can overwrite the shared file. Recording the same artifact for
 * the same slot twice with different content is a collision and fails
 * closed. The namespaced snapshots are the provenance source for the
 * deterministic synthesis performed at advance.
 */
function snapshotSlotArtifacts(
  state: TeamState,
  cap: ActiveCapability,
  record: DispatchRecord,
  artifactIds: string[],
  artifactsDir: string,
): { ok: true; state: TeamState } | { ok: false; error: string; retryable?: boolean } {
  if (cap.kind !== "consilium" || cap.expected_count <= 1 || artifactIds.length === 0) {
    return { ok: true, state };
  }
  const stageId = cap.issued_for.stage_cursor;
  const existing = state.slot_artifacts?.[stageId] ?? { slots: {} };
  const slots = { ...existing.slots };
  const slotMap = { ...(slots[record.role] ?? {}) };
  const values: Array<{ id: string; value: unknown }> = [];
  for (const id of artifactIds) {
    const value = readArtifact(artifactsDir, id);
    if (value === null) {
      return {
        ok: false,
        retryable: true,
        error: `slot '${record.role}' artifact '${id}' is not readable yet; retry completion or workflow_advance`,
      };
    }
    values.push({ id, value });
  }
  for (const { id, value } of values) {
    const hash = hashValue(value);
    const previous = slotMap[id];
    if (previous && previous.hash !== hash) {
      return { ok: false, error: `slot artifact conflict: slot '${record.role}' wrote '${id}' with different content` };
    }
    // Already slot-scoped ids are the slot's own provenance; only copy the
    // shared-id writes into the namespace before a later slot can clobber.
    const namespaced = isNamespacedArtifactId(id, record.role) ? id : namespacedArtifactId(id, record.role);
    if (namespaced !== id) {
      writeArtifact(artifactsDir, namespaced, value);
    }
    slotMap[id] = { path: join(artifactsDir, `${namespaced}.json`), hash };
  }
  slots[record.role] = slotMap;
  return { ok: true, state: { ...state, slot_artifacts: { ...(state.slot_artifacts ?? {}), [stageId]: { ...existing, slots } } } };
}

function hashValue(value: unknown): string {
  return hash(JSON.stringify(value));
}
export function completeDispatch(cwd: string, input: DispatchAuth & { dispatch_id: string } & Partial<CompletionInput>): TransitionResult {
  return runTransition(cwd, (state, target) => {
    const cap = activeCapability(state.dispatch_capability);
    if (!cap) return rejectTransition("dispatch capability unavailable", state);
    const error = auth(cap, input, cap.dispatch_token_hash);
    if (error) return rejectTransition(error, state);
    const coherence = authorizeCoherenceError(state, cap);
    if (coherence) return rejectTransition(coherence, state);
    const record = cap.dispatches.find((d) => d.id === input.dispatch_id);
    if (!record) return rejectTransition("unknown dispatch", state);
    if (input.role !== undefined && input.role !== record.role) return rejectTransition("dispatch role mismatch", state);
    if (input.slot_id !== undefined && input.slot_id !== record.work_identity?.slot_id && input.slot_id !== record.role) return rejectTransition("dispatch slot mismatch", state);
    if (input.task_id !== undefined && input.task_id !== record.work_identity?.task_id) return rejectTransition("dispatch task mismatch", state);
    if (input.agent !== undefined && input.agent !== record.agent) return rejectTransition("dispatch agent mismatch", state);
    if (input.tool_call_id !== undefined && record.tool_call_id !== undefined && input.tool_call_id !== record.tool_call_id) return rejectTransition("dispatch tool-call mismatch", state);
    if (input.pending === true) return pendingRecord(state, cap, record, input.pending_reason, input.provider_ref);
    if (!input.outcome || !input.evidence) return rejectTransition("terminal completion outcome and evidence are required", state);
    return completeRecord(state, target, cap, record, input as CompletionInput);
  });
}

/** Reconcile a native task result without exposing capability secrets to hooks. */
export function reconcileTrustedTaskResult(cwd: string, input: {
  tool_call_id?: string;
  capability_id?: string;
  cursor_epoch?: string;
  dispatch_id?: string;
  role?: string;
  slot_id?: string;
  task_id?: string;
  work_identity?: WorkIdentity;
  outcome: DispatchCompletion["outcome"];
  evidence: string;
  artifact_ids?: string[];
  pending?: boolean;
  pending_reason?: PendingState["pending_reason"];
  provider_ref?: string;
  terminal_signal?: CompletionEnvelope["terminal_signal"];
}): TransitionResult {
  if (!input.tool_call_id && !input.dispatch_id && !input.work_identity) return { ok: false, error: "dispatch identity required" };
  // Candidate resolution AND the pending/terminal mutation run in ONE
  // transaction: the join below is computed from the freshly persisted
  // dispatch ledger under the lock, never from a pre-lock snapshot.
  return runTransition(cwd, (state, target) => {
    const cap = activeCapability(state.dispatch_capability);
    if (!cap) return rejectTransition("dispatch capability unavailable", state);
    if (input.capability_id && input.capability_id !== cap.capability_id) return rejectTransition("capability identity mismatch", state);
    if (input.cursor_epoch && input.cursor_epoch !== cap.issued_for.cursor_epoch) return rejectTransition("cursor epoch mismatch", state);
    const coherence = authorizeCoherenceError(state, cap);
    if (coherence) return rejectTransition(coherence, state);
    const candidates = cap.dispatches.filter((record) => {
      if (input.dispatch_id && record.id !== input.dispatch_id) return false;
      if (input.tool_call_id && record.tool_call_id !== input.tool_call_id) return false;
      if (input.slot_id && input.slot_id !== record.role && input.slot_id !== record.work_identity?.slot_id) return false;
      if (input.task_id && input.task_id !== record.work_identity?.task_id) return false;
      if (input.work_identity && JSON.stringify(record.work_identity) !== JSON.stringify(input.work_identity)) return false;
      return !record.completion;
    });
    if (candidates.length !== 1) return rejectTransition(candidates.length === 0 ? "unknown or already reconciled dispatch" : "ambiguous positional result", state);
    const record = candidates[0];
    if (!record) return rejectTransition("dispatch result identity disappeared", state);
    if (input.role && input.role !== record.role) return rejectTransition("dispatch role mismatch", state);
    if (input.pending) return pendingRecord(state, cap, record, input.pending_reason, input.provider_ref);
    return completeRecord(state, target, cap, record, {
      outcome: input.outcome,
      evidence: input.evidence,
      artifact_ids: input.artifact_ids,
      completed_by: "synchronous_tool_result",
      terminal_signal: input.terminal_signal ?? "native_tool_result",
    });
  });
}
function stageProduces(stage: StageDef): string[] {
  if (Array.isArray(stage.produces)) return stage.produces;
  return stage.produces ? [stage.produces] : [];
}

/**
 * Native task results are reconciled before the orchestrator can inspect the
 * executor's output, so they intentionally carry no artifact ids. The
 * orchestrator may also bind those ids before a concurrent artifact write is
 * readable. Recover both forms deterministically at the advance boundary.
 * Shared ids are never inferred for a multi-slot consilium: a clobbered shared
 * file cannot prove which slot produced it.
 */
function recoverSynchronousArtifactIds(
  cwd: string,
  state: TeamState,
  target: ResolvedState,
  cap: ActiveCapability,
  stage: StageDef,
): { ok: true; state: TeamState } | { ok: false; error: string } {
  const artifactsDir = target.artifactsDir ?? "";
  const produces = stageProduces(stage);
  const multiSlot = cap.kind === "consilium" && cap.expected_count > 1;
  let recovered = state;
  for (const candidate of cap.dispatches) {
    const completion = candidate.completion;
    if (!completion || completion.completed_by !== "synchronous_tool_result" || completion.outcome !== "succeeded") continue;

    let artifactIds = completion.artifact_ids;
    if (artifactIds.length > 0) {
      // Explicit ids are already bound. Only re-enter completion to create
      // missing consilium snapshots; single-stage artifacts are validated
      // directly by the stage contract below.
      if (!multiSlot) continue;
      const slotMap = recovered.slot_artifacts?.[stage.id]?.slots?.[candidate.role] ?? {};
      const needsSnapshot = artifactIds.some((id) => !slotMap[id]);
      if (!needsSnapshot || !artifactIds.every((id) => readArtifact(artifactsDir, id) !== null)) continue;
    } else {
      artifactIds = multiSlot
        ? produces.map((id) => namespacedArtifactId(id, candidate.role)).filter((id) => readArtifact(artifactsDir, id) !== null)
        : produces.every((id) => readArtifact(artifactsDir, id) !== null) ? produces : [];
      if (artifactIds.length === 0) continue;
    }

    const currentCap = activeCapability(recovered.dispatch_capability);
    if (!currentCap) return { ok: false, error: "dispatch capability disappeared during artifact recovery" };
    const record = currentCap.dispatches.find((entry) => entry.id === candidate.id);
    if (!record) return { ok: false, error: "dispatch disappeared during artifact recovery" };
    const mutation = completeRecord(recovered, target, currentCap, record, {
      outcome: completion.outcome,
      evidence: `${completion.evidence}\nRecovered declared artifact ids at workflow advance.`,
      artifact_ids: artifactIds,
      completed_by: "synchronous_tool_result",
    });
    if (!mutation.result.ok) return { ok: false, error: mutation.result.error };
    if (mutation.write) recovered = mutation.state;
  }
  return { ok: true, state: recovered };
}

function objectArtifact(artifactsDir: string, id: string): Record<string, unknown> | null {
  const value = readArtifact(artifactsDir, id);
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function evaluateStageGate(stage: StageDef, state: TeamState, artifactsDir: string, flags: ScopeFlags): string | null {
  const gate = stage.gate?.trim();
  if (!gate) return null;
  const result = evaluatePredicate(gate, {
    flags,
    artifactsDir,
    state,
    stage,
    namedGate: (name) => {
      const named = NAMED_GATES[name];
      return named ? named(state, artifactsDir) : undefined;
    },
  });
  if (!result.ok) return result.error;
  // The named gate's concrete failure reason rides on the unsatisfied
  // result; preserve it so workflow_advance rejects with the real cause
  // instead of a generic "not satisfied" message.
  return result.value ? null : `gate '${gate}' is not satisfied${result.detail ? `: ${result.detail}` : ""}`;
}

/** Named gates are plain identifiers resolved by the predicate evaluator. */
const NAMED_GATES: Record<string, (state: TeamState, artifactsDir: string) => string | null> = {
  branch_created: (state) => (state.branch.trim() ? null : "branch_created gate requires a persisted branch"),
  root_cause_documented: (_state, artifactsDir) => {
    const result = isRootCauseDocumented(artifactsDir);
    return result.ok ? null : result.reason;
  },
  dod_complete: (_state, artifactsDir) => {
    const result = isDoDComplete(readDoD(artifactsDir));
    return result.ok ? null : `dod_complete gate is not satisfied (${result.pending.length} pending items)`;
  },
  plan_valid: (_state, artifactsDir) => {
    const plan = objectArtifact(artifactsDir, "team_plan");
    return plan && Array.isArray(plan.teams) && plan.teams.length > 0 ? null : "plan_valid gate requires a non-empty team_plan.teams array";
  },
  contract_complete: (_state, artifactsDir) => {
    const architecture = objectArtifact(artifactsDir, "architecture");
    return architecture && Array.isArray(architecture.options) && architecture.options.length > 0 && typeof architecture.chosen === "string" && architecture.chosen.trim() ? null : "contract_complete gate requires architecture options and a chosen option";
  },
  feature_spec_present: (_state, artifactsDir) => {
    const spec = objectArtifact(artifactsDir, "feature_spec");
    return spec && typeof spec.goal === "string" && spec.goal.trim() && Array.isArray(spec.acceptance_criteria) && spec.acceptance_criteria.length > 0 ? null : "feature_spec_present gate requires a goal and acceptance criteria";
  },
  tests_passed: (_state, artifactsDir) => {
    const tests = objectArtifact(artifactsDir, "qa_tests");
    return tests?.build_status === "pass" ? null : "tests_passed gate requires qa_tests.build_status=pass";
  },
  /**
   * Product approval gate. The approval stage consumes its current immutable
   * scope. The later handoff consumes the exact decision generation stamped
   * into product_approval_record when that approval stage committed.
   */
  product_approval_recorded: (state, artifactsDir) => {
    const PRODUCT_APPROVAL_STAGE = "product_approval";
    const PRODUCT_DECISIONS = ["proceed", "needs_more_validation", "defer", "reject"];
    const profile = loadProfile(state.classification?.workflow ?? "");
    const productStage = profile?.stages.find((candidate) => candidate.id === PRODUCT_APPROVAL_STAGE);
    if (!profile || !productStage) return "product_approval_recorded gate: declaring product_approval stage is unavailable";
    const declaration = resolveCheckpointDeclaration(productStage, profile.checkpoint_policy ?? null, state, "authorize");
    if (!declaration.ok || !declaration.declaration) {
      return `product_approval_recorded gate: product approval declaration is invalid${declaration.ok ? "" : `: ${declaration.error}`}`;
    }

    let decision: CheckpointDecision | TypedCheckpointDecision | null = null;
    if (state.stage_cursor === PRODUCT_APPROVAL_STAGE) {
      const current = validateCheckpointForAdvance(productStage, state, declaration.declaration);
      if (!current.ok) return `product_approval_recorded gate: ${current.error}`;
      decision = current.decision;
    } else {
      const artifact = objectArtifact(artifactsDir, "product_approval_record");
      const decisionKey = artifact?.checkpoint_decision_key;
      if (typeof decisionKey !== "string" || !decisionKey) {
        return "product_approval_recorded gate: completed product_approval_record is missing its exact checkpoint_decision_key generation binding";
      }
      const historical = findHistoricalCheckpointDecision(state, declaration.declaration, { decision_key: decisionKey });
      if (!historical.ok) return `product_approval_recorded gate: ${historical.error}`;
      decision = historical.decision;
    }
    if (!decision) {
      return "product_approval_recorded gate: no durable decision recorded for checkpoint 'product_approval' (stage 'product_approval'); the product owner must answer via workflow_checkpoint with checkpoint_kind=product_approval, authorization=human, and actor_provenance bound to the product-owner answer; decision exactly one of proceed | needs_more_validation | defer | reject — no inferred consent";
    }
    const authorization = "authorization" in decision ? decision.authorization : decision.mode === "interactive" ? "human" : "policy_auto";
    if (authorization !== "human") {
      return "product_approval_recorded gate: checkpoint 'product_approval' was not recorded with interactive human authorization; autonomous decisions are rejected";
    }
    if (!PRODUCT_DECISIONS.includes(decision.decision)) {
      return `product_approval_recorded gate: decision '${decision.decision}' is not one of the four allowed product approval decisions (proceed | needs_more_validation | defer | reject)`;
    }
    return null;
  },
};

type StageCompletionResult = { ok: true; notes: string[] } | { ok: false; error: string };

/**
 * Executable artifact contract policy for durable advance. Additive and
 * compatibility-first: the shipped default validates every schema-defined
 * artifact with no grandfathering; legacy artifacts can be grandfathered
 * explicitly via {@link setArtifactContractPolicy}.
 */
let artifactContractPolicy: ArtifactContractPolicy = DEFAULT_ARTIFACT_CONTRACT_POLICY;

/** Override the artifact contract policy (e.g. explicit legacy grandfathering). */
export function setArtifactContractPolicy(policy: ArtifactContractPolicy): void {
  artifactContractPolicy = policy;
}

/** Fan-in policy for multi-slot consilium synthesis. */
let fanInPolicy: FanInPolicy = DEFAULT_FAN_IN_POLICY;

/** Override the consilium fan-in policy. */
export function setFanInPolicy(policy: FanInPolicy): void {
  fanInPolicy = policy;
}

function bindCompletedProductApprovalGeneration(
  stage: StageDef,
  state: TeamState,
  target: ResolvedState,
  profile: NonNullable<ReturnType<typeof loadProfile>>,
): { ok: true } | { ok: false; error: string } {
  if (stage.id !== "product_approval" || stage.checkpoint !== "product_approval") return { ok: true };
  if (!target.artifactsDir) return { ok: false, error: "product approval artifacts directory is unavailable" };
  const declaration = resolveCheckpointDeclaration(stage, profile.checkpoint_policy, state, "authorize");
  if (!declaration.ok || !declaration.declaration) {
    return { ok: false, error: `product approval declaration is invalid${declaration.ok ? "" : `: ${declaration.error}`}` };
  }
  const current = validateCheckpointForAdvance(stage, state, declaration.declaration);
  if (!current.ok) return { ok: false, error: current.error };
  const artifact = objectArtifact(target.artifactsDir, "product_approval_record");
  if (!artifact) return { ok: false, error: "product_approval_record artifact is missing" };
  if (artifact.decision !== current.decision.decision) {
    return { ok: false, error: "product_approval_record decision does not match the current durable checkpoint decision" };
  }
  writeArtifact(target.artifactsDir, "product_approval_record", {
    ...artifact,
    checkpoint_decision_key: checkpointDecisionKey(current.decision),
    checkpoint_run_id: current.decision.run_id,
    checkpoint_capability_id: current.decision.capability_id,
    checkpoint_capability_epoch: current.decision.capability_epoch,
    checkpoint_loop_iteration: current.decision.loop_iteration,
    checkpoint_policy_hash: current.decision.policy_hash,
  });
  return { ok: true };
}

function validateStageCompletion(
  stage: StageDef,
  state: TeamState,
  target: ResolvedState,
  evidence: string,
  flags: ScopeFlags,
  profile: NonNullable<ReturnType<typeof loadProfile>>,
): StageCompletionResult {
  if (!evidence.trim()) return { ok: false, error: "stage completion evidence required" };
  const artifactsDir = target.artifactsDir ?? "";
  for (const id of stageProduces(stage)) {
    if (!isSafeStateSegment(id)) return { ok: false, error: `unsafe stage artifact id '${id}'` };
    const value = readArtifact(artifactsDir, id);
    if (value === null) return { ok: false, error: `required stage artifact '${id}.json' is missing or invalid` };
    const validated = validateProducedArtifact(id, value, artifactContractPolicy);
    if (!validated.ok) {
      return {
        ok: false,
        error: `produced artifact '${id}' violates its contract: ${validated.issues.map((issue) => `${issue.field}: ${issue.message}`).join("; ")}`,
      };
    }
  }
  const consumed = validateConsumedArtifacts(stage, artifactsDir, state, profile, artifactContractPolicy);
  if (!consumed.ok) return { ok: false, error: consumed.error };
  const validation = validationGate({ cwd: target.stateDir ?? "", stageId: stage.id, artifactsDir, produces: stage.produces });
  if (!validation.ok) return { ok: false, error: validation.reason };
  const gateError = evaluateStageGate(stage, state, artifactsDir, flags);
  if (gateError) return { ok: false, error: gateError };
  const notes = consumed.diagnostics
    .filter((diagnostic) => diagnostic.missing && diagnostic.issues.length === 0)
    .map((diagnostic) => `consumed artifact '${diagnostic.id}' is absent (producer ${diagnostic.producer_status ?? "unknown"})`);
  return { ok: true, notes };
}

/**
 * Executable `document` stage render at the durable advance boundary: the
 * engine — not an agent — renders the declared document from the stage's
 * declared sources and persists the document plus the typed artifact.
 * Fail-closed: a missing source, an unsupported contract or an unsafe
 * path blocks the transition before anything is marked done.
 */
function renderStageDocument(stage: StageDef, target: ResolvedState): { ok: true } | { ok: false; error: string } {
  const contract = stage.document;
  if (!contract) return { ok: false, error: `document stage '${stage.id}' is missing its document declaration` };
  if (contract.format !== "markdown" || contract.renderer !== "product-prd") {
    return { ok: false, error: `document stage '${stage.id}' declares an unsupported document contract (format '${contract.format}', renderer '${contract.renderer}')` };
  }
  const artifactsDir = target.artifactsDir;
  if (!artifactsDir) return { ok: false, error: `document stage '${stage.id}': artifacts dir unavailable` };
  const sourceArtifacts: Record<string, unknown> = {};
  for (const id of PRD_SOURCE_ARTIFACT_IDS) {
    const artifact = readArtifact(artifactsDir, id);
    if (artifact === null) return { ok: false, error: `document stage '${stage.id}': source artifact '${id}.json' not found` };
    sourceArtifacts[id] = artifact;
  }
  const written = writeProductPrdDocument({
    stateDir: dirname(artifactsDir),
    artifactsDir,
    path: contract.path,
    sourceArtifacts,
  });
  if (!written.ok) return { ok: false, error: `document stage '${stage.id}' render failed: ${written.error}` };
  return { ok: true };
}

export function advanceCursor(cwd: string, input: DispatchAuth, options?: TrustedMappingOptions): TransitionResult {
  // One cross-process transaction: authentication, capability validation and
  // the join/advance/re-entry decision all run against the freshly persisted
  // state under the lock; handoff secrets are derived from the committed
  // state and the commit is CAS-guarded.
  return runTransition(cwd, (rawState, target) => {
  const cap = activeCapability(rawState.dispatch_capability);
  if (!cap) return rejectTransition("dispatch capability unavailable", rawState);
  const error = auth(cap, input, cap.advance_token_hash);
  if (error) return rejectTransition(error, rawState);
  if (cap.status === "invalidated" || cap.status === "complete") return rejectTransition("capability invalidated", rawState);
  const coherence = authorizeCoherenceError(rawState, cap);
  if (coherence) return rejectTransition(coherence, rawState);
  if (input.cursor_epoch !== cap.issued_for.cursor_epoch || rawState.stage_cursor !== cap.issued_for.stage_cursor || rawState.cursor_epoch !== cap.issued_for.cursor_epoch) return rejectTransition("stale cursor binding", rawState);
  if (typeof input.evidence !== "string" || !input.evidence.trim()) return rejectTransition("stage advancement evidence required", rawState);
  const profile = loadProfile(cap.issued_for.workflow);
  if (!profile || profileHash(profile) !== cap.issued_for.profile_hash) return rejectTransition("workflow profile is missing or stale", rawState);
  const currentStage = profile.stages.find((candidate) => candidate.id === rawState.stage_cursor);
  if (!currentStage) return rejectTransition("current workflow stage unavailable", rawState);

  const config = resolveConfig(cwd);
  const trusted = bindTrustedMapping(config, options?.trustedMapping);
  if (!trusted.ok) return rejectTransition(trusted.error, rawState);
  const effectiveConfig = trusted.config;
  const flags = rawState.scope ?? resolveScope([], config);
  const recovered = recoverSynchronousArtifactIds(cwd, rawState, target, cap, currentStage);
  if (!recovered.ok) return rejectTransition(recovered.error, rawState);
  let state = recovered.state;

  // Join by the persisted slot identity, never by array position or provider
  // result order. A retry replaces only the same slot's terminal record.
  const joinCap = activeCapability(state.dispatch_capability) ?? cap;
  const expected = new Set(joinCap.expected_roles);
  const latest = new Map<string, DispatchRecord>();
  for (const record of joinCap.dispatches) {
    const prior = latest.get(record.role);
    if (!prior || record.attempt > prior.attempt) latest.set(record.role, record);
  }
  const records = Array.from(latest.values()).sort((left, right) => left.role.localeCompare(right.role));
  const incomplete = records.some((record) => !expected.has(record.role) || record.status !== "succeeded")
    || records.length !== joinCap.expected_count
    || joinCap.expected_roles.some((role) => !latest.has(role));
  if (incomplete) {
    const pending = records.find((record) => record.status === "pending")?.pending ?? state.pending;
    if (pending) {
      const pendingState: TeamState = {
        ...state,
        pending,
        pause: { kind: "background_wait", reason: "dispatch join remains pending" },
        updated_at: now(),
      };
      return commitTransition(pendingState, { ok: false, error: "dispatch join pending", state: pendingState });
    }
    return rejectTransition("dispatch join incomplete", state);
  }
  const joinSummary = {
    stage_id: rawState.stage_cursor,
    cursor_epoch: cap.issued_for.cursor_epoch,
    dispatch_ids: records.map((r) => r.id),
    roles: records.map((r) => r.role),
    evidence: input.evidence.trim(),
    joined_at: now(),
  };

  // Fan-in: deterministically synthesize multi-slot consilium results into
  // the stable shared artifact ids before any validation or handoff. Missing
  // slot results and collisions fail closed; schema-required scalar
  // disagreements block by default (strict) unless the stage declares an
  // explicit, documented resolution — every applied resolution is recorded
  // in the synthesis provenance (`conflicts`).
  const isMultiSlotConsilium = cap.kind === "consilium" && cap.expected_count > 1;
  if (isMultiSlotConsilium) {
    const currentRecords = activeCapability(state.dispatch_capability)?.dispatches ?? records;
    const withoutArtifacts = currentRecords
      .filter((record) => record.status === "succeeded" && (record.completion?.artifact_ids.length ?? 0) === 0)
      .map((record) => `${record.role} (${namespacedArtifactId(stageProduces(currentStage)[0] ?? "artifact", record.role)})`);
    if (withoutArtifacts.length > 0) {
      return rejectTransition(`consilium fan-in incomplete: dispatches without recorded artifact_ids: ${withoutArtifacts.join(", ")}; call workflow_complete with each slot's artifact ids before workflow_advance`, state);
    }
  }
  if (isMultiSlotConsilium) {
    const policy: FanInPolicy = {
      ...fanInPolicy,
      resolutions: [...(fanInPolicy.resolutions ?? []), ...(currentStage.fan_in?.resolutions ?? [])],
    };
    const synthesized = synthesizeArtifacts(
      state,
      currentStage.id,
      target.artifactsDir ?? "",
      stageProduces(currentStage),
      cap.expected_roster.map((entry) => entry.role),
      policy,
    );
    if (!synthesized.ok) return rejectTransition(synthesized.error, state);
    state = synthesized.state;
  }

  // Executable document stage: the engine renders the declared document
  // from the stage's declared sources BEFORE the completion validation
  // commits the transition — the native /do-work path never depends on an
  // agent having rendered it, and a failed render fails the advance closed.
  if (currentStage.type === "document") {
    const rendered = renderStageDocument(currentStage, target);
    if (!rendered.ok) return rejectTransition(rendered.error, state);
  }

  // Stage completion validation: consumes, produces, schema contracts, the
  // validation gate and the gate expression all fail closed.
  const completion = validateStageCompletion(currentStage, state, target, input.evidence, flags, profile);
  if (!completion.ok) return rejectTransition(completion.error, state);

  // Unresolved declared checkpoints block advance. The durable pause kind is
  // committed in the same transaction so adapters observe it after a
  // concurrent transition, too.
  const checkpointError = unresolvedCheckpointError(currentStage, state);
  if (checkpointError) {
    return commitTransition(state, { ok: false, error: checkpointError, state });
  }
  const approvalBinding = bindCompletedProductApprovalGeneration(currentStage, state, target, profile);
  if (!approvalBinding.ok) return rejectTransition(approvalBinding.error, state);


  // Bounded loop: evaluate `until`; re-enter `back_to` with a fresh
  // epoch/capability or map exhaustion to needs_human/failed.
  if (currentStage.loop) {
    const until = evaluatePredicate(currentStage.loop.until, {
      flags,
      artifactsDir: target.artifactsDir ?? "",
      state,
      stage: currentStage,
    });
    if (!until.ok) return rejectTransition(`loop until evaluation failed: ${until.error}`, state);
    if (!until.value) {
      const loop = loopStateFor(state, currentStage.id);
      const decision = loopReentryDecision(loop, currentStage.loop.max_iterations);
      if (decision.exhausted) {
        const kind = loopExhaustionKind(currentStage.loop.on_exhausted);
        const exhausted: LoopState = {
          ...(loop ?? { reentries: 0, history: [], epoch: cap.issued_for.cursor_epoch }),
          stage_id: currentStage.id,
          back_to: currentStage.loop.back_to,
          until: currentStage.loop.until,
          max_iterations: currentStage.loop.max_iterations,
          on_exhausted: currentStage.loop.on_exhausted,
          status: "exhausted",
          outcome: kind,
          ended_at: now(),
        };
        const next: TeamState = {
          ...state,
          loop_state: exhausted,
          pause: { kind, reason: `loop '${currentStage.id}' exhausted after ${currentStage.loop.max_iterations} iteration(s)` },
          stages: state.stages.map((s) => (s.id === currentStage.id ? { ...s, status: "done" as const } : s)),
          join_summary: joinSummary,
          dispatch_capability: { ...cap, status: "complete" as const, dispatches: [] },
          updated_at: now(),
        };
        return commitTransition(next, { ok: true, state: next });
      }
      return reenterLoop(cwd, state, target, profile, cap, currentStage, records, joinSummary, decision.reentries, flags, effectiveConfig, trusted.trusted);
    }
    const existingLoop = loopStateFor(state, currentStage.id);
    if (existingLoop) {
      state = { ...state, loop_state: { ...existingLoop, status: "complete" as const, ended_at: now() } };
    }
  }

  const index = state.stages.findIndex((s) => s.id === state.stage_cursor);
  if (index < 0) return rejectTransition("current workflow stage unavailable", state);

  // Skip-aware advance (WF-3): evaluate every consecutive next stage's
  // `skip_if` with the same fail-closed predicate evaluator the interpreter
  // uses before arming a capability. A stage whose skip_if holds is marked
  // terminal `skipped` and is never armed or counted as an expected
  // dispatch; the first runnable stage is armed atomically under this
  // advance token. Malformed or unsupported skip expressions fail closed —
  // they block advance instead of silently skipping or silently running.
  const skippedStageIds: string[] = [];
  let nextStage: StageDef | undefined;
  for (let i = index + 1; i < state.stages.length; i += 1) {
    const entry = state.stages[i];
    const candidate = entry ? profile.stages.find((s) => s.id === entry.id) : undefined;
    if (entry && !candidate) return rejectTransition("next workflow stage unavailable", state);
    if (!entry || !candidate) break;
    if (candidate.skip_if) {
      const skip = evaluatePredicate(candidate.skip_if, {
        flags,
        artifactsDir: target.artifactsDir ?? "",
        state,
        stage: candidate,
      });
      if (!skip.ok) {
        return rejectTransition(`next stage '${candidate.id}' skip_if evaluation failed: ${skip.error}`, state);
      }
      if (skip.value) {
        skippedStageIds.push(candidate.id);
        continue;
      }
    }
    nextStage = candidate;
    break;
  }
  // The cursor epoch rotates ONLY when a next stage is armed: a terminal
  // advance keeps the completed capability's epoch so the strict
  // state<->capability binding stays coherent (rotating without a next
  // stage would leave the completed capability carrying a stale issued
  // epoch that no new capability ever replaces).
  const epoch = nextStage ? randomUUID() : cap.issued_for.cursor_epoch;
  let handoffSecrets: { capability_id: string; dispatch_token: string; advance_token: string } | undefined;
  // Automatic capability issuance during advance never freezes a roster for
  // a roster-policy stage: such a next stage stays semantically unselected
  // and pending until its explicit workflow_begin freezes a selection from
  // the trusted or persisted live registered mapping. Only a non-roster
  // stage — executable, or an orchestrator shell — is atomically armed here.
  let armedStage: StageDef | undefined;
  const { roster_selection: _completedSelection, ...completedCap } = cap;
  let nextCap: NonNullable<TeamState["dispatch_capability"]> = { ...completedCap, status: "complete" as const, dispatches: [] };
  // The next stage's own declaration is authoritative from the moment the
  // cursor moves: the policy binding is re-projected (or cleared) for it in
  // the same transaction, and the armed capability carries its policy hash
  // and loop iteration. A prior-stage policy can neither authorize nor block.
  let nextDeclaration: CheckpointDeclarationResolution = { ok: true, declaration: null };
  let nextIteration = 1;
  if (nextStage) {
    const iteration = loopIterationForStage(state, profile, nextStage.id);
    if (!iteration.ok) return rejectTransition(iteration.error, state);
    nextIteration = iteration.iteration;
    const declaration = resolveCheckpointDeclaration(nextStage, profile.checkpoint_policy, state, "rebind");
    if (!declaration.ok) return rejectTransition(`${declaration.code}: ${declaration.error}`, state);
    nextDeclaration = declaration;
  }
  if (nextStage) {
    const nextKind: "none" | "single" | "consilium" =
      nextStage.type === "single" || nextStage.type === "consilium" ? nextStage.type : "none";
    if (!nextStage.roster_policy) {
      let slots: ReturnType<typeof resolveStageDispatchSlots> = [];
      let expectedRoster: Array<{ role: string; agent: string; slot_id?: string; semantic_role?: string; occurrence?: number; facet?: string | null }> = [];
      if (nextKind !== "none") {
        try {
          slots = resolveStageDispatchSlots(nextStage, { cwd, flags, resolveDevAgent: () => flags.dev_agent, state });
          for (const slot of slots) {
            const agent = trustedSlotAgent(slot.role, effectiveConfig, trusted.trusted);
            if (agent === null) {
              return rejectTransition(`next stage '${nextStage.id}' dispatch roster unresolved: role '${slot.role}' is missing or unavailable in the trusted agent mapping handoff's resolved_roles`, state);
            }
            expectedRoster.push({ role: slot.slot, agent });
          }
        } catch (error) {
          return rejectTransition(`next stage '${nextStage.id}' dispatch roster unresolved: ${String(error)}`, state);
        }
        if ((nextKind === "single" && slots.length !== 1) || (nextKind === "consilium" && slots.length === 0)) {
          return rejectTransition(`next stage '${nextStage.id}' has an invalid dispatch roster`, state);
        }
      }
      const issued = createCapability({
        run_key: cap.issued_for.run_key,
        branch: cap.issued_for.branch,
        workflow: cap.issued_for.workflow,
        profile_hash: cap.issued_for.profile_hash,
        stage_cursor: nextStage.id,
        cursor_epoch: epoch,
        kind: nextKind,
        expected_roster: expectedRoster,
        loop_iteration: nextIteration,
        checkpoint_policy_hash: nextDeclaration.declaration?.policy_hash ?? null,
      });
      nextCap = issued.state;
      armedStage = nextStage;
      handoffSecrets = { capability_id: issued.capability_id, dispatch_token: issued.dispatch_token, advance_token: issued.advance_token };
    }
  }
  // Deferral/completion masking: a frozen selection is data of the stage it
  // was frozen for. When the cursor leaves that stage the top-level mirror
  // is dropped (the per-stage `roster_selections` history retains it), so a
  // prior stage's selection can never leak into a later stage's contract.
  const priorSelection = state.roster_selection;
  const selectionStays = Boolean(priorSelection && nextStage && priorSelection.stage_id === nextStage.id);
  const { roster_selection: _carriedSelection, ...carriedState } = state;
  const identityStage = nextStage?.id ?? state.stage_cursor;
  const next: TeamState = {
    ...carriedState,
    ...policyProjectionFor(nextDeclaration.declaration, nextStage?.id ?? "", cap.issued_for.profile_hash),
    stage_cursor: nextStage?.id ?? state.stage_cursor,
    cursor_epoch: epoch,
    // Only an atomically armed non-roster capability coexists with an
    // in_progress stage cursor. A deferred roster-policy next stage stays
    // pending — nothing can dispatch against it until workflow_begin arms
    // the selected capability. Consecutive skip_if stages are marked
    // terminal `skipped` in the same update; they are never armed.
    stages: state.stages.map((s) => {
      if (s.id === state.stage_cursor) return { ...s, status: "done" as const };
      if (skippedStageIds.includes(s.id)) return { ...s, status: "skipped" as const };
      if (armedStage && s.id === armedStage.id) return { ...s, status: "in_progress" as const };
      return s;
    }),
    join_summary: joinSummary,
    ...(selectionStays && priorSelection ? { roster_selection: priorSelection } : {}),
    dispatch_capability: nextCap,
    // A successful cursor move starts the next stage with a clean
    // lifecycle: the prior stage's pause/pending/completion mirrors are
    // cleared below, so a resolved checkpoint or provider wait can never
    // report the NEXT stage as paused or pending.
    pause: nextStage ? { kind: "none", reason: "" } : { kind: "done", reason: "" },
  };
  // Deliberate mirror resets of the cursor move — all by key deletion, never
  // own undefined:
  //   - a stale prior-stage identity can never bind the next stage's proofs;
  //   - a no-declaration next stage carries no policy mirror at all;
  //   - pending/completion describe the JOINED dispatches of the completed
  //     epoch and are re-derived by the next stage's own transitions.
  if (state.work_identity && state.work_identity.stage_id !== identityStage) delete next.work_identity;
  if (!nextDeclaration.declaration) clearPolicyProjection(next);
  if (nextStage && nextStage.roster_policy) {
    // Deferred roster stage: NO capability is left behind. The completed
    // capability of the prior stage binds the PRIOR stage/epoch, so strict
    // state<->capability coherence would reject it and workflow_begin could
    // never issue the stage's real capability — a deferred stage must be
    // startable via workflow_begin after the cursor move.
    delete next.dispatch_capability;
  }
  delete next.pending;
  delete next.completion_envelope;
  return commitTransition(next, { ok: true, state: next, handoff: armedStage && handoffSecrets ? handoffFromState(next, handoffSecrets, armedStage) : undefined });
  });
}

/**
 * Loop re-entry: point the cursor back at the loop's `back_to` stage and
 * rotate to a fresh cursor epoch. Old epochs can never authorize a
 * re-entered iteration — the durable binding rotates with every loop-back.
 * Iteration history is appended durably. An executable non-roster target is
 * armed immediately; a roster-policy target stays semantically unselected
 * and pending until its explicit workflow_begin freezes the iteration's
 * roster from the trusted or persisted live mapping.
 */
function reenterLoop(
  cwd: string,
  state: TeamState,
  target: ResolvedState,
  profile: NonNullable<ReturnType<typeof loadProfile>>,
  cap: ActiveCapability,
  currentStage: StageDef,
  records: DispatchRecord[],
  joinSummary: TeamState["join_summary"],
  reentries: number,
  flags: ScopeFlags,
  config: ResolvedConfig,
  trusted: boolean,
): RecordCore {
  const loop = currentStage.loop!;
  const backToStage = resolveBackToStage(profile, loop.back_to);
  if (!backToStage) return rejectTransition(`loop back_to '${loop.back_to}' is not a stage in the profile`, state);
  const kind: "none" | "single" | "consilium" =
    backToStage.type === "single" || backToStage.type === "consilium" ? backToStage.type : "none";
  const epoch = randomUUID();
  // Same invariant as the linear advance path: a roster-policy loop target
  // is never roster-resolved here. Re-entry rotates the cursor epoch,
  // records the iteration history, and parks the stage pending until its
  // explicit workflow_begin freezes the iteration's selection.
  const deferredRoster = kind !== "none" && !!backToStage.roster_policy;
  let rosterSelection: TeamState["roster_selection"];
  let slots: ReturnType<typeof resolveStageDispatchSlots> = [];
  let expectedRoster: Array<{ role: string; agent: string; slot_id?: string; semantic_role?: string; occurrence?: number; facet?: string | null }> = [];
  if (!deferredRoster && kind !== "none") {
    try {
      slots = resolveStageDispatchSlots(backToStage, { cwd, flags, resolveDevAgent: () => flags.dev_agent, state });
      for (const slot of slots) {
        const agent = trustedSlotAgent(slot.role, config, trusted);
        if (agent === null) {
          return rejectTransition(`loop target stage '${backToStage.id}' dispatch roster unresolved: role '${slot.role}' is missing or unavailable in the trusted agent mapping handoff's resolved_roles`, state);
        }
        expectedRoster.push({ role: slot.slot, agent });
      }
    } catch (error) {
      return rejectTransition(`loop target stage '${backToStage.id}' dispatch roster unresolved: ${String(error)}`, state);
    }
  }
  if (!deferredRoster && ((kind === "single" && slots.length !== 1) || (kind === "consilium" && slots.length === 0))) {
    return rejectTransition(`loop target stage '${backToStage.id}' has an invalid dispatch roster`, state);
  }
  // Historical re-entry count vs execution iteration: `reentriesAfter`
  // counts the loop-backs PERFORMED (including this one) and is what
  // `loop_state.reentries` stores; the window then executes in iteration
  // `loop_state.reentries + 1` (`loopIterationForStage`), so the issued
  // capability, the handoff, the ledger scope and the active window can
  // never disagree — the first re-entry arms iteration 2, the second
  // iteration 3, and so on.
  const reentriesAfter = reentries + 1;
  const iteration = reentriesAfter + 1;
  const backDeclaration = resolveCheckpointDeclaration(backToStage, profile.checkpoint_policy, state, "rebind");
  if (!backDeclaration.ok) return rejectTransition(`${backDeclaration.code}: ${backDeclaration.error}`, state);
  const issued = deferredRoster
    ? undefined
    : createCapability({
        run_key: cap.issued_for.run_key,
        branch: cap.issued_for.branch,
        workflow: cap.issued_for.workflow,
        profile_hash: cap.issued_for.profile_hash,
        stage_cursor: backToStage.id,
        cursor_epoch: epoch,
        kind,
        expected_roster: expectedRoster,
        roster_selection: rosterSelection,
        loop_iteration: iteration,
        checkpoint_policy_hash: backDeclaration.declaration?.policy_hash ?? null,
      });
  const loopState: LoopState = {
    stage_id: currentStage.id,
    back_to: loop.back_to,
    until: loop.until,
    max_iterations: loop.max_iterations,
    on_exhausted: loop.on_exhausted,
    reentries: reentriesAfter,
    epoch,
    status: "running",
    history: [
      ...(loopStateFor(state, currentStage.id)?.history ?? []),
      loopIterationRecord(iteration, cap.issued_for.cursor_epoch, epoch, false),
    ],
  };
  // Masking mirrors the linear advance: the completed iteration's frozen
  // selection belongs to the stage it was frozen for and is dropped from
  // both the state mirror and the completed capability. The per-stage
  // `roster_selections` history retains it for audit.
  const priorLoopSelection = state.roster_selection?.stage_id === backToStage.id ? state.roster_selection : undefined;
  const { roster_selection: _carriedLoopSelection, ...carriedLoopState } = state;
  const { roster_selection: _completedLoopSelection, ...completedLoopCap } = cap;
  const next: TeamState = {
    ...carriedLoopState,
    ...policyProjectionFor(backDeclaration.declaration, backToStage.id, cap.issued_for.profile_hash),
    stage_cursor: backToStage.id,
    cursor_epoch: epoch,
    loop_state: loopState,
    stages: state.stages.map((s) =>
      s.id === currentStage.id
        ? { ...s, status: "done" as const }
        : s.id === backToStage.id
          ? deferredRoster
            ? { ...s, status: "pending" as const }
            : { ...s, status: "in_progress" as const }
          : s,
    ),
    join_summary: joinSummary,
    ...(priorLoopSelection ? { roster_selection: priorLoopSelection } : {}),
    dispatch_capability: issued
      ? { ...issued.state, status: "ready" as const, dispatches: [] }
      : { ...completedLoopCap, status: "complete" as const, dispatches: [] },
    // The re-entered iteration starts clean: the previous iteration's pause
    // (e.g. a resolved user_checkpoint) never reports the new iteration as
    // paused.
    pause: { kind: "none", reason: "" },
    updated_at: now(),
  };
  // A re-entered iteration rebinds identity from scratch: a prior stage's
  // top-level work_identity can never silently bind new iteration proofs.
  // Cleared by key deletion — own undefined fails normalization.
  delete next.work_identity;
  if (!backDeclaration.declaration) clearPolicyProjection(next);
  if (deferredRoster) {
    // Same deferred-roster invariant as the linear advance: the completed
    // prior-iteration capability is deleted, never carried with its stale
    // stage/epoch binding — workflow_begin must be able to issue the
    // re-entered iteration's capability.
    delete next.dispatch_capability;
  }
  delete next.pending;
  delete next.completion_envelope;
  return issued
    ? commitTransition(next, {
        ok: true,
        state: next,
        handoff: handoffFromState(next, {
          capability_id: issued.capability_id,
          dispatch_token: issued.dispatch_token,
          advance_token: issued.advance_token,
        }, backToStage),
      })
    : commitTransition(next, { ok: true, state: next });
}

export interface ChildJoinInput {
  parent: WorkIdentity;
  child: WorkIdentity;
  state: ChildJoin["state"];
  expected_artifact_ids: string[];
  completion_envelope_ref: string | null;
  attempt: number;
  completion_envelope?: CompletionEnvelope;
}

function sameIdentity(left: WorkIdentity | undefined, right: WorkIdentity | undefined): boolean {
  return left !== undefined && right !== undefined && JSON.stringify(left) === JSON.stringify(right);
}

/** Append a child result to the durable parent ledger without positional joins. */
export function appendChildJoin(cwd: string, input: ChildJoinInput): TransitionResult {
  return runTransition(cwd, (state, target) => {
    const cap = activeCapability(state.dispatch_capability);
    if (!cap) return rejectTransition("dispatch capability unavailable", state);
    const coherence = authorizeCoherenceError(state, cap);
    if (coherence) return rejectTransition(coherence, state);
    if (!sameIdentity(input.parent, state.work_identity) && (
      input.parent.capability_id !== cap.capability_id
      || input.parent.capability_epoch !== cap.issued_for.cursor_epoch
    )) return rejectTransition("parent identity is not bound to the active capability", state);
    if (!input.child.run_id || !input.child.task_id || !input.child.dispatch_id || !input.child.worker_id) return rejectTransition("child identity is incomplete", state);
    if (sameIdentity(input.parent, input.child)) return rejectTransition("parent and child identities must differ", state);
    if (!Number.isInteger(input.attempt) || input.attempt < 1) return rejectTransition("child attempt must be a positive integer", state);
    if (new Set(input.expected_artifact_ids).size !== input.expected_artifact_ids.length || input.expected_artifact_ids.some((id) => !isSafeStateSegment(id))) {
      return rejectTransition("child artifact ids are unsafe or duplicated", state);
    }
    if (input.completion_envelope) {
      const terminal = input.state === "succeeded" || input.state === "failed" || input.state === "cancelled";
      if (
        !sameIdentity(input.completion_envelope.identity, input.child)
        || input.completion_envelope.outcome !== (terminal ? input.state : "pending")
        || (terminal ? input.completion_envelope.terminal_signal === null : input.completion_envelope.terminal_signal !== null)
      ) return rejectTransition("child completion envelope is not a validated terminal/pending envelope", state);
    }
    if ((input.state === "succeeded" || input.state === "failed" || input.state === "cancelled") && !input.completion_envelope) {
      return rejectTransition("terminal child join requires a completion envelope", state);
    }
    const existing = (state.child_joins ?? []).find((join) => sameIdentity(join.parent, input.parent) && sameIdentity(join.child, input.child));
    if (existing) {
      const exact = existing.state === input.state
        && existing.attempt === input.attempt
        && existing.completion_envelope_ref === input.completion_envelope_ref
        && JSON.stringify(existing.expected_artifact_ids) === JSON.stringify(input.expected_artifact_ids);
      if (exact) return replayTransition({ ok: true, state, child_join: existing });
      const conflictRef = `conflict:${hash(JSON.stringify({ existing, input }))}`;
      const conflict: ChildJoin = {
        parent: input.parent,
        child: input.child,
        state: "conflict",
        expected_artifact_ids: [...input.expected_artifact_ids],
        completion_envelope_ref: conflictRef,
        attempt: Math.max(existing.attempt, input.attempt),
        created_at: existing.created_at,
        joined_at: now(),
      };
      const next: TeamState = { ...state, child_join: conflict, child_joins: [...(state.child_joins ?? []), conflict], updated_at: now() };
      return commitTransition(next, { ok: false, error: `child join conflict (${conflictRef})`, state: next, child_join: conflict });
    }
    const priorChild = (state.child_joins ?? []).find((join) => sameIdentity(join.parent, input.parent) && join.child.task_id === input.child.task_id);
    if (priorChild && priorChild.state !== "succeeded" && priorChild.state !== "failed" && priorChild.state !== "cancelled") {
      return rejectTransition("active child join cannot be replaced", state);
    }
    if (priorChild && input.attempt <= priorChild.attempt) return rejectTransition("child replacement attempt must increase", state);
    const joined: ChildJoin = {
      parent: input.parent,
      child: input.child,
      state: input.state,
      expected_artifact_ids: [...input.expected_artifact_ids],
      completion_envelope_ref: input.completion_envelope_ref,
      attempt: input.attempt,
      created_at: now(),
      joined_at: now(),
    };
    const next: TeamState = {
      ...state,
      child_join: joined,
      child_joins: [...(state.child_joins ?? []), joined],
      updated_at: now(),
    };
    return commitTransition(next, { ok: true, state: next, child_join: joined });
  });
}

export const joinChild = appendChildJoin;

export interface CheckpointDecisionInput extends DispatchAuth {
  checkpoint: string;
  decision: string;
  rationale: string;
  run_id?: string;
  checkpoint_id?: string;
  checkpoint_kind?: TypedCheckpointDecision["checkpoint_kind"];
  authorization?: TypedCheckpointDecision["authorization"];
  actor_provenance?: TypedCheckpointDecision["actor"];
  /** Legacy fields are accepted as display input only and never authorize. */
  mode?: "interactive" | "autonomous";
  actor?: string;
}

/**
 * Persist a policy-bound typed checkpoint decision as ONE cross-process
 * transaction: the decision envelope is derived from the freshly persisted
 * state under the workspace lock (never from a pre-await snapshot), the
 * current-scope append is idempotent by immutable decision key, and the
 * commit is CAS-guarded against concurrent writers.
 */
export function recordCheckpointDecision(cwd: string, input: CheckpointDecisionInput): TransitionResult {
  const outcome = updateStateAtomically<{ state: TeamState }>(cwd, (snapshot) => {
    const state = snapshot.state;
    if (!state) return { op: "fail", code: "state_missing", error: "state not found" };
    if (snapshot.target.isStale) return { op: "fail", code: "state_conflict", error: "workflow state is stale for the active branch" };
    const cap = activeCapability(state.dispatch_capability);
    if (!cap) return { op: "fail", code: "capability_invalid", error: "dispatch capability unavailable" };
    const error = auth(cap, input, cap.advance_token_hash);
    if (error) return { op: "fail", code: "binding_invalid", error };
    if (cap.status === "invalidated" || cap.status === "complete") return { op: "fail", code: "binding_invalid", error: "capability invalidated" };
    const coherence = authorizeCoherenceError(state, cap);
    if (coherence) return { op: "fail", code: "binding_invalid", error: coherence };
    if (input.stage_cursor !== cap.issued_for.stage_cursor) return { op: "fail", code: "checkpoint_scope_stale", error: "checkpoint stage does not match the active capability" };
    if (!input.checkpoint.trim() || !input.decision.trim()) return { op: "fail", code: "decision_invalid", error: "checkpoint name and decision are required" };
    if (!input.authorization || !input.actor_provenance) {
      return { op: "fail", code: "decision_invalid", error: "typed checkpoint authorization and actor provenance are required; legacy mode/actor fields cannot authorize" };
    }
    const profile = loadProfile(cap.issued_for.workflow);
    if (!profile || profileHash(profile) !== cap.issued_for.profile_hash) {
      return { op: "fail", code: "policy_invalid", error: "workflow profile hash drifted from the capability binding" };
    }
    const stage = profile.stages.find((candidate) => candidate.id === cap.issued_for.stage_cursor);
    if (!stage?.checkpoint) return { op: "fail", code: "policy_invalid", error: `stage '${cap.issued_for.stage_cursor}' declares no checkpoint` };
    if (input.checkpoint !== stage.checkpoint || (input.checkpoint_id && input.checkpoint_id !== input.checkpoint)) {
      return { op: "fail", code: "checkpoint_scope_stale", error: `checkpoint '${input.checkpoint}' does not match declared checkpoint '${stage.checkpoint}'` };
    }
    // The CURRENT stage/profile declaration is authoritative at record time;
    // a persisted mirror that contradicts it fails closed (policy_conflict).
    const declaration = resolveCheckpointDeclaration(stage, profile.checkpoint_policy, state, "authorize");
    if (!declaration.ok) return { op: "fail", code: declaration.code, error: `${declaration.code}: ${declaration.error}` };
    if (!declaration.declaration) return { op: "fail", code: "policy_invalid", error: `checkpoint '${input.checkpoint}' has no policy` };
    // Exact ask -> record contract: trim decides EMPTINESS only. The
    // decision label and rationale are preserved verbatim — a padded label
    // can never be normalized into an allowed decision, and the immutable
    // decision key is computed over exactly what the actor returned.
    const decision: TypedCheckpointDecision = {
      run_id: input.run_id ?? activeRunIdOf(state),
      stage_id: stage.id,
      checkpoint_id: input.checkpoint,
      checkpoint_kind: input.checkpoint_kind ?? declaration.declaration.rule.kind,
      decision: input.decision,
      authorization: input.authorization,
      actor: input.actor_provenance,
      capability_id: cap.capability_id,
      capability_epoch: cap.issued_for.cursor_epoch,
      loop_iteration: cap.issued_for.loop_iteration,
      policy_hash: declaration.declaration.policy_hash,
      rationale: input.rationale,
      decided_at: now(),
    };
    const validated = validateCheckpointDecision(state, decision, { stage, declaration: declaration.declaration, mode: "current" });
    if (!validated.ok) return { op: "fail", code: validated.code, error: `${validated.code}: ${validated.error}` };
    const appended = appendCheckpointDecision(state, validated.decision);
    if (!appended.ok) return { op: "fail", code: appended.code, error: `${appended.code}: ${appended.error}` };
    // Exact replay of the same immutable decision is a pure no-op: the first
    // record with its original decided_at is kept and the revision does not
    // move. A regenerated timestamp never becomes a conflict.
    if (appended.idempotent && appended.state === state) {
      return { op: "discard", value: { state } };
    }
    return { op: "commit", state: appended.state, value: { state: appended.state } };
  });
  if (!outcome.ok) return { ok: false, error: outcome.error };
  if (!outcome.value) return { ok: false, error: "state transaction completed without a result" };
  // The returned state is the committed, normalized/stamped state on disk.
  return { ok: true, state: outcome.committed && outcome.state ? outcome.state : outcome.value.state };
}

/**
 * STRICT binding between the currently persisted state and the active
 * capability, enforced before EVERY authorizing mutation (authorize,
 * pending, complete, begin/reissue, advance, re-entry, checkpoint ask and
 * record). Every shared field (run, branch, workflow, profile hash, cursor
 * epoch, stage cursor) must be PRESENT on both sides and strictly equal —
 * a capability whose issued_for no longer matches the state it lives in,
 * or a state missing any binding field, is stale or forged and must be
 * repaired or re-issued, never authorized.
 */
/**
 * Stable per-field drift reasons for the human-facing ask/record surfaces:
 * the exact binding field that disagrees is named instead of leaking
 * validator issue paths.
 */
const CAPABILITY_DRIFT_REASONS: Record<string, string> = {
  run_key: "capability run_key does not match the workflow state",
  branch: "capability branch does not match the workflow state",
  workflow: "capability workflow does not match the workflow state",
  profile_hash: "capability profile hash does not match the workflow state",
  cursor_epoch: "capability epoch does not match the workflow state",
  stage_cursor: "capability stage cursor does not match the workflow state",
};

function capabilityStateCoherenceError(state: TeamState, _cap: ActiveCapability): string | null {
  const binding = validateActiveCapabilityStateBinding(state);
  if (!binding.ok) {
    const drifted = binding.issues.find((issue) =>
      issue.message === "does not match the workflow state"
      && (() => {
        const match = /\.issued_for\.([a-z_]+)$/.exec(issue.path);
        return match !== null && CAPABILITY_DRIFT_REASONS[match[1]!] !== undefined;
      })());
    if (drifted) return CAPABILITY_DRIFT_REASONS[/\.issued_for\.([a-z_]+)$/.exec(drifted.path)![1]!]!;
    if (binding.issues.some((issue) => issue.path.endsWith(".work_identity"))) {
      return "capability work identity does not match the workflow state";
    }
    return `workflow state and capability disagree: ${binding.issues.map((issue) => `${issue.path} ${issue.message}`).join("; ")}`;
  }
  return null;
}

/**
 * CURRENT-STAGE scope coherence for authorizing mutations: the capability
 * must still bind the stage window that is live RIGHT NOW — the profile
 * hash, the 1-based loop iteration of the cursor stage, and the stage's
 * declared checkpoint policy hash. `beginCapability` deliberately applies
 * only the binding half of this check: it is the repair path that
 * re-projects a stale policy mirror and re-issues the capability.
 */
function capabilityStageScopeError(state: TeamState, cap: ActiveCapability): string | null {
  const workflow = state.classification?.workflow;
  const profile = workflow ? loadProfile(workflow) : null;
  if (!profile) return `workflow '${workflow ?? ""}' is unavailable`;
  if (profileHash(profile) !== cap.issued_for.profile_hash) return "workflow profile hash drifted from the capability binding";
  const stage = profile.stages.find((candidate) => candidate.id === cap.issued_for.stage_cursor);
  if (!stage) return `workflow stage '${cap.issued_for.stage_cursor}' is unavailable in the workflow profile`;
  const iteration = loopIterationForStage(state, profile, stage.id);
  if (!iteration.ok) return iteration.error;
  if (cap.issued_for.loop_iteration !== iteration.iteration) return "capability loop iteration does not match the stage's active loop window";
  const declaration = resolveCheckpointDeclaration(stage, profile.checkpoint_policy, state, "authorize");
  if (!declaration.ok) return `${declaration.code}: ${declaration.error}`;
  const declaredHash = declaration.declaration?.policy_hash ?? null;
  if ((cap.issued_for.checkpoint_policy_hash ?? null) !== declaredHash) return "capability checkpoint policy hash does not match the current stage declaration";
  return null;
}

/** Binding coherence plus current-stage scope: every authorizing mutation. */
function authorizeCoherenceError(state: TeamState, cap: ActiveCapability): string | null {
  return capabilityStateCoherenceError(state, cap) ?? capabilityStageScopeError(state, cap);
}

export interface CheckpointAskRequest {
  token: string;
  capability_id: string;
  run_key: string;
  branch: string;
  workflow: string;
  stage_cursor: string;
  cursor_epoch: string;
  checkpoint: string;
  checkpoint_id: string;
  checkpoint_kind: string;
  /** Loop iteration of the handoff; mismatching iterations reject. */
  loop_iteration?: number;
}

/** Everything the trusted human-ask ingest needs from one validated snapshot. */
export interface CheckpointAskContext {
  state: TeamState;
  target?: ResolvedState;
  stage: StageDef;
  declaration: CheckpointDeclaration;
  policy: CheckpointPolicy;
  rule: CheckpointRule;
  allowed: string[];
}

export type CheckpointAskPreflight = { ok: true; context: CheckpointAskContext } | { ok: false; error: string };

type AskContextResolution =
  | { ok: true; context: CheckpointAskContext }
  | { ok: false; code: string; error: string };

/**
 * Full state<->capability<->profile<->policy validation for the trusted
 * checkpoint ask, against ONE explicit state snapshot. Used read-only by the
 * preflight and authoritatively inside the post-dialog commit transaction —
 * never against a caller-held stale snapshot.
 */
function checkpointAskContextFor(state: TeamState, input: CheckpointAskRequest): AskContextResolution {
  // Full capability shape: identity fields, secret hashes, roster
  // consistency, and dispatch-record invariants — a malformed or hand-crafted
  // capability fails closed here instead of raising a human dialog.
  const cap = activeCapability(state.dispatch_capability);
  if (!cap) return { ok: false, code: "capability_invalid", error: "dispatch capability unavailable" };
  // Guard mirror of the durable auth() checks: the secret-bearing comparisons
  // run before anything human-facing; the full binding is re-validated
  // authoritatively when the decision envelope is recorded.
  if (!input.token || hash(input.token) !== cap.advance_token_hash) return { ok: false, code: "binding_invalid", error: "invalid secret" };
  if (input.capability_id !== cap.capability_id) return { ok: false, code: "binding_invalid", error: "capability identity mismatch" };
  const issued = cap.issued_for;
  if (input.run_key !== issued.run_key || input.branch !== issued.branch || input.workflow !== issued.workflow || input.stage_cursor !== issued.stage_cursor || input.cursor_epoch !== issued.cursor_epoch) {
    return { ok: false, code: "binding_invalid", error: "capability binding mismatch" };
  }
  // A modern (loop-scoped) capability REQUIRES the caller's iteration: an
  // omitted iteration can neither ask nor record, so the ask response can
  // always carry the complete scope verbatim. Only genuinely legacy
  // (pre-loop-scope) capabilities tolerate omission, and those cannot
  // authorize anyway.
  if (issued.loop_iteration !== undefined && input.loop_iteration !== issued.loop_iteration) {
    return { ok: false, code: "binding_invalid", error: "capability binding mismatch" };
  }
  if (cap.status === "invalidated" || cap.status === "complete") return { ok: false, code: "binding_invalid", error: "capability invalidated" };
  const profile = loadProfile(issued.workflow);
  if (!profile) return { ok: false, code: "policy_invalid", error: `workflow '${issued.workflow}' is unavailable` };
  if (profileHash(profile) !== issued.profile_hash) return { ok: false, code: "policy_invalid", error: "workflow profile hash drifted from the capability binding" };
  const stage = profile.stages.find((candidate) => candidate.id === issued.stage_cursor);
  if (!stage?.checkpoint) return { ok: false, code: "policy_invalid", error: `stage '${issued.stage_cursor}' declares no checkpoint` };
  if (input.checkpoint !== stage.checkpoint || input.checkpoint_id !== input.checkpoint) {
    return { ok: false, code: "checkpoint_scope_stale", error: `checkpoint '${input.checkpoint}' does not match declared checkpoint '${stage.checkpoint}'` };
  }
  // The declaration of the CURRENT stage is authoritative: profile/stage
  // policy first, the persisted mirror only while its binding names this
  // stage, and a contradicting mirror is a policy conflict (fail closed).
  const declaration = resolveCheckpointDeclaration(stage, profile.checkpoint_policy, state, "authorize");
  if (!declaration.ok) return { ok: false, code: declaration.code, error: declaration.error };
  if (!declaration.declaration) return { ok: false, code: "policy_invalid", error: `checkpoint '${input.checkpoint}' has no policy` };
  if (input.checkpoint_kind !== declaration.declaration.rule.kind) {
    return { ok: false, code: "policy_invalid", error: `checkpoint kind '${input.checkpoint_kind}' does not match policy kind '${declaration.declaration.rule.kind}'` };
  }
  // Strict state<->capability coherence and current-stage scope run AFTER the
  // declaration resolution: a policy conflict must surface as policy_conflict
  // (the ask preflight wraps it as state<->profile drift), never dressed up
  // as a binding failure.
  const coherence = authorizeCoherenceError(state, cap);
  if (coherence) return { ok: false, code: "binding_invalid", error: coherence };
  const allowed = declaration.declaration.rule.allowed_decisions.filter((decision) => decision.trim().length > 0);
  if (allowed.length === 0) {
    // Migration policies leave allowed_decisions empty on purpose:
    // unresolved legacy consent never becomes a live question.
    return { ok: false, code: "policy_invalid", error: `checkpoint '${input.checkpoint}' policy allows no decisions; resolve the workflow policy first` };
  }
  return {
    ok: true,
    context: {
      state,
      stage,
      declaration: declaration.declaration,
      policy: declaration.declaration.policy,
      rule: declaration.declaration.rule,
      allowed,
    },
  };
}

/**
 * Full state<->capability<->profile<->policy validation for the trusted
 * checkpoint ask. Read-only against the CURRENTLY persisted state: the ask
 * tool runs it once before any human prompt and again after the dialog
 * resolves, so a state, capability, profile, or policy transition while the
 * dialog is open rejects instead of persisting a stale answer.
 */
export function validateCheckpointAsk(cwd: string, input: CheckpointAskRequest): CheckpointAskPreflight {
  const target = resolveState(cwd, resolveActiveBranch(cwd));
  if (target.invalid) {
    // A state whose ONLY rejection is a malformed dispatch capability is a
    // capability failure, not a generic unsafe-path failure: the ask
    // boundary names it as such instead of raising the human dialog.
    if (target.statePath) {
      try {
        const issues: string[] = [];
        normalizePersistedState(JSON.parse(readFileSync(target.statePath, "utf8")), issues);
        if (issues.length > 0 && issues.every((issue) => issue.startsWith("$.dispatch_capability"))) {
          return { ok: false, error: "dispatch capability unavailable" };
        }
      } catch {
        // fall through to the generic rejection
      }
    }
    return { ok: false, error: "workflow state is invalid or unsafe" };
  }
  if (!target.state) return { ok: false, error: "workflow state not found" };
  if (target.isStale) return { ok: false, error: "workflow state is stale for the active branch" };
  const context = checkpointAskContextFor(target.state, input);
  if (!context.ok) {
    if (context.code === "policy_conflict") {
      return { ok: false, error: `checkpoint policy drifted between the workflow state and the declaring profile (${context.error})` };
    }
    return { ok: false, error: context.error };
  }
  return { ok: true, context: { ...context.context, target } };
}

export interface CheckpointAnswerCommitInput {
  token: string;
  capability_id: string;
  run_key: string;
  branch: string;
  workflow: string;
  stage_cursor: string;
  cursor_epoch: string;
  checkpoint: string;
  checkpoint_id: string;
  checkpoint_kind: string;
  /** Loop iteration of the handoff; mismatching iterations reject. */
  loop_iteration?: number;
  /**
   * The exact canonical decision label chosen at the UI surface. It is never
   * trimmed, lower-cased or otherwise normalized before the ledger check.
   */
  decision: string;
}

export type CheckpointAnswerCommitSuccess = {
  ok: true;
  /** minted = fresh answer; reused_live = exact live proof replayed; already_finalized = exact decision already on the ledger. */
  outcome: "minted" | "reused_live" | "already_finalized";
  decision: string;
  checkpoint_kind: CheckpointRuleKind;
  allowed: string[];
  answer: TrustedCheckpointAnswer | null;
  proof: CheckpointAnswerProof | null;
  state: TeamState;
};

export type CheckpointAnswerCommitResult =
  | CheckpointAnswerCommitSuccess
  | {
      ok: false;
      /** rejected = validation/auth; stale = scope moved; conflict = a different decision is already final. */
      kind: "rejected" | "stale" | "conflict";
      code: string;
      error: string;
      recorded_decision?: string;
      allowed?: string[];
    };

type CommitPayload =
  | { kind: "success"; outcome: "minted" | "reused_live"; checkpoint_kind: CheckpointRuleKind; allowed: string[]; answer: TrustedCheckpointAnswer; proof: CheckpointAnswerProof }
  | { kind: "success"; outcome: "already_finalized"; checkpoint_kind: CheckpointRuleKind; allowed: string[]; answer: TrustedCheckpointAnswer | null; proof: CheckpointAnswerProof | null }
  | { kind: "rejected"; code: string; error: string }
  | { kind: "stale"; code: string; error: string }
  | { kind: "conflict"; code: string; error: string; recorded_decision: string };

function markAnswersSuperseded(state: TeamState, answerIds: ReadonlySet<string>): TeamState {
  if (answerIds.size === 0) return state;
  const supersededAt = new Date().toISOString();
  return {
    ...state,
    trusted_checkpoint_answers: (state.trusted_checkpoint_answers ?? []).map((candidate) =>
      answerIds.has(candidate.answer_id) && candidate.consumed_at === undefined && candidate.consumed_reason === undefined
        ? { ...candidate, consumed_at: supersededAt, consumed_reason: "superseded" as const }
        : candidate,
    ),
  };
}

/**
 * The ONLY function that commits a human checkpoint answer after the
 * asynchronous UI resolves.
 *
 * Runs as one cross-process transaction (`lock + re-read + revision/raw-hash
 * CAS`): it re-derives the current declaration and capability from the
 * freshly persisted state — never from the pre-dialog snapshot — keeps every
 * unrelated concurrent field, and either:
 *   - finds an exact final decision already on the ledger for the same
 *     immutable decision key (`already_finalized`),
 *   - rejects on a conflicting final decision without touching the ledger,
 *   - reuses the exact live answer for the current scope, collapsing any
 *     duplicate siblings,
 *   - or supersedes ALL live answers for the question (both channels, all
 *     epochs) and mints exactly one fresh terminal answer in the same
 *     commit.
 * A stage/epoch/iteration/policy move while the dialog was open fails with
 * `checkpoint_scope_stale` and writes nothing. The minted `answer_id` is
 * engine-generated (`randomUUID`), never derived from record counts.
 */
export function commitCheckpointAnswer(cwd: string, input: CheckpointAnswerCommitInput): CheckpointAnswerCommitResult {
  const result = updateStateAtomically<CommitPayload>(cwd, (snapshot) => {
    const state = snapshot.state;
    if (!state) return { op: "fail", code: "state_missing", error: "workflow state not found" };
    if (snapshot.target.isStale) return { op: "fail", code: "state_conflict", error: "workflow state is stale for the active branch" };
    const context = checkpointAskContextFor(state, input);
    if (!context.ok) {
      if (context.code === "checkpoint_scope_stale") {
        return { op: "discard", value: { kind: "stale", code: context.code, error: context.error } };
      }
      return { op: "discard", value: { kind: "rejected", code: context.code, error: context.error } };
  }
    const { stage, declaration, allowed } = context.context;
    const checkpoint_kind = declaration.rule.kind;
    if (!allowed.includes(input.decision)) {
      return {
        op: "discard",
        value: { kind: "rejected", code: "policy_invalid", error: "the selected label is not a policy-allowed decision; nothing was recorded" },
      };
    }
    const scope = currentCheckpointScope(state, stage, declaration);
    if (!scope.ok) return { op: "discard", value: { kind: "stale", code: scope.code, error: scope.error } };
    const active = scope.scope;

    // Validate EVERY record in the current immutable scope before any replay
    // result is returned. A malformed sibling or two conflicting finals is
    // ledger corruption and fails closed; array order never chooses a winner.
    const currentRecords = [
      ...(state.typed_checkpoint_decisions ?? []),
      ...(state.checkpoint_decisions ?? []),
    ].filter((candidate) => {
      const id = "checkpoint_id" in candidate ? candidate.checkpoint_id : candidate.checkpoint;
      if (candidate.stage_id !== stage.id || id !== input.checkpoint) return false;
      const candidateScope = decisionScopeOf(candidate);
      return candidateScope !== null
        && candidateScope.capability_id === active.capability_id
        && candidateScope.capability_epoch === active.capability_epoch
        && candidateScope.loop_iteration === active.loop_iteration
        && candidateScope.policy_hash === active.policy_hash;
    });
    const finalized = new Map<string, TypedCheckpointDecision>();
    for (const candidate of currentRecords) {
      const validated = validateCheckpointDecision(state, candidate, { stage, declaration, mode: "current" });
      if (!validated.ok) {
        return {
          op: "discard",
          value: { kind: "rejected", code: validated.code, error: `current-scope checkpoint ledger is invalid: ${validated.error}` },
        };
      }
      finalized.set(checkpointDecisionKey(validated.decision), validated.decision);
    }
    if (finalized.size > 1) {
      return {
        op: "discard",
        value: {
          kind: "conflict",
          code: "decision_conflict",
          error: `multiple conflicting decisions were already recorded for checkpoint '${input.checkpoint}' while the dialog was open; nothing was recorded`,
          recorded_decision: Array.from(finalized.values()).map((decision) => decision.decision).join(" | "),
        },
      };
    }
    const existingFinal = finalized.values().next().value as TypedCheckpointDecision | undefined;
    if (existingFinal) {
      if (existingFinal.decision === input.decision) {
        const proof = existingFinal.actor.proof ?? null;
        const answer = proof
          ? (state.trusted_checkpoint_answers ?? []).find((entry) => entry.answer_id === proof.answer_id) ?? null
          : null;
        return { op: "discard", value: { kind: "success", outcome: "already_finalized", checkpoint_kind, allowed, answer, proof } };
      }
      return {
        op: "discard",
        value: {
          kind: "conflict",
          code: "decision_conflict",
          error: `a conflicting decision '${existingFinal.decision}' was already recorded for checkpoint '${input.checkpoint}' while the dialog was open; nothing was recorded`,
          recorded_decision: existingFinal.decision,
        },
      };
    }

    // At most ONE live answer per (run, stage, checkpoint) across terminal
    // and escalation channels and all epochs.
    const live = (state.trusted_checkpoint_answers ?? []).filter((candidate) =>
      candidate.run_id === active.run_id
      && candidate.stage_id === stage.id
      && candidate.checkpoint_id === input.checkpoint
      && candidate.consumed_at === undefined
      && candidate.consumed_reason === undefined);
    const exact = live.find((candidate) =>
      candidate.decision === input.decision
      && candidate.channel === "terminal"
      && candidate.capability_id === active.capability_id
      && candidate.capability_epoch === active.capability_epoch
      && candidate.loop_iteration === active.loop_iteration
      && candidate.policy_hash === active.policy_hash);
    if (exact) {
      let reusable = false;
      try {
        const replay = recordTrustedCheckpointAnswer(state, {
          answer_id: exact.answer_id,
          channel: exact.channel,
          reference: exact.reference,
          stage_id: exact.stage_id,
          checkpoint_id: exact.checkpoint_id,
          decision: exact.decision,
          issued_at: exact.issued_at,
        });
        reusable = replay.answer === exact && replay.state === state;
      } catch {
        // A shape-valid but forged live record is superseded by the fresh
        // mint below; it is never returned as an unusable proof.
      }
      if (reusable) {
        const duplicates = live.filter((candidate) => candidate.answer_id !== exact.answer_id);
        const next = markAnswersSuperseded(state, new Set(duplicates.map((candidate) => candidate.answer_id)));
        const payload: CommitPayload = { kind: "success", outcome: "reused_live", checkpoint_kind, allowed, answer: exact, proof: checkpointProofOf(exact) };
        return next !== state ? { op: "commit", state: next, value: payload } : { op: "discard", value: payload };
      }
    }

    // Conflicting/stale live proofs are superseded and one fresh terminal
    // answer is minted in the SAME commit — engine-owned answer identity.
    const minted = recordTrustedCheckpointAnswer(state, {
      answer_id: randomUUID(),
      channel: "terminal",
      reference: `terminal-answer/${active.run_id}/${stage.id}/${input.checkpoint}/${randomUUID().slice(0, 8)}`,
      stage_id: stage.id,
      checkpoint_id: input.checkpoint,
      decision: input.decision,
    });
    const next = markAnswersSuperseded(minted.state, new Set(live.map((candidate) => candidate.answer_id)));
    return {
      op: "commit",
      state: next,
      value: { kind: "success", outcome: "minted", checkpoint_kind: declaration.rule.kind, allowed, answer: minted.answer, proof: minted.proof },
    };
  });
  if (!result.ok || !result.value) {
    return { ok: false, kind: "rejected", code: result.ok ? "state_conflict" : result.code, error: result.ok ? "state transaction completed without a result" : result.error };
  }
  const payload: CommitPayload = result.value;
  if (payload.kind === "success") {
    return {
      ok: true,
      outcome: payload.outcome,
      decision: input.decision,
      checkpoint_kind: payload.checkpoint_kind,
      allowed: payload.allowed,
      answer: payload.answer,
      proof: payload.proof,
      state: result.state!,
    };
  }
  return {
    ok: false,
    kind: payload.kind,
    code: payload.code,
    error: payload.error,
    ...(payload.kind === "conflict" ? { recorded_decision: payload.recorded_decision } : {}),
  };
}

export function reconcileTaskResult(cwd: string, input: {
  dispatch_id?: string;
  tool_call_id?: string;
  slot_id?: string;
  task_id?: string;
  token?: string;
  capability_id: string;
  cursor_epoch?: string;
  output?: string;
  isError?: boolean;
  details?: { async?: { state?: string; provider_ref?: string } };
}): TransitionResult {
  if (!input.dispatch_id && !input.tool_call_id) return { ok: false, error: "dispatch identity required" };
  if (!input.token) return { ok: false, error: "dispatch token required" };
  // Candidate resolution, authentication and the pending/terminal mutation
  // run in ONE cross-process transaction against the freshly persisted
  // ledger.
  return runTransition(cwd, (state, target) => {
    const cap = activeCapability(state.dispatch_capability);
    if (!cap || cap.capability_id !== input.capability_id || (input.cursor_epoch && cap.issued_for.cursor_epoch !== input.cursor_epoch)) return rejectTransition("capability binding mismatch", state);
    const error = auth(cap, {
      token: input.token!,
      capability_id: input.capability_id,
      run_key: cap.issued_for.run_key,
      branch: cap.issued_for.branch,
      workflow: cap.issued_for.workflow,
      profile_hash: cap.issued_for.profile_hash,
      stage_cursor: cap.issued_for.stage_cursor,
      cursor_epoch: cap.issued_for.cursor_epoch,
      loop_iteration: cap.issued_for.loop_iteration,
    }, cap.dispatch_token_hash);
    if (error) return rejectTransition(error, state);
    const coherence = authorizeCoherenceError(state, cap);
    if (coherence) return rejectTransition(coherence, state);
    const records = cap.dispatches.filter((record) =>
      !record.completion
      && (input.dispatch_id ? record.id === input.dispatch_id : record.tool_call_id === input.tool_call_id)
      && (!input.slot_id || input.slot_id === record.role || input.slot_id === record.work_identity?.slot_id)
      && (!input.task_id || input.task_id === record.work_identity?.task_id),
    );
    if (records.length !== 1) return rejectTransition(records.length === 0 ? "unknown dispatch" : "ambiguous positional result", state);
    const record = records[0];
    if (!record) return rejectTransition("dispatch result identity disappeared", state);
    const asyncState = input.details?.async?.state;
    const remainsPending = asyncState === "running" || asyncState === "spawned" || asyncState === "scheduled" || (!input.output && !input.isError);
    if (remainsPending) {
      return pendingRecord(state, cap, record, "provider_running", input.details?.async?.provider_ref ?? asyncState);
    }
    const evidence = input.output?.trim() || (input.isError ? "task failed" : "");
    return completeRecord(state, target, cap, record, {
      outcome: input.isError ? "failed" : "succeeded",
      evidence,
      completed_by: "synchronous_tool_result",
    });
  });
}
