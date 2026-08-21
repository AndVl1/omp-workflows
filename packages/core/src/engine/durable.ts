import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { loadProfile, profileHash } from "./profile.js";
import { resolveState, writeState, isSafeStateSegment, resolveActiveBranch, type ResolvedState } from "./state.js";
import { resolveConfig, resolveAgentForRole } from "./config.js";
import { resolveScope, type ScopeFlags } from "./scope.js";
import { resolveStageDispatchSlots } from "./stage.js";
import { readArtifact, writeArtifact } from "./artifacts.js";
import { isDoDComplete, isRootCauseDocumented, readDoD } from "./dod.js";
import { validationGate } from "../gates/validation.js";
import { buildDispatchMarker } from "../gates/dispatch.js";
import { evaluatePredicate } from "./predicate.js";
import { appendCheckpointDecision, findCheckpointDecision, unresolvedCheckpointError } from "./checkpoints.js";
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
import type { CheckpointDecision, DispatchCompletion, DispatchRecord, HandoffContext, HandoffRecord, HandoffRoute, LoopState, TeamState, StageDef } from "./types.js";

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
  evidence?: string;
  agent?: string;
  expected_count?: number;
  tool_call_id?: string;
};

type ActiveCapability = {
  capability_id: string; dispatch_token_hash: string; advance_token_hash: string;
  issued_for: { run_key: string; branch: string; workflow: TeamState["classification"]["workflow"]; profile_hash: string; stage_cursor: string; cursor_epoch: string };
  kind: "none" | "single" | "consilium"; expected_roles: string[]; expected_count: number;
  expected_roster: Array<{ role: string; agent: string }>;
  status: "ready" | "dispatched" | "joining" | "complete" | "invalidated"; dispatches: DispatchRecord[];
};
const activeCapability = (value: TeamState["dispatch_capability"]): ActiveCapability | null => {
  if (
    !value?.issued_for ||
    typeof value.issued_for !== "object" ||
    typeof value.capability_id !== "string" ||
    !value.capability_id ||
    typeof value.dispatch_token_hash !== "string" ||
    !/^[0-9a-f]{64}$/.test(value.dispatch_token_hash) ||
    typeof value.advance_token_hash !== "string" ||
    !/^[0-9a-f]{64}$/.test(value.advance_token_hash) ||
    !Array.isArray(value.dispatches) ||
    !Array.isArray(value.expected_roles) ||
    value.expected_count === undefined ||
    !Number.isInteger(value.expected_count) ||
    !Array.isArray(value.expected_roster) ||
    !value.status
  ) return null;
  const issued = value.issued_for;
  const expectedRoles = value.expected_roles;
  const expectedRoster = value.expected_roster;
  const expectedCount = value.expected_count;
  if (!["none", "single", "consilium"].includes(value.kind) || !["ready", "dispatched", "joining", "complete", "invalidated"].includes(value.status)) return null;
  if ([issued.run_key, issued.branch, issued.workflow, issued.profile_hash, issued.stage_cursor, issued.cursor_epoch].some((field) => typeof field !== "string" || !field)) return null;
  if ((value.kind === "none" ? expectedCount !== 0 : expectedCount <= 0) || expectedCount !== expectedRoles.length || expectedCount !== expectedRoster.length) return null;
  if (expectedRoles.some((role) => typeof role !== "string" || !role) || expectedRoster.some((entry) => !entry || typeof entry !== "object" || typeof entry.role !== "string" || !entry.role || typeof entry.agent !== "string" || !entry.agent)) return null;
  if (new Set(expectedRoles).size !== expectedRoles.length || new Set(expectedRoster.map((r) => r.role)).size !== expectedRoster.length) return null;
  if (expectedRoles.some((role) => !expectedRoster.some((entry) => entry.role === role))) return null;
  const terminalStatuses = new Set(["succeeded", "failed", "cancelled"]);
  if (
    new Set(value.dispatches.map((record) => record?.id)).size !== value.dispatches.length ||
    value.dispatches.some((record) => {
      if (!record || typeof record.id !== "string" || !record.id || typeof record.role !== "string" || !record.role || !expectedRoles.includes(record.role) || typeof record.agent !== "string" || !record.agent || !expectedRoster.some((entry) => entry.role === record.role && entry.agent === record.agent) || !["authorized", "running", "succeeded", "failed", "cancelled"].includes(record.status) || !Number.isInteger(record.attempt) || record.attempt < 1 || typeof record.created_at !== "string" || (record.tool_call_id !== undefined && (typeof record.tool_call_id !== "string" || !record.tool_call_id))) return true;
      const completion = record.completion;
      if (!terminalStatuses.has(record.status)) return completion !== undefined;
      return !completion ||
        typeof completion !== "object" ||
        completion.dispatch_id !== record.id ||
        completion.cursor_epoch !== issued.cursor_epoch ||
        completion.outcome !== record.status ||
        typeof completion.evidence !== "string" ||
        !completion.evidence.trim() ||
        !Array.isArray(completion.artifact_ids) ||
        new Set(completion.artifact_ids).size !== completion.artifact_ids.length ||
        completion.artifact_ids.some((id) => typeof id !== "string" || !isSafeStateSegment(id)) ||
        !["workflow_complete", "synchronous_tool_result", "engine_task_caller"].includes(completion.completed_by) ||
        typeof completion.completed_at !== "string" ||
        record.completed_at !== completion.completed_at;
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

export type TransitionResult = { ok: true; state: TeamState; record?: DispatchRecord; handoff?: CapabilityHandoff } | { ok: false; error: string; state?: TeamState };

export interface CapabilityDispatchMarker {
  role: string;
  marker: string;
}

export interface CapabilityHandoff {
  capability_id: string;
  dispatch_token: string;
  advance_token: string;
  run_key: string;
  branch: string;
  workflow: TeamState["classification"]["workflow"];
  profile_hash: string;
  stage_cursor: string;
  cursor_epoch: string;
  kind: "none" | "single" | "consilium";
  expected_roster: Array<{ role: string; agent: string }>;
  dispatch_markers: CapabilityDispatchMarker[];
}

function handoffFromState(
  cwd: string,
  state: TeamState,
  secrets: { capability_id: string; dispatch_token: string; advance_token: string },
): CapabilityHandoff | undefined {
  const cap = activeCapability(state.dispatch_capability);
  if (!cap) return undefined;
  const profile = loadProfile(cap.issued_for.workflow);
  const stage = profile?.stages.find((candidate) => candidate.id === cap.issued_for.stage_cursor);
  if (!stage) return undefined;
  const stageKind = stage.type === "single" || stage.type === "consilium" ? stage.type : "none";
  if (stageKind !== cap.kind) return undefined;

  const config = resolveConfig(cwd);
  const flags = state.scope ?? resolveScope([], config);
  const slots = stageKind === "none"
    ? []
    : resolveStageDispatchSlots(stage, { cwd, flags, resolveDevAgent: () => flags.dev_agent });
  const resolvedRoster = slots.map((slot) => ({ role: slot.slot, agent: resolveAgentForRole(slot.role, config) }));
  if (JSON.stringify(resolvedRoster) !== JSON.stringify(cap.expected_roster)) return undefined;

  const roles = cap.expected_roster.map((entry) => entry.role);
  const dispatch_markers = cap.expected_roster.map(({ role }) => ({
    role,
    marker: buildDispatchMarker(cap.issued_for.run_key, stage, roles, role, cap.issued_for.cursor_epoch),
  }));
  return {
    capability_id: secrets.capability_id,
    dispatch_token: secrets.dispatch_token,
    advance_token: secrets.advance_token,
    run_key: cap.issued_for.run_key,
    branch: cap.issued_for.branch,
    workflow: cap.issued_for.workflow,
    profile_hash: cap.issued_for.profile_hash,
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

export function hashDispatchSecret(secret: string): string { return hash(secret); }

export function createCapability(input: {
  run_key: string; branch: string; workflow: TeamState["classification"]["workflow"]; profile_hash: string;
  stage_cursor: string; cursor_epoch?: string; kind: "none" | "single" | "consilium"; expected_roles?: string[];
  dispatch_secret?: string; advance_secret?: string; expected_roster?: Array<{ role: string; agent: string }>;
}): { capability_id: string; dispatch_token: string; advance_token: string; state: NonNullable<TeamState["dispatch_capability"]> } {
  if (!input.run_key || !input.branch || !input.workflow || !input.profile_hash || !input.stage_cursor) throw new Error("invalid capability binding");
  const cursor_epoch = input.cursor_epoch ?? randomUUID();
  const dispatch_token = input.dispatch_secret ?? randomUUID();
  const advance_token = input.advance_secret ?? randomUUID();
  const roster = (input.expected_roster ?? (input.expected_roles ?? []).map((role) => ({ role, agent: role }))).map((entry) => ({ role: entry.role, agent: entry.agent }));
  const expected_roles = roster.map((entry) => entry.role);
  if (input.kind === "none" && roster.length !== 0 || input.kind === "single" && roster.length !== 1 || input.kind === "consilium" && roster.length === 0) throw new Error("capability roster does not match dispatch kind");
  if (new Set(expected_roles).size !== expected_roles.length || roster.some((entry) => !entry.role || !entry.agent)) throw new Error("invalid capability roster");
  const state = { capability_id: randomUUID(), dispatch_token_hash: hash(dispatch_token), advance_token_hash: hash(advance_token), issued_for: { run_key: input.run_key, branch: input.branch, workflow: input.workflow, profile_hash: input.profile_hash, stage_cursor: input.stage_cursor, cursor_epoch }, kind: input.kind, expected_roles, expected_count: roster.length, expected_roster: roster, status: "ready" as const, dispatches: [] };
  return { capability_id: state.capability_id, dispatch_token, advance_token, state };
}
/**
 * Create the opaque dispatch capability after the model has persisted the
 * classification and stage list. This is the entry point for the native
 * `/do-work` prompt; the interpreter path uses `createCapability` directly.
 */
export function beginCapability(cwd: string): TransitionResult {
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
  if (state.profile_hash && state.profile_hash !== persistedHash) {
    return { ok: false, error: "workflow profile hash is stale", state };
  }
  const stageId = state.stage_cursor || profile.stages[0]?.id;
  const stage = profile.stages.find((candidate) => candidate.id === stageId);
  if (!stage) return { ok: false, error: `workflow stage '${stageId ?? ""}' is unavailable`, state };
  const stageEntry = state.stages.find((candidate) => candidate.id === stage.id);
  if (!stageEntry) return { ok: false, error: `workflow stage '${stage.id}' is not persisted`, state };
  if (stageEntry.status === "done" || stageEntry.status === "skipped") {
    return { ok: false, error: `workflow stage '${stage.id}' is already ${stageEntry.status}`, state };
  }
  const existing = activeCapability(state.dispatch_capability);
  if (state.policy?.strict_orchestrator === true && state.dispatch_capability && !existing) {
    return { ok: false, error: "workflow dispatch capability is malformed", state };
  }
  if (existing && existing.issued_for.stage_cursor === stage.id && existing.status !== "complete" && existing.status !== "invalidated") {
    return { ok: false, error: "workflow stage already has an active capability; use the existing handoff", state };
  }
  const existingDispatches = existing?.issued_for.stage_cursor === stage.id ? existing.dispatches : [];
  const config = resolveConfig(cwd);
  const flags = state.scope ?? resolveScope([], config);
  const kind: "none" | "single" | "consilium" =
    stage.type === "single" || stage.type === "consilium" ? stage.type : "none";
  const slots = kind === "none"
    ? []
    : resolveStageDispatchSlots(stage, { cwd, flags, resolveDevAgent: () => flags.dev_agent });
  if ((kind === "single" && slots.length !== 1) || (kind === "consilium" && slots.length === 0)) {
    return { ok: false, error: `workflow stage '${stage.id}' has an invalid dispatch roster`, state };
  }
  const expectedRoster = slots.map((slot) => ({ role: slot.slot, agent: resolveAgentForRole(slot.role, config) }));
  if (existing && existingDispatches.length > 0 && JSON.stringify(existing.expected_roster) !== JSON.stringify(expectedRoster)) {
    return { ok: false, error: "active dispatch capability roster is inconsistent", state };
  }
  const issued = createCapability({
    run_key: state.run_key ?? state.branch,
    branch: state.branch,
    workflow,
    profile_hash: persistedHash,
    stage_cursor: stage.id,
    kind,
    expected_roster: expectedRoster,
  });
  const next: TeamState = {
    ...state,
    run_key: state.run_key ?? state.branch,
    profile_hash: persistedHash,
    cursor_epoch: issued.state.issued_for!.cursor_epoch,
    stage_cursor: stage.id,
    scope: flags,
    policy: { ...(state.policy ?? {}), strict_orchestrator: true },
    stages: state.stages.map((entry) => entry.id === stage.id ? { ...entry, status: "in_progress" as const } : entry),
    dispatch_capability: {
      ...issued.state,
      status: existingDispatches.length > 0 ? "dispatched" as const : "ready" as const,
      dispatches: existingDispatches,
    },
    pause: { kind: "none", reason: "" },
    updated_at: now(),
  };
  persist(cwd, next, target);
  return {
    ok: true,
    state: next,
    handoff: handoffFromState(cwd, next, {
      capability_id: issued.capability_id,
      dispatch_token: issued.dispatch_token,
      advance_token: issued.advance_token,
    }),
  };
}
function auth(cap: ActiveCapability, a: DispatchAuth, secretHash: string): string | null {
  if (!a.capability_id || a.capability_id !== cap.capability_id) return "capability identity mismatch";
  if (!a.token || hash(a.token) !== secretHash) return "invalid secret";
  const b = cap.issued_for;
  if (a.run_key !== b.run_key || a.branch !== b.branch || a.workflow !== b.workflow || a.profile_hash !== b.profile_hash || a.stage_cursor !== b.stage_cursor || a.cursor_epoch !== b.cursor_epoch) return "capability binding mismatch";
  return null;
}

/** Persist authorization before any native task is executed. */
export function authorizeDispatch(cwd: string, authInput: DispatchAuth): TransitionResult {
  const found = current(cwd); if (!found) return { ok: false, error: "state not found" };
  const { state, target } = found;
  if (target.isStale) return { ok: false, error: "workflow state is stale for the active branch", state };
  const cap = activeCapability(state.dispatch_capability); if (!cap) return { ok: false, error: "dispatch capability unavailable", state };
  const error = auth(cap, authInput, cap.dispatch_token_hash); if (error) return { ok: false, error, state };
  if (cap.status === "invalidated" || cap.status === "complete") return { ok: false, error: "capability invalidated", state };
  const role = authInput.role ?? ""; const rosterEntry = cap.expected_roster.find((entry) => entry.role === role);
  if (!rosterEntry) return { ok: false, error: "role not expected", state };
  if (authInput.agent !== rosterEntry.agent) return { ok: false, error: "agent does not match role roster", state };
  if (cap.dispatches.some((d) => d.role === role && d.status !== "failed" && d.status !== "cancelled")) return { ok: false, error: "role already dispatched", state };
  if (authInput.expected_count !== undefined && authInput.expected_count !== cap.expected_count) return { ok: false, error: "cardinality mismatch", state };
  const record: DispatchRecord = { id: randomUUID(), role, agent: rosterEntry.agent, tool_call_id: authInput.tool_call_id, status: "authorized", attempt: 1, created_at: now() };
  const next: TeamState = { ...state, dispatch_capability: { ...cap, status: "dispatched", dispatches: [...cap.dispatches, record] } };
  persist(cwd, next, target); return { ok: true, state: next, record };
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
  agent: string;
  tool_call_id: string;
  expected_count?: number;
}

/** Authorize a task after the trusted runtime gate validated its marker. */
export function authorizeDispatchTrusted(cwd: string, input: TrustedDispatchInput): TransitionResult {
  const found = current(cwd);
  if (!found) return { ok: false, error: "state not found" };
  const { state, target } = found;
  const branch = resolveActiveBranch(cwd);
  if (branch !== state.branch) return { ok: false, error: "workflow state is stale for the active branch", state };
  const cap = activeCapability(state.dispatch_capability);
  if (!cap) return { ok: false, error: "dispatch capability unavailable", state };
  const binding = cap.issued_for;
  if (
    input.capability_id !== cap.capability_id ||
    input.run_key !== binding.run_key ||
    input.branch !== binding.branch ||
    input.workflow !== binding.workflow ||
    input.profile_hash !== binding.profile_hash ||
    input.stage_cursor !== binding.stage_cursor ||
    input.cursor_epoch !== binding.cursor_epoch
  ) return { ok: false, error: "capability binding mismatch", state };
  if (cap.status === "invalidated" || cap.status === "complete") return { ok: false, error: "capability invalidated", state };
  if (!input.tool_call_id) return { ok: false, error: "tool call identity required", state };
  const rosterEntry = cap.expected_roster.find((entry) => entry.role === input.role);
  if (!rosterEntry) return { ok: false, error: "role not expected", state };
  if (rosterEntry.agent !== input.agent) return { ok: false, error: "agent does not match role roster", state };
  if (input.expected_count !== undefined && input.expected_count !== cap.expected_count) return { ok: false, error: "cardinality mismatch", state };
  const existing = cap.dispatches.find((record) => record.role === input.role);
  if (existing && existing.status !== "failed" && existing.status !== "cancelled") {
    if (existing.status !== "authorized" || (existing.tool_call_id && existing.tool_call_id !== input.tool_call_id)) {
      return { ok: false, error: "role already dispatched", state };
    }
    if (existing.tool_call_id === input.tool_call_id) return { ok: true, state, record: existing };
    const bound = { ...existing, tool_call_id: input.tool_call_id };
    const next: TeamState = { ...state, dispatch_capability: { ...cap, dispatches: cap.dispatches.map((record) => record.id === existing.id ? bound : record) } };
    persist(cwd, next, target);
    return { ok: true, state: next, record: bound };
  }
  const record: DispatchRecord = { id: randomUUID(), role: input.role, agent: input.agent, tool_call_id: input.tool_call_id, status: "authorized", attempt: 1, created_at: now() };
  const next: TeamState = { ...state, dispatch_capability: { ...cap, status: "dispatched", dispatches: [...cap.dispatches, record] } };
  persist(cwd, next, target);
  return { ok: true, state: next, record };
}

type CompletionInput = {
  outcome: DispatchCompletion["outcome"];
  evidence: string;
  artifact_ids?: string[];
  completed_by?: DispatchCompletion["completed_by"];
};

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
  if (
    new Set(artifact_ids).size !== artifact_ids.length ||
    artifact_ids.some((id) => !isSafeStateSegment(id) || (!existsSync(join(artifactDir, `${id}.json`)) && !Object.prototype.hasOwnProperty.call(declaredArtifacts, id)))
  ) {
    return { ok: false, error: "declared artifact missing or unsafe", state };
  }
  if (record.completion) {
    const sameOutcome = record.completion.outcome === input.outcome;
    const sameArtifacts = JSON.stringify(record.completion.artifact_ids) === JSON.stringify(artifact_ids);
    if (sameOutcome && sameArtifacts) return { ok: true, state, record };
    if (sameOutcome && record.completion.completed_by === "synchronous_tool_result" && record.completion.artifact_ids.length === 0 && artifact_ids.length > 0) {
      const completion = { ...record.completion, artifact_ids, evidence: input.evidence, completed_by: input.completed_by ?? "workflow_complete" };
      const updated: DispatchRecord = { ...record, completed_at: completion.completed_at, completion };
      const snapshotted = snapshotSlotArtifacts(state, cap, record, artifact_ids, artifactDir);
      if (!snapshotted.ok) return { ok: false, error: snapshotted.error, state };
      const next: TeamState = {
        ...snapshotted.state,
        dispatch_capability: { ...cap, dispatches: cap.dispatches.map((d) => d.id === record.id ? updated : d) },
      };
      persist(cwd, next, target);
      return { ok: true, state: next, record: updated };
    }
    return { ok: false, error: "conflicting replay", state };
  }
  const completion: DispatchCompletion = {
    dispatch_id: record.id,
    cursor_epoch: cap.issued_for.cursor_epoch,
    outcome: input.outcome,
    artifact_ids,
    evidence: input.evidence,
    completed_by: input.completed_by ?? "workflow_complete",
    completed_at: now(),
  };
  const updated: DispatchRecord = { ...record, status: input.outcome, completed_at: completion.completed_at, completion };
  const snapshotted = snapshotSlotArtifacts(state, cap, record, artifact_ids, artifactDir);
  if (!snapshotted.ok) return { ok: false, error: snapshotted.error, state };
  const next: TeamState = {
    ...snapshotted.state,
    dispatch_capability: { ...cap, dispatches: cap.dispatches.map((d) => d.id === record.id ? updated : d) },
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
): { ok: true; state: TeamState } | { ok: false; error: string } {
  if (cap.kind !== "consilium" || cap.expected_count <= 1 || artifactIds.length === 0) {
    return { ok: true, state };
  }
  const stageId = cap.issued_for.stage_cursor;
  const existing = state.slot_artifacts?.[stageId] ?? { slots: {} };
  const slots = { ...existing.slots };
  const slotMap = { ...(slots[record.role] ?? {}) };
  for (const id of artifactIds) {
    const value = readArtifact(artifactsDir, id);
    if (value === null) {
      return { ok: false, error: `slot '${record.role}' artifact '${id}' disappeared before completion` };
    }
    // Already slot-scoped ids are the slot's own provenance; only copy the
    // shared-id writes into the namespace before a later slot can clobber.
    const namespaced = isNamespacedArtifactId(id, record.role) ? id : namespacedArtifactId(id, record.role);
    if (namespaced !== id) {
      writeArtifact(artifactsDir, namespaced, value);
    }
    const hash = hashValue(value);
    const previous = slotMap[id];
    if (previous && previous.hash !== hash) {
      return { ok: false, error: `slot artifact conflict: slot '${record.role}' wrote '${id}' with different content` };
    }
    slotMap[id] = { path: join(artifactsDir, `${namespaced}.json`), hash };
  }
  slots[record.role] = slotMap;
  return { ok: true, state: { ...state, slot_artifacts: { ...(state.slot_artifacts ?? {}), [stageId]: { ...existing, slots } } } };
}

function hashValue(value: unknown): string {
  return hash(JSON.stringify(value));
}
export function completeDispatch(cwd: string, input: DispatchAuth & { dispatch_id: string } & CompletionInput): TransitionResult {
  const found = current(cwd); if (!found) return { ok: false, error: "state not found" };
  const { state, target } = found;
  if (target.isStale) return { ok: false, error: "workflow state is stale for the active branch", state };
  const cap = activeCapability(state.dispatch_capability); if (!cap) return { ok: false, error: "dispatch capability unavailable", state };
  const error = auth(cap, input, cap.dispatch_token_hash); if (error) return { ok: false, error, state };
  if (cap.status === "invalidated" || cap.status === "complete") return { ok: false, error: "capability invalidated", state };
  const record = cap.dispatches.find((d) => d.id === input.dispatch_id);
  if (!record) return { ok: false, error: "unknown dispatch", state };
  if (input.role !== undefined && input.role !== record.role) return { ok: false, error: "dispatch role mismatch", state };
  if (input.agent !== undefined && input.agent !== record.agent) return { ok: false, error: "dispatch agent mismatch", state };
  if (input.tool_call_id !== undefined && record.tool_call_id !== undefined && input.tool_call_id !== record.tool_call_id) return { ok: false, error: "dispatch tool-call mismatch", state };
  return completeRecord(cwd, state, target, cap, record, input);
}

/** Reconcile a native task result without exposing capability secrets to hooks. */
export function reconcileTrustedTaskResult(cwd: string, input: {
  tool_call_id: string;
  outcome: DispatchCompletion["outcome"];
  evidence: string;
  artifact_ids?: string[];
}): TransitionResult {
  if (!input.tool_call_id) return { ok: false, error: "tool call identity required" };
  let found = current(cwd);
  if (!found) return { ok: false, error: "state not found" };
  const branch = resolveActiveBranch(cwd);
  if (branch !== found.state.branch) return { ok: false, error: "workflow state is stale for the active branch", state: found.state };
  let pending = found.state.dispatch_capability?.dispatches?.filter((record) => record.tool_call_id === input.tool_call_id && !record.completion) ?? [];
  if (pending.length === 0) return { ok: false, error: "unknown or already reconciled tool call", state: found.state };
  let last: TransitionResult = { ok: true, state: found.state };
  for (const expected of pending) {
    if (!found) return { ok: false, error: "state disappeared during reconciliation" };
    const cap = activeCapability(found.state.dispatch_capability);
    if (!cap) return { ok: false, error: "dispatch capability unavailable", state: found.state };
    const record = cap.dispatches.find((candidate) => candidate.id === expected.id);
    if (!record) return { ok: false, error: "dispatch disappeared during reconciliation", state: found.state };
    last = completeRecord(cwd, found.state, found.target, cap, record, { ...input, completed_by: "synchronous_tool_result" });
    if (!last.ok) return last;
    found = { state: last.state, target: found.target };

  }
  return last;
}
function stageProduces(stage: StageDef): string[] {
  if (Array.isArray(stage.produces)) return stage.produces;
  return stage.produces ? [stage.produces] : [];
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

export function advanceCursor(cwd: string, input: DispatchAuth): TransitionResult {
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
  const flags = rawState.scope ?? resolveScope([], config);

  // Join completeness — every dispatched role must have succeeded.
  const expected = new Set(cap.expected_roles);
  const latest = new Map<string, DispatchRecord>();
  for (const record of cap.dispatches) latest.set(record.role, record);
  const records = Array.from(latest.values());
  if (records.length !== cap.expected_count || records.some((record) => !expected.has(record.role) || record.status !== "succeeded")) {
    return { ok: false, error: "dispatch join incomplete", state: rawState };
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
  let state = rawState;
  const isMultiSlotConsilium = cap.kind === "consilium" && cap.expected_count > 1;
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

  // Stage completion validation: consumes, produces, schema contracts, the
  // validation gate and the gate expression all fail closed.
  const completion = validateStageCompletion(currentStage, state, target, input.evidence, flags, profile);
  if (!completion.ok) return { ok: false, error: completion.error, state };

  // Unresolved declared checkpoints block advance.
  const checkpointError = unresolvedCheckpointError(currentStage, state);
  if (checkpointError) return { ok: false, error: checkpointError, state };

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
      return reenterLoop(cwd, state, target, profile, cap, currentStage, records, joinSummary, decision.reentries, flags, config);
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
  let nextCap: NonNullable<TeamState["dispatch_capability"]>;
  if (nextStage) {
    const nextKind: "none" | "single" | "consilium" =
      nextStage.type === "single" || nextStage.type === "consilium" ? nextStage.type : "none";
    const slots = nextKind === "none"
      ? []
      : resolveStageDispatchSlots(nextStage, { cwd, flags, resolveDevAgent: () => flags.dev_agent });
    if ((nextKind === "single" && slots.length !== 1) || (nextKind === "consilium" && slots.length === 0)) {
      return { ok: false, error: `next stage '${nextStage.id}' has an invalid dispatch roster`, state };
    }
    const issued = createCapability({
      run_key: cap.issued_for.run_key,
      branch: cap.issued_for.branch,
      workflow: cap.issued_for.workflow,
      profile_hash: cap.issued_for.profile_hash,
      stage_cursor: nextStage.id,
      cursor_epoch: epoch,
      kind: nextKind,
      expected_roster: slots.map((slot) => ({ role: slot.slot, agent: resolveAgentForRole(slot.role, config) })),
    });
    nextCap = issued.state;
    handoffSecrets = { capability_id: issued.capability_id, dispatch_token: issued.dispatch_token, advance_token: issued.advance_token };
  } else {
    nextCap = { ...cap, status: "complete" as const, dispatches: [] };
  }
  const next: TeamState = {
    ...state,
    stage_cursor: nextStage?.id ?? state.stage_cursor,
    cursor_epoch: epoch,
    // The newly armed ready capability must never be persisted while its
    // stage cursor is still pending: mark the next stage in_progress in the
    // same atomic state update that arms the capability, so a resumed run
    // can dispatch against it immediately. Consecutive skip_if stages are
    // marked terminal `skipped` in the same update; they are never armed.
    stages: state.stages.map((s) => {
      if (s.id === state.stage_cursor) return { ...s, status: "done" as const };
      if (skippedStageIds.includes(s.id)) return { ...s, status: "skipped" as const };
      if (nextStage && s.id === nextStage.id) return { ...s, status: "in_progress" as const };
      return s;
    }),
    join_summary: joinSummary,
    dispatch_capability: nextCap,
    pause: nextStage ? state.pause : { kind: "done", reason: "" },
  };
  persist(cwd, next, target);
  return { ok: true, state: next, handoff: handoffSecrets ? handoffFromState(cwd, next, handoffSecrets) : undefined };
}

/**
 * Loop re-entry: point the cursor back at the loop's `back_to` stage and
 * issue a fresh capability with a fresh cursor epoch. Old epochs can never
 * authorize a re-entered iteration — the durable binding rotates with every
 * loop-back. Iteration history is appended durably.
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
  config: ReturnType<typeof resolveConfig>,
): TransitionResult {
  const loop = currentStage.loop!;
  const backToStage = resolveBackToStage(profile, loop.back_to);
  if (!backToStage) return { ok: false, error: `loop back_to '${loop.back_to}' is not a stage in the profile`, state };
  const kind: "none" | "single" | "consilium" =
    backToStage.type === "single" || backToStage.type === "consilium" ? backToStage.type : "none";
  const slots = kind === "none"
    ? []
    : resolveStageDispatchSlots(backToStage, { cwd, flags, resolveDevAgent: () => flags.dev_agent });
  if ((kind === "single" && slots.length !== 1) || (kind === "consilium" && slots.length === 0)) {
    return { ok: false, error: `loop target stage '${backToStage.id}' has an invalid dispatch roster`, state };
  }
  const epoch = randomUUID();
  const issued = createCapability({
    run_key: cap.issued_for.run_key,
    branch: cap.issued_for.branch,
    workflow: cap.issued_for.workflow,
    profile_hash: cap.issued_for.profile_hash,
    stage_cursor: backToStage.id,
    cursor_epoch: epoch,
    kind,
    expected_roster: slots.map((slot) => ({ role: slot.slot, agent: resolveAgentForRole(slot.role, config) })),
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
  const next: TeamState = {
    ...state,
    stage_cursor: backToStage.id,
    cursor_epoch: epoch,
    loop_state: loopState,
    stages: state.stages.map((s) =>
      s.id === currentStage.id
        ? { ...s, status: "done" as const }
        : s.id === backToStage.id
          ? { ...s, status: "in_progress" as const }
          : s,
    ),
    join_summary: joinSummary,
    dispatch_capability: { ...issued.state, status: "ready" as const, dispatches: [] },
    updated_at: now(),
  };
  persist(cwd, next, target);
  return {
    ok: true,
    state: next,
    handoff: handoffFromState(cwd, next, {
      capability_id: issued.capability_id,
      dispatch_token: issued.dispatch_token,
      advance_token: issued.advance_token,
    }),
  };
}

export interface CheckpointDecisionInput extends DispatchAuth {
  checkpoint: string;
  mode: "interactive" | "autonomous";
  decision: string;
  actor: string;
  rationale: string;
}

/**
 * Persist a durable checkpoint decision (interactive user answer or the
 * autonomous path's recorded rationale). Bound to the active capability via
 * the orchestrator's advance token; the checkpoint name must match the
 * current stage's declared checkpoint. Recording is idempotent per
 * (stage, checkpoint): the latest decision wins.
 */
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
  if (input.stage_cursor !== cap.issued_for.stage_cursor) {
    return { ok: false, error: "checkpoint stage does not match the active capability", state };
  }
  if (!input.checkpoint.trim() || !input.decision.trim()) {
    return { ok: false, error: "checkpoint name and decision are required", state };
  }
  const profile = loadProfile(cap.issued_for.workflow);
  const stage = profile?.stages.find((candidate) => candidate.id === cap.issued_for.stage_cursor);
  if (!stage?.checkpoint) return { ok: false, error: `stage '${cap.issued_for.stage_cursor}' declares no checkpoint`, state };
  if (input.checkpoint !== stage.checkpoint) {
    return { ok: false, error: `checkpoint '${input.checkpoint}' does not match declared checkpoint '${stage.checkpoint}'`, state };
  }
  const decision: CheckpointDecision = {
    stage_id: cap.issued_for.stage_cursor,
    checkpoint: input.checkpoint,
    mode: input.mode,
    decision: input.decision.trim(),
    actor: input.actor.trim() || "orchestrator",
    rationale: input.rationale.trim(),
    decided_at: now(),
  };
  const next = appendCheckpointDecision(state, decision);
  persist(cwd, next, target);
  return { ok: true, state: next };
}

export function reconcileTaskResult(cwd: string, input: { dispatch_id?: string; tool_call_id?: string; token?: string; capability_id: string; cursor_epoch?: string; output?: string; isError?: boolean; details?: { async?: { state?: string } } }): TransitionResult {
  const asyncState = input.details?.async?.state;
  if (asyncState === "running" || asyncState === "spawned" || asyncState === "scheduled" || (!input.output && !input.isError)) return { ok: false, error: "asynchronous task remains pending" };
  if (!input.dispatch_id && !input.tool_call_id) return { ok: false, error: "dispatch identity required" };
  if (!input.token) return { ok: false, error: "dispatch token required" };
  const found = current(cwd);
  if (!found) return { ok: false, error: "state not found" };
  if (found.target.isStale) return { ok: false, error: "workflow state is stale for the active branch", state: found.state };
  const cap = activeCapability(found.state.dispatch_capability);
  if (!cap || cap.capability_id !== input.capability_id || (input.cursor_epoch && cap.issued_for.cursor_epoch !== input.cursor_epoch)) return { ok: false, error: "capability binding mismatch", state: found.state };
  const records = cap.dispatches.filter((record) => !record.completion && (input.dispatch_id ? record.id === input.dispatch_id : record.tool_call_id === input.tool_call_id));
  if (records.length === 0) return { ok: false, error: "unknown dispatch", state: found.state };
  const evidence = input.output?.trim() || (input.isError ? "task failed" : "");
  let last: TransitionResult = { ok: true, state: found.state };
  for (const record of records) {
    last = completeDispatch(cwd, {
      dispatch_id: record.id,
      token: input.token,
      capability_id: input.capability_id,
      run_key: cap.issued_for.run_key,
      branch: cap.issued_for.branch,
      workflow: cap.issued_for.workflow,
      profile_hash: cap.issued_for.profile_hash,
      stage_cursor: cap.issued_for.stage_cursor,
      cursor_epoch: cap.issued_for.cursor_epoch,
      outcome: input.isError ? "failed" : "succeeded",
      evidence,
      completed_by: "synchronous_tool_result",
    });
    if (!last.ok) return last;
  }
  return last;
}

// ── Handoff: cross-profile transfer of an approved completed run ──────────
//
// A handoff moves an explicitly approved, completed source run into a
// registered target workflow without editing shipped profile JSON or copying
// artifacts: the feature directory is already shared, so artifacts/decisions/
// history/scope survive by construction and the transition only rewrites the
// engine-owned state bindings. Every validation failure returns before the
// single `persist` call, so rejected handoffs leave canonical state and
// artifacts byte-identical (fail closed). Plaintext capability secrets are
// returned only in the one-time result envelope; state.json persists hashes
// only.

export interface HandoffApproval {
  kind: "checkpoint" | "artifact";
  /** Checkpoint name (checkpoint kind) or safe artifact id (artifact kind). */
  ref: string;
  /** Must equal the authenticated source stage and the registered route source stage. */
  source_stage: string;
  /** Must be the literal `approved`; free text is never an approval. */
  decision: string;
}

export interface HandoffWorkflowInput extends DispatchAuth {
  target_workflow: string;
  /** Optional caller precondition; the engine always persists the current target hash. */
  target_profile_hash?: string;
  approval: HandoffApproval;
  /** Non-empty bounded audit actor; the control tool defaults this to "orchestrator". */
  actor: string;
  handoff_context?: HandoffContext;
}

export type HandoffTransitionResult =
  | { ok: true; state: TeamState; route: HandoffRoute; handoff: CapabilityHandoff; audit: HandoffRecord }
  | { ok: false; error: string; state?: TeamState; route?: HandoffRoute };

const MAX_HANDOFF_CONTEXT_ARTIFACTS = 32;
const MAX_HANDOFF_CONTEXT_DECISION_REFS = 32;
const MAX_HANDOFF_CONTEXT_SUMMARY_CHARS = 2000;
const MAX_HANDOFF_CONTEXT_SERIALIZED_BYTES = 8192;
const MAX_HANDOFF_DECISION_REF_CHARS = 200;
const MAX_HANDOFF_RECORDS = 32;

/** Registered source-workflow/source-stage/target-workflow -> route. */
const handoffRoutes = new Map<string, HandoffRoute>();
const handoffRouteKey = (sourceWorkflow: string, sourceStage: string, targetWorkflow: string): string =>
  `${sourceWorkflow}\u0000${sourceStage}\u0000${targetWorkflow}`;

const HANDOFF_ROUTE_DISPOSITIONS = ["enabled", "conditional", "unsupported"] as const;

/**
 * Register a generic handoff route. Duplicate keys (same source workflow +
 * source stage + target workflow) and duplicate route ids are rejected
 * deterministically so route metadata can never drift silently. Route
 * entries must carry a stable id, an explicit disposition (`enabled` |
 * `conditional` | `unsupported`), a semantics kind, and human-readable
 * description; `conditional` entries declare prerequisites and the
 * `blocked_by` adapter/evidence gaps that keep them from completing.
 */
export function registerWorkflowHandoffRoute(route: HandoffRoute): void {
  if (
    !route ||
    typeof route.id !== "string" || !route.id.trim() ||
    typeof route.source_workflow !== "string" || !route.source_workflow.trim() ||
    typeof route.source_stage !== "string" || !route.source_stage.trim() ||
    typeof route.target_workflow !== "string" || !route.target_workflow.trim() ||
    typeof route.target_stage !== "string" || !route.target_stage.trim() ||
    typeof route.kind !== "string" || !route.kind.trim() ||
    !HANDOFF_ROUTE_DISPOSITIONS.includes(route.disposition) ||
    typeof route.description !== "string" || !route.description.trim()
  ) {
    throw new Error("invalid handoff route registration");
  }
  for (const field of ["preparation", "when"] as const) {
    const value = route[field];
    if (value !== undefined && (typeof value !== "string" || !value.trim())) {
      throw new Error("invalid handoff route registration");
    }
  }
  for (const field of ["prerequisites", "blocked_by"] as const) {
    const values = route[field];
    if (values !== undefined && (!Array.isArray(values) || values.some((entry) => typeof entry !== "string" || !entry.trim()))) {
      throw new Error("invalid handoff route registration");
    }
  }
  const key = handoffRouteKey(route.source_workflow, route.source_stage, route.target_workflow);
  if (handoffRoutes.has(key)) {
    throw new Error(`handoff route already registered: ${route.source_workflow}:${route.source_stage} -> ${route.target_workflow}`);
  }
  for (const existing of handoffRoutes.values()) {
    if (existing.id === route.id) {
      throw new Error(`handoff route id already registered: ${route.id}`);
    }
  }
  handoffRoutes.set(key, route);
}

/**
 * Engine-owned typed transition catalogue (see `workflows/README.md` for the
 * maintainers' matrix). Default-deny: only `enabled` routes may complete;
 * `conditional` routes are catalogue-only until their required
 * evidence/materialization adapter exists (`handoffWorkflow` rejects them
 * deterministically with the route metadata and the missing gaps); and
 * explicitly documented `unsupported` pairs — plus any unregistered target
 * string — fail closed. Route metadata lives here, never in shipped profile
 * JSON, so `profileHash` stays stable for in-flight runs.
 */
const HANDOFF_ROUTE_CATALOGUE: readonly HandoffRoute[] = [
  // ── Enabled: approved implementation-ready spec -> feature discovery ────
  {
    id: "spec-handoff->full-feature",
    source_workflow: "spec-preparation",
    source_stage: "handoff",
    target_workflow: "full-feature",
    target_stage: "discovery",
    kind: "feature-intake",
    disposition: "enabled",
    description: "Transfer an approved implementation-ready specification into full-feature discovery.",
    preparation: "Target discovery normalizes the carried spec_handoff context into the feature profile's own feature_spec contract and runs the feature profile's discovery/preparation gates.",
    prerequisites: [
      "source stage `handoff` is complete and every source stage is done/skipped",
      "typed `workflow_approval` artifact (or an approved checkpoint) bound to the source run/workflow/stage",
      "`spec_handoff` produced artifact is present and addressable",
    ],
    when: "the user explicitly approves the specification for implementation",
  },

  // ── Conditional: post-feature regression intake ─────────────────────────
  {
    id: "full-feature-summary->regression",
    source_workflow: "full-feature",
    source_stage: "summary",
    target_workflow: "feature-regression",
    target_stage: "discovery_intake",
    kind: "regression",
    disposition: "conditional",
    description: "Conditional post-feature regression after an approved full-feature summary.",
    preparation: "Target discovery_intake materializes a regression intake from the carried implementation/review/QA context.",
    prerequisites: [
      "`summary` produced artifact is present",
      "bounded implementation/review/QA context carried",
      "explicit regression intent/approval",
    ],
    blocked_by: [
      "regression intent/approval evidence adapter not implemented",
      "implementation/review/QA context materialization adapter not implemented",
    ],
    when: "the user explicitly requests a regression pass over the completed feature",
  },
  {
    id: "standard-summary->regression",
    source_workflow: "standard",
    source_stage: "summary",
    target_workflow: "feature-regression",
    target_stage: "discovery_intake",
    kind: "regression",
    disposition: "conditional",
    description: "Conditional post-feature regression after an approved standard summary.",
    preparation: "Target discovery_intake materializes a regression intake from the carried implementation/review/QA context.",
    prerequisites: [
      "`summary` produced artifact is present",
      "bounded implementation/review/QA context carried",
      "explicit regression intent/approval",
    ],
    blocked_by: [
      "regression intent/approval evidence adapter not implemented",
      "implementation/review/QA context materialization adapter not implemented",
    ],
    when: "the user explicitly requests a regression pass over the completed feature",
  },
  {
    id: "lightweight-summary->regression",
    source_workflow: "lightweight",
    source_stage: "summary",
    target_workflow: "feature-regression",
    target_stage: "discovery_intake",
    kind: "regression",
    disposition: "conditional",
    description: "Conditional post-feature regression after an approved lightweight summary.",
    preparation: "Target discovery_intake materializes a regression intake from the carried implementation/review/QA context.",
    prerequisites: [
      "`summary` produced artifact is present",
      "bounded implementation/review/QA context carried",
      "explicit regression intent/approval",
    ],
    blocked_by: [
      "regression intent/approval evidence adapter not implemented",
      "implementation/review/QA context materialization adapter not implemented",
    ],
    when: "the user explicitly requests a regression pass over the completed feature",
  },

  // ── Conditional: regression -> confirmed obvious bug fix ────────────────
  {
    id: "regression-summary->bug-fix",
    source_workflow: "feature-regression",
    source_stage: "summary_handoff",
    target_workflow: "bug-fix",
    target_stage: "discovery",
    kind: "bug-fix-diagnostic",
    disposition: "conditional",
    description: "Conditional diagnostic handoff into a confirmed, actionable bug fix from a regression report.",
    preparation: "Target discovery confirms the obvious fix from the carried regression report/triage evidence.",
    prerequisites: [
      "`regression_report` produced artifact is present",
      "confirmed actionable/obvious finding with regression triage evidence",
    ],
    blocked_by: ["regression report/triage materialization adapter not implemented"],
    when: "the regression run confirms an actionable, obvious fix",
  },

  // ── Conditional: regression -> uncertain/iterative debug cycle ──────────
  {
    id: "regression-summary->debug-cycle",
    source_workflow: "feature-regression",
    source_stage: "summary_handoff",
    target_workflow: "debug-cycle",
    target_stage: "discovery",
    kind: "debug-diagnostic",
    disposition: "conditional",
    description: "Conditional diagnostic handoff into iterative verification for uncertain, replay-required regression findings.",
    preparation: "Target discovery starts an iterative debug cycle from the carried regression evidence.",
    prerequisites: [
      "`regression_report` produced artifact is present",
      "uncertain/iterative finding requiring replay verification",
    ],
    blocked_by: ["regression report/triage materialization adapter not implemented"],
    when: "the finding is uncertain or requires iterative verification",
  },

  // ── Conditional: post-fix feedback/reopen regression ────────────────────
  {
    id: "bug-fix-summary->regression",
    source_workflow: "bug-fix",
    source_stage: "summary",
    target_workflow: "feature-regression",
    target_stage: "discovery_intake",
    kind: "feedback-regression",
    disposition: "conditional",
    description: "Conditional post-fix regression/feedback after an approved bug-fix summary.",
    preparation: "Target discovery_intake materializes a regression intake from the carried fix/verification evidence.",
    prerequisites: [
      "`summary` produced artifact is present",
      "fix/verification evidence is available",
      "explicit regression intent/approval",
    ],
    blocked_by: [
      "post-fix regression intent/approval evidence adapter not implemented",
      "fix/verification evidence materialization adapter not implemented",
    ],
    when: "the user requests post-fix regression or feedback verification",
  },
  {
    id: "debug-cycle-summary->regression",
    source_workflow: "debug-cycle",
    source_stage: "summary",
    target_workflow: "feature-regression",
    target_stage: "discovery_intake",
    kind: "feedback-regression",
    disposition: "conditional",
    description: "Conditional post-fix regression/feedback after an approved debug-cycle summary.",
    preparation: "Target discovery_intake materializes a regression intake from the carried fix/verification evidence.",
    prerequisites: [
      "`summary` produced artifact is present",
      "fix/verification evidence is available",
      "explicit regression intent/approval",
    ],
    blocked_by: [
      "post-fix regression intent/approval evidence adapter not implemented",
      "fix/verification evidence materialization adapter not implemented",
    ],
    when: "the user requests post-fix regression or feedback verification",
  },
  {
    id: "emergency-summary->regression",
    source_workflow: "emergency",
    source_stage: "summary",
    target_workflow: "feature-regression",
    target_stage: "discovery_intake",
    kind: "feedback-regression",
    disposition: "conditional",
    description: "Conditional post-fix regression/feedback after an approved emergency summary.",
    preparation: "Target discovery_intake materializes a regression intake from the carried fix/verification evidence.",
    prerequisites: [
      "`summary` produced artifact is present",
      "fix/verification evidence is available",
      "explicit regression intent/approval",
    ],
    blocked_by: [
      "post-fix regression intent/approval evidence adapter not implemented",
      "fix/verification evidence materialization adapter not implemented",
    ],
    when: "the user requests post-fix regression or feedback verification",
  },

  // ── Explicitly unsupported direct pairs (documented default-deny) ───────
  // These complete nothing today and reject deterministically with a
  // human-readable reason; they exist so the catalogue documents the policy
  // instead of pretending arbitrary target strings are safe.
  {
    id: "spec-handoff->bug-fix",
    source_workflow: "spec-preparation",
    source_stage: "handoff",
    target_workflow: "bug-fix",
    target_stage: "discovery",
    kind: "unsupported",
    disposition: "unsupported",
    description: "Direct spec -> bug-fix transfer is unsupported: a confirmed fix must first be validated by a regression run that produces triage evidence.",
    when: "never — start a new classification instead",
  },
  {
    id: "spec-handoff->debug-cycle",
    source_workflow: "spec-preparation",
    source_stage: "handoff",
    target_workflow: "debug-cycle",
    target_stage: "discovery",
    kind: "unsupported",
    disposition: "unsupported",
    description: "Direct spec -> debug-cycle transfer is unsupported: uncertain findings must come from a regression run, not from a specification.",
    when: "never — start a new classification instead",
  },
  {
    id: "full-feature-summary->bug-fix",
    source_workflow: "full-feature",
    source_stage: "summary",
    target_workflow: "bug-fix",
    target_stage: "discovery",
    kind: "unsupported",
    disposition: "unsupported",
    description: "Direct feature -> bug-fix transfer is unsupported: a suspected defect must first be evidenced by a regression run.",
    when: "never — request post-feature regression instead",
  },
  {
    id: "full-feature-summary->debug-cycle",
    source_workflow: "full-feature",
    source_stage: "summary",
    target_workflow: "debug-cycle",
    target_stage: "discovery",
    kind: "unsupported",
    disposition: "unsupported",
    description: "Direct feature -> debug-cycle transfer is unsupported: uncertain defects must first be evidenced by a regression run.",
    when: "never — request post-feature regression instead",
  },
  {
    id: "standard-summary->bug-fix",
    source_workflow: "standard",
    source_stage: "summary",
    target_workflow: "bug-fix",
    target_stage: "discovery",
    kind: "unsupported",
    disposition: "unsupported",
    description: "Direct feature -> bug-fix transfer is unsupported: a suspected defect must first be evidenced by a regression run.",
    when: "never — request post-feature regression instead",
  },
  {
    id: "standard-summary->debug-cycle",
    source_workflow: "standard",
    source_stage: "summary",
    target_workflow: "debug-cycle",
    target_stage: "discovery",
    kind: "unsupported",
    disposition: "unsupported",
    description: "Direct feature -> debug-cycle transfer is unsupported: uncertain defects must first be evidenced by a regression run.",
    when: "never — request post-feature regression instead",
  },
  {
    id: "lightweight-summary->bug-fix",
    source_workflow: "lightweight",
    source_stage: "summary",
    target_workflow: "bug-fix",
    target_stage: "discovery",
    kind: "unsupported",
    disposition: "unsupported",
    description: "Direct feature -> bug-fix transfer is unsupported: a suspected defect must first be evidenced by a regression run.",
    when: "never — request post-feature regression instead",
  },
  {
    id: "lightweight-summary->debug-cycle",
    source_workflow: "lightweight",
    source_stage: "summary",
    target_workflow: "debug-cycle",
    target_stage: "discovery",
    kind: "unsupported",
    disposition: "unsupported",
    description: "Direct feature -> debug-cycle transfer is unsupported: uncertain defects must first be evidenced by a regression run.",
    when: "never — request post-feature regression instead",
  },
  {
    id: "regression-summary->full-feature",
    source_workflow: "feature-regression",
    source_stage: "summary_handoff",
    target_workflow: "full-feature",
    target_stage: "discovery",
    kind: "unsupported",
    disposition: "unsupported",
    description: "Direct regression -> feature transfer is unsupported: regression findings never reopen feature implementation; reopen the affected stage or start a new feature task.",
    when: "never — reopen the affected stage instead",
  },
  {
    id: "regression-summary->standard",
    source_workflow: "feature-regression",
    source_stage: "summary_handoff",
    target_workflow: "standard",
    target_stage: "discovery",
    kind: "unsupported",
    disposition: "unsupported",
    description: "Direct regression -> feature transfer is unsupported: regression findings never reopen feature implementation.",
    when: "never — reopen the affected stage instead",
  },
  {
    id: "regression-summary->lightweight",
    source_workflow: "feature-regression",
    source_stage: "summary_handoff",
    target_workflow: "lightweight",
    target_stage: "discovery",
    kind: "unsupported",
    disposition: "unsupported",
    description: "Direct regression -> feature transfer is unsupported: regression findings never reopen feature implementation.",
    when: "never — reopen the affected stage instead",
  },
  {
    id: "review-summary->full-feature",
    source_workflow: "review",
    source_stage: "summary",
    target_workflow: "full-feature",
    target_stage: "discovery",
    kind: "unsupported",
    disposition: "unsupported",
    description: "Direct review -> implementation transfer is unsupported: a review deliverable never starts feature implementation; classify a new implementation task.",
    when: "never — start a new classification instead",
  },
  {
    id: "research-summary->full-feature",
    source_workflow: "research",
    source_stage: "summary",
    target_workflow: "full-feature",
    target_stage: "discovery",
    kind: "unsupported",
    disposition: "unsupported",
    description: "Direct analysis -> implementation transfer is unsupported: research findings never start feature implementation; classify a new implementation task.",
    when: "never — start a new classification instead",
  },
  {
    id: "full-feature->full-feature",
    source_workflow: "full-feature",
    source_stage: "summary",
    target_workflow: "full-feature",
    target_stage: "discovery",
    kind: "unsupported",
    disposition: "unsupported",
    description: "Same-profile transitions are unsupported: a completed run never restarts its own profile; reopen the affected stage instead.",
    when: "never — reopen the affected stage instead",
  },
  {
    id: "standard->standard",
    source_workflow: "standard",
    source_stage: "summary",
    target_workflow: "standard",
    target_stage: "discovery",
    kind: "unsupported",
    disposition: "unsupported",
    description: "Same-profile transitions are unsupported: a completed run never restarts its own profile; reopen the affected stage instead.",
    when: "never — reopen the affected stage instead",
  },
  {
    id: "lightweight->lightweight",
    source_workflow: "lightweight",
    source_stage: "summary",
    target_workflow: "lightweight",
    target_stage: "discovery",
    kind: "unsupported",
    disposition: "unsupported",
    description: "Same-profile transitions are unsupported: a completed run never restarts its own profile; reopen the affected stage instead.",
    when: "never — reopen the affected stage instead",
  },
  {
    id: "bug-fix->bug-fix",
    source_workflow: "bug-fix",
    source_stage: "summary",
    target_workflow: "bug-fix",
    target_stage: "discovery",
    kind: "unsupported",
    disposition: "unsupported",
    description: "Same-profile transitions are unsupported: a completed run never restarts its own profile; reopen the affected stage instead.",
    when: "never — reopen the affected stage instead",
  },
  {
    id: "debug-cycle->debug-cycle",
    source_workflow: "debug-cycle",
    source_stage: "summary",
    target_workflow: "debug-cycle",
    target_stage: "discovery",
    kind: "unsupported",
    disposition: "unsupported",
    description: "Same-profile transitions are unsupported: a completed run never restarts its own profile; reopen the affected stage instead.",
    when: "never — reopen the affected stage instead",
  },
  {
    id: "feature-regression->feature-regression",
    source_workflow: "feature-regression",
    source_stage: "summary_handoff",
    target_workflow: "feature-regression",
    target_stage: "discovery_intake",
    kind: "unsupported",
    disposition: "unsupported",
    description: "Same-profile transitions are unsupported: a completed run never restarts its own profile; reopen the affected stage instead.",
    when: "never — reopen the affected stage instead",
  },
  {
    id: "emergency->emergency",
    source_workflow: "emergency",
    source_stage: "summary",
    target_workflow: "emergency",
    target_stage: "implementation",
    kind: "unsupported",
    disposition: "unsupported",
    description: "Same-profile transitions are unsupported: a completed run never restarts its own profile; reopen the affected stage instead.",
    when: "never — reopen the affected stage instead",
  },
  {
    id: "spec-preparation->spec-preparation",
    source_workflow: "spec-preparation",
    source_stage: "handoff",
    target_workflow: "spec-preparation",
    target_stage: "intake_repo_map",
    kind: "unsupported",
    disposition: "unsupported",
    description: "Same-profile transitions are unsupported: a completed run never restarts its own profile; reopen the affected stage instead.",
    when: "never — reopen the affected stage instead",
  },
];

for (const route of HANDOFF_ROUTE_CATALOGUE) {
  registerWorkflowHandoffRoute(route);
}

/** Live snapshot of the registered handoff route catalogue (insertion order). */
export function handoffRouteCatalogue(): readonly HandoffRoute[] {
  return [...handoffRoutes.values()];
}

/**
 * Deterministic default-deny gate over the route catalogue. `enabled`
 * routes pass; `conditional` routes fail closed with the route id, required
 * prerequisites and the missing evidence/materialization adapters; and
 * `unsupported` pairs fail with a human-readable reason. The full route
 * metadata rides along in the rejection so callers can render the state.
 */
function handoffRouteError(route: HandoffRoute): string | null {
  if (route.disposition === "enabled") return null;
  const where = `${route.source_workflow}:${route.source_stage} -> ${route.target_workflow}:${route.target_stage}`;
  if (route.disposition === "unsupported") {
    return `workflow transition is unsupported: route '${route.id}' (${where}): ${route.description}`;
  }
  const prerequisites = route.prerequisites?.length ? ` prerequisites: ${route.prerequisites.join("; ")}.` : "";
  const blockedBy = route.blocked_by?.length ? ` blocking: ${route.blocked_by.join("; ")}.` : "";
  return `workflow transition is conditional and not enabled: route '${route.id}' (${where}): ${route.description}${prerequisites}${blockedBy}`;
}

type ApprovalRecord = Record<string, unknown>;

type NormalizedNestedApproval = {
  actor: string;
};

function asApprovalRecord(value: unknown): ApprovalRecord | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as ApprovalRecord : null;
}

function isNonEmptyApprovalString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isApprovalStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

/**
 * Normalize the observed nested approval shape only after binding every
 * security-relevant field to the authenticated source capability, state,
 * route and caller input. The flat artifact shape is intentionally handled
 * by the legacy branch in validateHandoffApproval and remains unchanged.
 */
function normalizeNestedWorkflowApproval(
  value: unknown,
  ref: string,
  input: HandoffWorkflowInput,
  state: TeamState,
  cap: ActiveCapability,
  route: HandoffRoute,
): NormalizedNestedApproval | null {
  const record = asApprovalRecord(value);
  const approval = asApprovalRecord(record?.approval);
  const source = asApprovalRecord(record?.source);
  const completedHandoff = asApprovalRecord(source?.completed_handoff);
  const target = asApprovalRecord(record?.target);
  const classification = asApprovalRecord(target?.classification);
  const boundedSpecHandoff = asApprovalRecord(record?.bounded_spec_handoff);
  const transferConstraints = asApprovalRecord(record?.transfer_constraints);
  if (
    !record ||
    record.artifact_id !== ref ||
    record.schema_version !== 1 ||
    record.kind !== "workflow_approval" ||
    record.status !== "approved" ||
    !approval ||
    approval.decision !== "approve" ||
    approval.mode !== "interactive" ||
    !isNonEmptyApprovalString(approval.actor) ||
    !isNonEmptyApprovalString(approval.rationale) ||
    !source ||
    source.workflow !== cap.issued_for.workflow ||
    source.stage !== route.source_stage ||
    source.stage !== input.stage_cursor ||
    source.status !== "completed" ||
    source.branch !== cap.issued_for.branch ||
    source.run_key !== cap.issued_for.run_key ||
    !completedHandoff ||
    completedHandoff.capability_id !== cap.capability_id ||
    completedHandoff.stage_cursor !== cap.issued_for.stage_cursor ||
    completedHandoff.cursor_epoch !== cap.issued_for.cursor_epoch ||
    completedHandoff.profile_hash !== cap.issued_for.profile_hash ||
    !target ||
    target.workflow !== input.target_workflow ||
    target.workflow !== route.target_workflow ||
    target.branch !== cap.issued_for.branch ||
    target.run_key !== cap.issued_for.run_key ||
    !classification ||
    !isNonEmptyApprovalString(classification.type) ||
    !isNonEmptyApprovalString(classification.complexity) ||
    !isNonEmptyApprovalString(classification.confidence) ||
    typeof classification.autonomous !== "boolean" ||
    !boundedSpecHandoff ||
    !isNonEmptyApprovalString(boundedSpecHandoff.artifact) ||
    !isApprovalStringArray(boundedSpecHandoff.scope) ||
    !isApprovalStringArray(boundedSpecHandoff.contract) ||
    !isNonEmptyApprovalString(boundedSpecHandoff.acceptance_artifact) ||
    !isApprovalStringArray(boundedSpecHandoff.blocking_gaps) ||
    !isApprovalStringArray(boundedSpecHandoff.implementation_sequence) ||
    !transferConstraints ||
    transferConstraints.do_not_restart_specification !== true ||
    transferConstraints.do_not_modify_spec_handoff !== true ||
    transferConstraints.do_not_expand_scope_beyond_bounded_handoff !== true ||
    (state.run_key ?? state.branch) !== cap.issued_for.run_key ||
    state.branch !== cap.issued_for.branch ||
    state.classification?.workflow !== cap.issued_for.workflow ||
    state.stage_cursor !== cap.issued_for.stage_cursor ||
    state.cursor_epoch !== cap.issued_for.cursor_epoch ||
    state.profile_hash !== cap.issued_for.profile_hash
  ) return null;
  return { actor: approval.actor.trim() };
}

function validateHandoffApproval(
  input: HandoffWorkflowInput,
  state: TeamState,
  artifactsDir: string,
  route: HandoffRoute,
  cap: ActiveCapability,
): string | null {
  const approval = input.approval;
  if (!approval || typeof approval !== "object") return "handoff approval evidence is missing";
  if (approval.decision !== "approved") return "handoff approval evidence is invalid";
  if (approval.source_stage !== input.stage_cursor || approval.source_stage !== route.source_stage) {
    return "handoff approval evidence is invalid";
  }
  const actor = typeof input.actor === "string" ? input.actor.trim() : "";
  if (!actor) return "handoff approval evidence is invalid";
  if (approval.kind === "checkpoint") {
    const ref = approval.ref;
    if (typeof ref !== "string" || !ref.trim()) return "handoff approval evidence is invalid";
    const decision = findCheckpointDecision(state, input.stage_cursor, ref);
    if (!decision) return "handoff approval evidence is missing";
    if (decision.decision !== "approved") return "handoff approval evidence is invalid";
    return null;
  }
  if (approval.kind === "artifact") {
    const ref = approval.ref;
    if (typeof ref !== "string" || !isSafeStateSegment(ref)) return "handoff approval evidence is invalid";
    const value = readArtifact(artifactsDir, ref);
    if (!value || typeof value !== "object" || Array.isArray(value)) return "handoff approval evidence is missing";
    const record = value as Record<string, unknown>;
    if (record.type === "workflow_approval" && record.version === 1 && record.decision === "approved") {
      if (record.run_key !== (state.run_key ?? state.branch) || record.workflow !== state.classification?.workflow || record.stage !== route.source_stage) {
        return "handoff approval evidence is invalid";
      }
      if (typeof record.actor !== "string" || !record.actor.trim()) return "handoff approval evidence is invalid";
      if (typeof record.decided_at !== "string" || !record.decided_at.trim() || Number.isNaN(Date.parse(record.decided_at))) {
        return "handoff approval evidence is invalid";
      }
      return null;
    }
    return normalizeNestedWorkflowApproval(value, ref, input, state, cap, route)
      ? null
      : "handoff approval evidence is invalid";
  }
  return "handoff approval evidence is invalid";
}

/** Validate bounded handoff context: safe, resolvable, size-capped references. */
function validateHandoffContext(input: HandoffWorkflowInput, artifactsDir: string): string | null {
  const context = input.handoff_context ?? {};
  const artifactIds = Array.isArray(context.artifact_ids) ? context.artifact_ids : [];
  const decisionRefs = Array.isArray(context.decision_refs) ? context.decision_refs : [];
  const summary = typeof context.summary === "string" ? context.summary : "";
  if (artifactIds.length > MAX_HANDOFF_CONTEXT_ARTIFACTS) return "handoff context is invalid or exceeds limits";
  if (decisionRefs.length > MAX_HANDOFF_CONTEXT_DECISION_REFS) return "handoff context is invalid or exceeds limits";
  if (summary.length > MAX_HANDOFF_CONTEXT_SUMMARY_CHARS) return "handoff context is invalid or exceeds limits";
  if (
    new Set(artifactIds).size !== artifactIds.length ||
    artifactIds.some((id) => typeof id !== "string" || !isSafeStateSegment(id) || readArtifact(artifactsDir, id) === null)
  ) {
    return "handoff context is invalid or exceeds limits";
  }
  if (
    decisionRefs.some((ref) => typeof ref !== "string" || !ref.trim() || ref.length > MAX_HANDOFF_DECISION_REF_CHARS) ||
    decisionRefs.some((ref, index) => decisionRefs.indexOf(ref) !== index)
  ) {
    return "handoff context is invalid or exceeds limits";
  }
  const serialized = JSON.stringify({ artifact_ids: artifactIds, decision_refs: decisionRefs, summary });
  if (Buffer.byteLength(serialized, "utf8") > MAX_HANDOFF_CONTEXT_SERIALIZED_BYTES) {
    return "handoff context is invalid or exceeds limits";
  }
  return null;
}

/**
 * Cross-profile handoff transition. Validates source capability/binding,
 * source profile hash, terminal source shape (all stages done/skipped,
 * pause done, capability complete), source produced artifacts, registered
 * route, target profile/hash/stage, typed approval evidence, and bounded
 * context entirely in memory; then performs exactly one atomic `writeState`
 * to the same feature directory and returns a fresh one-time target
 * capability. Rejections never mutate state.
 */
export function handoffWorkflow(cwd: string, input: HandoffWorkflowInput): HandoffTransitionResult {
  const branch = resolveActiveBranch(cwd);
  const target = resolveState(cwd, branch);
  if (target.invalid) return { ok: false, error: "workflow state is invalid or unsafe" };
  if (!target.state || !target.statePath) return { ok: false, error: "workflow state not found" };
  if (target.isStale) return { ok: false, error: "workflow state is stale for the active branch", state: target.state };
  const state = target.state;
  const cap = activeCapability(state.dispatch_capability);
  if (!cap) return { ok: false, error: "dispatch capability unavailable", state };
  const error = auth(cap, input, cap.advance_token_hash);
  if (error) return { ok: false, error, state };
  if (cap.status !== "complete") return { ok: false, error: "source workflow is not a completed handoff source", state };

  const sourceWorkflow = cap.issued_for.workflow;
  const sourceProfile = loadProfile(sourceWorkflow);
  if (!sourceProfile || profileHash(sourceProfile) !== cap.issued_for.profile_hash) {
    return { ok: false, error: "source workflow profile is missing or stale", state };
  }
  const sourceStage = sourceProfile.stages.find((candidate) => candidate.id === input.stage_cursor);
  if (!sourceStage) return { ok: false, error: "source workflow is not a completed handoff source", state };
  if (state.pause?.kind !== "done" || !Array.isArray(state.stages) || state.stages.length === 0 || state.stages.some((s) => s.status !== "done" && s.status !== "skipped")) {
    return { ok: false, error: "source workflow is not a completed handoff source", state };
  }
  const artifactsDir = target.artifactsDir ?? "";
  for (const id of stageProduces(sourceStage)) {
    if (!isSafeStateSegment(id) || readArtifact(artifactsDir, id) === null) {
      return { ok: false, error: `source produced artifact '${id}' is missing or invalid`, state };
    }
  }

  const targetWorkflow = input.target_workflow;
  const targetProfile = loadProfile(targetWorkflow);
  if (!targetProfile) return { ok: false, error: "target workflow is unavailable", state };
  const targetHash = profileHash(targetProfile);
  if (input.target_profile_hash && input.target_profile_hash !== targetHash) {
    return { ok: false, error: "target profile hash mismatch", state };
  }
  const route = handoffRoutes.get(handoffRouteKey(sourceWorkflow, input.stage_cursor, targetWorkflow));
  if (!route) return { ok: false, error: "workflow transition is not registered", state };
  const routeError = handoffRouteError(route);
  if (routeError) return { ok: false, error: routeError, state, route };
  const targetStage = targetProfile.stages.find((candidate) => candidate.id === route.target_stage);
  if (!targetStage) return { ok: false, error: "target stage is unavailable", state };

  const approvalError = validateHandoffApproval(input, state, artifactsDir, route, cap);
  if (approvalError) return { ok: false, error: approvalError, state };
  const contextError = validateHandoffContext(input, artifactsDir);
  if (contextError) return { ok: false, error: contextError, state };
  if ((state.handoffs?.length ?? 0) >= MAX_HANDOFF_RECORDS) {
    return { ok: false, error: "handoff audit trail is full", state };
  }

  const config = resolveConfig(cwd);
  const flags = state.scope ?? resolveScope([], config);
  const kind: "none" | "single" | "consilium" =
    targetStage.type === "single" || targetStage.type === "consilium" ? targetStage.type : "none";
  const slots = kind === "none"
    ? []
    : resolveStageDispatchSlots(targetStage, { cwd, flags, resolveDevAgent: () => flags.dev_agent });
  if ((kind === "single" && slots.length !== 1) || (kind === "consilium" && slots.length === 0)) {
    return { ok: false, error: `target stage '${targetStage.id}' has an invalid dispatch roster`, state };
  }
  const expectedRoster = slots.map((slot) => ({ role: slot.slot, agent: resolveAgentForRole(slot.role, config) }));
  const epoch = randomUUID();
  const issued = createCapability({
    run_key: cap.issued_for.run_key,
    branch: cap.issued_for.branch,
    workflow: targetWorkflow,
    profile_hash: targetHash,
    stage_cursor: targetStage.id,
    cursor_epoch: epoch,
    kind,
    expected_roster: expectedRoster,
  });

  const audit: HandoffRecord = {
    id: randomUUID(),
    route: { ...route },
    source: {
      workflow: sourceWorkflow,
      profile_hash: cap.issued_for.profile_hash,
      stage: cap.issued_for.stage_cursor,
      cursor_epoch: cap.issued_for.cursor_epoch,
      run_key: cap.issued_for.run_key,
      branch: cap.issued_for.branch,
    },
    target: {
      workflow: targetWorkflow,
      profile_hash: targetHash,
      stage: targetStage.id,
      cursor_epoch: epoch,
      capability_id: issued.capability_id,
    },
    approval: {
      kind: input.approval.kind,
      ref: input.approval.ref,
      decision: "approved",
      actor: input.actor.trim(),
      decided_at: now(),
    },
    context: {
      artifact_ids: [...(input.handoff_context?.artifact_ids ?? [])],
      decision_refs: [...(input.handoff_context?.decision_refs ?? [])],
      summary: input.handoff_context?.summary ?? "",
    },
    at: now(),
  };

  // Build the complete target TeamState in memory, then persist exactly once.
  // Source provenance (workflow/hash/stage/epoch) lives in the audit record;
  // the active stage list must contain target stages only so workflow
  // contract, monotonic checks and dispatch gates resolve the target profile.
  // Source join/loop/slot metadata names source stage ids and epochs, so it
  // is dropped outright (never carried as undefined-valued keys).
  const { join_summary: _joinSummary, loop_state: _loopState, slot_artifacts: _slotArtifacts, ...sourceRest } = state;
  const next: TeamState = {
    ...sourceRest,
    run_key: state.run_key ?? state.branch,
    classification: { ...state.classification, workflow: targetWorkflow },
    workflow_override: true,
    profile_hash: targetHash,
    stage_cursor: targetStage.id,
    cursor_epoch: epoch,
    stages: targetProfile.stages.map((s) => ({ id: s.id, status: s.id === targetStage.id ? "in_progress" as const : "pending" as const })),
    dispatch_capability: issued.state,
    pause: { kind: "none", reason: "" },
    policy: { ...(state.policy ?? {}), strict_orchestrator: true },
    handoffs: [...(state.handoffs ?? []), audit],
    updated_at: now(),
  };
  persist(cwd, next, target);
  const handoff = handoffFromState(cwd, next, {
    capability_id: issued.capability_id,
    dispatch_token: issued.dispatch_token,
    advance_token: issued.advance_token,
  });
  if (!handoff) return { ok: false, error: "handoff capability construction failed" };
  return { ok: true, state: next, route: audit.route, handoff, audit };
}
