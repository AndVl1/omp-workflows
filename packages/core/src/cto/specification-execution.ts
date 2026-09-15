/**
 * Engine-owned fresh CTO specification execution preparation.
 *
 * This boundary is the only supported way to create the active execution wave
 * consumed by the public preflight/confirm/dispatch seams. It validates the
 * caller's explicit decomposition, persists typed state/DoD artifacts through
 * pinned-root and run-lock APIs, and never starts a worker.
 */

import { createHash } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { posix, resolve } from "node:path";
import { prepareWorkflowStatePinned, type ModelClassification } from "../engine/run.js";
import { createCapability, readTrustedTaskResultReceipt, type IssuedCapability } from "../engine/durable.js";
import { assertCtoRuntimeAccessFacadeLive, CtoRuntimeAccessError, isSafeCtoRuntimeSessionId, type CtoRuntimeAccessFacade } from "./runtime-access.js";
import { MAX_PERSISTED_STATE_BYTES, resolvePreparationStatePinned, resolveStatePinned, updateStateAtomically, parseBoundedPersistedState } from "../engine/state.js";
import { validateTypedControlPlane } from "../engine/workflow-contract.js";
import { loadProfile, profileHash, resolveWorkflowForClassification } from "../engine/profile.js";
import type { DoD, TeamState, WorkIdentity, WorkflowName } from "../engine/types.js";
import {
  isSafeCtoExecutionId,
  isSafeCtoRunId,
  newCtoState,
  ctoRuntimeRunInitialIdentityDigest,
  readCtoStatePinned,
  setTeamStatus,
} from "./state.js";
import type {
  CtoSpecificationPreparationFileImage,
  CtoSpecificationPreparationTransaction,
  CtoState,
  TeamDef,
  WorktreeStrategy,
} from "./types.js";
import { buildCtoSpecificationMapping, buildTeamPlan, ctoSpecificationTeamId, loadTeamDefsPinned, validateDecompositionDepth, type PlanTeamInput } from "./plan.js";
import { preflightCtoSpecificationExecutionPinned as validateSpecificationSelection } from "./gates.js";
import type { CtoSpecificationExecutionSelection } from "./gates.js";
import type { FeatureWorkspace, ImplementationHandoff } from "../specification/types.js";
import { resolveFeatureWorkspace } from "../specification/workspace.js";
import { readCurrentExecutionClaim } from "../specification/claims.js";
import { readCanonicalHandoff } from "../specification/canonical-reader.js";
import { canonicalJson, digestOf } from "../specification/validation.js";
import { PinnedProjectRoot, PinnedRootError, type PinnedRootFileExpectation } from "../specification/pinned-root.js";
import { readPinnedCurrentConstitution } from "../specification/constitution-identities.js";
import { currentConstitutionPersistenceIssue } from "../specification/prerequisite.js";
import { canonicalCtoDoDDigest, writeCtoDoDExclusive } from "./dod.js";
import { assertCtoWorkerTaskDispatchable, parseCtoSliceMarker } from "./slice-gate.js";
import { MAX_DOD_BYTES, readDoDFilePinned } from "../engine/dod.js";
import {
  MAX_CTO_SPECIFICATION_AGGREGATE_BYTES,
  MAX_CTO_SPECIFICATION_DEPENDENCIES,
  MAX_CTO_SPECIFICATION_DOD_ITEMS,
  MAX_CTO_SPECIFICATION_ID_BYTES,
  MAX_CTO_SPECIFICATION_REQUESTS,
  MAX_CTO_SPECIFICATION_SCOPE_ENTRIES,
  MAX_CTO_SPECIFICATION_TEAMS,
  MAX_CTO_SPECIFICATION_TEXT_BYTES,
  isCtoSpecificationSafeId,
  isCtoSpecificationText,
} from "./types.js";

export interface CtoSpecificationPreparationTaskRef {
  feature_id: string;
  task_id: string;
}

export interface CtoSpecificationPreparationDoD extends Omit<DoD, "updated_at"> {
  updated_at?: string;
}

export interface CtoSpecificationPreparationTeam {
  /** TeamDef id from the pinned consumer registry. */
  team: string;
  task_ref: CtoSpecificationPreparationTaskRef;
  scope?: string[];
  profile?: string;
  worktree?: WorktreeStrategy;
  depends_on?: string[];
  classification: ModelClassification;
  workflow?: WorkflowName;
  dod: CtoSpecificationPreparationDoD;
}

export interface CtoSpecificationExecutionPreparationInput {
  cto_run_id: string;
  task: string;
  branch: string;
  classification: ModelClassification;
  selections: readonly CtoSpecificationExecutionSelection[];
  teams: readonly CtoSpecificationPreparationTeam[];
  wave_id?: string;
  source_id?: string;
}
export interface CtoSpecificationExecutionExcludedSelection {
  feature_id: string;
  run_key: string;
  findings: string[];
}

export interface CtoSpecificationPreparedSelectionReport {
  /** Exact public selector order, including excluded rows. */
  requested_selections: CtoSpecificationExecutionSelection[];
  /** Rows admitted into this wave after read-only eligibility checks. */
  eligible_selections: CtoSpecificationExecutionSelection[];
  /** Rows retained as findings instead of being silently dropped. */
  excluded: CtoSpecificationExecutionExcludedSelection[];
}

export interface CtoSpecificationPreparedSlice {
  feature_id: string;
  run_key: string;
  task_id: string;
  team_id: string;
  team_def_id: string;
  slice_id: string;
  dod_path: string;
  work_identity: WorkIdentity;
}

export interface CtoSpecificationExecutionPreparationReady extends CtoSpecificationPreparedSelectionReport {
  status: "ready";
  prepared: true;
  dispatched: false;
  cto_run_id: string;
  wave_id: string;
  source_id: string;
  capability_id: string;
  capability_epoch: string;
  /** Exact feature/run state used by the mounted confirmation proof. */
  confirmation_anchor: CtoSpecificationExecutionSelection;
  slices: CtoSpecificationPreparedSlice[];
}

export interface CtoSpecificationExecutionPreparationBlocked extends CtoSpecificationPreparedSelectionReport {
  status: "blocked";
  prepared: false;
  dispatched: false;
  findings: string[];
}

export type CtoSpecificationExecutionPreparationResult =
  | CtoSpecificationExecutionPreparationReady
  | CtoSpecificationExecutionPreparationBlocked;

export type CtoSpecificationPreparationFailurePoint = "after_dod_write" | "after_feature_capability_write" | "before_wave_commit";

export interface CtoSpecificationPreparationTestHooks {
  afterWrite?: (point: CtoSpecificationPreparationFailurePoint, featureId: string) => void;
  beforeAnchorBind?: (featureId: string) => void;
  afterAnchorBindFailure?: (context: { feature_id: string; code: string; error: string }) => void;
  afterEligibilityGate?: (featureId: string) => void;
  beforePreparationRestore?: (featureId: string) => void;
}

export type CtoSpecificationExecutionTeamReconciliationResult = {
  status: "reconciled"; reconciled_team_ids: string[]; findings: string[];
} | { status: "blocked"; reconciled_team_ids: string[]; findings: string[] };

export interface ReconcileCtoSpecificationExecutionTeamsOptions {
  runtimeAccess: CtoRuntimeAccessFacade;
  sessionId: string;
  pinnedRoot?: PinnedProjectRoot;
}

export interface CtoSpecificationTaskAuthorizationEvent {
  toolName?: string; toolCallId?: string; input?: unknown;
}
export interface CtoSpecificationTaskAuthorizationOptions {
  runtimeAccess: CtoRuntimeAccessFacade; sessionId: string; pinnedRoot?: PinnedProjectRoot;
}
export type CtoSpecificationTaskAuthorizationResult = {
  ok: true; feature_id: string; run_key: string; slice_id: string; team_id: string; task_id: string; dispatch_id: string; tool_call_id: string; work_identity: WorkIdentity;
} | { ok: false; reason: string };

export interface PrepareCtoSpecificationExecutionOptions {
  defs: readonly TeamDef[] | Record<string, TeamDef> | Map<string, TeamDef>;
  profileDepth?: (profile: string) => number;
  /** Genuine live RuntimeAccess for the same pinned project root. */
  runtimeAccess: CtoRuntimeAccessFacade;
  /** Exact non-blank host manager session identity. */
  sessionId: string;
  /** Borrowed root pin held by the mounted caller through state commit. */
  pinnedRoot?: PinnedProjectRoot;
}

const SAFE_ID = /^[A-Za-z0-9._-]{1,128}$/u;
const SAFE_FEATURE = /^[a-z0-9][a-z0-9._-]{0,127}$/u;
const WORKFLOWS = new Set<WorkflowName>([
  "full-feature", "standard", "lightweight", "debug-cycle", "bug-fix", "emergency",
  "research", "lecture-research", "review", "spec-preparation", "feature-regression",
  "product-discovery",
]);

function blocked(...findings: string[]): CtoSpecificationExecutionPreparationBlocked {
  return { status: "blocked", prepared: false, dispatched: false, requested_selections: [], eligible_selections: [], excluded: [], findings };
}

function blockedWithSelectionReport(
  requested: readonly CtoSpecificationExecutionSelection[],
  eligible: readonly CtoSpecificationExecutionSelection[],
  excluded: readonly CtoSpecificationExecutionExcludedSelection[],
  extraFindings: readonly string[] = [],
): CtoSpecificationExecutionPreparationBlocked {
  return {
    status: "blocked",
    prepared: false,
    dispatched: false,
    requested_selections: requested.map((selection) => ({ ...selection })),
    eligible_selections: eligible.map((selection) => ({ ...selection })),
    excluded: excluded.map((entry) => ({ ...entry, findings: [...entry.findings] })),
    findings: [...excluded.flatMap((entry) => entry.findings), ...extraFindings],
  };
}


function defsMap(defs: PrepareCtoSpecificationExecutionOptions["defs"]): Map<string, TeamDef> {
  if (defs instanceof Map) return new Map(defs);
  if (Array.isArray(defs)) return new Map(defs.map((def) => [def.id, def]));
  return new Map(Object.entries(defs));
}
function teamDefsDigest(defs: Map<string, TeamDef>): string {
  return digestOf([...defs.values()]
    .map((def) => ({
      id: def.id,
      name: def.name,
      scope: [...def.scope],
      profile: def.profile,
      lead: def.lead,
      roster: [...def.roster],
    }))
    .sort((left, right) => left.id.localeCompare(right.id)));
}

function pinnedTeamDefsMatch(root: PinnedProjectRoot, defs: Map<string, TeamDef>): boolean {
  return teamDefsDigest(defsMap(loadTeamDefsPinned(root.canonical_root, root))) === teamDefsDigest(defs);
}

function classifyError(classification: ModelClassification | undefined, label: string): string | null {
  if (!classification || typeof classification !== "object") return `${label}.classification is required`;
  if (!(["FEATURE", "REFACTOR", "OPS", "BUG_FIX", "SPEC", "REGRESS", "INVESTIGATION", "LECTURE_RESEARCH", "REVIEW", "HOTFIX", "PRODUCT_DISCOVERY"] as string[]).includes(classification.type)) return `${label}.classification.type is invalid`;
  if (!( ["QUICK", "MEDIUM", "COMPLEX", "CRITICAL"] as string[]).includes(classification.complexity)) return `${label}.classification.complexity is invalid`;
  if (!( ["HIGH", "MEDIUM", "LOW"] as string[]).includes(classification.confidence)) return `${label}.classification.confidence is invalid`;
  if (typeof classification.autonomous !== "boolean") return `${label}.classification.autonomous is required`;
  let resolved: WorkflowName;
  try { resolved = resolveWorkflowForClassification(classification); } catch (error) { return `${label}.classification workflow is invalid: ${String(error)}`; }
  if (classification.workflow !== undefined && (typeof classification.workflow !== "string" || !WORKFLOWS.has(classification.workflow))) return `${label}.classification.workflow is invalid`;
  if (classification.workflow !== undefined && classification.workflow !== resolved) return `${label}.classification.workflow must equal '${resolved}'`;
  return null;
}
function normalizedTopLevelClassification(classification: ModelClassification, workflow: WorkflowName): Record<string, unknown> {
  return {
    type: classification.type,
    complexity: classification.complexity,
    confidence: classification.confidence,
    autonomous: classification.autonomous,
    autonomous_reason: classification.autonomous_reason ?? null,
    workflow,
  };
}
function validatePreparationText(value: unknown, label: string, allowEmpty = false): string | null {
  return isCtoSpecificationText(value, MAX_CTO_SPECIFICATION_TEXT_BYTES, allowEmpty)
    ? null
    : `${label} must be bounded line-inert text of at most ${MAX_CTO_SPECIFICATION_TEXT_BYTES} UTF-8 bytes`;
}

function validatePreparationId(value: unknown, label: string): string | null {
  return isCtoSpecificationSafeId(value)
    ? null
    : `${label} must be a safe identifier of at most ${MAX_CTO_SPECIFICATION_ID_BYTES} UTF-8 bytes`;
}

function validatePreparationClassification(classification: unknown, label: string): string | null {
  if (!classification || typeof classification !== "object" || Array.isArray(classification)) return `${label} must be an object`;
  const candidate = classification as ModelClassification;
  for (const [field, value] of [["type", candidate.type], ["complexity", candidate.complexity], ["confidence", candidate.confidence]] as const) {
    const issue = validatePreparationId(value, `${label}.${field}`);
    if (issue) return issue;
  }
  if (typeof candidate.autonomous !== "boolean") return `${label}.autonomous must be boolean`;
  if (candidate.autonomous_reason !== undefined) {
    const issue = validatePreparationText(candidate.autonomous_reason, `${label}.autonomous_reason`, true);
    if (issue) return issue;
  }
  if (candidate.workflow !== undefined) {
    const issue = validatePreparationId(candidate.workflow, `${label}.workflow`);
    if (issue) return issue;
  }
  return null;
}

function validatePreparationDod(dod: unknown, label: string, aggregate: { bytes: number }): string | null {
  if (!dod || typeof dod !== "object" || Array.isArray(dod)) return `${label} must be an object`;
  const candidate = dod as Partial<CtoSpecificationPreparationDoD>;
  if (!Array.isArray(candidate.items) || candidate.items.length === 0) return `${label}.items must be non-empty`;
  if (candidate.items.length > MAX_CTO_SPECIFICATION_DOD_ITEMS) return `${label}.items must contain at most ${MAX_CTO_SPECIFICATION_DOD_ITEMS} entries`;
  for (const [index, item] of candidate.items.entries()) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return `${label}.items[${index}] must be an object`;
    const value = item as Partial<DoD["items"][number]>;
    const idIssue = validatePreparationId(value.id, `${label}.items[${index}].id`);
    if (idIssue) return idIssue;
    for (const [field, fieldValue] of [["source", value.source], ["criterion", value.criterion], ["verify_method", value.verify_method]] as const) {
      const issue = validatePreparationText(fieldValue, `${label}.items[${index}].${field}`);
      if (issue) return issue;
      aggregate.bytes += Buffer.byteLength(fieldValue as string, "utf8");
    }
    if (typeof value.evidence !== "string") return `${label}.items[${index}].evidence is required`;
    const evidenceIssue = validatePreparationText(value.evidence, `${label}.items[${index}].evidence`, true);
    if (evidenceIssue) return evidenceIssue;
    aggregate.bytes += Buffer.byteLength(value.id as string, "utf8") + Buffer.byteLength(value.evidence, "utf8");
    if (value.status !== "pending" && value.status !== "met") return `${label}.items[${index}].status must be pending or met`;
    if (value.status === "met" && value.evidence.trim().length === 0) return `${label}.items[${index}] met evidence is required`;
  }
  if (candidate.type_requirements_met !== true) return `${label}.type_requirements_met must be true`;
  if (candidate.updated_at !== undefined) {
    const updatedIssue = validatePreparationText(candidate.updated_at, `${label}.updated_at`);
    if (updatedIssue) return updatedIssue;
    aggregate.bytes += Buffer.byteLength(candidate.updated_at, "utf8");
  }
  return null;
}

function validatePreparationInput(input: CtoSpecificationExecutionPreparationInput): string | null {
  const runIssue = validatePreparationId(input.cto_run_id, "cto_run_id");
  if (runIssue || !isSafeCtoRunId(input.cto_run_id)) return runIssue ?? "cto_run_id must be a safe CTO run id";
  for (const [field, value] of [["task", input.task], ["branch", input.branch]] as const) {
    const issue = validatePreparationText(value, field);
    if (issue) return issue;
  }
  const aggregate = { bytes: Buffer.byteLength(input.task, "utf8") + Buffer.byteLength(input.branch, "utf8") };
  const classificationIssue = validatePreparationClassification(input.classification, "classification");
  if (classificationIssue) return classificationIssue;
  if (input.classification.autonomous_reason !== undefined) aggregate.bytes += Buffer.byteLength(input.classification.autonomous_reason, "utf8");
  if (input.classification.workflow !== undefined) aggregate.bytes += Buffer.byteLength(input.classification.workflow, "utf8");
  if (!Array.isArray(input.selections) || input.selections.length === 0) return "at least one explicit feature/run selection is required";
  if (input.selections.length > MAX_CTO_SPECIFICATION_REQUESTS) return `selections must contain at most ${MAX_CTO_SPECIFICATION_REQUESTS} entries`;
  for (const [index, selection] of input.selections.entries()) {
    if (!selection || typeof selection !== "object" || Array.isArray(selection)) return `selections[${index}] must be an object`;
    const featureIssue = validatePreparationId(selection.feature_id, `selections[${index}].feature_id`);
    if (featureIssue || !SAFE_FEATURE.test(selection.feature_id)) return featureIssue ?? `selections[${index}].feature_id must be a safe feature id`;
    const runKeyIssue = validatePreparationId(selection.run_key, `selections[${index}].run_key`);
    if (runKeyIssue) return runKeyIssue;
    aggregate.bytes += Buffer.byteLength(selection.feature_id, "utf8") + Buffer.byteLength(selection.run_key, "utf8");
  }
  if (!Array.isArray(input.teams) || input.teams.length === 0) return "at least one explicit team/task mapping is required";
  if (input.teams.length > MAX_CTO_SPECIFICATION_TEAMS) return `teams must contain at most ${MAX_CTO_SPECIFICATION_TEAMS} entries`;
  for (const [index, team] of input.teams.entries()) {
    const label = `teams[${index}]`;
    if (!team || typeof team !== "object" || Array.isArray(team)) return `${label} must be an object`;
    const teamIssue = validatePreparationId(team.team, `${label}.team`);
    if (teamIssue) return teamIssue;
    const taskRef = team.task_ref;
    if (!taskRef || typeof taskRef !== "object" || Array.isArray(taskRef)) return `${label}.task_ref must be an object`;
    const featureIssue = validatePreparationId(taskRef.feature_id, `${label}.task_ref.feature_id`);
    if (featureIssue || !SAFE_FEATURE.test(taskRef.feature_id)) return featureIssue ?? `${label}.task_ref.feature_id must be a safe feature id`;
    const taskIssue = validatePreparationId(taskRef.task_id, `${label}.task_ref.task_id`);
    if (taskIssue) return taskIssue;
    aggregate.bytes += Buffer.byteLength(team.team, "utf8") + Buffer.byteLength(taskRef.feature_id, "utf8") + Buffer.byteLength(taskRef.task_id, "utf8");
    for (const [field, value] of [["profile", team.profile], ["workflow", team.workflow]] as const) {
      if (value === undefined) continue;
      const issue = validatePreparationId(value, `${label}.${field}`);
      if (issue) return issue;
      aggregate.bytes += Buffer.byteLength(value, "utf8");
    }
    if (team.scope !== undefined) {
      if (!Array.isArray(team.scope) || team.scope.length > MAX_CTO_SPECIFICATION_SCOPE_ENTRIES) return `${label}.scope must contain at most ${MAX_CTO_SPECIFICATION_SCOPE_ENTRIES} entries`;
      for (const [scopeIndex, scope] of team.scope.entries()) {
        const issue = validatePreparationText(scope, `${label}.scope[${scopeIndex}]`);
        if (issue) return issue;
        aggregate.bytes += Buffer.byteLength(scope, "utf8");
      }
    }
    if (team.depends_on !== undefined) {
      if (!Array.isArray(team.depends_on) || team.depends_on.length > MAX_CTO_SPECIFICATION_DEPENDENCIES) return `${label}.depends_on must contain at most ${MAX_CTO_SPECIFICATION_DEPENDENCIES} entries`;
      for (const [dependencyIndex, dependency] of team.depends_on.entries()) {
        const issue = validatePreparationId(dependency, `${label}.depends_on[${dependencyIndex}]`);
        if (issue) return issue;
        aggregate.bytes += Buffer.byteLength(dependency, "utf8");
      }
    }
    const teamClassificationIssue = validatePreparationClassification(team.classification, `${label}.classification`);
    if (teamClassificationIssue) return teamClassificationIssue;
    if (team.classification.autonomous_reason !== undefined) aggregate.bytes += Buffer.byteLength(team.classification.autonomous_reason, "utf8");
    if (team.classification.workflow !== undefined) aggregate.bytes += Buffer.byteLength(team.classification.workflow, "utf8");
    const dodIssue = validatePreparationDod(team.dod, `${label}.dod`, aggregate);
    if (dodIssue) return dodIssue;
  }
  return aggregate.bytes > MAX_CTO_SPECIFICATION_AGGREGATE_BYTES
    ? `preparation payload exceeds ${MAX_CTO_SPECIFICATION_AGGREGATE_BYTES} bytes`
    : null;
}


function normalizeDod(input: CtoSpecificationPreparationDoD, label: string): { value: DoD } | { error: string } {
  if (!input || typeof input !== "object" || Array.isArray(input)) return { error: `${label}.dod is required` };
  if (!Array.isArray(input.items) || input.items.length === 0) return { error: `${label}.dod.items must be non-empty` };
  const dodAggregate = { bytes: 0 };
  const dodError = validatePreparationDod(input, label, dodAggregate);
  if (dodError) return { error: dodError };
  const seen = new Set<string>();
  const items = input.items.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error(`${label}.dod.items[${index}] must be an object`);
    const candidate = item as Partial<DoD["items"][number]>;
    if (typeof candidate.id !== "string" || !SAFE_ID.test(candidate.id) || seen.has(candidate.id)) throw new Error(`${label}.dod.items[${index}].id must be unique and safe`);
    seen.add(candidate.id);
    if (typeof candidate.source !== "string" || candidate.source.trim().length === 0) throw new Error(`${label}.dod.items[${index}].source is required`);
    if (typeof candidate.criterion !== "string" || candidate.criterion.trim().length === 0) throw new Error(`${label}.dod.items[${index}].criterion is required`);
    if (typeof candidate.verify_method !== "string" || candidate.verify_method.trim().length === 0) throw new Error(`${label}.dod.items[${index}].verify_method is required`);
    if (candidate.status !== "pending" && candidate.status !== "met") throw new Error(`${label}.dod.items[${index}].status must be pending or met`);

    if (typeof candidate.evidence !== "string") throw new Error(`${label}.dod.items[${index}].evidence is required`);
    if (candidate.status === "met" && candidate.evidence.trim().length === 0) throw new Error(`${label}.dod.items[${index}] met evidence is required`);
    return { id: candidate.id, source: candidate.source, criterion: candidate.criterion, verify_method: candidate.verify_method, status: candidate.status, evidence: candidate.evidence };
  });
  if (input.type_requirements_met !== true) return { error: `${label}.dod.type_requirements_met must be true` };
  return { value: { items, type_requirements_met: true, updated_at: typeof input.updated_at === "string" && input.updated_at.trim() ? input.updated_at : new Date().toISOString() } };
}

type PreparationHookRecord = { hook: CtoSpecificationPreparationTestHooks; aliases: string[] };
const preparationTestHooksByRoot = new Map<string, PreparationHookRecord>();
function preparationHookScopeKeys(projectRoot: string): string[] {
  const lexical = resolve(projectRoot);
  try {
    const canonical = resolve(realpathSync(projectRoot));
    return canonical === lexical ? [lexical] : [lexical, canonical];
  } catch {
    return [lexical];
  }
}
function preparationHookIdentity(projectRoot: string): string | undefined {
  try {
    const stat = lstatSync(realpathSync(projectRoot));
    return "identity:" + String(stat.dev) + ":" + String(stat.ino);
  } catch {
    return undefined;
  }
}
function findPreparationHook(projectRoot: string, pinnedRoot?: PinnedProjectRoot): CtoSpecificationPreparationTestHooks | undefined {
  const aliases = pinnedRoot
    ? ["identity:" + String(pinnedRoot.dev) + ":" + String(pinnedRoot.ino), ...preparationHookScopeKeys(projectRoot)]
    : preparationHookScopeKeys(projectRoot);
  for (const key of aliases) {
    const record = preparationTestHooksByRoot.get(key);
    if (record) return record.hook;
  }
  return undefined;
}
function setPreparationHook(hook: CtoSpecificationPreparationTestHooks | null, projectRoot: string): void {
  const aliases = [...preparationHookScopeKeys(projectRoot)];
  const identity = preparationHookIdentity(projectRoot);
  if (identity) aliases.push(identity);
  const previous = new Set<PreparationHookRecord>();
  for (const alias of aliases) {
    const record = preparationTestHooksByRoot.get(alias);
    if (record) previous.add(record);
  }
  for (const record of previous) for (const alias of record.aliases) {
    if (preparationTestHooksByRoot.get(alias) === record) preparationTestHooksByRoot.delete(alias);
  }
  if (!hook) return;
  const record: PreparationHookRecord = { hook, aliases };
  for (const alias of aliases) preparationTestHooksByRoot.set(alias, record);
}

/** Internal deterministic failure seam; intentionally not re-exported publicly. */
export function setCtoSpecificationPreparationTestHooks(hooks: CtoSpecificationPreparationTestHooks | null, projectRoot: string): void {
  setPreparationHook(hooks, projectRoot);
}

function injectPreparationFailure(root: string, pinnedRoot: PinnedProjectRoot, point: CtoSpecificationPreparationFailurePoint, featureId: string): void {
  findPreparationHook(root, pinnedRoot)?.afterWrite?.(point, featureId);
}

function sha256Bytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

const PREPARATION_PREIMAGE_DIRECTORY = ".work-state/cto";

function preparationPreimagePath(runId: string, sha256: string): string {
  if (!isSafeCtoRunId(runId) || !/^[a-f0-9]{64}$/u.test(sha256)) {
    throw new Error("preparation preimage identity is invalid");
  }
  return PREPARATION_PREIMAGE_DIRECTORY + "/" + runId + "/preparation-preimages/" + sha256 + ".bin";
}

function persistPreparationPreimage(
  pinnedRoot: PinnedProjectRoot,
  runId: string,
  sha256: string,
  bytes: Uint8Array,
): string {
  if (bytes.byteLength > MAX_PERSISTED_STATE_BYTES) throw new Error("preparation preimage exceeds the bounded 8MiB limit");
  const ref = preparationPreimagePath(runId, sha256);
  pinnedRoot.ensureDirectories([PREPARATION_PREIMAGE_DIRECTORY + "/" + runId + "/preparation-preimages"]);
  try {
    pinnedRoot.writeExclusive(ref, bytes);
  } catch (error) {
    if (!(error instanceof PinnedRootError) || error.code !== "exists") throw error;
  }
  const stored = pinnedRoot.readFile(ref, { maxBytes: MAX_PERSISTED_STATE_BYTES });
  if (stored.bytes.byteLength !== bytes.byteLength || sha256Bytes(stored.bytes) !== sha256) {
    throw new Error("preparation preimage ref '" + ref + "' does not match its content address");
  }
  return ref;
}

function capturePreparationImage(
  pinnedRoot: PinnedProjectRoot,
  runId: string,
  relativePath: string,
  persistPreimage = true,
): CtoSpecificationPreparationFileImage {
  try {
    const isDod = relativePath === "dod.json" || relativePath.endsWith("/dod.json");
    const maxBytes = isDod ? MAX_DOD_BYTES : MAX_PERSISTED_STATE_BYTES;
    const read = pinnedRoot.readFile(relativePath, { maxBytes });
    const raw = new TextDecoder("utf-8", { fatal: true }).decode(read.bytes);
    if (!isDod) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch (error) {
        throw new Error("feature state is not valid JSON: " + (error instanceof Error ? error.message : String(error)));
      }
      if (!parseBoundedPersistedState(parsed)) {
        throw new Error("feature state exceeds bounded structural limits or has an unsafe object shape");
      }
    }
    const bytes = Buffer.from(read.bytes);
    const sha256 = sha256Bytes(bytes);
    return {
      path: relativePath,
      exists: true,
      sha256,
      byte_count: bytes.byteLength,
      dev: read.dev,
      ino: read.ino,
      ...(persistPreimage ? { preimage_ref: persistPreparationPreimage(pinnedRoot, runId, sha256, bytes) } : {}),
    };
  } catch (error) {
    if (error instanceof PinnedRootError && error.code === "not_found") {
      return { path: relativePath, exists: false, sha256: "", byte_count: 0 };
    }
    throw error;
  }
}

function samePreparationImage(left: CtoSpecificationPreparationFileImage, right: CtoSpecificationPreparationFileImage): boolean {
  return left.path === right.path
    && left.exists === right.exists
    && left.sha256 === right.sha256
    && left.byte_count === right.byte_count
    && (!left.exists || (left.dev === right.dev && left.ino === right.ino));
}

function preparationExpectation(image: CtoSpecificationPreparationFileImage): PinnedRootFileExpectation {
  const { dev, ino, sha256, byte_count: byteCount } = image;
  if (!image.exists || !Number.isSafeInteger(dev) || !Number.isSafeInteger(ino) || !sha256 || typeof byteCount !== "number" || !Number.isSafeInteger(byteCount) || byteCount < 0 || byteCount > MAX_PERSISTED_STATE_BYTES) {
    throw new Error("invalid preparation image for '" + image.path + "'");
  }
  return { dev: dev as number, ino: ino as number, sha256 };
}

function decodeLegacyPreparationPreimage(image: CtoSpecificationPreparationFileImage): Buffer {
  if (typeof image.bytes_base64 !== "string" || image.bytes_base64.length === 0 || image.bytes_base64.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(image.bytes_base64)) {
    throw new Error("legacy preparation preimage encoding is invalid");
  }
  const bytes = Buffer.from(image.bytes_base64, "base64");
  if (bytes.byteLength > MAX_PERSISTED_STATE_BYTES || bytes.toString("base64") !== image.bytes_base64) {
    throw new Error("legacy preparation preimage exceeds the bounded limit");
  }
  return bytes;
}

function preparationPreimageBytes(
  pinnedRoot: PinnedProjectRoot,
  runId: string,
  image: CtoSpecificationPreparationFileImage,
): Buffer {
  if (!image.exists) throw new Error("missing preparation preimage for an absent file");
  let bytes: Buffer;
  if (image.preimage_ref !== undefined) {
    if (image.preimage_ref !== preparationPreimagePath(runId, image.sha256)) {
      throw new Error("preparation preimage reference is outside its owning CTO run");
    }
    bytes = Buffer.from(pinnedRoot.readFile(image.preimage_ref, { maxBytes: MAX_PERSISTED_STATE_BYTES }).bytes);
  } else {
    bytes = decodeLegacyPreparationPreimage(image);
  }
  const byteCount = image.byte_count;
  if ((typeof byteCount !== "number" || !Number.isSafeInteger(byteCount) || byteCount !== bytes.byteLength)
    || sha256Bytes(bytes) !== image.sha256) {
    throw new Error("preparation preimage content does not match its recorded identity");
  }
  return bytes;
}

function externalizeLegacyPreparationImage(
  pinnedRoot: PinnedProjectRoot,
  runId: string,
  image: CtoSpecificationPreparationFileImage,
): CtoSpecificationPreparationFileImage {
  if (!image.exists || image.preimage_ref !== undefined) return image;
  const bytes = decodeLegacyPreparationPreimage(image);
  const sha256 = sha256Bytes(bytes);
  if (sha256 !== image.sha256) throw new Error("legacy preparation preimage digest does not match its image");
  const preimage_ref = persistPreparationPreimage(pinnedRoot, runId, sha256, bytes);
  const { bytes_base64: _legacy, ...withoutLegacy } = image;
  return { ...withoutLegacy, byte_count: bytes.byteLength, preimage_ref };
}

function restorePreparationImage(
  pinnedRoot: PinnedProjectRoot,
  runId: string,
  before: CtoSpecificationPreparationFileImage,
  after: CtoSpecificationPreparationFileImage | undefined,
): void {
  const current = capturePreparationImage(pinnedRoot, runId, before.path, false);
  if (!after) {
    if (!samePreparationImage(current, before)) {
      throw new Error("preparation recovery found an unjournaled mutation at '" + before.path + "'");
    }
    return;
  }
  if (!samePreparationImage(current, after)) {
    throw new Error("preparation recovery found a conflicting mutation at '" + before.path + "'");
  }
  if (before.exists) {
    const bytes = preparationPreimageBytes(pinnedRoot, runId, before);
    pinnedRoot.replaceFileIfMatches(before.path, preparationExpectation(after), bytes);
  } else {
    pinnedRoot.removeFileIfMatches(before.path, preparationExpectation(after));
  }
}

function persistPreparationTransaction(
  runtimeAccess: CtoRuntimeAccessFacade,
  state: CtoState,
  pinnedRoot: PinnedProjectRoot,
  transaction: CtoSpecificationPreparationTransaction,
  preCommit?: () => void,
): CtoState {
  // Runtime transaction snapshots are immutable. Build a shallow postimage
  // rather than mutating the read snapshot, and return the writer-owned image
  // whose revision is advanced by the authenticated state writer.
  let next: CtoState | undefined;
  const source = state.specification_preparation_transaction === transaction
    ? state
    : readCtoStatePinned(state.id, pinnedRoot);
  if (!source) throw new Error(`CTO preparation state '${state.id}' is unavailable during transaction recovery`);
  const postimage = JSON.parse(JSON.stringify({ ...source, specification_preparation_transaction: transaction })) as CtoState;
  runtimeAccess.withRunTransaction(state.id, (tx) => {
    const current = tx.readState();
    if (current.state_revision !== state.state_revision) {
      throw new Error(`CTO preparation state changed during transaction (expected ${String(state.state_revision)}, got ${String(current.state_revision)})`);
    }
    preCommit?.();
    tx.writeState(postimage);
    // Capture the transaction-owned object, not the caller's preimage.
    // The authenticated writer advances this exact staged object after the
    // callback returns, so the returned image carries the committed revision
    // into the next logical preparation step without a second write.
    next = tx.readState();
  });
  if (!next) throw new Error("CTO preparation transaction did not produce a persisted state image");
  return next;
}

function externalizeLegacyPreparationTransaction(
  pinnedRoot: PinnedProjectRoot,
  runId: string,
  transaction: CtoSpecificationPreparationTransaction,
): CtoSpecificationPreparationTransaction {
  const image = (value: CtoSpecificationPreparationFileImage): CtoSpecificationPreparationFileImage => externalizeLegacyPreparationImage(pinnedRoot, runId, value);
  return {
    ...transaction,
    feature_state: {
      ...transaction.feature_state,
      before: image(transaction.feature_state.before),
      ...(transaction.feature_state.after ? { after: image(transaction.feature_state.after) } : {}),
    },
    dod_files: transaction.dod_files.map((file) => ({
      ...file,
      before: image(file.before),
      ...(file.after ? { after: image(file.after) } : {}),
    })),
  };
}

function recoverPreparationTransaction(
  runtimeAccess: CtoRuntimeAccessFacade,
  state: CtoState,
  root: string,
  pinnedRoot: PinnedProjectRoot,
): { ok: true; state: CtoState } | { ok: false; error: string } {
  try {
    const recovered = runtimeAccess.withRunTransaction(state.id, (tx) => {
      const locked = tx.readState();
      const current = readCtoStatePinned(state.id, pinnedRoot);
      if (!current || current.id !== state.id || locked.id !== state.id || current.state_revision !== locked.state_revision) {
        throw new Error(`preparation recovery state changed before rollback (locked revision ${String(locked.state_revision)}, persisted revision ${String(current?.state_revision)})`);
      }
      const transaction = locked.specification_preparation_transaction;
      if (!transaction || transaction.status === "committed" || transaction.status === "rolled_back" || transaction.kind === "bootstrap") return current;
      if (transaction.schema_version !== 1 || transaction.root_identity.canonical_path !== pinnedRoot.canonical_root
        || transaction.root_identity.dev !== pinnedRoot.dev || transaction.root_identity.ino !== pinnedRoot.ino) {
        throw new Error("preparation transaction root identity is invalid");
      }
      const normalized = externalizeLegacyPreparationTransaction(pinnedRoot, current.id, transaction);
      findPreparationHook(root, pinnedRoot)?.beforePreparationRestore?.(normalized.feature_state.path);
      restorePreparationImage(pinnedRoot, current.id, normalized.feature_state.before, normalized.feature_state.after);
      for (const file of normalized.dod_files) {
        findPreparationHook(root, pinnedRoot)?.beforePreparationRestore?.(file.path);
        restorePreparationImage(pinnedRoot, current.id, file.before, file.after);
      }
      const rolledBack: CtoSpecificationPreparationTransaction = {
        ...normalized,
        status: "rolled_back",
        updated_at: new Date().toISOString(),
      };
      const postimage = JSON.parse(JSON.stringify({ ...locked, specification_preparation_transaction: rolledBack })) as CtoState;
      tx.writeState(postimage);
      return postimage;
    });
    return { ok: true, state: recovered };
  } catch (error) {
    return { ok: false, error: `preparation recovery failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}
function loadHandoffPinned(root: string, selection: CtoSpecificationExecutionSelection, pinnedRoot: PinnedProjectRoot): { ok: true; workspace: FeatureWorkspace; handoff: ImplementationHandoff } | { ok: false; error: string } {
  const workspace = resolveFeatureWorkspace(root, selection, {
    lexical_root: pinnedRoot.lexical_root,
    canonical_root: pinnedRoot.canonical_root,
    dev: pinnedRoot.dev,
    ino: pinnedRoot.ino,
    pinned_root: pinnedRoot,
  }, { persistMigration: false, requireMigration: true });
  if (!workspace.ok) return { ok: false, error: `${workspace.code}: ${workspace.error}` };
  if (workspace.value.status !== "implementation_ready") return { ok: false, error: `workspace '${selection.feature_id}' is not implementation_ready (status '${workspace.value.status}')` };
  if (!workspace.value.handoff_ref || !SAFE_ID.test(workspace.value.handoff_ref)) return { ok: false, error: `handoff reference for '${selection.feature_id}' is invalid` };
  const relativePath = `.work-state/features/${selection.feature_id}/artifacts/implementation_handoff/${workspace.value.handoff_ref}.json`;
  const loaded = readCanonicalHandoff(pinnedRoot, relativePath, `handoff for '${selection.feature_id}'`);
  if (!loaded.ok) return { ok: false, error: loaded.error };
  const handoff = loaded.handoff;
  if (handoff.status !== "ready" || handoff.feature_id !== selection.feature_id) return { ok: false, error: `handoff for '${selection.feature_id}' is not ready or carries a foreign feature id` };
  if (!handoff.execution_choices.includes("cto")) return { ok: false, error: `handoff for '${selection.feature_id}' does not allow CTO execution` };
  return { ok: true, workspace: workspace.value, handoff };
}
interface SelectionEligibility {
  workspace: FeatureWorkspace;
  handoff: ImplementationHandoff;
}

function evaluateSelectionEligibility(
  root: string,
  ctoRunId: string,
  selection: CtoSpecificationExecutionSelection,
  pinnedRoot: PinnedProjectRoot,
): { ok: true; value: SelectionEligibility } | { ok: false; findings: string[] } {
  // Reuse the pure public gate for status, frozen versions, constitution,
  // handoff digest/readiness, and current claim consistency. It performs no
  // migration or persistence in this intake phase.
  const preflight = validateSpecificationSelection(root, pinnedRoot, {
    cto_run_id: ctoRunId,
    selections: [selection],
  });
  if (preflight.status !== "ready") {
    return { ok: false, findings: preflight.findings.length > 0 ? [...preflight.findings] : [`selection '${selection.feature_id}' is not eligible for CTO execution`] };
  }
  findPreparationHook(root, pinnedRoot)?.afterEligibilityGate?.(selection.feature_id);

  const currentClaim = readCurrentExecutionClaim(root, selection.feature_id, pinnedRoot);
  if (!currentClaim.ok) return { ok: false, findings: [`${currentClaim.code}: ${currentClaim.error}`] };
  if (currentClaim.value && (currentClaim.value.status === "active" || currentClaim.value.status === "blocked")) {
    return {
      ok: false,
      findings: [
        `existing active execution claim for '${selection.feature_id}': ${currentClaim.value.owner_kind} owner '${currentClaim.value.owner_run_id}' holds claim '${currentClaim.value.claim_id}'`,
      ],
    };
  }

  const loaded = loadHandoffPinned(root, selection, pinnedRoot);
  if (!loaded.ok) return { ok: false, findings: [loaded.error] };
  return { ok: true, value: loaded };
}
type ReplayTeamExpectation = {
  input: CtoSpecificationPreparationTeam;
  def: TeamDef;
  owner: { feature_id: string; task_id: string; slice_id: string; depends_on: string[] };
  workflow: WorkflowName;
  dod: DoD;
  teamId: string;
  dodPath: string;
  dodDigest: string;
  /** Resolved execution-instance dependencies persisted in TeamPlan. */
  planDependsOn: string[];
};
function preparationDigest(input: {
  task: string;
  branch: string;
  classification: ModelClassification;
  workflow: WorkflowName;
  selections: readonly CtoSpecificationExecutionSelection[];
  teams: readonly ReplayTeamExpectation[];
}): string {
  return digestOf({
    task: input.task,
    branch: input.branch,
    classification: normalizedTopLevelClassification(input.classification, input.workflow),
    autonomous: input.classification.autonomous,
    workflow: input.workflow,
    selections: input.selections.map((selection) => ({
      feature_id: selection.feature_id,
      run_key: selection.run_key,
    })),
    teams: input.teams.map((team) => ({
      team_id: team.teamId,
      team_def_id: team.def.id,
      feature_id: team.owner.feature_id,
      task_id: team.owner.task_id,
      slice_id: team.owner.slice_id,
      scope: team.input.scope ?? team.def.scope,
      profile: team.input.profile ?? team.def.profile,
      worktree: team.input.worktree ?? "same_branch",
      depends_on: team.input.depends_on ?? [],
      classification: team.input.classification,
      workflow: team.workflow,
      dod: { items: team.dod.items, type_requirements_met: team.dod.type_requirements_met },
      dod_digest: team.dodDigest,
    })),
  });
}
function sameSelections(left: readonly CtoSpecificationExecutionSelection[] | undefined, right: readonly CtoSpecificationExecutionSelection[]): boolean {
  return Array.isArray(left)
    && left.length === right.length
    && left.every((selection, index) => selection.feature_id === right[index]?.feature_id && selection.run_key === right[index]?.run_key);
}

function sameExclusions(
  left: readonly { feature_id: string; run_key: string; findings: readonly string[] }[] | undefined,
  right: readonly CtoSpecificationExecutionExcludedSelection[],
): boolean {
  return Array.isArray(left)
    && left.length === right.length
    && left.every((entry, index) => {
      const expected = right[index];
      if (!expected) return false;
      return entry.feature_id === expected.feature_id
        && entry.run_key === expected.run_key
        && entry.findings.length === expected.findings.length
        && entry.findings.every((finding: string, findingIndex: number) => finding === expected.findings[findingIndex]);
    });
}

const MAX_FEATURE_PREPARATION_TASK_LENGTH = 256;

/**
 * The feature-state preparation handoff has a deliberately small task field.
 * Never project the resident CTO request into that field: it is arbitrary
 * caller text and may be large or multi-line. The anchor task is instead a
 * stable projection of the canonical identities that are being migrated.
 */
function deriveAnchorMigrationTask(
  ctoRunId: string,
  selection: CtoSpecificationExecutionSelection,
): string | null {
  if (!isSafeCtoRunId(ctoRunId)
    || !SAFE_FEATURE.test(selection.feature_id)
    || !isCtoSpecificationSafeId(selection.run_key)) return null;
  const task = `cto-anchor:${ctoRunId}:${selection.feature_id}:${selection.run_key}`;
  if (task.length > MAX_FEATURE_PREPARATION_TASK_LENGTH
    || Buffer.byteLength(task, "utf8") > MAX_FEATURE_PREPARATION_TASK_LENGTH
    || /[\u0000-\u001f\u007f\r\n]/u.test(task)) return null;
  return task;
}

function bindSpecificationExecutionAnchor(
  root: string,
  selection: CtoSpecificationExecutionSelection,
  capability: IssuedCapability["state"],
  capabilityEpoch: string,
  pinnedRoot: PinnedProjectRoot,
  migrationInput: Pick<CtoSpecificationExecutionPreparationInput, "cto_run_id" | "branch" | "classification">,
): string | null {
  const liveConstitutionError = (workspace: FeatureWorkspace): string | null => {
    if (!workspace.constitution_binding) return "SPEC_CONSTITUTION_IMPACT_PENDING: confirmation anchor workspace has no constitution binding";
    const current = readPinnedCurrentConstitution(root, pinnedRoot, workspace.constitution_binding);
    return current.ok ? null : "SPEC_CONSTITUTION_IMPACT_PENDING: " + current.error;
  };
  const workspaceResultBeforeMigration = resolveFeatureWorkspace(root, selection, {
    lexical_root: pinnedRoot.lexical_root,
    canonical_root: pinnedRoot.canonical_root,
    dev: pinnedRoot.dev,
    ino: pinnedRoot.ino,
    pinned_root: pinnedRoot,
  }, { persistMigration: false, requireMigration: true });
  if (!workspaceResultBeforeMigration.ok) {
    const error = `${workspaceResultBeforeMigration.code}: ${workspaceResultBeforeMigration.error}`;
    findPreparationHook(root, pinnedRoot)?.afterAnchorBindFailure?.({
      feature_id: selection.feature_id,
      code: workspaceResultBeforeMigration.code,
      error,
    });
    return error;
  }
  if (!pinnedRoot.isStable()) {
    const error = "SPEC_PATH_UNAUTHORIZED: project root changed before anchor migration";
    findPreparationHook(root, pinnedRoot)?.afterAnchorBindFailure?.({ feature_id: selection.feature_id, code: "SPEC_PATH_UNAUTHORIZED", error });
    return error;
  }
  const preparationState = resolvePreparationStatePinned(root, pinnedRoot, selection);
  if (preparationState.invalid) {
    const workspaceResult = resolveFeatureWorkspace(root, selection, {
      lexical_root: pinnedRoot.lexical_root,
      canonical_root: pinnedRoot.canonical_root,
      dev: pinnedRoot.dev,
      ino: pinnedRoot.ino,
      pinned_root: pinnedRoot,
    }, { persistMigration: false, requireMigration: true });
    const code = workspaceResult.ok ? "SPEC_STATE_INVALID" : workspaceResult.code;
    const error = workspaceResult.ok
      ? "SPEC_STATE_INVALID: feature state is unreadable or invalid before anchor binding"
      : `${workspaceResult.code}: ${workspaceResult.error}`;
    findPreparationHook(root, pinnedRoot)?.afterAnchorBindFailure?.({ feature_id: selection.feature_id, code, error });
    return error;
  }
  if (preparationState.state?.specification !== undefined && preparationState.state.classification === undefined) {
    const migrationTask = deriveAnchorMigrationTask(migrationInput.cto_run_id, selection);
    if (migrationTask === null) {
      const message = "SPEC_STATE_INVALID: confirmation anchor identity cannot be represented as a bounded single-line task";
      findPreparationHook(root, pinnedRoot)?.afterAnchorBindFailure?.({ feature_id: selection.feature_id, code: "SPEC_STATE_INVALID", error: message });
      return message;
    }
    try {
      prepareWorkflowStatePinned({
        task: migrationTask,
        cwd: root,
        branch: migrationInput.branch,
        autonomous: false,
        classification: {
          type: "SPEC",
          complexity: migrationInput.classification.complexity,
          confidence: migrationInput.classification.confidence,
          autonomous: false,
          workflow: "spec-preparation",
        },
        feature_id: selection.feature_id,
        run_key: selection.run_key,
      }, pinnedRoot);
    } catch (error) {
      const message = `SPEC_STATE_INVALID: pinned workflow state migration failed: ${error instanceof Error ? error.message : String(error)}`;
      findPreparationHook(root, pinnedRoot)?.afterAnchorBindFailure?.({ feature_id: selection.feature_id, code: "SPEC_STATE_INVALID", error: message });
      return message;
    }
  }
  if (!pinnedRoot.isStable()) {
    const error = "SPEC_PATH_UNAUTHORIZED: project root changed after anchor migration";
    findPreparationHook(root, pinnedRoot)?.afterAnchorBindFailure?.({ feature_id: selection.feature_id, code: "SPEC_PATH_UNAUTHORIZED", error });
    return error;
  }
  const workspaceResult = resolveFeatureWorkspace(root, selection, {
    lexical_root: pinnedRoot.lexical_root,
    canonical_root: pinnedRoot.canonical_root,
    dev: pinnedRoot.dev,
    ino: pinnedRoot.ino,
    pinned_root: pinnedRoot,
  }, { persistMigration: false, requireMigration: true });
  if (!workspaceResult.ok) {
    const error = `${workspaceResult.code}: ${workspaceResult.error}`;
    findPreparationHook(root, pinnedRoot)?.afterAnchorBindFailure?.({
      feature_id: selection.feature_id,
      code: workspaceResult.code,
      error,
    });
    return error;
  }
  const beforeBindConstitutionError = liveConstitutionError(workspaceResult.value);
  if (beforeBindConstitutionError) {
    findPreparationHook(root, pinnedRoot)?.afterAnchorBindFailure?.({ feature_id: selection.feature_id, code: "SPEC_CONSTITUTION_IMPACT_PENDING", error: beforeBindConstitutionError });
    return beforeBindConstitutionError;
  }
  const bind = () => updateStateAtomically(
    root,
    (snapshot) => {
      if (!snapshot.state || !snapshot.target.statePath) {
        return { op: "fail", code: "state_missing", error: `confirmation anchor ${selection.feature_id} has no canonical feature state` };
      }
      if (snapshot.state.run_key !== selection.run_key || snapshot.state.specification?.feature_id !== selection.feature_id) {
        return { op: "fail", code: "state_conflict", error: `confirmation anchor ${selection.feature_id}/${selection.run_key} does not match its canonical feature state` };
      }
      const currentWorkspace = snapshot.state.specification;
      if (!currentWorkspace) return { op: "fail", code: "state_conflict", error: "confirmation anchor specification workspace disappeared before binding" };
      const currentConstitutionError = liveConstitutionError(currentWorkspace);
      if (currentConstitutionError) return { op: "fail", code: "state_conflict", error: currentConstitutionError };
      const next: TeamState = {
        ...snapshot.state,
        cursor_epoch: capabilityEpoch,
        dispatch_capability: capability,
      };
      return { op: "commit", state: next, value: null };
    },
    {
      selector: selection,
      branchNeutral: true,
      rootGuard: pinnedRoot,
      pinnedRoot,
      preCommit: () => {
        const current = resolveFeatureWorkspace(root, selection, {
          lexical_root: pinnedRoot.lexical_root,
          canonical_root: pinnedRoot.canonical_root,
          dev: pinnedRoot.dev,
          ino: pinnedRoot.ino,
          pinned_root: pinnedRoot,
        }, { persistMigration: false, requireMigration: true });
        if (!current.ok) throw new Error(current.error);
        const constitutionError = liveConstitutionError(current.value);
        if (constitutionError) throw new Error(constitutionError);
      },
    },
  );
  let updated = bind();
  if (!updated.ok) {
    findPreparationHook(root, pinnedRoot)?.afterAnchorBindFailure?.({
      feature_id: selection.feature_id,
      code: updated.code,
      error: updated.error,
    });
  }
  return updated.ok ? null : `${updated.code}: ${updated.error}`;
}

function replayResult(
  state: CtoState,
  runId: string,
  expected: {
    task: string;
    branch: string;
    classification: ModelClassification;
    workflow: WorkflowName;
    sourceId: string;
    waveId: string;
    selections: readonly CtoSpecificationExecutionSelection[];
    excluded: readonly CtoSpecificationExecutionExcludedSelection[];
    teams: readonly ReplayTeamExpectation[];
  },
  pinnedRoot: PinnedProjectRoot,
): CtoSpecificationExecutionPreparationResult | null {
  const wave = state.wave_history?.find((candidate) => candidate.id === state.active_wave_id && candidate.status === "active" && candidate.source === "specification-execution");
  if (!wave || !wave.work_identity || state.id !== runId || state.task !== expected.task || state.branch !== expected.branch || wave.id !== expected.waveId || wave.source_id !== expected.sourceId) return null;
  const anchor = state.specification_execution_anchor;
  const expectedAnchor = expected.selections[0];
  if (!state.classification || state.autonomous !== expected.classification.autonomous) return null;
  let actualWorkflow: WorkflowName;
  try { actualWorkflow = resolveWorkflowForClassification(state.classification); } catch { return null; }
  if (actualWorkflow !== expected.workflow
    || digestOf(normalizedTopLevelClassification(state.classification, actualWorkflow))
      !== digestOf(normalizedTopLevelClassification(expected.classification, expected.workflow))) return null;
  if (!anchor || !expectedAnchor || anchor.feature_id !== expectedAnchor.feature_id || anchor.run_key !== expectedAnchor.run_key) return null;
  if (!sameSelections(state.specification_execution_requested_selections, expected.selections)
    || !sameExclusions(state.specification_execution_exclusions, expected.excluded)) return null;
  const expectedDigest = preparationDigest(expected);
  if (state.specification_execution_preparation_digest !== expectedDigest) return null;
  const capabilityId = wave.work_identity.capability_id;
  const capabilityEpoch = wave.work_identity.capability_epoch;
  if (!capabilityId || !capabilityEpoch || wave.slice_ids.length === 0 || state.teams.length !== expected.teams.length) return null;
  const transaction = state.specification_preparation_transaction;
  if (!transaction || transaction.status !== "committed"
    || transaction.id !== `cto-preparation-${expectedDigest.slice(0, 32)}`
    || transaction.request_digest !== expectedDigest
    || transaction.source_id !== expected.sourceId
    || transaction.wave_id !== expected.waveId
    || transaction.root_identity.canonical_path !== pinnedRoot.canonical_root
    || transaction.root_identity.dev !== pinnedRoot.dev
    || transaction.root_identity.ino !== pinnedRoot.ino
    || transaction.feature_state.path !== `.work-state/features/${expectedAnchor?.feature_id ?? ""}/state.json`
    || transaction.dod_files.length !== expected.teams.length) return null;
  try {
    const featureAfter = transaction.feature_state.after;
    if (!featureAfter || !samePreparationImage(capturePreparationImage(pinnedRoot, runId, transaction.feature_state.path, false), featureAfter)) return null;
    for (const team of expected.teams) {
      const file = transaction.dod_files.find((candidate) => candidate.path === `${team.dodPath}/dod.json`);
      if (!file?.after || !samePreparationImage(capturePreparationImage(pinnedRoot, runId, file.path, false), file.after)) return null;
    }
  } catch { return null; }
  const stateWorkIdentity = state.work_identity;
  const statePending = state.pending;
  const stateCompletionEnvelope = state.completion_envelope;
  if (!stateWorkIdentity || canonicalJson(stateWorkIdentity) !== canonicalJson(wave.work_identity)
    || !statePending || canonicalJson(statePending.identity) !== canonicalJson(stateWorkIdentity) || statePending.status !== "authorized"
    || !stateCompletionEnvelope || canonicalJson(stateCompletionEnvelope.identity) !== canonicalJson(stateWorkIdentity) || stateCompletionEnvelope.outcome !== "pending") return null;
  const progressed = state.teams.some((team) => {
    const terminalSignal = "terminal_signal" in team ? team.terminal_signal : undefined;
    return team.status !== "pending"
      || team.pending !== undefined
      || team.completion_envelope !== undefined
      || terminalSignal !== undefined
      || Object.keys(team.escalations ?? {}).length > 0;
  });
  if (progressed) {
    return blockedWithSelectionReport(
      expected.selections,
      expected.selections.filter((selection) => !expected.excluded.some((entry) => entry.feature_id === selection.feature_id && entry.run_key === selection.run_key)),
      expected.excluded,
      ["already_started: authenticated CTO execution teams are no longer in their initial pending state; fresh preparation replay is refused"],
    );
  }
  const actualDigest = digestOf({
    teams: state.teams.map((team, index) => {
      const terminalSignal = "terminal_signal" in team ? team.terminal_signal : undefined;
      return {
        team_id: team.id,
        team_def_id: team.team_def_id,
        feature_id: team.feature_id,
        run_key: team.run_key,
        task_id: team.task_id,
        slice_id: team.slice_id,
        classification: team.classification,
        workflow: team.workflow,
        dod_path: team.dod_path,
        dod_digest: team.dod_digest,
        status: team.status,
        pending: team.pending ?? null,
        completion_envelope: team.completion_envelope ?? null,
        terminal_signal: terminalSignal ?? null,
        escalations: team.escalations ?? {},
        work_identity: team.work_identity,
        plan: state.plan.teams[index],
      };
    }),
  });
  const expectedStateDigest = digestOf({
    teams: expected.teams.map((team) => ({
      team_id: team.teamId,
      team_def_id: team.def.id,
      feature_id: team.owner.feature_id,
      run_key: expected.selections.find((selection) => selection.feature_id === team.owner.feature_id)?.run_key,
      task_id: team.owner.task_id,
      slice_id: team.owner.slice_id,
      classification: team.input.classification,
      workflow: team.workflow,
      dod_path: team.dodPath,
      dod_digest: team.dodDigest,
      status: "pending",
      pending: null,
      completion_envelope: null,
      terminal_signal: null,
      escalations: {},
      work_identity: {
        run_id: runId,
        wave_id: expected.waveId,
        slice_id: team.owner.slice_id,
        session_id: state.owner_session,
        workflow: team.workflow,
        stage_id: "execution",
        stage_cursor: "execution",
        capability_id: capabilityId,
        capability_epoch: capabilityEpoch,
        slot_id: team.owner.slice_id,
        task_id: team.owner.task_id,
        dispatch_id: `dispatch-${digestOf({ kind: "cto-execution-dispatch", feature_id: team.owner.feature_id, task_id: team.owner.task_id }).slice(0, 32)}`,
        attempt: 1,
        worker_id: team.def.lead,
      },
      plan: {
        team: team.teamId,
        team_def_id: team.def.id,
        scope: [...(team.input.scope ?? team.def.scope)],
        slice: team.owner.slice_id,
        profile: team.input.profile ?? team.def.profile,
        worktree: team.input.worktree ?? "same_branch",
        depends_on: [...team.planDependsOn],
      },
    })),
  });
  if (actualDigest !== expectedStateDigest) return null;
  for (const team of expected.teams) {
    const current = readDoDFilePinned(pinnedRoot, team.dodPath + "/dod.json");
    if (!current.ok || canonicalCtoDoDDigest(current.dod) !== team.dodDigest) return null;
  }
  if (!pinnedRoot.isStable()) return null;
  const slices: CtoSpecificationPreparedSlice[] = [];
  for (const team of state.teams) {
    if (!team.slice_id || !team.work_identity || !team.dod_path || !team.feature_id || !team.run_key || !team.task_id || !team.team_def_id) continue;
    const identity = team.work_identity;
    const expectedIdentity = expected.teams.find((candidate) => candidate.teamId === team.id);
    if (!expectedIdentity
      || canonicalJson(identity) !== canonicalJson({
        run_id: runId, wave_id: wave.id, slice_id: expectedIdentity.owner.slice_id, session_id: state.owner_session, workflow: expectedIdentity.workflow,
        stage_id: "execution", stage_cursor: "execution", capability_id: capabilityId, capability_epoch: capabilityEpoch, slot_id: expectedIdentity.owner.slice_id,
        task_id: expectedIdentity.owner.task_id,
        dispatch_id: `dispatch-${digestOf({ kind: "cto-execution-dispatch", feature_id: expectedIdentity.owner.feature_id, task_id: expectedIdentity.owner.task_id }).slice(0, 32)}`,
        attempt: 1, worker_id: expectedIdentity.def.lead,
      })
      || identity.run_id !== runId || identity.wave_id !== wave.id || identity.slice_id !== team.slice_id || identity.slot_id !== team.slice_id || identity.task_id !== team.task_id || identity.stage_id !== "execution" || identity.stage_cursor !== "execution" || identity.capability_id !== capabilityId || identity.capability_epoch !== capabilityEpoch) return null;
    if (!wave.slice_ids.includes(team.slice_id)) continue;
    slices.push({ feature_id: team.feature_id, run_key: team.run_key, task_id: team.task_id, team_id: team.id, team_def_id: team.team_def_id, slice_id: team.slice_id, dod_path: team.dod_path, work_identity: identity });
  }
  if (slices.length !== wave.slice_ids.length) return null;
  return {
    status: "ready",
    prepared: true,
    dispatched: false,
    cto_run_id: runId,
    wave_id: wave.id,
    source_id: wave.source_id,
    capability_id: capabilityId,
    capability_epoch: capabilityEpoch,
    confirmation_anchor: { ...anchor },
    requested_selections: expected.selections.map((selection) => ({ ...selection })),
    eligible_selections: expected.selections.filter((selection) => !expected.excluded.some((entry) => entry.feature_id === selection.feature_id && entry.run_key === selection.run_key)).map((selection) => ({ ...selection })),
    excluded: expected.excluded.map((entry) => ({ ...entry, findings: [...entry.findings] })),
    slices,
  };
}

/** Reconcile trusted terminal task receipts before dependency scheduling. */
export function reconcileCtoSpecificationExecutionTeams(projectRoot: string, ctoRunId: string, options: ReconcileCtoSpecificationExecutionTeamsOptions): CtoSpecificationExecutionTeamReconciliationResult {
  const pinnedRoot = options?.pinnedRoot ?? PinnedProjectRoot.open(projectRoot);
  if (!pinnedRoot) return { status: "blocked", reconciled_team_ids: [], findings: ["recovery_required: project root cannot be pinned for CTO task reconciliation"] };
  const ownsPin = options?.pinnedRoot === undefined;
  try {
    if (!isSafeCtoRuntimeSessionId(options?.sessionId)) return { status: "blocked", reconciled_team_ids: [], findings: ["recovery_required: a bounded non-blank host sessionId is required for CTO task reconciliation"] };
    try { assertCtoRuntimeAccessFacadeLive(options?.runtimeAccess, pinnedRoot.canonical_root, options?.sessionId); }
    catch (error) { return { status: "blocked", reconciled_team_ids: [], findings: [
      `recovery_required: live RuntimeAccess is unavailable for CTO task reconciliation: ${error instanceof Error ? error.message : String(error)}`,
    ] }; }
    if (!isSafeCtoRunId(ctoRunId)) return { status: "blocked", reconciled_team_ids: [], findings: ["CTO task reconciliation run id is invalid"] };
    return options.runtimeAccess.withRunTransaction(ctoRunId, (transaction) => {
      if (!pinnedRoot.isStable()) return { status: "blocked", reconciled_team_ids: [], findings: ["recovery_required: project root changed before CTO task reconciliation"] };
      const state = transaction.readState();
      if (state.id !== ctoRunId) return { status: "blocked", reconciled_team_ids: [], findings: ["CTO task reconciliation run identity does not match authenticated state"] };
      const activeWave = state.wave_history?.find((candidate) => candidate.id === state.active_wave_id && candidate.status === "active" && candidate.source === "specification-execution");
      const waveIdentity = activeWave?.work_identity;
      const findings: string[] = [];
      const admittedSlices = new Set<string>();
      if (!activeWave || !waveIdentity || state.owner_session !== options.sessionId
        || !state.control_plane_provenance || state.control_plane_provenance.status !== "typed"
        || !validateTypedControlPlane({ work_identity: state.work_identity, pending: state.pending, completion_envelope: state.completion_envelope }).ok) {
        findings.push("recovery_required: authenticated CTO execution wave/control-plane provenance is missing or stale");
      } else if (new Set(activeWave.slice_ids).size !== activeWave.slice_ids.length) {
        findings.push("recovery_required: authenticated CTO execution wave admits duplicate slices");
      }
      const updates: Array<{ team: CtoState["teams"][number]; envelope: any; status: "done" | "failed" }> = [];
      for (const team of state.teams) {
        const identity = team.work_identity;
        const identityValid = Boolean(activeWave && waveIdentity && identity
          && identity.run_id === state.id
          && identity.wave_id === activeWave.id
          && identity.slice_id === team.slice_id
          && identity.slot_id === team.slice_id
          && identity.task_id === team.task_id
          && identity.dispatch_id.length > 0
          && identity.attempt === 1
          && identity.worker_id.length > 0
          && identity.session_id === options.sessionId
          && identity.workflow === waveIdentity.workflow
          && identity.stage_id === "execution"
          && identity.stage_cursor === "execution"
          && identity.capability_id === waveIdentity.capability_id
          && identity.capability_epoch === waveIdentity.capability_epoch
          && activeWave.slice_ids.includes(identity.slice_id)
          && !admittedSlices.has(identity.slice_id));
        if (identity?.slice_id) admittedSlices.add(identity.slice_id);
        if (!identityValid) {
          findings.push(`${team.id}: authenticated team work identity does not exactly match the active specification-execution wave`);
          continue;
        }
        if (!team.feature_id || !team.run_key) {
          findings.push(`${team.id}: authenticated execution team is missing an exact feature_id/run_key selector`);
          continue;
        }
        if (!team.work_identity) {
          findings.push(`${team.id}: authenticated execution team is missing an exact work identity`);
          continue;
        }
        if (!["pending", "in_progress", "done", "failed"].includes(team.status)) {
          findings.push(`${team.id}: authenticated execution team has unsupported lifecycle status ${String(team.status)}`);
          continue;
        }
        const hostProviderRef = team.pending?.provider_ref?.startsWith(CTO_HOST_TOOL_CALL_PREFIX) ? team.pending.provider_ref : undefined;
        const receipt = readTrustedTaskResultReceipt(pinnedRoot, {
          feature_id: team.feature_id, run_key: team.run_key, dispatch_id: team.work_identity.dispatch_id,
          expected_work_identity: team.work_identity,
          // Every task in this CTO execution wave is authorized through the
          // mounted host bridge. Once the first result is reconciled, its
          // pending provider binding is cleared; retain the CTO authority
          // selector so later team passes still read the same receipt path.
          cto_run_id: ctoRunId,
          ...(hostProviderRef ? { provider_ref: hostProviderRef, tool_call_id: hostProviderRef.slice(CTO_HOST_TOOL_CALL_PREFIX.length) } : {}),
        });
        if (!receipt.ok) { if (receipt.code === "absent") { if (team.status === "done" || team.status === "failed") findings.push(`${team.id}: terminal CTO team has no trusted completion receipt`); continue; } findings.push(`${team.id}: ${receipt.code}: ${receipt.error}`); continue; }
        const envelope = receipt.receipt.completion_envelope;
        const expectedOutcome = receipt.receipt.completion_status;
        const resolved = hostProviderRef ? null : resolveStatePinned(pinnedRoot.canonical_root, pinnedRoot, { feature_id: team.feature_id, run_key: team.run_key });
        const record = resolved?.state?.dispatch_capability?.dispatches?.find((candidate: any) => candidate.id === receipt.receipt.dispatch_id);
        const validHostReceipt = Boolean(receipt.receipt.authority_kind === "cto" && receipt.receipt.cto_run_id === ctoRunId
          && (hostProviderRef === undefined || receipt.receipt.provider_ref === hostProviderRef)
          && (hostProviderRef === undefined || receipt.receipt.tool_call_id === hostProviderRef.slice(CTO_HOST_TOOL_CALL_PREFIX.length))
          && canonicalJson(envelope.identity) === canonicalJson(team.work_identity)
          && validateTypedControlPlane({ completion_envelope: envelope }).ok);
        const validGenericReceipt = Boolean(!hostProviderRef && resolved && !resolved.invalid && resolved.state && record && record.status === expectedOutcome && record.completion_envelope && canonicalJson(record.completion_envelope) === canonicalJson(envelope) && canonicalJson(envelope.identity) === canonicalJson(team.work_identity) && validateTypedControlPlane({ completion_envelope: envelope }).ok && receipt.receipt.tool_call_id === (record.tool_call_id ?? null));
        if ((!validHostReceipt && !validGenericReceipt) || envelope.outcome !== expectedOutcome || (expectedOutcome !== "succeeded" && expectedOutcome !== "failed") || envelope.terminal_signal === null || envelope.terminal_signal === undefined) { findings.push(`${team.id}: trusted terminal receipt does not bind the exact CTO task or feature dispatch and work identity`); continue; }
        const nextStatus = expectedOutcome === "succeeded" ? "done" : "failed";
        if (team.status === nextStatus && team.completion_envelope && canonicalJson(team.completion_envelope) === canonicalJson(envelope)) { if (team.pending !== undefined) updates.push({ team, envelope, status: nextStatus }); continue; }
        if (team.status === "done" || team.status === "failed") { findings.push(`${team.id}: terminal CTO team status conflicts with trusted task result '${expectedOutcome}'`); continue; }
        updates.push({ team, envelope, status: nextStatus });
      }
      if (activeWave && (state.teams.length !== activeWave.slice_ids.length || admittedSlices.size !== activeWave.slice_ids.length || [...admittedSlices].some((sliceId) => !activeWave.slice_ids.includes(sliceId)))) {
        findings.push("recovery_required: authenticated CTO execution wave and team slice set/cardinality do not match");
      }
      if (findings.length > 0) return { status: "blocked", reconciled_team_ids: [], findings };
      for (const update of updates) { update.team.completion_envelope = update.envelope; delete update.team.pending; setTeamStatus(state, update.team.id, update.status); }
      if (updates.length > 0) transaction.writeState(state);
      return { status: "reconciled", reconciled_team_ids: updates.map((update) => update.team.id), findings: [] };
    });
  } catch (error) {
    if (error instanceof CtoRuntimeAccessError) return { status: "blocked", reconciled_team_ids: [], findings: [`recovery_required: CTO task reconciliation RuntimeAccess transaction failed: ${error.message}`] };
    return { status: "blocked", reconciled_team_ids: [], findings: [`CTO task reconciliation failed: ${error instanceof Error ? error.message : String(error)}`] };
  } finally { if (ownsPin) pinnedRoot.close(); }
}

const CTO_HOST_TOOL_CALL_PREFIX = "host-task:";
function canonicalPreparationScope(values: readonly unknown[]): string[] | null {
  const normalized: string[] = [];
  for (const value of values) {
    if (typeof value !== "string" || value.trim().length === 0 || value.includes("\\") || value.includes("\0") || posix.isAbsolute(value)) return null;
    const path = posix.normalize(value.trim());
    if (path === "." || path === ".." || path.startsWith("../") || path.split("/").some((segment) => segment.length === 0 || segment === "." || segment === "..")) return null;
    if (!normalized.includes(path)) normalized.push(path);
  }
  return normalized.sort();
}
function preparationScopeWithinPolicy(scope: string, policy: readonly string[]): boolean {
  return policy.some((candidate) => scope === candidate || scope.startsWith(candidate + "/"));
}

const MAX_CTO_HOST_TOOL_CALL_ID_BYTES = 512;
function safeCtoHostToolCallId(value: unknown): value is string { return typeof value === "string" && value.length > 0 && Buffer.byteLength(value, "utf8") <= MAX_CTO_HOST_TOOL_CALL_ID_BYTES && !/[\u0000-\u001f\u007f-\u009f\p{Cf}\p{Zl}\p{Zp}]/u.test(value); }
function ctoTaskMarkerFromHostEvent(input: CtoSpecificationTaskAuthorizationEvent): { ok: true; runId: string; sliceId: string } | { ok: false; reason: string } {
  if (!input || input.toolName !== "task") return { ok: false, reason: "CTO task authorization requires the task tool" };
  if (!safeCtoHostToolCallId(input.toolCallId)) return { ok: false, reason: "CTO task authorization requires a bounded tool_call_id" };
  if (!input.input || typeof input.input !== "object" || Array.isArray(input.input)) return { ok: false, reason: "CTO task authorization requires a task payload object" };
  const payload = input.input as Record<string, any>;
  if (Object.hasOwn(payload, "task") && Object.hasOwn(payload, "tasks")) return { ok: false, reason: "CTO task authorization rejects ambiguous task/tasks payloads" };
  let taskText: string;
  if (Object.hasOwn(payload, "task")) { if (typeof payload.task !== "string") return { ok: false, reason: "CTO task authorization requires a string task marker" }; taskText = payload.task; }
  else if (Object.hasOwn(payload, "tasks")) { if (!Array.isArray(payload.tasks) || payload.tasks.length !== 1) return { ok: false, reason: "CTO task authorization requires exactly one marker-bearing task" }; const item = payload.tasks[0]; if (!item || typeof item !== "object" || Array.isArray(item) || typeof item.task !== "string") return { ok: false, reason: "CTO task authorization requires a string task marker" }; taskText = item.task; }
  else return { ok: false, reason: "CTO task authorization requires an exact CTO slice marker" };
  const marker = parseCtoSliceMarker(taskText); return marker ? { ok: true, runId: marker.runId, sliceId: marker.sliceId } : { ok: false, reason: "CTO task authorization requires exactly one valid CTO slice marker" };
}

export function authorizeCtoSpecificationExecutionTask(projectRoot: string, event: CtoSpecificationTaskAuthorizationEvent, options: CtoSpecificationTaskAuthorizationOptions): CtoSpecificationTaskAuthorizationResult {
  const parsed = ctoTaskMarkerFromHostEvent(event); if (!parsed.ok) return parsed;
  if (!isSafeCtoRuntimeSessionId(options?.sessionId)) return { ok: false, reason: "recovery_required: a bounded non-blank host sessionId is required for CTO task authorization" };
  const pinnedRoot = options?.pinnedRoot ?? PinnedProjectRoot.open(projectRoot); if (!pinnedRoot) return { ok: false, reason: "recovery_required: project root cannot be pinned for CTO task authorization" }; const ownsPin = options?.pinnedRoot === undefined;
  try {
    try { assertCtoRuntimeAccessFacadeLive(options?.runtimeAccess, pinnedRoot.canonical_root, options?.sessionId); } catch (error) { return { ok: false, reason: `recovery_required: live RuntimeAccess is unavailable for CTO task authorization: ${error instanceof Error ? error.message : String(error)}` }; }
    return options.runtimeAccess.withRunTransaction(parsed.runId, (transaction) => {
      if (!pinnedRoot.isStable()) return { ok: false, reason: "recovery_required: project root changed before CTO task authorization" };
      const state = transaction.readState(); if (state.id !== parsed.runId) return { ok: false, reason: "CTO task marker run does not match authenticated CtoState" };
      const admission = assertCtoWorkerTaskDispatchable(state, { sliceId: parsed.sliceId, markerRunId: parsed.runId, pinnedRoot });
      if (!admission.ok) return { ok: false, reason: `recovery_required: ${admission.reason}` };
      const wave = state.wave_history?.find((candidate) => candidate.id === state.active_wave_id && candidate.status === "active" && candidate.source === "specification-execution");
      const waveIdentity = wave?.work_identity;
      if (state.owner_session !== options.sessionId || !state.control_plane_provenance || state.control_plane_provenance.status !== "typed" || !validateTypedControlPlane({ work_identity: state.work_identity, pending: state.pending, completion_envelope: state.completion_envelope }).ok) return { ok: false, reason: "CTO task marker run lacks authenticated session/control-plane provenance" };
      const admittedSlices = new Set(wave?.slice_ids ?? []);
      const stateSlices = state.teams.map((team) => team.slice_id).filter((sliceId): sliceId is string => typeof sliceId === "string");
      if (!wave || !waveIdentity || admittedSlices.size !== wave.slice_ids.length || state.teams.length !== wave.slice_ids.length || stateSlices.length !== state.teams.length || stateSlices.some((sliceId) => !admittedSlices.has(sliceId)) || admittedSlices.size !== stateSlices.length) return { ok: false, reason: "recovery_required: authenticated CTO execution wave and team slice set/cardinality do not match" };
      if (wave.slice_ids.filter((sliceId) => sliceId === parsed.sliceId).length !== 1) return { ok: false, reason: `CTO task marker slice '${parsed.sliceId}' is not uniquely admitted by the active execution wave` };
      const providerRef = `${CTO_HOST_TOOL_CALL_PREFIX}${event.toolCallId}`; const existingBinding = state.teams.find((candidate) => candidate.pending?.provider_ref === providerRef); if (existingBinding) return { ok: false, reason: existingBinding.slice_id === parsed.sliceId ? `CTO task marker slice '${parsed.sliceId}' already has this host tool call bound` : `CTO task tool call is already bound to foreign CTO slice '${String(existingBinding.slice_id)}'` };
      const matches = state.teams.filter((team) => team.slice_id === parsed.sliceId); if (matches.length !== 1) return { ok: false, reason: `CTO task marker slice '${parsed.sliceId}' does not map to exactly one authenticated team` }; const team = matches[0]!;
      if (team.status !== "pending") return { ok: false, reason: `CTO task marker slice '${parsed.sliceId}' is not ready (team status '${team.status}')` }; if (team.pending) return { ok: false, reason: `CTO task marker slice '${parsed.sliceId}' already has a pending host dispatch` };
      const identity = team.work_identity; if (!identity || !validateTypedControlPlane({ work_identity: identity }).ok || identity.run_id !== state.id || identity.wave_id !== wave.id || identity.slice_id !== parsed.sliceId || identity.slot_id !== team.slice_id || identity.task_id !== team.task_id || identity.session_id !== options.sessionId || identity.workflow !== waveIdentity.workflow || identity.stage_id !== "execution" || identity.stage_cursor !== "execution" || identity.capability_id !== waveIdentity.capability_id || identity.capability_epoch !== waveIdentity.capability_epoch || identity.attempt !== 1 || identity.worker_id.length === 0 || identity.dispatch_id.length === 0) return { ok: false, reason: `CTO task marker slice '${parsed.sliceId}' has no exact authenticated work identity` };
      const planEntry = state.plan?.teams?.find((entry) => entry.slice === parsed.sliceId); if (!planEntry || planEntry.team !== team.id || planEntry.team_def_id !== team.team_def_id || !Array.isArray(planEntry.scope) || planEntry.scope.length === 0) return { ok: false, reason: `CTO task marker slice '${parsed.sliceId}' has no exact authenticated team mapping` };
      if (!team.feature_id || !team.run_key || !team.task_id || !state.specification_execution_requested_selections?.some((selection) => selection.feature_id === team.feature_id && selection.run_key === team.run_key)) return { ok: false, reason: `CTO task marker slice '${parsed.sliceId}' has no exact selected feature/run binding` };
      for (const dependency of planEntry.depends_on) { const predecessor = state.teams.find((candidate) => candidate.id === dependency); if (!predecessor || predecessor.status !== "done") return { ok: false, reason: `CTO task marker slice '${parsed.sliceId}' is not topologically ready; dependency '${dependency}' is not done` }; }
      const toolCallId = event.toolCallId!; team.pending = { identity, status: "running", provider_ref: providerRef, terminal_signal: null, updated_at: new Date().toISOString() }; setTeamStatus(state, team.id, "in_progress"); transaction.writeState(state);
      return { ok: true, feature_id: team.feature_id, run_key: team.run_key, slice_id: team.slice_id!, team_id: team.id, task_id: team.task_id, dispatch_id: identity.dispatch_id, tool_call_id: toolCallId, work_identity: { ...identity } };
    });
  } catch (error) { return { ok: false, reason: `${error instanceof CtoRuntimeAccessError ? "recovery_required: " : ""}CTO task authorization failed: ${error instanceof Error ? error.message : String(error)}` }; }
  finally { if (ownsPin) pinnedRoot.close(); }
}

/**
 * Prepare a fresh explicit CTO specification execution wave. Repeated calls
 * with the same canonical request replay the existing active wave; changed
 * selectors, task refs, or plan data fail closed rather than taking over it.
 */
export function prepareCtoSpecificationExecution(
  projectRoot: string,
  input: CtoSpecificationExecutionPreparationInput,
  options: PrepareCtoSpecificationExecutionOptions,
): CtoSpecificationExecutionPreparationResult {
  const borrowedPinnedRoot = options?.pinnedRoot;
  const pinnedRoot = borrowedPinnedRoot ?? PinnedProjectRoot.open(projectRoot);
  if (!pinnedRoot) return blocked("project root is missing or cannot be canonicalized");
  const root = pinnedRoot.canonical_root;
  const runtimeAccess = options?.runtimeAccess;
  if (!isSafeCtoRuntimeSessionId(options?.sessionId)) {
    if (!borrowedPinnedRoot) pinnedRoot.close();
    return blocked("recovery_required: a bounded non-blank host sessionId is required for CTO execution preparation");
  }
  const sessionId = options.sessionId;
  try {
    assertCtoRuntimeAccessFacadeLive(runtimeAccess, root, sessionId);
    runtimeAccess.assertProjectRoot(root);
    runtimeAccess.assertLive();
  } catch (error) {
    if (!borrowedPinnedRoot) pinnedRoot.close();
    return blocked(`recovery_required: authenticated CTO runtime access is unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }
  let requestedSelections: CtoSpecificationExecutionSelection[] = [];
  let eligibleSelections: CtoSpecificationExecutionSelection[] = [];
  let excluded: CtoSpecificationExecutionExcludedSelection[] = [];
  try {
    if (!input || typeof input !== "object") return blocked("preparation input is required");
    const inputIssue = validatePreparationInput(input);
    if (inputIssue) return blocked(inputIssue);
    if (!isSafeCtoRunId(input.cto_run_id)) return blocked("cto_run_id must be a safe non-empty CTO run id");
    if (typeof input.task !== "string" || input.task.trim().length === 0) return blocked("task must be non-blank");
    if (typeof input.branch !== "string" || input.branch.trim().length === 0) return blocked("branch must be non-blank");
    const classError = classifyError(input.classification, "classification");
    if (classError) return blocked(classError);
    if (!Array.isArray(input.selections) || input.selections.length === 0) return blocked("at least one explicit feature/run selection is required");
    if (!Array.isArray(input.teams) || input.teams.length === 0) return blocked("at least one explicit team/task mapping is required");
    const seenFeatures = new Set<string>();
    for (const selection of input.selections) {
      if (!selection || !SAFE_FEATURE.test(selection.feature_id) || typeof selection.run_key !== "string" || selection.run_key.trim().length === 0) return blocked("each selection requires a safe feature_id and non-blank run_key");
      if (seenFeatures.has(selection.feature_id)) return blocked(`duplicate feature selection '${selection.feature_id}'`);
      seenFeatures.add(selection.feature_id);
    }
    requestedSelections = input.selections.map((selection) => ({ feature_id: selection.feature_id, run_key: selection.run_key }));
    const defs = defsMap(options?.defs);
    if (borrowedPinnedRoot && (!pinnedRoot.isStable() || !pinnedTeamDefsMatch(pinnedRoot, defs))) {
      return blockedWithSelectionReport(requestedSelections, eligibleSelections, excluded, ["TeamDef registry changed after it was pinned"]);
    }
    if (defs.size === 0) return blockedWithSelectionReport(requestedSelections, eligibleSelections, excluded, ["team registry is empty or invalid"]);
    eligibleSelections = [];
    excluded = [];
    const loaded = new Map<string, { workspace: FeatureWorkspace; handoff: ImplementationHandoff }>();
    for (const selection of requestedSelections) {
      const eligibility = evaluateSelectionEligibility(root, input.cto_run_id, selection, pinnedRoot);
      if (!eligibility.ok) {
        excluded.push({ ...selection, findings: [...eligibility.findings] });
        continue;
      }
      eligibleSelections.push({ ...selection });
      loaded.set(selection.feature_id, { workspace: eligibility.value.workspace, handoff: eligibility.value.handoff });
    }
    if (eligibleSelections.length === 0) return blockedWithSelectionReport(requestedSelections, eligibleSelections, excluded);
    const selectionMap = new Map(eligibleSelections.map((selection) => [selection.feature_id, selection]));
    let mapping;
    try {
      mapping = buildCtoSpecificationMapping({
        cto_run_id: input.cto_run_id,
        selections: eligibleSelections.map((selection) => ({ ...selection, run_key: selection.run_key, handoff: loaded.get(selection.feature_id)!.handoff })),
      });
    }
    catch (error) { return blockedWithSelectionReport(requestedSelections, eligibleSelections, excluded, [`mapping construction failed: ${String(error)}`]); }
    const taskLookup = new Map(mapping.task_to_slice.map((owner) => [`${owner.feature_id}\0${owner.task_id}`, owner]));
    const planTeams: PlanTeamInput[] = [];
    const preparedTeams: ReplayTeamExpectation[] = [];
    const seenTasks = new Set<string>();
    const excludedFeatures = new Set(excluded.map((entry) => entry.feature_id));
    const teamsForEligible = input.teams
      .map((team, index) => ({ team, index }))
      .filter(({ team }) => {
        const featureId = team && typeof team === "object" && !Array.isArray(team)
          && team.task_ref && typeof team.task_ref === "object"
          ? team.task_ref.feature_id
          : undefined;
        return typeof featureId !== "string" || !excludedFeatures.has(featureId);
      });
    for (const { team, index } of teamsForEligible) {
      const label = `teams[${index}]`;
      if (!team || typeof team !== "object" || Array.isArray(team)) return blockedWithSelectionReport(requestedSelections, eligibleSelections, excluded, [`${label} must be an object`]);
      if (typeof team.team !== "string" || !defs.has(team.team)) return blockedWithSelectionReport(requestedSelections, eligibleSelections, excluded, [`${label}.team is not a known TeamDef id`]);
      const def = defs.get(team.team)!;
      const taskRef = team.task_ref;
      if (!taskRef || typeof taskRef.feature_id !== "string" || typeof taskRef.task_id !== "string") return blockedWithSelectionReport(requestedSelections, eligibleSelections, excluded, [`${label}.task_ref must identify feature_id and task_id`]);
      const selection = selectionMap.get(taskRef.feature_id);
      if (!selection) return blockedWithSelectionReport(requestedSelections, eligibleSelections, excluded, [`${label}.task_ref references an unselected feature`]);
      const owner = taskLookup.get(`${taskRef.feature_id}\0${taskRef.task_id}`);
      if (!owner) return blockedWithSelectionReport(requestedSelections, eligibleSelections, excluded, [`${label}.task_ref does not match a task in the frozen handoff`]);
      if (!isSafeCtoRunId(owner.slice_id)) return blockedWithSelectionReport(requestedSelections, eligibleSelections, excluded, [`${label}.task_ref slice_id must be a non-reserved safe CTO run id`]);
      const taskKey = `${taskRef.feature_id}\0${taskRef.task_id}`;
      if (seenTasks.has(taskKey)) return blockedWithSelectionReport(requestedSelections, eligibleSelections, excluded, [`duplicate task_ref '${taskRef.feature_id}/${taskRef.task_id}'`]);
      seenTasks.add(taskKey);
      const clsError = classifyError(team.classification, label);
      if (clsError) return blockedWithSelectionReport(requestedSelections, eligibleSelections, excluded, [clsError]);
      let resolvedWorkflow: WorkflowName;
      try { resolvedWorkflow = resolveWorkflowForClassification(team.classification); } catch (error) { return blockedWithSelectionReport(requestedSelections, eligibleSelections, excluded, [`${label}: ${String(error)}`]); }
      if (team.workflow !== undefined && team.workflow !== resolvedWorkflow) return blockedWithSelectionReport(requestedSelections, eligibleSelections, excluded, [`${label}.workflow must equal '${resolvedWorkflow}'`]);
      const profile = team.profile ?? def.profile;
      if (profile !== def.profile) return blockedWithSelectionReport(requestedSelections, eligibleSelections, excluded, [`${label}.profile must match authenticated TeamDef '${def.id}' profile '${def.profile}'`]);
      const handoffTask = loaded.get(taskRef.feature_id)?.handoff.tasks.find((candidate) => candidate.task_id === taskRef.task_id);
      if (!handoffTask) return blockedWithSelectionReport(requestedSelections, eligibleSelections, excluded, [`${label}.task_ref does not have an authenticated pinned handoff task`]);
      const derivedScope = canonicalPreparationScope(Array.isArray(handoffTask.affected_scope) && handoffTask.affected_scope.length > 0 ? handoffTask.affected_scope : def.scope);
      const policyScope = canonicalPreparationScope(def.scope);
      const requestedScope = canonicalPreparationScope(team.scope === undefined ? (derivedScope ?? []) : team.scope);
      if (!derivedScope || !policyScope || !requestedScope || canonicalJson(requestedScope) !== canonicalJson(derivedScope)) return blockedWithSelectionReport(requestedSelections, eligibleSelections, excluded, [`${label}.scope must exactly match the authenticated pinned task affected scope`]);
      if (derivedScope.some((scope) => !preparationScopeWithinPolicy(scope, policyScope))) return blockedWithSelectionReport(requestedSelections, eligibleSelections, excluded, [`${label}.scope is outside authenticated TeamDef '${def.id}' scope policy`]);
      let dod: DoD;
      try {
        const normalized = normalizeDod(team.dod, label);
        if ("error" in normalized) return blockedWithSelectionReport(requestedSelections, eligibleSelections, excluded, [normalized.error]);
        dod = normalized.value;
      } catch (error) { return blockedWithSelectionReport(requestedSelections, eligibleSelections, excluded, [error instanceof Error ? error.message : String(error)]); }
      const teamId = ctoSpecificationTeamId(taskRef.feature_id, selection.run_key, loaded.get(taskRef.feature_id)!.handoff.handoff_digest, taskRef.task_id);
      const dodPath = `.work-state/cto/${input.cto_run_id}/artifacts/${teamId}`;
      planTeams.push({ team: teamId, team_def_id: def.id, scope: [...(derivedScope ?? [])], slice: owner.slice_id, profile, worktree: team.worktree ?? "same_branch", depends_on: [...(team.depends_on ?? [])] });
      preparedTeams.push({ input: team, def, owner, workflow: resolvedWorkflow, dod, teamId, dodPath, dodDigest: canonicalCtoDoDDigest(dod), planDependsOn: [] });
    }
    if (seenTasks.size !== taskLookup.size) return blockedWithSelectionReport(requestedSelections, eligibleSelections, excluded, ["every handoff task must have exactly one explicit team/task mapping"]);
    const executionTeamIds = new Set(preparedTeams.map((entry) => entry.teamId));
    for (let index = 0; index < preparedTeams.length; index += 1) {
      const entry = preparedTeams[index]!;
      const dependencies = new Set<string>();
      for (const dependency of entry.owner.depends_on) {
        const predecessor = taskLookup.get(entry.owner.feature_id + "\0" + dependency);
        if (predecessor) dependencies.add(predecessor.team_id);
      }
      for (const dependency of entry.input.depends_on ?? []) {
        if (executionTeamIds.has(dependency)) {
          dependencies.add(dependency);
          continue;
        }
        const matchingTeamDefs = preparedTeams.filter((candidate) => candidate.def.id === dependency);
        if (matchingTeamDefs.length > 0) {
          for (const candidate of matchingTeamDefs) dependencies.add(candidate.teamId);
          continue;
        }
        return blockedWithSelectionReport(requestedSelections, eligibleSelections, excluded, [`teams[${index}].depends_on references unknown execution team or TeamDef ${dependency}`]);
      }
      dependencies.delete(entry.teamId);
      const resolved = [...dependencies].sort();
      entry.planDependsOn = resolved;
      planTeams[index] = { ...planTeams[index]!, depends_on: resolved };
    }
    if (!pinnedRoot.isStable()) return blockedWithSelectionReport(requestedSelections, eligibleSelections, excluded, ["project root changed during preparation validation"]);
    let resolvedRunWorkflow: WorkflowName;
    try { resolvedRunWorkflow = resolveWorkflowForClassification(input.classification); } catch (error) { return blockedWithSelectionReport(requestedSelections, eligibleSelections, excluded, [`classification workflow is invalid: ${String(error)}`]); }
    const requestDigest = preparationDigest({
      task: input.task,
      branch: input.branch,
      classification: input.classification,
      workflow: resolvedRunWorkflow,
      selections: input.selections,
      teams: preparedTeams,
    });
    const sourceId = input.source_id ?? `cto-prepare-${requestDigest.slice(0, 32)}`;
    const waveId = input.wave_id ?? `wave-${digestOf({ kind: "cto-specification-execution", cto_run_id: input.cto_run_id, source_id: sourceId }).slice(0, 32)}`;
    if (!isSafeCtoRunId(sourceId) || !isSafeCtoRunId(waveId)) return blockedWithSelectionReport(requestedSelections, eligibleSelections, excluded, ["wave_id and source_id must be non-reserved safe CTO run ids"]);
    const expectedWorkspaceDigests = new Map<string, string>(
      [...loaded.entries()].map(([featureId, value]) => [featureId, digestOf(value.workspace)]),
    );
    assertCtoRuntimeAccessFacadeLive(runtimeAccess, root, sessionId);
    runtimeAccess.assertProjectRoot(root);
    runtimeAccess.assertLive();
    let existing = runtimeAccess.readState(input.cto_run_id) as unknown as CtoState | null;
      if (existing && existing.owner_session !== sessionId) return blockedWithSelectionReport(requestedSelections, eligibleSelections, excluded, ["existing CTO run is owned by a different host session"]);
      let existingStateRevision = existing?.state_revision ?? 0;
      if (existing?.specification_preparation_transaction
        && existing.specification_preparation_transaction.status !== "committed"
        && existing.specification_preparation_transaction.status !== "rolled_back") {
        const recovered = recoverPreparationTransaction(runtimeAccess, existing, root, pinnedRoot);
        if (!recovered.ok) return blockedWithSelectionReport(requestedSelections, eligibleSelections, excluded, [recovered.error]);
        existing = recovered.state;
        existingStateRevision = existing.state_revision ?? existingStateRevision;
      }
      let rolledBackExisting: CtoState | null = null;
      if (existing?.specification_preparation_transaction?.status === "rolled_back") {
        rolledBackExisting = existing;
        existing = null;
      }
      if (existing && existing.specification_preparation_transaction?.status !== "rolled_back") {
        const exactExisting = runtimeAccess.withRunTransaction(input.cto_run_id, (transaction) => transaction.readState());
        if (exactExisting.owner_session !== sessionId) return blockedWithSelectionReport(requestedSelections, eligibleSelections, excluded, ["existing CTO run is owned by a different host session"]);
        const replay = replayResult(exactExisting, input.cto_run_id, {
          task: input.task,
          branch: input.branch,
          classification: input.classification,
          workflow: resolvedRunWorkflow,
          sourceId,
          waveId,
          selections: requestedSelections,
          excluded,
          teams: preparedTeams,
        }, pinnedRoot);
        if (replay?.status === "ready" || replay?.status === "blocked") return replay;
        return blockedWithSelectionReport(requestedSelections, eligibleSelections, excluded, ["an existing CTO run has a different preparation identity; takeover is not permitted"]);
      }
      const profile = loadProfile(resolvedRunWorkflow);
      if (!profile) return blockedWithSelectionReport(requestedSelections, eligibleSelections, excluded, [`workflow profile '${resolvedRunWorkflow}' is unavailable`]);
      let cap = createCapability({ run_key: input.cto_run_id, branch: input.branch, workflow: resolvedRunWorkflow, profile_hash: profileHash(profile), stage_cursor: "execution", kind: "consilium", expected_roster: preparedTeams.map((entry) => ({ role: entry.owner.slice_id, agent: entry.def.lead })) });
      const initialCapabilityEpoch = cap.state.issued_for?.cursor_epoch;
      if (!initialCapabilityEpoch) return blockedWithSelectionReport(requestedSelections, eligibleSelections, excluded, ["execution capability epoch is unavailable"]);
      let capabilityEpoch = initialCapabilityEpoch;
      const planResult = buildTeamPlan({ id: input.cto_run_id, task: input.task, teams: planTeams }, defs);
      if (!planResult.ok) return blockedWithSelectionReport(requestedSelections, eligibleSelections, excluded, [planResult.reason]);
      const depth = validateDecompositionDepth(planResult.plan, options.profileDepth);
      if (!depth.ok) return blockedWithSelectionReport(requestedSelections, eligibleSelections, excluded, [depth.reason]);
      let state = newCtoState({ id: input.cto_run_id, task: input.task, branch: input.branch, autonomous: input.classification.autonomous, classification: input.classification, plan: planResult.plan, owner_session: sessionId });
      state.state_revision = existingStateRevision;
      state.specification_execution_preparation_digest = requestDigest;
      state.specification_execution_requested_selections = requestedSelections.map((selection) => ({ ...selection }));
      state.specification_execution_exclusions = excluded.map((entry) => ({ ...entry, findings: [...entry.findings] }));
      const confirmationAnchor = eligibleSelections[0]!;
      state.specification_execution_anchor = { ...confirmationAnchor };
      let identities = preparedTeams.map((entry): WorkIdentity => ({ run_id: input.cto_run_id, wave_id: waveId, slice_id: entry.owner.slice_id, session_id: sessionId, workflow: entry.workflow, stage_id: "execution", stage_cursor: "execution", capability_id: cap.capability_id, capability_epoch: capabilityEpoch, slot_id: entry.owner.slice_id, task_id: entry.owner.task_id, dispatch_id: `dispatch-${digestOf({ kind: "cto-execution-dispatch", feature_id: entry.owner.feature_id, task_id: entry.owner.task_id }).slice(0, 32)}`, attempt: 1, worker_id: entry.def.lead }));
      let firstIdentity = identities[0];
      if (!firstIdentity) throw new Error("CTO execution preparation produced no work identity");
      const initialPending = { identity: firstIdentity, status: "authorized" as const, terminal_signal: null, updated_at: new Date().toISOString() };
      const initialCompletionEnvelope = { schema_version: 1 as const, identity: firstIdentity, outcome: "pending" as const, terminal_signal: null, artifact_refs: [], evidence_ref: null, conflict_ref: null, completed_by: "engine_task_caller" as const, emitted_at: new Date().toISOString() };
      state.work_identity = firstIdentity;
      state.pending = initialPending;
      state.completion_envelope = initialCompletionEnvelope;
      state.control_plane_provenance = { completion_intent: "none", checkpoint_policy: "none", roster_policy: "none", roster_selection: "none", work_identity: "state", pending: "state", child_join: "none", completion_envelope: "state", legacy_inputs: [], warnings: [], status: "typed" };
      const persistedWorkIdentity = state.work_identity;
      const persistedPending = state.pending;
      const persistedCompletionEnvelope = state.completion_envelope;
      if (!persistedWorkIdentity || !persistedPending || !persistedCompletionEnvelope
        || canonicalJson(persistedWorkIdentity) !== canonicalJson(firstIdentity)
        || canonicalJson(persistedPending.identity) !== canonicalJson(firstIdentity)
        || canonicalJson(persistedCompletionEnvelope.identity) !== canonicalJson(firstIdentity)
        || !validateTypedControlPlane({ work_identity: persistedWorkIdentity, pending: persistedPending, completion_envelope: persistedCompletionEnvelope }).ok) throw new Error("CTO execution preparation produced an invalid top-level work identity control plane");
      state.teams = preparedTeams.map((entry, index) => ({ id: entry.teamId, status: "pending", escalations: {}, feature_id: entry.owner.feature_id, run_key: selectionMap.get(entry.owner.feature_id)!.run_key, task_id: entry.owner.task_id, team_def_id: entry.def.id, slice_id: entry.owner.slice_id, classification: entry.input.classification, workflow: entry.workflow, dod_path: entry.dodPath, dod_digest: entry.dodDigest, work_identity: identities[index] }));
      const featureStatePath = `.work-state/features/${confirmationAnchor.feature_id}/state.json`;
      const transaction: CtoSpecificationPreparationTransaction = {
        schema_version: 1,
        id: `cto-preparation-${requestDigest.slice(0, 32)}`,
        status: "prepared",
        request_digest: requestDigest,
        source_id: sourceId,
        wave_id: waveId,
        root_identity: { canonical_path: root, dev: pinnedRoot.dev, ino: pinnedRoot.ino },
        expected_state_revision: existingStateRevision,
        feature_state: { path: featureStatePath, before: capturePreparationImage(pinnedRoot, input.cto_run_id, featureStatePath) },
        dod_files: preparedTeams.map((entry) => ({
          path: `${entry.dodPath}/dod.json`,
          before: capturePreparationImage(pinnedRoot, input.cto_run_id, `${entry.dodPath}/dod.json`),
        })),
        updated_at: new Date().toISOString(),
      };
      state.specification_preparation_transaction = transaction;
      if (rolledBackExisting && ctoRuntimeRunInitialIdentityDigest(rolledBackExisting) !== ctoRuntimeRunInitialIdentityDigest(state)) {
        return blockedWithSelectionReport(requestedSelections, eligibleSelections, excluded, ["rolled-back CTO preparation identity does not match the exact retry request; takeover is not permitted"]);
      }
      if (!existing) {
        state = runtimeAccess.createRun(state, { source_id: `cto-run:${input.cto_run_id}`, initial_state_sha256: ctoRuntimeRunInitialIdentityDigest(state) });
        if (rolledBackExisting) {
          const priorTransaction = state.specification_preparation_transaction;
          const priorPlan = state.plan;
          const priorSelections = state.specification_execution_requested_selections;
          const priorIdentity = state.work_identity;
          const priorTeams = state.teams;
          const retryMatches = state.owner_session === sessionId
            && state.task === input.task
            && state.branch === input.branch
            && state.specification_execution_preparation_digest === requestDigest
            && !!priorTransaction
            && priorTransaction.status === "rolled_back"
            && priorTransaction.request_digest === requestDigest
            && priorTransaction.source_id === sourceId
            && priorTransaction.wave_id === waveId
            && canonicalJson(priorSelections ?? []) === canonicalJson(requestedSelections)
            && !!priorPlan
            && priorPlan.id === planResult.plan.id
            && priorPlan.task === planResult.plan.task
            && canonicalJson(priorPlan.teams) === canonicalJson(planResult.plan.teams)
            && state.active_wave_id === undefined
            && Array.isArray(priorTeams)
            && priorTeams.length === preparedTeams.length
            && !!priorIdentity
            && priorTeams.every((team, index) => {
              const expected = preparedTeams[index];
              const identity = team.work_identity;
              return !!expected
                && team.id === expected.teamId
                && team.feature_id === expected.owner.feature_id
                && team.run_key === selectionMap.get(expected.owner.feature_id)?.run_key
                && team.task_id === expected.owner.task_id
                && team.team_def_id === expected.def.id
                && team.slice_id === expected.owner.slice_id
                && team.workflow === expected.workflow
                && team.dod_path === expected.dodPath
                && team.dod_digest === expected.dodDigest
                && !!identity
                && identity.run_id === input.cto_run_id
                && identity.wave_id === waveId
                && identity.slice_id === expected.owner.slice_id
                && identity.stage_id === "execution"
                && identity.stage_cursor === "execution";
            });
          if (!retryMatches || !priorIdentity || priorTeams.some((team) => !team.work_identity)) {
            return blockedWithSelectionReport(requestedSelections, eligibleSelections, excluded, ["rolled-back CTO preparation identity does not match the exact retry request; takeover is not permitted"]);
          }
          const restoredIdentities: WorkIdentity[] = [];
          for (const team of priorTeams) {
            const identity = team.work_identity;
            if (!identity) return blockedWithSelectionReport(requestedSelections, eligibleSelections, excluded, ["rolled-back CTO preparation state is missing an authenticated team identity"]);
            restoredIdentities.push(identity);
          }
          identities = restoredIdentities;
          firstIdentity = priorIdentity;
          capabilityEpoch = priorIdentity.capability_epoch;
          cap = createCapability({
            run_key: input.cto_run_id,
            branch: input.branch,
            workflow: resolvedRunWorkflow,
            profile_hash: profileHash(profile),
            stage_cursor: "execution",
            cursor_epoch: capabilityEpoch,
            capability_id: priorIdentity.capability_id,
            kind: "consilium",
            expected_roster: preparedTeams.map((entry) => ({ role: entry.owner.slice_id, agent: entry.def.lead })),
          });
          state.specification_preparation_transaction = transaction;
        }
      }
      const assertAllSelectedConstitutionsCurrent = (): void => {
        if (!pinnedRoot.isStable()) throw new Error("project root changed before CTO execution state commit");
        for (const selection of eligibleSelections) {
          const expected = loaded.get(selection.feature_id);
          const expectedDigest = expectedWorkspaceDigests.get(selection.feature_id);
          if (!expected || !expectedDigest) throw new Error(`selected workspace '${selection.feature_id}' lacks an execution preimage`);
          const current = resolveFeatureWorkspace(root, selection, {
            lexical_root: pinnedRoot.lexical_root,
            canonical_root: pinnedRoot.canonical_root,
            dev: pinnedRoot.dev,
            ino: pinnedRoot.ino,
            pinned_root: pinnedRoot,
          }, { persistMigration: false, requireMigration: true });
          if (!current.ok) throw new Error(current.error);
          if (digestOf(current.value) !== expectedDigest) throw new Error(`selected workspace '${selection.feature_id}' changed before CTO execution state commit`);
          const binding = expected.workspace.constitution_binding;
          const gateId = expected.workspace.constitution_gate_ref;
          if (!binding || !gateId || !current.value.constitution_binding
            || digestOf(current.value.constitution_binding) !== digestOf(binding)
            || current.value.constitution_gate_ref !== gateId) {
            throw new Error(`selected workspace '${selection.feature_id}' constitution binding changed before CTO execution state commit`);
          }
          const issue = currentConstitutionPersistenceIssue(root, binding, gateId, pinnedRoot);
          if (issue) throw new Error(`selected workspace '${selection.feature_id}' constitution is stale: ${issue}`);
        }
        if (!pinnedRoot.isStable()) throw new Error("project root changed after CTO execution state precommit");
      };
      state = persistPreparationTransaction(runtimeAccess, state, pinnedRoot, transaction, assertAllSelectedConstitutionsCurrent);
      transaction.feature_state.after = capturePreparationImage(pinnedRoot, input.cto_run_id, featureStatePath);
      state = persistPreparationTransaction(runtimeAccess, state, pinnedRoot, transaction, assertAllSelectedConstitutionsCurrent);
      for (let index = 0; index < preparedTeams.length; index += 1) {
        const entry = preparedTeams[index]!;
        writeCtoDoDExclusive(pinnedRoot, entry.dodPath, entry.dod, {
          beforeWrite: assertAllSelectedConstitutionsCurrent,
        });
        transaction.status = "committing";
        transaction.updated_at = new Date().toISOString();
        transaction.dod_files[index]!.after = capturePreparationImage(pinnedRoot, input.cto_run_id, `${entry.dodPath}/dod.json`);
        transaction.feature_state.after = capturePreparationImage(pinnedRoot, input.cto_run_id, featureStatePath);
        state = persistPreparationTransaction(runtimeAccess, state, pinnedRoot, transaction, assertAllSelectedConstitutionsCurrent);
        injectPreparationFailure(root, pinnedRoot, "after_dod_write", entry.owner.feature_id);
      }
      assertAllSelectedConstitutionsCurrent();
      findPreparationHook(root, pinnedRoot)?.beforeAnchorBind?.(confirmationAnchor.feature_id);
      const anchorError = bindSpecificationExecutionAnchor(root, confirmationAnchor, cap.state, capabilityEpoch, pinnedRoot, {
        cto_run_id: input.cto_run_id,
        branch: input.branch,
        classification: input.classification,
      });
      if (anchorError) throw new Error(`confirmation anchor binding failed: ${anchorError}`);
      const anchorWorkspace = resolveFeatureWorkspace(root, confirmationAnchor, {
        lexical_root: pinnedRoot.lexical_root,
        canonical_root: pinnedRoot.canonical_root,
        dev: pinnedRoot.dev,
        ino: pinnedRoot.ino,
        pinned_root: pinnedRoot,
      }, { persistMigration: false, requireMigration: true });
      if (!anchorWorkspace.ok) throw new Error(anchorWorkspace.error);
      expectedWorkspaceDigests.set(confirmationAnchor.feature_id, digestOf(anchorWorkspace.value));
      transaction.status = "committing";
      transaction.updated_at = new Date().toISOString();
      transaction.feature_state.after = capturePreparationImage(pinnedRoot, input.cto_run_id, featureStatePath);
      // Journal the exact anchor postimage before re-validating every selected
      // workspace. If a non-anchor workspace drifts during this final seam,
      // recovery must know the anchor mutation it is responsible for undoing.
      state = persistPreparationTransaction(runtimeAccess, state, pinnedRoot, transaction);
      assertAllSelectedConstitutionsCurrent();
      injectPreparationFailure(root, pinnedRoot, "after_feature_capability_write", confirmationAnchor.feature_id);
      injectPreparationFailure(root, pinnedRoot, "before_wave_commit", confirmationAnchor.feature_id);
      if (borrowedPinnedRoot && (!pinnedRoot.isStable() || !pinnedTeamDefsMatch(pinnedRoot, defs))) {
        throw new Error("TeamDef registry changed before CTO state commit");
      }
      transaction.status = "committed";
      transaction.updated_at = new Date().toISOString();
      state = runtimeAccess.withRunTransaction(input.cto_run_id, (transactionFacade) => {
        const current = transactionFacade.readState();
        if (current.state_revision !== state.state_revision) throw new Error(`CTO preparation state changed before wave commit (expected ${String(state.state_revision)}, got ${String(current.state_revision)})`);
        current.specification_preparation_transaction = transaction;
        assertAllSelectedConstitutionsCurrent();
        state = transactionFacade.appendWave({ id: waveId, source: "specification-execution", source_id: sourceId, task: input.task, slice_ids: identities.map((identity) => identity.slice_id), work_identity: firstIdentity });
        if (state.active_wave_id !== waveId || !state.wave_history?.some((wave) => wave.id === waveId && wave.status === "active" && wave.source === "specification-execution")) throw new Error("CTO execution wave was not admitted by the authenticated run transaction");
        return state;
      });
      assertCtoRuntimeAccessFacadeLive(runtimeAccess, root, sessionId);
      runtimeAccess.assertProjectRoot(root);
      runtimeAccess.assertLive();
      return {
        status: "ready",
        prepared: true,
        dispatched: false,
        cto_run_id: input.cto_run_id,
        wave_id: waveId,
        source_id: sourceId,
        capability_id: cap.capability_id,
        capability_epoch: capabilityEpoch,
        confirmation_anchor: { ...confirmationAnchor },
        requested_selections: requestedSelections.map((selection) => ({ ...selection })),
        eligible_selections: eligibleSelections.map((selection) => ({ ...selection })),
        excluded: excluded.map((entry) => ({ ...entry, findings: [...entry.findings] })),
        slices: preparedTeams.map((entry, index) => ({
          feature_id: entry.owner.feature_id,
          run_key: selectionMap.get(entry.owner.feature_id)!.run_key,
          task_id: entry.owner.task_id,
          team_id: entry.teamId,
          team_def_id: entry.def.id,
          slice_id: entry.owner.slice_id,
          dod_path: entry.dodPath,
          work_identity: identities[index]!,
        })),
      };
  } catch (error) {
    const message = `CTO preparation failed: ${error instanceof Error ? error.message : String(error)}`;
    try {
      const current = runtimeAccess.readState(input?.cto_run_id) as unknown as CtoState | null;
      const recovered = current?.specification_preparation_transaction
        && current.specification_preparation_transaction.status !== "committed"
        && current.specification_preparation_transaction.status !== "rolled_back"
        ? recoverPreparationTransaction(runtimeAccess, current, root, pinnedRoot)
        : null;
      const recoveryError = recovered && !recovered.ok ? recovered.error : null;
      if (recoveryError) return blockedWithSelectionReport(requestedSelections, eligibleSelections, excluded, [message, recoveryError]);
    } catch (recoveryError) {
      return blockedWithSelectionReport(requestedSelections, eligibleSelections, excluded, [message, `preparation rollback failed: ${recoveryError instanceof Error ? recoveryError.message : String(recoveryError)}`]);
    }
    return blockedWithSelectionReport(requestedSelections, eligibleSelections, excluded, [message]);
  } finally {
    if (!borrowedPinnedRoot) pinnedRoot.close();
  }
}
