/**
 * Main interpreter loop. The class+method the `/team` slash command invokes.
 * It chains:
 *
 *   1. classify (model classification is authoritative when supplied)
 *   2. resolve workflow -> profile
 *   3. write state BEFORE any subagent launch
 *   4. walk profile stages
 *   5. mirror progress into team-state.md
 *
 * The `task` field of a `TaskCaller` is what the engine passes to the native
 * `task` tool / `agent` API. The engine itself does NOT use the model; it
 * orchestrates subagents only.
 *
 * Autonomy contract (RC2+): `classification` carries the MODEL decision
 * (`classification.autonomous`) and is authoritative. When it is supplied,
 * type/complexity/confidence/autonomous must all be present — the engine
 * FAILS CLOSED rather than silently filling the gaps from keyword guesses.
 * `keywordClassify` remains only for legacy callers that run without a
 * model classification; it cannot decide autonomy (the caller's `autonomous`
 * option is used verbatim, never defaulted).
 */

import { readFileSync } from "node:fs";
import { loadAllProfiles, profileHash, resolveWorkflow, selectProfile } from "./profile.js";
import { resolveConfig, resolveAgentForRole } from "./config.js";
import { resolveScope } from "./scope.js";
import { writeState, setStageStatus, setPause, resolveState, reopenFromFeedback } from "./state.js";
import { authorizeDispatch, completeDispatch, advanceCursor, createCapability } from "./durable.js";
import { keywordClassify } from "./classify.js";
import type { Classification, Complexity, Confidence, Profile, TaskType, TeamState, WorkflowName } from "./types.js";
import { walkProfile, type StageContext, type TaskCaller } from "./stage.js";

/**
 * The model's PHASE-0 classification. `type`, `complexity`, `confidence` and
 * `autonomous` are classified together by the LLM and are all required;
 * `workflow` may be omitted and is then resolved from the matrix.
 */
export interface ModelClassification {
  type: TaskType;
  complexity: Complexity;
  confidence: Confidence;
  autonomous: boolean;
  /** Model's justification for the autonomy decision (optional). */
  autonomous_reason?: string;
  /** Explicit workflow override; resolved from the matrix when absent. */
  workflow?: WorkflowName;
}

export interface RunOptions {
  task: string;
  cwd: string;
  branch: string;
  /** Legacy autonomy flag for callers without model classification. */
  autonomous: boolean;
  /** Authoritative model classification (PHASE-0). */
  classification?: ModelClassification;
  /** Caller-issued task tool reference. */
  taskTool: TaskCaller;
  issue?: { number: number; url?: string } | null;
  pause?: (reason: string) => Promise<void>;
  log?: (line: string) => void;
  /** Resume prior state after user feedback, preserving artifacts/history. */
  continuation?: { feedback: string; stageId: string };
}

export interface RunResult {
  classification: Classification;
  profile: Profile;
  outcomes: Array<{ stageId: string; status: "done" | "skipped" | "failed"; note: string }>;
  statePath: string | null;
}

/**
 * Resolve the authoritative classification: model first (fail closed on
 * incomplete output), keyword guess only for legacy callers.
 */
export function resolveClassification(opts: Pick<RunOptions, "task" | "autonomous" | "classification">): Classification {
  const model = opts.classification;
  if (model) {
    if (!model.type || !model.complexity || !model.confidence || typeof model.autonomous !== "boolean") {
      throw new Error(
        `classification gate: model classification incomplete (type=${model.type}, complexity=${model.complexity}, confidence=${model.confidence}, autonomous=${model.autonomous}). PHASE-0 must classify type, complexity, confidence and autonomous together; refusing to fall back to keyword guesses.`,
      );
    }
    const expected = resolveWorkflow(model.type, model.complexity, model.autonomous);
    if (model.workflow !== undefined && model.workflow !== expected && (model.type === "SPEC" || model.type === "REGRESS")) {
      throw new Error(`classification gate: ${model.type} must resolve to '${expected}', got '${model.workflow}'`);
    }
    return {
      type: model.type,
      complexity: model.complexity,
      confidence: model.confidence,
      autonomous: model.autonomous,
      autonomous_reason: model.autonomous_reason,
      workflow: model.workflow ?? expected,
    };
  }
  // Legacy path: keyword guess for type/complexity/confidence only; the
  // caller's explicit autonomous flag is used verbatim — never defaulted.
  const base = keywordClassify(opts.task);
  return {
    type: base.type,
    complexity: base.complexity,
    confidence: base.confidence,
    autonomous: opts.autonomous,
    workflow: resolveWorkflow(base.type, base.complexity, opts.autonomous),
  };
}

export async function run(opts: RunOptions): Promise<RunResult> {
  const config = resolveConfig(opts.cwd);
  const profiles = loadAllProfiles();
  const existing = resolveState(opts.cwd, opts.branch);
  if (opts.continuation && (!existing.state || existing.isStale)) {
    throw new Error(`cannot continue workflow: no non-stale state for branch ${opts.branch}`);
  }
  const persistedClassification = opts.continuation ? existing.state?.classification : undefined;
  const classification = persistedClassification ?? resolveClassification(opts);
  const profile = persistedClassification
    ? profiles.find((candidate) => candidate.name === persistedClassification.workflow)
    : selectProfile(profiles, classification);
  if (!profile) throw new Error(`no profile matches classification ${JSON.stringify(classification)}`);
  const flags = resolveScope([], config);
  const continuation = opts.continuation
    ? reopenFromFeedback(existing.state!, opts.continuation.feedback, opts.continuation.stageId)
    : null;
  const initialState: TeamState = continuation
    ? { ...continuation, policy: { ...(continuation.policy ?? {}), strict_orchestrator: true } }
    : (() => {
        const stage = profile.stages[0];
        const kind: "single" | "consilium" | null = stage?.type === "single" ? "single" : stage?.type === "consilium" ? "consilium" : null;
        const issued = stage && kind ? createCapability({ run_key: opts.branch, branch: opts.branch, workflow: profile.name, profile_hash: profileHash(profile), stage_cursor: stage.id, kind, expected_roles: kind === "single" ? [stage.role ?? ""] : [...(stage.roles ?? [])] }) : null;
        return { schema: 1, branch: opts.branch, classification, task: opts.task, workflow_override: opts.classification?.workflow !== undefined, issue: opts.issue ?? null, stage_cursor: stage?.id ?? "", stages: profile.stages.map((s) => ({ id: s.id, status: "pending" as const })), pause: { kind: "none" as const, reason: "" }, artifacts: {}, policy: { strict_orchestrator: true }, profile_hash: profileHash(profile), run_key: opts.branch, cursor_epoch: issued?.state.issued_for?.cursor_epoch, dispatch_capability: issued?.state, updated_at: new Date().toISOString() } satisfies TeamState;
      })();
  const { statePath, artifactsDir } = writeState(opts.cwd, initialState, opts.continuation ? { target: existing } : {});
  const completed = new Set(initialState.stages.filter((s) => s.status === "done" || s.status === "skipped").map((s) => s.id));
  const runnableProfile = completed.size === 0 ? profile : { ...profile, stages: profile.stages.filter((s) => !completed.has(s.id)) };
  let durableStage: { stageId: string; dispatchToken: string; advanceToken: string; epoch: string } | null = null;
  const ctx: StageContext = {
    cwd: opts.cwd,
    state: initialState,
    artifactsDir,
    flags,
    agent: (role) => resolveAgentForRole(role, config),
    task: opts.taskTool,
    pause: opts.pause ?? (async () => undefined),
    onStageStart: (stageId) => {
      const current = readState(statePath);
      const stage = profile.stages.find((candidate) => candidate.id === stageId);
      const kind: "single" | "consilium" | null = stage?.type === "single" ? "single" : stage?.type === "consilium" ? "consilium" : null;
      const next = setStageStatus(current, stageId, "in_progress", opts.cwd);
      const capability = stage && kind ? createCapability({ run_key: next.run_key ?? next.branch, branch: next.branch, workflow: profile.name, profile_hash: profileHash(profile), stage_cursor: stage.id, kind, expected_roles: kind === "single" ? [stage.role ?? ""] : [...(stage.roles ?? [])] }) : null;
      if (capability) durableStage = { stageId, dispatchToken: capability.dispatch_token, advanceToken: capability.advance_token, epoch: capability.state.issued_for!.cursor_epoch };
      writeState(opts.cwd, capability ? { ...next, run_key: next.run_key ?? next.branch, cursor_epoch: capability.state.issued_for!.cursor_epoch, profile_hash: profileHash(profile), dispatch_capability: capability.state } : next, opts.continuation ? { target: existing } : {});
    },
    log: opts.log ?? (() => undefined),
    resolveDevAgent: () => flags.dev_agent,
    durable: {
      authorize: (role, agent) => {
        if (!durableStage) return { ok: false, error: "durable stage unavailable" };
        const s = readState(statePath);
        const r = authorizeDispatch(opts.cwd, { token: durableStage.dispatchToken, capability_id: s.dispatch_capability?.capability_id ?? "", run_key: initialState.run_key ?? opts.branch, branch: opts.branch, workflow: profile.name, profile_hash: profileHash(profile), stage_cursor: durableStage.stageId, cursor_epoch: durableStage.epoch, role, agent });
        return r.ok && r.record ? { ok: true, dispatchId: r.record.id } : { ok: false, error: r.ok ? "missing dispatch record" : r.error };
      },
      complete: (dispatchId, output, outcome, artifactIds) => {
        if (!durableStage) return { ok: false, error: "durable stage unavailable" };
        const r = completeDispatch(opts.cwd, { token: durableStage.dispatchToken, capability_id: readState(statePath).dispatch_capability?.capability_id ?? "", dispatch_id: dispatchId, run_key: initialState.run_key ?? opts.branch, branch: opts.branch, workflow: profile.name, profile_hash: profileHash(profile), stage_cursor: durableStage.stageId, cursor_epoch: durableStage.epoch, outcome, evidence: output || (outcome === "failed" ? "task failed" : ""), artifact_ids: artifactIds });
        return r.ok ? { ok: true } : { ok: false, error: r.error };
      },
      advance: (evidence) => {
        if (!durableStage) return { ok: false, error: "durable stage unavailable" };
        const r = advanceCursor(opts.cwd, { token: durableStage.advanceToken, capability_id: readState(statePath).dispatch_capability?.capability_id ?? "", run_key: initialState.run_key ?? opts.branch, branch: opts.branch, workflow: profile.name, profile_hash: profileHash(profile), stage_cursor: durableStage.stageId, cursor_epoch: durableStage.epoch });
        if (!r.ok) return { ok: false, error: `${r.error}: ${evidence}` };
        if (r.handoff) durableStage = { stageId: r.state.stage_cursor, dispatchToken: r.handoff.dispatch_token, advanceToken: r.handoff.advance_token, epoch: r.handoff.cursor_epoch };
        return { ok: true, handoff: r.handoff };
      },
    },
  };
  opts.log?.(`walking profile: ${profile.name} (${runnableProfile.stages.length} stages)`);
  const outcomes = await walkProfile(runnableProfile, ctx);
  const final = readState(statePath);
  const done = final.stages.every((s) => s.status === "done" || s.status === "skipped");
  writeState(opts.cwd, setPause(final, done ? "done" : "failed", done ? "" : "one or more stages failed"), opts.continuation ? { target: existing } : {});
  return { classification, profile, outcomes: outcomes.map((o) => ({ stageId: o.stageId, status: o.status, note: o.note })), statePath };
}

function readState(path: string): TeamState {
  if (!path) throw new Error("state path missing");
  return JSON.parse(readFileSync(path, "utf8")) as TeamState;
}
