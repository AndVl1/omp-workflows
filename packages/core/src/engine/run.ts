/* <!-- omp-cto-slice run=01a03ee4-7dd6-7580-8ad7-16d26dc886ba slice=workflow-v2-core --> */
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
 * Autonomy contract (RC2+): `classification.autonomous` is a routing/migration
 * input, authoritative only for the legacy workflow matrix. It NEVER grants
 * checkpoint permission; a checkpoint requires a policy-bound typed decision.
 * When the field is supplied, type/complexity/confidence/autonomous must all be
 * present — the engine FAILS CLOSED rather than silently filling the gaps from
 * keyword guesses.
 * `keywordClassify` remains only for legacy callers that run without a model
 * classification; it cannot decide autonomy (the caller's `autonomous` option
 * is used verbatim, never defaulted).
 */

import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { loadProfileByIdentity, resolveProfileForClassification, resolveWorkflow } from "./profile.js";
import { validateProviderCatalog } from "../workflow-v2/descriptor.js";
import { minimatch } from "./minimatch.js";
import { writeState, setStageStatus, setPause, resolveState, reopenFromFeedback, normalizePersistedState, type ResolvedState } from "./state.js";
import {
  authorizeDispatch,
  completeDispatch,
  advanceCursor,
  createCapability,
  type CapabilityContext,
} from "./durable.js";
import { validateCheckpointForAdvance } from "./checkpoints.js";
import { keywordClassify } from "./classify.js";
import { resolveStageDispatchSlots, walkProfile, type StageContext, type TaskCaller } from "./stage.js";
import {
  buildWorkflowRunIdentity,
  validateProjectIdentity,
  validateWorkflowRunIdentity,
} from "../workflow-v2/identity.js";
import { createDiagnostic } from "../workflow-v2/diagnostics.js";
import type {
  AgentRef,
  CatalogProfile,
  EffectivePolicy,
  ProjectIdentity,
  ProviderCatalog,
  ProfileIdentity,
  WorkflowPrepareResult,
  WorkflowRunIdentity,
  WorkflowStateContext,
} from "../workflow-v2/types.js";
import { WorkflowLifecycleError, type Classification, type Complexity, type Confidence, type Profile, type TaskType, type TeamState, type WorkflowName, type DispatchSlot, type WorkIdentityScope, type WorkIdentity } from "./types.js";
import type { ScopeFlags } from "./scope.js";

const WORK_IDENTITY_SCOPE_KEYS = [
  "run_id", "wave_id", "slice_id", "session_id", "workflow", "stage_id",
  "stage_cursor", "slot_id", "task_id", "dispatch_id", "attempt", "worker_id",
] as const;

const WORK_IDENTITY_KEYS = [
  ...WORK_IDENTITY_SCOPE_KEYS, "capability_id", "capability_epoch",
] as const;

function validWorkIdentityScope(scope: WorkIdentityScope | undefined): scope is WorkIdentityScope {
  if (!scope || typeof scope !== "object") return false;
  const keys = Object.keys(scope);
  if (keys.length !== WORK_IDENTITY_SCOPE_KEYS.length
    || !WORK_IDENTITY_SCOPE_KEYS.every((key) => Object.prototype.hasOwnProperty.call(scope, key))) return false;
  return WORK_IDENTITY_SCOPE_KEYS.every((key) => key === "attempt"
    ? Number.isInteger(scope[key]) && scope[key] > 0
    : typeof scope[key] === "string" && scope[key].length > 0);
}

function validWorkIdentity(identity: WorkIdentity | undefined): identity is WorkIdentity {
  if (!identity || typeof identity !== "object") return false;
  const keys = Object.keys(identity);
  if (keys.length !== WORK_IDENTITY_KEYS.length
    || !WORK_IDENTITY_KEYS.every((key) => Object.prototype.hasOwnProperty.call(identity, key))) return false;
  return WORK_IDENTITY_KEYS.every((key) => key === "attempt"
    ? Number.isInteger(identity[key]) && identity[key] > 0
    : typeof identity[key] === "string" && identity[key].length > 0);
}

function scopeMatches(left: WorkIdentityScope, right: WorkIdentityScope, stageId?: string): boolean {
  return WORK_IDENTITY_SCOPE_KEYS.every((key) => {
    const leftValue = stageId && (key === "stage_id" || key === "stage_cursor") ? stageId : left[key];
    const rightValue = stageId && (key === "stage_id" || key === "stage_cursor") ? stageId : right[key];
    return leftValue === rightValue;
  });
}

function scopeForStage(identity: WorkIdentity, stageId: string): WorkIdentityScope {
  const { capability_id: _capability_id, capability_epoch: _capability_epoch, ...scope } = identity;
  return { ...scope, stage_id: stageId, stage_cursor: stageId };
}

function requireScope(scope: WorkIdentityScope | undefined, runIdentity: WorkflowRunIdentity, workflow: string, stageId: string): WorkIdentityScope {
  if (!validWorkIdentityScope(scope)) throw new WorkflowLifecycleError(createDiagnostic({ code: "MIGRATION_REQUIRED", operation: "runtime.activate", severity: "error", evidence: { field: "work_identity_scope" }, remediation: "Provide a complete work identity scope." }));
  if (scope.run_id !== runIdentity.run_id || scope.session_id !== runIdentity.session.session_id || scope.workflow !== workflow || scope.stage_id !== stageId || scope.stage_cursor !== stageId) {
    throw new WorkflowLifecycleError(createDiagnostic({ code: "IDENTITY_MISMATCH", operation: "runtime.activate", severity: "error", evidence: { field: "work_identity_scope" }, remediation: "Use the exact scope for this workflow run and stage." }));
  }
  return scope;
}
function requireFreshScope(
  scope: WorkIdentityScope | undefined,
  projectIdentity: ProjectIdentity,
  workflow: string,
  stageId: string,
): WorkIdentityScope {
  if (!validWorkIdentityScope(scope)) {
    throw new WorkflowLifecycleError(createDiagnostic({
      code: "MIGRATION_REQUIRED",
      operation: "runtime.activate",
      severity: "error",
      evidence: { field: "work_identity_scope" },
      remediation: "Provide an exact twelve-field work identity scope before creating a run identity.",
    }));
  }
  if (
    scope.session_id !== projectIdentity.session.session_id
    || scope.workflow !== workflow
    || scope.stage_id !== stageId
    || scope.stage_cursor !== stageId
  ) {
    throw new WorkflowLifecycleError(createDiagnostic({
      code: "IDENTITY_MISMATCH",
      operation: "runtime.activate",
      severity: "error",
      evidence: { field: "work_identity_scope", stage_id: stageId },
      remediation: "Use the exact caller scope for this project, workflow, and initial stage.",
    }));
  }
  return scope;
}

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
  files?: string[];
  orchestrate?: NonNullable<StageContext["orchestrate"]>;
  issue?: { number: number; url?: string } | null;
  pause?: (reason: string) => Promise<void>;
  log?: (line: string) => void;
  continuation?: { feedback: string; stageId: string };
  project_identity: ProjectIdentity;
  run_identity?: WorkflowRunIdentity;
  catalog: Readonly<ProviderCatalog>;
  effective_policy: Readonly<EffectivePolicy>;
  agent_inventory: readonly AgentRef[];
  work_identity_scope: WorkIdentityScope;
}
export interface RunResult {
  classification: Classification;
  profile: Profile;
  run_identity: WorkflowRunIdentity;
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
    if (model.type === "PRODUCT_DISCOVERY" && model.autonomous) {
      throw new Error(
        "classification gate: PRODUCT_DISCOVERY is always human-approved; autonomous product discovery fails closed (reclassify with autonomous=false, the product_approval checkpoint is interactive-only)",
      );
    }
    const expected = resolveWorkflow(model.type, model.complexity, model.autonomous);
    if (model.workflow !== undefined && model.workflow !== expected && (model.type === "SPEC" || model.type === "REGRESS" || model.type === "PRODUCT_DISCOVERY")) {
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
  if (base.type === "PRODUCT_DISCOVERY" && opts.autonomous) {
    throw new Error(
      "classification gate: PRODUCT_DISCOVERY is always human-approved; autonomous product discovery fails closed (reclassify with autonomous=false, the product_approval checkpoint is interactive-only)",
    );
  }
  return {
    type: base.type,
    complexity: base.complexity,
    confidence: base.confidence,
    autonomous: opts.autonomous,
    workflow: resolveWorkflow(base.type, base.complexity, opts.autonomous),
  };
}
export type WorkflowPrepareOptions =
  Pick<RunOptions, "task" | "cwd" | "branch" | "autonomous" | "classification" | "files" | "issue" | "continuation" | "work_identity_scope">
  & Pick<RunOptions, "project_identity" | "run_identity" | "catalog" | "effective_policy" | "agent_inventory">;

export interface PreparedWorkflowState extends WorkflowPrepareResult {
  project_identity: ProjectIdentity;
  run_identity: WorkflowRunIdentity;
  state_context: WorkflowStateContext;
  selected_profile: Readonly<CatalogProfile>;
  persisted: true;
  catalog: Readonly<ProviderCatalog>;
  effective_policy: Readonly<EffectivePolicy>;
  agent_inventory: readonly AgentRef[];
  profile_identity: ProfileIdentity;
  profile: Profile;
  flags: ScopeFlags;
  classification: Classification;
  state: TeamState;
  statePath: string;
  artifactsDir: string;
  stateTarget: { target?: ResolvedState };
  expectedRoster: (stage: NonNullable<Profile["stages"][number]>) => Array<{
    role: string;
    agent: string;
    agent_ref: AgentRef;
  }>;
}

function requiredStateBinding(
  state: Pick<TeamState, "run_key" | "profile_hash">,
  field: "run_key" | "profile_hash",
): string {
  const value = state[field];
  if (typeof value !== "string" || !value.trim()) {
    throw new WorkflowLifecycleError(createDiagnostic({
      code: "MIGRATION_REQUIRED",
      operation: "runtime.activate",
      severity: "error",
      evidence: { field },
      remediation: `Persist the canonical ${field} before continuing the workflow lifecycle.`,
    }));
  }
  return value;
}

function qualifiedAgentForRole(
  role: string,
  effective_policy: Readonly<EffectivePolicy>,
  agent_inventory: readonly AgentRef[],
): AgentRef {
  const direct = effective_policy.roles[role];
  const ref = direct ?? Object.values(effective_policy.roles).find((candidate) => candidate.registered_name === role);
  if (!ref) throw new Error(`MIGRATION_REQUIRED: role '${role}' has no provider-qualified policy agent`);
  const observed = agent_inventory.find((candidate) => candidate.registered_name === ref.registered_name);
  if (!observed || observed.provider_id !== ref.provider_id || observed.source_fingerprint !== ref.source_fingerprint) {
    throw new Error(`MIGRATION_REQUIRED: role '${role}' has no matching provider-qualified agent inventory entry`);
  }
  return ref;
}

function resolvePolicyScope(files: readonly string[], policy: Readonly<EffectivePolicy>): ScopeFlags {
  const flags: ScopeFlags = {
    scope: [],
    has_security: Boolean(policy.flags.has_security),
    has_infra: Boolean(policy.flags.has_infra),
    has_ui: Boolean(policy.flags.has_ui),
    has_runtime: Boolean(policy.flags.has_runtime),
    dev_agent: null,
  };
  const matched = new Set<string>();
  for (const file of files) {
    for (const rule of policy.scope_map) {
      let matches = false;
      try {
        matches = rule.patterns.some((pattern) => minimatch(file, pattern));
      } catch {
        matches = false;
      }
      if (!matches) continue;
      matched.add(rule.scope);
      flags.dev_agent = rule.dev_agent.registered_name;
      const runtime = typeof rule.runtime_class === "string" ? rule.runtime_class.trim().toLowerCase() : rule.runtime_class;
      flags.has_runtime ||= runtime === true || (typeof runtime === "string" && !["", "none", "static", "documentation", "ui"].includes(runtime));
      flags.has_ui ||= runtime === "ui" || rule.ui_class === true || (typeof rule.ui_class === "string" && rule.ui_class.trim().toLowerCase() === "ui");
      break;
    }
  }
  flags.scope = [...matched];
  for (const [name, value] of Object.entries(policy.flags)) flags[name] = value;
  return flags;
}

function sameProjectIdentity(left: ProjectIdentity, right: ProjectIdentity): boolean {
  return left.root_instance_id === right.root_instance_id
    && left.provider_id === right.provider_id
    && left.descriptor_fingerprint === right.descriptor_fingerprint
    && left.executable_provenance.build_fingerprint === right.executable_provenance.build_fingerprint
    && left.executable_provenance.runtime_fingerprint === right.executable_provenance.runtime_fingerprint
    && left.catalog_content_digest === right.catalog_content_digest
    && left.config_byte_sha256 === right.config_byte_sha256
    && left.config_semantic_sha256 === right.config_semantic_sha256
    && left.session.session_id === right.session.session_id
    && left.session.lifecycle_id === right.session.lifecycle_id;
}

function sameRunIdentity(left: WorkflowRunIdentity, right: WorkflowRunIdentity): boolean {
  return sameProjectIdentity(left, right)
    && left.run_id === right.run_id
    && left.profile_identity.id === right.profile_identity.id
    && left.profile_identity.fingerprint === right.profile_identity.fingerprint;
}

function validateCatalog(catalog: Readonly<ProviderCatalog>): Readonly<ProviderCatalog> {
  const checked = validateProviderCatalog(catalog);
  if (!checked.ok) {
    throw new WorkflowLifecycleError(checked.diagnostics[0] ?? createDiagnostic({
      code: "CONFIG_MALFORMED",
      operation: "catalog.validate",
      severity: "error",
      evidence: { field: "catalog" },
      remediation: "Provide the complete immutable provider catalog selected during project admission.",
    }));
  }
  return checked.value;
}
function validateProjectContext(
  opts: WorkflowPrepareOptions,
  catalog: Readonly<ProviderCatalog>,
): ProjectIdentity {
  const checked = validateProjectIdentity(opts.project_identity);
  if (!checked.ok) throw new WorkflowLifecycleError(checked.diagnostics[0] ?? createDiagnostic({
    code: "MIGRATION_REQUIRED",
    operation: "runtime.activate",
    severity: "error",
    evidence: { field: "project_identity" },
    remediation: "Provide a complete profile-free project identity before preparing a workflow run.",
  }));
  const identity = checked.value;
  const provider = opts.effective_policy.provider;
  if (
    provider.id !== identity.provider_id
    || provider.descriptor_fingerprint !== identity.descriptor_fingerprint
    || provider.catalog_content_digest !== identity.catalog_content_digest
    || catalog.content_digest !== identity.catalog_content_digest
  ) {
    throw new Error("IDENTITY_MISMATCH: policy/provider/catalog does not match project identity");
  }
  for (const [role, ref] of Object.entries(opts.effective_policy.roles)) {
    if (!ref || ref.provider_id !== identity.provider_id) throw new Error(`IDENTITY_MISMATCH: policy role '${role}' is not owned by the selected provider`);
    qualifiedAgentForRole(role, opts.effective_policy, opts.agent_inventory);
  }
  return identity;
}

function profileForSelection(
  policy: Readonly<EffectivePolicy>,
  catalog: Readonly<ProviderCatalog>,
  classification: Classification,
): Readonly<CatalogProfile> {
  const selection = policy.workflow;
  if (selection.selection === "fixed") {
    const loaded = loadProfileByIdentity(catalog, selection.profile_identity);
    if (!loaded.ok) {
      throw new WorkflowLifecycleError(loaded.diagnostics[0] ?? createDiagnostic({
        code: "PROFILE_UNAVAILABLE",
        operation: "profile.resolve",
        severity: "error",
        evidence: { field: "profile_identity" },
        remediation: "Select a profile published by the immutable provider catalog.",
      }));
    }
    const selected = catalog.profiles.find((entry) =>
      entry.identity.id === selection.profile_identity.id
      && entry.identity.fingerprint === selection.profile_identity.fingerprint,
    );
    if (!selected) throw new Error("IDENTITY_MISMATCH: fixed profile identity is not present in the provider catalog");
    return selected;
  }
  const resolved = resolveProfileForClassification(catalog, classification);
  if (!resolved.ok) {
    throw new WorkflowLifecycleError(resolved.diagnostics[0] ?? createDiagnostic({
      code: "PROFILE_UNAVAILABLE",
      operation: "profile.resolve",
      severity: "error",
      evidence: { field: "classification" },
      remediation: "Provide a classification that resolves to exactly one immutable catalog profile.",
    }));
  }
  return resolved.value;
}

/**
 * Persist a new PHASE-0 classification through the engine-owned state writer.
 * The interactive orchestrator must call this helper through `workflow_prepare`
 * instead of editing canonical `.work-state` files directly.
 */
export function prepareWorkflowState(opts: WorkflowPrepareOptions): PreparedWorkflowState {
  const checkedRunIdentity = opts.run_identity === undefined
    ? undefined
    : validateWorkflowRunIdentity(opts.run_identity);
  if (checkedRunIdentity && !checkedRunIdentity.ok) {
    throw new WorkflowLifecycleError(createDiagnostic({
      code: "MIGRATION_REQUIRED",
      operation: "admission",
      severity: "error",
      evidence: { field: "run_identity" },
      remediation: "Provide a complete validated workflow run identity.",
    }));
  }
  const validatedRunIdentity = checkedRunIdentity?.value;
  const catalog = validateCatalog(opts.catalog);
  const project_identity = validateProjectContext(opts, catalog);
  const continuation = opts.continuation;
  const isContinuation = continuation !== undefined;
  const existing = resolveState(opts.cwd, opts.branch, validatedRunIdentity);
  const persistedState = existing.state;

  const diagnostics = existing.diagnostics;
  if (diagnostics && diagnostics.length > 0) {
    const first = diagnostics[0];
    throw new Error(`${first?.code ?? "MIGRATION_REQUIRED"}: workflow state cannot be used by this lifecycle`);
  }
  if (existing.invalid) throw new Error("MIGRATION_REQUIRED: workflow state is invalid or unsafe");
  if (isContinuation) {
    if (!persistedState || existing.isStale) {
      throw new Error(`cannot continue workflow: no non-stale state for branch ${opts.branch}`);
    }
    if (typeof persistedState.run_key !== "string" || !persistedState.run_key.trim()) {
      throw new Error("MIGRATION_REQUIRED: persisted workflow state has no run key");
    }
  } else if (persistedState && !existing.isStale) {
    throw new Error("workflow state already exists for this branch; use continuation mode");
  }

  let selected_profile: Readonly<CatalogProfile>;
  let classification: Classification;
  let run_identity: WorkflowRunIdentity;
  if (continuation !== undefined) {
    if (!persistedState) {
      throw new Error(`cannot continue workflow: no non-stale state for branch ${opts.branch}`);
    }
    const persisted = persistedState.run_identity;
    const checkedRun = validateWorkflowRunIdentity(persisted);
    if (!checkedRun.ok) throw new Error("MIGRATION_REQUIRED: workflow state has no complete run identity");
    if (!sameProjectIdentity(project_identity, checkedRun.value)) {
      throw new Error("IDENTITY_MISMATCH: workflow state belongs to a different project identity");
    }
    if (validatedRunIdentity && !sameRunIdentity(validatedRunIdentity, checkedRun.value)) {
      throw new Error("IDENTITY_MISMATCH: requested run identity does not match the persisted run");
    }
    run_identity = checkedRun.value;
    const loaded = loadProfileByIdentity(catalog, run_identity.profile_identity);
    if (!loaded.ok) throw new Error("IDENTITY_MISMATCH: persisted run profile is unavailable or stale in the provider catalog");
    const catalogProfile = catalog.profiles.find((entry) =>
      entry.identity.id === run_identity.profile_identity.id
      && entry.identity.fingerprint === run_identity.profile_identity.fingerprint,
    );
    if (!catalogProfile) throw new Error("IDENTITY_MISMATCH: persisted run profile is unavailable in the provider catalog");
    selected_profile = catalogProfile;
    classification = persistedState.classification;
  } else {
    const classified = resolveClassification(opts);
    selected_profile = profileForSelection(opts.effective_policy, catalog, classified);
    classification = classified;
    if (validatedRunIdentity) {
      if (!sameProjectIdentity(project_identity, validatedRunIdentity)) {
        throw new Error("IDENTITY_MISMATCH: requested run identity does not match the active project identity");
      }
      if (
        validatedRunIdentity.profile_identity.id !== selected_profile.identity.id
        || validatedRunIdentity.profile_identity.fingerprint !== selected_profile.identity.fingerprint
      ) {
        throw new Error("IDENTITY_MISMATCH: requested run identity does not match the selected catalog profile");
      }
      run_identity = validatedRunIdentity;
    } else {
      const firstStage = selected_profile.profile.stages[0];
      if (!firstStage) {
        throw new WorkflowLifecycleError(createDiagnostic({
          code: "PROFILE_UNAVAILABLE",
          operation: "profile.resolve",
          severity: "error",
          evidence: { profile: selected_profile.profile.name },
          remediation: "Select a provider catalog profile with at least one workflow stage.",
        }));
      }
      const scope = requireFreshScope(opts.work_identity_scope, project_identity, selected_profile.profile.name, firstStage.id);
      const built = buildWorkflowRunIdentity({
        project_identity,
        run_id: scope.run_id,
        profile_identity: selected_profile.identity,
      });
      if (!built.ok) throw new WorkflowLifecycleError(built.diagnostics[0] ?? createDiagnostic({
        code: "MIGRATION_REQUIRED",
        operation: "runtime.activate",
        severity: "error",
        evidence: { field: "run_identity" },
        remediation: "Persist a complete run identity before activating workflow stages.",
      }));
      run_identity = built.value;
    }
  }


  const profile = selected_profile.profile;
  if (classification.workflow !== profile.name) {
    throw new Error(`IDENTITY_MISMATCH: classification workflow '${classification.workflow}' is not the selected catalog profile '${profile.name}'`);
  }
  const firstStage = profile.stages[0];
  if (!firstStage) {
    throw new WorkflowLifecycleError(createDiagnostic({
      code: "PROFILE_UNAVAILABLE",
      operation: "profile.resolve",
      severity: "error",
      evidence: { profile: profile.name },
      remediation: "Select a provider catalog profile with at least one workflow stage.",
    }));
  }

  let flags: ScopeFlags;
  if (opts.files !== undefined) {
    flags = resolvePolicyScope(opts.files, opts.effective_policy);
  } else if (continuation !== undefined && persistedState) {
    const persistedScope = persistedState.scope;
    flags = persistedScope === undefined
      ? resolvePolicyScope([], opts.effective_policy)
      : persistedScope;
  } else {
    flags = resolvePolicyScope([], opts.effective_policy);
  }
  const resolveSlots = (stage: NonNullable<Profile["stages"][number]>): DispatchSlot[] => {
    const stageContext = {
      cwd: opts.cwd,
      flags,
      resolveDevAgent: () => flags.dev_agent,
      project_identity,
      run_identity,
      catalog,
      effectivePolicy: opts.effective_policy,
      agentInventory: opts.agent_inventory,
      ...(persistedState === null ? {} : { state: persistedState }),
    };
    return resolveStageDispatchSlots(stage, stageContext);
  };
  const expectedRoster = (stage: NonNullable<Profile["stages"][number]>) =>
    resolveSlots(stage).map((slot) => {
      const agent_ref = qualifiedAgentForRole(slot.role, opts.effective_policy, opts.agent_inventory);
      return { role: slot.slot, agent: agent_ref.registered_name, agent_ref };
    });

  let reopened: TeamState | undefined;
  if (continuation === undefined) {
    reopened = undefined;
  } else {
    if (!persistedState) {
      throw new Error(`cannot continue workflow: no non-stale state for branch ${opts.branch}`);
    }
    reopened = reopenFromFeedback(persistedState, continuation.feedback, continuation.stageId);
  }
  const cursor_epoch = randomUUID();
  let state: TeamState;
  if (reopened !== undefined) {
    const runKey = reopened.run_key;
    if (typeof runKey !== "string" || !runKey.trim()) {
      throw new Error("MIGRATION_REQUIRED: persisted workflow state has no run key");
    }
    state = {
      ...reopened,
      project_identity,
      run_identity,
      classification,
      workflow: profile.name,
      run_key: runKey,
      scope: flags,
      profile_hash: run_identity.profile_identity.fingerprint,
      policy: { ...(reopened.policy ?? {}), strict_orchestrator: true },
    };
  } else {
    const freshStages: TeamState["stages"] = profile.stages.map((stage) => ({ id: stage.id, status: "pending" }));
    const freshPause: TeamState["pause"] = { kind: "none", reason: "" };
    const freshIssue: TeamState["issue"] = opts.issue === undefined ? null : opts.issue;
    state = {
      schema: 1,
      branch: opts.branch,
      project_identity,
      run_identity,
      classification,
      workflow: profile.name,
      task: opts.task,
      workflow_override: opts.classification !== undefined && opts.classification.workflow !== undefined,
      issue: freshIssue,
      stage_cursor: firstStage.id,
      cursor_epoch,
      stages: freshStages,
      pause: freshPause,
      artifacts: {},
      retired_capabilities: [],
      scope: flags,
      policy: { strict_orchestrator: true },
      profile_hash: run_identity.profile_identity.fingerprint,
      run_key: opts.branch,
      updated_at: new Date().toISOString(),
    };
  }
  const state_context: WorkflowStateContext = {
    run_identity,
    classification,
    workflow: state.workflow,
    stage_cursor: state.stage_cursor,
    cursor_epoch: state.cursor_epoch,
  };
  const stateTarget: { target?: ResolvedState } = isContinuation ? { target: existing } : {};
  const initialStageId = isContinuation
    ? opts.continuation?.stageId ?? state.stage_cursor
    : profile.stages[0]?.id;
  if (initialStageId) {
    if (isContinuation) {
      if (!validWorkIdentity(persistedState?.work_identity)) {
        throw new WorkflowLifecycleError(createDiagnostic({ code: "MIGRATION_REQUIRED", operation: "runtime.activate", severity: "error", evidence: { field: "work_identity" }, remediation: "Persist a complete work identity before continuing the workflow." }));
      }
      if (!validWorkIdentityScope(opts.work_identity_scope)
        || !scopeMatches(opts.work_identity_scope, scopeForStage(persistedState.work_identity, initialStageId))) {
        throw new WorkflowLifecycleError(createDiagnostic({ code: "IDENTITY_MISMATCH", operation: "runtime.activate", severity: "error", evidence: { field: "work_identity_scope" }, remediation: "Use the exact persisted work identity scope for this workflow stage." }));
      }
    } else {
      requireScope(opts.work_identity_scope, run_identity, profile.name, initialStageId);
    }
  }
  const { statePath, artifactsDir } = writeState(opts.cwd, state, stateTarget);
  return {
    project_identity,
    run_identity,
    state_context,
    selected_profile,
    persisted: true,
    catalog,
    effective_policy: opts.effective_policy,
    agent_inventory: opts.agent_inventory,
    profile_identity: run_identity.profile_identity,
    profile,
    flags,
    classification,
    state,
    statePath,
    artifactsDir,
    stateTarget,
    expectedRoster,
  };
}

export async function run(opts: RunOptions): Promise<RunResult> {
  const prepared = prepareWorkflowState(opts);
  const {
    project_identity,
    run_identity,
    catalog,
    effective_policy,
    agent_inventory,
    profile_identity,
    profile,
    flags,
    classification,
    state: initialState,
    statePath,
    artifactsDir,
    stateTarget,
    expectedRoster,
  } = prepared;
  const orchestrate = opts.orchestrate;
  const capabilityContext: CapabilityContext = {
    project_identity,
    run_identity,
    catalog,
    effective_policy,
    agent_inventory,
    work_identity_scope: opts.work_identity_scope,
  };
  const completed = new Set(initialState.stages.filter((s) => s.status === "done" || s.status === "skipped").map((s) => s.id));
  const runnableProfile = completed.size === 0 ? profile : { ...profile, stages: profile.stages.filter((s) => !completed.has(s.id)) };
  let durableStage: { stageId: string; dispatchToken: string; advanceToken: string; epoch: string } | null = null;
  const ctx: StageContext = {
    cwd: opts.cwd,
    state: initialState,
    artifactsDir,
    flags,
    project_identity,
    run_identity,
    catalog,
    effectivePolicy: effective_policy,
    agentInventory: agent_inventory,
    agent: (role) => qualifiedAgentForRole(role, effective_policy, agent_inventory).registered_name,
    task: opts.taskTool,
    orchestrate: orchestrate
      ? (args) => orchestrate({ ...args, state: ctx.state })
      : undefined,
    pause: opts.pause ?? (async () => undefined),
    onStageStart: (stageId) => {
      const current = readState(statePath, project_identity, run_identity);
      const currentWorkIdentity = current.work_identity;
      const armed = current.dispatch_capability;
      if (
        durableStage
        && durableStage.stageId === stageId
        && armed?.issued_for?.stage_cursor === stageId
        && (armed.status === "ready" || armed.status === "dispatched")
      ) {
        if (!validWorkIdentity(currentWorkIdentity) || !validWorkIdentity(armed.work_identity) || !armed.capability_id || !armed.issued_for) {
          throw new WorkflowLifecycleError(createDiagnostic({ code: "MIGRATION_REQUIRED", operation: "runtime.activate", severity: "error", evidence: { field: "dispatch_capability" }, remediation: "Persist a complete matching work identity and capability." }));
        }
        if (!WORK_IDENTITY_KEYS.every((key) => currentWorkIdentity[key] === armed.work_identity[key])
          || currentWorkIdentity.stage_id !== stageId
          || currentWorkIdentity.stage_cursor !== stageId) {
          throw new WorkflowLifecycleError(createDiagnostic({ code: "IDENTITY_MISMATCH", operation: "runtime.activate", severity: "error", evidence: { field: "work_identity" }, remediation: "Refuse reuse of an identity from another run or stage." }));
        }
        const resumed = setStageStatus(current, stageId, "in_progress", opts.cwd);
        ctx.state = resumed;
        writeState(opts.cwd, resumed, stateTarget);
        return;
      }
      const stage = profile.stages.find((candidate) => candidate.id === stageId);
      const kind: "single" | "consilium" | "none" =
        stage?.type === "single" ? "single" : stage?.type === "consilium" ? "consilium" : "none";
      const next = setStageStatus(current, stageId, "in_progress", opts.cwd);
      const runKey = requiredStateBinding(next, "run_key");
      const work_identity_scope = currentWorkIdentity
        ? scopeForStage(currentWorkIdentity, stageId)
        : requireScope(opts.work_identity_scope, run_identity, profile.name, stageId);
      const issued = stage
        ? createCapability({
            run_key: runKey,
            branch: next.branch,
            workflow: profile.name,
            profile_hash: profile_identity.fingerprint,
            stage_cursor: stage.id,
            kind,
            expected_roster: kind === "none" ? [] : expectedRoster(stage),
            work_identity_scope,
            project_identity,
            run_identity,
          })
        : null;
      const nextState: TeamState = issued
        ? {
            ...next,
            project_identity,
            run_identity,
            workflow: profile.name,
            run_key: runKey,
            cursor_epoch: issued.state.issued_for.cursor_epoch,
            profile_hash: profile_identity.fingerprint,
            work_identity: issued.work_identity,
            dispatch_capability: issued.state,
          }
        : {
            ...next,
            project_identity,
            run_identity,
            workflow: profile.name,
            cursor_epoch: randomUUID(),
          };
      ctx.state = nextState;
      if (issued) {
        durableStage = {
          stageId,
          dispatchToken: issued.dispatch_token,
          advanceToken: issued.advance_token,
          epoch: issued.state.issued_for.cursor_epoch,
        };
      } else durableStage = null;
      writeState(opts.cwd, nextState, stateTarget);
    },
    onStageComplete: (stageId, status) => {
      const current = readState(statePath, project_identity, run_identity);
      if (
        status === "failed"
        && (current.pause?.kind === "user_checkpoint" || current.pause?.kind === "needs_human" || current.pause?.kind === "background_wait")
      ) {
        ctx.state = current;
        return;
      }
      const next = setStageStatus(current, stageId, status, opts.cwd);
      ctx.state = next;
      writeState(opts.cwd, next, stateTarget);
    },
    log: opts.log ?? (() => undefined),
    resolveDevAgent: () => flags.dev_agent,
    durable: {
      authorize: (role, agent) => {
        if (!durableStage) return { ok: false, error: "durable stage unavailable" };
        const current = readState(statePath, project_identity, run_identity);
        const runKey = requiredStateBinding(current, "run_key");
        const profileHash = requiredStateBinding(current, "profile_hash");
        const capabilityId = current.dispatch_capability?.capability_id;
        if (!capabilityId) return { ok: false, error: "MIGRATION_REQUIRED: dispatch capability identity is missing" };
        const agent_ref = qualifiedAgentForRole(role, effective_policy, agent_inventory);
        if (agent !== agent_ref.registered_name) return { ok: false, error: "agent identity mismatch" };
        const r = authorizeDispatch(opts.cwd, {
          token: durableStage.dispatchToken,
          capability_id: capabilityId,
          run_key: runKey,
          branch: current.branch,
          workflow: profile.name,
          profile_hash: profileHash,
          stage_cursor: durableStage.stageId,
          cursor_epoch: durableStage.epoch,
          role,
          agent,
          agent_ref,
          project_identity,
          run_identity,
        });
        if (r.ok) ctx.state = r.state;
        return r.ok && r.record ? { ok: true, dispatchId: r.record.id } : { ok: false, error: r.ok ? "missing dispatch record" : r.error };
      },
      complete: (dispatchId, output, outcome, artifactIds) => {
        if (!durableStage) return { ok: false, error: "durable stage unavailable" };
        const current = readState(statePath, project_identity, run_identity);
        const runKey = requiredStateBinding(current, "run_key");
        const profileHash = requiredStateBinding(current, "profile_hash");
        const capabilityId = current.dispatch_capability?.capability_id;
        if (!capabilityId) return { ok: false, error: "MIGRATION_REQUIRED: dispatch capability identity is missing" };
        const record = current.dispatch_capability?.dispatches?.find((entry) => entry.id === dispatchId);
        const agent_ref = record?.agent_ref;
        const r = completeDispatch(opts.cwd, {
          token: durableStage.dispatchToken,
          capability_id: capabilityId,
          dispatch_id: dispatchId,
          run_key: runKey,
          branch: current.branch,
          workflow: profile.name,
          profile_hash: profileHash,
          stage_cursor: durableStage.stageId,
          cursor_epoch: durableStage.epoch,
          outcome,
          evidence: output || (outcome === "failed" ? "task failed" : "task completed"),
          artifact_ids: artifactIds,
          agent_ref,
          project_identity,
          run_identity,
        });
        if (r.ok) ctx.state = r.state;
        return r.ok ? { ok: true } : { ok: false, error: r.error };
      },
      advance: (evidence) => {
        if (!durableStage) return { ok: false, error: "durable stage unavailable" };
        const current = readState(statePath, project_identity, run_identity);
        const runKey = requiredStateBinding(current, "run_key");
        const profileHash = requiredStateBinding(current, "profile_hash");
        const capabilityId = current.dispatch_capability?.capability_id;
        if (!capabilityId) return { ok: false, error: "MIGRATION_REQUIRED: dispatch capability identity is missing" };
        const stageId = durableStage.stageId;
        const stageDef = profile.stages.find((candidate) => candidate.id === stageId);
        if (stageDef?.checkpoint) {
          const checkpoint = validateCheckpointForAdvance(stageDef, current);
          if (!checkpoint.ok) {
            const pauseKind = checkpoint.pauseKind ?? (checkpoint.code === "checkpoint_unresolved" ? "user_checkpoint" : "needs_human");
            const paused = setPause(current, pauseKind, checkpoint.error);
            ctx.state = paused;
            writeState(opts.cwd, paused, stateTarget);
            return { ok: false, error: `${checkpoint.code}: ${checkpoint.error}` };
          }
        }
        const r = advanceCursor(opts.cwd, {
          token: durableStage.advanceToken,
          capability_id: capabilityId,
          run_key: runKey,
          branch: current.branch,
          workflow: profile.name,
          profile_hash: profileHash,
          stage_cursor: durableStage.stageId,
          cursor_epoch: durableStage.epoch,
          evidence,
          project_identity,
          run_identity,
        }, capabilityContext);
        if (!r.ok) return { ok: false, error: `${r.error}: ${evidence}` };
        ctx.state = r.state;
        if (r.handoff) durableStage = { stageId: r.state.stage_cursor, dispatchToken: r.handoff.dispatch_token, advanceToken: r.handoff.advance_token, epoch: r.handoff.cursor_epoch };
        return { ok: true, handoff: r.handoff };
      },
    },
  };
  opts.log?.(`walking profile: ${profile.name} (${runnableProfile.stages.length} stages)`);
  const outcomes = await walkProfile(profile, ctx);
  const final = readState(statePath, project_identity, run_identity);
  const done = final.stages.every((s) => s.status === "done" || s.status === "skipped");
  const resumablePause = final.pause.kind === "user_checkpoint"
    || final.pause.kind === "needs_human"
    || final.pause.kind === "background_wait"
    || final.pause.kind === "failed";
  const terminal = resumablePause
    ? final
    : setPause(final, done ? "done" : "failed", done ? "" : "one or more stages failed");
  writeState(opts.cwd, terminal, stateTarget);
  return {
    classification,
    profile,
    run_identity,
    outcomes: outcomes.map((o) => ({ stageId: o.stageId, status: o.status, note: o.note })),
    statePath,
  };
}
function readState(path: string, project_identity: ProjectIdentity, run_identity: WorkflowRunIdentity): TeamState {
  if (!path) throw new Error("state path missing");
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  const state = normalizePersistedState(parsed);
  if (!state) throw new Error("MIGRATION_REQUIRED: persisted workflow state is malformed");
  if (
    !state.project_identity
    || !state.run_identity
    || !sameProjectIdentity(state.project_identity, project_identity)
    || !sameRunIdentity(state.run_identity, run_identity)
  ) {
    throw new Error("IDENTITY_MISMATCH: persisted workflow state does not belong to the active project/run identity");
  }
  return state;
}
