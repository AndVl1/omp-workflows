import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { loadProfile, profileHash } from "./profile.js";
import { resolveState, writeState, isSafeStateSegment, resolveActiveBranch, type ResolvedState } from "./state.js";
import { resolveConfig, resolveAgentForRole } from "./config.js";
import { resolveScope } from "./scope.js";
import { resolveStageDispatchRoles } from "./stage.js";
import { readArtifact } from "./artifacts.js";
import { isDoDComplete, isRootCauseDocumented, readDoD } from "./dod.js";
import { validationGate } from "../gates/validation.js";
import type { DispatchCompletion, DispatchRecord, TeamState, StageDef } from "./types.js";

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
}

function handoffFromState(
  state: TeamState,
  secrets: { capability_id: string; dispatch_token: string; advance_token: string },
): CapabilityHandoff | undefined {
  const cap = activeCapability(state.dispatch_capability);
  if (!cap) return undefined;
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
  const roles = kind === "none"
    ? []
    : resolveStageDispatchRoles(stage, { cwd, flags, resolveDevAgent: () => flags.dev_agent });
  if ((kind === "single" && roles.length !== 1) || (kind === "consilium" && roles.length === 0)) {
    return { ok: false, error: `workflow stage '${stage.id}' has an invalid dispatch roster`, state };
  }
  const expectedRoster = roles.map((role) => ({ role, agent: resolveAgentForRole(role, config) }));
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
    handoff: handoffFromState(next, {
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
      const next: TeamState = { ...state, dispatch_capability: { ...cap, dispatches: cap.dispatches.map((d) => d.id === record.id ? updated : d) } };
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
  const next: TeamState = { ...state, dispatch_capability: { ...cap, dispatches: cap.dispatches.map((d) => d.id === record.id ? updated : d) } };
  persist(cwd, next, target);
  return { ok: true, state: next, record: updated };
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

function evaluateStageGate(stage: StageDef, state: TeamState, artifactsDir: string): string | null {
  const gate = stage.gate?.trim();
  if (!gate) return null;
  if (gate === "branch_created") return state.branch.trim() ? null : "branch_created gate requires a persisted branch";
  if (gate === "root_cause_documented") {
    const result = isRootCauseDocumented(artifactsDir);
    return result.ok ? null : result.reason;
  }
  if (gate === "dod_complete") {
    const result = isDoDComplete(readDoD(artifactsDir));
    return result.ok ? null : `dod_complete gate is not satisfied (${result.pending.length} pending items)`;
  }
  if (gate === "plan_valid") {
    const plan = objectArtifact(artifactsDir, "team_plan");
    return plan && Array.isArray(plan.teams) && plan.teams.length > 0 ? null : "plan_valid gate requires a non-empty team_plan.teams array";
  }
  if (gate === "contract_complete") {
    const architecture = objectArtifact(artifactsDir, "architecture");
    return architecture && Array.isArray(architecture.options) && architecture.options.length > 0 && typeof architecture.chosen === "string" && architecture.chosen.trim() ? null : "contract_complete gate requires architecture options and a chosen option";
  }
  if (gate === "feature_spec_present") {
    const spec = objectArtifact(artifactsDir, "feature_spec");
    return spec && typeof spec.goal === "string" && spec.goal.trim() && Array.isArray(spec.acceptance_criteria) && spec.acceptance_criteria.length > 0 ? null : "feature_spec_present gate requires a goal and acceptance criteria";
  }
  if (gate === "tests_passed") {
    const tests = objectArtifact(artifactsDir, "qa_tests");
    return tests?.build_status === "pass" ? null : "tests_passed gate requires qa_tests.build_status=pass";
  }
  const verdictGate = /^(?:(?<artifact>[A-Za-z0-9._-]+)\.)?verdict\s*(?<operator>==|!=)\s*(?<expected>[A-Za-z0-9_-]+)$/.exec(gate);
  if (verdictGate?.groups) {
    const artifactId = verdictGate.groups.artifact ?? stageProduces(stage).find((id) => objectArtifact(artifactsDir, id)?.verdict !== undefined);
    const artifact = artifactId ? objectArtifact(artifactsDir, artifactId) : null;
    const actual = typeof artifact?.verdict === "string" ? artifact.verdict : null;
    if (!actual) return `verdict gate '${gate}' requires a normalized verdict artifact`;
    const matches = actual === verdictGate.groups.expected;
    return (verdictGate.groups.operator === "==" ? matches : !matches) ? null : `verdict gate '${gate}' rejected verdict '${actual}'`;
  }
  return `unsupported workflow gate '${gate}'`;
}

function validateStageCompletion(stage: StageDef, state: TeamState, target: ResolvedState, evidence: string): string | null {
  if (!evidence.trim()) return "stage completion evidence required";
  const artifactsDir = target.artifactsDir ?? "";
  for (const id of stageProduces(stage)) {
    if (!isSafeStateSegment(id) || !readArtifact(artifactsDir, id)) return `required stage artifact '${id}.json' is missing or invalid`;
  }
  const validation = validationGate({ cwd: target.stateDir ?? "", stageId: stage.id, artifactsDir, produces: stage.produces });
  if (!validation.ok) return validation.reason;
  return evaluateStageGate(stage, state, artifactsDir);
}

export function advanceCursor(cwd: string, input: DispatchAuth): TransitionResult {
  const found = current(cwd);
  if (!found) return { ok: false, error: "state not found" };
  const { state, target } = found;
  if (target.isStale) return { ok: false, error: "workflow state is stale for the active branch", state };
  const cap = activeCapability(state.dispatch_capability);
  if (!cap) return { ok: false, error: "dispatch capability unavailable", state };
  const error = auth(cap, input, cap.advance_token_hash);
  if (error) return { ok: false, error, state };
  if (cap.status === "invalidated" || cap.status === "complete") return { ok: false, error: "capability invalidated", state };
  if (input.cursor_epoch !== cap.issued_for.cursor_epoch || state.stage_cursor !== cap.issued_for.stage_cursor || state.cursor_epoch !== cap.issued_for.cursor_epoch) return { ok: false, error: "stale cursor binding", state };
  if (typeof input.evidence !== "string" || !input.evidence.trim()) return { ok: false, error: "stage advancement evidence required", state };
  const profile = loadProfile(cap.issued_for.workflow);
  if (!profile || profileHash(profile) !== cap.issued_for.profile_hash) return { ok: false, error: "workflow profile is missing or stale", state };
  const currentStage = profile.stages.find((candidate) => candidate.id === state.stage_cursor);
  if (!currentStage) return { ok: false, error: "current workflow stage unavailable", state };
  const completionError = validateStageCompletion(currentStage, state, target, input.evidence);
  if (completionError) return { ok: false, error: completionError, state };

  const expected = new Set(cap.expected_roles);
  const latest = new Map<string, DispatchRecord>();
  for (const record of cap.dispatches) latest.set(record.role, record);
  const records = Array.from(latest.values());
  if (records.length !== cap.expected_count || records.some((record) => !expected.has(record.role) || record.status !== "succeeded")) {
    return { ok: false, error: "dispatch join incomplete", state };
  }

  const index = state.stages.findIndex((s) => s.id === state.stage_cursor);
  if (index < 0) return { ok: false, error: "current workflow stage unavailable", state };
  const nextStageEntry = state.stages[index + 1];
  const nextStage = nextStageEntry && profile.stages.find((candidate) => candidate.id === nextStageEntry.id);
  if (nextStageEntry && !nextStage) return { ok: false, error: "next workflow stage unavailable", state };
  const epoch = randomUUID();
  let handoffSecrets: { capability_id: string; dispatch_token: string; advance_token: string } | undefined;
  let nextCap: NonNullable<TeamState["dispatch_capability"]>;
  if (nextStage) {
    const nextKind: "none" | "single" | "consilium" =
      nextStage.type === "single" || nextStage.type === "consilium" ? nextStage.type : "none";
    const config = resolveConfig(cwd);
    const flags = state.scope ?? resolveScope([], config);
    const roles = nextKind === "none"
      ? []
      : resolveStageDispatchRoles(nextStage, { cwd, flags, resolveDevAgent: () => flags.dev_agent });
    if ((nextKind === "single" && roles.length !== 1) || (nextKind === "consilium" && roles.length === 0)) {
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
      expected_roster: roles.map((role) => ({ role, agent: resolveAgentForRole(role, config) })),
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
    stages: state.stages.map((s) => s.id === state.stage_cursor ? { ...s, status: "done" as const } : s),
    join_summary: { stage_id: state.stage_cursor, cursor_epoch: cap.issued_for.cursor_epoch, dispatch_ids: records.map((r) => r.id), roles: records.map((r) => r.role), evidence: input.evidence.trim(), joined_at: now() },
    dispatch_capability: nextCap,
    pause: nextStage ? state.pause : { kind: "done", reason: "" },
  };
  persist(cwd, next, target);
  return { ok: true, state: next, handoff: handoffSecrets ? handoffFromState(next, handoffSecrets) : undefined };
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
