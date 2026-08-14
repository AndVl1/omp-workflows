/**
 * Classification gate (P5). Replaces claude-plugin's `validate-state.sh`
 * PreToolUse(Task) hook.
 *
 * Blocks subagent launches when `.work-state/team-state.json` lacks a
 * classification, when `classification.autonomous` is missing or non-boolean
 * (fail closed — no silent default), or when the resolved `workflow` does
 * not match the Type x Complexity -> Workflow table. The autonomous flag
 * comes from `classification.autonomous` (the model decision); the legacy
 * top-level `autonomous` field is read only as read-compatibility for old
 * state files and can never override a present model field.
 *
 * Wired to `before_agent_start` so the engine catches it before the agent
 * executes.
 *
 * Gracefully degrades:
 *   - no JSON state    -> allow (legacy flow)
 *   - parse error      -> allow (transient write)
 *   - intentional override (`workflow_override: true`) -> allow, but ONLY
 *     after the model autonomy field validates: missing or non-boolean
 *     `classification.autonomous` still blocks — an explicit override can
 *     skip the workflow-mismatch check, never the fail-closed autonomy gate.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { isRegisteredWorkflow, matchesProfile, resolveWorkflow } from "../engine/profile.js";
import { monotonicGate } from "./monotonic.js";
import type { Classification, Complexity, TaskType } from "../engine/types.js";

const WORK_STATE_DIR = ".work-state";
const ACTIVE_FEATURE = ".active-feature";
const LEGACY_STATE = "team-state.json";
interface AgentStartEvent {
  /** Optional agent type/name. */
  agent?: string;
}

interface AgentStartContext {
  cwd: string;
}

interface ToolCallEvent {
  toolName: string;
}

/**
 * Enforce the zero-step contract at the task boundary. A workflow run that
 * has initialized `.work-state/` must persist classification before spawning
 * any subagent. Projects without workflow state retain legacy behavior.
 */
export function classificationToolGate(event: ToolCallEvent, ctx: AgentStartContext): { block?: boolean; reason?: string } | void {
  if (event.toolName !== "task") return;
  const wsDir = resolve(ctx.cwd, WORK_STATE_DIR);
  if (!existsSync(wsDir)) return;
  // Other tools may use `.work-state/` without running the team workflow.
  const active = join(wsDir, ACTIVE_FEATURE);
  const legacy = join(wsDir, LEGACY_STATE);
  if (!existsSync(active) && !existsSync(legacy)) return;
  if (!resolveStatePath(ctx.cwd)) {
    return { block: true, reason: "BLOCK (P5): classification state is missing. Complete PHASE 0, write .work-state/team-state.json, then launch agents." };
  }
  // The complete classification contract is enforced pre-execution. The
  // before_agent_start hook remains a reminder only (OMP cannot block there).
  const classification = classificationGate(event as unknown as AgentStartEvent, ctx);
  if (classification?.block) return classification;
  return monotonicGate(event, ctx);
}
export function classificationGate(event: AgentStartEvent, ctx: AgentStartContext): { block?: boolean; reason?: string } | void {
  const statePath = resolveStatePath(ctx.cwd);
  if (!statePath) return;

  let raw: string;
  try {
    raw = readFileSync(statePath, "utf8");
  } catch {
    return;
  }
  let state: { classification?: Partial<Classification>; autonomous?: boolean; workflow_override?: boolean };
  try {
    state = JSON.parse(raw) as typeof state;
  } catch {
    return;
  }

  const c = state.classification;
  if (!c?.type || !c?.complexity) {
    return { block: true, reason: "BLOCK (P5): missing classification. Run /team so a CLASSIFICATION block is written to .work-state/team-state.json before launching agents." };
  }

  // Fail-closed autonomy validation runs BEFORE the override escape hatch:
  // `workflow_override: true` may skip the workflow-mismatch check below, but
  // it must NEVER bypass a missing or non-boolean model autonomy field. The
  // model decision is the only authority and no silent default applies.
  const autonomous = resolveAutonomous(state);
  if (autonomous === undefined) return { block: true, reason: autonomousBlockReason(state) };

  if (state.workflow_override === true) return;

  const type = c.type as TaskType;
  const complexity = c.complexity as Complexity;
  const expected = resolveWorkflow(type, complexity, autonomous);
  const actual = c.workflow;
  if (actual && actual !== expected) {
    // Non-autonomous runs may pick a different registered profile whose match
    // table accepts this classification (intentional override). Autonomous
    // runs resolve through the MODEL classification field (e.g. BUG_FIX ->
    // debug-cycle) and may NOT be silently downgraded to the interactive
    // counterpart via the profile-match escape hatch.
    if (!autonomous && isRegisteredWorkflow(actual) && matchesProfile(actual, { type, complexity })) return;
    return {
      block: true,
      reason: `BLOCK (P5): workflow '${actual}' does not match classification (type=${type} complexity=${complexity} autonomous=${autonomous} -> expected '${expected}'). Fix the workflow in team-state.json, or set workflow_override: true.`,
    };
  }
}

function resolveStatePath(cwd: string): string | null {
  const wsDir = resolve(cwd, WORK_STATE_DIR);
  if (!existsSync(wsDir)) return null;
  const active = join(wsDir, ".active-feature");
  if (existsSync(active)) {
    const slug = readFileSync(active, "utf8").trim();
    if (slug) {
      const path = join(wsDir, "features", slug, "state.json");
      if (existsSync(path)) return path;
    }
  }
  const legacy = join(wsDir, "team-state.json");
  if (existsSync(legacy)) return legacy;
  return null;
}

/**
 * Resolve the autonomous flag for the P5 gate, fail-closed:
 * - `classification.autonomous` is the MODEL decision — the only authority.
 *   A present non-boolean value BLOCKS (never silently replaced).
 * - Absent classification field falls back to the legacy top-level
 *   `TeamState.autonomous` ONLY for old state files (read compatibility).
 * - Neither present -> BLOCK: no silent true/false default for a task.
 */
function resolveAutonomous(state: {
  classification?: Partial<Classification>;
  autonomous?: boolean;
}): boolean | undefined {
  const modelAutonomous = state.classification?.autonomous;
  if (modelAutonomous !== undefined) {
    return typeof modelAutonomous === "boolean" ? modelAutonomous : undefined;
  }
  if (typeof state.autonomous === "boolean") return state.autonomous;
  return undefined;
}

function autonomousBlockReason(state: {
  classification?: Partial<Classification>;
  autonomous?: boolean;
}): string {
  const modelAutonomous = state.classification?.autonomous;
  if (modelAutonomous !== undefined) {
    return `BLOCK (P5): classification.autonomous must be a boolean, got ${JSON.stringify(modelAutonomous)}. Fail closed — the model decision is invalid and no silent default applies.`;
  }
  return "BLOCK (P5): classification.autonomous is missing. PHASE-0 must decide `autonomous: true | false`; no silent default and no workflow can be resolved without it.";
}
