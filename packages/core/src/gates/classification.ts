/**
 * Classification gate (P5). Replaces claude-plugin's `validate-state.sh`
 * PreToolUse(Task) hook.
 *
 * Blocks subagent launches when `.work-state/team-state.json` lacks a
 * classification, or when the resolved `workflow` does not match the
 * Type x Complexity -> Workflow table.
 *
 * Wired to `before_agent_start` so the engine catches it before the agent
 * executes.
 *
 * Gracefully degrades:
 *   - no JSON state    -> allow (legacy flow)
 *   - parse error      -> allow (transient write)
 *   - intentional override (`workflow_override: true`) -> allow
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { resolveWorkflow } from "../engine/profile.js";
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
  // Other tools (e2e, observability, CTO) may use `.work-state/` without
  // running the team workflow. Only a workflow pointer arms this gate.
  const active = join(wsDir, ACTIVE_FEATURE);
  const legacy = join(wsDir, LEGACY_STATE);
  if (!existsSync(active) && !existsSync(legacy)) return;
  if (!resolveStatePath(ctx.cwd)) {
    return {
      block: true,
      reason: "BLOCK (P5): classification state is missing. Complete PHASE 0, write .work-state/team-state.json, then launch agents.",
    };
  }
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

  if (state.workflow_override === true) return;

  const type = c.type as TaskType;
  const complexity = c.complexity as Complexity;
  const autonomous = state.autonomous === true;
  const expected = resolveWorkflow(type, complexity, autonomous);
  const actual = c.workflow;
  if (actual && actual !== expected) {
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
