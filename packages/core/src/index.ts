/**
 * @andvl1/omp-workflows-core — public API surface.
 *
 * Workflow engine: 7 slash commands, 4 event handlers, 8 declarative
 * JSON profiles, typed artifact schemas, state machine, role/scope
 * resolution, DoD lifecycle, plus runtime observability (event log +
 * rollup). No agents, no skills — bundles ship those.
 *
 * Example minimal bundle:
 *
 *   import { registerTeamWorkflow, defaultFullstackRoles } from "@andvl1/omp-workflows-core";
 *   export default function (pi: ExtensionAPI) {
 *     registerTeamWorkflow(pi, {
 *       label: "omp-workflows-fullstack",
 *       roles: defaultFullstackRoles,
 *     });
 *   }
 */

import { orchestratorWriteGate, workerWriteScopeGate } from "./gates/orchestrator-write.js";
import { dispatchGate, trustedDispatchRequests } from "./gates/dispatch.js";
import type { ExtensionAPI, BeforeAgentStartEvent, SessionStopEvent, ToolCallEvent, ToolResultEvent } from "@oh-my-pi/pi-coding-agent";
import { classificationGate, classificationToolGate } from "./gates/classification.js";
import { monotonicGate } from "./gates/monotonic.js";
import { dodBackstop } from "./gates/dod-backstop.js";
import { safetyGuard } from "./gates/safety.js";
import { ctoNestingGuard } from "./gates/cto-nesting.js";
import { outboxEnforcementGate } from "./gates/outbox.js";
import { ctoSliceTaskGate } from "./cto/slice-gate.js";
import { registerObservabilityHooks, recordToolCallAttempt } from "./observability/index.js";
import { authorizeDispatchTrusted, reconcileTrustedTaskResult } from "./engine/durable.js";
import { registerWorkflowProfiles } from "./engine/profile.js";
import type { Profile, RoleConfig } from "./engine/types.js";
import type { WorkerWriteScope } from "./gates/orchestrator-write.js";
export interface RegisterOptions {
  label?: string;
  roles?: RoleConfig["roles"];
  rosterOverrides?: RoleConfig["roster_overrides"];
  scopeMap?: RoleConfig["scope_map"];
  flags?: RoleConfig["flags"];
  designSystem?: string | null;
  workflowProfiles?: Profile[];
  observability?: boolean;
  /**
   * Bounded write_scope experiment: when enabled, worker source writes are
   * narrowed to the declared scope after the orchestrator gate. Off by
   * default — shipped workflows keep the single-writer model.
   */
  writeScope?: WorkerWriteScope;
}

export type CommandId = "do-work" | "team" | "cto" | "init-team" | "interview" | "omp-model-roles";

export const defaultFullstackRoles: RoleConfig["roles"] = {
  analyst: "analyst",
  "tech-researcher": "tech-researcher",
  diagnostics: "diagnostics",
  architect: "architect",
  architect_minimal: "architect",
  architect_clean: "architect",
  architect_pragmatic: "architect",
  "backend-kotlin": "developer-kotlin",
  go: "developer-go",
  frontend: "frontend-developer",
  mobile: "developer-mobile",
  android: "developer-mobile",
  qa: "qa",
  "manual-qa": "manual-qa",
  "code-reviewer": "code-reviewer",
  "security-tester": "security-tester",
  devops: "devops",
  "regression-planner": "analyst",
  "regression-executor": "manual-qa",
  "regression-oracle": "qa",
};


export const defaultFullstackScopeMap: RoleConfig["scope_map"] = [
  { glob: ["**/iosApp/**", "**/composeApp/**", "**/commonMain/**", "**/androidMain/**"], scope: "mobile", dev_agent: "developer-mobile" },
  { glob: ["**/*.tsx", "**/*.jsx", "**/*.vue", "**/*.ts", "**/src/jsMain/**", "**/miniapp/**", "**/frontend/**"], scope: "frontend", dev_agent: "frontend-developer" },
  { glob: ["**/*.go", "**/go.mod", "**/go.sum"], scope: "go", dev_agent: "developer-go" },
  { glob: ["**/Dockerfile", "**/*.yaml", "**/*.yml", "**/helm/**", "**/.github/**", "**/k8s/**"], scope: "devops", dev_agent: "devops" },
  { glob: ["**/*.kt", "**/*.java", "**/src/main/**"], scope: "backend-kotlin", dev_agent: "developer-kotlin" },
];

export const defaultFullstackFlags: RoleConfig["flags"] = {
  has_security: ["**/auth/**", "**/security/**", "**/*crypto*", "**/*Secret*", "**/*Token*"],
  has_infra: ["**/Dockerfile", "**/helm/**", "**/k8s/**", "**/.github/workflows/**"],
};
// ── Model-role taxonomy ─────────────────────────────────────────────────────
export { defaultFullstackModelRoles } from "./model-roles.js";
export {
	resolveRoleChain,
	isResearchRequest,
	isResearchResponse,
	validateResearchRequest,
	validateResearchResponse,
} from "./model-roles.js";
export type {
	ModelRoleEntry,
	InventoryModel,
	RoleLookup,
	RoleResolution,
	RoleResolutionStatus,
	ResearchRequest,
	ResearchResponse,
	BenchmarkSource,
	ResearchRecommendation,
} from "./model-roles.js";

/**
 * Wire the engine into omp's ExtensionAPI. Bundles call this from their
 * default export. The engine consults `.omp/team.config.json` (or the
 * `roles`/`scopeMap` overrides) at runtime to resolve workflow roles to agents.
 *
 * Extension-side responsibilities:
 * - Register gates (classification, monotonic, dod-backstop, safety).
 * - Write runtime config (roles, scope, flags) for custom-TS commands.
 * - Register observability hooks (event log + rollup in `.work-state/features/<slug>/observability/`).
 *
 * Slash commands are NOT registered here. Since OMP 17.x, the `task` tool
 * lives on the main agent only — `ExtensionCommandContext` exposes no
 * subagent-dispatch affordance. Workflow commands ship as OMP custom-TS
 * commands in `packages/fullstack/commands/<name>/index.ts`; they receive
 * a `HookCommandContext` that can read `cwd`, `ui`, `sessionManager`, and
 * `modelRegistry`, and rely on `ctx.sendUserMessage(prompt)` to hand the
 * profile-driven workflow to the main agent's own `task` tool.
 */
export function registerTeamWorkflow(pi: ExtensionAPI, opts: RegisterOptions = {}): void {
	const label = opts.label ?? "omp-workflows";
	pi.setLabel(label);
  if (opts.workflowProfiles?.length) registerWorkflowProfiles(opts.workflowProfiles);

	writeRuntimeConfig(opts);

	// @ts-expect-error -- ExtensionAPI.on(string, handler) overload is enough at runtime; we type the handler explicitly.
	pi.on("before_agent_start", (event: BeforeAgentStartEvent, ctx: unknown) => {
		const c = ctx as { cwd: string };
		const r1 = classificationGate(event as unknown as Parameters<typeof classificationGate>[0], c);
		if (r1?.block) return r1;
		const r2 = monotonicGate(event, c);
		if (r2?.block) return r2;
	});
	pi.on("session_stop", (event: SessionStopEvent, ctx: unknown) => {
		const c = ctx as { cwd: string };
		return dodBackstop(event as unknown as Parameters<typeof dodBackstop>[0], c);
	});
  pi.on("tool_call", (event: ToolCallEvent, ctx: unknown) => {
    const c = ctx as { cwd: string; hasUI?: boolean; actor?: "orchestrator" | "worker" | "lead" };
    let result: { block?: boolean; reason?: string } | undefined;
    const run = (candidate: { block?: boolean; reason?: string } | void) => { if (!result && candidate?.block) result = candidate; };
    run(ctoNestingGuard(event as unknown as Parameters<typeof ctoNestingGuard>[0]));
    run(outboxEnforcementGate(event as unknown as Parameters<typeof outboxEnforcementGate>[0], c));
    run(classificationToolGate(event as unknown as Parameters<typeof classificationToolGate>[0], c));
    run(orchestratorWriteGate(event as unknown as Parameters<typeof orchestratorWriteGate>[0], c));
    // Bounded write_scope experiment: composed AFTER the orchestrator gate,
    // so it can only narrow worker writes, never weaken the boundary.
    run(workerWriteScopeGate(event as unknown as Parameters<typeof workerWriteScopeGate>[0], { ...c, writeScope: opts.writeScope }));
    run(ctoSliceTaskGate(event as unknown as Parameters<typeof ctoSliceTaskGate>[0], c));
    run(safetyGuard(event as unknown as Parameters<typeof safetyGuard>[0], c));
    run(dispatchGate(event as unknown as Parameters<typeof dispatchGate>[0], c));
    if (!result && event.toolName === "task") {
      const authorization = trustedDispatchRequests(
        event as unknown as { toolName?: string; toolCallId?: string; input?: unknown },
        c,
      );
      if (!authorization.ok) {
        run({ block: true, reason: authorization.reason });
      } else {
        for (const request of authorization.requests) {
          const authorized = authorizeDispatchTrusted(c.cwd, request);
          if (!authorized.ok) {
            run({ block: true, reason: `dispatch authorization failed: ${authorized.error}` });
            break;
          }
        }
      }
    }
    if (opts.observability !== false) recordToolCallAttempt(c.cwd, event as unknown as { toolName?: string; toolCallId?: string; input?: unknown }, result ? "blocked" : "allowed", result?.reason);

    return result;
  });
  // Native task results are the trusted completion signal for synchronous
  // calls. Async task jobs remain pending until the workflow_complete tool
  // receives their explicit result/evidence binding.
  pi.on("tool_result", (event: ToolResultEvent, ctx: unknown) => {
    if (event.toolName !== "task") return;
    const c = ctx as { cwd?: string };
    if (!c.cwd) return;
    const details = (event as unknown as { details?: { async?: { state?: string } } }).details;
    const asyncState = details?.async?.state;
    if (asyncState === "running" || asyncState === "spawned" || asyncState === "scheduled") return;
    const content = event.content
      .filter((part): part is { type: "text"; text: string } => part.type === "text")
      .map((part) => part.text)
      .join("\n")
      .trim();
    const evidence = content || (event.isError ? "native task failed" : "native task completed");
    const reconciled = reconcileTrustedTaskResult(c.cwd, {
      tool_call_id: event.toolCallId,
      outcome: event.isError ? "failed" : "succeeded",
      evidence,
    });
    if (!reconciled.ok && !reconciled.error.includes("unknown or already reconciled")) {
      console.warn(`omp workflow task reconciliation failed: ${reconciled.error}`);
    }
  });

	// ── Observability ────────────────────────────────────────────────────────
	// Wire telemetry hooks AFTER gates so a blocked agent_start still emits
	// the event (operators want to see *why* the gate fired). The recorder
	// is best-effort; never throws.
	registerObservabilityHooks(pi, { enabled: opts.observability, toolCall: false });
}

function writeRuntimeConfig(opts: RegisterOptions): void {
  const hasOverride = opts.roles || opts.scopeMap || opts.flags || opts.rosterOverrides;
  if (!hasOverride) return;
  try {
    const { resolveRuntimeConfigPath, writeConfig } = require("./runtime-config.js") as typeof import("./runtime-config.js");
    const path = resolveRuntimeConfigPath(process.cwd());
    if (!path) return;
    writeConfig(path, {
      roles: opts.roles ?? {},
      roster_overrides: opts.rosterOverrides ?? {},
      scope_map: opts.scopeMap ?? [],
      flags: opts.flags ?? {},
      design_system: opts.designSystem ?? null,
    });
  } catch {
    // best-effort
  }
}
export { teamCommand } from "./commands/team.js";
export { dispatchGate, buildDispatchMarker, parseDispatchMarker, trustedDispatchRequests, type DispatchAuthorizationRequest } from "./gates/dispatch.js";
export {
  findProfileDir,
  resolveWorkflowProfilePath,
  loadAllProfiles,
  loadProfile,
  isRegisteredWorkflow,
  matchesProfile,
  registerWorkflowProfiles,
  resolveWorkflow,
  selectProfile,
} from "./engine/profile.js";
export {
  hashDispatchSecret,
  createCapability,
  beginCapability,
  authorizeDispatch,
  authorizeDispatchTrusted,
  completeDispatch,
  reconcileTrustedTaskResult,
  advanceCursor,
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
  resolveWorkflowContract,
  resolveStageInstructions,
  WorkflowContractError,
  type WorkflowContract,
  type WorkflowContractOptions,
  type WorkflowStageContract,
} from "./engine/workflow-contract.js";
export {
  resolveConfig,
  resolveAgentForRole,
  agentMappingIssueForRole,
} from "./engine/config.js";
export {
  AGENT_MAPPING_SCHEMA,
  DEFAULT_GENERIC_AGENT,
  agentMappingPath,
  buildAgentMapping,
  mappingPreferencesHash,
  readAgentMapping,
  writeAgentMapping,
  type AgentMappingDiagnostic,
  type AgentMappingOptions,
  type AgentMappingState,
  type AgentMappingStatus,
} from "./engine/agent-mapping.js";
export { resolveScope, applyConditional, shouldSkip } from "./engine/scope.js";
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
	walkProfile,
	runStage,
	createTaskCaller,
	spawnLabel,
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
  RoleConfig,
  DoD,
  DoDItem,
  DispatchCompletion,
  DispatchRecord,
  DispatchCapabilityState,
  JoinSummary,
  CheckpointDecision,
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
	CtoState,
} from "./cto/types.js";
export {
	validateEscalation,
	sanitizeEscalation,
	answersDir,
	readAnswers,
	ensureAnswersDir,
} from "./cto/escalation.js";
export { buildTeamPlan, validateDecompositionDepth, loadTeamDefs, type PlanTeamInput, type BuildResult } from "./cto/plan.js";
export {
	ctoStateDir,
	ctoStatePath,
	newCtoState,
	readCtoState,
	writeCtoState,
	setTeamStatus,
	setEscalation,
	setEscalationStatus,
	setIntegration,
	setCtoPause,
	expireEscalations,
	pendingEscalations,
	activeTeams,
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
  findActiveCtoRun,
  type ParsedCtoEnvelope,
  type CtoPromptOptions,
} from "./commands/cto.js";
export {
	registerWorkflowCommands,
	type WorkflowCommandOptions,
} from "./commands/register.js";
export {
  parseWorkEnvelope,
  buildDoWorkPrompt,
  type ParsedWorkEnvelope,
  type WorkTeamConfig,
} from "./commands/do-work.js";
export {
  parseAutonomousDirective,
  AUTONOMOUS_TOKEN,
  AUTONOMOUS_DIRECTIVES,
  type AutonomousDirective,
} from "./commands/envelope.js";
export { markAmended } from "./cto/state.js";
export {
	EventRecorder,
	rollupFromEvents,
	readObservabilityPointer,
	extractSkills,
	type ObservabilityEvent,
	type ObservabilityPointer,
	type ObservabilityRollup,
	type EventKind,
} from "./observability/index.js";

/**
 * Marker exported so custom-TS commands can detect that the engine was
 * wired in this package (i.e. the bundle is `omp-workflows-fullstack` or
 * a derivative that calls `registerTeamWorkflow`). Used by the bundled
 * commands to short-circuit when no engine is present.
 */
export const CORE_ENGINE_MARKER = "omp-workflows-core/0.8.0";

// ── cto-core (br-zps.1, br-zps.3, br-zps.11) ────────────────────────────────
export {
	migrateCtoState,
	canonicalizeState,
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
	resolveChannelProfile,
	normalizeChannelConfig,
	hasRwPrimary,
	loadEscalationConfigRaw,
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
export { renderReportHtml } from "./report/html.js";
export { redactReportBody } from "./report/redact.js";
export { recordStageTransition, recordArtifactWritten } from "./observability/index.js";
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
