import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import {
  candidateForState,
  createSelectionSnapshot,
  listRuns,
  readRunState,
  readRunControl,
  readSelectionSnapshot,
  runTarget,
} from "./run-store.js";
import { LifecycleError, type RunSelectionResult } from "./run-lifecycle.js";
import { resolveRunSelection } from "./run-store.js";
import type {
  LifecycleMode,
  LifecycleSelector,
  RunCandidate,
  RunSelectionSnapshot,
  TeamState,
} from "./types.js";

export interface ReadSelectorContext {
  branch?: string;
  session_run_id?: string;
}

export interface WorkflowRunRead {
  run_id: string;
  candidate: RunCandidate;
  state: TeamState;
  state_path: string;
  artifacts_dir: string;
  revision_id?: string;
}

export interface WorkflowReadSelector {
  list(options?: { branch?: string; includeTerminal?: boolean }): RunSelectionSnapshot;
  resolve(mode: Exclude<LifecycleMode, "new">, selector?: LifecycleSelector, snapshot?: RunSelectionSnapshot): RunSelectionResult;
  read(runId: string, revisionId?: string): WorkflowRunRead;
}

function safeRevisionId(value: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(value) && value !== "." && value !== "..";
}

function readJsonState(path: string, runId: string): TeamState {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new LifecycleError("recovery_required", `run state is unreadable: ${(error as Error).message}`, { run_id: runId });
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new LifecycleError("run_state_invalid", "run state is not an object", { run_id: runId });
  }
  const state = parsed as TeamState;
  if (state.schema !== 2 || state.run_id !== runId || state.run_key !== runId) {
    throw new LifecycleError("run_state_invalid", "run state identity is invalid", { run_id: runId });
  }
  return state;
}

export function createWorkflowReadSelector(cwd: string, context: ReadSelectorContext = {}): WorkflowReadSelector {
  const root = resolve(cwd);
  const defaultBranch = context.branch;
  return {
    list(options = {}) {
      const branch = options.branch ?? defaultBranch;
      return createSelectionSnapshot(root, { ...options, ...(branch ? { branch } : {}) });
    },
    resolve(mode, selector, snapshot) {
      if (mode !== "resume" && mode !== "rework") {
        throw new LifecycleError("lifecycle_request_conflict", `read selector cannot resolve mode '${mode}'`);
      }
      const branch = defaultBranch;
      let candidates: RunCandidate[];
      if (selector?.run_id) {
        const explicit = readRunState(root, selector.run_id);
        if (!explicit) throw new LifecycleError("run_not_found", `run '${selector.run_id}' is missing`, { run_id: selector.run_id });
        if (branch && explicit.branch !== branch) throw new LifecycleError("run_context_mismatch", `run '${selector.run_id}' belongs to branch '${explicit.branch}', current branch is '${branch}'`, { run_id: selector.run_id, branch, next_action: "switch to the run branch or select a run on the current branch" });
        candidates = [candidateForState(explicit)];
      } else {
        candidates = listRuns(root, { ...(branch ? { branch } : {}), includeTerminal: mode === "rework" });
      }
      const resolvedSnapshot = snapshot ?? (selector?.list_item ? readSelectionSnapshot(root, selector.list_item.snapshot_id) : undefined);
      return resolveRunSelection({
        mode,
        candidates,
        currentBranch: branch,
        selector,
        sessionRunId: context.session_run_id,
        snapshot: resolvedSnapshot,
      });
    },
    read(runId, revisionId) {
      const target = runTarget(root, runId);
      const statePath = target.statePath!;
      const selectedStatePath = revisionId
        ? join(target.stateDir!, "revisions", revisionId, "state.json")
        : statePath;
      if (revisionId && (!safeRevisionId(revisionId) || isAbsolute(revisionId))) {
        throw new LifecycleError("run_state_invalid", "unsafe revision selector", { run_id: runId });
      }
      const selectedRoot = revisionId ? join(target.stateDir!, "revisions", revisionId) : target.stateDir!;
      const rel = relative(target.stateDir!, selectedRoot);
      if (rel.startsWith("..") || isAbsolute(rel)) {
        throw new LifecycleError("run_state_invalid", "revision selector escapes run directory", { run_id: runId });
      }
      if (!existsSync(selectedStatePath)) {
        if (!revisionId) {
          const current = readRunState(root, runId, defaultBranch);
          if (!current) throw new LifecycleError("run_not_found", `run '${runId}' is missing`, { run_id: runId });
          return { run_id: runId, candidate: candidateForState(current), state: current, state_path: statePath, artifacts_dir: target.artifactsDir! };
        }
        throw new LifecycleError("run_not_found", `revision '${revisionId}' is missing for run '${runId}'`, { run_id: runId });
      }
      const state = readJsonState(selectedStatePath, runId);
      return {
        run_id: runId,
        candidate: candidateForState(state),
        state,
        state_path: selectedStatePath,
        artifacts_dir: revisionId ? join(selectedRoot, "artifacts") : target.artifactsDir!,
        ...(revisionId ? { revision_id: revisionId } : {}),
      };
    },
  };
}
