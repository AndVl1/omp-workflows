import { resolveState } from "../engine/state.js";
import { loadProfile, profileHash } from "../engine/profile.js";
import type { Profile, StageDef, TeamState } from "../engine/types.js";

export const DISPATCH_MARKER_PREFIX = "<!-- omp-dispatch";
const MARKER_RE = /<!--\s*omp-dispatch\s+run=([^\s]+)\s+stage=([a-z0-9_-]+)\s+kind=(single|consilium)\s+cursor=([a-z0-9_-]+)\s+roles=([^\s]+)\s*-->/;

export type DispatchMarker = { run: string; stage: string; kind: "single" | "consilium"; cursor: string; roles: string[] };

export function buildDispatchMarker(run: string, stage: StageDef): string {
  const roles = stage.type === "single" ? [stage.role ?? ""] : stage.roles ?? [];
  return `${DISPATCH_MARKER_PREFIX} run=${run} stage=${stage.id} kind=${stage.type} cursor=${stage.id} roles=${roles.join(",")} -->`;
}

export function parseDispatchMarker(text: string): DispatchMarker | null {
  const match = text.match(MARKER_RE);
  if (!match) return null;
  const [run, stage, kind, cursor, rolesText] = match.slice(1);
  if (!run || !stage || !kind || !cursor || !rolesText) return null;
  const roles = rolesText === "-" ? [] : rolesText.split(",");
  if (roles.some((role) => !role)) return null;
  return { run, stage, kind: kind as DispatchMarker["kind"], cursor, roles };
}

export function dispatchGate(event: { toolName?: string; input?: unknown }, ctx: { cwd: string }): { block: true; reason: string } | undefined {
  if (event.toolName !== "task") return;
  const resolved = resolveState(ctx.cwd);
  if (!resolved.state || !resolved.statePath) return;
  const state = resolved.state;
  if (resolved.isStale) return { block: true, reason: "dispatch gate: workflow state is stale for the active branch" };
  if (state.policy?.strict_orchestrator !== true) return;
  const classification = state.classification;
  if (!classification || typeof classification !== "object" || typeof classification.workflow !== "string" || !classification.workflow) {
    return { block: true, reason: "dispatch gate: malformed classification state; refusing task launch" };
  }
  const profile = loadProfile(classification.workflow);
  if (!profile) return { block: true, reason: `dispatch gate: workflow '${classification.workflow}' is unavailable` };
  const hash = profileHash(profile);
  if (!state.profile_hash || state.profile_hash !== hash) return { block: true, reason: "dispatch gate: persisted profile is missing or stale" };
  const stage = profile.stages.find((candidate) => candidate.id === state.stage_cursor);
  if (!stage) return { block: true, reason: `dispatch gate: cursor '${state.stage_cursor}' has no matching stage` };
  const capability = state.dispatch_capability;
  const issued = capability?.issued_for;
  if (!capability || !issued || !capability.dispatch_token_hash || !capability.advance_token_hash || !capability.capability_id || !capability.expected_roster || !capability.dispatches || issued.run_key !== (state.run_key ?? `team:${state.branch}:root`) || issued.branch !== state.branch || issued.workflow !== profile.name || issued.profile_hash !== hash || issued.stage_cursor !== stage.id || issued.cursor_epoch !== state.cursor_epoch || capability.expected_count !== capability.expected_roster.length) return { block: true, reason: "dispatch gate: missing or stale opaque dispatch capability" };
  const input = event.input as Record<string, unknown> | undefined;
  const items = Array.isArray(input?.tasks) ? input.tasks.map((item) => ({ item: item as Record<string, unknown>, text: String((item as Record<string, unknown>)?.task ?? "") })) : [{ item: input ?? {}, text: String(input?.task ?? "") }];
  if (items.length === 0) return { block: true, reason: "dispatch gate: empty task batch" };
  const expectedKind = stage.type === "single" ? "single" : stage.type === "consilium" ? "consilium" : null;
  if (!expectedKind) return { block: true, reason: `dispatch gate: stage '${stage.id}' does not permit task dispatch` };
  if (items.length !== (expectedKind === "single" ? 1 : (stage.roles ?? []).length)) return { block: true, reason: `dispatch gate: task count does not match stage '${stage.id}'` };
  for (const { item, text } of items) {
    const marker = parseDispatchMarker(text);
    if (!marker || marker.run !== issued.run_key || marker.stage !== issued.stage_cursor || marker.cursor !== issued.cursor_epoch || marker.kind !== capability.kind || JSON.stringify([...marker.roles].sort()) !== JSON.stringify(capability.expected_roster.map((entry) => entry.role).sort())) return { block: true, reason: "dispatch gate: task marker does not match persisted opaque capability" };
    const agent = typeof item.agent === "string" ? item.agent : "";
    const role = typeof item.role === "string" ? item.role : "";
    const roster = capability.expected_roster.find((entry) => entry.role === role);
    if (!roster || agent !== roster.agent) return { block: true, reason: "dispatch gate: role-agent roster mismatch" };
  }
}

