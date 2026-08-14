import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { resolveState, writeState, type ResolvedState } from "./state.js";
import type { DispatchCompletion, DispatchRecord, TeamState } from "./types.js";

export type DispatchAuth = {
  token: string;
  capability_id: string;
  run_key?: string;
  branch?: string;
  workflow?: string;
  profile_hash?: string;
  stage_cursor?: string;
  cursor_epoch?: string;
  role?: string;
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
  if (!value?.issued_for || !value.dispatch_token_hash || !value.advance_token_hash || !value.capability_id || !value.dispatches || !value.expected_roles || value.expected_count === undefined || !value.expected_roster || !value.status) return null;
  if (value.expected_count !== value.expected_roles.length || value.expected_count !== value.expected_roster.length) return null;
  if (new Set(value.expected_roles).size !== value.expected_roles.length || new Set(value.expected_roster.map((r) => r.role)).size !== value.expected_roster.length) return null;
  return value as ActiveCapability;
};

export type TransitionResult = { ok: true; state: TeamState; record?: DispatchRecord; handoff?: { capability_id: string; dispatch_token: string; advance_token: string; cursor_epoch: string } } | { ok: false; error: string; state?: TeamState };

const hash = (value: string): string => createHash("sha256").update(value).digest("hex");
const now = (): string => new Date().toISOString();
const current = (cwd: string): { state: TeamState; target: ResolvedState } | null => {
  const target = resolveState(cwd);
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
  const cursor_epoch = input.cursor_epoch ?? randomUUID();
  const dispatch_token = input.dispatch_secret ?? randomUUID();
  const advance_token = input.advance_secret ?? randomUUID();
  const roster = (input.expected_roster ?? (input.expected_roles ?? []).map((role) => ({ role, agent: role }))).map((entry) => ({ role: entry.role, agent: entry.agent }));
  const expected_roles = roster.map((entry) => entry.role);
  if (new Set(expected_roles).size !== expected_roles.length || roster.some((entry) => !entry.role || !entry.agent)) throw new Error("invalid capability roster");
  const state = { capability_id: randomUUID(), dispatch_token_hash: hash(dispatch_token), advance_token_hash: hash(advance_token), issued_for: { run_key: input.run_key, branch: input.branch, workflow: input.workflow, profile_hash: input.profile_hash, stage_cursor: input.stage_cursor, cursor_epoch }, kind: input.kind, expected_roles, expected_count: roster.length, expected_roster: roster, status: "ready" as const, dispatches: [] };
  return { capability_id: state.capability_id, dispatch_token, advance_token, state };
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
  const { state, target } = found; const cap = activeCapability(state.dispatch_capability); if (!cap) return { ok: false, error: "dispatch capability unavailable", state };
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

export function completeDispatch(cwd: string, input: DispatchAuth & { dispatch_id: string; outcome: DispatchCompletion["outcome"]; evidence: string; artifact_ids?: string[]; completed_by?: DispatchCompletion["completed_by"] }): TransitionResult {
  const found = current(cwd); if (!found) return { ok: false, error: "state not found" };
  const { state, target } = found; const cap = activeCapability(state.dispatch_capability); if (!cap) return { ok: false, error: "dispatch capability unavailable", state };
  const error = auth(cap, input, cap.dispatch_token_hash); if (error) return { ok: false, error, state };
  const record = cap.dispatches.find((d) => d.id === input.dispatch_id); if (!record) return { ok: false, error: "unknown dispatch", state };
  if (!input.evidence.trim()) return { ok: false, error: "completion evidence required", state };
  const artifact_ids = input.artifact_ids ?? []; const artifactDir = target.artifactsDir ?? "";
  if (artifact_ids.some((id) => !existsSync(join(artifactDir, `${id}.json`)) && !state.artifacts[id])) return { ok: false, error: "declared artifact missing", state };
  if (record.completion) {
    const same = record.completion.outcome === input.outcome && record.completion.evidence === input.evidence && JSON.stringify(record.completion.artifact_ids) === JSON.stringify(artifact_ids);
    return same ? { ok: true, state, record } : { ok: false, error: "conflicting replay", state };
  }
  const completion: DispatchCompletion = { dispatch_id: record.id, cursor_epoch: cap.issued_for.cursor_epoch, outcome: input.outcome, artifact_ids, evidence: input.evidence, completed_by: input.completed_by ?? "workflow_complete", completed_at: now() };
  const updated: DispatchRecord = { ...record, status: input.outcome, completed_at: completion.completed_at, completion };
  const next: TeamState = { ...state, dispatch_capability: { ...cap, dispatches: cap.dispatches.map((d) => d.id === record.id ? updated : d) } };
  persist(cwd, next, target); return { ok: true, state: next, record: updated };
}

export function advanceCursor(cwd: string, input: DispatchAuth): TransitionResult {
  const found = current(cwd); if (!found) return { ok: false, error: "state not found" };
  const { state, target } = found; const cap = activeCapability(state.dispatch_capability); if (!cap) return { ok: false, error: "dispatch capability unavailable", state };
  const error = auth(cap, input, cap.advance_token_hash); if (error) return { ok: false, error, state };
  if (input.cursor_epoch && input.cursor_epoch !== cap.issued_for.cursor_epoch) return { ok: false, error: "stale cursor epoch", state };
  const expected = new Set(cap.expected_roles); const records = cap.dispatches;
  if (records.length !== cap.expected_count || new Set(records.map((r) => r.role)).size !== cap.expected_count || records.some((r) => !expected.has(r.role) || r.status !== "succeeded")) return { ok: false, error: "dispatch join incomplete", state };
  const index = state.stages.findIndex((s) => s.id === state.stage_cursor); const nextStage = state.stages[index + 1];
  const epoch = randomUUID();
  let handoff: { capability_id: string; dispatch_token: string; advance_token: string; cursor_epoch: string } | undefined;
  let nextCap: NonNullable<TeamState["dispatch_capability"]>;
  if (nextStage) {
    const issued = createCapability({ run_key: cap.issued_for.run_key, branch: cap.issued_for.branch, workflow: cap.issued_for.workflow, profile_hash: cap.issued_for.profile_hash, stage_cursor: nextStage.id, cursor_epoch: epoch, kind: cap.kind, expected_roles: cap.expected_roles });
    nextCap = issued.state;
    handoff = { capability_id: issued.capability_id, dispatch_token: issued.dispatch_token, advance_token: issued.advance_token, cursor_epoch: epoch };
  } else {
    nextCap = { ...cap, status: "complete" as const, dispatches: [] };
  }
  const next: TeamState = { ...state, stage_cursor: nextStage?.id ?? state.stage_cursor, cursor_epoch: epoch, stages: state.stages.map((s) => s.id === state.stage_cursor ? { ...s, status: "done" as const } : s), join_summary: { stage_id: state.stage_cursor, cursor_epoch: cap.issued_for.cursor_epoch, dispatch_ids: records.map((r) => r.id), roles: records.map((r) => r.role), joined_at: now() }, dispatch_capability: nextCap, pause: nextStage ? state.pause : { kind: "done", reason: "" } };
  persist(cwd, next, target); return { ok: true, state: next, handoff };
}

export function reconcileTaskResult(cwd: string, input: { dispatch_id: string; token: string; capability_id: string; cursor_epoch?: string; output?: string; isError?: boolean; details?: { async?: { state?: string } } }): TransitionResult {
  const asyncState = input.details?.async?.state;
  if (asyncState === "running" || asyncState === "spawned" || asyncState === "scheduled" || (!input.output && !input.isError)) return { ok: false, error: "asynchronous task remains pending" };
  return completeDispatch(cwd, { ...input, outcome: input.isError ? "failed" : "succeeded", evidence: input.output?.trim() || (input.isError ? "task failed" : ""), completed_by: "synchronous_tool_result" });
}
