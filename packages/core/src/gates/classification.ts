/**
 * Classification gate (P5). Replaces claude-plugin's `validate-state.sh`
 * PreToolUse(Task) hook.
 *
 * Blocks task launches for a selected canonical workflow run when
 * classification is missing or malformed, when `classification.autonomous`
 * is missing or non-boolean (fail closed — no silent default), or when the
 * resolved `workflow` does not match the Type x Complexity -> Workflow
 * table. The autonomous flag is routing/migration input only:
 * `classification.autonomous` is preferred for the legacy matrix and the
 * top-level `autonomous` field is read only for old state files. Neither
 * field grants checkpoint permission; typed policy-bound decisions do.
 *
 * Wired to `before_agent_start` so the engine catches it before the agent
 * executes.
 *
 * Outside a selected workflow run, the gate preserves the host's existing
 * no-active-workflow behavior and does not inspect legacy root state.
 */

import { isRegisteredWorkflow, loadProfile, matchesProfile, resolveWorkflow } from "../engine/profile.js";
import { resolveActiveBranch, resolveCanonicalRun, type ResolvedCanonicalRun } from "../engine/state.js";
import { monotonicGate } from "./monotonic.js";
import { checkpointPolicyLegacyConflict } from "../engine/workflow-contract.js";
import { validateTypedControlPlane } from "../engine/workflow-contract.js";
import type { Classification, Complexity, TaskType, CheckpointPolicy, TeamState } from "../engine/types.js";

interface AgentStartEvent {
  /** Optional agent type/name. */
  agent?: string;
}

interface AgentStartContext {
  cwd: string;
  run_id?: string;
}

interface ToolCallEvent {
  toolName: string;
}

/**
 * Enforce the zero-step contract at the task boundary for a selected workflow
 * run. Projects without a selected run retain legacy behavior.
 */
export function classificationToolGate(event: ToolCallEvent, ctx: AgentStartContext): { block?: boolean; reason?: string } | void {
  if (event.toolName !== "task") return;
  if (!ctx.run_id) return;
  const classification = classificationGate(event as unknown as AgentStartEvent, ctx);
  if (classification?.block) return classification;
  return monotonicGate(event, ctx);
}

type SelectedStateResolution =
  | { state: TeamState }
  | { block: true; reason: string };

function resolveSelectedState(ctx: AgentStartContext): SelectedStateResolution | null {
  const runId = ctx.run_id;
  if (!runId) return null;
  let resolved: ResolvedCanonicalRun | null;
  try {
    resolved = resolveCanonicalRun(ctx.cwd, { kind: "team", runId }, resolveActiveBranch(ctx.cwd));
  } catch {
    return {
      block: true,
      reason: "BLOCK (P5): selected canonical workflow run is invalid, unreadable, malformed, or outside its trusted state tree.",
    };
  }
  if (!resolved || !resolved.state) {
    return { block: true, reason: "BLOCK (P5): selected canonical workflow run is missing." };
  }
  if (resolved.isStale) {
    return { block: true, reason: "BLOCK (P5): selected canonical workflow run is stale for the active branch." };
  }
  if (resolved.state.schema !== 2 || resolved.state.run_id !== runId || resolved.state.run_key !== runId) {
    return { block: true, reason: "BLOCK (P5): selected canonical workflow run identity is invalid." };
  }
  return { state: resolved.state };
}

export function classificationGate(event: AgentStartEvent, ctx: AgentStartContext): { block?: boolean; reason?: string } | void {
  const selected = resolveSelectedState(ctx);
  if (!selected) return;
  if ("block" in selected) return selected;
  const state = selected.state;

  // Typed control-plane validation is deliberately first. Legacy autonomy
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
    return { block: true, reason: "BLOCK (P5): missing classification. Run workflow_prepare for the selected canonical run before launching agents." };
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
      reason: `BLOCK (P5): workflow '${actual}' does not match classification (type=${type} complexity=${complexity} autonomous=${autonomous} -> expected '${expected}'). Fix the classification in the selected canonical run, or set workflow_override: true.`,
    };
  }
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
