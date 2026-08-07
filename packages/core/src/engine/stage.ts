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
 *
 * v0.7.0: stages that ship code (currently `implementation` and
 * `review_fixes`) go through the `validationGate` after the subagent
 * returns. A subagent that claims `ready: true` without `validation_run:
 * true` + non-empty `validation_evidence` is rejected with a precise
 * reason so the orchestrator re-spawns the developer instead of editing
 * the artifact. See `gates/validation.ts` for the full contract.
 */

import { execSync } from "node:child_process";
import { readArtifact } from "./artifacts.js";
import { resolveConfig } from "./config.js";
import { resolveScope, applyConditional, shouldSkip, type ScopeFlags } from "./scope.js";
import { checkArtifact as validationCheckArtifact, validationGate } from "../gates/validation.js";
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
/**
 * Minimum shape we depend on from the real OMP `TaskTool`. `TaskTool` is
 * exported from `@oh-my-pi/pi-coding-agent/task` but the surface is
 * intentionally not pulled into the engine module — the adapter is built at
 * the call site (see `packages/fullstack/commands/team/index.ts`). The
 * structural shape below is the only contract the engine depends on.
 */
export interface TaskToolLike {
	execute(
		toolCallId: string,
		params: Record<string, unknown>,
		signal?: AbortSignal,
		onUpdate?: (result: unknown) => void,
	): Promise<{ output: unknown }>;
}

/**
 * Spawn interface the engine actually consumes. Implemented by the OMP
 * adapter ({@link createTaskCaller}) and by test stubs. The shape mirrors the
 * wire schema `TaskTool` populates: flat single spawn (`{ name?, agent?, task }`)
 * and batch (`{ context, tasks[] }`) for parallel fan-out.
 */
export interface TaskCaller {
	/**
	 * Spawn a single subagent. Wire shape: `{ name?, agent, task, effort? }`.
	 */
	call(args: {
		agent: string;
		task: string;
		name?: string;
		effort?: "lo" | "med" | "hi";
	}): Promise<TaskResult>;

	/**
	 * Spawn N subagents in parallel. Wire shape: `{ context, tasks[] }`. Each
	 * item carries `{ name?, agent, task, effort? }`.
	 */
	batch(args: {
		context: string;
		tasks: Array<{
			name?: string;
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

/**
 * Validated single-spawn result. We only promise to read five fields;
 * anything else in the `TaskTool` output is ignored. Batch results arrive
 * as `{ results: SingleSpawnPayload[] }` at the top level; the caller
 * unpacks that separately.
 */
interface SingleSpawnPayload {
	id?: string;
	output?: string;
	artifacts?: Record<string, string>;
	exitCode?: number;
	error?: string;
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function readSingleSpawn(raw: unknown): SingleSpawnPayload {
	if (!isObject(raw)) return {};
	const id = typeof raw.id === "string" ? raw.id : undefined;
	const output = typeof raw.output === "string" ? raw.output : undefined;
	const exitCode = typeof raw.exitCode === "number" ? raw.exitCode : undefined;
	const error = typeof raw.error === "string" ? raw.error : undefined;
	let artifacts: Record<string, string> | undefined;
	if (isObject(raw.artifacts) && Object.values(raw.artifacts).every((v) => typeof v === "string")) {
		artifacts = Object.fromEntries(Object.entries(raw.artifacts)) as Record<string, string>;
	}
	return { id, output, artifacts, exitCode, error };
}

function extractResult(raw: { output: unknown }, newId: () => string): TaskResult {
	if (isObject(raw.output)) {
		const r = readSingleSpawn(raw.output);
		return {
			id: r.id ?? newId(),
			output: r.output ?? JSON.stringify(raw.output),
			artifacts: r.artifacts ?? {},
			exitCode: r.exitCode ?? 0,
			error: r.error,
		};
	}
	return {
		id: newId(),
		output: typeof raw.output === "string" ? raw.output : "",
		artifacts: {},
		exitCode: 0,
	};
}

/**
 * Build a {@link TaskCaller} that delegates to a real OMP {@link TaskToolLike}.
 * Kept in `core` so the engine can drive workflows through the native `task`
 * tool without re-implementing wire framing, output handling, or worktree
 * isolation. Use from a custom-TS command, an extension, or a test scaffold.
 */
export function createTaskCaller(tool: TaskToolLike): TaskCaller {
	let nextId = 0;
	const newId = (): string => `task-${Date.now().toString(36)}-${(nextId++).toString(36)}`;

	return {
		async call(args) {
			const params: Record<string, unknown> = {
				agent: args.agent,
				task: args.task,
			};
			if (args.name) params.name = args.name;
			if (args.effort) params.effort = args.effort;
			const result = await tool.execute(newId(), params);
			return extractResult(result, newId);
		},
		async batch(args) {
			const params: Record<string, unknown> = {
				context: args.context,
				tasks: args.tasks.map((t) => {
					const item: Record<string, unknown> = { agent: t.agent, task: t.task };
					if (t.name) item.name = t.name;
					if (t.effort) item.effort = t.effort;
					return item;
				}),
			};
			const result = await tool.execute(newId(), params);
			const root = isObject(result.output) ? result.output : {};
			const results = Array.isArray(root.results) ? root.results : [];
			return results.map((r) => extractResult({ output: r }, newId));
		},
	};
}

/**
 * Compute a stable wire name for a single subagent (used as default `name:`
 * when the caller doesn't supply one). Mirrors OMP's `oneLineLabel` rules so
 * the rendered spawn roster is readable.
 */
export function spawnLabel(role: string, stageId: string, cwd: string): string {
	return `${stageId}-${role}`;
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

  if (result.exitCode !== 0) {
    return {
      stageId: stage.id,
      status: "failed",
      note: result.error ?? `${agent} returned exit ${result.exitCode}`,
      artifacts: produces,
    };
  }
  return validateProduced(stage, ctx, produces, `${agent} returned exit 0`);
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
  if (failed.length > 0) {
    return {
      stageId: stage.id,
      status: "failed",
      note: `${failed.length}/${tasks.length} failed`,
      artifacts: produces,
    };
  }
  return validateProduced(
    stage,
    ctx,
    produces,
    `${tasks.length} agents in parallel`,
  );
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

/**
 * Inspect produced artifacts for the stage and run the validation gate
 * when the stage is in the validation-required list. Returns `done` when
 * the gate passes or when the stage is not in the list; `failed` with the
 * gate's reason otherwise.
 *
 * The gate is what prevents the failure mode from session 019fbd62:
 * a subagent that returns `ready: true, validation_run: false` is
 * rejected with a clear, actionable reason that the orchestrator can
 * read and re-spawn with.
 */
function validateProduced(
  stage: StageDef,
  ctx: StageContext,
  produces: string[],
  successNote: string,
): StageOutcome {
  // The gate is keyed on the *produces* list, not the stage id, so a
  // test or a custom profile that reuses the "implementation" id for a
  // non-code stage (no produces) is not penalised. The semantic
  // invariant is: a stage that produces a code-bearing artifact
  // (`implementation` or `review_fixes`) MUST include validation
  // evidence; everything else is unconstrained.
  const validatedIds = new Set(["implementation", "review_fixes"]);
  const gated = produces.filter((p) => validatedIds.has(p));
  if (gated.length === 0) {
    return { stageId: stage.id, status: "done", note: successNote, artifacts: produces };
  }
  for (const id of gated) {
    const data = readArtifact(ctx.artifactsDir, id);
    if (!data) {
      return {
        stageId: stage.id,
        status: "failed",
        note: `produced artifact "${id}.json" not found at ${ctx.artifactsDir}/${id}.json — subagent claimed done without writing its artifact. Re-spawn.`,
        artifacts: produces,
      };
    }
    const result = validationCheckArtifact(id, data as Record<string, unknown>);
    if (!result.ok) {
      ctx.log(`  validation: REJECTED for ${id} — ${result.reason}`);
      return {
        stageId: stage.id,
        status: "failed",
        note: result.reason,
        artifacts: produces,
      };
    }
  }
  ctx.log(`  validation: PASSED for ${stage.id}`);
  return { stageId: stage.id, status: "done", note: successNote, artifacts: produces };
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
  const roleHint = isOrchestratorRole(role)
    ? "You are a DISPATCHER and INTEGRATOR, not a coder. Spawn subagents for any code work, read their artifacts, decide whether to proceed. Do NOT edit code yourself — if a subagent's output is wrong, re-spawn with a sharper task; do not patch their artifact. Trust their validation evidence; do not second-guess build/test output by re-running it."
    : "You are an EXECUTOR, not a router. Gather your own context. Do not delegate to other agents unless you spawn them yourself. If your stage produces code, you MUST run the project's build + tests + linter yourself and include the verbatim output in the artifact's `validation_evidence` field, with `validation_run: true`. The engine will reject the handoff otherwise. Do not invent escape hatches like 'orchestrator owns validation' — that contract does not exist.";
  return `## Stage: ${stage.id} — ${stage.title}
${stage.description ?? ""}

Branch: ${ctx.state.branch}
Classification: ${ctx.state.classification.type}/${ctx.state.classification.complexity} (workflow=${ctx.state.classification.workflow})
Workflow role: ${role}

${roleHint}

### Task
${ctx.state.task}

### Your job
Execute this stage. Write your typed artifact to .work-state/artifacts/<id>.json matching the engine's schema (the engine reads only JSON, not prose).

Produces: ${produces}${readsBlock}

### Rule
${roleHint}
`;
}

function isOrchestratorRole(role: string): boolean {
  // Orchestrator roles are the ones the engine marks as "inline" — they
  // Discovery is a read-only dispatcher; all other orchestration belongs to CTO.
  return role === "discovery";
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

// Re-export so consumers can read the validation gate cheaply.
export { validationGate };
