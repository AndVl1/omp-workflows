/**
 * @andvl1/omp-workflows-core — public API surface.
 *
 * The v2 host is the sole owner of canonical workflow commands and tools.
 * Core keeps the engine, gates, observability and CTO contracts available
 * behind the validated provider/runtime boundary.
 * <!-- omp-cto-slice run=01a03ee4-7dd6-7580-8ad7-16d26dc886ba slice=workflow-v2-core -->
 */

import { createHash } from "node:crypto";
import type {
  BeforeAgentStartEvent,
  ExtensionAPI,
  SessionStopEvent,
  ToolCallEvent,
  ToolResultEvent,
} from "@oh-my-pi/pi-coding-agent";
import { orchestratorWriteGate, workerWriteScopeGate } from "./gates/orchestrator-write.js";
import { dispatchGate, trustedDispatchRequests } from "./gates/dispatch.js";
import { classificationGate, classificationToolGate } from "./gates/classification.js";
import type { WorkflowGateContext } from "./gates/classification.js";
import { monotonicGate } from "./gates/monotonic.js";
import { dodBackstop } from "./gates/dod-backstop.js";
import { safetyGuard } from "./gates/safety.js";
import { ctoNestingGuard } from "./gates/cto-nesting.js";
import { outboxEnforcementGate } from "./gates/outbox.js";
import { ctoSliceTaskGate } from "./cto/slice-gate.js";
import { registerObservabilityHooks, recordToolCallAttempt } from "./observability/index.js";
import {
  authorizeDispatchTrusted,
  reconcileTrustedTaskResult,
} from "./engine/durable.js";
import { registerWorkflowV2Host, validateInvocation } from "./workflow-v2/host.js";
import {
  createCanonicalRoot,
  projectRuntimeKeyFor,
  validateProjectIdentity,
} from "./workflow-v2/identity.js";
import { createDiagnostic, failureResult } from "./workflow-v2/diagnostics.js";
import type {
  CanonicalRoot,
  DiagnosticResult,
  HostCapability,
  ProjectIdentity,
  ProjectRuntimeKey,
  WorkflowHost,
  WorkflowHostOptions,
  WorkflowOwnerClaim,
  WorkflowOwnerIdentity,
  WorkflowOwnerClaimResult,
  WorkflowRunIdentity,
  WorkflowV2Diagnostic,
} from "./workflow-v2/types.js";
import type { WorkerWriteScope } from "./gates/orchestrator-write.js";

export type { WorkflowOwnerClaim, WorkflowOwnerClaimResult, WorkflowOwnerIdentity };

type OwnerClaims = Map<HostCapability, WorkflowOwnerClaim>;
const workflowOwners = new Map<ProjectRuntimeKey, OwnerClaims>();

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalize(entry)]),
    );
  }
  return value;
}

function ownerFingerprint(owner: WorkflowOwnerIdentity): `sha256:${string}` {
  const bytes = JSON.stringify(canonicalize(owner));
  const digest = createHash("sha256").update(bytes, "utf8").digest("hex");
  return `sha256:${digest}`;
}

function ownerDiagnostic(
  field: string,
  remediation: string,
  evidence: Record<string, string | number | boolean | null | readonly string[]> = {},
) {
  return createDiagnostic({
    code: "OWNER_CONFLICT",
    operation: "admission",
    evidence: { field, ...evidence },
    remediation,
  });
}

function validateOwner(
  owner: WorkflowOwnerIdentity,
): DiagnosticResult<{ readonly owner: WorkflowOwnerIdentity; readonly projectRoot: CanonicalRoot }> {
  if (!owner || typeof owner !== "object") {
    return failureResult(ownerDiagnostic("owner", "Provide a complete v2 owner identity."));
  }
  const candidate = owner as unknown as Record<string, unknown>;
  const provenance =
    candidate.provenance && typeof candidate.provenance === "object"
      ? (candidate.provenance as Record<string, unknown>)
      : undefined;
  const required: readonly [string, unknown][] = [
    ["owner_id", candidate.owner_id],
    ["bundle_id", candidate.bundle_id],
    ["owner_kind", candidate.owner_kind],
    ["activation_marker", candidate.activation_marker],
    ["host_range", candidate.host_range],
    ["provenance.package", provenance?.package],
    ["provenance.entrypoint", provenance?.entrypoint],
    ["provenance.cwd", provenance?.cwd],
  ];
  const missing = required.find(([, value]) => typeof value !== "string" || value.trim().length === 0);
  if (missing) {
    return failureResult(ownerDiagnostic(missing[0], "Provide every owner and package provenance field."));
  }
  const projectRoot = createCanonicalRoot(provenance?.cwd as string);
  if (!projectRoot) {
    return failureResult(ownerDiagnostic("provenance.cwd", "Use the manager-resolved absolute canonical project root."));
  }
  const normalized: WorkflowOwnerIdentity = Object.freeze({
    owner_id: candidate.owner_id as string,
    bundle_id: candidate.bundle_id as string,
    owner_kind: candidate.owner_kind as WorkflowOwnerIdentity["owner_kind"],
    activation_marker: candidate.activation_marker as string,
    host_range: candidate.host_range as string,
    provenance: Object.freeze({
      package: provenance?.package as string,
      entrypoint: provenance?.entrypoint as string,
      cwd: projectRoot,
      ...(typeof provenance?.config_path === "string" ? { config_path: provenance.config_path } : {}),
    }),
  });
  return {
    ok: true,
    value: { owner: normalized, projectRoot },
    diagnostics: [],
  };
}

/**
 * Bind host ownership to a complete project-level identity. Cwd-only
 * ownership is intentionally impossible: provider, config, catalog,
 * executable or worktree identity changes get a distinct runtime key.
 */
export function claimWorkflowOwners(
  projectIdentity: ProjectIdentity,
  capabilities: readonly HostCapability[],
  owner: WorkflowOwnerIdentity,
): WorkflowOwnerClaimResult {
  const checkedIdentity = validateProjectIdentity(projectIdentity);
  if (!checkedIdentity.ok) return { ok: false, diagnostics: checkedIdentity.diagnostics };
  const checkedOwner = validateOwner(owner);
  if (!checkedOwner.ok) return { ok: false, diagnostics: checkedOwner.diagnostics };
  const requested = [...new Set(capabilities)];
  if (requested.length === 0) {
    return { ok: false, diagnostics: [ownerDiagnostic("capabilities", "Claim at least one host capability.")] };
  }
  const fingerprint = ownerFingerprint(checkedOwner.value.owner);
  const runtimeKey = projectRuntimeKeyFor(checkedIdentity.value);
  const existing = workflowOwners.get(runtimeKey);
  for (const capability of requested) {
    const prior = existing?.get(capability);
    if (prior && ownerFingerprint(prior.owner) !== fingerprint) {
      return {
        ok: false,
        diagnostics: [
          ownerDiagnostic(
            "owner",
            "Restart the host and remove the competing canonical owner before claiming this project identity.",
            { owner_id: prior.owner.owner_id, capability },
          ),
        ],
        claim: prior,
      };
    }
  }
  const registry = existing ?? new Map<HostCapability, WorkflowOwnerClaim>();
  let idempotent = true;
  for (const capability of requested) {
    if (registry.has(capability)) continue;
    idempotent = false;
    registry.set(
      capability,
      Object.freeze({
        project_root: checkedOwner.value.projectRoot,
        capability,
        project_runtime_key: runtimeKey,
        owner: checkedOwner.value.owner,
        project_identity: checkedIdentity.value,
      }),
    );
  }
  if (!existing) workflowOwners.set(runtimeKey, registry);
  const firstCapability = requested[0];
  if (firstCapability === undefined) {
    return { ok: false, diagnostics: [ownerDiagnostic("claim", "Claim at least one host capability.")] };
  }
  const claim = registry.get(firstCapability);
  if (!claim) {
    return { ok: false, diagnostics: [ownerDiagnostic("claim", "Claim at least one host capability.")] };
  }
  return {
    ok: true,
    claim,
    idempotent,
    diagnostics: [],
  };
}

export function claimWorkflowOwner(
  projectIdentity: ProjectIdentity,
  capability: HostCapability,
  owner: WorkflowOwnerIdentity,
): WorkflowOwnerClaimResult {
  return claimWorkflowOwners(projectIdentity, [capability], owner);
}

/** Read-only project-identity-bound claim lookup for host/tests. */
export function workflowOwnerFor(
  projectIdentity: ProjectIdentity,
  capability: HostCapability,
): WorkflowOwnerClaim | undefined {
  const checked = validateProjectIdentity(projectIdentity);
  if (!checked.ok) return undefined;
  return workflowOwners.get(projectRuntimeKeyFor(checked.value))?.get(capability);
}

/**
 * Test-only fresh-lifecycle disposal. Production code must never use an
 * in-place identity reset or hot provider switch.
 */
export function resetWorkflowOwners(projectIdentity?: ProjectIdentity): void {
  if (projectIdentity === undefined) {
    workflowOwners.clear();
    return;
  }
  const checked = validateProjectIdentity(projectIdentity);
  if (checked.ok) workflowOwners.delete(projectRuntimeKeyFor(checked.value));
}

export interface RegisterOptions extends WorkflowHostOptions {
  readonly observability?: boolean;
  readonly writeScope?: WorkerWriteScope;
}

/**
 * Register the single v2 host and the generic core gates. The host performs
 * synchronous admission and owns all canonical command/tool registration;
 * this wrapper has no policy/config writer or session-start seed path.
 */
export function registerTeamWorkflow(pi: ExtensionAPI, options: RegisterOptions): WorkflowHost {
  const host = registerWorkflowV2Host(pi, options);
  type ValidatedGateContext = WorkflowGateContext & {
    readonly cwd: string;
    readonly project_identity: ProjectIdentity;
    readonly run_identity: WorkflowRunIdentity;
    readonly catalog: NonNullable<WorkflowGateContext["catalog"]>;
    readonly effective_policy: NonNullable<WorkflowGateContext["effective_policy"]>;
    readonly agent_inventory: NonNullable<WorkflowGateContext["agent_inventory"]>;
  };
  type GateBlock = {
    readonly block: true;
    readonly reason: string;
    readonly diagnostic?: WorkflowV2Diagnostic;
  };
  type GateContextResult =
    | { readonly ok: true; readonly context: ValidatedGateContext }
    | { readonly ok: false; readonly blocked: GateBlock };

  const gateBlock = (diagnostics: readonly WorkflowV2Diagnostic[]): GateBlock => {
    const diagnostic = diagnostics[0] ?? createDiagnostic({
      code: "MIGRATION_REQUIRED",
      operation: "tool.dispatch",
      remediation: "Re-admit the workflow through the protocol-v2 host before invoking a core gate.",
    });
    return {
      block: true,
      reason: `BLOCK (v2): ${diagnostic.code} — ${diagnostic.remediation}`,
      diagnostic,
    };
  };
  /**
   * Hook payloads are untrusted and contain no workflow identity. Acquire a
   * complete project/run context through the host's read-only validation
   * boundary instead of copying cwd or identity-shaped values from payloads.
   */
  const validatedGateContext = (ctx: unknown): GateContextResult => {
    const validated = validateInvocation({
      operation: "tool",
      name: "workflow_status",
      args: {},
      context: ctx,
    }, options);
    if (!validated.ok) return { ok: false, blocked: gateBlock(validated.diagnostics) };
    const value = validated.value;
    if (value.identity_level !== "run") {
      return {
        ok: false,
        blocked: gateBlock([
          createDiagnostic({
            code: "MIGRATION_REQUIRED",
            operation: "tool.dispatch",
            remediation: "Prepare and persist a WorkflowRunIdentity before invoking durable workflow gates.",
          }),
        ]),
      };
    }
    return {
      ok: true,
      context: {
        cwd: value.snapshot.root,
        project_identity: value.project_identity,
        run_identity: value.run_identity,
        catalog: value.catalog,
        effective_policy: value.effective_policy,
        agent_inventory: value.agent_inventory,
      },
    };
  };

  // @ts-expect-error -- ExtensionAPI event overloads are narrower than the
  // structural gate handlers, but OMP dispatches these callbacks by name.
  pi.on("before_agent_start", (event: BeforeAgentStartEvent, ctx: unknown) => {
    const checked = validatedGateContext(ctx);
    if (!checked.ok) return checked.blocked;
    const c = checked.context;
    const r1 = classificationGate(
      event as unknown as Parameters<typeof classificationGate>[0],
      c as Parameters<typeof classificationGate>[1],
    );
    if (r1?.block) return r1;
    const r2 = monotonicGate(event, c as Parameters<typeof monotonicGate>[1]);
    if (r2?.block) return r2;
  });
  pi.on("session_stop", (event: SessionStopEvent, ctx: unknown) => {
    const checked = validatedGateContext(ctx);
    if (!checked.ok) return { decision: "block", reason: checked.blocked.reason };
    return dodBackstop(event as unknown as Parameters<typeof dodBackstop>[0], checked.context);
  });
  pi.on("tool_call", (event: ToolCallEvent, ctx: unknown) => {
    const checked = validatedGateContext(ctx);
    if (!checked.ok) return checked.blocked;
    const c = checked.context;
    let result: { block?: boolean; reason?: string } | undefined;
    const run = (candidate: { block?: boolean; reason?: string } | void) => {
      if (!result && candidate?.block) result = candidate;
    };
    if (!result) run(ctoNestingGuard(event as unknown as Parameters<typeof ctoNestingGuard>[0]));
    if (!result) run(outboxEnforcementGate(
      event as unknown as Parameters<typeof outboxEnforcementGate>[0],
      c as Parameters<typeof outboxEnforcementGate>[1],
    ));
    if (!result) run(classificationToolGate(
      event as unknown as Parameters<typeof classificationToolGate>[0],
      c as Parameters<typeof classificationToolGate>[1],
    ));
    if (!result) run(orchestratorWriteGate(
      event as unknown as Parameters<typeof orchestratorWriteGate>[0],
      c as Parameters<typeof orchestratorWriteGate>[1],
    ));
    if (!result) run(workerWriteScopeGate(
      event as unknown as Parameters<typeof workerWriteScopeGate>[0],
      {
        ...c,
        writeScope: options.writeScope,
      } as Parameters<typeof workerWriteScopeGate>[1],
    ));
    if (!result) run(ctoSliceTaskGate(
      event as unknown as Parameters<typeof ctoSliceTaskGate>[0],
      c as Parameters<typeof ctoSliceTaskGate>[1],
    ));
    if (!result) run(safetyGuard(
      event as unknown as Parameters<typeof safetyGuard>[0],
      c as Parameters<typeof safetyGuard>[1],
    ));
    if (!result) run(dispatchGate(
      event as unknown as Parameters<typeof dispatchGate>[0],
      c as Parameters<typeof dispatchGate>[1],
    ));
    if (!result && event.toolName === "task") {
      const authorization = trustedDispatchRequests(
        event as unknown as { toolName?: string; toolCallId?: string; input?: unknown },
        c as Parameters<typeof trustedDispatchRequests>[1],
      );
      if (!authorization.ok) {
        run({ block: true, reason: authorization.reason });
      } else {
        for (const request of authorization.requests) {
          const policyAgentRef = c.effective_policy.roles[request.role];
          const inventoryMatches = c.agent_inventory.filter((entry) => entry.registered_name === request.agent);
          const agentRef = policyAgentRef ?? (inventoryMatches.length === 1 ? inventoryMatches[0] : undefined);
          if (!agentRef) {
            run({
              block: true,
              reason: "MIGRATION_REQUIRED: task authorization requires a provider-qualified agent identity.",
            });
            break;
          }
          const authorized = authorizeDispatchTrusted(c.cwd, {
            ...request,
            project_identity: c.project_identity,
            run_identity: c.run_identity,
            agent_ref: agentRef,
          });
          if (!authorized.ok) {
            run({ block: true, reason: `dispatch authorization failed: ${authorized.error}` });
            break;
          }
        }
      }
    }
    if (options.observability !== false) {
      recordToolCallAttempt(
        c.cwd,
        event as unknown as { toolName?: string; toolCallId?: string; input?: unknown },
        result ? "blocked" : "allowed",
        result?.reason,
      );
    }
    return result;
  });
  pi.on("tool_result", (event: ToolResultEvent, ctx: unknown) => {
    if (event.toolName !== "task") return;
    const details = (event as unknown as { details?: { async?: { state?: string } } }).details;
    const asyncState = details?.async?.state;
    if (asyncState === "running" || asyncState === "spawned" || asyncState === "scheduled") return;
    const checked = validatedGateContext(ctx);
    if (!checked.ok) return;
    const c = checked.context;
    const content = event.content
      .filter((part): part is { type: "text"; text: string } => part.type === "text")
      .map((part) => part.text)
      .join("\n")
      .trim();
    const evidence = content || (event.isError ? "native task failed" : "native task completed");
    const reconciled = reconcileTrustedTaskResult(c.cwd, {
      project_identity: c.project_identity,
      run_identity: c.run_identity,
      tool_call_id: event.toolCallId,
      outcome: event.isError ? "failed" : "succeeded",
      evidence,
      pending: false,
    });
    if (!reconciled.ok && !reconciled.error.includes("unknown or already reconciled")) {
      console.warn(`omp workflow task reconciliation failed: ${reconciled.error}`);
    }
  });
  registerObservabilityHooks(pi, { enabled: options.observability, toolCall: false });
  return host;
}

export * from "./workflow-v2/index.js";
export {
  resolveRoleChain,
  isResearchRequest,
  isResearchResponse,
  validateResearchRequest,
  validateResearchResponse,
} from "./model-roles.js";
export type {
  ModelRoleEntry,
  ModelRoleTaxonomy,
  ModelRolePreset,
  InventoryModel,
  RoleLookup,
  RoleResolutionStatus,
  RoleResolution,
  ResearchRequest,
  BenchmarkSource,
  ResearchRecommendation,
  ResearchResponse,
} from "./model-roles.js";
export type { SessionIdentity } from "./workflow-v2/types.js";
export { resolveWorkflow } from "./engine/profile.js";

export { dispatchGate, buildDispatchMarker, parseDispatchMarker, trustedDispatchRequests, type DispatchAuthorizationRequest } from "./gates/dispatch.js";
export {
  createCapability,
  beginCapability,
  authorizeDispatch,
  authorizeDispatchTrusted,
  completeDispatch,
  reconcileTrustedTaskResult,
  reconcileTaskResult,
  recordCheckpointDecision,
  setArtifactContractPolicy,
  setFanInPolicy,
  type CheckpointDecisionInput,
  type DispatchAuth,
  type TrustedDispatchInput,
  type CapabilityHandoff,
  type TransitionResult,
} from "./engine/durable.js";
export {
  parseExpression,
  evaluatePredicate,
  evaluateExpression,
  validateProfileExpressions,
  deepEqual,
  type PredicateAst,
  type PredicateContext,
  type PredicateResult,
  type PredicateParseResult,
  type PredicateTerm,
} from "./engine/predicate.js";
export {
  loadArtifactSchemas,
  artifactSchemaFor,
  requiredFieldsOf,
  validateProducedArtifact,
  validateConsumedArtifacts,
  DEFAULT_ARTIFACT_CONTRACT_POLICY,
  type ArtifactContractPolicy,
  type ArtifactIssue,
  type ArtifactValidationResult,
  type ConsumeDiagnostic,
  type ConsumeValidationResult,
  type JsonSchemaDef,
} from "./engine/artifact-contract.js";
export {
  findCheckpointDecision,
  hasCheckpointDecision,
  appendCheckpointDecision,
  unresolvedCheckpointError,
} from "./engine/checkpoints.js";
export {
  loopExhaustionKind,
  loopStateFor,
  loopReentryDecision,
  resolveBackToStage,
  loopIterationRecord,
} from "./engine/loops.js";
export {
  sanitizeSlot,
  namespacedArtifactId,
  isNamespacedArtifactId,
  slotRecordsFor,
  missingSlotResults,
  mergeSlotValues,
  synthesizeArtifacts,
  validateStageFanInResolutions,
  DEFAULT_FAN_IN_POLICY,
  type FanInPolicy,
  type MergeResult,
  type SynthesisResult,
} from "./engine/fan-in.js";
export {
  renderProductPrdDocument,
  writeProductPrdDocument,
  validateProductPrdDocument,
  PRODUCT_PRD_ARTIFACT_ID,
  PRODUCT_PRD_RENDERER,
  PRD_SOURCE_ARTIFACT_IDS,
  type ProductPrdManifest,
  type ProductPrdWriteOptions,
  type ProductPrdWriteResult,
  type ProductPrdValidation,
} from "./engine/product-prd.js";
export {
  resolveWorkflowContract,
  resolveStageInstructions,
  validateTypedControlPlane,
  checkpointPolicyLegacyConflict,
  migrationCompletionIntent,
  migrationCheckpointPolicy,
  WorkflowContractError,
  type TypedContractValidationResult,
  type WorkflowContract,
  type WorkflowContractOptions,
  type WorkflowStageContract,
} from "./engine/workflow-contract.js";
export {
  resolveScope,
  applyConditional,
  shouldSkip,
  runtimeClassForScope,
  scopeToRuntimeClass,
  type RuntimeClass,
  type ScopeRuntimeClassTable,
  type ScopeFlags,
  type ScopeResolutionOptions,
} from "./engine/scope.js";
export {
  writeState,
  setStageStatus,
  setPause,
  checkMonotonic,
  resolveState,
  resolveCanonicalRun,
  type ResolvedActiveRun,
  type StateSelector,
  reopenFromFeedback,
} from "./engine/state.js";
export {
  writeArtifact,
  readArtifact,
  persistReturnedArtifacts,
} from "./engine/artifacts.js";
export {
	appendDoDItem,
	closeDoDItem,
	readDoD,
	isDoDComplete,
	isRootCauseDocumented,
} from "./engine/dod.js";
export { orchestratorWriteGate, workerWriteScopeGate, actorOf, hasStrictOrchestratorState, type WorkerWriteScope } from "./gates/orchestrator-write.js";
export {
  run,
  prepareWorkflowState,
  resolveClassification,
  type RunOptions,
  type WorkflowPrepareOptions,
  type PreparedWorkflowState,
  type RunResult,
  type ModelClassification,
} from "./engine/run.js";
export {
  runStage,
  createTaskCaller,
  spawnLabel,
  DevAgentUnavailableError,
  type TaskCaller,
  type TaskResult,
  type TaskToolLike,
  type StageContext,
  type StageOutcome,
} from "./engine/stage.js";
export type {
  Profile,
  StageDef,
  StageType,
  StageStatus,
  PauseKind,
  TaskType,
  Complexity,
  Confidence,
  WorkflowName,
  Classification,
  TeamState,
  DoD,
  DoDItem,
  DispatchCompletion,
  DispatchRecord,
  RetiredCapability,
  JoinSummary,
  CheckpointDecision,
  TypedCheckpointDecision,
  CompletionIntent,
  CompletionIntentMode,
  CompletionAcceptance,
  CheckpointPolicy,
  CheckpointPolicyDefault,
  CheckpointPolicyScope,
  CheckpointPolicyPhase,
  CheckpointRule,
  CheckpointRuleKind,
  HardHumanCheckpointKind,
  CheckpointActor,
  CheckpointActorKind,
  CheckpointAnswerChannel,
  CheckpointAnswerProof,
  TrustedCheckpointAnswer,
  CheckpointAuthorization,
  RosterMultiplicity,
  RosterTriggers,
  RosterBudget,
  RosterSelectionMode,
  RosterSelectionStopReason,
  RosterPolicy,
  RosterSelectionEntry,
  RosterOmittedEntry,
  RosterSelection,
  WorkIdentity,
  WorkIdentityScope,
  PendingReason,
  PendingLease,
  PendingState,
  PendingDispatchState,
  ChildJoinStatus,
  ChildJoin,
  CompletionOutcome,
  CompletionTerminalSignal,
  CompletionSchemaStatus,
  CompletionDodStatus,
  CompletionArtifactRef,
  CompletionEnvelope,
  WorkflowLifecycleStatus,
  WorkflowContractStatus,
  ControlPlaneFieldSource,
  ControlPlaneMigrationStatus,
  ControlPlaneProvenance,
  MigrationReceipt,
  SlotArtifactRecord,
  StageSlotRecords,
  StageFanInResolution,
  FanInConflictRecord,
  LoopIterationRecord,
  LoopState,
} from "./engine/types.js";
// ── CTO sub-orchestration (pure engine) ────────────────────────────────────
export { MAX_TEAMS, MAX_DECOMPOSITION_DEPTH } from "./cto/types.js";
export type {
	TeamDef,
	TeamPlan,
	TeamPlanEntry,
	WorktreeStrategy,
	Escalation,
	EscalationOption,
	EscalationLevel,
	EscalationAdapter,
	EscalationReceipt,
	EscalationStatus,
	EscalationRecord,
	EscalationAnswer,
	TeamRunStatus,
	CtoControlPlaneFields,
	CtoState,
} from "./cto/types.js";
export {
	validateEscalation,
	sanitizeEscalation,
	answersDir,
	readAnswers,
	ensureAnswersDir,
} from "./cto/escalation.js";
export {
	ctoStateDir,
	ctoStatePath,
	newCtoState,
	readBoundCtoState,
	writeCtoState,
	setTeamStatus,
	setEscalation,
	setEscalationStatus,
	setIntegration,
	setCtoPause,
	setCtoControlPlane,
	setTeamControlPlane,
	expireEscalations,
	pendingEscalations,
	activeTeams,
	markAmended,
	isCtoRunTerminal,
	resolveCtoAutonomous,
	// ── resident control-plane (wave lifecycle) ──
	isCtoResident,
	appendWave,
	finishWave,
	activeWave,
	findWaveBySourceId,
} from "./cto/state.js";
export { teamDoDComplete, integrationDoD, ctoBackstop } from "./cto/gates.js";
export { runCto, ctoRunId, type RunCtoOptions, type RunCtoResult } from "./cto/run.js";
export {
  ctoCommand,
  parseEnvelope as parseCtoEnvelope,
  buildCtoPrompt,
  buildAmendPrompt,
  buildStandbyCtoPrompt,
  renderChannelSection,
  type ParsedCtoEnvelope,
  type CtoPromptOptions,
} from "./commands/cto.js";
export {
	buildTeamPlan,
	validateDecompositionDepth,
	type PlanTeamInput,
	type PlanBuildInput,
	type BuildResult,
} from "./cto/plan.js";
export {
  parseWorkEnvelope,
  buildDoWorkPrompt,
  type ParsedWorkEnvelope,
} from "./commands/do-work.js";
export {
  parseAutonomousDirective,
  AUTONOMOUS_TOKEN,
  AUTONOMOUS_DIRECTIVES,
  type AutonomousDirective,
} from "./commands/envelope.js";
export {
  EventRecorder,
  rollupFromEvents,
  readObservabilityPointer,
  extractSkills,
} from "./observability/index.js";
export {
  recordToolCallAttempt,
  recordStageTransition,
  recordArtifactWritten,
  recordWorkPending,
  recordWorkTerminal,
} from "./observability/hooks.js";
export type {
  ObservabilityEvent,
  ObservabilityPointer,
  ObservabilityRollup,
  ObservabilitySignalFields,
  ObservabilityArtifactSummary,
  EventKind,
} from "./observability/events.js";

export {
	migrateCtoState,
} from "./cto/state.js";
export {
	acquireLease,
	heartbeatLease,
	releaseLease,
	isLeaseAlive,
	reclaimDeadLeases,
} from "./cto/leases.js";
export { recordDecision, recallDecisions, decisionsToMarkdown } from "./cto/decisions.js";
export type {
	BudgetPolicy,
	BudgetAccounting,
	BudgetState,
	BudgetStatus,
	TeamLease,
	DecisionMemoryEntry,
	QuarantineRecord,
	RunHealth,
	SchedulerState,
	ScheduledDigest,
	RedactionConfig,
	RefinementResult,
	DissentTrigger,
	DissentEvaluation,
} from "./cto/types.js";

// ── cto resident control-plane (channel policy, slice gate) ────────────────
export {
  resolveBoundChannelProfile,
} from "./cto/channels.js";
export type { ExplicitChannelConfig, ChannelCapabilities } from "./cto/channels.js";
export {
	buildCtoSliceMarker,
	parseCtoSliceMarker,
	assertCtoSliceDispatchable,
	ctoSliceTaskGate,
	validateSliceClassification,
	validateSliceWorkflow,
	validateSliceDoD,
	CTO_SLICE_MARKER_PREFIX,
} from "./cto/slice-gate.js";
export type { WaveRecord, ChannelProfile, ChannelDirection } from "./cto/types.js";

// ── cto-safety (br-zps.4, br-zps.5, br-zps.6) ───────────────────────────────
export { redactEscalation, DEFAULT_REDACTION_CONFIG } from "./cto/redaction.js";
export { outboxEnforcementGate } from "./gates/outbox.js";
export { classificationGate, classificationToolGate } from "./gates/classification.js";
export { keywordClassify, type KeywordGuess } from "./engine/classify.js";
export { buildClassificationPhaseZero, buildWorkflowMatrix, CLASSIFICATION_FIELDS, type ClassificationHint } from "./commands/classification-contract.js";
export type { EscalationInboundMessage } from "./cto/types.js";

// ── cto-operations (br-zps.2, br-zps.7, br-zps.8) ───────────────────────────
export { defaultBudgetState, checkBudget, recordSpend, setBudgetPolicy, CHAR_HEURISTIC_RECORDER } from "./cto/budget.js";
export type { BudgetRecorder } from "./cto/budget.js";
export { assessRunHealth, healthToMarkdown } from "./cto/health.js";
export { shouldRunWave, buildDigest, startWaveScheduler } from "./cto/scheduler.js";

// ── cto-quality (br-zps.9, br-zps.10) ───────────────────────────────────────
export { refineTask, validateRefinement } from "./cto/refinement.js";
export { evaluateDissent } from "./cto/dissent.js";
export { dissentGate } from "./cto/gates.js";

// ── Session-state visualization (pragmatic architecture) ───────────────────
export {
  buildSessionReport,
  writeReport,
} from "./report/assemble.js";
export {
	createReportStorageAuthority,
	isReportStorageAuthority,
	isReportTreeStorageAuthority,
	replaceStorageTreeAtomic,
} from "./report/storage.js";
export type {
	ReportStorageAuthority,
	ReportStorageOperations,
	ReportTreeStorageAuthority,
	ReportTreeStorageOperations,
	StorageEntry,
	StorageFailure,
	StorageFailureReason,
	StorageResult,
	StorageStat,
	StorageTreeEntry,
	StorageTreeLimits,
	StorageTreePublishResult,
} from "./report/storage.js";
export { findActiveCtoRun } from "./report/session-source.js";
export { renderReportHtml } from "./report/html.js";
export { renderMarkdownDocumentHtml } from "./report/markdown.js";
export type { MarkdownDocumentOptions } from "./report/markdown.js";
export { redactReportBody } from "./report/redact.js";
export type {
	SessionKind,
	SessionSelector,
	BuildSessionReportOptions,
	StageInfo,
	StageAgentInfo,
	EdgeKind,
	SessionEdge,
	ArtifactStatus,
	ReportArtifact,
	ReportTeam,
	ReportIntegration,
	ReportHealth,
	ReportMeta,
	ReportSource,
	ReportTelemetry,
	ChronologyEvent,
	SessionReport,
} from "./report/types.js";

// ── Workflow visualization (visualize OPT-A, on-demand projection) ──────────
// Additive seam: the fullstack `/workflow-view` command consumes this surface.
// `export *` deliberately leaves three name clashes to the pre-existing
// explicit exports (ES semantics: explicit exports win over star re-exports),
// so `SessionKind` / `ArtifactStatus` / `WorkflowName` keep their report/
// engine meanings — no breaking export change. The visualize barrel's own
// definitions of those three names (different unions) remain reachable via
// the additive `@andvl1/omp-workflows-core/visualize` subpath export.
export * from "./visualize/index.js";
