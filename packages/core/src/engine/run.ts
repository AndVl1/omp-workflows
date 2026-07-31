/**
 * Main interpreter loop. The class+method the `/team` slash command invokes.
 * It chains:
 *
 *   1. classify(task)
 *   2. resolve workflow -> profile
 *   3. write state BEFORE any subagent launch
 *   4. walk profile stages
 *   5. mirror progress into team-state.md
 *
 * The `task` field of a `TaskCaller` is what the engine passes to the native
 * `task` tool / `agent` API. The engine itself does NOT use the model; it
 * orchestrates subagents only.
 */

import { readFileSync } from "node:fs";
import { loadAllProfiles, resolveWorkflow, selectProfile } from "./profile.js";
import { resolveConfig, resolveAgentForRole } from "./config.js";
import { resolveScope } from "./scope.js";
import { writeState, setStageStatus, setPause, resolveState } from "./state.js";
import { classify } from "./classify.js";
import { walkProfile, type StageContext, type TaskCaller } from "./stage.js";
import type { Classification, Profile, TeamState } from "./types.js";

export interface RunOptions {
  task: string;
  cwd: string;
  branch: string;
  autonomous: boolean;
  /** Optional override for the classifier. */
  classification?: Partial<Classification>;
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
export async function run(opts: RunOptions): Promise<RunResult> {
  const config = resolveConfig(opts.cwd);
  const profiles = loadAllProfiles();

  // 1. classify.
  const base = classify(opts.task, { autonomous: opts.autonomous });
  const classification: Classification = {
    type: opts.classification?.type ?? base.type,
    complexity: opts.classification?.complexity ?? base.complexity,
    confidence: opts.classification?.confidence ?? base.confidence,
    workflow: resolveWorkflow(
      opts.classification?.type ?? base.type,
      opts.classification?.complexity ?? base.complexity,
      opts.autonomous,
    ),
  };

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
    autonomous: opts.autonomous,
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
  ;
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
