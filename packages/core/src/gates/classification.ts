/**
 * Classification gate (P5). Replaces claude-plugin's `validate-state.sh`
 * PreToolUse(Task) hook.
 *
 * Blocks subagent launches when `.work-state/team-state.json` lacks a
 * classification, when `classification.autonomous` is missing or non-boolean
 * (fail closed — no silent default), or when the resolved `workflow` does
 * not match the Type x Complexity -> Workflow table. The autonomous flag is
 * routing/migration input only: `classification.autonomous` is preferred for
 * the legacy matrix and the top-level `autonomous` field is read only for old
 * state files. Neither field grants checkpoint permission; typed policy-bound
 * decisions do.
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
import { isRegisteredWorkflow, loadProfile, matchesProfile, resolveWorkflow } from "../engine/profile.js";
import { monotonicGate } from "./monotonic.js";
import { isSafeStateSegment, resolveState } from "../engine/state.js";
import { checkpointPolicyLegacyConflict } from "../engine/workflow-contract.js";
import { validateTypedControlPlane } from "../engine/workflow-contract.js";
import type { Classification, Complexity, TaskType, CheckpointPolicy } from "../engine/types.js";

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
  const active = join(wsDir, ACTIVE_FEATURE);
  const legacy = join(wsDir, LEGACY_STATE);
  if (!existsSync(active) && !existsSync(legacy)) return;
  if (resolveState(ctx.cwd).invalid) {
    return { block: true, reason: "BLOCK (P5): workflow state is malformed or unsafe; refusing task launch." };
  }
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
  let state: {
    classification?: Partial<Classification>;
    autonomous?: boolean;
    workflow_override?: boolean;
    stage_cursor?: string;
    checkpoint_policy?: CheckpointPolicy;
  };
  try {
    state = JSON.parse(raw) as typeof state;
  } catch {
    return;
  }

  // Typed control-plane validation is deliberately first.  Legacy autonomy
  // cannot rescue malformed/unknown typed policy, intent, or decisions.
  const stateTyped = validateTypedControlPlane(state);
  const stateIssues = stateTyped.ok
    ? []
    : stateTyped.issues.filter((issue) => !(
      state.checkpoint_policy?.source === "migration"
      && issue.path.endsWith(".allowed_decisions")
      && issue.message.includes("must not be empty")
    ));
  if (stateIssues.length > 0) {
    return {
      block: true,
      reason: `BLOCK (P5): policy_invalid — typed control-plane fields are malformed: ${stateIssues.map((issue) => `${issue.path} ${issue.message}`).join("; ")}`,
    };
  }
  const classificationValue = state.classification as unknown;
  if (classificationValue !== undefined) {
    const classificationTyped = validateTypedControlPlane(classificationValue);
    if (!classificationTyped.ok) {
      return {
        block: true,
        reason: `BLOCK (P5): policy_invalid — typed classification fields are malformed: ${classificationTyped.issues.map((issue) => `${issue.path} ${issue.message}`).join("; ")}`,
      };
    }
  }

  const c = state.classification;
  if (!c?.type || !c?.complexity) {
    return { block: true, reason: "BLOCK (P5): missing classification. Run /team so a CLASSIFICATION block is written to .work-state/team-state.json before launching agents." };
  }

  // Resolve policy and floor before the workflow override escape hatch.  An
  // override may select a registered profile; it cannot invent permission or
  // downgrade a hard-human rule.
  const workflow = typeof c.workflow === "string" ? c.workflow : undefined;
  const profile = workflow ? loadProfile(workflow) : undefined;
  const stage = profile?.stages.find((candidate) => candidate.id === state.stage_cursor);
  const policy = state.checkpoint_policy ?? stage?.checkpoint_policy ?? profile?.checkpoint_policy;
  if (stage?.checkpoint) {
    if (!policy) {
      return { block: true, reason: `BLOCK (P5): policy_invalid — declared checkpoint '${stage.checkpoint}' has no typed checkpoint policy.` };
    }
    const rule = policy.rules[stage.checkpoint];
    if (!rule) {
      return { block: true, reason: `BLOCK (P5): policy_invalid — checkpoint policy has no rule for '${stage.checkpoint}'.` };
    }
    const floorKinds: Record<string, true> = {
      product_approval: true,
      security: true,
      destructive_side_effect: true,
      production: true,
      bundle_activation: true,
      migration_cutover: true,
    };
    const floor = floorKinds[rule.kind] === true || policy.hard_human.includes(rule.kind);
    if (floor && (policy.default === "autonomous_allowed" || rule.default === "autonomous_allowed")) {
      return { block: true, reason: `BLOCK (P5): policy_invalid — hard-human checkpoint '${stage.checkpoint}' cannot permit policy_auto.` };
    }
  }

  // Fail-closed autonomy validation remains required during the migration
  // window because it still routes the legacy profile matrix.  It never grants
  // checkpoint permission.
  const autonomous = resolveAutonomous(state);
  if (autonomous === undefined) return { block: true, reason: autonomousBlockReason(state) };
  if (policy) {
    const conflict = checkpointPolicyLegacyConflict(policy, autonomous);
    if (conflict) return { block: true, reason: `BLOCK (P5): migration_conflict — ${conflict}` };
  }

  if (state.workflow_override === true) return;

  const type = c.type as TaskType;
  const complexity = c.complexity as Complexity;
  const expected = resolveWorkflow(type, complexity, autonomous);
  const actual = c.workflow;
  if (actual && actual !== expected) {
    // Non-autonomous runs may pick a different registered profile whose match
    // table accepts this classification (intentional override). Autonomous
    // runs resolve through the MODEL routing field and may not be downgraded.
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
    if (isSafeStateSegment(slug)) {
      const path = join(wsDir, "features", slug, "state.json");
      if (existsSync(path)) return path;
    }
  }
  const legacy = join(wsDir, "team-state.json");
  if (existsSync(legacy)) return legacy;
  return null;
}

/**
 * Resolve the routing/migration autonomy input for the P5 gate, fail-closed:
 * - `classification.autonomous` is preferred for the legacy routing matrix.
 *   A present non-boolean value BLOCKS (never silently replaced).
 * - An absent classification field falls back to the legacy top-level
 *   `TeamState.autonomous` ONLY for old state files (read compatibility).
 * - Neither present -> BLOCK: no silent true/false default for a task.
 *
 * The result never authorizes a checkpoint; typed policy/provenance does.
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
