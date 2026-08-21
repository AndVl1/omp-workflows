/**
 * Stage dispatcher. Walks a profile's stages in order; for each stage picks
 * the right execution strategy by `type`:
 *
 *   - `orchestrator` -> inline prompt (orientation only, not investigation)
 *   - `single`       -> one `task` call with the resolved agent
 *   - `consilium`    -> parallel `task` calls in one batch (one per role)
 *   - `document`     -> deterministic engine-rendered document (no agent)
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

import { buildDispatchMarker } from "../gates/dispatch.js";
import { execSync } from "node:child_process";
import { dirname } from "node:path";
import { persistReturnedArtifacts, readArtifact, writeArtifact } from "./artifacts.js";
import { resolveConfig } from "./config.js";
import { resolveScope, applyConditional, type ScopeFlags } from "./scope.js";
import { evaluatePredicate } from "./predicate.js";
import { namespacedArtifactId, sanitizeSlot } from "./fan-in.js";
import { PRD_SOURCE_ARTIFACT_IDS, validateProductPrdDocument, writeProductPrdDocument } from "./product-prd.js";
import { checkArtifact as validationCheckArtifact, validationGate } from "../gates/validation.js";
import type { DispatchSlot, Profile, StageDef, TeamState } from "./types.js";

export interface StageContext {
  cwd: string;
  state: TeamState;
  artifactsDir: string;
  flags: ScopeFlags;
  agent: (role: string) => string;
  /** Run a single task subagent. The engine owns the `task` tool reference. */
  task: TaskCaller;
  pause: (reason: string) => Promise<void>;
  log: (line: string) => void;
  resolveDevAgent: () => string | null;
  /** Let the owning main session execute an inline orchestrator stage. */
  orchestrate?: (args: {
    stage: StageDef;
    prompt: string;
    cwd: string;
    artifactsDir: string;
    state: TeamState;
  }) => Promise<OrchestratorResult | void> | OrchestratorResult | void;
  onStageStart?: (stageId: string) => void;
  onStageComplete?: (stageId: string, status: StageOutcome["status"]) => void;
  /** Present when strict durable execution is armed. */
  durable?: {
    authorize: (role: string, agent: string) => { ok: true; dispatchId: string } | { ok: false; error: string };
    complete: (dispatchId: string, output: string, outcome: "succeeded" | "failed", artifactIds?: string[]) => { ok: true } | { ok: false; error: string };
    advance: (evidence: string) => { ok: true; handoff?: { capability_id: string; dispatch_token: string; advance_token: string; cursor_epoch: string } } | { ok: false; error: string };
  };
}
/**
 * Minimum shape we depend on from the real OMP `TaskTool`. `TaskTool` is
 * exported from `@oh-my-pi/pi-coding-agent/task` but the surface is
 * intentionally not pulled into the engine module — the adapter is built at
 * the call site (see `packages/fullstack/commands/team/index.ts`). The
 * structural shape below is the only contract the engine depends on.
 */
export interface OrchestratorResult {
  output?: string;
  artifacts?: Record<string, unknown>;
}

export interface TaskToolLike {
  execute(
    toolCallId: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
    onUpdate?: (result: unknown) => void,
  ): Promise<{
    output?: unknown;
    content?: Array<{ type?: string; text?: string }>;
    details?: unknown;
  }>;
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
  pending?: boolean;
}

/**
 * Normalized task-tool payload. Native OMP results expose these fields under
 * `details.results`; the legacy adapter shape puts one payload under `output`.
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

function contentText(value: unknown): string {
  if (!isObject(value) || !Array.isArray(value.content)) return "";
  return value.content
    .map((part) => isObject(part) && typeof part.text === "string" ? part.text : "")
    .filter(Boolean)
    .join("\n");
}

function taskDetails(value: unknown): Record<string, unknown> | null {
  if (!isObject(value) || !isObject(value.details)) return null;
  return value.details;
}

function taskResultRows(value: unknown): unknown[] {
  const details = taskDetails(value);
  if (details && Array.isArray(details.results)) return details.results;
  if (isObject(value) && isObject(value.output) && Array.isArray(value.output.results)) {
    return value.output.results;
  }
  return [];
}

function taskIsPending(value: unknown): boolean {
  const asyncState = taskDetails(value)?.async;
  return isObject(asyncState) && asyncState.state === "running";
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

function extractPayload(raw: unknown, newId: () => string): TaskResult {
  const value = isObject(raw) && "output" in raw && !("id" in raw || "exitCode" in raw || "artifacts" in raw || "error" in raw)
    ? raw.output
    : raw;
  if (isObject(value)) {
    const r = readSingleSpawn(value);
    return {
      id: r.id ?? newId(),
      output: r.output ?? JSON.stringify(value),
      artifacts: r.artifacts ?? {},
      exitCode: r.exitCode ?? 0,
      error: r.error,
    };
  }
  return {
    id: newId(),
    output: typeof value === "string" ? value : "",
    artifacts: {},
    exitCode: 0,
  };
}

function extractResult(raw: unknown, newId: () => string): TaskResult {
  const rows = taskResultRows(raw);
  const result = extractPayload(rows[0] ?? raw, newId);
  if (taskIsPending(raw)) {
    return { ...result, pending: true, exitCode: 1, error: "task remains asynchronous" };
  }
  if (rows.length === 0 && result.output === "") {
    const text = contentText(raw);
    if (text) return { ...result, output: text };
  }
  return result;
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
			const results = taskResultRows(result);
			if (results.length > 0) return results.map((r) => extractPayload(r, newId));
			if (taskIsPending(result)) return [];
			return [];
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
  if (stage.skip_if) {
    // Fail closed: an expression we cannot evaluate (unsupported syntax or a
    // missing referenced artifact) blocks the stage instead of silently
    // skipping or silently running.
    const skip = evaluatePredicate(stage.skip_if, {
      flags: ctx.flags,
      artifactsDir: ctx.artifactsDir,
      state: ctx.state,
      stage,
    });
    if (!skip.ok) {
      return { stageId: stage.id, status: "failed", note: `skip_if evaluation failed: ${skip.error}`, artifacts: [] };
    }
    if (skip.value) {
      ctx.log(`stage ${stage.id}: skipped by skip_if`);
      return { stageId: stage.id, status: "skipped", note: "skipped by skip_if", artifacts: [] };
    }
  }

  ctx.log(`stage ${stage.id}: ${stage.title}`);
  ctx.onStageStart?.(stage.id);

  const produces = Array.isArray(stage.produces) ? stage.produces : stage.produces ? [stage.produces] : [];


  switch (stage.type) {
    case "orchestrator":
      return runOrchestrator(stage, ctx, produces);
    case "single":
      return runSingle(stage, ctx, produces);
    case "consilium":
      return runConsilium(stage, ctx, produces);
    case "document":
      return runProductPrdRender(stage, ctx, produces);
    case "bash":
      return runBash(stage, ctx, produces);
    case "none":
      return { stageId: stage.id, status: "done", note: "no-op stage", artifacts: [] };
    default:
      return { stageId: stage.id, status: "failed", note: `unknown stage type: ${stage.type}`, artifacts: [] };
  }
}

async function runOrchestrator(stage: StageDef, ctx: StageContext, produces: string[]): Promise<StageOutcome> {
  ctx.log(`  orchestrator: ${stage.produces?.toString() ?? "none"}`);
  if (ctx.orchestrate) {
    try {
      const result = await ctx.orchestrate({
        stage,
        prompt: buildStagePrompt(stage, ctx, "orchestrator"),
        cwd: ctx.cwd,
        artifactsDir: ctx.artifactsDir,
        state: ctx.state,
      });
      if (result?.artifacts) persistReturnedArtifacts(ctx.artifactsDir, result.artifacts);
      return validateProduced(stage, ctx, produces, result?.output?.trim() || "orchestrator stage completed");
    } catch (error) {
      return { stageId: stage.id, status: "failed", note: `orchestrator stage failed: ${String(error)}`, artifacts: produces };
    }
  }
  if (produces.length > 0) {
    return {
      stageId: stage.id,
      status: "failed",
      note: "orchestrator stage declares artifacts but no orchestrate callback is configured",
      artifacts: produces,
    };
  }
  return validateProduced(stage, ctx, [], "orchestrator stage (inline)");
}

function persistTaskArtifacts(ctx: StageContext, result: TaskResult): { ids: string[]; error?: string } {
  try {
    return { ids: persistReturnedArtifacts(ctx.artifactsDir, result.artifacts ?? {}) };
  } catch (error) {
    return { ids: [], error: String(error) };
  }
}
function failAuthorizedDispatches(
  ctx: StageContext,
  authorized: Array<{ ok: true; dispatchId: string } | { ok: false; error: string }>,
  evidence: string,
): void {
  if (!ctx.durable) return;
  for (const entry of authorized) {
    if (!entry.ok) continue;
    const completed = ctx.durable.complete(entry.dispatchId, evidence, "failed");
    if (!completed.ok) ctx.log(`  durable cleanup failed for ${entry.dispatchId}: ${completed.error}`);
  }
}

function taskEvidence(result: TaskResult, outcome: "succeeded" | "failed"): string {
  return result.output.trim() || result.error?.trim() || (outcome === "failed" ? "task failed" : "task completed");
}

async function runSingle(stage: StageDef, ctx: StageContext, produces: string[]): Promise<StageOutcome> {
  const slot = resolveStageDispatchSlots(stage, ctx)[0];
  if (!slot) return { stageId: stage.id, status: "failed", note: "single stage missing role", artifacts: [] };
  const agent = ctx.agent(slot.role);
  const task = buildStagePrompt(stage, ctx, slot.slot);
  ctx.log(`  single: ${agent} (slot=${slot.slot}, role=${slot.role})`);
  const authorized = ctx.durable?.authorize(slot.slot, agent);
  if (authorized && !authorized.ok) return { stageId: stage.id, status: "failed", note: `dispatch authorization failed: ${authorized.error}`, artifacts: produces };
  let result: TaskResult;
  try {
    result = await ctx.task.call({ agent, task });
  } catch (error) {
    if (authorized?.ok) failAuthorizedDispatches(ctx, [authorized], `task call failed: ${String(error)}`);
    return { stageId: stage.id, status: "failed", note: `${agent} task call failed: ${String(error)}`, artifacts: produces };
  }
  const persisted = persistTaskArtifacts(ctx, result);
  const outcome = result.exitCode === 0 && !result.pending && !persisted.error ? "succeeded" : "failed";
  if (authorized) {
    const completed = ctx.durable!.complete(authorized.dispatchId, taskEvidence(result, outcome), outcome, persisted.ids);
    if (!completed.ok) return { stageId: stage.id, status: "failed", note: `dispatch completion failed: ${completed.error}`, artifacts: produces };
  }
  if (persisted.error) return { stageId: stage.id, status: "failed", note: persisted.error, artifacts: produces };
  if (result.exitCode !== 0 || result.pending) return { stageId: stage.id, status: "failed", note: result.error ?? `${agent} returned exit ${result.exitCode}`, artifacts: produces };
  return validateProduced(stage, ctx, produces, `${agent} returned exit 0`);
}

/**
 * Executable `document` stage (shipped renderer: product-prd): the engine
 * itself — not an agent — renders the declared document from the stage's
 * declared sources and persists both the markdown document and the typed
 * artifact. Like bash stages this is deterministic engine work: no agent
 * dispatch and no durable dispatch records — the stage completes through
 * the normal produced-artifact validation and advance flow.
 */
async function runProductPrdRender(stage: StageDef, ctx: StageContext, produces: string[]): Promise<StageOutcome> {
  const contract = stage.document;
  if (!contract) {
    return { stageId: stage.id, status: "failed", note: "document stage is missing its document declaration", artifacts: produces };
  }
  if (contract.format !== "markdown") {
    return { stageId: stage.id, status: "failed", note: `unsupported document format: ${String(contract.format)}`, artifacts: produces };
  }
  if (contract.renderer !== "product-prd") {
    return { stageId: stage.id, status: "failed", note: `unsupported document renderer: ${String(contract.renderer)}`, artifacts: produces };
  }
  const sourceArtifacts: Record<string, unknown> = {};
  for (const id of PRD_SOURCE_ARTIFACT_IDS) {
    const artifact = readArtifact(ctx.artifactsDir, id);
    if (artifact === null) {
      return { stageId: stage.id, status: "failed", note: `product_prd render: source artifact '${id}.json' not found`, artifacts: produces };
    }
    sourceArtifacts[id] = artifact;
  }
  const written = writeProductPrdDocument({
    stateDir: dirname(ctx.artifactsDir),
    artifactsDir: ctx.artifactsDir,
    path: contract.path,
    sourceArtifacts,
  });
  if (!written.ok) {
    return { stageId: stage.id, status: "failed", note: `product_prd render failed: ${written.error}`, artifacts: produces };
  }
  // Fail closed on the freshly persisted pair: re-verify the exact manifest
  // shape, hash agreement, on-disk document bytes and source staleness
  // BEFORE the produced-artifact validation can mark the stage done.
  const pair = validateProductPrdDocument({ stateDir: dirname(ctx.artifactsDir), artifactsDir: ctx.artifactsDir });
  if (!pair.ok) {
    return { stageId: stage.id, status: "failed", note: `product_prd pair validation failed: ${pair.issues.join("; ")}`, artifacts: produces };
  }
  ctx.log(`  product_prd: deterministic render -> ${written.documentPath}`);
  return validateProduced(stage, ctx, produces, `deterministic product PRD rendered to ${written.documentPath}`);
}

async function runConsilium(stage: StageDef, ctx: StageContext, produces: string[]): Promise<StageOutcome> {
  const roster = resolveStageDispatchSlots(stage, ctx);
  if (roster.length === 0) return { stageId: stage.id, status: "failed", note: "consilium stage resolved to an empty roster", artifacts: produces };
  const multiSlot = roster.length > 1;
  ctx.log(`  consilium: ${roster.map((slot) => slot.slot).join(", ")}${multiSlot ? " (slot-scoped artifacts)" : ""}`);
  const tasks = roster.map((slot) => ({ name: `${stage.id}-${slot.slot}`, agent: ctx.agent(slot.role), task: buildStagePrompt(stage, ctx, slot.slot, multiSlot) }));
  const authorized = ctx.durable ? roster.map((slot, i) => ctx.durable!.authorize(slot.slot, tasks[i]!.agent)) : [];
  const denied = authorized.find((a) => !a.ok);
  if (denied && !denied.ok) {
    failAuthorizedDispatches(ctx, authorized, `dispatch authorization failed: ${denied.error}`);
    return { stageId: stage.id, status: "failed", note: `dispatch authorization failed: ${denied.error}`, artifacts: produces };
  }
  let results: TaskResult[];
  try {
    results = await ctx.task.batch({ context: `Parallel agents for stage "${stage.id}" (${stage.title}). Each of you gathers its own context.`, tasks });
  } catch (error) {
    failAuthorizedDispatches(ctx, authorized, `task batch failed: ${String(error)}`);
    return { stageId: stage.id, status: "failed", note: `task batch failed: ${String(error)}`, artifacts: produces };
  }
  if (results.length !== tasks.length) {
    failAuthorizedDispatches(ctx, authorized, `task batch returned ${results.length}/${tasks.length} results`);
    return { stageId: stage.id, status: "failed", note: `task batch returned ${results.length}/${tasks.length} results`, artifacts: produces };
  }
  for (let i = 0; i < results.length; i++) {
    const auth = authorized[i];
    if (auth?.ok) {
      const result = results[i]!;
      const slot = roster[i]!.slot;
      const persisted = multiSlot
        ? persistConsiliumSlotArtifacts(ctx, slot, result, produces)
        : persistTaskArtifacts(ctx, result);
      const outcome = result.exitCode === 0 && !result.pending && !persisted.error ? "succeeded" : "failed";
      const completed = ctx.durable!.complete(auth.dispatchId, taskEvidence(result, outcome), outcome, persisted.ids);
      if (!completed.ok) {
        failAuthorizedDispatches(ctx, authorized.slice(i), `dispatch completion failed: ${completed.error}`);
        return { stageId: stage.id, status: "failed", note: `dispatch completion failed: ${completed.error}`, artifacts: produces };
      }
      if (persisted.error) {
        failAuthorizedDispatches(ctx, authorized.slice(i + 1), persisted.error);
        return { stageId: stage.id, status: "failed", note: persisted.error, artifacts: produces };
      }
    }
  }
  const failed = results.filter((r) => r.exitCode !== 0 || r.pending);
  if (failed.length > 0) return { stageId: stage.id, status: "failed", note: `${failed.length}/${tasks.length} failed`, artifacts: produces };
  return validateProduced(stage, ctx, produces, `${tasks.length} agents in parallel`, multiSlot ? roster : undefined);
}

/**
 * Persist a consilium slot's returned artifacts and guarantee the
 * slot-scoped namespaced files (`<id>-<slot>.json`) exist for every declared
 * produce. When the slot returned the shared id, a namespaced copy is made
 * from its own just-written content, so later slots can never clobber this
 * slot's provenance. The namespaced ids are declared on the durable
 * completion so advance-time synthesis can read them deterministically.
 */
function persistConsiliumSlotArtifacts(
  ctx: StageContext,
  slot: string,
  result: TaskResult,
  produces: string[],
): { ids: string[]; error?: string } {
  const persisted = persistTaskArtifacts(ctx, result);
  if (persisted.error) return persisted;
  const ids = [...persisted.ids];
  for (const produce of produces) {
    const namespaced = namespacedArtifactId(produce, slot);
    if (ids.includes(namespaced)) continue;
    // Only snapshot a produce this slot EXPLICITLY returned under the shared
    // id: at this moment the shared file is the slot's own just-written
    // content. A slot that returned no artifact for a produce must never
    // inherit another slot's (or a prior iteration's) shared file as its
    // namespaced provenance — that would count a free-rider slot as a
    // contributor and record incorrect fan-in provenance.
    if (!ids.includes(produce)) continue;
    const shared = readArtifact(ctx.artifactsDir, produce);
    if (shared !== null) {
      try {
        writeArtifact(ctx.artifactsDir, namespaced, shared);
      } catch (error) {
        return { ids, error: String(error) };
      }
      ids.push(namespaced);
    }
  }
  return { ids };
}

async function runBash(stage: StageDef, ctx: StageContext, produces: string[]): Promise<StageOutcome> {
  // The stage's task field may describe a command; user-driven stages use
  // the typed `command:` field on the stage definition.
  const cmd = stage.command;
  if (!cmd) {
    return { stageId: stage.id, status: "failed", note: "bash stage missing command", artifacts: [] };
  }
  try {
    execSync(cmd, { cwd: ctx.cwd, stdio: "inherit" });
    return validateProduced(stage, ctx, produces, cmd);
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
  slots?: DispatchSlot[],
): StageOutcome {
  if (slots && slots.length > 1) {
    return validateProducedMultiSlot(stage, ctx, produces, successNote, slots);
  }
  // Every declared output is required. Validation-specific checks below add
  // stronger semantic requirements for code-bearing artifacts.
  for (const id of produces) {
    if (!readArtifact(ctx.artifactsDir, id)) {
      return {
        stageId: stage.id,
        status: "failed",
        note: `produced artifact "${id}.json" not found at ${ctx.artifactsDir}/${id}.json — stage claimed done without writing its artifact.`,
        artifacts: produces,
      };
    }
  }

  const validatedIds = new Set(["implementation", "review_fixes"]);
  const gated = produces.filter((p) => validatedIds.has(p));
  if (gated.length === 0) {
    return { stageId: stage.id, status: "done", note: successNote, artifacts: produces };
  }
  for (const id of gated) {
    const data = readArtifact(ctx.artifactsDir, id);
    const result = validationCheckArtifact(id, data as Record<string, unknown>);
    if (!result.ok) {
      ctx.log(`  validation: REJECTED for ${id} — ${result.reason}`);
      return { stageId: stage.id, status: "failed", note: result.reason, artifacts: produces };
    }
  }
  ctx.log(`  validation: PASSED for ${stage.id}`);
  return { stageId: stage.id, status: "done", note: successNote, artifacts: produces };
}

/**
 * Multi-slot consilium produced validation: every declared produce must have
 * at least one slot-scoped result and every slot must have contributed at
 * least one artifact. The shared artifacts are synthesized deterministically
 * by advance-time fan-in, so this stage-level check verifies the per-slot
 * provenance files exist.
 */
function validateProducedMultiSlot(
  stage: StageDef,
  ctx: StageContext,
  produces: string[],
  successNote: string,
  slots: DispatchSlot[],
): StageOutcome {
  // No declared produces => nothing to fan in; the shared-id check does not
  // apply (there are no shared artifacts for this stage).
  if (produces.length === 0) {
    return { stageId: stage.id, status: "done", note: successNote, artifacts: produces };
  }
  const contributing = new Set<string>();
  for (const id of produces) {
    const contributors = slots.filter((slot) => readArtifact(ctx.artifactsDir, namespacedArtifactId(id, slot.slot)) !== null);
    if (contributors.length === 0) {
      return {
        stageId: stage.id,
        status: "failed",
        note: `produced artifact "${id}" has no per-slot results (<id>-<slot>.json) at ${ctx.artifactsDir} — every consilium slot must write its slot-scoped artifact for each declared produce.`,
        artifacts: produces,
      };
    }
    for (const contributor of contributors) contributing.add(contributor.slot);
  }
  const emptySlots = slots.filter((slot) => !contributing.has(slot.slot));
  if (emptySlots.length > 0) {
    return {
      stageId: stage.id,
      status: "failed",
      note: `consilium slots produced no artifacts: ${emptySlots.map((slot) => slot.slot).join(", ")}`,
      artifacts: produces,
    };
  }
  return { stageId: stage.id, status: "done", note: successNote, artifacts: produces };
}

function buildStagePrompt(stage: StageDef, ctx: StageContext, role: string, slotScoped = false): string {
  const consumes = stage.consumes ?? [];
  const reads = consumes
    .map((id) => {
      const data = readArtifact(ctx.artifactsDir, id);
      return data ? `### ${id}\n\`\`\`json\n${JSON.stringify(data, null, 2)}\n\`\`\`` : null;
    })
    .filter((x): x is string => x !== null);

  const readsBlock = reads.length > 0 ? `\n\n## Reads from prior stages\n${reads.join("\n\n")}` : "";
  const rawProduces = Array.isArray(stage.produces) ? stage.produces : stage.produces ? [stage.produces] : [];
  const produces = slotScoped
    ? rawProduces.map((id) => `${id}-${sanitizeSlot(role)}.json`).join(", ")
    : rawProduces.join(", ") || "(none)";
  const roleHint = isOrchestratorRole(role)
    ? "You are a DISPATCHER and INTEGRATOR, not a coder. Spawn subagents for any code work, read their artifacts, decide whether to proceed. Do NOT edit code yourself — if a subagent's output is wrong, re-spawn with a sharper task; do not patch their artifact. Trust their validation evidence; do not second-guess build/test output by re-running it."
    : "You are an EXECUTOR, not a router. Gather your own context. Do not delegate to other agents unless you spawn them yourself. If your stage produces code, you MUST run the project's build + tests + linter yourself and include the verbatim output in the artifact's `validation_evidence` field, with `validation_run: true`. The engine will reject the handoff otherwise. Do not invent escape hatches like 'orchestrator owns validation' — that contract does not exist.";
  const dispatchMarker = stage.type === "single" || stage.type === "consilium"
    ? buildDispatchMarker(ctx.state.run_key ?? ctx.state.branch, stage, resolveStageDispatchSlots(stage, ctx).map((slot) => slot.slot), role, ctx.state.cursor_epoch ?? stage.id)
    : "";
  const durableBinding = dispatchMarker
    ? `run_key=${ctx.state.run_key ?? ctx.state.branch} branch=${ctx.state.branch} workflow=${ctx.state.classification.workflow} profile_hash=${ctx.state.profile_hash ?? ""} stage_cursor=${stage.id} cursor_epoch=${ctx.state.cursor_epoch ?? ""}`
    : "";
  return `## Stage: ${stage.id} — ${stage.title}
${stage.description ?? ""}

Branch: ${ctx.state.branch}
Classification: ${ctx.state.classification.type}/${ctx.state.classification.complexity} (workflow=${ctx.state.classification.workflow})
Workflow role: ${role}
${roleHint}

### Dispatch contract
${dispatchMarker || "No task dispatch is permitted for this stage."}

### Durable binding
${durableBinding || "No durable dispatch binding is active."}

### Task
${ctx.state.task}

### Stage instructions
${stage.prompt ?? "Follow the stage title and produce the declared artifact from the task and prior artifacts."}

### Your job
Execute this stage. Write your typed artifact to ${ctx.artifactsDir}/${slotScoped ? "<id>-<slot>.json" : "<id>.json"} matching the engine's schema (the engine reads only JSON, not prose).${slotScoped ? " This is a parallel consilium slot: write ONLY your own slot-scoped files (other slots write theirs). The engine deterministically synthesizes the shared artifacts at advance." : ""}

Produces: ${produces}${readsBlock}

### Rule
${roleHint}
`;
}

function isOrchestratorRole(role: string): boolean {
  // Orchestrator roles are the ones the engine marks as inline; all other
  // roles are executors.
  return role === "discovery" || role === "orchestrator";
}

/**
 * Resolve the stage's dispatch roster as stable occurrence slots. Semantic
 * profile roles are preserved on `slot.role`; repeated roles normalize to
 * unique deterministic slot identities (`analyst#1`, `analyst#2`) so
 * capability rosters, markers, authorization and joins can distinguish
 * occurrences while the concrete agent mapping stays per semantic role.
 */
export function resolveStageDispatchSlots(
  stage: StageDef,
  ctx: Pick<StageContext, "flags" | "cwd" | "resolveDevAgent">,
): DispatchSlot[] {
  const base = stage.type === "single" ? [stage.role ?? ""] : stage.roles ?? [];
  const expanded = base.map((role) => expandRole(role, ctx));
  const conditioned = stage.type === "consilium"
    ? applyConditional(expanded, stage.conditional, ctx.flags)
    : expanded;
  const roster = applyRosterOverrides(conditioned, ctx.cwd, stage.id).map((role) => expandRole(role, ctx));
  return normalizeDispatchSlots(roster);
}

/**
 * Map a resolved semantic roster to stable unique slot identities. A role
 * that occurs exactly once keeps its bare name (unique-role profiles are
 * byte-identical to the pre-slot era); a role that occurs more than once
 * gets every occurrence numbered deterministically by position
 * (`analyst#1`, `analyst#2`). Order is preserved, so the mapping is stable
 * across capability creation, handoff, markers and joins.
 */
function normalizeDispatchSlots(roles: string[]): DispatchSlot[] {
  const totals = new Map<string, number>();
  for (const role of roles) totals.set(role, (totals.get(role) ?? 0) + 1);
  const seen = new Map<string, number>();
  return roles.map((role) => {
    const occurrence = (seen.get(role) ?? 0) + 1;
    seen.set(role, occurrence);
    const repeated = (totals.get(role) ?? 0) > 1;
    return { slot: repeated ? `${role}#${occurrence}` : role, role };
  });
}

/**
 * Semantic dispatch roster (profile roles after expansion, conditionals and
 * overrides). Dispatch identity lives in {@link resolveStageDispatchSlots};
 * this view keeps the profile's declared roles verbatim (duplicates
 * included) for display and reporting.
 */
export function resolveStageDispatchRoles(
  stage: StageDef,
  ctx: Pick<StageContext, "flags" | "cwd" | "resolveDevAgent">,
): string[] {
  return resolveStageDispatchSlots(stage, ctx).map((slot) => slot.role);
}

function expandRole(role: string, ctx: Pick<StageContext, "resolveDevAgent">): string {
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
 *
 * Cursor-driven: after a durable advance, the cursor repositions to the
 * armed stage. A normal advance moves it forward; a bounded-loop re-entry
 * (handled inside `advanceCursor`) points it back at the loop's `back_to`
 * stage, which is re-run with a fresh capability and epoch. Loop exhaustion
 * leaves the durable pause in `needs_human`/`failed`, which halts the walk.
 * Stages already completed in a prior session are skipped without re-running.
 */
export async function walkProfile(
  profile: Profile,
  ctx: StageContext,
): Promise<StageOutcome[]> {
  const outcomes: StageOutcome[] = [];
  let cursor = 0;
  while (cursor < profile.stages.length) {
    const stage = profile.stages[cursor]!;
    const persisted = ctx.state.stages.find((entry) => entry.id === stage.id);
    if (persisted && (persisted.status === "done" || persisted.status === "skipped")) {
      ctx.log(`stage ${stage.id}: already ${persisted.status}; skipping`);
      cursor += 1;
      continue;
    }
    let outcome = await runStage(stage, ctx);
    // Strict durable stages advance only after all dispatches have joined.
    // EVERY stage type (orchestrator/single/consilium/bash/none) routes its
    // completion through the same durable transition: declared checkpoints
    // are enforced (interactive runs fail closed on unresolved decisions) or
    // auto-recorded (autonomous runs), and no stage reaches done while its
    // checkpoint is unresolved. The interpreter binds a capability for every
    // stage type (kind "none" for non-dispatch stages) so advance is always
    // available under strict durable execution.
    if (outcome.status === "done" && ctx.durable) {
      const advanced = ctx.durable.advance(outcome.note);
      if (!advanced.ok) {
        outcome = { ...outcome, status: "failed", note: `durable cursor advance failed: ${advanced.error}` };
      } else {
        ctx.onStageComplete?.(stage.id, outcome.status);
        outcomes.push(outcome);
        // Loop exhaustion / needs-human halt: no further stage may run.
        if (ctx.state.pause?.kind === "needs_human" || ctx.state.pause?.kind === "failed") {
          ctx.log(`halting at stage ${stage.id}: ${ctx.state.pause.reason}`);
          return outcomes;
        }
        // Reposition to the armed stage: forward on normal advance, backward
        // on bounded-loop re-entry.
        const armedIndex = ctx.state.stage_cursor
          ? profile.stages.findIndex((candidate) => candidate.id === ctx.state.stage_cursor)
          : -1;
        cursor = armedIndex >= 0 ? armedIndex : cursor + 1;
        continue;
      }
    }
    ctx.onStageComplete?.(stage.id, outcome.status);
    outcomes.push(outcome);
    if (outcome.status === "failed") {
      ctx.log(`halting at stage ${stage.id}`);
      break;
    }
    cursor += 1;
  }
  return outcomes;
}

// Re-export so consumers can read the validation gate cheaply.
export { validationGate };
