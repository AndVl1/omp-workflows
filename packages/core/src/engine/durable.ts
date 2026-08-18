import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { loadProfile, profileHash } from "./profile.js";
import { resolveState, writeState, isSafeStateSegment, resolveActiveBranch, type ResolvedState } from "./state.js";
import { agentMappingIssueForRole, resolveConfig, resolveAgentForRole } from "./config.js";
import type { AgentMappingDiagnostic } from "./agent-mapping.js";
import { resolveScope, type ScopeFlags } from "./scope.js";
import { resolveStageDispatchSlots } from "./stage.js";
import { readArtifact, writeArtifact } from "./artifacts.js";
import { isDoDComplete, isRootCauseDocumented, readDoD } from "./dod.js";
import { validationGate } from "../gates/validation.js";
import { buildDispatchMarker } from "../gates/dispatch.js";
import { evaluatePredicate } from "./predicate.js";
import { appendCheckpointDecision, unresolvedCheckpointError } from "./checkpoints.js";
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
import type { CheckpointDecision, DispatchCompletion, DispatchRecord, LoopState, TeamState, StageDef } from "./types.js";

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
      marker: buildDispatchMarker(cap.issued_for.run_key, stage, roles, role, cap.issued_for.cursor_epoch),
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
function reissueActiveCapability(cap: ActiveCapability): {
  capability_id: string;
  dispatch_token: string;
  advance_token: string;
  state: NonNullable<TeamState["dispatch_capability"]>;
} {
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
  if (!Array.isArray(state.stages)) return { ok: false, error: "workflow stages are missing", state };
  const stages = state.stages.length > 0
    ? state.stages
    : profile.stages.map((candidate) => ({ id: candidate.id, status: "pending" as const }));
  const stageId = state.stage_cursor || profile.stages[0]?.id;
  const stage = profile.stages.find((candidate) => candidate.id === stageId);
  if (!stage) return { ok: false, error: `workflow stage '${stageId ?? ""}' is unavailable`, state };
  const stageEntry = stages.find((candidate) => candidate.id === stage.id);
  if (!stageEntry) return { ok: false, error: `workflow stage '${stage.id}' is not persisted`, state };
  if (stageEntry.status === "done" || stageEntry.status === "skipped") {
    return { ok: false, error: `workflow stage '${stage.id}' is already ${stageEntry.status}`, state };
  }
  const existing = activeCapability(state.dispatch_capability);
  if (state.policy?.strict_orchestrator === true && state.dispatch_capability && !existing) {
    return { ok: false, error: "workflow dispatch capability is malformed", state };
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
  const mappingIssues: Array<{ role: string; diagnostic: AgentMappingDiagnostic }> = [];
  for (const slot of slots) {
    const diagnostic = agentMappingIssueForRole(slot.role, config);
    if (diagnostic) mappingIssues.push({ role: slot.role, diagnostic });
  }
  if (mappingIssues.length > 0) {
    const details = mappingIssues
      .map(({ role, diagnostic }) => `role '${role}' requested '${diagnostic.requested}' (candidates: ${diagnostic.candidates.join(", ")})`)
      .join("; ");
    return { ok: false, error: `workflow stage '${stage.id}' has no available agent mapping: ${details}`, state };
  }
  const expectedRoster = slots.map((slot) => ({ role: slot.slot, agent: resolveAgentForRole(slot.role, config) }));
  if (existing && existing.issued_for.stage_cursor === stage.id && existing.status !== "complete" && existing.status !== "invalidated") {
    const rosterChanged = JSON.stringify(existing.expected_roster) !== JSON.stringify(expectedRoster);
    if (existingDispatches.length > 0 && rosterChanged) {
      return { ok: false, error: "active dispatch capability roster is inconsistent", state };
    }
    if (!rosterChanged) {
      // Plaintext secrets are intentionally not persisted. Reissue them when
      // a resumed main session needs to recover an active handoff, preserving
      // the capability identity and already-authorized dispatch records.
      const reissued = reissueActiveCapability(existing);
      const next: TeamState = {
        ...state,
        run_key: state.run_key ?? state.branch,
        profile_hash: persistedHash,
        cursor_epoch: reissued.state.issued_for!.cursor_epoch,
        stage_cursor: stage.id,
        scope: flags,
        policy: { ...(state.policy ?? {}), strict_orchestrator: true },
        stages: stages.map((entry) => entry.id === stage.id ? { ...entry, status: "in_progress" as const } : entry),
        dispatch_capability: reissued.state,
        pause: { kind: "none", reason: "" },
        updated_at: now(),
      };
      persist(cwd, next, target);
      return {
        ok: true,
        state: next,
        handoff: handoffFromState(next, {
          capability_id: reissued.capability_id,
          dispatch_token: reissued.dispatch_token,
          advance_token: reissued.advance_token,
        }, stage),
      };
    }
    // No dispatch was authorized under the stale roster. Reissue the capability
    // with the current mapping so a resumed workflow does not need manual repair.
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
    stages: stages.map((entry) => entry.id === stage.id ? { ...entry, status: "in_progress" as const } : entry),
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
    handoff: handoffFromState(next, {
      capability_id: issued.capability_id,
      dispatch_token: issued.dispatch_token,
      advance_token: issued.advance_token,
    }, stage),
  };
}
function auth(cap: ActiveCapability, a: DispatchAuth, secretHash: string): string | null {
  if (!a.capability_id || a.capability_id !== cap.capability_id) return "capability identity mismatch";
  if (!a.token || hash(a.token) !== secretHash) return "invalid secret";
  const b = cap.issued_for;
  if (a.run_key !== b.run_key || a.branch !== b.branch || a.workflow !== b.workflow || !profileHashMatches(b.profile_hash, a.profile_hash) || a.stage_cursor !== b.stage_cursor || a.cursor_epoch !== b.cursor_epoch) return "capability binding mismatch";
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
  const previousCompletion = record.completion;
  const sameOutcome = previousCompletion?.outcome === input.outcome;
  const sameArtifacts = previousCompletion !== undefined && JSON.stringify(previousCompletion.artifact_ids) === JSON.stringify(artifact_ids);
  // Native task results may be persisted before the executor's artifact write
  // becomes visible to the orchestrator. Preserve the binding and let the
  // advance-boundary recovery snapshot it once the file is readable.
  const canDeferNativeArtifacts = previousCompletion?.completed_by === "synchronous_tool_result" &&
    sameOutcome &&
    (sameArtifacts || (previousCompletion.artifact_ids.length === 0 && artifact_ids.length > 0));
  const unsafeArtifacts = new Set(artifact_ids).size !== artifact_ids.length ||
    artifact_ids.some((id) => !isSafeStateSegment(id));
  const missingArtifacts = artifact_ids.some((id) =>
    !existsSync(join(artifactDir, `${id}.json`)) && !Object.prototype.hasOwnProperty.call(declaredArtifacts, id),
  );
  if (unsafeArtifacts || (missingArtifacts && !canDeferNativeArtifacts)) {
    return { ok: false, error: "declared artifact missing or unsafe", state };
  }
  if (previousCompletion) {
    if (sameOutcome && sameArtifacts) {
      if (previousCompletion.completed_by === "synchronous_tool_result" && artifact_ids.length > 0) {
        const snapshotted = snapshotSlotArtifacts(state, cap, record, artifact_ids, artifactDir);
        if (!snapshotted.ok) {
          if (snapshotted.retryable) return { ok: true, state, record };
          return { ok: false, error: snapshotted.error, state };
        }
        const completion = {
          ...previousCompletion,
          evidence: input.evidence,
          completed_by: input.completed_by ?? previousCompletion.completed_by,
        };
        const updated: DispatchRecord = { ...record, completed_at: completion.completed_at, completion };
        const next: TeamState = {
          ...snapshotted.state,
          dispatch_capability: { ...cap, dispatches: cap.dispatches.map((d) => d.id === record.id ? updated : d) },
        };
        persist(cwd, next, target);
        return { ok: true, state: next, record: updated };
      }
      return { ok: true, state, record };
    }
    if (sameOutcome && previousCompletion.completed_by === "synchronous_tool_result" && previousCompletion.artifact_ids.length === 0 && artifact_ids.length > 0) {
      const snapshotted = snapshotSlotArtifacts(state, cap, record, artifact_ids, artifactDir);
      if (!snapshotted.ok && !snapshotted.retryable) return { ok: false, error: snapshotted.error, state };
      const completedBy = snapshotted.ok ? input.completed_by ?? "workflow_complete" : "synchronous_tool_result";
      const completion = { ...previousCompletion, artifact_ids, evidence: input.evidence, completed_by: completedBy };
      const updated: DispatchRecord = { ...record, completed_at: completion.completed_at, completion };
      const next: TeamState = {
        ...(snapshotted.ok ? snapshotted.state : state),
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
  const recovered = recoverSynchronousArtifactIds(cwd, rawState, target, cap, currentStage);
  if (!recovered.ok) return { ok: false, error: recovered.error, state: rawState };
  let state = recovered.state;

  // Join completeness — every dispatched role must have succeeded.
  const expected = new Set(cap.expected_roles);
  const latest = new Map<string, DispatchRecord>();
  for (const record of cap.dispatches) latest.set(record.role, record);
  const records = Array.from(latest.values());
  if (records.length !== cap.expected_count || records.some((record) => !expected.has(record.role) || record.status !== "succeeded")) {
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
  return { ok: true, state: next, handoff: nextStage && handoffSecrets ? handoffFromState(next, handoffSecrets, nextStage) : undefined };
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
    handoff: handoffFromState(next, {
      capability_id: issued.capability_id,
      dispatch_token: issued.dispatch_token,
      advance_token: issued.advance_token,
    }, backToStage),
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
