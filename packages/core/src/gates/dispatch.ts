import { createHash } from "node:crypto";
import { resolveState, resolveActiveBranch } from "../engine/state.js";
import { loadProfile, profileHash } from "../engine/profile.js";

import type { StageDef } from "../engine/types.js";
export const DISPATCH_MARKER_PREFIX = "<!-- omp-dispatch";
const MARKER_RE = /<!--\s*omp-dispatch\s+run=([^\s]+)\s+stage=([^\s]+)\s+kind=(single|consilium)\s+cursor=([^\s]+)\s+roles=([^\s]+)(?:\s+role=([^\s]+))?(?:\s+capability=([^\s]+))?(?:\s+slot=([^\s]+))?(?:\s+task=([^\s]+))?\s*-->/;

export type DispatchMarker = {
  run: string;
  stage: string;
  kind: "single" | "consilium";
  cursor: string;
  roles: string[];
  role?: string;
  capability_id?: string;
  slot_id?: string;
  task_id?: string;
};

/** Stable task identity used by the marker and durable authorization layers. */
export function dispatchTaskId(capabilityId: string, runKey: string, branch: string, workflow: string, stage: string, role: string): string {
  return `task-${createHash("sha256").update(`${capabilityId}|${runKey}|${branch}|${workflow}|${stage}|${role}`).digest("hex").slice(0, 32)}`;
}

export function buildDispatchMarker(
  run: string,
  stage: StageDef,
  rolesOverride?: string[],
  role?: string,
  cursor = stage.id,
  capabilityId?: string,
  slotId?: string,
  taskId?: string,
): string {
  const roles = rolesOverride ?? (stage.type === "single" ? [stage.role ?? ""] : stage.roles ?? []);
  const rolePart = role ? ` role=${role}` : "";
  const capabilityPart = capabilityId ? ` capability=${capabilityId}` : "";
  const slotPart = slotId ? ` slot=${slotId}` : "";
  const taskPart = taskId ? ` task=${taskId}` : "";
  return `${DISPATCH_MARKER_PREFIX} run=${run} stage=${stage.id} kind=${stage.type} cursor=${cursor} roles=${roles.length > 0 ? roles.join(",") : "-"}${rolePart}${capabilityPart}${slotPart}${taskPart} -->`;
}

export function parseDispatchMarker(text: string): DispatchMarker | null {
  const match = text.match(MARKER_RE);
  if (!match) return null;
  const [run, stage, kind, cursor, rolesText, role, capability_id, slot_id, task_id] = match.slice(1);
  if (!run || !stage || !kind || !cursor || !rolesText) return null;
  const roles = rolesText === "-" ? [] : rolesText.split(",");
  if (roles.some((entry) => !entry)) return null;
  return {
    run,
    stage,
    kind: kind as DispatchMarker["kind"],
    cursor,
    roles,
    ...(role ? { role } : {}),
    ...(capability_id ? { capability_id } : {}),
    ...(slot_id ? { slot_id } : {}),
    ...(task_id ? { task_id } : {}),
  };
}

export function dispatchGate(event: { toolName?: string; input?: unknown }, ctx: { cwd: string }): { block: true; reason: string } | undefined {
  if (event.toolName !== "task") return;
  const currentBranch = resolveActiveBranch(ctx.cwd);
  const resolved = resolveState(ctx.cwd, currentBranch);
  if (resolved.invalid) return { block: true, reason: "dispatch gate: workflow state path is invalid" };
  if (!resolved.state || !resolved.statePath) return;
  if (resolved.isStale) {
    return { block: true, reason: `dispatch gate: workflow state branch '${resolved.state.branch}' does not match active branch '${currentBranch}'` };
  }

  const state = resolved.state;
  const classification = state.classification;
  if (
    !classification ||
    typeof classification !== "object" ||
    typeof classification.workflow !== "string" ||
    !classification.workflow ||
    typeof state.branch !== "string" ||
    !state.branch ||
    typeof state.run_key !== "string" ||
    !state.run_key ||
    typeof state.stage_cursor !== "string" ||
    !state.stage_cursor ||
    typeof state.cursor_epoch !== "string" ||
    !state.cursor_epoch ||
    !Array.isArray(state.stages)
  ) {
    return { block: true, reason: "dispatch gate: malformed workflow state; refusing task launch" };
  }
  if (state.policy?.strict_orchestrator !== true) return;

  const profile = loadProfile(classification.workflow);
  if (!profile) return { block: true, reason: `dispatch gate: workflow '${classification.workflow}' is unavailable` };
  const hash = profileHash(profile);
  if (!state.profile_hash || state.profile_hash !== hash) return { block: true, reason: "dispatch gate: persisted profile is missing or stale" };
  const stage = profile.stages.find((candidate) => candidate.id === state.stage_cursor);
  const persistedStage = state.stages.find((candidate) => candidate.id === state.stage_cursor);
  if (!stage || !persistedStage) return { block: true, reason: `dispatch gate: cursor '${state.stage_cursor}' has no matching stage` };
  if (persistedStage.status !== "in_progress") return { block: true, reason: "dispatch gate: current stage is not in progress" };

  const capability = state.dispatch_capability;
  const issued = capability?.issued_for;
  const expectedRunKey = state.run_key;
  const expectedRoster = capability?.expected_roster;
  const expectedRoles = capability?.expected_roles;
  const expectedCount = capability?.expected_count;
  const dispatchCount = typeof expectedCount === "number" && Number.isInteger(expectedCount) ? expectedCount : -1;
  const validRoster =
    Array.isArray(expectedRoster) &&
    Array.isArray(expectedRoles) &&
    dispatchCount > 0 &&
    dispatchCount === expectedRoster.length &&
    dispatchCount === expectedRoles.length &&
    expectedRoster.every((entry) => isNonEmptyString(entry?.role) && isNonEmptyString(entry?.agent)) &&
    expectedRoles.every(isNonEmptyString) &&
    new Set(expectedRoster.map((entry) => entry.role)).size === dispatchCount &&
    new Set(expectedRoles).size === dispatchCount &&
    expectedRoles.every((role) => expectedRoster.some((entry) => entry.role === role));
  if (
    !capability ||
    (capability.status !== "ready" && capability.status !== "dispatched") ||
    !issued ||
    !isNonEmptyString(issued.run_key) ||
    !isNonEmptyString(issued.branch) ||
    !isNonEmptyString(issued.workflow) ||
    !isNonEmptyString(issued.profile_hash) ||
    !isNonEmptyString(issued.stage_cursor) ||
    !isNonEmptyString(issued.cursor_epoch) ||
    !capability.dispatch_token_hash ||
    !capability.advance_token_hash ||
    !capability.capability_id ||
    !Array.isArray(capability.dispatches) ||
    !validRoster ||
    issued.run_key !== expectedRunKey ||
    issued.branch !== state.branch ||
    issued.workflow !== profile.name ||
    issued.profile_hash !== hash ||
    issued.stage_cursor !== stage.id ||
    issued.cursor_epoch !== state.cursor_epoch ||
    capability.expected_count !== dispatchCount
  ) {
    return { block: true, reason: "dispatch gate: missing or stale opaque dispatch capability" };
  }

  const input = event.input && typeof event.input === "object" && !Array.isArray(event.input)
    ? event.input as Record<string, unknown>
    : undefined;
  const items = Array.isArray(input?.tasks)
    ? input.tasks.map((candidate) => {
        const item = candidate && typeof candidate === "object" && !Array.isArray(candidate)
          ? candidate as Record<string, unknown>
          : {};
        return { item, text: String(item.task ?? "") };
      })
    : [{ item: input ?? {}, text: String(input?.task ?? "") }];
  if (items.length === 0) return { block: true, reason: "dispatch gate: empty task batch" };
  const expectedKind = stage.type === "single" ? "single" : stage.type === "consilium" ? "consilium" : null;
  if (!expectedKind) return { block: true, reason: `dispatch gate: stage '${stage.id}' does not permit task dispatch` };
  if (capability.kind !== expectedKind) return { block: true, reason: "dispatch gate: capability kind does not match current stage" };
  if (items.length !== dispatchCount) return { block: true, reason: `dispatch gate: task count does not match stage '${stage.id}'` };

  const seenRoles = new Set<string>();
  for (const { item, text } of items) {
    const marker = parseDispatchMarker(text);
    if (
      !marker
      || marker.run !== issued.run_key
      || marker.stage !== issued.stage_cursor
      || marker.cursor !== issued.cursor_epoch
      || marker.kind !== capability.kind
      || JSON.stringify([...marker.roles].sort()) !== JSON.stringify(expectedRoster.map((entry) => entry.role).sort())
    ) {
      return { block: true, reason: "dispatch gate: task marker does not match persisted opaque capability" };
    }
    const agent = typeof item.agent === "string" ? item.agent : "";
    const role = marker.slot_id ?? marker.role ?? (typeof item.role === "string" ? item.role : "");
    const roster = expectedRoster.find((entry) => entry.role === role);
    const expectedTask = dispatchTaskId(capability.capability_id, issued.run_key, issued.branch, issued.workflow, issued.stage_cursor, role);
    if (
      marker.capability_id !== undefined && marker.capability_id !== capability.capability_id
      || marker.slot_id !== undefined && marker.slot_id !== role
      || marker.task_id !== undefined && marker.task_id !== expectedTask
      || !roster
      || seenRoles.has(role)
      || agent !== roster.agent
    ) return { block: true, reason: "dispatch gate: role-agent-identity roster mismatch" };
    seenRoles.add(role);
  }
  if (seenRoles.size !== expectedCount) return { block: true, reason: "dispatch gate: dispatch roster is incomplete" };
}

export interface DispatchAuthorizationRequest {
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
  slot_id: string;
  task_id: string;
  agent: string;
  tool_call_id: string;
  expected_count: number;
  retry_of?: string;
}

/**
 * Return the state-bound authorization payload after the ordinary gate has
 * accepted a native task call. The payload contains no secret; durable.ts
 * still validates every binding before persisting the dispatch record.
 */
export function trustedDispatchRequests(
  event: { toolName?: string; toolCallId?: string; input?: unknown },
  ctx: { cwd: string },
): { ok: true; requests: DispatchAuthorizationRequest[] } | { ok: false; reason: string } {
  if (event.toolName !== "task") return { ok: false, reason: "dispatch gate: non-task call" };
  const resolved = resolveState(ctx.cwd, resolveActiveBranch(ctx.cwd));
  const state = resolved.state;
  if (!state || state.policy?.strict_orchestrator !== true) return { ok: true, requests: [] };
  const blocked = dispatchGate(event, ctx);
  if (blocked) return { ok: false, reason: blocked.reason };
  const toolCallId = event.toolCallId;
  if (!toolCallId) return { ok: false, reason: "dispatch gate: task call identity is missing" };
  const cap = state.dispatch_capability;
  const issued = cap?.issued_for;
  if (!cap || !issued || !cap.capability_id || !Number.isInteger(cap.expected_count)) return { ok: false, reason: "dispatch gate: capability disappeared before authorization" };
  const capabilityId = cap.capability_id;
  const expectedCount = cap.expected_count as number;
  const input = event.input && typeof event.input === "object" && !Array.isArray(event.input)
    ? event.input as Record<string, unknown>
    : undefined;
  const items = Array.isArray(input?.tasks)
    ? input.tasks.map((candidate) => candidate && typeof candidate === "object" && !Array.isArray(candidate) ? candidate as Record<string, unknown> : {})
    : [input ?? {}];
  const requests: DispatchAuthorizationRequest[] = [];
  for (const item of items) {
    const marker = parseDispatchMarker(String(item.task ?? ""));
    if (!marker) return { ok: false, reason: "dispatch gate: task marker disappeared during authorization" };
    const slotId = marker.slot_id ?? marker.role ?? (typeof item.role === "string" ? item.role : "");
    if (!slotId) return { ok: false, reason: "dispatch gate: task slot identity is missing" };
    requests.push({
      capability_id: capabilityId,
      run_key: issued.run_key,
      branch: issued.branch,
      workflow: issued.workflow,
      profile_hash: issued.profile_hash,
      stage_cursor: issued.stage_cursor,
      cursor_epoch: issued.cursor_epoch,
      ...(Number.isInteger(issued.loop_iteration) ? { loop_iteration: issued.loop_iteration as number } : {}),
      role: slotId,
      slot_id: slotId,
      task_id: marker.task_id ?? dispatchTaskId(capabilityId, issued.run_key, issued.branch, issued.workflow, issued.stage_cursor, slotId),
      agent: typeof item.agent === "string" ? item.agent : "",
      tool_call_id: toolCallId,
      expected_count: expectedCount,
      ...(typeof item.retry_of === "string" ? { retry_of: item.retry_of } : {}),
    });
  }
  return { ok: true, requests };
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}
