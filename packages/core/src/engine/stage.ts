/**
 * Stage dispatcher. Walks a profile's stages in order; for each stage picks
 * the right execution strategy by `type`:
 *
 *   - `orchestrator` -> inline prompt (orientation only, not investigation)
 *   - `single`       -> one `task` call with the resolved agent
 *   - `consilium`    -> parallel `task` calls in one batch (one per role)
 *   - `bash`         -> deterministic shell step
 *   - `none`         -> skip
 *
 * The orchestrator hands every `task` call its `consumes` artifact content;
 * the agent gathers its own context outside this layer.
 */

import { execSync } from "node:child_process";
import { readArtifact } from "./artifacts.js";
import { resolveConfig } from "./config.js";
import { resolveScope, applyConditional, shouldSkip, type ScopeFlags } from "./scope.js";
import type { Profile, StageDef, TeamState } from "./types.js";

export interface StageContext {
  cwd: string;
  state: TeamState;
  artifactsDir: string;
  flags: ScopeFlags;
  agent: (role: string) => string;
  /** Run a single task subagent. The engine owns the `task` tool reference. */
  task: TaskCaller;
  /** Pause for /user input. Used by `checkpoint` stages. */
  pause: (reason: string) => Promise<void>;
  /** Append a log line to the human mirror. */
  log: (line: string) => void;
  /** Resolve ${scope.dev_agent} -> string. */
  resolveDevAgent: () => string | null;
}

export interface TaskCaller {
  /**
   * Spawn a single subagent. Returns when the agent yields.
   * `task.batch` is also exposed via `batch()`.
   */
  call(opts: {
    agent: string;
    task: string;
    effort?: "lo" | "med" | "hi";
    isolated?: boolean;
  }): Promise<TaskResult>;

  /** Spawn N agents in parallel via task.batch. */
  batch(opts: {
    context: string;
    tasks: Array<{
      name: string;
      agent: string;
      task: string;
      effort?: "lo" | "med" | "hi";
    }>;
  }): Promise<TaskResult[]>;
}

export interface TaskResult {
  id: string;
  output: string;
  artifacts: Record<string, string>;
  exitCode: number;
  error?: string;
}

export interface StageOutcome {
  stageId: string;
  status: "done" | "skipped" | "failed";
  note: string;
  artifacts: string[];
  loopIteration?: number;
}

export async function runStage(
  stage: StageDef,
  ctx: StageContext,
): Promise<StageOutcome> {
  if (shouldSkip(stage, ctx.flags)) {
    ctx.log(`stage ${stage.id}: skipped by skip_if`);
    return { stageId: stage.id, status: "skipped", note: "skipped by skip_if", artifacts: [] };
  }

  ctx.log(`stage ${stage.id}: ${stage.title}`);

  const produces = Array.isArray(stage.produces) ? stage.produces : stage.produces ? [stage.produces] : [];

  switch (stage.type) {
    case "orchestrator":
      return runOrchestrator(stage, ctx, produces);
    case "single":
      return runSingle(stage, ctx, produces);
    case "consilium":
      return runConsilium(stage, ctx, produces);
    case "bash":
      return runBash(stage, ctx, produces);
    case "none":
      return { stageId: stage.id, status: "done", note: "no-op stage", artifacts: [] };
    default:
      return { stageId: stage.id, status: "failed", note: `unknown stage type: ${stage.type}`, artifacts: [] };
  }
}

async function runOrchestrator(stage: StageDef, ctx: StageContext, produces: string[]): Promise<StageOutcome> {
  // The orchestrator stage is INLINE — orientation only. The model itself reads
  // consumes / writes produces (or returns guidance to the parent).
  ctx.log(`  orchestrator: ${stage.produces?.toString() ?? "none"}`);
  return {
    stageId: stage.id,
    status: "done",
    note: "orchestrator stage (inline)",
    artifacts: produces,
  };
}

async function runSingle(stage: StageDef, ctx: StageContext, produces: string[]): Promise<StageOutcome> {
  const role = stage.role ? expandRole(stage.role, ctx) : "";
  if (!role) {
    return { stageId: stage.id, status: "failed", note: "single stage missing role", artifacts: [] };
  }
  const agent = ctx.agent(role);
  const task = buildStagePrompt(stage, ctx, role);

  ctx.log(`  single: ${agent} (role=${role})`);
  const result = await ctx.task.call({ agent, task });

  return {
    stageId: stage.id,
    status: result.exitCode === 0 ? "done" : "failed",
    note: result.error ?? `${agent} returned exit ${result.exitCode}`,
    artifacts: produces,
  };
}

async function runConsilium(stage: StageDef, ctx: StageContext, produces: string[]): Promise<StageOutcome> {
  const baseRoles = stage.roles ?? [];
  const roster = applyConditional(baseRoles, stage.conditional, ctx.flags);
  const overridden = applyRosterOverrides(roster, ctx.cwd, stage.id);

  ctx.log(`  consilium: ${overridden.join(", ")}`);

  const tasks = overridden.map((role) => ({
    name: `${stage.id}-${role}`,
    agent: ctx.agent(role),
    task: buildStagePrompt(stage, ctx, role),
  }));

  const results = await ctx.task.batch({
    context: `Parallel agents for stage "${stage.id}" (${stage.title}). Each of you gathers its own context.`,
    tasks,
  });

  const failed = results.filter((r) => r.exitCode !== 0);
  return {
    stageId: stage.id,
    status: failed.length === 0 ? "done" : "failed",
    note: failed.length === 0 ? `${tasks.length} agents in parallel` : `${failed.length}/${tasks.length} failed`,
    artifacts: produces,
  };
}

async function runBash(stage: StageDef, ctx: StageContext, produces: string[]): Promise<StageOutcome> {
  // The stage's task field may describe a command; for now we infer a single
  // command from the task id (e.g. "install_hooks"). User-driven stages use
  // a custom `command:` field embedded in the stage.
  const cmd = (stage as unknown as { command?: string }).command;
  if (!cmd) {
    return { stageId: stage.id, status: "failed", note: "bash stage missing command", artifacts: [] };
  }
  try {
    execSync(cmd, { cwd: ctx.cwd, stdio: "inherit" });
    return { stageId: stage.id, status: "done", note: cmd, artifacts: produces };
  } catch (e) {
    return { stageId: stage.id, status: "failed", note: String(e), artifacts: produces };
  }
}

function buildStagePrompt(stage: StageDef, ctx: StageContext, role: string): string {
  const consumes = stage.consumes ?? [];
  const reads = consumes
    .map((id) => {
      const data = readArtifact(ctx.artifactsDir, id);
      return data ? `### ${id}\n\`\`\`json\n${JSON.stringify(data, null, 2)}\n\`\`\`` : null;
    })
    .filter((x): x is string => x !== null);

  const readsBlock = reads.length > 0 ? `\n\n## Reads from prior stages\n${reads.join("\n\n")}` : "";
  const produces = Array.isArray(stage.produces) ? stage.produces.join(", ") : stage.produces ?? "(none)";
  return `## Stage: ${stage.id} — ${stage.title}
${stage.description ?? ""}

Branch: ${ctx.state.branch}
Classification: ${ctx.state.classification.type}/${ctx.state.classification.complexity} (workflow=${ctx.state.classification.workflow})
Workflow role: ${role}

Follow the responsibility and perspective of this workflow role. For named variants such as architect_minimal, architect_clean, and architect_pragmatic, make that variant the explicit design focus.

### Task
${ctx.state.task}

### Your job
Execute this stage. Write your typed artifact to .work-state/artifacts/<id>.json matching the engine's schema (the engine reads only JSON, not prose).

Produces: ${produces}${readsBlock}

### Rule
You are an EXECUTOR, not a router. Gather your own context. Do not delegate to other agents unless you spawn them yourself.
`;
}

function expandRole(role: string, ctx: StageContext): string {
  if (role === "${scope.dev_agent}") return ctx.resolveDevAgent() ?? "developer-kotlin";
  return role;
}

function applyRosterOverrides(roster: string[], cwd: string, stageId: string): string[] {
  const config = resolveConfig(cwd);
  const override = config.roster_overrides[stageId];
  if (!override) return roster;
  if (override.replace) return override.replace;
  const result = new Set(roster);
  for (const r of override.add ?? []) result.add(r);
  for (const r of override.remove ?? []) result.delete(r);
  return Array.from(result);
}

/**
 * Walk the profile to completion. The principal output of running a `/team`.
 */
export async function walkProfile(
  profile: Profile,
  ctx: StageContext,
): Promise<StageOutcome[]> {
  const outcomes: StageOutcome[] = [];
  for (const stage of profile.stages) {
    const outcome = await runStage(stage, ctx);
    outcomes.push(outcome);
    if (outcome.status === "failed") {
      ctx.log(`halting at stage ${stage.id}`);
      break;
    }
    if (stage.loop) {
      const iterations = await runLoop(stage, ctx);
      outcomes.push(...iterations);
    }
  }
  return outcomes;
}

async function runLoop(stage: StageDef, ctx: StageContext): Promise<StageOutcome[]> {
  const outcomes: StageOutcome[] = [];
  for (let i = 0; i < stage.loop!.max_iterations; i++) {
    const verdict = readArtifact(ctx.artifactsDir, "debug");
    if (verdict && typeof verdict === "object" && "verdict" in verdict && (verdict as { verdict?: unknown }).verdict === "PASS") {
      ctx.log(`loop done at iteration ${i + 1}`);
      break;
    }
    ctx.log(`loop iteration ${i + 1} -> ${stage.loop!.back_to}`);
    // Caller re-runs the back_to stage itself; this just records the loop.
    outcomes.push({ stageId: stage.id, status: "done", note: `loop iteration ${i + 1}`, artifacts: [], loopIteration: i + 1 });
  }
  return outcomes;
}
