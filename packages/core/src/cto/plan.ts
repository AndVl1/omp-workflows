/**
 * TeamPlan lifecycle: build + validate.
 *
 * The CTO agent (or a consumer's own orchestrator) produces a decomposition;
 * the engine validates it against the hard caps and TeamDef registry before
 * it is persisted and executed. Two-layer contract: the engine never decides
 * the decomposition itself — it guards what the orchestrator proposes.
 */

import { join, posix } from "node:path";
import { TextDecoder } from "node:util";
import { MAX_TEAMS, MAX_DECOMPOSITION_DEPTH, type CtoSharedContractConstraint, type CtoParallelizationDecision, type CtoSpecificationMapping, type CtoTaskOwnership, type TeamDef, type TeamPlan, type TeamPlanEntry, type WorktreeStrategy } from "./types.js";
import type { HandoffVerification, ImplementationHandoff } from "../specification/types.js";
import { digestOf, isSafeFeatureId } from "../specification/validation.js";
import { isSafeCtoExecutionId, isSafeCtoRunId, isValidCtoTaskText } from "./state.js";
import { MAX_CTO_MAPPING_ARTIFACT_VERSIONS, MAX_CTO_MAPPING_CONTRACTS, MAX_CTO_MAPPING_FEATURES, MAX_CTO_MAPPING_PARALLELIZATION, MAX_CTO_MAPPING_TASKS } from "../specification/mapping-record.js";
import { PinnedProjectRoot } from "../specification/pinned-root.js";

/** Canonical team identity shared by preparation and frozen mapping. */
export function ctoSpecificationTeamId(featureId: string, runKey: string | undefined, handoffDigest: string, taskId?: string): string {
  const taskProjectionId = taskId === undefined ? null : JSON.stringify({ feature_id: featureId, task_id: taskId });
  const taskProjectionDigest = taskProjectionId === null ? null : digestOf({ kind: "cto-task-projection", task_projection_id: taskProjectionId });
  return `team-${digestOf({
    kind: "cto-team",
    feature_id: featureId,
    run_key: runKey ?? null,
    handoff_digest: handoffDigest,
    task_projection_id: taskProjectionId,
    task_projection_digest: taskProjectionDigest,
  }).slice(0, 32)}`;
}


export interface PlanTeamInput {
  /** Unique execution team id; TeamDef identity is carried separately. */
  team: string;
  /** Pinned consumer TeamDef id used for role/profile metadata. */
  team_def_id?: string;
  scope: string[];
  slice: string;
  profile: string;
  worktree?: WorktreeStrategy;
  depends_on?: string[];
}

export interface PlanBuildInput {
  /** Canonical CTO run id; matches `.work-state/cto/<id>/`. */
  id: string;
  task: string;
  teams: PlanTeamInput[];
}

export type BuildResult = { ok: true; plan: TeamPlan } | { ok: false; reason: string };

/** Inputs to the pure, deterministic specification-to-CTO mapping builder. */
export interface CtoSpecificationMappingInput {
  selections: readonly {
    feature_id: string;
    run_key?: string;
    handoff: ImplementationHandoff;
  }[];
  /** Audit timestamp; omitted from mapping identity and hash. */
  created_at?: string;
  mapping_version?: number;
  cto_run_id?: string;
  execution?: { wave_id: string; source_id?: string; capability_id: string; capability_epoch: string; choice: "cto" };
}

/**
 * Build the complete T095 mapping without persistence or dispatch.
 *
 * A handoff task is one stable slice and has exactly one feature/team owner.
 * Task dependencies, repeated affected paths, and explicit handoff constraints
 * become serial shared contracts. A slice is parallel only when it is
 * explicitly parallel-safe and has no serial contract or predecessor.
 * `created_at` is deliberately outside the hashed mapping body.
 */
export function buildCtoSpecificationMapping(input: CtoSpecificationMappingInput): CtoSpecificationMapping {
  if (!input || !Array.isArray(input.selections) || input.selections.length === 0) {
    throw new Error("CTO specification mapping requires at least one selection");
  }
  if (input.selections.length > MAX_CTO_MAPPING_FEATURES) {
    throw new Error(`CTO specification mapping selections exceed ${MAX_CTO_MAPPING_FEATURES}`);
  }
  if (input.cto_run_id !== undefined && !isSafeCtoRunId(input.cto_run_id)) {
    throw new Error("CTO specification mapping cto_run_id must be a safe CTO run id");
  }
  if (input.execution !== undefined && (!isSafeCtoExecutionId(input.execution.wave_id) || (input.execution.source_id !== undefined && !isSafeCtoExecutionId(input.execution.source_id)))) {
    throw new Error("CTO specification mapping execution wave/source ids must be safe CTO execution ids");
  }

  const featureIds = input.selections.map((selection) => selection.feature_id);
  if (featureIds.some((featureId) => !isSafeFeatureId(featureId))) {
    throw new Error("CTO specification mapping feature ids must be safe non-empty ids");
  }
  if (new Set(featureIds).size !== featureIds.length) {
    throw new Error("CTO specification mapping selections must have unique feature ids");
  }
  for (const selection of input.selections) {
    if (!isSafeCtoExecutionId(selection.run_key)) {
      throw new Error(`CTO specification mapping selector for '${selection.feature_id}' requires a safe run key`);
    }
    if (!Array.isArray(selection.handoff.artifact_versions)
      || selection.handoff.artifact_versions.length > MAX_CTO_MAPPING_ARTIFACT_VERSIONS) {
      throw new Error(`CTO specification mapping handoff artifacts exceed ${MAX_CTO_MAPPING_ARTIFACT_VERSIONS}`);
    }
  }

  const bindings = input.selections.map(({ feature_id, handoff }) => ({
    feature_id,
    handoff_id: handoff.handoff_id,
    handoff_digest: handoff.handoff_digest,
    artifact_versions: handoff.artifact_versions.map((artifact: ImplementationHandoff["artifact_versions"][number]) => ({ ...artifact })),
  }));

  const taskIdentity = (featureId: string, taskId: string): string => JSON.stringify({ feature_id: featureId, task_id: taskId });
  const sliceIdentity = (featureId: string, taskId: string): string => "slice-" + digestOf({ kind: "cto-slice", feature_id: featureId, task_id: taskId }).slice(0, 32);

  const taskOwnership: CtoTaskOwnership[] = [];
  const taskRecords: Array<{
    featureId: string;
    teamId: string;
    sliceId: string;
    taskIdentity: string;
    task: ImplementationHandoff["tasks"][number];
    handoff: ImplementationHandoff;
  }> = [];
  for (const { feature_id, run_key, handoff } of input.selections) {
    if (handoff.feature_id !== feature_id || !Array.isArray(handoff.tasks) || handoff.tasks.length > MAX_CTO_MAPPING_TASKS) throw new Error(`CTO specification mapping handoff tasks exceed ${MAX_CTO_MAPPING_TASKS} or do not match feature '${feature_id}'`);
    const seenTasks = new Set<string>();
    for (const task of handoff.tasks) {
      if (!task || typeof task.task_id !== "string" || task.task_id.trim().length === 0 || seenTasks.has(task.task_id)) throw new Error(`CTO specification mapping has an invalid or duplicate task id for '${feature_id}'`);
      seenTasks.add(task.task_id);
      const sliceId = sliceIdentity(feature_id, task.task_id);
      const teamId = ctoSpecificationTeamId(feature_id, run_key, handoff.handoff_digest, task.task_id);
      const verifications = handoff.verification.filter((verification: HandoffVerification) => verification.task_ids.includes(task.task_id));
      const verificationIds = verifications.map((verification: HandoffVerification) => verification.verification_id);
      const evidenceRefs = [...new Set([
        ...task.completion_evidence,
        ...verifications.map((verification: HandoffVerification) => verification.expected_evidence),
      ])];
      if (taskOwnership.length >= MAX_CTO_MAPPING_TASKS) throw new Error(`CTO specification mapping tasks exceed ${MAX_CTO_MAPPING_TASKS}`);
      taskOwnership.push({
        feature_id,
        task_id: task.task_id,
        team_id: teamId,
        slice_id: sliceId,
        requirement_ids: [...task.requirement_ids],
        verification_ids: verificationIds,
        evidence_refs: evidenceRefs,
        depends_on: [...task.depends_on],
      });
      taskRecords.push({ featureId: feature_id, teamId, sliceId, taskIdentity: taskIdentity(feature_id, task.task_id), task, handoff });
    }
  }

  const contracts: CtoSharedContractConstraint[] = [];
  const contractKeys = new Set<string>();
  const addContract = (contract: CtoSharedContractConstraint, key: string): void => {
    if (contractKeys.has(key)) return;
    if (contracts.length >= MAX_CTO_MAPPING_CONTRACTS) {
      throw new Error(`CTO specification mapping shared contracts exceed ${MAX_CTO_MAPPING_CONTRACTS}`);
    }
    contractKeys.add(key);
    contracts.push(contract);
  };

  // Explicit handoff constraints are shared contracts even when one task is
  // currently bound: preserving them makes the mapping auditable and stable.
  for (const { feature_id, handoff } of input.selections) {
    const records = taskRecords.filter((record) => record.featureId === feature_id);
    for (const constraint of handoff.scope.constraints) {
      const taskIds = records.map((record) => record.taskIdentity).sort();
      const contractId = `contract-${digestOf({ feature_id, constraint, task_ids: taskIds }).slice(0, 24)}`;
      addContract({
        contract_id: contractId,
        contract: constraint,
        owner: JSON.stringify({ team_ids: [...new Set(records.map((record) => record.teamId))].sort() }),
        task_ids: taskIds,
        order: 0,
        reason: `The handoff explicitly serializes every owner ${JSON.stringify(records.map((record) => ({ team_id: record.teamId, slice_id: record.sliceId })))}.`,
        requires_serialization: true,
      }, JSON.stringify({ kind: "constraint", feature_id, constraint }));
    }
  }

  // Canonical project-relative resources serialize exact and ancestor/descendant overlap.
  // Any unknown or unsafe scope is conservatively serialized globally for every
  // selected task, so it can never run independently beside a known scope.
  type ScopeResource = { path: string | null; label: string; owners: typeof taskRecords };
  const resources = new Map<string, ScopeResource>();
  let hasUnknownScope = false;
  const canonicalScope = (value: unknown): string | null => {
    if (typeof value !== "string" || value.trim().length === 0 || value.includes("\\") || value.includes("\0") || posix.isAbsolute(value)) return null;
    const normalized = posix.normalize(value.trim());
    if (normalized === "." || normalized === ".." || normalized.startsWith("../")) return null;
    if (normalized.split("/").some((segment) => segment.length === 0 || segment === "." || segment === "..")) return null;
    return normalized;
  };
  for (const record of taskRecords) {
    const scopes: unknown[] = Array.isArray(record.task.affected_scope) && record.task.affected_scope.length > 0
      ? record.task.affected_scope
      : [null];
    scopes.forEach((scope) => {
      const path = canonicalScope(scope);
      if (path === null) hasUnknownScope = true;
      const key = path === null
        ? JSON.stringify({ kind: "unknown" })
        : JSON.stringify({ kind: "path", path });
      const resource = resources.get(key) ?? { path, label: path ?? "unknown affected scope", owners: [] };
      if (!resource.owners.some((owner) => owner.taskIdentity === record.taskIdentity)) resource.owners.push(record);
      resources.set(key, resource);
    });
  }
  const resourceList = [...resources.values()].sort((left, right) => left.label.localeCompare(right.label));
  const parents = resourceList.map((_, index) => index);
  const find = (index: number): number => parents[index] === index ? index : (parents[index] = find(parents[index]!));
  const union = (left: number, right: number): void => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot !== rightRoot) parents[rightRoot] = leftRoot;
  };
  const overlaps = (left: string, right: string): boolean =>
    left === right || left.startsWith(right + "/") || right.startsWith(left + "/");
  for (let left = 0; left < resourceList.length; left += 1) {
    for (let right = left + 1; right < resourceList.length; right += 1) {
      const leftPath = resourceList[left]!.path;
      const rightPath = resourceList[right]!.path;
      if (leftPath !== null && rightPath !== null && overlaps(leftPath, rightPath)) union(left, right);
    }
  }
  const components = new Map<number, ScopeResource[]>();
  resourceList.forEach((resource, index) => {
    const root = find(index);
    const component = components.get(root) ?? [];
    component.push(resource);
    components.set(root, component);
  });
  for (const component of hasUnknownScope ? [] : components.values()) {
    const owners = [...new Map(component.flatMap((resource) => resource.owners).map((owner) => [owner.taskIdentity, owner])).values()]
      .sort((left, right) => left.taskIdentity.localeCompare(right.taskIdentity));
    const hasUnknown = component.some((resource) => resource.path === null);
    if (owners.length < 2 && !hasUnknown) continue;
    const paths = component.map((resource) => resource.label).sort();
    const taskIds = owners.map((owner) => owner.taskIdentity);
    const ownerSlices = owners.map((owner) => ({ team_id: owner.teamId, slice_id: owner.sliceId }));
    const contractId = `contract-${digestOf({ kind: "affected-scope", paths, task_ids: taskIds }).slice(0, 24)}`;
    addContract({
      contract_id: contractId,
      contract: paths.join(" <-> "),
      owner: JSON.stringify({ team_ids: [...new Set(owners.map((owner) => owner.teamId))].sort() }),
      task_ids: taskIds,
      order: 0,
      reason: hasUnknown
        ? `Unknown affected scope is conservatively serialized for every owner ${JSON.stringify(ownerSlices)}.`
        : `Overlapping project-relative resources require ordered writes for every owner ${JSON.stringify(ownerSlices)}.`,
      requires_serialization: true,
    }, JSON.stringify({ kind: "affected-scope", paths, task_ids: taskIds }));
  }
  if (hasUnknownScope) {
    const recordsByIdentity = new Map(taskRecords.map((record) => [record.taskIdentity, record]));
    const remaining = new Set(taskRecords.map((record) => record.taskIdentity));
    const orderedTaskIds: string[] = [];
    while (remaining.size > 0) {
      const ready = [...remaining]
        .map((identity) => recordsByIdentity.get(identity)!)
        .filter((record) => record.task.depends_on.every((dependency) => {
          const predecessor = recordsByIdentity.get(taskIdentity(record.featureId, dependency));
          return !predecessor || !remaining.has(predecessor.taskIdentity);
        }))
        .sort((left, right) => left.taskIdentity.localeCompare(right.taskIdentity));
      if (ready.length === 0) throw new Error("CTO specification mapping contains an unresolvable task dependency cycle");
      const next = ready[0]!;
      orderedTaskIds.push(next.taskIdentity);
      remaining.delete(next.taskIdentity);
    }
    const ownerSlices = taskRecords.map((owner) => ({ team_id: owner.teamId, slice_id: owner.sliceId }));
    const contractId = `contract-${digestOf({ kind: "affected-scope-global", task_ids: orderedTaskIds }).slice(0, 24)}`;
    addContract({
      contract_id: contractId,
      contract: "unknown affected scope (global)",
      owner: JSON.stringify({ team_ids: [...new Set(taskRecords.map((owner) => owner.teamId))].sort() }),
      task_ids: orderedTaskIds,
      order: 0,
      reason: `Unknown or unsafe affected scope is conservatively serialized for every selected owner ${JSON.stringify(ownerSlices)}.`,
      requires_serialization: true,
    }, JSON.stringify({ kind: "affected-scope-global", task_ids: orderedTaskIds }));
  }

  // Every predecessor edge is explicit in the mapping, not inferred from
  // dispatch order. This also gives dependent slices a stable serial reason.
  for (const record of taskRecords) {
    for (const dependency of record.task.depends_on) {
      const dependencyRecord = taskRecords.find((candidate) => candidate.featureId === record.featureId && candidate.task.task_id === dependency);
      const predecessorIdentity = dependencyRecord?.taskIdentity ?? taskIdentity(record.featureId, dependency);
      const taskIds = [predecessorIdentity, record.taskIdentity];
      const contractId = `contract-${digestOf({ feature_id: record.featureId, dependency, task: record.task.task_id }).slice(0, 24)}`;
      addContract({
        contract_id: contractId,
        contract: `task dependency ${predecessorIdentity} -> ${record.taskIdentity}`,
        owner: JSON.stringify({ team_ids: [record.teamId] }),
        task_ids: taskIds,
        order: 0,
        reason: `The task graph serializes owners ${JSON.stringify(taskIds)} in predecessor order.`,
        requires_serialization: true,
      }, JSON.stringify({ kind: "dependency", feature_id: record.featureId, dependency, task: record.task.task_id }));
    }
  }

  contracts.sort((left, right) => left.contract_id.localeCompare(right.contract_id));
  const contractByTask = new Map<string, Map<string, string[]>>();
  for (const contract of contracts) {
    for (const qualifiedTaskId of contract.task_ids) {
      const record = taskRecords.find((candidate) => candidate.taskIdentity === qualifiedTaskId);
      if (!record) continue;
      const featureContracts = contractByTask.get(record.featureId) ?? new Map<string, string[]>();
      const ids = featureContracts.get(record.task.task_id) ?? [];
      ids.push(contract.contract_id);
      featureContracts.set(record.task.task_id, ids);
      contractByTask.set(record.featureId, featureContracts);
    }
  }
  const parallelization: CtoParallelizationDecision[] = taskRecords.map((record) => {
    const ownContracts = [...(contractByTask.get(record.featureId)?.get(record.task.task_id) ?? [])].sort();
    const dependencySlices = record.task.depends_on.map((dependency) => {
      const predecessor = taskRecords.find((candidate) => candidate.featureId === record.featureId && candidate.task.task_id === dependency);
      return predecessor?.sliceId ?? sliceIdentity(record.featureId, dependency);
    });
    const serial = !record.task.parallel_safe || dependencySlices.length > 0 || ownContracts.length > 0;
    const reason = !record.task.parallel_safe
      ? "The handoff marks this task as not parallel-safe."
      : dependencySlices.length > 0
        ? "The task depends on a predecessor and must wait for its output."
        : ownContracts.length > 0
          ? "Every owner of an overlapping or unknown resource is serialized by an explicit shared contract."
          : "The task has no shared resources or dependencies and may run independently.";
    return {
      slice_id: record.sliceId,
      decision: serial ? "serial" : "parallel",
      reason,
      worktree: serial ? "same_branch" : "separate_worktree",
      depends_on_slice_ids: dependencySlices,
      shared_contract_ids: ownContracts,
    };
  });

  const body = {
    schema_version: 1 as const,
    mapping_version: input.mapping_version ?? 1,
    ...(input.cto_run_id ? { cto_run_id: input.cto_run_id } : {}),
    ...(input.execution ? { execution: { ...input.execution } } : {}),
    feature_ids: [...featureIds],
    selections: input.selections.map((selection) => ({ feature_id: selection.feature_id, run_key: selection.run_key ?? null })),
    execution_choice: "cto" as const,
    handoff_bindings: bindings,
    task_to_slice: taskOwnership,
    shared_contracts: contracts,
    parallelization,
    checkpoint_ref: null,
    status: "awaiting_confirmation" as const,
  };
  const mappingHash = digestOf(body);
  return {
    ...body,
    mapping_id: `cto-mapping-${mappingHash.slice(0, 32)}`,
    mapping_hash: mappingHash,
    created_at: input.created_at ?? new Date().toISOString(),
  };
}

/**
 * TeamDef registry loader: reads the consumer-owned `.omp/teams.json`
 * (array of {@link TeamDef}). Missing/malformed file -> empty array (never
 * throws). Consumers may also pass TeamDef[] directly to the engine.
 */
function boundedTeamString(value: unknown): value is string {
  return typeof value === "string"
    && value.trim().length > 0
    && Buffer.byteLength(value, "utf8") <= MAX_TEAM_DEF_STRING_BYTES
    && !/[\u0000-\u001f\u007f]/u.test(value);
}

function nonBlankUniqueStrings(value: unknown, maxEntries = MAX_TEAM_DEF_ARRAY_ENTRIES): value is string[] {
  return Array.isArray(value)
    && value.length <= maxEntries
    && value.every((item) => boundedTeamString(item))
    && new Set(value).size === value.length;
}

const MAX_TEAM_DEFS = 64;
const MAX_TEAM_DEF_STRING_BYTES = 1024;
const MAX_TEAM_DEF_ARRAY_ENTRIES = 128;
const MAX_TEAM_DEFS_BYTES = 256 * 1024;
const TEAM_DEF_KEYS = new Set(["id", "name", "scope", "profile", "lead", "roster"]);

function validTeamDef(value: unknown): value is TeamDef {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  if (keys.length !== TEAM_DEF_KEYS.size || keys.some((key) => !TEAM_DEF_KEYS.has(key))) return false;
  const team = value as Partial<TeamDef>;
  return Object.hasOwn(team, "id")
    && Object.hasOwn(team, "name")
    && Object.hasOwn(team, "scope")
    && Object.hasOwn(team, "profile")
    && Object.hasOwn(team, "lead")
    && Object.hasOwn(team, "roster")
    && typeof team.id === "string" && isSafeCtoRunId(team.id) && boundedTeamString(team.id)
    && boundedTeamString(team.name)
    && boundedTeamString(team.profile)
    && boundedTeamString(team.lead)
    && nonBlankUniqueStrings(team.scope)
    && nonBlankUniqueStrings(team.roster);
}

function safelyValidTeamDef(value: unknown): value is TeamDef {
  try {
    return validTeamDef(value);
  } catch {
    return false;
  }
}

function parseTeamDefs(raw: unknown): TeamDef[] {
  if (!Array.isArray(raw) || raw.length > MAX_TEAM_DEFS) return [];
  let aggregateBytes = 2;
  for (const entry of raw) {
    if (!safelyValidTeamDef(entry)) return [];
    aggregateBytes += Buffer.byteLength(JSON.stringify(entry), "utf8") + 1;
    if (aggregateBytes > MAX_TEAM_DEFS_BYTES) return [];
  }
  if (new Set(raw.map((entry) => entry.id)).size !== raw.length) return [];
  const scopes = new Set<string>();
  for (const entry of raw) {
    for (const scope of entry.scope) {
      if (scopes.has(scope)) return [];
      scopes.add(scope);
    }
  }
  return raw.map((entry) => ({ ...entry, scope: [...entry.scope], roster: [...entry.roster] }));
}

/**
 * Read the consumer-owned TeamDef registry through an already-open pinned
 * project root. The pin is borrowed and remains owned by the caller.
 */
export function loadTeamDefsPinned(_cwd: string, pinnedRoot: PinnedProjectRoot): TeamDef[] {
  try {
    if (!pinnedRoot.isStable()) return [];
    const bytes = pinnedRoot.readFile(".omp/teams.json", { maxBytes: MAX_TEAM_DEFS_BYTES }).bytes;
    if (!pinnedRoot.isStable()) return [];
    const raw = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return parseTeamDefs(JSON.parse(raw) as unknown);
  } catch {
    return [];
  }
}

export function loadTeamDefs(cwd: string): TeamDef[] {
  const pinnedRoot = PinnedProjectRoot.open(cwd);
  if (!pinnedRoot) return [];
  try {
    return loadTeamDefsPinned(cwd, pinnedRoot);
  } finally {
    pinnedRoot.close();
  }
}

/**
 * Build a TeamPlan and validate it. Returns a reason on any violation:
 * caps (MAX_TEAMS), unknown team ids, depends_on cycles or dangling refs.
 */
export function buildTeamPlan(input: PlanBuildInput, defs: Record<string, TeamDef> | Map<string, TeamDef>): BuildResult {
  if (!input || !isValidCtoTaskText(input.task)) return { ok: false, reason: "plan needs a canonical non-blank task (UTF-8 <= 256 KiB)" };
  if (!input.id) return { ok: false, reason: "plan needs { id, task }" };
  if (!isSafeCtoRunId(input.id)) {
    return { ok: false, reason: `plan id must be a safe CTO run id, got: ${input.id}` };
  }
  if (!Array.isArray(input.teams)) return { ok: false, reason: "plan.teams must be an array" };
  if (input.teams.length === 0) return { ok: false, reason: "plan.teams is empty — nothing to orchestrate" };
  if (input.teams.length > MAX_TEAMS) {
    return { ok: false, reason: `plan has ${input.teams.length} teams, cap is ${MAX_TEAMS}` };
  }

  const registryEntries = defs instanceof Map ? [...defs.entries()] : Object.entries(defs ?? {});
  if (registryEntries.length > MAX_TEAM_DEFS) return { ok: false, reason: `team definition registry exceeds ${MAX_TEAM_DEFS} entries` };
  const registry = new Map<string, TeamDef>();
  const registryScopes = new Set<string>();
  let registryBytes = 2;
  for (const [key, candidate] of registryEntries) {
    if (!safelyValidTeamDef(candidate) || key !== candidate.id || registry.has(candidate.id)) {
      return { ok: false, reason: `invalid or duplicate team definition: ${String(key)}` };
    }
    registryBytes += Buffer.byteLength(JSON.stringify(candidate), "utf8") + 1;
    if (registryBytes > MAX_TEAM_DEFS_BYTES) return { ok: false, reason: `team definition registry exceeds ${MAX_TEAM_DEFS_BYTES} bytes` };
    for (const scope of candidate.scope) {
      if (registryScopes.has(scope)) return { ok: false, reason: `duplicate team scope: ${scope}` };
      registryScopes.add(scope);
    }
    registry.set(candidate.id, candidate);
  }

  const entries: TeamPlanEntry[] = [];
  const seen = new Set<string>();
  for (const candidate of input.teams) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return { ok: false, reason: "plan team entries must be objects" };
    const t = candidate as PlanTeamInput;
    if (typeof t.team !== "string" || t.team.trim().length === 0) return { ok: false, reason: "plan team id must be non-blank" };
    if (!isSafeCtoRunId(t.team)) return { ok: false, reason: `plan execution team id must be a safe canonical id: ${t.team}` };
    const teamDefId = t.team_def_id ?? t.team;
    if (typeof teamDefId !== "string" || teamDefId.trim().length === 0) return { ok: false, reason: `${t.team} team_def_id must be non-blank` };
    const def = registry.get(teamDefId);
    if (!def) return { ok: false, reason: `unknown team definition id: ${teamDefId}` };
    if (seen.has(t.team)) return { ok: false, reason: `duplicate team id in plan: ${t.team}` };
    if (t.scope !== undefined && !nonBlankUniqueStrings(t.scope)) return { ok: false, reason: `${t.team} scope must be a unique non-blank string array` };
    if (t.profile !== undefined && (typeof t.profile !== "string" || t.profile.trim().length === 0)) return { ok: false, reason: `${t.team} profile must be non-blank` };
    if (t.depends_on !== undefined && !nonBlankUniqueStrings(t.depends_on)) return { ok: false, reason: `${t.team} depends_on must be a unique non-blank string array` };
    const scope = t.scope === undefined ? def.scope : t.scope;
    const profile = t.profile === undefined ? def.profile : t.profile;
    const dependencies = t.depends_on === undefined ? [] : t.depends_on;
    if (typeof t.slice !== "string" || !isSafeCtoRunId(t.slice)) return { ok: false, reason: `${t.team} slice must be a safe non-blank id` };
    if (typeof profile !== "string" || profile.trim().length === 0) return { ok: false, reason: `${t.team} profile must be non-blank` };
    if (!nonBlankUniqueStrings(dependencies) || dependencies.some((dependency) => !isSafeCtoRunId(dependency))) return { ok: false, reason: `${t.team} depends_on must be a unique canonical safe id array` };
    if (t.worktree !== undefined && t.worktree !== "same_branch" && t.worktree !== "separate_worktree") return { ok: false, reason: `${t.team} worktree strategy is invalid` };
    seen.add(t.team);
    entries.push({ team: t.team, team_def_id: def.id, scope: [...scope], slice: t.slice, profile, worktree: t.worktree ?? "same_branch", depends_on: [...dependencies] });
  }

  // depends_on: dangling refs + cycles (DFS on the team graph).
  for (const entry of entries) {
    for (const dep of entry.depends_on) {
      if (!seen.has(dep)) return { ok: false, reason: `${entry.team} depends on unknown team: ${dep}` };
    }
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (teamId: string): boolean => {
    if (visiting.has(teamId)) return false; // cycle
    if (visited.has(teamId)) return true;
    visiting.add(teamId);
    const entry = entries.find((e) => e.team === teamId);
    const deps = entry ? entry.depends_on : [];
    for (const dep of deps) {
      if (!visit(dep)) return false;
    }
    visiting.delete(teamId);
    visited.add(teamId);
    return true;
  };
  for (const entry of entries) {
    if (!visit(entry.team)) {
      return { ok: false, reason: `depends_on cycle detected involving: ${entry.team}` };
    }
  }

  return {
    ok: true,
    plan: { id: input.id, task: input.task, teams: entries, created_at: new Date().toISOString() },
  };
}

/**
 * Decomposition depth of a plan: 1 for a flat plan; a team whose sub-profile
 * itself contains `type: team` stages adds a level. The consumer supplies a
 * `profileDepth` loader when it can see sub-profile contents; without one the
 * plan is assumed flat (depth 1). Enforces MAX_DECOMPOSITION_DEPTH (2).
 */
export function validateDecompositionDepth(
  plan: TeamPlan,
  profileDepth?: (profile: string) => number,
): { ok: true; depth: number } | { ok: false; reason: string; depth: number } {
  if (!profileDepth) return { ok: true, depth: 1 };
  let depth = 1;
  for (const entry of plan.teams) {
    const nestedDepth = profileDepth(entry.profile);
    if (!Number.isFinite(nestedDepth) || !Number.isInteger(nestedDepth) || nestedDepth < 0) {
      return { ok: false, reason: `invalid decomposition depth ${String(nestedDepth)} for profile ${entry.profile}`, depth: nestedDepth };
    }
    depth = Math.max(depth, 1 + nestedDepth);
  }
  if (depth > MAX_DECOMPOSITION_DEPTH) {
    return {
      ok: false,
      reason: `decomposition depth ${depth} exceeds cap ${MAX_DECOMPOSITION_DEPTH} (CTO -> team -> sub-team)`,
      depth,
    };
  }
  return { ok: true, depth };
}
