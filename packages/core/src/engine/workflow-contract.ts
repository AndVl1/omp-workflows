import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { loadProfile, profileHash as sharedProfileHash, resolveWorkflowProfilePath } from "./profile.js";
import { resolveConfig, resolveAgentForRole } from "./config.js";
import { resolveState } from "./state.js";
import type { StageDef, TeamState, WorkflowName } from "./types.js";

export interface WorkflowContractOptions {
  /** Require a persisted, branch-current run. Defaults to true. */
  requireState?: boolean;
  workflow?: WorkflowName;
  branch?: string;
  stageId?: string;
  maxInstructions?: number;
}

export interface WorkflowStageContract {
  id: string; title: string; type: StageDef["type"]; description: string; prompt: string;
  roles: Array<{ role: string; agent: string }>; parallel: boolean; consumes: string[]; produces: string[];
  checkpoint: string | null; autonomous: string | null; gate: string | null; skip_if: string | null; loop: StageDef["loop"] | null;
  dispatch: { permitted: boolean; kind: "single" | "consilium" | null; expected_count: number; capability_id: string | null; cursor_epoch: string | null };
  instructions: string;
  provenance: { source: "workflow"; profilePath: string | null; profileHash: string; stageHash: string };
}

export interface WorkflowContract {
  workflow: WorkflowName;
  profile: { title: string; description: string; path: string | null; hash: string; source: "workflow" };
  state: {
    path: string;
    branch: string;
    workflow: WorkflowName;
    profileHash: string;
    stageCursor: string;
    stageStatuses: Array<{ id: string; status: string }>;
    dispatch: { allowed: boolean; stageId: string; kind: "single" | "consilium" | null; capability: string; cursorEpoch?: string | null };
  };
  stage: WorkflowStageContract;
  provenance: { statePath: string; profilePath: string | null; profileHash: string; stateHash: string };
}

export class WorkflowContractError extends Error {
  readonly code: "STATE_MISSING" | "STATE_STALE" | "PROFILE_MISSING" | "STAGE_MISSING" | "PROFILE_MISMATCH";
  constructor(code: WorkflowContractError["code"], message: string) { super(message); this.name = "WorkflowContractError"; this.code = code; }
}

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
function currentBranch(cwd: string): string | undefined {
  try { return execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd, encoding: "utf8" }).trim() || undefined; } catch { return undefined; }
}
function instructions(stage: StageDef, max: number): string {
  const text = [stage.description, stage.prompt, stage.checkpoint ? `Checkpoint: ${stage.checkpoint}` : undefined, stage.gate ? `Gate: ${stage.gate}` : undefined, stage.autonomous ? `Autonomous: ${stage.autonomous}` : undefined].filter(Boolean).join("\n\n").trim();
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

/** Resolve the persisted run, profile and current stage into one bounded, typed contract. */
export function resolveWorkflowContract(cwd: string, options: WorkflowContractOptions = {}): WorkflowContract {
  const expectedBranch = options.branch ?? currentBranch(cwd);
  const resolved = resolveState(cwd, expectedBranch);
  if (options.requireState !== false && (!resolved.state || !resolved.statePath)) throw new WorkflowContractError("STATE_MISSING", "workflow contract requires an active persisted state");
  if (!resolved.state || !resolved.statePath) throw new WorkflowContractError("STATE_MISSING", "workflow state is missing");
  if (resolved.isStale) throw new WorkflowContractError("STATE_STALE", `workflow state branch '${resolved.state.branch}' is stale (current '${expectedBranch ?? "unknown"}')`);
  const state = resolved.state as TeamState;
  const workflow = options.workflow ?? state.classification?.workflow;
  if (!workflow || (options.workflow && options.workflow !== state.classification?.workflow)) throw new WorkflowContractError("PROFILE_MISMATCH", "requested workflow does not match persisted classification");
  const profile = loadProfile(workflow);
  if (!profile) throw new WorkflowContractError("PROFILE_MISSING", `workflow profile '${workflow}' is unavailable`);
  const path = resolveWorkflowProfilePath(workflow, cwd);
  const pHash = sharedProfileHash(profile);
  const persistedHash = (state as TeamState & { profile_hash?: string }).profile_hash;
  if (persistedHash && persistedHash !== pHash) throw new WorkflowContractError("PROFILE_MISMATCH", "persisted profile hash is stale");
  const stageId = options.stageId ?? state.stage_cursor;
  const stage = profile.stages.find(candidate => candidate.id === stageId);
  if (!stage) throw new WorkflowContractError("STAGE_MISSING", `stage cursor '${stageId}' is not present in '${workflow}'`);
  const config = resolveConfig(cwd);
  const roles = stage.roles ?? (stage.role ? [stage.role] : []);
  const kind = stage.type === "single" || stage.type === "consilium" ? stage.type : null;
  const statuses = state.stages.map(item => ({ id: item.id, status: item.status }));
  const expectedCount = roles.length;
  const capability = state.dispatch_capability;
  const stageContract: WorkflowStageContract = {
    id: stage.id, title: stage.title, type: stage.type,
    description: stage.description ?? "", prompt: stage.prompt ?? "",
    roles: roles.map(role => ({ role, agent: resolveAgentForRole(role, config) })), parallel: stage.parallel ?? stage.type === "consilium",
    consumes: stage.consumes ?? [], produces: typeof stage.produces === "string" ? [stage.produces] : stage.produces ?? [],
    checkpoint: stage.checkpoint ?? null, autonomous: stage.autonomous ?? null, gate: stage.gate ?? null, skip_if: stage.skip_if ?? null, loop: stage.loop ?? null,
    dispatch: { permitted: kind !== null, kind, expected_count: expectedCount, capability_id: capability ? String((capability as any).capability_id ?? "") || null : null, cursor_epoch: (state as any).cursor_epoch ?? null },
    instructions: instructions(stage, options.maxInstructions ?? 4000),
    provenance: { source: "workflow", profilePath: path, profileHash: pHash, stageHash: hash(stage) },
  };
  const stateRaw = readFileSync(resolved.statePath, "utf8");
  return {
    workflow, profile: { title: profile.title, description: profile.description, path, hash: pHash, source: "workflow" },
    state: { path: resolved.statePath, branch: state.branch, workflow, profileHash: pHash, stageCursor: state.stage_cursor, stageStatuses: statuses, dispatch: { allowed: kind !== null, stageId, kind, capability: kind ? `task:${kind}` : "none", cursorEpoch: (state as any).cursor_epoch ?? null } },
    stage: stageContract,
    provenance: { statePath: resolved.statePath, profilePath: path, profileHash: pHash, stateHash: hash(JSON.parse(stateRaw)) },
  };
}

export function resolveStageInstructions(cwd: string, options: WorkflowContractOptions = {}): WorkflowStageContract {
  return resolveWorkflowContract(cwd, options).stage;
}
