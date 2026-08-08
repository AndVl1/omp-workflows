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
import { loadAllProfiles, resolveWorkflow, selectProfile } from "./profile.js";
import { resolveConfig, resolveAgentForRole } from "./config.js";
import { resolveScope } from "./scope.js";
import { writeState, setStageStatus, setPause, resolveState } from "./state.js";
import { keywordClassify } from "./classify.js";
import { walkProfile, type StageContext, type TaskCaller } from "./stage.js";
import type { Classification, Complexity, Confidence, Profile, TaskType, TeamState, WorkflowName } from "./types.js";

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
  /**
   * LEGACY autonomy flag for callers that do not supply a model
   * `classification`. Used verbatim (never defaulted) on the legacy path
   * only; the model path reads `classification.autonomous`.
   */
  autonomous: boolean;
  /** Authoritative model classification (PHASE-0). */
  classification?: ModelClassification;
  /** Caller-issued task tool reference. */
  taskTool: TaskCaller;
  /** Optional issue metadata (number + url) for PR/decision wiring. */
  issue?: { number: number; url?: string } | null;
  /** Pause for a user checkpoint. */
  pause?: (reason: string) => Promise<void>;
  /** Logger for engine progress. */
  log?: (line: string) => void;
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
    return {
      type: model.type,
      complexity: model.complexity,
      confidence: model.confidence,
      autonomous: model.autonomous,
      autonomous_reason: model.autonomous_reason,
      workflow: model.workflow ?? resolveWorkflow(model.type, model.complexity, model.autonomous),
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

  // 1. classify — the model classification is authoritative.
  const classification = resolveClassification(opts);

  // 2. select profile.
  const profile = selectProfile(profiles, classification);
  if (!profile) {
    throw new Error(`no profile matches classification ${JSON.stringify(classification)}`);
  }

  // 3. write state BEFORE any subagent launch — the gate requires this.
  const flags = resolveScope([], config); // resolved later when files surface
  const existing = resolveState(opts.cwd, opts.branch);

  const stages = profile.stages.map((s) => ({
    id: s.id,
    status: "pending" as const,
  }));

  const initialState: TeamState = {
    schema: 1,
    branch: opts.branch,
    classification,
    task: opts.task,
    // New writes carry the decision in classification.autonomous; the legacy
    // top-level field is intentionally NOT written.
    workflow_override: opts.classification?.workflow !== undefined,
    issue: opts.issue ?? null,
    stage_cursor: profile.stages[0]?.id ?? "",
    stages,
    artifacts: {},
    pause: { kind: "none", reason: "" },
    updated_at: new Date().toISOString(),
  };

  const { statePath, artifactsDir } = writeState(opts.cwd, initialState);

  // 4. walk stages.
  const ctx: StageContext = {
    cwd: opts.cwd,
    state: initialState,
    artifactsDir: artifactsDir ?? `${opts.cwd}/.work-state/artifacts`,
    flags,
    agent: (role) => resolveAgentForRole(role, config),
    task: opts.taskTool,
    pause: opts.pause ?? (async () => undefined),
    log: opts.log ?? ((line) => undefined),
    resolveDevAgent: () => flags.dev_agent,
  };

  opts.log?.(`walking profile: ${profile.name} (${profile.stages.length} stages)`);
  const outcomes = await walkProfile(profile, ctx);

  // 5. update state stages[].
  for (const o of outcomes) {
    if (o.status === "done" || o.status === "skipped") {
      const updated = readState(statePath);
      const next = setStageStatus(updated, o.stageId, o.status);
      writeState(opts.cwd, next);
    }
  }

  const final = readState(statePath);
  const done = outcomes.every((o) => o.status === "done" || o.status === "skipped");
  writeState(
    opts.cwd,
    setPause(final, done ? "done" : "failed", done ? "" : "one or more stages failed"),
  );

  return {
    classification,
    profile,
    outcomes: outcomes.map((o) => ({ stageId: o.stageId, status: o.status, note: o.note })),
    statePath,
  };
}

function readState(path: string): TeamState {
  if (!path) throw new Error("state path missing");
  return JSON.parse(readFileSync(path, "utf8")) as TeamState;
}
