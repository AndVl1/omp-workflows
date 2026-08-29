import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, realpathSync, unlinkSync } from "node:fs";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { loadProfile, profileHash } from "./profile.js";
import { resolveState, writeState, isSafeStateSegment, resolveActiveBranch, type ResolvedState } from "./state.js";
import { agentMappingIssueForRole, resolveConfig, resolveAgentForRole, type ResolvedConfig } from "./config.js";
import { validateAgentMappingState, type AgentMappingDiagnostic, type AgentMappingState } from "./agent-mapping.js";
import { resolveScope, type ScopeFlags } from "./scope.js";
import { resolveStageDispatchSlots, selectRoster, type RosterSelectionContext } from "./stage.js";
import { readArtifact, writeArtifact } from "./artifacts.js";
import { isDoDComplete, isRootCauseDocumented, readDoD } from "./dod.js";
import { validationGate } from "../gates/validation.js";
import { buildDispatchMarker, dispatchTaskId } from "../gates/dispatch.js";
import { evaluatePredicate } from "./predicate.js";
import {
  appendCheckpointDecision,
  checkpointPolicyHash,
  findCheckpointDecision,
  resolveCheckpointPolicy,
  validateCheckpointDecision,
  unresolvedCheckpointError,
} from "./checkpoints.js";
import { loopExhaustionKind, loopIterationRecord, loopReentryDecision, loopStateFor, resolveBackToStage } from "./loops.js";
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
  CheckpointDecision,
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
  issued_for: { run_key: string; branch: string; workflow: TeamState["classification"]["workflow"]; profile_hash: string; stage_cursor: string; cursor_epoch: string };
  kind: "none" | "single" | "consilium"; expected_roles: string[]; expected_count: number;
  expected_roster: Array<{ role: string; agent: string }>;
  /** Frozen selection carried by roster-policy capabilities (masked on completion). */
  roster_selection?: RosterSelection;
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
  if (
    !value?.issued_for
    || typeof value.issued_for !== "object"
    || typeof value.capability_id !== "string"
    || !value.capability_id
    || typeof value.dispatch_token_hash !== "string"
    || !/^[0-9a-f]{64}$/.test(value.dispatch_token_hash)
    || typeof value.advance_token_hash !== "string"
    || !/^[0-9a-f]{64}$/.test(value.advance_token_hash)
    || !Array.isArray(value.dispatches)
    || !Array.isArray(value.expected_roles)
    || value.expected_count === undefined
    || !Number.isInteger(value.expected_count)
    || !Array.isArray(value.expected_roster)
    || !value.status
  ) return null;
  const issued = value.issued_for;
  const expectedRoles = value.expected_roles;
  const expectedRoster = value.expected_roster;
  const expectedCount = value.expected_count;
  if (
    !["none", "single", "consilium"].includes(value.kind)
    || !["ready", "dispatched", "joining", "complete", "invalidated"].includes(value.status)
    || [issued.run_key, issued.branch, issued.workflow, issued.profile_hash, issued.stage_cursor, issued.cursor_epoch].some((field) => typeof field !== "string" || !field)
  ) return null;
  if ((value.kind === "none" ? expectedCount !== 0 : expectedCount <= 0) || expectedCount !== expectedRoles.length || expectedCount !== expectedRoster.length) return null;
  if (
    expectedRoles.some((role) => typeof role !== "string" || !role)
    || expectedRoster.some((entry) => !entry || typeof entry !== "object" || typeof entry.role !== "string" || !entry.role || typeof entry.agent !== "string" || !entry.agent)
    || new Set(expectedRoles).size !== expectedRoles.length
    || new Set(expectedRoster.map((entry) => entry.role)).size !== expectedRoster.length
    || expectedRoles.some((role) => !expectedRoster.some((entry) => entry.role === role))
  ) return null;
  const terminalStatuses = new Set(["succeeded", "failed", "cancelled"]);
  const identityValid = (identity: WorkIdentity, role: string, dispatchId: string, attempt: number): boolean =>
    Boolean(identity.run_id)
    && identity.slot_id === role
    && identity.capability_id === value.capability_id
    && identity.capability_epoch === issued.cursor_epoch
    && identity.dispatch_id === dispatchId
    && identity.attempt === attempt
    && Boolean(identity.task_id)
    && Boolean(identity.worker_id);
  const envelopeValid = (envelope: CompletionEnvelope | undefined, identity: WorkIdentity, outcome: CompletionEnvelope["outcome"]): boolean =>
    envelope !== undefined
    && envelope.schema_version === 1
    && sameIdentity(envelope.identity, identity)
    && envelope.outcome === outcome
    && (outcome === "pending" ? envelope.terminal_signal === null : envelope.terminal_signal !== null)
    && Array.isArray(envelope.artifact_refs)
    && typeof envelope.emitted_at === "string";
  if (
    new Set(value.dispatches.map((record) => record?.id)).size !== value.dispatches.length
    || value.dispatches.some((record) => {
      if (
        !record
        || typeof record.id !== "string"
        || !record.id
        || typeof record.role !== "string"
        || !record.role
        || !expectedRoles.includes(record.role)
        || typeof record.agent !== "string"
        || !record.agent
        || !expectedRoster.some((entry) => entry.role === record.role && entry.agent === record.agent)
        || !["authorized", "running", "pending", "succeeded", "failed", "cancelled"].includes(record.status)
        || !Number.isInteger(record.attempt)
        || record.attempt < 1
        || typeof record.created_at !== "string"
        || (record.tool_call_id !== undefined && (typeof record.tool_call_id !== "string" || !record.tool_call_id))
        || !record.work_identity
        || !identityValid(record.work_identity, record.role, record.id, record.attempt)
      ) return true;
      const completion = record.completion;
      if (!terminalStatuses.has(record.status)) {
        if (completion !== undefined) return true;
        if (!envelopeValid(record.completion_envelope, record.work_identity, record.status === "pending" ? "pending" : "pending")) return true;
        if (record.pending !== undefined && (
          record.pending.identity.dispatch_id !== record.id
          || record.pending.identity.slot_id !== record.role
          || record.pending.status !== record.status
          || (record.status === "pending" && record.pending.terminal_signal !== undefined && record.pending.terminal_signal !== null)
        )) return true;
        return false;
      }
      return !completion
        || typeof completion !== "object"
        || completion.dispatch_id !== record.id
        || completion.cursor_epoch !== issued.cursor_epoch
        || completion.outcome !== record.status
        || typeof completion.evidence !== "string"
        || !completion.evidence.trim()
        || !Array.isArray(completion.artifact_ids)
        || new Set(completion.artifact_ids).size !== completion.artifact_ids.length
        || completion.artifact_ids.some((id) => typeof id !== "string" || !isSafeStateSegment(id))
        || !["workflow_complete", "synchronous_tool_result", "engine_task_caller"].includes(completion.completed_by)
        || typeof completion.completed_at !== "string"
        || record.completed_at !== completion.completed_at
        || !completion.work_identity
        || !sameIdentity(completion.work_identity, record.work_identity)
        || !envelopeValid(record.completion_envelope, record.work_identity, record.status);
    })
  ) return null;
  const latestByRole = new Map<string, DispatchRecord>();
  for (const record of value.dispatches) {
    const previous = latestByRole.get(record.role);
    if (previous && previous.status !== "failed" && previous.status !== "cancelled") return null;
    latestByRole.set(record.role, record);
  }
  return value as ActiveCapability;
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
    kind: cap.kind,
    expected_roster: cap.expected_roster,
    dispatch_markers,
  };
}


const hash = (value: string): string => createHash("sha256").update(value).digest("hex");
const now = (): string => new Date().toISOString();
const current = (cwd: string): { state: TeamState; target: ResolvedState } | null => {
  const target = resolveState(cwd, resolveActiveBranch(cwd));
  return target.state ? { state: target.state, target } : null;
};
const persist = (cwd: string, state: TeamState, target: ResolvedState): void => {
  if (!target.statePath || !target.stateDir || !target.artifactsDir) throw new Error("state target missing");
  writeState(cwd, state, { target });
};
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
  const base = state.work_identity;
  const seed = stableIdentitySeed(state, cap);
  return {
    run_id: base?.run_id ?? cap.issued_for.run_key,
    wave_id: base?.wave_id ?? `wave-${hash(seed).slice(0, 20)}`,
    slice_id: base?.slice_id ?? cap.issued_for.stage_cursor,
    session_id: base?.session_id ?? `session-${hash(`${seed}|session`).slice(0, 20)}`,
    workflow: cap.issued_for.workflow,
    stage_id: cap.issued_for.stage_cursor,
    stage_cursor: cap.issued_for.stage_cursor,
    capability_id: cap.capability_id,
    capability_epoch: cap.issued_for.cursor_epoch,
    slot_id: role,
    task_id: taskId ?? dispatchTaskId(cap.capability_id, cap.issued_for.run_key, cap.issued_for.branch, cap.issued_for.workflow, cap.issued_for.stage_cursor, role),
    dispatch_id: dispatchId,
    attempt,
    worker_id: agent,
  };
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

export function createCapability(input: {
  run_key: string; branch: string; workflow: TeamState["classification"]["workflow"]; profile_hash: string;
  stage_cursor: string; cursor_epoch?: string; kind: "none" | "single" | "consilium"; expected_roles?: string[];
  dispatch_secret?: string; advance_secret?: string;
  expected_roster?: Array<{ role: string; agent: string; slot_id?: string; semantic_role?: string; occurrence?: number; facet?: string | null }>;
  roster_selection?: TeamState["roster_selection"];
  work_identity?: WorkIdentity;
}): IssuedCapability {
  if (!input.run_key || !input.branch || !input.workflow || !input.profile_hash || !input.stage_cursor) throw new Error("invalid capability binding");
  const cursor_epoch = input.cursor_epoch ?? randomUUID();
  const dispatch_token = input.dispatch_secret ?? randomUUID();
  const advance_token = input.advance_secret ?? randomUUID();
  const roster = (input.expected_roster ?? (input.expected_roles ?? []).map((role) => ({ role, agent: role }))).map((entry) => ({ ...entry, role: entry.role, agent: entry.agent }));
  const expected_roles = roster.map((entry) => entry.role);
  if ((input.kind === "none" && roster.length !== 0) || (input.kind === "single" && roster.length !== 1) || (input.kind === "consilium" && roster.length === 0)) throw new Error("capability roster does not match dispatch kind");
  if (new Set(expected_roles).size !== expected_roles.length || roster.some((entry) => !entry.role || !entry.agent)) throw new Error("invalid capability roster");
  const state = {
    capability_id: randomUUID(),
    dispatch_token_hash: hash(dispatch_token),
    advance_token_hash: hash(advance_token),
    issued_for: { run_key: input.run_key, branch: input.branch, workflow: input.workflow, profile_hash: input.profile_hash, stage_cursor: input.stage_cursor, cursor_epoch },
    kind: input.kind,
    expected_roles,
    expected_count: roster.length,
    expected_roster: roster,
    ...(input.roster_selection ? { roster_selection: input.roster_selection } : {}),
    ...(input.work_identity ? { work_identity: input.work_identity } : {}),
    status: "ready" as const,
    dispatches: [],
  };
  return { capability_id: state.capability_id, dispatch_token, advance_token, state };
}
function reissueActiveCapability(cap: ActiveCapability): IssuedCapability {
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
  const branch = resolveActiveBranch(cwd);
  const target = resolveState(cwd, branch);
  if (target.invalid) return { ok: false, error: "workflow state is invalid or unsafe" };
  if (!target.state || !target.statePath) return { ok: false, error: "workflow state not found" };
  if (target.isStale) return { ok: false, error: "workflow state is stale for the active branch", state: target.state };

  const state = target.state;
  const workflow = state.classification?.workflow;
  if (!workflow) return { ok: false, error: "workflow classification is missing", state };
  const profile = loadProfile(workflow);
  if (!profile) return { ok: false, error: `workflow '${workflow}' is unavailable`, state };
  const persistedHash = profileHash(profile);
  if (state.profile_hash && state.profile_hash !== persistedHash) return { ok: false, error: "workflow profile hash is stale", state };
  if (!Array.isArray(state.stages)) return { ok: false, error: "workflow stages are missing", state };
  const stages = state.stages.length > 0
    ? state.stages
    : profile.stages.map((candidate) => ({ id: candidate.id, status: "pending" as const }));
  const stageId = state.stage_cursor || profile.stages[0]?.id;
  const stage = profile.stages.find((candidate) => candidate.id === stageId);
  if (!stage) return { ok: false, error: `workflow stage '${stageId ?? ""}' is unavailable`, state };
  const stageEntry = stages.find((candidate) => candidate.id === stage.id);
  if (!stageEntry) return { ok: false, error: `workflow stage '${stage.id}' is not persisted`, state };
  if (stageEntry.status === "done" || stageEntry.status === "skipped") return { ok: false, error: `workflow stage '${stage.id}' is already ${stageEntry.status}`, state };

  const existing = activeCapability(state.dispatch_capability);
  if (state.policy?.strict_orchestrator === true && state.dispatch_capability && !existing) return { ok: false, error: "workflow dispatch capability is malformed", state };
  const existingDispatches = existing?.issued_for.stage_cursor === stage.id ? existing.dispatches : [];
  const config = resolveConfig(cwd);
  const trusted = bindTrustedMapping(config, options?.trustedMapping);
  if (!trusted.ok) return { ok: false, error: trusted.error, state };
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
      return {
        ok: false,
        error: `workflow stage '${stage.id}' requires a live registered agent mapping before dispatch; none is trusted for the current configuration (regenerate the agent mapping from host discovery)`,
        state,
      };
    }
    if (requested) {
      if (requested.occurrences.some((occurrence) => "agent" in occurrence)) {
        return { ok: false, error: `workflow stage '${stage.id}' accepts only semantic role/facet/reason selections; concrete agent ids are never caller authority`, state };
      }
      if (requested.occurrences.some((occurrence) => typeof occurrence.role !== "string" || occurrence.role.trim() === "")) {
        return { ok: false, error: `workflow stage '${stage.id}' roster selection requires a non-empty semantic role for every occurrence`, state };
      }
      const unmapped = [...new Set(requested.occurrences.map((occurrence) => occurrence.role))].filter((role) => !effectiveConfig.agent_mapping?.resolved_roles[role]);
      if (unmapped.length > 0) {
        return { ok: false, error: `workflow stage '${stage.id}' selected roles have no live registered agent mapping: ${unmapped.map((role) => `'${role}'`).join(", ")}`, state };
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
      return {
        ok: false,
        error: `workflow stage '${stage.id}' roster selection is frozen for the active capability (snapshot '${frozen.snapshot_id}'); a changed selection is rejected — re-issue the identical semantic selection or wait for the capability to complete`,
        state,
      };
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
    if (selection.ok === false) return { ok: false, error: `workflow stage '${stage.id}' roster selection failed: ${selection.error}`, state };
    rosterSelection = selection.selection;
    slots = selection.slots;
    expectedRoster = selection.expected_roster;
  } else {
    try {
      slots = resolveStageDispatchSlots(stage, { cwd, flags, resolveDevAgent: () => flags.dev_agent });
      for (const slot of slots) {
        const agent = trustedSlotAgent(slot.role, effectiveConfig, trusted.trusted);
        if (agent === null) {
          return {
            ok: false,
            error: `workflow stage '${stage.id}' dispatch roster unresolved: role '${slot.role}' is missing or unavailable in the trusted agent mapping handoff's resolved_roles`,
            state,
          };
        }
        expectedRoster.push({ role: slot.slot, agent });
      }
    } catch (error) {
      return { ok: false, error: `workflow stage '${stage.id}' dispatch roster unresolved: ${String(error)}`, state };
    }
  }
  if ((kind === "single" && slots.length !== 1) || (kind === "consilium" && slots.length === 0)) return { ok: false, error: `workflow stage '${stage.id}' has an invalid dispatch roster`, state };
  const mappingIssues: Array<{ role: string; diagnostic: AgentMappingDiagnostic }> = [];
  for (const slot of slots) {
    const diagnostic = agentMappingIssueForRole(slot.role, effectiveConfig);
    if (diagnostic) mappingIssues.push({ role: slot.role, diagnostic });
  }
  if (mappingIssues.length > 0) {
    const details = mappingIssues.map(({ role, diagnostic }) => `role '${role}' requested '${diagnostic.requested}' (candidates: ${diagnostic.candidates.join(", ")})`).join("; ");
    return { ok: false, error: `workflow stage '${stage.id}' has no available agent mapping: ${details}`, state };
  }

  if (existing && existing.issued_for.stage_cursor === stage.id && stageEntry.status === "in_progress" && existing.status !== "complete" && existing.status !== "invalidated") {
    const rosterChanged = JSON.stringify(existing.expected_roster) !== JSON.stringify(expectedRoster);
    if (existingDispatches.length > 0 && rosterChanged) return { ok: false, error: "active dispatch capability roster is inconsistent", state };
    if (!rosterChanged) {
      const reissued = reissueActiveCapability(existing);
      const pendingActive = (reissued.state.dispatches ?? []).some((record) => record.status === "pending" || record.status === "running");
      const next: TeamState = {
        ...state,
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
      persist(cwd, next, target);
      return { ok: true, state: next, handoff: handoffFromState(next, { capability_id: reissued.capability_id, dispatch_token: reissued.dispatch_token, advance_token: reissued.advance_token }, stage) };
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
  });
  const next: TeamState = {
    ...resetState,
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
  persist(cwd, next, target);
  return {
    ok: true,
    state: next,
    handoff: handoffFromState(next, { capability_id: issued.capability_id, dispatch_token: issued.dispatch_token, advance_token: issued.advance_token }, stage),
  };
}
function auth(cap: ActiveCapability, a: DispatchAuth, secretHash: string): string | null {
  if (!a.capability_id || a.capability_id !== cap.capability_id) return "capability identity mismatch";
  if (!a.token || hash(a.token) !== secretHash) return "invalid secret";
  const b = cap.issued_for;
  if (a.run_key !== b.run_key || a.branch !== b.branch || a.workflow !== b.workflow || !profileHashMatches(b.profile_hash, a.profile_hash) || a.stage_cursor !== b.stage_cursor || a.cursor_epoch !== b.cursor_epoch) return "capability binding mismatch";
  return null;
}

function expectedTaskId(cap: ActiveCapability, role: string): string {
  return dispatchTaskId(cap.capability_id, cap.issued_for.run_key, cap.issued_for.branch, cap.issued_for.workflow, cap.issued_for.stage_cursor, role);
}

function authorizeBoundRecord(
  cwd: string,
  state: TeamState,
  target: ResolvedState,
  cap: ActiveCapability,
  input: DispatchAuth,
): TransitionResult {
  if (cap.status === "invalidated" || cap.status === "complete") return { ok: false, error: "capability invalidated", state };
  const role = input.slot_id ?? input.role ?? "";
  const rosterEntry = cap.expected_roster.find((entry) => entry.role === role);
  if (!rosterEntry) return { ok: false, error: "role/slot not expected", state };
  if (input.role !== undefined && input.role !== role) return { ok: false, error: "slot identity mismatch", state };
  if (input.expected_count !== undefined && input.expected_count !== cap.expected_count) return { ok: false, error: "cardinality mismatch", state };
  const taskId = expectedTaskId(cap, role);
  if (input.task_id !== undefined && input.task_id !== taskId) return { ok: false, error: "task identity mismatch", state };
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
      persist(cwd, reboundState, target);
      return { ok: true, state: reboundState, record: rebound };
    }
    if ((sameTool || sameTask) && (!input.task_id || latest.work_identity?.task_id === input.task_id)) return { ok: true, state, record: latest };
  }
  if (latest && (!input.retry_of || input.retry_of !== latest.id || (latest.status !== "failed" && latest.status !== "cancelled"))) {
    return { ok: false, error: "retry requires an explicit terminal failure linkage", state };
  }
  const dispatchId = randomUUID();
  const attempt = latest ? latest.attempt + 1 : 1;
  const identity = workIdentityFor(state, cap, role, rosterEntry.agent, dispatchId, attempt, taskId);
  const pending = pendingFor(identity, "authorized", undefined, undefined, latest?.id ?? null);
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
    completion_envelope: completionEnvelopeFor(identity, "pending", null, [], "authorized", "engine_task_caller"),
  };
  const next: TeamState = {
    ...state,
    work_identity: identity,
    completion_envelope: completionEnvelopeFor(identity, "pending", null, [], "authorized", "engine_task_caller"),
    dispatch_capability: {
      ...cap,
      status: "dispatched",
      dispatches: [...cap.dispatches, record],
      pending: [...(cap.pending ?? []), pending],
    },
  };
  persist(cwd, next, target);
  return { ok: true, state: next, record };
}

/** Persist authorization before any native task is executed. */
export function authorizeDispatch(cwd: string, authInput: DispatchAuth): TransitionResult {
  const found = current(cwd);
  if (!found) return { ok: false, error: "state not found" };
  const { state, target } = found;
  if (target.isStale) return { ok: false, error: "workflow state is stale for the active branch", state };
  const cap = activeCapability(state.dispatch_capability);
  if (!cap) return { ok: false, error: "dispatch capability unavailable", state };
  const error = auth(cap, authInput, cap.dispatch_token_hash);
  if (error) return { ok: false, error, state };
  return authorizeBoundRecord(cwd, state, target, cap, authInput);
}

export interface TrustedDispatchInput {
  capability_id: string;
  run_key: string;
  branch: string;
  workflow: string;
  profile_hash: string;
  stage_cursor: string;
  cursor_epoch: string;
  role: string;
  slot_id?: string;
  task_id?: string;
  agent: string;
  tool_call_id: string;
  expected_count?: number;
  retry_of?: string;
}

/** Authorize a task after the trusted runtime gate validated its marker. */
export function authorizeDispatchTrusted(cwd: string, input: TrustedDispatchInput): TransitionResult {
  const found = current(cwd);
  if (!found) return { ok: false, error: "state not found" };
  const { state, target } = found;
  if (resolveActiveBranch(cwd) !== state.branch) return { ok: false, error: "workflow state is stale for the active branch", state };
  const cap = activeCapability(state.dispatch_capability);
  if (!cap) return { ok: false, error: "dispatch capability unavailable", state };
  const binding = cap.issued_for;
  if (
    input.capability_id !== cap.capability_id
    || input.run_key !== binding.run_key
    || input.branch !== binding.branch
    || input.workflow !== binding.workflow
    || input.profile_hash !== binding.profile_hash
    || input.stage_cursor !== binding.stage_cursor
    || input.cursor_epoch !== binding.cursor_epoch
  ) return { ok: false, error: "capability binding mismatch", state };
  if (!input.tool_call_id) return { ok: false, error: "tool call identity required", state };
  return authorizeBoundRecord(cwd, state, target, cap, {
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
  cwd: string,
  state: TeamState,
  target: ResolvedState,
  cap: ActiveCapability,
  record: DispatchRecord,
  reason: PendingState["pending_reason"] = "provider_running",
  providerRef?: string,
): TransitionResult {
  if (record.status === "succeeded" || record.status === "failed" || record.status === "cancelled") return { ok: false, error: "terminal dispatch cannot become pending", state };
  const identity = record.work_identity ?? workIdentityFor(state, cap, record.role, record.agent, record.id, record.attempt);
  const previous = record.pending;
  if (previous?.status === "pending" && previous.provider_ref === providerRef && previous.pending_reason === reason) return { ok: true, state, record };
  if (previous?.status === "pending" && previous.provider_ref !== providerRef) return { ok: false, error: "conflicting pending replay", state };
  const pending = pendingFor(identity, "pending", reason, providerRef, previous?.retry_of ?? null);
  const envelope = completionEnvelopeFor(identity, "pending", null, [], providerRef ?? reason, "engine_task_caller");
  const updated: DispatchRecord = {
    ...record,
    status: "pending",
    work_identity: identity,
    pending,
    completion_envelope: envelope,
  };
  const nextCapability = {
    ...cap,
    status: "dispatched" as const,
    dispatches: cap.dispatches.map((candidate) => candidate.id === record.id ? updated : candidate),
    pending: [...(cap.pending ?? []).filter((candidate) => candidate.identity.dispatch_id !== record.id), pending],
  };
  const next: TeamState = {
    ...state,
    work_identity: identity,
    pending,
    completion_envelope: envelope,
    dispatch_capability: nextCapability,
    pause: { kind: "background_wait", reason: providerRef ? `provider work pending (${providerRef})` : "provider work remains pending" },
    updated_at: now(),
  };
  persist(cwd, next, target);
  return { ok: true, state: next, record: updated };
}

/** Persist a neutral provider-running state before returning to the caller. */
export function persistPendingDispatch(
  cwd: string,
  input: DispatchAuth & { dispatch_id: string; pending_reason?: PendingState["pending_reason"]; provider_ref?: string },
): TransitionResult {
  const found = current(cwd);
  if (!found) return { ok: false, error: "state not found" };
  const { state, target } = found;
  if (target.isStale) return { ok: false, error: "workflow state is stale for the active branch", state };
  const cap = activeCapability(state.dispatch_capability);
  if (!cap) return { ok: false, error: "dispatch capability unavailable", state };
  const error = auth(cap, input, cap.dispatch_token_hash);
  if (error) return { ok: false, error, state };
  const record = cap.dispatches.find((candidate) => candidate.id === input.dispatch_id);
  if (!record) return { ok: false, error: "unknown dispatch", state };
  if (input.role !== undefined && input.role !== record.role) return { ok: false, error: "dispatch slot mismatch", state };
  return pendingRecord(cwd, state, target, cap, record, input.pending_reason, input.provider_ref);
}

/** Alias retained for adapters that name the transition as a lifecycle update. */
export const markDispatchPending = persistPendingDispatch;

function completeRecord(
  cwd: string,
  state: TeamState,
  target: ResolvedState,
  cap: ActiveCapability,
  record: DispatchRecord,
  input: CompletionInput,
): TransitionResult {
  if (cap.status === "invalidated" || cap.status === "complete") return { ok: false, error: "capability invalidated", state };
  if (!input.evidence.trim()) return { ok: false, error: "completion evidence required", state };
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
  if (unsafeArtifacts || (missingArtifacts && !deferredNativeArtifacts)) return { ok: false, error: "declared artifact missing or unsafe", state };
  if (previousCompletion && !(sameOutcome && sameArtifacts) && !deferredNativeArtifacts) return { ok: false, error: "conflicting replay", state };
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
      const deferredState: TeamState = {
        ...state,
        work_identity: identity,
        completion_envelope: deferredEnvelope,
        dispatch_capability: { ...cap, dispatches: cap.dispatches.map((candidate) => candidate.id === record.id ? deferredRecord : candidate) },
        updated_at: now(),
      };
      persist(cwd, deferredState, target);
      return { ok: true, state: deferredState, record: deferredRecord };
    }
    return { ok: false, error: snapshotted.error, state };
  }
  if (previousCompletion && sameOutcome && sameArtifacts) {
    const replayedRecord: DispatchRecord = { ...record, work_identity: identity };
    const replayedState: TeamState = {
      ...snapshotted.state,
      work_identity: identity,
      ...(snapshotted.state.pending ? { pending: snapshotted.state.pending } : {}),
      ...(record.completion_envelope ? { completion_envelope: record.completion_envelope } : {}),
      dispatch_capability: { ...cap, dispatches: cap.dispatches.map((candidate) => candidate.id === record.id ? replayedRecord : candidate) },
      updated_at: now(),
    };
    persist(cwd, replayedState, target);
    return { ok: true, state: replayedState, record: replayedRecord };
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
  const nextCapability = {
    ...cap,
    dispatches: cap.dispatches.map((candidate) => candidate.id === record.id ? updated : candidate),
    pending: [...(cap.pending ?? []).filter((candidate) => candidate.identity.dispatch_id !== record.id), terminalPending],
  };
  const activePending = nextCapability.dispatches.some((candidate) => candidate.status === "pending" || candidate.status === "running");
  const next: TeamState = {
    ...snapshotted.state,
    work_identity: identity,
    ...(activePending ? { pending: nextCapability.dispatches.find((candidate) => candidate.status === "pending")?.pending } : {}),
    completion_envelope: envelope,
    dispatch_capability: nextCapability,
    pause: activePending ? { kind: "background_wait", reason: "provider work remains pending" } : { kind: "none", reason: "" },
    updated_at: now(),
  };
  persist(cwd, next, target);
  return { ok: true, state: next, record: updated };
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
  const found = current(cwd); if (!found) return { ok: false, error: "state not found" };
  const { state, target } = found;
  if (target.isStale) return { ok: false, error: "workflow state is stale for the active branch", state };
  const cap = activeCapability(state.dispatch_capability); if (!cap) return { ok: false, error: "dispatch capability unavailable", state };
  const error = auth(cap, input, cap.dispatch_token_hash); if (error) return { ok: false, error, state };
  const record = cap.dispatches.find((d) => d.id === input.dispatch_id);
  if (!record) return { ok: false, error: "unknown dispatch", state };
  if (input.role !== undefined && input.role !== record.role) return { ok: false, error: "dispatch role mismatch", state };
  if (input.slot_id !== undefined && input.slot_id !== record.work_identity?.slot_id && input.slot_id !== record.role) return { ok: false, error: "dispatch slot mismatch", state };
  if (input.task_id !== undefined && input.task_id !== record.work_identity?.task_id) return { ok: false, error: "dispatch task mismatch", state };
  if (input.agent !== undefined && input.agent !== record.agent) return { ok: false, error: "dispatch agent mismatch", state };
  if (input.tool_call_id !== undefined && record.tool_call_id !== undefined && input.tool_call_id !== record.tool_call_id) return { ok: false, error: "dispatch tool-call mismatch", state };
  if (input.pending === true) return pendingRecord(cwd, state, target, cap, record, input.pending_reason, input.provider_ref);
  if (!input.outcome || !input.evidence) return { ok: false, error: "terminal completion outcome and evidence are required", state };
  return completeRecord(cwd, state, target, cap, record, input as CompletionInput);
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
  const found = current(cwd);
  if (!found) return { ok: false, error: "state not found" };
  if (resolveActiveBranch(cwd) !== found.state.branch) return { ok: false, error: "workflow state is stale for the active branch", state: found.state };
  const cap = activeCapability(found.state.dispatch_capability);
  if (!cap) return { ok: false, error: "dispatch capability unavailable", state: found.state };
  if (input.capability_id && input.capability_id !== cap.capability_id) return { ok: false, error: "capability identity mismatch", state: found.state };
  if (input.cursor_epoch && input.cursor_epoch !== cap.issued_for.cursor_epoch) return { ok: false, error: "cursor epoch mismatch", state: found.state };
  let candidates = cap.dispatches.filter((record) => {
    if (input.dispatch_id && record.id !== input.dispatch_id) return false;
    if (input.tool_call_id && record.tool_call_id !== input.tool_call_id) return false;
    if (input.slot_id && input.slot_id !== record.role && input.slot_id !== record.work_identity?.slot_id) return false;
    if (input.task_id && input.task_id !== record.work_identity?.task_id) return false;
    if (input.work_identity && JSON.stringify(record.work_identity) !== JSON.stringify(input.work_identity)) return false;
    return !record.completion;
  });
  if (candidates.length !== 1) return { ok: false, error: candidates.length === 0 ? "unknown or already reconciled dispatch" : "ambiguous positional result", state: found.state };
  const record = candidates[0];
  if (!record) return { ok: false, error: "dispatch result identity disappeared", state: found.state };
  if (input.role && input.role !== record.role) return { ok: false, error: "dispatch role mismatch", state: found.state };
  if (input.pending) return pendingRecord(cwd, found.state, found.target, cap, record, input.pending_reason, input.provider_ref);
  return completeRecord(cwd, found.state, found.target, cap, record, {
    outcome: input.outcome,
    evidence: input.evidence,
    artifact_ids: input.artifact_ids,
    completed_by: "synchronous_tool_result",
    terminal_signal: input.terminal_signal ?? "native_tool_result",
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
    const result = completeRecord(cwd, recovered, target, currentCap, record, {
      outcome: completion.outcome,
      evidence: `${completion.evidence}\nRecovered declared artifact ids at workflow advance.`,
      artifact_ids: artifactIds,
      completed_by: "synchronous_tool_result",
    });
    if (!result.ok) return { ok: false, error: result.error };
    recovered = result.state;
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
  return result.value ? null : `gate '${gate}' is not satisfied`;
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
   * Product approval gate. Requires a durable decision for the
   * (stage, checkpoint) pair ('product_approval', 'product_approval'):
   * recorded interactively, never autonomous, normalized to exactly one of
   * the four allowed product decisions. Attached to both the
   * `product_approval` stage (which records the decision) and the
   * `product_handoff` stage (which consumes the approval record), so the
   * decision lookup is keyed by the declaring stage id, not the gate host.
   */
  product_approval_recorded: (state) => {
    const PRODUCT_APPROVAL_STAGE = "product_approval";
    const PRODUCT_APPROVAL_CHECKPOINT = "product_approval";
    const PRODUCT_DECISIONS = ["proceed", "needs_more_validation", "defer", "reject"];
    const decision = findCheckpointDecision(state, PRODUCT_APPROVAL_STAGE, PRODUCT_APPROVAL_CHECKPOINT);
    if (!decision) {
      return "product_approval_recorded gate: no durable decision recorded for checkpoint 'product_approval' (stage 'product_approval'); the product owner must answer via workflow_checkpoint with checkpoint_kind=product_approval, authorization=human, and actor_provenance bound to the product-owner answer; decision exactly one of proceed | needs_more_validation | defer | reject — no inferred consent";
    }
    if (decision.mode !== "interactive") {
      return `product_approval_recorded gate: checkpoint 'product_approval' was not recorded with interactive human authorization (projection mode '${decision.mode}'); product approval requires actor provenance from the product owner — autonomous decisions are rejected`;
    }
    const normalized = decision.decision.trim().toLowerCase();
    if (!PRODUCT_DECISIONS.includes(normalized)) {
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
  const found = current(cwd);
  if (!found) return { ok: false, error: "state not found" };
  const { state: rawState, target } = found;
  if (target.isStale) return { ok: false, error: "workflow state is stale for the active branch", state: rawState };
  const cap = activeCapability(rawState.dispatch_capability);
  if (!cap) return { ok: false, error: "dispatch capability unavailable", state: rawState };
  const error = auth(cap, input, cap.advance_token_hash);
  if (error) return { ok: false, error, state: rawState };
  if (cap.status === "invalidated" || cap.status === "complete") return { ok: false, error: "capability invalidated", state: rawState };
  if (input.cursor_epoch !== cap.issued_for.cursor_epoch || rawState.stage_cursor !== cap.issued_for.stage_cursor || rawState.cursor_epoch !== cap.issued_for.cursor_epoch) return { ok: false, error: "stale cursor binding", state: rawState };
  if (typeof input.evidence !== "string" || !input.evidence.trim()) return { ok: false, error: "stage advancement evidence required", state: rawState };
  const profile = loadProfile(cap.issued_for.workflow);
  if (!profile || profileHash(profile) !== cap.issued_for.profile_hash) return { ok: false, error: "workflow profile is missing or stale", state: rawState };
  const currentStage = profile.stages.find((candidate) => candidate.id === rawState.stage_cursor);
  if (!currentStage) return { ok: false, error: "current workflow stage unavailable", state: rawState };

  const config = resolveConfig(cwd);
  const trusted = bindTrustedMapping(config, options?.trustedMapping);
  if (!trusted.ok) return { ok: false, error: trusted.error, state: rawState };
  const effectiveConfig = trusted.config;
  const flags = rawState.scope ?? resolveScope([], config);
  const recovered = recoverSynchronousArtifactIds(cwd, rawState, target, cap, currentStage);
  if (!recovered.ok) return { ok: false, error: recovered.error, state: rawState };
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
      persist(cwd, pendingState, target);
      return { ok: false, error: "dispatch join pending", state: pendingState };
    }
    return { ok: false, error: "dispatch join incomplete", state };
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
      return {
        ok: false,
        error: `consilium fan-in incomplete: dispatches without recorded artifact_ids: ${withoutArtifacts.join(", ")}; call workflow_complete with each slot's artifact ids before workflow_advance`,
        state,
      };
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
    if (!synthesized.ok) return { ok: false, error: synthesized.error, state };
    state = synthesized.state;
  }

  // Executable document stage: the engine renders the declared document
  // from the stage's declared sources BEFORE the completion validation
  // commits the transition — the native /do-work path never depends on an
  // agent having rendered it, and a failed render fails the advance closed.
  if (currentStage.type === "document") {
    const rendered = renderStageDocument(currentStage, target);
    if (!rendered.ok) return { ok: false, error: rendered.error, state };
  }

  // Stage completion validation: consumes, produces, schema contracts, the
  // validation gate and the gate expression all fail closed.
  const completion = validateStageCompletion(currentStage, state, target, input.evidence, flags, profile);
  if (!completion.ok) return { ok: false, error: completion.error, state };

  // Unresolved declared checkpoints block advance.
  const checkpointError = unresolvedCheckpointError(currentStage, state);
  if (checkpointError) {
    persist(cwd, state, target);
    return { ok: false, error: checkpointError, state };
  }

  // Bounded loop: evaluate `until`; re-enter `back_to` with a fresh
  // epoch/capability or map exhaustion to needs_human/failed.
  if (currentStage.loop) {
    const until = evaluatePredicate(currentStage.loop.until, {
      flags,
      artifactsDir: target.artifactsDir ?? "",
      state,
      stage: currentStage,
    });
    if (!until.ok) return { ok: false, error: `loop until evaluation failed: ${until.error}`, state };
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
        persist(cwd, next, target);
        return { ok: true, state: next };
      }
      return reenterLoop(cwd, state, target, profile, cap, currentStage, records, joinSummary, decision.reentries, flags, effectiveConfig, trusted.trusted);
    }
    const existingLoop = loopStateFor(state, currentStage.id);
    if (existingLoop) {
      state = { ...state, loop_state: { ...existingLoop, status: "complete" as const, ended_at: now() } };
    }
  }

  const index = state.stages.findIndex((s) => s.id === state.stage_cursor);
  if (index < 0) return { ok: false, error: "current workflow stage unavailable", state };

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
    if (entry && !candidate) return { ok: false, error: "next workflow stage unavailable", state };
    if (!entry || !candidate) break;
    if (candidate.skip_if) {
      const skip = evaluatePredicate(candidate.skip_if, {
        flags,
        artifactsDir: target.artifactsDir ?? "",
        state,
        stage: candidate,
      });
      if (!skip.ok) {
        return { ok: false, error: `next stage '${candidate.id}' skip_if evaluation failed: ${skip.error}`, state };
      }
      if (skip.value) {
        skippedStageIds.push(candidate.id);
        continue;
      }
    }
    nextStage = candidate;
    break;
  }
  const epoch = randomUUID();
  let handoffSecrets: { capability_id: string; dispatch_token: string; advance_token: string } | undefined;
  // Automatic capability issuance during advance never freezes a roster for
  // a roster-policy stage: such a next stage stays semantically unselected
  // and pending until its explicit workflow_begin freezes a selection from
  // the trusted or persisted live registered mapping. Only a non-roster
  // stage — executable, or an orchestrator shell — is atomically armed here.
  let armedStage: StageDef | undefined;
  const { roster_selection: _completedSelection, ...completedCap } = cap;
  let nextCap: NonNullable<TeamState["dispatch_capability"]> = { ...completedCap, status: "complete" as const, dispatches: [] };
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
              return {
                ok: false,
                error: `next stage '${nextStage.id}' dispatch roster unresolved: role '${slot.role}' is missing or unavailable in the trusted agent mapping handoff's resolved_roles`,
                state,
              };
            }
            expectedRoster.push({ role: slot.slot, agent });
          }
        } catch (error) {
          return { ok: false, error: `next stage '${nextStage.id}' dispatch roster unresolved: ${String(error)}`, state };
        }
        if ((nextKind === "single" && slots.length !== 1) || (nextKind === "consilium" && slots.length === 0)) {
          return { ok: false, error: `next stage '${nextStage.id}' has an invalid dispatch roster`, state };
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
  const next: TeamState = {
    ...carriedState,
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
    pause: nextStage ? state.pause : { kind: "done", reason: "" },
  };
  persist(cwd, next, target);
  return { ok: true, state: next, handoff: armedStage && handoffSecrets ? handoffFromState(next, handoffSecrets, armedStage) : undefined };
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
): TransitionResult {
  const loop = currentStage.loop!;
  const backToStage = resolveBackToStage(profile, loop.back_to);
  if (!backToStage) return { ok: false, error: `loop back_to '${loop.back_to}' is not a stage in the profile`, state };
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
          return {
            ok: false,
            error: `loop target stage '${backToStage.id}' dispatch roster unresolved: role '${slot.role}' is missing or unavailable in the trusted agent mapping handoff's resolved_roles`,
            state,
          };
        }
        expectedRoster.push({ role: slot.slot, agent });
      }
    } catch (error) {
      return { ok: false, error: `loop target stage '${backToStage.id}' dispatch roster unresolved: ${String(error)}`, state };
    }
  }
  if (!deferredRoster && ((kind === "single" && slots.length !== 1) || (kind === "consilium" && slots.length === 0))) {
    return { ok: false, error: `loop target stage '${backToStage.id}' has an invalid dispatch roster`, state };
  }
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
      });
  const iteration = reentries + 1;
  const loopState: LoopState = {
    stage_id: currentStage.id,
    back_to: loop.back_to,
    until: loop.until,
    max_iterations: loop.max_iterations,
    on_exhausted: loop.on_exhausted,
    reentries: iteration,
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
    updated_at: now(),
  };
  persist(cwd, next, target);
  return issued
    ? {
        ok: true,
        state: next,
        handoff: handoffFromState(next, {
          capability_id: issued.capability_id,
          dispatch_token: issued.dispatch_token,
          advance_token: issued.advance_token,
        }, backToStage),
      }
    : { ok: true, state: next };
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
  const found = current(cwd);
  if (!found) return { ok: false, error: "state not found" };
  const { state, target } = found;
  if (target.isStale) return { ok: false, error: "workflow state is stale for the active branch", state };
  const cap = activeCapability(state.dispatch_capability);
  if (!cap) return { ok: false, error: "dispatch capability unavailable", state };
  if (!sameIdentity(input.parent, state.work_identity) && (
    input.parent.capability_id !== cap.capability_id
    || input.parent.capability_epoch !== cap.issued_for.cursor_epoch
  )) return { ok: false, error: "parent identity is not bound to the active capability", state };
  if (!input.child.run_id || !input.child.task_id || !input.child.dispatch_id || !input.child.worker_id) return { ok: false, error: "child identity is incomplete", state };
  if (sameIdentity(input.parent, input.child)) return { ok: false, error: "parent and child identities must differ", state };
  if (!Number.isInteger(input.attempt) || input.attempt < 1) return { ok: false, error: "child attempt must be a positive integer", state };
  if (new Set(input.expected_artifact_ids).size !== input.expected_artifact_ids.length || input.expected_artifact_ids.some((id) => !isSafeStateSegment(id))) {
    return { ok: false, error: "child artifact ids are unsafe or duplicated", state };
  }
  if (input.completion_envelope) {
    const terminal = input.state === "succeeded" || input.state === "failed" || input.state === "cancelled";
    if (
      !sameIdentity(input.completion_envelope.identity, input.child)
      || input.completion_envelope.outcome !== (terminal ? input.state : "pending")
      || (terminal ? input.completion_envelope.terminal_signal === null : input.completion_envelope.terminal_signal !== null)
    ) return { ok: false, error: "child completion envelope is not a validated terminal/pending envelope", state };
  }
  if ((input.state === "succeeded" || input.state === "failed" || input.state === "cancelled") && !input.completion_envelope) {
    return { ok: false, error: "terminal child join requires a completion envelope", state };
  }
  const existing = (state.child_joins ?? []).find((join) => sameIdentity(join.parent, input.parent) && sameIdentity(join.child, input.child));
  if (existing) {
    const exact = existing.state === input.state
      && existing.attempt === input.attempt
      && existing.completion_envelope_ref === input.completion_envelope_ref
      && JSON.stringify(existing.expected_artifact_ids) === JSON.stringify(input.expected_artifact_ids);
    if (exact) return { ok: true, state, child_join: existing };
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
    persist(cwd, next, target);
    return { ok: false, error: `child join conflict (${conflictRef})`, state: next, child_join: conflict };
  }
  const priorChild = (state.child_joins ?? []).find((join) => sameIdentity(join.parent, input.parent) && join.child.task_id === input.child.task_id);
  if (priorChild && priorChild.state !== "succeeded" && priorChild.state !== "failed" && priorChild.state !== "cancelled") {
    return { ok: false, error: "active child join cannot be replaced", state };
  }
  if (priorChild && input.attempt <= priorChild.attempt) return { ok: false, error: "child replacement attempt must increase", state };
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
  persist(cwd, next, target);
  return { ok: true, state: next, child_join: joined };
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

/** Persist a policy-bound typed checkpoint decision. */
export function recordCheckpointDecision(cwd: string, input: CheckpointDecisionInput): TransitionResult {
  const found = current(cwd);
  if (!found) return { ok: false, error: "state not found" };
  const { state, target } = found;
  if (target.isStale) return { ok: false, error: "workflow state is stale for the active branch", state };
  const cap = activeCapability(state.dispatch_capability);
  if (!cap) return { ok: false, error: "dispatch capability unavailable", state };
  const error = auth(cap, input, cap.advance_token_hash);
  if (error) return { ok: false, error, state };
  if (cap.status === "invalidated" || cap.status === "complete") return { ok: false, error: "capability invalidated", state };
  if (input.stage_cursor !== cap.issued_for.stage_cursor) return { ok: false, error: "checkpoint stage does not match the active capability", state };
  if (!input.checkpoint.trim() || !input.decision.trim()) return { ok: false, error: "checkpoint name and decision are required", state };
  if (!input.authorization || !input.actor_provenance) {
    return { ok: false, error: "typed checkpoint authorization and actor provenance are required; legacy mode/actor fields cannot authorize", state };
  }
  const profile = loadProfile(cap.issued_for.workflow);
  const stage = profile?.stages.find((candidate) => candidate.id === cap.issued_for.stage_cursor);
  if (!stage?.checkpoint) return { ok: false, error: `stage '${cap.issued_for.stage_cursor}' declares no checkpoint`, state };
  if (input.checkpoint !== stage.checkpoint || (input.checkpoint_id && input.checkpoint_id !== input.checkpoint)) {
    return { ok: false, error: `checkpoint '${input.checkpoint}' does not match declared checkpoint '${stage.checkpoint}'`, state };
  }
  const policy = resolveCheckpointPolicy(stage, state);
  if (!policy) return { ok: false, error: `checkpoint '${input.checkpoint}' has no policy`, state };
  const rule = policy.rules[input.checkpoint];
  if (!rule) return { ok: false, error: `checkpoint policy has no rule for '${input.checkpoint}'`, state };
  const decision: TypedCheckpointDecision = {
    run_id: input.run_id ?? state.work_identity?.run_id ?? state.run_key ?? state.branch,
    stage_id: stage.id,
    checkpoint_id: input.checkpoint,
    checkpoint_kind: input.checkpoint_kind ?? rule.kind,
    decision: input.decision.trim(),
    authorization: input.authorization,
    actor: input.actor_provenance,
    capability_id: cap.capability_id,
    capability_epoch: cap.issued_for.cursor_epoch,
    policy_hash: checkpointPolicyHash(policy),
    rationale: input.rationale.trim(),
    decided_at: now(),
  };
  const validated = validateCheckpointDecision(state, decision, { stage, policy });
  if (!validated.ok) return { ok: false, error: `${validated.code}: ${validated.error}`, state };
  try {
    const next = appendCheckpointDecision(state, validated.decision);
    persist(cwd, next, target);
    return { ok: true, state: next };
  } catch (appendError) {
    return { ok: false, error: appendError instanceof Error ? appendError.message : String(appendError), state };
  }
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
  const found = current(cwd);
  if (!found) return { ok: false, error: "state not found" };
  if (found.target.isStale) return { ok: false, error: "workflow state is stale for the active branch", state: found.state };
  const cap = activeCapability(found.state.dispatch_capability);
  if (!cap || cap.capability_id !== input.capability_id || (input.cursor_epoch && cap.issued_for.cursor_epoch !== input.cursor_epoch)) return { ok: false, error: "capability binding mismatch", state: found.state };
  const records = cap.dispatches.filter((record) =>
    !record.completion
    && (input.dispatch_id ? record.id === input.dispatch_id : record.tool_call_id === input.tool_call_id)
    && (!input.slot_id || input.slot_id === record.role || input.slot_id === record.work_identity?.slot_id)
    && (!input.task_id || input.task_id === record.work_identity?.task_id),
  );
  if (records.length !== 1) return { ok: false, error: records.length === 0 ? "unknown dispatch" : "ambiguous positional result", state: found.state };
  const record = records[0];
  if (!record) return { ok: false, error: "dispatch result identity disappeared", state: found.state };
  const asyncState = input.details?.async?.state;
  const remainsPending = asyncState === "running" || asyncState === "spawned" || asyncState === "scheduled" || (!input.output && !input.isError);
  if (remainsPending) {
    return completeDispatch(cwd, {
      dispatch_id: record.id,
      token: input.token,
      capability_id: input.capability_id,
      run_key: cap.issued_for.run_key,
      branch: cap.issued_for.branch,
      workflow: cap.issued_for.workflow,
      profile_hash: cap.issued_for.profile_hash,
      stage_cursor: cap.issued_for.stage_cursor,
      cursor_epoch: cap.issued_for.cursor_epoch,
      role: record.role,
      slot_id: record.work_identity?.slot_id,
      task_id: record.work_identity?.task_id,
      agent: record.agent,
      tool_call_id: record.tool_call_id,
      pending: true,
      pending_reason: "provider_running",
      provider_ref: input.details?.async?.provider_ref ?? asyncState,
    });
  }
  const evidence = input.output?.trim() || (input.isError ? "task failed" : "");
  return completeDispatch(cwd, {
    dispatch_id: record.id,
    token: input.token,
    capability_id: input.capability_id,
    run_key: cap.issued_for.run_key,
    branch: cap.issued_for.branch,
    workflow: cap.issued_for.workflow,
    profile_hash: cap.issued_for.profile_hash,
    stage_cursor: cap.issued_for.stage_cursor,
    cursor_epoch: cap.issued_for.cursor_epoch,
    role: record.role,
    slot_id: record.work_identity?.slot_id,
    task_id: record.work_identity?.task_id,
    agent: record.agent,
    tool_call_id: record.tool_call_id,
    outcome: input.isError ? "failed" : "succeeded",
    evidence,
    completed_by: "synchronous_tool_result",
  });
}
