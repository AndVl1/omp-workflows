/**
 * Definition-of-Done backstop. Replaces claude-plugin's `dod-gate.sh`
 * Stop hook.
 *
 * Blocks a done-claim (returns `{ decision: "block", reason }` from
 * `session_stop`) when the DoD artifact has unmet or evidence-less items.
 *
 * Allows Stop in every legitimate pause:
 *   - no JSON state / no .work-state
 *   - stale state (branch != current)
 *   - typed neutral runtime state (pending/active/Still Running/nested wait/polling/
 *     temporary artifact absence)
 *   - override marker .work-state/.dod-override present
 *   - workflow in research | review | emergency | lecture-research (no implementation phase)
 *   - not claiming done yet (cursor not at summary AND pause.kind != done)
 */

import { join } from "node:path";
import { PinnedProjectRoot } from "../specification/pinned-root.js";
import { resolveActiveStatePinned } from "../engine/state.js";
import { readDoDFilePinned } from "../engine/dod.js";
const WORK_STATE_DIR = ".work-state";

export interface SessionStopEvent {
  stop_hook_active?: boolean;
}

export interface SessionStopContext {
  cwd: string;
}

export interface DoDItem {
  id?: string;
  criterion: string;
  verify_method: string;
  status: "pending" | "met";
  evidence?: string;
}

export interface DoD {
  items: DoDItem[];
}

export type DoDValidation =
  | { ok: true; value: DoD }
  | { ok: false; error: string };

interface TeamState {
  classification?: { workflow?: string };
  pause?: { kind?: string };
  stage_cursor?: string;
  branch?: string;
  specification?: { status?: unknown; handoff_ref?: unknown };
}

const NEUTRAL_RUNTIME_STATES: Record<string, true> = {
  background_wait: true,
  user_checkpoint: true,
  needs_human: true,
  failed: true,
  pending: true,
  pending_worker: true,
  active: true,
  active_worker: true,
  still_running: true,
  nested_wait: true,
  polling: true,
  polling_state: true,
  temporary_artifact_absence: true,
  temporary_artifact_missing: true,
  artifact_temporary_absence: true,
};
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function normalizeRuntimeState(value: unknown): string | null {
  return typeof value === "string" ? value.trim().toLowerCase().replace(/[\s-]+/g, "_") : null;
}

function hasNeutralRuntimeState(state: TeamState): boolean {
  const extended = state as TeamState & {
    worker?: { status?: unknown; state?: unknown };
    wait?: { kind?: unknown; status?: unknown };
    polling?: unknown;
    worker_status?: unknown;
    wait_status?: unknown;
    poll_state?: unknown;
    artifact_status?: unknown;
  };
  const polling = isRecord(extended.polling) ? extended.polling : null;
  const candidates = [
    state.pause?.kind,
    extended.worker?.status,
    extended.worker?.state,
    extended.wait?.kind,
    extended.wait?.status,
    polling?.kind,
    polling?.status,
    polling === null ? extended.polling : undefined,
    extended.worker_status,
    extended.wait_status,
    extended.poll_state,
    extended.artifact_status,
  ];
  return candidates.some((candidate) => {
    const normalized = normalizeRuntimeState(candidate);
    return normalized !== null && NEUTRAL_RUNTIME_STATES[normalized] === true;
  });
}

export function validateTypedDoD(input: unknown): DoDValidation {
  if (!isRecord(input)) return { ok: false, error: "root must be an object" };
  if ("criteria" in input) return { ok: false, error: "legacy criteria is not supported; use typed items" };
  if (!Array.isArray(input.items)) return { ok: false, error: "items must be an array" };

  const items: DoDItem[] = [];
  for (const [index, rawItem] of input.items.entries()) {
    if (!isRecord(rawItem)) return { ok: false, error: `items[${index}] must be an object` };

    const criterion = rawItem.criterion;
    if (!nonEmptyString(criterion)) return { ok: false, error: `items[${index}].criterion must be a non-empty string` };
    const verifyMethod = rawItem.verify_method;
    if (!nonEmptyString(verifyMethod)) return { ok: false, error: `items[${index}].verify_method must be a non-empty string` };

    const status = rawItem.status;
    if (status !== "pending" && status !== "met") {
      return { ok: false, error: `items[${index}].status must be pending or met` };
    }

    let id: string | undefined;
    if ("id" in rawItem) {
      if (!nonEmptyString(rawItem.id)) return { ok: false, error: `items[${index}].id must be a non-empty string when present` };
      id = rawItem.id;
    }

    let evidence: string | undefined;
    if ("evidence" in rawItem) {
      if (typeof rawItem.evidence !== "string") return { ok: false, error: `items[${index}].evidence must be a string when present` };
      evidence = rawItem.evidence;
    }

    items.push({
      ...(id === undefined ? {} : { id }),
      criterion,
      verify_method: verifyMethod,
      status,
      ...(evidence === undefined ? {} : { evidence }),
    });
  }
  return { ok: true, value: { items } };
}


export function dodBackstop(event: SessionStopEvent, ctx: SessionStopContext): { decision: "block"; reason: string } | { continue: true } | void {
  if (event.stop_hook_active) return;
  const pinnedRoot = PinnedProjectRoot.open(ctx.cwd);
  if (!pinnedRoot) return;
  try {
    const resolved = resolveActiveStatePinned(ctx.cwd, pinnedRoot);
    const state = resolved.state;
    if (!state || !resolved.stateDir) return;
    if (pinnedRoot.pathEntryExists(join(WORK_STATE_DIR, ".dod-override"))) return;
    if (hasNeutralRuntimeState(state)) return;

    const workflow = state.classification?.workflow;
    if (workflow === "research" || workflow === "review" || workflow === "emergency" || workflow === "lecture-research") return;

    const pause = state.pause?.kind ?? "none";
    const cursor = state.stage_cursor;
    const claimingDone = pause === "done" || cursor === "summary";
    if (!claimingDone) return;

    const pendingDispatches = (state as TeamState & { dispatch_capability?: { dispatches?: Array<{ id: string; status?: string }> } }).dispatch_capability?.dispatches?.filter((d) => d.status === "authorized" || d.status === "running") ?? [];
    if (pendingDispatches.length > 0) {
      return {
        decision: "block",
        reason: `Durable join incomplete: ${pendingDispatches.length} dispatch(es) still authorized/running (${pendingDispatches.map((d) => d.id).join(", ")}). Reconcile terminal tool_result outcomes before stopping.`,
      };
    }

    // spec-import stops at an implementation-ready handoff. It has completed
    // compatibility approval and frozen the shared handoff, but it has not
    // started implementation work, so the implementation DoD backstop does
    // not apply until /do-work --spec claims that handoff.
    if (workflow === "spec-import"
      && state.specification?.status === "implementation_ready"
      && nonEmptyString(state.specification.handoff_ref)) {
      return { continue: true };
    }

    const dodAbsolutePath = join(resolved.stateDir, "artifacts", "dod.json");
    const dodRelativePath = pinnedRoot.relativePath(dodAbsolutePath);
    if (!dodRelativePath) return;
    const dodResult = readDoDFilePinned(pinnedRoot, dodRelativePath);
    if (!dodResult.ok) {
      const reason = dodResult.reason.includes("missing")
        ? `DoD: malformed typed artifact at ${dodAbsolutePath}: file is missing (unmet or evidence-less). Write the typed Definition of Done (items with criterion, verify_method, and status).`
        : `DoD: malformed typed artifact at ${dodAbsolutePath}: ${dodResult.reason}. Each item requires criterion, verify_method, status (pending|met), and optional evidence.`;
      return { decision: "block", reason };
    }

    const dod = dodResult.dod;
    if (dod.items.length === 0) {
      return {
        decision: "block",
        reason: "DoD: empty typed Definition of Done at done-claim. Write at least one criterion before claiming done.",
      };
    }

    const pending = dod.items.flatMap((item, index) => {
      const evidenceMet = typeof item.evidence === "string" && item.evidence.trim().length > 0;
      return item.status === "met" && evidenceMet ? [] : [item.id ?? `item-${index + 1}`];
    });
    if (pending.length > 0) {
      return {
        decision: "block",
        reason: `DoD: ${pending.length} item(s) unmet or evidence-less: ${pending.join(", ")}. Close each typed item with non-empty evidence, or set a typed neutral pause state for an intentional pause. Override: touch .work-state/.dod-override`,
      };
    }
    return { continue: true };
  } finally {
    pinnedRoot.close();
  }
}
