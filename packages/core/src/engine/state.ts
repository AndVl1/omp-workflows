/**
 * State machine: read/write `.work-state/team-state.json` with monotonic
 * progress, branch detection, and the per-feature subdir layout.
 *
 * Layout (preserved from claude-plugin):
 *   .work-state/
 *     .active-feature                  (file: slug)
 *     team-state.json                  (legacy root state)
 *     team-state.md                    (human mirror)
 *     artifacts/
 *       <id>.json
 *     features/
 *       <slug>/
 *         state.json
 *         team-state.md
 *         artifacts/<id>.json
 *
 * Resolution order on read:
 *   1. .work-state/.active-feature -> features/<slug>/state.json
 *   2. .work-state/team-state.json (legacy)
 *   3. undefined (no state yet)
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { PauseKind, StageStatus, TeamState } from "./types.js";

const WORK_STATE_DIR = ".work-state";
const ACTIVE_FEATURE = ".active-feature";
const LEGACY_STATE = "team-state.json";
const STATE_MD = "team-state.md";

export interface ResolvedState {
  state: TeamState | null;
  statePath: string | null;
  stateDir: string | null;
  artifactsDir: string | null;
  isLegacy: boolean;
  isStale: boolean;
}

export function resolveState(cwd: string, currentBranch?: string): ResolvedState {
  const wsDir = resolve(cwd, WORK_STATE_DIR);
  if (!existsSync(wsDir)) {
    return { state: null, statePath: null, stateDir: null, artifactsDir: null, isLegacy: false, isStale: false };
  }

  const activeFile = join(wsDir, ACTIVE_FEATURE);
  if (existsSync(activeFile)) {
    const slug = readFileSync(activeFile, "utf8").trim();
    if (slug) {
      const featureDir = join(wsDir, "features", slug);
      const statePath = join(featureDir, "state.json");
      if (existsSync(statePath)) {
        const state = JSON.parse(readFileSync(statePath, "utf8")) as TeamState;
        return {
          state,
          statePath,
          stateDir: featureDir,
          artifactsDir: join(featureDir, "artifacts"),
          isLegacy: false,
          isStale: currentBranch ? state.branch !== currentBranch : false,
        };
      }
    }
  }

  const legacyPath = join(wsDir, LEGACY_STATE);
  if (existsSync(legacyPath)) {
    const state = JSON.parse(readFileSync(legacyPath, "utf8")) as TeamState;
    return {
      state,
      statePath: legacyPath,
      stateDir: wsDir,
      artifactsDir: join(wsDir, "artifacts"),
      isLegacy: true,
      isStale: currentBranch ? state.branch !== currentBranch : false,
    };
  }

  return { state: null, statePath: null, stateDir: null, artifactsDir: null, isLegacy: false, isStale: false };
}

export function writeState(
  cwd: string,
  state: TeamState,
  opts: { featureSlug?: string } = {},
): { statePath: string; artifactsDir: string } {
  const wsDir = resolve(cwd, WORK_STATE_DIR);
  const featureSlug = opts.featureSlug ?? deriveFeatureSlugFromBranch(state.branch) ?? "default";

  let stateDir: string;
  let statePath: string;
  let artifactsDir: string;

  if (featureSlug) {
    stateDir = join(wsDir, "features", featureSlug);
    statePath = join(stateDir, "state.json");
    artifactsDir = join(stateDir, "artifacts");
  } else {
    stateDir = wsDir;
    statePath = join(wsDir, LEGACY_STATE);
    artifactsDir = join(wsDir, "artifacts");
  }

  mkdirSync(stateDir, { recursive: true });
  mkdirSync(artifactsDir, { recursive: true });

  const stamped: TeamState = { ...state, updated_at: new Date().toISOString() };
  writeFileSync(statePath, JSON.stringify(stamped, null, 2) + "\n", "utf8");
  writeStateMd(stateDir, stamped);

  if (featureSlug) {
    writeFileSync(join(wsDir, ACTIVE_FEATURE), featureSlug + "\n", "utf8");
  }

  return { statePath, artifactsDir };
}

export function writeStateMd(stateDir: string, state: TeamState): void {
  const lines: string[] = [];
  lines.push("# TEAM STATE");
  lines.push("");
  lines.push("## Classification");
  lines.push(`- Type: ${state.classification.type}`);
  lines.push(`- Complexity: ${state.classification.complexity}`);
  lines.push(`- Workflow: ${state.classification.workflow}`);
  lines.push(`- Confidence: ${state.classification.confidence}`);
  lines.push("");
  lines.push("## Task");
  lines.push(state.task);
  lines.push("");
  lines.push("## Progress");
  for (const s of state.stages) {
    const mark = s.status === "done" ? "[x]" : s.status === "in_progress" ? "[~]" : s.status === "skipped" ? "[s]" : "[ ]";
    lines.push(`- ${mark} ${s.id} - ${s.status}`);
  }
  lines.push("");
  lines.push("## Pause");
  lines.push(`- kind: ${state.pause.kind}`);
  if (state.pause.reason) lines.push(`- reason: ${state.pause.reason}`);
  lines.push("");
  lines.push("## Branch");
  lines.push(state.branch);
  lines.push("");
  lines.push("## Last update");
  lines.push(state.updated_at);
  lines.push("");

  writeFileSync(join(stateDir, STATE_MD), lines.join("\n"), "utf8");
}

export function setPause(state: TeamState, kind: PauseKind, reason = ""): TeamState {
  return { ...state, pause: { kind, reason }, updated_at: new Date().toISOString() };
}

export function setStageStatus(state: TeamState, stageId: string, status: StageStatus): TeamState {
  const stages = state.stages.map((s) => (s.id === stageId ? { ...s, status } : s));
  const cursor = status === "in_progress" ? stageId : state.stage_cursor;
  return { ...state, stages, stage_cursor: cursor, updated_at: new Date().toISOString() };
}

/**
 * Monotonic check: a stage with `pending` must not precede a stage that is
 * `done` or `in_progress`. The P4 gate in claude-plugin's validate-state.sh.
 */
export function checkMonotonic(state: TeamState): { ok: true } | { ok: false; violation: string } {
  const statuses = state.stages.map((s) => s.status ?? "pending");
  const firstPending = statuses.indexOf("pending");
  if (firstPending === -1) return { ok: true };
  const after = statuses.slice(firstPending + 1).filter((s) => s === "done" || s === "in_progress");
  if (after.length > 0) {
    return {
      ok: false,
      violation: `stage progress is not monotonic — stage ${state.stages[firstPending]?.id ?? "?"} is pending while a later stage is done/in_progress`,
    };
  }
  return { ok: true };
}

function deriveFeatureSlugFromBranch(branch: string): string | null {
  if (!branch) return null;
  return branch.replace(/\//g, "-").replace(/[^a-z0-9._-]/gi, "-").toLowerCase();
}

export function archiveStaleState(statePath: string, state: TeamState): void {
  const archiveDir = join(dirname(statePath), "..", "archive");
  try {
    mkdirSync(archiveDir, { recursive: true });
    const safeBranch = state.branch.replace(/\//g, "-").replace(/[^a-z0-9._-]/gi, "-");
    const dest = join(archiveDir, `${safeBranch}.${Date.now()}.bak.json`);
    writeFileSync(dest, JSON.stringify(state, null, 2));
  } catch {
    // best-effort
  }
}

export function listFeatures(cwd: string): string[] {
  const wsDir = resolve(cwd, WORK_STATE_DIR);
  const featuresDir = join(wsDir, "features");
  if (!existsSync(featuresDir)) return [];
  return readdirSync(featuresDir).filter((name) => {
    const statePath = join(featuresDir, name, "state.json");
    return existsSync(statePath);
  });
}
