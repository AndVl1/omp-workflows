/**
 * Monotonic stage gate (P4). Replaces the second half of claude-plugin's
 * `validate-state.sh` hook.
 *
 * The identity-bound workflow state's `stages[]` array must be monotonic — a
 * `pending` stage must not precede a `done` or `in_progress` stage. Mark
 * deliberately skipped stages `skipped`, never `pending`.
 *
 * Wired to `before_agent_start`. Unlike the retired gate, a durable state
 * record is never inspected without its required WorkflowRunIdentity.
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { resolveState } from "../engine/state.js";
import type { TeamState } from "../engine/types.js";
import { validateWorkflowRunIdentity } from "../workflow-v2/identity.js";
import type { WorkflowRunIdentity } from "../workflow-v2/types.js";

const STATE_RESOLUTION_MIGRATION_REASON =
  "MIGRATION_REQUIRED: migrate the identity-bound workflow state explicitly before attempting to resume it.";

interface AgentStartContext {
  readonly cwd: string;
  readonly run_identity?: WorkflowRunIdentity;
  readonly state?: TeamState | null;
}

function projectIdentityKey(identity: WorkflowRunIdentity): string {
  return JSON.stringify([
    identity.root_instance_id,
    identity.provider_id,
    identity.descriptor_fingerprint,
    identity.executable_provenance.build_fingerprint,
    identity.executable_provenance.runtime_fingerprint,
    identity.catalog_content_digest,
    identity.config_byte_sha256,
    identity.config_semantic_sha256,
    identity.session.session_id,
    identity.session.lifecycle_id,
  ]);
}

function runIdentityKey(identity: WorkflowRunIdentity): string {
  return JSON.stringify([
    projectIdentityKey(identity),
    identity.run_id,
    identity.profile_identity.id,
    identity.profile_identity.fingerprint,
  ]);
}

function identityBlockReason(code: "MIGRATION_REQUIRED" | "IDENTITY_MISMATCH", detail: string): string {
  return `${code}: ${detail}`;
}

function stateWithIdentity(
  state: TeamState,
  expected: WorkflowRunIdentity,
): { ok: true; state: TeamState } | { ok: false; reason: string } {
  const candidate = (state as unknown as { run_identity?: unknown }).run_identity;
  if (candidate === undefined) {
    return {
      ok: false,
      reason: identityBlockReason("MIGRATION_REQUIRED", "persisted workflow state has no required WorkflowRunIdentity"),
    };
  }
  const checked = validateWorkflowRunIdentity(candidate);
  if (!checked.ok) {
    return {
      ok: false,
      reason: identityBlockReason("MIGRATION_REQUIRED", "persisted workflow state does not contain a complete WorkflowRunIdentity"),
    };
  }
  if (runIdentityKey(checked.value) !== runIdentityKey(expected)) {
    return {
      ok: false,
      reason: identityBlockReason("IDENTITY_MISMATCH", "persisted workflow state does not match the admitted run and profile identity"),
    };
  }
  return { ok: true, state };
}

export function monotonicGate(_event: unknown, ctx: AgentStartContext): { block?: boolean; reason?: string } | void {
  let expected: WorkflowRunIdentity | undefined;
  if (ctx.run_identity !== undefined) {
    const checked = validateWorkflowRunIdentity(ctx.run_identity);
    if (!checked.ok) {
      return { block: true, reason: identityBlockReason("MIGRATION_REQUIRED", "a complete WorkflowRunIdentity is required") };
    }
    expected = checked.value;
  }

  let state: TeamState | null;
  if (ctx.state !== undefined) {
    state = ctx.state;
    if (!state) return;
    if (!expected) {
      return { block: true, reason: identityBlockReason("MIGRATION_REQUIRED", "a WorkflowRunIdentity is required for durable state") };
    }
    const checkedState = stateWithIdentity(state, expected);
    if (!checkedState.ok) return { block: true, reason: checkedState.reason };
  } else {
    const resolved = resolveState(ctx.cwd, undefined, expected);
    const stateExpected = resolved.statePath !== null || resolved.stateDir !== null || existsSync(resolve(ctx.cwd, ".work-state"));
    if (!stateExpected) return;
    if (!expected) {
      return { block: true, reason: identityBlockReason("MIGRATION_REQUIRED", "a WorkflowRunIdentity is required for durable state") };
    }
    if (resolved.invalid || (resolved.diagnostics && resolved.diagnostics.length > 0) || !resolved.state) {
      return { block: true, reason: STATE_RESOLUTION_MIGRATION_REASON };
    }
    const checkedState = stateWithIdentity(resolved.state, expected);
    if (!checkedState.ok) return { block: true, reason: checkedState.reason };
    state = resolved.state;
  }
  if (!state) return;
  if (!Array.isArray(state.stages) || state.stages.length === 0) return;
  const statuses = state.stages.map((s) => s.status ?? "pending");
  const firstPending = statuses.indexOf("pending");
  if (firstPending === -1) return;
  const after = statuses.slice(firstPending + 1).filter((s) => s === "done" || s === "in_progress");
  if (after.length > 0) {
    const stageId = state.stages[firstPending]?.id ?? "?";
    return {
      block: true,
      reason: `BLOCK (P4): stage progress is not monotonic — stage ${stageId} is pending while a later stage is done/in_progress. Mark skipped stages 'skipped', not 'pending'.`,
    };
  }
}
