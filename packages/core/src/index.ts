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
 *   import { registerTeamWorkflow } from "@andvl1/omp-workflows-core";
 *   export default function (pi: ExtensionAPI) {
 *     registerTeamWorkflow(pi, {
 *       label: "omp-workflows-custom",
 *       roles: { developer: "developer" },
 *     });
 *   }
 */

import { createHash, randomUUID } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  orchestratorWriteGate,
  workerWriteScopeGate,
  isRegisteredLifecycleDeviceWrite,
  createTrustedOrchestratorWriteProof,
  TRUSTED_ORCHESTRATOR_WRITE_PROOF,
  type TrustedOrchestratorWriteProof,
  type WorkerWriteScope,
} from "./gates/orchestrator-write.js";
import { readOnlyWorkerBashGate } from "./gates/read-only-bash.js";
import { dispatchGate, parseDispatchMarker, trustedDispatchRequests, type DispatchMarker } from "./gates/dispatch.js";
import type { ExtensionAPI, BeforeAgentStartEvent, ToolCallEvent, ToolResultEvent } from "@oh-my-pi/pi-coding-agent";
import { classificationGate, classificationToolGate } from "./gates/classification.js";
import { monotonicGate } from "./gates/monotonic.js";
import { dodBackstop } from "./gates/dod-backstop.js";
import { safetyGuard } from "./gates/safety.js";
import { ctoNestingGuard } from "./gates/cto-nesting.js";
import { outboxEnforcementGate } from "./gates/outbox.js";
import { ctoSliceTaskGate, parseCtoSliceMarker } from "./cto/slice-gate.js";
import { isCtoRunTerminal, readCtoState } from "./cto/state.js";
import { resolveActiveBranch, withWorkspaceTransaction } from "./engine/state.js";
import { publishDeclaredDocumentStage } from "./engine/stage.js";
import { registerObservabilityHooks, recordToolCallAttempt, setObservabilityRun } from "./observability/index.js";
import { authorizeDispatchTrusted, reconcileTrustedTaskResult, beginCapability, completeDispatch, advanceCursor, recordCheckpointDecision, validateCheckpointAsk, commitCheckpointAnswer, hashDispatchSecret, rejectDispatchPreflightTrusted, findAcceptedOrdinaryStageReceipt, type CheckpointAnswerCommitResult } from "./engine/durable.js";
import { loadProfile, registerWorkflowProfiles } from "./engine/profile.js";
import { prepareWorkflowState, type ModelClassification, type WorkflowPrepareOptions } from "./engine/run.js";
import { LifecycleError } from "./engine/run-lifecycle.js";
import { resolveWorkflowContract, WorkflowContractError } from "./engine/workflow-contract.js";
import { findCurrentCheckpointDecision, recordTrustedCheckpointAnswer } from "./engine/checkpoints.js";
import { createWorkflowSessionController, ctoClaimCredentials, type WorkflowSessionController } from "./engine/host-controller.js";
import { suspendCtoSession, finalizeCtoSession, readCtoStateForModel, commitCtoStateForModel } from "./cto/run.js";
import { readDispatchOriginLocator, rememberDispatchOriginLocator } from "./dispatch-origin-locator.js";
import { resolveRuntimeConfigPath, writeConfig } from "./runtime-config.js";
import { readRunControlNoRecovery, knownDispatchOrigins, rememberDispatchOrigin, restoreDispatchOrigins, readSelectionSnapshot, retainSelectionSnapshot, readRunControl, readRunState, resolveRunSelection, listRuns, runStatePath, runTarget, reserveExecutionClaimWorkers, settleExecutionClaimWorkers, settleCtoExecutionClaimWorkersByToolCall, type DispatchOrigin } from "./engine/run-store.js";
import type { Profile, RoleConfig, CheckpointRuleKind, CheckpointAnswerProof, TrustedExecutionContext, LifecycleSelector, CtoClaimScope, RunControl, WorkIdentity, StageReceiptLedger, CapturedDispatchContext } from "./engine/types.js";
import { createNativeWorkerAuthority, NativeWorkerRouteError, type NativeWorkerAuthority, type NativeRootAuthorityRegistration, type NativeWorkerResolution } from "./native-worker-authority.js";
import { commitNativeCtoStageResult } from "./cto/native-stage-execution.js";
import { advanceNativeStageForCoordinator, findNativeAcceptedStageReceipt, preflightNativeStageCheckpoint, commitNativeStageCheckpoint, type NativeStageMutationResult } from "./cto/native-stage.js";
import { readArtifactFileSafe } from "./engine/artifacts.js";
import {
  OMP_STAGE_HOST_CAPABILITIES,
  deriveWorkerStageHostBinding,
  deriveMainStageHostBinding,
  createTrustedToolCallback,
  submitStageResult,
  resolveStageSubmissionBinding,
  receiptFromLedger,
  type StageAuthority,
  type StageHostBindingResolver,
  type StageHostBinding,
  type TrustedToolCallback,
  type StageProducerBinding,
  type StageResultCommitter,
  type StageResultValidationFailure,
  type StageResultSubmissionOutcome,
} from "./engine/reliable-stage.js";
import {
  recoverStageExecution,
  type RecoveryErrorClass,
  type RecoveryIntent,
  type RecoveryEvidenceProof,
  type RecoveryHostInput,
  type RecoveryPreflightNotStartedProof,
  type RecoveryReplacementEvidence,
  type RecoveryTerminalEvidence,
  type StageRecoveryCapabilities,
  type StageRecoveryExecutionOptions,
  type StageRecoveryHost,
  type StageRecoveryRequest,
  type StageRecoveryResult,
  type StageRecoverySnapshot,
  type StageRecoveryTransitionResult,
  type TrustedRecoverySelection,
} from "./engine/stage-recovery.js";
import {
  createOrdinaryStageRecoveryStore,
  type OrdinaryStageRecoveryStore,
  type StageRecoveryFormatValidationInput,
} from "./engine/stage-recovery-store.js";
import {
  createNativeStageRecoveryStore,
  type NativeStageRecoveryStore,
} from "./cto/stage-recovery-store.js";
import type { ScopeRuntimeClassTable } from "./engine/scope.js";
import type { DispatchAuth, RosterBeginSelection } from "./engine/durable.js";
import type { AgentMappingState } from "./engine/agent-mapping.js";
import {
  trustedToolCallAdmissionDiagnostic,
  type AdmissionDiagnosticCode,
  type TrustedToolCallDenialCode,
  type TrustedToolCallAdmissionScenario,
  type TrustedToolCallAdapterSignal,
} from "./actor-admission-diagnostics.js";
export type { TrustedToolCallDenialCode } from "./actor-admission-diagnostics.js";

export type WorkflowCapability = "workflow_registration" | "workflow_tools" | "config_writer";

export type WorkflowOwnerKind = "fullstack" | "private_omp" | (string & {});

export interface WorkflowOwnerProvenance {
  package: string;
  entrypoint: string;
  cwd: string;
  config_path?: string;
}

export interface WorkflowOwnerIdentity {
  owner_id: string;
  bundle_id: string;
  owner_kind: WorkflowOwnerKind;
  activation_marker: string;
  host_range: string;
  provenance: WorkflowOwnerProvenance;
}

export interface WorkflowOwnerClaim {
  project_root: string;
  capability: WorkflowCapability;
  fingerprint: string;
  owner: WorkflowOwnerIdentity;
}
const stageBindingResolvers = new WeakMap<object, StageHostBindingResolver>();
const stageResultCommitters = new WeakMap<object, StageResultCommitter>();
const stageToolBindingResolvers = new WeakMap<object, (
  ctx: unknown,
  cwd: string,
  runId: string,
  toolName: string,
  callback: TrustedToolCallback,
) => StageHostBinding | undefined>();
type StageToolPublisherStart =
  | { ok: true; publish: StageResultPublisher; close(): void }
  | { ok: false; code: string; error: string };
const stageToolPublisherFactories = new WeakMap<object, (
  ctx: unknown,
  toolName: string,
  registrationId: string,
  invocationId: string,
) => StageToolPublisherStart>();
type AuthenticatedStageRecoveryStore = OrdinaryStageRecoveryStore | NativeStageRecoveryStore;
type StaleAdmissionObservation = {
  readonly cwd: string;
  readonly run_id: string;
  readonly authority: StageAuthority;
  readonly tool_call_id: string;
  readonly reason: string;
  readonly observed_at: string;
};
type StageRecoveryRuntime = {
  readonly storeFor: (ctx: unknown, cwd: string) => AuthenticatedStageRecoveryStore | undefined;
  ownerStoreFor?: (
    cwd: string,
    runId: string,
    authority: StageAuthority,
  ) => AuthenticatedStageRecoveryStore | undefined;
  readonly host: StageRecoveryHost;
  readonly staleAdmissions: WeakMap<object, StaleAdmissionObservation>;
  readonly automaticPending: Set<Promise<void>>;
  automaticContinuation?: Promise<void>;
  automaticOpen: boolean;
};
const stageRecoveryRuntimes = new WeakMap<object, StageRecoveryRuntime>();
const nativeWorkerAuthorities = new WeakMap<object, NativeWorkerAuthority>();
function recoveryStoreForController(controller: WorkflowSessionController, cwd: string): AuthenticatedStageRecoveryStore | undefined {
  const context = controller.context();
  let ctoClaim: CtoClaimScope | undefined;
  try {
    ctoClaim = controller.activeCtoClaim();
  } catch (error) {
    if (!(error instanceof LifecycleError) || error.code !== "recovery_required") throw error;
    // A torn lifecycle journal can make the durable claim unreadable. The
    // controller's private credential binding is still the authenticated
    // session boundary; the owner-scoped store will revalidate it after
    // journal repair. Never manufacture this fallback without that binding.
    const credentials = ctoClaimCredentials(controller);
    if (!credentials) throw error;
    ctoClaim = { run_id: credentials.run_id, ownership_epoch: credentials.ownership_epoch };
  }
  if (ctoClaim) return createNativeStageRecoveryStore(cwd, { context, runId: ctoClaim.run_id, claim_scope: ctoClaim });
  const runId = controller.selectedRunId();
  if (!runId || controller.activeClaimRunId() !== runId) return undefined;
  return createOrdinaryStageRecoveryStore(cwd, { context, runId });
}
function controllerHasActiveRecoveryOwner(controller: WorkflowSessionController | null): boolean {
  if (!controller) return false;
  try {
    return controller.activeCtoClaim() !== undefined || controller.activeClaimRunId() !== undefined;
  } catch {
    return false;
  }
}

type WorkflowRecoveryToolInput = {
  readonly operation: "diagnose" | "reconcile";
  readonly intent?: RecoveryIntent;
};

function recoveryProof(input: RecoveryHostInput, eventId: string, source: string): RecoveryEvidenceProof {
  const bindingId = input.snapshot.binding_id ?? input.snapshot.ownership?.binding_id;
  if (!bindingId) throw new Error("recovery host binding is unavailable");
  return {
    authenticated: true,
    source,
    event_id: eventId,
    binding_id: bindingId,
    observed_at: new Date().toISOString(),
    state_revision: input.snapshot.revision,
  };
}

function recoveryMessageSender(pi: ExtensionAPI): (
  message: unknown,
  options: { deliverAs: "followUp"; triggerTurn: true },
) => void | PromiseLike<void> {
  const sendMessage = (pi as unknown as {
    sendMessage?: (
      message: unknown,
      options?: { deliverAs?: "steer" | "followUp" | "nextTurn"; triggerTurn?: boolean },
    ) => void | PromiseLike<void>;
  }).sendMessage;
  if (typeof sendMessage !== "function") throw new Error("the OMP host does not expose sendMessage for recovery continuation");
  return (message, options) => sendMessage.call(pi, message, options);
}

function createStageRecoveryHost(pi: ExtensionAPI): StageRecoveryHost {
  const queued = new Map<string, RecoveryReplacementEvidence>();
  const queue = async (input: RecoveryHostInput & { readonly retry_of?: string; readonly producer_correction?: boolean }): Promise<void> => {
    const send = recoveryMessageSender(pi);
    await send({
      customType: "omp-workflow-stage-recovery",
      content: "Продолжите сохранённое назначение через обычный workflow task admission с canonical handoff и retry_of. Сохраните имеющиеся изменения, отчёт предыдущего worker и результаты проверок; выполните только оставшуюся работу и проверки, затем workflow_submit_result. Не повторяйте весь workflow, не создавайте второй writer и не подделывайте результаты.",
      details: {
        version: 1 as const,
        kind: "stage_recovery_continuation" as const,
        run_id: input.request.run_id,
        authority: input.request.authority,
        operation_id: input.operation_id,
        retry_of: input.retry_of ?? input.identity.dispatch_id,
        identity: input.replacement_identity ?? input.identity,
        ...(input.snapshot.handoff ? { handoff: input.snapshot.handoff } : {}),
        ...(input.snapshot.submission ? { assignment: input.snapshot.submission } : {}),
        ...(input.producer_correction ? { producer_correction: true } : {}),
      },
    }, { deliverAs: "followUp", triggerTurn: true });
  };

  const dispatchReplacement = async (
    input: RecoveryHostInput & { readonly retry_of: string; readonly error_class: RecoveryErrorClass; readonly producer_correction: boolean },
  ): Promise<RecoveryReplacementEvidence> => {
    if (input.producer_correction) throw new Error("default OMP host cannot prove same-producer format repair or producer-only correction");
    const planned = input.replacement_identity ?? input.prepared_operation?.replacement_identity;
    if (!planned) throw new Error("recovery replacement identity was not owner-minted");
    const existing = queued.get(input.operation_id);
    if (existing && existing.kind === "replacement_dispatched") {
      if (!isDeepStrictEqual(existing.new_identity, planned)) throw new Error("recovery replacement replay identity conflicts");
      return existing;
    }
    await queue(input);
    const proof = recoveryProof(input, `recovery:${input.operation_id}:queued`, "omp-send-message");
    const evidence: RecoveryReplacementEvidence = {
      authoritative: true,
      run_id: input.request.run_id,
      dispatch_id: input.identity.dispatch_id,
      identity: input.identity,
      operation: "replacement_dispatch",
      proof,
      kind: "replacement_dispatched",
      original_dispatch_id: input.retry_of,
      new_identity: planned,
      observed_at: proof.observed_at,
      new_state: "pending",
    };
    queued.set(input.operation_id, evidence);
    return evidence;
  };
  const capabilities: StageRecoveryCapabilities = Object.freeze({
    trusted_lineage: "supported",
    terminal_lifecycle: "supported",
    preflight_not_started: "unsupported",
    inspect: "unsupported",
    observe: "unsupported",
    reconnect: "unsupported",
    resume: "unsupported",
    clarify: "unsupported",
    cancel_ack: "unsupported",
    format_repair: "unsupported",
    replacement_dispatch: "supported",
    producer_correction: "unsupported",
    operation_replay: "unsupported",
  });
  return { capabilities, dispatchReplacement };
}
function recoveryIdentityFromOrigin(origin: DispatchOrigin): WorkIdentity | undefined {
  try {
    const state = readRunState(origin.cwd, origin.run_id);
    const dispatches = state?.dispatch_capability?.dispatches ?? [];
    const record = dispatches.find((candidate) => candidate.id === origin.dispatch_id);
    return record?.work_identity;
  } catch {
    return undefined;
  }
}
/** Resolve latest canonical attempts without inventing a consilium root identity. */
function currentRecoveryAssignments(cwd: string, runId: string): WorkIdentity[] {
  const state = readRunState(cwd, runId);
  if (!state) throw new Error("canonical recovery state unavailable");
  const bySlot = new Map<string, WorkIdentity>();
  for (const dispatch of state.dispatch_capability?.dispatches ?? []) {
    const identity = dispatch.work_identity;
    if (!identity || identity.run_id !== runId || identity.stage_cursor !== state.stage_cursor) continue;
    const previous = bySlot.get(identity.slot_id);
    if (previous && previous.attempt === identity.attempt && previous.dispatch_id !== identity.dispatch_id) {
      throw new Error("ambiguous canonical recovery slot");
    }
    if (!previous || identity.attempt > previous.attempt) bySlot.set(identity.slot_id, identity);
  }
  return [...bySlot.values()];
}

async function persistRecoveryTerminalObservation(
  runtime: StageRecoveryRuntime | undefined,
  ctx: unknown,
  cwd: string,
  authority: StageAuthority,
  runId: string,
  identity: WorkIdentity | undefined,
  toolCallId: string,
  outcome: "succeeded" | "failed" | "cancelled",
  terminalEvent?: { source: string; event_id: string },
): Promise<void> {
  if (!runtime) return;
  const store = runtime.storeFor(ctx, cwd) ?? runtime.ownerStoreFor?.(cwd, runId, authority);
  if (!store) return;
  let snapshot: StageRecoverySnapshot;
  try {
    snapshot = await store.read({
      run_id: runId,
      authority,
      ...(identity ? { identity } : {}),
    });
  } catch {
    return;
  }
  if (!snapshot.identity || (identity && !isDeepStrictEqual(snapshot.identity, identity)) || !snapshot.binding_id) return;
  const selection = store.selection(snapshot.identity);
  const operationId = `omp-recovery-terminal:${toolCallId}:${snapshot.identity.dispatch_id}`;
  let prepared: StageRecoveryTransitionResult;
  try {
    prepared = await store.transition({
      phase: "prepare",
      operation_id: operationId,
      run_id: runId,
      authority,
      expected_revision: snapshot.revision,
      selection,
      mutation: {
        kind: "host_action",
        action: "observe",
        dispatch_id: snapshot.identity.dispatch_id,
        state_proof: snapshot.state_proof,
      },
    });
  } catch {
    return;
  }
  if (!prepared.ok) return;
  if (prepared.operation.status === "acked") {
    if (outcome !== "succeeded" || snapshot.error_context?.class === "format_validation") {
      scheduleAutomaticRecovery(runtime, {
        kind: "terminal",
        run_id: runId,
        authority,
        cwd,
        ctx,
        dispatch_id: snapshot.identity.dispatch_id,
        outcome,
      });
    }
    return;
  }
  const observedAt = new Date().toISOString();
  const proof: RecoveryEvidenceProof = {
    authenticated: true,
    source: terminalEvent?.source ?? "omp-task-result",
    event_id: terminalEvent?.event_id ?? `task_result:${toolCallId}:${snapshot.identity.dispatch_id}`,
    binding_id: snapshot.binding_id,
    observed_at: observedAt,
    state_revision: prepared.revision,
  };
  const evidence: RecoveryTerminalEvidence = {
    authoritative: true,
    run_id: runId,
    dispatch_id: snapshot.identity.dispatch_id,
    identity: snapshot.identity,
    operation: "observe",
    proof,
    kind: "terminal",
    outcome,
    terminal_event_id: proof.event_id,
    observed_at: observedAt,
  };
  const response: StageRecoveryResult = {
    operation_id: operationId,
    code: outcome === "succeeded" ? "worker_succeeded" : "worker_terminal",
    worker: "terminal",
    action: "none",
    attempts_remaining: 0,
    retry_of: snapshot.identity.dispatch_id,
    evidence,
    state_revision: prepared.revision,
    state_proof: prepared.state_proof ?? { ...snapshot.state_proof, revision: prepared.revision },
  };
  let acked: StageRecoveryTransitionResult;
  try {
    acked = await store.transition({
      phase: "ack",
      operation_id: operationId,
      run_id: runId,
      authority,
      expected_revision: prepared.revision,
      selection,
      evidence,
      response,
    });
  } catch {
    // The durable operation remains prepared and is replay-safe; do not infer
    // terminality again from an unacknowledged observation.
    return;
  }
  if (!acked.ok) return;
  if (outcome !== "succeeded" || snapshot.error_context?.class === "format_validation") {
    scheduleAutomaticRecovery(runtime, {
      kind: "terminal",
      run_id: runId,
      authority,
      cwd,
      ctx,
      dispatch_id: snapshot.identity.dispatch_id,
      outcome,
    });
  }
}

type RecoveryDispatchSlot = {
  readonly run_id: string;
  readonly capability_id: string;
  readonly stage_cursor: string;
  readonly cursor_epoch: string;
  readonly slot_id: string;
  readonly task_id: string;
  readonly agent: string;
};

function recoveryIdentityForSlot(cwd: string, slot: RecoveryDispatchSlot): WorkIdentity | undefined {
  try {
    const state = readRunState(cwd, slot.run_id);
    const matches = (state?.dispatch_capability?.dispatches ?? []).filter((record) => {
      const identity = record.work_identity;
      return identity
        && identity.capability_id === slot.capability_id
        && identity.stage_id === slot.stage_cursor
        && identity.capability_epoch === slot.cursor_epoch
        && identity.slot_id === slot.slot_id
        && identity.task_id === slot.task_id
        && record.agent === slot.agent;
    });
    return matches.length === 1 ? matches[0]!.work_identity : undefined;
  } catch {
    return undefined;
  }
}

function persistRecoveryPreflightObservation(
  runtime: StageRecoveryRuntime | undefined,
  ctx: unknown,
  cwd: string,
  authority: StageAuthority,
  runId: string,
  identity: WorkIdentity | undefined,
  toolCallId: string,
  reason: string,
): boolean {
  if (!runtime || !identity) return false;
  const store = runtime.storeFor(ctx, cwd) ?? runtime.ownerStoreFor?.(cwd, runId, authority);
  if (!store) return false;
  try {
    const read = store.read({ run_id: runId, authority, identity });
    if (read instanceof Promise) return false;
    const snapshot = read;
    if (!snapshot.identity || !snapshot.binding_id || !isDeepStrictEqual(snapshot.identity, identity)) return false;
    const selection = store.selection(identity);
    const operationId = `omp-recovery-preflight:${toolCallId}:${identity.dispatch_id}`;
    const prepared = store.transition({
      phase: "prepare",
      operation_id: operationId,
      run_id: runId,
      authority,
      expected_revision: snapshot.revision,
      selection,
      mutation: {
        kind: "host_action",
        action: "observe",
        dispatch_id: identity.dispatch_id,
        state_proof: snapshot.state_proof,
      },
    });
    if (prepared instanceof Promise || !prepared.ok) return false;
    if (prepared.operation.status === "acked") return true;
    const observedAt = new Date().toISOString();
    const proof: RecoveryEvidenceProof = {
      authenticated: true,
      source: "omp-task-admission",
      event_id: `task_call:${toolCallId}:${identity.dispatch_id}`,
      binding_id: snapshot.binding_id,
      observed_at: observedAt,
      state_revision: prepared.revision,
    };
    const evidence: RecoveryPreflightNotStartedProof = {
      authoritative: true,
      kind: "preflight_not_started",
      never_started: true,
      run_id: runId,
      dispatch_id: identity.dispatch_id,
      identity,
      reason,
      observed_at: observedAt,
      proof,
    };
    const response: StageRecoveryResult = {
      operation_id: operationId,
      code: "preflight_not_started",
      worker: "not_started",
      action: "preflight",
      attempts_remaining: 0,
      retry_of: identity.dispatch_id,
      state_revision: prepared.revision,
      state_proof: prepared.state_proof ?? { ...snapshot.state_proof, revision: prepared.revision },
      evidence,
    };
    const acked = store.transition({
      phase: "ack",
      operation_id: operationId,
      run_id: runId,
      authority,
      expected_revision: prepared.revision,
      selection,
      evidence,
      response,
    });
    if (acked instanceof Promise || !acked.ok) return false;
    return true;
  } catch {
    // A malformed attempt never gains authority from a failed observation.
    return false;
  }
}
type AutomaticRecoveryTrigger =
  | {
      readonly kind: "preflight";
      readonly run_id: string;
      readonly authority: StageAuthority;
      readonly cwd: string;
      readonly ctx: unknown;
      readonly dispatch_id: string;
    }
  | {
      readonly kind: "terminal";
      readonly run_id: string;
      readonly authority: StageAuthority;
      readonly cwd: string;
      readonly ctx: unknown;
      readonly dispatch_id: string;
      readonly outcome: "failed" | "cancelled" | "succeeded";
    };

function automaticRecoveryOperationId(trigger: AutomaticRecoveryTrigger): string {
  return trigger.kind === "preflight"
    ? `omp-recovery-auto:preflight:${trigger.authority}:${trigger.run_id}:${trigger.dispatch_id}`
    : `omp-recovery-auto:terminal:${trigger.authority}:${trigger.run_id}:${trigger.dispatch_id}:${trigger.outcome}`;
}

async function executeAutomaticRecovery(
  runtime: StageRecoveryRuntime,
  trigger: AutomaticRecoveryTrigger,
): Promise<void> {
  if (!runtime.automaticOpen) return;
  const store = runtime.storeFor(trigger.ctx, trigger.cwd)
    ?? runtime.ownerStoreFor?.(trigger.cwd, trigger.run_id, trigger.authority);
  if (!store) return;
  let selection: TrustedRecoverySelection;
  let snapshot: StageRecoverySnapshot;
  try {
    const identity = trigger.authority === "ordinary"
      ? currentRecoveryAssignments(trigger.cwd, trigger.run_id).find(candidate => candidate.dispatch_id === trigger.dispatch_id)
      : undefined;
    if (trigger.authority === "ordinary" && !identity) return;
    selection = store.selection(identity);
    snapshot = await store.read({
      run_id: trigger.run_id,
      authority: trigger.authority,
      selection,
      ...(identity ? { identity } : {}),
    });
  } catch {
    return;
  }
  if (!snapshot.identity || snapshot.identity.dispatch_id !== trigger.dispatch_id) return;
  if (trigger.kind === "preflight") {
    if (!snapshot.preflight || snapshot.preflight.dispatch_id !== trigger.dispatch_id) return;
  } else if (
    !snapshot.terminal
    || snapshot.terminal.dispatch_id !== trigger.dispatch_id
    || snapshot.terminal.outcome !== trigger.outcome
  ) {
    return;
  }
  const formatRepair = trigger.kind === "terminal"
    && trigger.outcome === "succeeded"
    && snapshot.error_context?.class === "format_validation";
  if (trigger.kind === "terminal" && trigger.outcome === "succeeded" && !formatRepair) return;
  if (formatRepair
    && runtime.host.capabilities.format_repair !== "supported"
    && runtime.host.capabilities.producer_correction !== "supported") return;
  const request: StageRecoveryRequest = {
    run_id: trigger.run_id,
    authority: trigger.authority,
    operation: "reconcile",
    operation_id: automaticRecoveryOperationId(trigger),
    intent: trigger.kind === "preflight" ? "retry" : formatRepair ? "repair_format" : "replace",
    identity: snapshot.identity,
    expected_revision: snapshot.revision,
    selection,
  };
  if (!runtime.automaticOpen) return;
  try {
    // Automatic recovery is deliberately grant-free. A persisted default
    // budget may authorize one bounded replacement; exhaustion returns a
    // typed wait result and leaves explicit workflow_recover as the only
    // authenticated UI-grant boundary.
    await recoverStageExecution({ request, store, host: runtime.host });
  } catch {
    // Canonical evidence is already durable. A failed automatic continuation
    // remains replayable through the stable operation id and must not alter
    // the task result or invent an outcome.
  }
}
async function scanAutomaticRecoveryForOwner(
  runtime: StageRecoveryRuntime,
  ctx: unknown,
  cwd: string,
  requestedIdentity?: WorkIdentity,
): Promise<void> {
  if (!runtime.automaticOpen) return;
  const store = runtime.storeFor(ctx, cwd);
  if (!store) return;
  let selection: TrustedRecoverySelection;
  let snapshot: StageRecoverySnapshot;
  try {
    selection = store.selection(requestedIdentity);
    snapshot = await store.read({ run_id: selection.run_id, authority: selection.authority, selection, ...(requestedIdentity ? { identity: requestedIdentity } : {}) });
    if (!requestedIdentity && selection.authority === "ordinary") {
      const identities = currentRecoveryAssignments(cwd, selection.run_id);
      if (identities.length > 0) {
        for (const identity of identities) await scanAutomaticRecoveryForOwner(runtime, ctx, cwd, identity);
        return;
      }
    }
  } catch {
    return;
  }
  if (!snapshot.identity) return;
  if (snapshot.preflight) {
    scheduleAutomaticRecovery(runtime, {
      kind: "preflight",
      run_id: selection.run_id,
      authority: selection.authority,
      cwd,
      ctx,
      dispatch_id: snapshot.identity.dispatch_id,
    });
    return;
  }
  const terminal = snapshot.terminal;
  if (
    terminal
    && (terminal.outcome !== "succeeded" || snapshot.error_context?.class === "format_validation")
  ) {
    scheduleAutomaticRecovery(runtime, {
      kind: "terminal",
      run_id: selection.run_id,
      authority: selection.authority,
      cwd,
      ctx,
      dispatch_id: terminal.dispatch_id,
      outcome: terminal.outcome,
    });
  }
}

function scheduleAutomaticRecoveryScan(
  runtime: StageRecoveryRuntime | undefined,
  ctx: unknown,
  cwd: string,
): void {
  if (!runtime || !runtime.automaticOpen) return;
  trackAutomaticPending(runtime, scanAutomaticRecoveryForOwner(runtime, ctx, cwd).catch(() => {}));
}


function trackAutomaticPending(runtime: StageRecoveryRuntime, pending: Promise<void>): void {
  runtime.automaticPending.add(pending);
  void pending.finally(() => runtime.automaticPending.delete(pending)).catch(() => {});
}

function scheduleAutomaticRecovery(
  runtime: StageRecoveryRuntime | undefined,
  trigger: AutomaticRecoveryTrigger,
): void {
  if (!runtime || !runtime.automaticOpen) return;
  const pending = (runtime.automaticContinuation ?? Promise.resolve())
    .then(() => executeAutomaticRecovery(runtime, trigger))
    .catch(() => {});
  runtime.automaticContinuation = pending;
  trackAutomaticPending(runtime, pending);
  void pending.finally(() => {
    if (runtime.automaticContinuation === pending) runtime.automaticContinuation = undefined;
  });
}
async function drainAutomaticRecovery(runtime: StageRecoveryRuntime | undefined): Promise<void> {
  if (!runtime || runtime.automaticPending.size === 0) return;
  await Promise.allSettled([...runtime.automaticPending]);
}

function canonicalRecoveryIdentity(
  runtime: StageRecoveryRuntime | undefined,
  ctx: unknown,
  cwd: string,
  authority: StageAuthority,
  runId: string,
): WorkIdentity | undefined {
  if (!runtime) return undefined;
  try {
    const store = runtime.storeFor(ctx, cwd);
    if (!store) return undefined;
    const read = store.read({ run_id: runId, authority });
    return read instanceof Promise ? undefined : read.identity;
  } catch {
    return undefined;
  }
}
export type WorkflowOwnerClaimResult =
  | { ok: true; claim: WorkflowOwnerClaim; idempotent: boolean }
  | { ok: false; code: "owner_invalid" | "owner_conflict"; error: string; claim?: WorkflowOwnerClaim };
function normalizedMixedTaskInput(input: unknown): { mixed: boolean; input: unknown } {
  if (!input || typeof input !== "object" || Array.isArray(input)) return { mixed: false, input };
  const value = input as Record<string, unknown>;
  if (!Array.isArray(value.tasks) || value.tasks.length !== 0 || typeof value.task !== "string" || typeof value.agent !== "string") {
    return { mixed: false, input };
  }
  const normalized = Object.fromEntries(Object.entries(value).filter(([key]) => key !== "tasks"));
  return { mixed: true, input: normalized };
}
function taskBatchMissingContext(input: unknown): boolean {
  if (!input || typeof input !== "object" || Array.isArray(input)) return false;
  const value = input as Record<string, unknown>;
  return Array.isArray(value.tasks)
    && value.tasks.length > 0
    && !Object.prototype.hasOwnProperty.call(value, "context");
}

export type WorkflowOwnerSource =
  | WorkflowOwnerIdentity
  | ((projectRoot: string) => WorkflowOwnerIdentity);

const workflowOwners = new Map<string, Map<WorkflowCapability, WorkflowOwnerClaim>>();

/**
 * Match the cwd identity used by config and mapping readers: an existing
 * project/worktree is keyed by its physical path, while a not-yet-created
 * root keeps its resolved lexical path until it exists.
 */
function canonicalProjectRoot(projectRoot: string): string {
  const resolved = resolve(projectRoot);
  return existsSync(resolved) ? realpathSync(resolved) : resolved;
}

/**
 * Config paths are derived from the canonical project root even when the
 * `.omp` directory or config file does not exist yet. This keeps owner
 * provenance stable across a symlink alias during eager registration.
 */
function canonicalConfigPath(configPath: string): string {
  const resolved = resolve(configPath);
  if (basename(resolved) !== "team.config.json" || basename(dirname(resolved)) !== ".omp") return resolved;
  return join(canonicalProjectRoot(dirname(dirname(resolved))), ".omp", "team.config.json");
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => [key, canonicalize(entry)]));
  }
  return value;
}

function ownerFingerprint(owner: WorkflowOwnerIdentity): string {
  return createHash("sha256").update(JSON.stringify(canonicalize(owner))).digest("hex");
}

function invalidOwner(root: string, owner: WorkflowOwnerIdentity): string | null {
  const required = [
    ["owner_id", owner.owner_id],
    ["bundle_id", owner.bundle_id],
    ["owner_kind", owner.owner_kind],
    ["activation_marker", owner.activation_marker],
    ["host_range", owner.host_range],
    ["provenance.package", owner.provenance?.package],
    ["provenance.entrypoint", owner.provenance?.entrypoint],
    ["provenance.cwd", owner.provenance?.cwd],
  ] as const;
  const missing = required.find(([, value]) => typeof value !== "string" || value.trim().length === 0);
  if (missing) return `${missing[0]} is required`;
  if (canonicalProjectRoot(owner.provenance.cwd) !== root) return "owner provenance cwd does not match project root";
  if (owner.provenance.config_path && canonicalConfigPath(owner.provenance.config_path) !== join(root, ".omp", "team.config.json")) {
    return "owner provenance config_path does not belong to project root";
  }
  return null;
}

function normalizeOwner(owner: WorkflowOwnerIdentity): WorkflowOwnerIdentity {
  const provenance: WorkflowOwnerProvenance = {
    ...owner.provenance,
    cwd: canonicalProjectRoot(owner.provenance.cwd),
  };
  if (owner.provenance.config_path) provenance.config_path = canonicalConfigPath(owner.provenance.config_path);
  return { ...owner, provenance };
}

/**
 * Atomically claim one or more generic workflow capabilities for a bundle.
 * The registry is keyed by the canonical physical project/worktree root.
 * A repeated claim with the same fingerprint is idempotent; any differing
 * owner fails before the registry is mutated.
 */
export function claimWorkflowOwners(
  projectRoot: string,
  capabilities: readonly WorkflowCapability[],
  owner: WorkflowOwnerIdentity,
): WorkflowOwnerClaimResult {
  const root = canonicalProjectRoot(projectRoot);
  const invalid = invalidOwner(root, owner);
  if (invalid) return { ok: false, code: "owner_invalid", error: invalid };
  const normalizedOwner = normalizeOwner(owner);
  const fingerprint = ownerFingerprint(normalizedOwner);
  const requested = [...new Set(capabilities)];
  const existing = workflowOwners.get(root);
  for (const capability of requested) {
    const prior = existing?.get(capability);
    if (prior && prior.fingerprint !== fingerprint) {
      return {
        ok: false,
        code: "owner_conflict",
        error: `generic workflow capability '${capability}' is already owned by '${prior.owner.owner_id}'`,
        claim: prior,
      };
    }
  }
  const registry = existing ?? new Map<WorkflowCapability, WorkflowOwnerClaim>();
  let idempotent = true;
  for (const capability of requested) {
    if (!registry.has(capability)) {
      idempotent = false;
      registry.set(capability, { project_root: root, capability, fingerprint, owner: structuredClone(normalizedOwner) });
    }
  }
  if (!existing) workflowOwners.set(root, registry);
  const first = requested[0];
  const claim = first ? registry.get(first) : undefined;
  if (!claim) return { ok: false, code: "owner_invalid", error: "at least one workflow capability is required" };
  return { ok: true, claim, idempotent };
}

export function claimWorkflowOwner(
  projectRoot: string,
  capability: WorkflowCapability,
  owner: WorkflowOwnerIdentity,
): WorkflowOwnerClaimResult {
  return claimWorkflowOwners(projectRoot, [capability], owner);
}

/** Read-only diagnostic used by host adapters and focused owner tests. */
export function workflowOwnerFor(projectRoot: string, capability: WorkflowCapability): WorkflowOwnerClaim | undefined {
  return workflowOwners.get(canonicalProjectRoot(projectRoot))?.get(capability);
}

/** Clear only the in-memory registry; intended for isolated host/test lifecycles. */
export function resetWorkflowOwners(projectRoot?: string): void {
  if (projectRoot === undefined) workflowOwners.clear();

  else workflowOwners.delete(canonicalProjectRoot(projectRoot));
}

export type TrustedToolCallActor = "orchestrator" | "worker" | "lead";

export type TrustedToolCallResolution =
  | { readonly actor: "orchestrator"; readonly artifactsDir: string }
  | { readonly actor: "worker" | "lead" }
  | { readonly kind: "authenticated-interactive-host-no-run" }
  | { readonly kind: "authenticated-host-idle-basic-tools" }
  | { readonly kind: "authenticated-interactive-host-cto"; readonly run_id: string; readonly ownership_epoch: string }
  | { readonly kind: "denied"; readonly code: TrustedToolCallDenialCode };
/**
 * Bundle-owned adapter seam for the current authenticated tool-call context.
 * The callback receives host context only; model/tool input is never passed.
 */
export type TrustedToolCallActorResolver = (
  ctx: unknown,
  cwd: string,
  runId: string | undefined,
) => TrustedToolCallResolution | undefined;

interface RegisterOptionsBase {
  label?: string;
  roles?: RoleConfig["roles"];
  rosterOverrides?: RoleConfig["roster_overrides"];
  scopeMap?: RoleConfig["scope_map"];
  flags?: RoleConfig["flags"];
  /** Caller-supplied scope → runtime classification table (no core defaults exist). */
  scopeRuntimeClasses?: ScopeRuntimeClassTable;
  /** Caller-supplied scope → UI marker table (no core defaults exist). */
  scopeUiClasses?: ScopeRuntimeClassTable;
  designSystem?: string | null;
  workflowProfiles?: Profile[];
  observability?: boolean;
  /** Explicit project/worktree root for eager owner/config registration. */
  cwd?: string;
  /** Session-aware cwd resolver; no process cwd fallback is used when supplied. */
  resolveCwd?: (ctx: unknown) => string | undefined;
  owner?: WorkflowOwnerSource;
  /**
   * Bounded write_scope experiment: when enabled, worker source writes are
   * narrowed to the declared scope after the orchestrator gate. Off by
   * default — shipped workflows keep the single-writer model.
   */
  writeScope?: WorkerWriteScope;
  /** Host-declared read-only workers receive only allowlisted AST Bash commands. */
  readOnlyBashAgents?: readonly string[];
}

type RegisterOptionsWithoutController = RegisterOptionsBase & {
  /** A controller requires the authenticated actor resolver below. */
  getSessionController?: never;
  resolveTrustedToolCallActor?: TrustedToolCallActorResolver;
};

type RegisterOptionsWithController = RegisterOptionsBase & {
  /** Shared session controller used by command/tool ingress and lifecycle gates. */
  getSessionController: (ctx: unknown, cwd: string) => WorkflowSessionController | undefined;
  /** Required whenever a shared session controller is registered. */
  resolveTrustedToolCallActor: TrustedToolCallActorResolver;
};

/**
 * Registering a controller without its bundle-owned actor resolver is unsafe:
 * the controller alone cannot authenticate raw host tool calls. The union
 * keeps legacy registrations (neither callback) and resolver-only no-run
 * registrations valid while rejecting the incomplete combination at compile
 * time.
 */
export type RegisterOptions = RegisterOptionsWithoutController | RegisterOptionsWithController;

export type CommandId = "do-work" | "team" | "cto" | "init-team" | "interview" | "omp-model-roles";

export interface WorkflowToolAdapterOptions {
  cwd?: string;
  resolveCwd?: (ctx: unknown) => string | undefined;
  owner?: WorkflowOwnerSource;
  /**
   * Legacy per-call main-session classifier, consulted only when no
   * session_start host profile was captured (older OMP runtimes and direct
   * tool harnesses). With a captured profile, session ownership is decided
   * authoritatively from the host mode: trusted interactive sessions
   * (terminal TUI or connected RPC client) own the workflow tools; print,
   * json and Task subagent sessions never do. Per-call tool contexts
   * cannot make this decision — plain-rpc main sessions deliberately
   * report hasUI=false on them.
   */
  isMainSession?: (ctx: unknown) => boolean;
  /**
   * Optional trusted live agent-mapping handoff, invoked fresh for EVERY
   * agent-resolving transition (each workflow_begin and each
   * workflow_advance) with that transition's exact current cwd — never a
   * cached mapping from another transition or project. When the callback
   * resolves with a well-formed `AgentMappingState`, the transition consumes
   * it in memory for role availability and the persisted workspace mapping
   * file is never consulted. Only an explicit `undefined` keeps the
   * persisted mapping fallback; runtime null or any other malformed value
   * fails the transition closed. Discovery failures must throw so the
   * transition fails closed.
   */
  beforeBegin?: (cwd: string) => void | AgentMappingState | undefined | Promise<void | AgentMappingState | undefined>;
  mappingSummary?: (cwd: string) => unknown;
  /**
   * Engine-owned host binding resolver. Bundles normally omit this: the
   * registration bridge installed by registerTeamWorkflow supplies the
   * native authority resolver for assigned producer submission.
   */
  resolveStageHostBinding?: StageHostBindingResolver;
  /** Optional truthful host lifecycle/recovery adapter for supported capabilities. */
  stageRecoveryHost?: StageRecoveryHost;
  /** Reuse the exact bundle-owned controller shared with command ingress and hooks. */
  getSessionController?: (ctx: unknown, cwd: string) => WorkflowSessionController | undefined;
}

export interface WorkflowToolAdapter {
  readonly capabilities: readonly ["workflow_tools"];
  register(pi: ExtensionAPI): void;
}

// ── Generic model-role contracts (bundle taxonomy is intentionally absent) ──
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
function resolveCwdFromContext(ctx: unknown): string | undefined {
  if (!ctx || typeof ctx !== "object") return undefined;
  const value = ctx as { cwd?: unknown; sessionManager?: unknown };
  const manager = value.sessionManager;
  if (manager && typeof manager === "object" && "getCwd" in manager && typeof manager.getCwd === "function") {
    try {
      const cwd = manager.getCwd();
      if (typeof cwd === "string" && cwd.length > 0) return cwd;
    } catch {
      // Fall through to the context cwd.
    }
  }
  return typeof value.cwd === "string" && value.cwd.length > 0 ? value.cwd : undefined;
}

function isTrustedToolCallDenialCode(value: unknown): value is TrustedToolCallDenialCode {
  switch (value) {
    case "invalid_host_context":
    case "untrusted_actor_context":
    case "host_session_not_captured":
    case "headless_host_session":
    case "session_identity_mismatch":
    case "worktree_mismatch":
    case "host_profile_mismatch":
    case "session_controller_unavailable":
    case "controller_context_mismatch":
    case "selected_run_mismatch":
    case "execution_claim_mismatch":
    case "artifacts_scope_mismatch":
    case "controller_resolution_failed":
      return true;
    default:
      return false;
  }
}

function isTrustedToolCallResolution(value: unknown): value is TrustedToolCallResolution {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if ("actor" in record && "kind" in record) return false;
  if (record.actor === "worker" || record.actor === "lead") return true;
  if (record.actor === "orchestrator") return typeof record.artifactsDir === "string" && record.artifactsDir.length > 0;
  if (record.kind === "authenticated-interactive-host-no-run") return true;
  if (record.kind === "authenticated-host-idle-basic-tools") {
    for (const key in record) {
      if (!Object.prototype.hasOwnProperty.call(record, key)) continue;
      if (key !== "kind") return false;
    }
    return Object.prototype.hasOwnProperty.call(record, "kind");
  }
  if (record.kind === "authenticated-interactive-host-cto") {
    return typeof record.run_id === "string"
      && record.run_id.length > 0
      && typeof record.ownership_epoch === "string"
      && record.ownership_epoch.length > 0;
  }
  return record.kind === "denied" && isTrustedToolCallDenialCode(record.code);
}

function safeRegistrationLabel(value: unknown): string {
  if (typeof value !== "string") return "omp-workflows";
  const normalized = value.replace(/[^A-Za-z0-9._:@/-]/g, "_").slice(0, 80);
  return normalized || "omp-workflows";
}

function sessionIdFromContext(ctx: unknown): string | undefined {
  if (!ctx || typeof ctx !== "object") return undefined;
  const value = ctx as { session_id?: unknown; sessionId?: unknown; sessionManager?: unknown };
  const manager = value.sessionManager;
  if (manager && typeof manager === "object") {
    if (!("getSessionId" in manager) || typeof manager.getSessionId !== "function") return undefined;
    try {
      const id = manager.getSessionId();
      return typeof id === "string" && id.length > 0 ? id : undefined;
    } catch {
      return undefined;
    }
  }
  if (typeof value.session_id === "string" && value.session_id.length > 0) return value.session_id;
  return typeof value.sessionId === "string" && value.sessionId.length > 0 ? value.sessionId : undefined;
}
function sessionFileFromContext(ctx: unknown): string | undefined {
  if (!ctx || typeof ctx !== "object" || Array.isArray(ctx)) return undefined;
  const value = ctx as { sessionFile?: unknown; session_file?: unknown; sessionManager?: unknown };
  const explicit = typeof value.sessionFile === "string" && value.sessionFile.length > 0
    ? value.sessionFile
    : typeof value.session_file === "string" && value.session_file.length > 0
      ? value.session_file
      : undefined;
  const manager = value.sessionManager;
  if (manager && typeof manager === "object") {
    if (!("getSessionFile" in manager) || typeof manager.getSessionFile !== "function") return undefined;
    try {
      const file = manager.getSessionFile();
      if (typeof file !== "string" || file.length === 0 || (explicit !== undefined && explicit !== file)) return undefined;
      return file;
    } catch {
      return undefined;
    }
  }
  return explicit;
}
type NativeAcceptedReplayLineage = {
  readonly session_id: string;
  readonly session_file: string;
  readonly parent_session_file: string;
};
function nativeAcceptedReplayLineage(ctx: unknown, cwd: string): NativeAcceptedReplayLineage | undefined {
  if (!ctx || typeof ctx !== "object" || Array.isArray(ctx)) return undefined;
  const manager = (ctx as { sessionManager?: unknown }).sessionManager;
  if (!manager || typeof manager !== "object") return undefined;
  const candidate = manager as { getCwd?: () => unknown; getHeader?: () => unknown };
  if (typeof candidate.getCwd !== "function" || typeof candidate.getHeader !== "function") return undefined;
  const sessionId = sessionIdFromContext(ctx);
  const sessionFile = sessionFileFromContext(ctx);
  if (!sessionId || !sessionFile || !isAbsolute(sessionFile)) return undefined;
  let managerCwd: unknown;
  let header: unknown;
  try {
    managerCwd = candidate.getCwd();
    header = candidate.getHeader();
  } catch {
    return undefined;
  }
  if (typeof managerCwd !== "string" || resolve(managerCwd) !== resolve(cwd)) return undefined;
  if (!header || typeof header !== "object" || Array.isArray(header)) return undefined;
  const headerRecord = header as Record<string, unknown>;
  if (headerRecord.id !== sessionId || typeof headerRecord.cwd !== "string" || resolve(headerRecord.cwd) !== resolve(cwd)) return undefined;
  const parentSession = headerRecord.parentSession;
  if (typeof parentSession !== "string" || !isAbsolute(parentSession)) return undefined;
  return { session_id: sessionId, session_file: sessionFile, parent_session_file: parentSession };
}
function sessionSwitchActorIsAdmissible(event: unknown, ctx: unknown): boolean {
  for (const value of [event, ctx]) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    if (!Object.prototype.hasOwnProperty.call(value, "actor")) continue;
    const actor = (value as Record<string, unknown>).actor;
    if (actor !== undefined && actor !== "host" && actor !== "main" && actor !== "orchestrator") return false;
  }
  return true;
}

type LifecycleEventType = "session_start" | "session_switch" | "session_shutdown";

/**
 * Host lifecycle events carry routing metadata, never a replacement identity.
 * When a host includes optional identity fields, every supplied alias must
 * agree with the callback context; otherwise the event is malformed and must
 * not release or revoke any local authority.
 */
function lifecycleEventIdentityIsAdmissible(event: unknown, ctx: unknown, expectedType: LifecycleEventType): boolean {
  if (!event || typeof event !== "object" || Array.isArray(event)) return false;
  const eventValue = event as Record<string, unknown>;
  const hasType = Object.prototype.hasOwnProperty.call(eventValue, "type");
  if (
    expectedType === "session_start"
      ? hasType && eventValue.type !== expectedType
      : eventValue.type !== expectedType
  ) return false;
  const eventPart = lifecycleIdentityPart(event);
  const contextPart = lifecycleIdentityPart(ctx);
  if (!eventPart.valid || !contextPart.valid) return false;
  const eventIdentity = eventPart.identity;
  const contextIdentity = contextPart.identity;
  if (!contextIdentity?.session_id || !contextIdentity.cwd) return false;
  if (eventIdentity?.session_id && eventIdentity.session_id !== contextIdentity.session_id) return false;
  if (eventIdentity?.cwd && !sameLifecyclePath(eventIdentity.cwd, contextIdentity.cwd)) return false;
  if (eventIdentity?.session_manager && eventIdentity.session_manager !== contextIdentity.session_manager) return false;
  if (eventIdentity?.session_file && (!contextIdentity.session_file || !sameLifecyclePath(eventIdentity.session_file, contextIdentity.session_file))) return false;
  return true;
}


function ownerAtCwd(source: WorkflowOwnerSource, cwd: string): WorkflowOwnerIdentity {
  return typeof source === "function" ? source(canonicalProjectRoot(cwd)) : source;
}

function assertOwner(
  cwd: string,
  capabilities: readonly WorkflowCapability[],
  source: WorkflowOwnerSource | undefined,
): void {
  if (!source) return;
  const result = claimWorkflowOwners(cwd, capabilities, ownerAtCwd(source, cwd));
  if (!result.ok) throw new Error(`${result.code}: ${result.error}`);
}

/**
 * Write caller-supplied runtime configuration against an explicit session
 * cwd. Core never substitutes a fullstack preset and never falls back to the
 * process cwd when this seam is invoked without a known session root.
 */
export function writeRuntimeConfig(opts: RegisterOptions, cwd = opts.cwd): string | null {
  const hasOverride = Boolean(
    opts.roles
    || opts.scopeMap
    || opts.flags
    || opts.rosterOverrides
    || opts.scopeRuntimeClasses
    || opts.scopeUiClasses
    || opts.designSystem !== undefined,
  );
  if (!hasOverride || !cwd) return null;
  assertOwner(cwd, ["config_writer"], opts.owner);
  const path = resolveRuntimeConfigPath(cwd);
  if (!path) return null;
  // Seed-if-absent only. The session seed must never overwrite an existing
  // config: users and /init-team own the file content after the first
  // creation, and a per-session preset merge would silently revert every
  // customization (roles, scope_map) on each omp restart.
  if (existsSync(path)) return path;
  writeConfig(path, {
    roles: opts.roles ?? {},
    roster_overrides: opts.rosterOverrides ?? {},
    scope_map: opts.scopeMap ?? [],
    flags: opts.flags ?? {},
    scope_runtime_classes: opts.scopeRuntimeClasses ?? {},
    scope_ui_classes: opts.scopeUiClasses ?? {},
    design_system: opts.designSystem ?? null,
  });
  return path;
}

/**
 * Wire the generic engine into OMP. Domain bundles provide role/scope/flag
 * presets and an owner identity; core only registers reusable gates and
 * caller-supplied runtime data.
 */
function taskMarkers(input: unknown): DispatchMarker[] | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  const record = input as Record<string, unknown>;
  const values = Array.isArray(record.tasks) ? record.tasks : [record];
  const markers = values.map((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const task = (value as Record<string, unknown>).task;
    return typeof task === "string" ? parseDispatchMarker(task) : null;
  });
  return markers.length > 0 && markers.every((marker): marker is DispatchMarker => marker !== null) ? markers : undefined;
}

type NativeTaskResult = { index?: unknown; exitCode?: unknown; output?: unknown; stderr?: unknown; error?: unknown; aborted?: unknown };
type TaskOutcomeBatch = {
  mapped: Array<{ origin: DispatchOrigin; outcome: "succeeded" | "failed"; evidence: string }>;
  unresolved: DispatchOrigin[];
};

/**
 * Migration dispatch records are persisted audit evidence, not native
 * completion authority. Hooks receive untyped `details`, and a provider may
 * echo a projection either as a record/envelope or as JSON text content, so
 * reject the migration provenance before marker/origin fallback can turn it
 * into a live result.
 */
function nativeRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function migrationIdentity(value: unknown): boolean {
  if (!nativeRecord(value)) return false;
  return value.source === "migration"
    && typeof value.migration_id === "string"
    && typeof value.run_id === "string"
    && typeof value.stage_id === "string"
    && typeof value.capability_id === "string"
    && typeof value.slot_id === "string"
    && typeof value.task_id === "string"
    && typeof value.dispatch_id === "string"
    && value.attempt === 0;
}

function migrationIdentityMarker(value: unknown): boolean {
  if (!nativeRecord(value)) return false;
  return value.source === "migration";
}

function migrationEnvelopeMarker(value: unknown): boolean {
  if (!nativeRecord(value)) return false;
  return value.source === "migration"
    || value.completed_by === "migration"
    || value.terminal_signal === "migration_verified"
    || migrationIdentityMarker(value.identity);
}

function migrationCompletionMarker(value: unknown): boolean {
  if (!nativeRecord(value)) return false;
  return value.source === "migration"
    || value.completed_by === "migration"
    || value.terminal_signal === "migration_verified"
    || migrationIdentityMarker(value.work_identity);
}

function migrationDispatchRecordMarker(value: unknown): boolean {
  if (!nativeRecord(value)) return false;
  return value.source === "migration"
    || migrationCompletionMarker(value.completion)
    || migrationEnvelopeMarker(value.completion_envelope)
    || migrationIdentityMarker(value.work_identity);
}

/**
 * Inspect only protocol-shaped completion carriers. Worker output and
 * artifact payloads are deliberately opaque; a migration-looking data field
 * does not become a rejection unless it occupies an identity/completion
 * position in the native result envelope.
 */
function nativeMigrationCarrier(value: unknown): boolean {
  if (migrationIdentity(value)) return true;
  if (!nativeRecord(value)) return false;
  if (
    value.completed_by === "migration"
    || value.terminal_signal === "migration_verified"
    || migrationIdentityMarker(value.identity)
    || migrationIdentityMarker(value.work_identity)
  ) return true;
  if (migrationEnvelopeMarker(value.completion_envelope) || migrationCompletionMarker(value.completion)) return true;
  if (migrationDispatchRecordMarker(value.dispatch_record) || migrationDispatchRecordMarker(value.record)) return true;
  if (Array.isArray(value.results)) return value.results.some((row) => nativeMigrationCarrier(row));
  return false;
}

function nativeMigrationIngress(value: unknown): boolean {
  if (nativeMigrationCarrier(value)) return true;
  if (typeof value === "string") {
    const text = value.trim();
    if (!text.startsWith("{") && !text.startsWith("[")) return false;
    try {
      return nativeMigrationIngress(JSON.parse(text));
    } catch {
      return false;
    }
  }
  if (!Array.isArray(value)) return false;
  return value.some((part) => {
    if (nativeMigrationCarrier(part)) return true;
    if (!nativeRecord(part) || part.type !== "text" || typeof part.text !== "string") return false;
    return nativeMigrationIngress(part.text);
  });
}

function taskOutcomeRows(
  input: unknown,
  details: unknown,
  fallbackEvidence: string,
  origins: DispatchOrigin[],
): TaskOutcomeBatch | undefined {
  const markers = taskMarkers(input);
  if (!markers || markers.length !== origins.length) return undefined;
  const detailsRecord = details && typeof details === "object" && !Array.isArray(details) ? details as Record<string, unknown> : undefined;
  const rows = Array.isArray(detailsRecord?.results) ? detailsRecord.results as NativeTaskResult[] : [];
  const byIndex = new Map<number, NativeTaskResult>();
  for (const row of rows) {
    if (!row || typeof row !== "object" || Array.isArray(row)
      || !Number.isInteger(row.index) || (row.index as number) < 0 || (row.index as number) >= markers.length || byIndex.has(row.index as number)) return undefined;
    byIndex.set(row.index as number, row);
  }
  const originByIndex: DispatchOrigin[] = [];
  const used = new Set<string>();
  for (let index = 0; index < markers.length; index += 1) {
    const marker = markers[index]!;
    const matching = origins.filter((origin) =>
      origin.stage_id === marker.stage
      && origin.cursor_epoch === marker.cursor
      && (!marker.capability_id || origin.capability_id === marker.capability_id)
      && (!marker.slot_id || origin.slot_id === marker.slot_id)
      && (!marker.task_id || origin.task_id === marker.task_id),
    ).filter((origin) => !used.has(origin.dispatch_id));
    const positional = !marker.slot_id && !marker.task_id ? origins[index] : undefined;
    const origin = matching.length === 1 ? matching[0] : matching.length === 0 ? positional : undefined;
    if (!origin || used.has(origin.dispatch_id)) return undefined;
    used.add(origin.dispatch_id);
    originByIndex.push(origin);
  }
  if (used.size !== origins.length) return undefined;
  const mapped: TaskOutcomeBatch["mapped"] = [];
  const unresolved: DispatchOrigin[] = [];
  for (let index = 0; index < originByIndex.length; index += 1) {
    const row = byIndex.get(index);
    const origin = originByIndex[index]!;
    if (!row) {
      unresolved.push(origin);
      continue;
    }
    const failed = row.exitCode !== 0
      || row.aborted === true
      || (typeof row.error === "string" && row.error.length > 0);
    const rowEvidence = [row.error, row.stderr, row.output]
      .find((value): value is string => typeof value === "string" && value.trim().length > 0);
    mapped.push({
      origin,
      outcome: failed ? "failed" : "succeeded",
      evidence: rowEvidence?.trim() ?? (fallbackEvidence || (failed ? "task failed" : "task completed")),
    });
  }
  return { mapped, unresolved };
}

type TaskMarkerFilter = { runId: string; capabilityId?: string; stageId: string; cursorEpoch: string };

type PersistedDispatchOriginRecord = {
  id: string;
  tool_call_id?: string;
  origin_session_id?: string;
  work_identity?: {
    run_id?: string;
    capability_id?: string;
    stage_id?: string;
    capability_epoch?: string;
    slot_id?: string;
    task_id?: string;
  };
};

function taskMarkerFilter(input: unknown): TaskMarkerFilter | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  const markers = taskMarkers(input);
  if (!markers) return undefined;
  const first = markers[0]!;
  if (markers.some((marker) => marker!.run !== first.run
    || marker!.stage !== first.stage
    || marker!.cursor !== first.cursor
    || marker!.kind !== first.kind
    || (marker!.capability_id ?? "") !== (first.capability_id ?? "")
    || JSON.stringify([...marker!.roles].sort()) !== JSON.stringify([...first.roles].sort()))) return undefined;
  return { runId: first.run, ...(first.capability_id ? { capabilityId: first.capability_id } : {}), stageId: first.stage, cursorEpoch: first.cursor };
}

function persistedDispatchOrigin(cwd: string, runId: string, dispatch: PersistedDispatchOriginRecord): DispatchOrigin | undefined {
  const identity = dispatch.work_identity;
  if (identity?.run_id !== undefined && identity.run_id !== runId) return undefined;
  return {
    cwd: resolve(cwd),
    run_id: runId,
    dispatch_id: dispatch.id,
    ...(dispatch.origin_session_id ? { origin_session_id: dispatch.origin_session_id } : {}),
    ...(identity ? {
      capability_id: identity.capability_id,
      stage_id: identity.stage_id,
      cursor_epoch: identity.capability_epoch,
      slot_id: identity.slot_id,
      task_id: identity.task_id,
    } : {}),
  };
}

/**
 * Rebuild a task origin only after the host-owned locator discovers a
 * candidate workspace. The locator is discovery metadata, never authority:
 * canonical state is re-read there and every dispatch/marker binding is
 * checked before any result can mutate state. No current selection, callback
 * session, or callback cwd is consulted.
 */
function durableTaskOrigins(toolCallId: string, markerFilter: TaskMarkerFilter): DispatchOrigin[] {
  const discovered = readDispatchOriginLocator(toolCallId).filter((entry) => entry.run_id === markerFilter.runId);
  if (discovered.length === 0) return [];
  const workspaces = new Set(discovered.map((entry) => `${entry.cwd}\u0000${entry.run_id}`));
  if (workspaces.size !== 1) return [];
  const cwd = discovered[0]!.cwd;
  const state = readRunState(cwd, markerFilter.runId);
  if (!state || state.schema !== 2 || state.run_id !== markerFilter.runId || state.run_key !== markerFilter.runId) return [];
  const origins: DispatchOrigin[] = [];
  const discoveredIds = new Set(discovered.map((entry) => entry.dispatch_id));
  for (const dispatch of state.dispatch_capability?.dispatches ?? []) {
    if (!discoveredIds.has(dispatch.id) || dispatch.tool_call_id !== toolCallId) continue;
    const entries = discovered.filter((entry) => entry.dispatch_id === dispatch.id);
    if (entries.length !== 1) return [];
    const located = entries[0]!;
    if (located.origin_session_id !== undefined && located.origin_session_id !== dispatch.origin_session_id) return [];
    const origin = persistedDispatchOrigin(cwd, markerFilter.runId, dispatch);
    if (!origin
      || origin.stage_id !== markerFilter.stageId
      || origin.cursor_epoch !== markerFilter.cursorEpoch
      || (markerFilter.capabilityId !== undefined && origin.capability_id !== markerFilter.capabilityId)
      || (located.capability_id !== undefined && located.capability_id !== origin.capability_id)
      || (located.stage_id !== undefined && located.stage_id !== origin.stage_id)
      || (located.cursor_epoch !== undefined && located.cursor_epoch !== origin.cursor_epoch)
      || (located.slot_id !== undefined && located.slot_id !== origin.slot_id)
      || (located.task_id !== undefined && located.task_id !== origin.task_id)) continue;
    origins.push(origin);
  }
  if (origins.length === 0 || new Set(origins.map((origin) => origin.dispatch_id)).size !== discoveredIds.size) return [];
  for (const origin of origins) rememberDispatchOrigin(toolCallId, origin);
  return origins;
}

function taskOriginsForResult(toolCallId: string, markerFilter: TaskMarkerFilter | undefined): DispatchOrigin[] {
  if (!markerFilter) return [];
  const known = knownDispatchOrigins(toolCallId, markerFilter);
  return known.length > 0 ? known : durableTaskOrigins(toolCallId, markerFilter);
}
function ctoReservationWorkerIds(toolCallId: string | undefined, input: unknown, ownershipEpoch: string | undefined): string[] {
  if (!toolCallId || !ownershipEpoch) return [];
  if (input && typeof input === "object" && !Array.isArray(input)) {
    const value = input as Record<string, unknown>;
    if (Array.isArray(value.tasks)) {
      return value.tasks.length > 0
        ? value.tasks.map((_item, index) => `cto:${ownershipEpoch}:${toolCallId}:${index}`)
        : [];
    }
    if (typeof value.task === "string") return [`cto:${ownershipEpoch}:${toolCallId}:0`];
  }
  return [];
}

function ctoMarkerRunIds(input: unknown): string[] {
  if (!input || typeof input !== "object" || Array.isArray(input)) return [];
  const value = input as Record<string, unknown>;
  const ids: string[] = [];
  const singleTask = typeof value.task === "string" ? value.task : undefined;
  const tasks = Array.isArray(value.tasks) ? value.tasks : [];
  if (singleTask) {
    const marker = parseCtoSliceMarker(singleTask);
    if (marker) ids.push(marker.runId);
  }
  for (const item of tasks) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const task = (item as Record<string, unknown>).task;
    const marker = parseCtoSliceMarker(typeof task === "string" ? task : "");
    if (marker) ids.push(marker.runId);
  }
  return ids;
}
function trustedLegacyCtoOwnerForRun(
  cwd: string,
  runId: string,
  context: TrustedExecutionContext | undefined,
  rawContext: unknown,
): boolean {
  const interactive = trustedInteractiveHostProfileFromContext(rawContext);
  if (
    !/^[A-Za-z0-9._-]+$/.test(runId)
    || runId === "."
    || runId === ".."
    || !context
    || !interactive
    || context.caller !== "host"
    || context.authority !== "coordinator"
    || context.session_id !== interactive.session_id
  ) return false;
  try {
    if (resolve(context.worktree) !== resolve(cwd) || resolve(interactive.cwd ?? "") !== resolve(cwd)) return false;
    const control = readRunControlNoRecovery(cwd);
    if (control.execution_claim !== null || Object.prototype.hasOwnProperty.call(control.cto_releases, runId)) return false;
    const state = readCtoState(runId, cwd);
    return !!state
      && state.id === runId
      && !isCtoRunTerminal(state)
      && state.branch === context.branch
      && state.owner_session === context.session_id;
  } catch {
    // A malformed/unsupported cto_releases entry or path fails closed:
    // legacy bootstrap must never treat unreadable state as absent.
    return false;
  }
}

function trustedLegacyCtoRunId(
  cwd: string,
  input: unknown,
  context: TrustedExecutionContext | undefined,
  activeCtoScope: CtoClaimScope | undefined,
  rawContext: unknown,
): string | undefined {
  if (activeCtoScope) return undefined;
  const ids = ctoMarkerRunIds(input);
  if (ids.length === 0 || ids.some((id) => id !== ids[0])) return undefined;
  return trustedLegacyCtoOwnerForRun(cwd, ids[0]!, context, rawContext) ? ids[0] : undefined;
}

type CtoToolResultAsyncStatus = "sync" | "active" | "terminal" | "unknown";

function ctoToolResultAsyncStatus(details: unknown): CtoToolResultAsyncStatus {
  if (!nativeRecord(details) || !Object.prototype.hasOwnProperty.call(details, "async")) return "sync";
  const asyncDetails = details.async;
  if (!nativeRecord(asyncDetails)
    || asyncDetails.type !== "task"
    || typeof asyncDetails.jobId !== "string"
    || asyncDetails.jobId.length === 0
  ) return "unknown";
  if (asyncDetails.state === "running") return "active";
  if (asyncDetails.state === "completed" || asyncDetails.state === "failed") return "terminal";
  return "unknown";
}

function ctoSingleResultIsTerminal(row: unknown, expectedIndex: number): boolean {
  if (!nativeRecord(row)) return false;
  const has = (key: string): boolean => Object.prototype.hasOwnProperty.call(row, key);
  if (
    !has("index")
    || !has("id")
    || !has("agent")
    || !has("agentSource")
    || !has("task")
    || !has("exitCode")
    || !has("output")
    || !has("stderr")
    || !has("truncated")
    || !has("durationMs")
    || !has("tokens")
    || !has("requests")
  ) return false;
  const source = row.agentSource;
  return row.index === expectedIndex
    && Number.isInteger(row.index)
    && typeof row.id === "string"
    && row.id.length > 0
    && typeof row.agent === "string"
    && row.agent.length > 0
    && (source === "bundled" || source === "user" || source === "project")
    && typeof row.task === "string"
    && row.task.length > 0
    && typeof row.exitCode === "number"
    && Number.isFinite(row.exitCode)
    && Number.isInteger(row.exitCode)
    && typeof row.output === "string"
    && typeof row.stderr === "string"
    && typeof row.truncated === "boolean"
    && typeof row.durationMs === "number"
    && Number.isFinite(row.durationMs)
    && row.durationMs >= 0
    && typeof row.tokens === "number"
    && Number.isFinite(row.tokens)
    && row.tokens >= 0
    && typeof row.requests === "number"
    && Number.isFinite(row.requests)
    && row.requests >= 0;
}

function ctoResultHasTerminalSlots(details: unknown, expectedIndexes: readonly number[], isError = false): boolean {
  if (isError || expectedIndexes.length === 0 || new Set(expectedIndexes).size !== expectedIndexes.length) return false;
  if (!nativeRecord(details)) return false;
  const asyncStatus = ctoToolResultAsyncStatus(details);
  if (asyncStatus === "active" || asyncStatus === "unknown") return false;
  const rows = details.results;
  if (!Array.isArray(rows) || rows.length !== expectedIndexes.length) return false;
  const expected = new Set(expectedIndexes);
  const indexes = new Set<number>();
  for (const row of rows) {
    if (!nativeRecord(row)) return false;
    const rowIndex = row.index;
    if (typeof rowIndex !== "number" || !Number.isInteger(rowIndex) || !expected.has(rowIndex) || indexes.has(rowIndex)) return false;
    if (!ctoSingleResultIsTerminal(row, rowIndex)) return false;
    indexes.add(rowIndex);
  }
  return indexes.size === expected.size;
}

function ctoExpectedTaskCount(input: unknown): number {
  if (!input || typeof input !== "object" || Array.isArray(input)) return 0;
  const value = input as Record<string, unknown>;
  if (Array.isArray(value.tasks)) return value.tasks.length;
  return typeof value.task === "string" ? 1 : 0;
}

function ctoInputsMatch(left: unknown, right: unknown): boolean {
  try {
    const leftJson = JSON.stringify(canonicalize(left));
    const rightJson = JSON.stringify(canonicalize(right));
    return leftJson !== undefined && leftJson === rightJson;
  } catch {
    return false;
  }
}
function ctoSnapshotInput(value: unknown): unknown | undefined {
  try {
    const snapshot = canonicalize(value);
    return snapshot === undefined ? undefined : snapshot;
  } catch {
    return undefined;
  }
}


/**
 * The host's dynamic preflight/eval failures use the same exact empty result
 * image as shape validation. The original input disambiguates the flat and
 * batch wire forms; every reported batch line must name a captured item.
 */
function ctoPinnedTaskPreflightError(input: unknown, content: string): boolean {
  const text = content.trim();
  const flatPrefix = "Task execution failed: ";
  if (text.startsWith(flatPrefix) && text.slice(flatPrefix.length).trim().length > 0) {
    if (!input || typeof input !== "object" || Array.isArray(input)) return false;
    const value = input as Record<string, unknown>;
    return !Array.isArray(value.tasks);
  }
  if (!input || typeof input !== "object" || Array.isArray(input)) return false;
  const tasks = (input as Record<string, unknown>).tasks;
  if (!Array.isArray(tasks) || tasks.length === 0) return false;
  const expected = new Set<string>();
  for (let index = 0; index < tasks.length; index += 1) {
    const item = tasks[index];
    const itemRecord = item && typeof item === "object" && !Array.isArray(item)
      ? item as Record<string, unknown>
      : undefined;
    const name = typeof itemRecord?.name === "string" && itemRecord.name.trim().length > 0
      ? itemRecord.name.trim()
      : `#${index + 1}`;
    expected.add(name);
  }
  const lines = text.split("\n");
  if (lines.length === 0) return false;
  const seen = new Set<string>();
  for (const line of lines) {
    const match = /^Task (.+) failed preflight: (.+)$/.exec(line);
    if (!match || match[2]!.trim().length === 0 || !expected.has(match[1]!) || seen.has(match[1]!)) return false;
    seen.add(match[1]!);
  }
  return seen.size > 0;
}

function ctoAllScheduleRefusal(content: string): boolean {
  const text = content.trim();
  const match = /^Failed to start background task jobs?:\s+(.+)$/.exec(text);
  return match !== null && match[1]!.trim().length > 0;
}

function ctoEmptyRefusalDetails(details: unknown): boolean {
  if (!details || typeof details !== "object" || Array.isArray(details)) return false;
  const value = details as Record<string, unknown>;
  const keys = Object.keys(value).sort();
  return keys.length === 3
    && keys[0] === "projectAgentsDir"
    && keys[1] === "results"
    && keys[2] === "totalDurationMs"
    && value.projectAgentsDir === null
    && Array.isArray(value.results)
    && value.results.length === 0
    && value.totalDurationMs === 0;
}
function ctoPinnedTaskValidationError(input: unknown, content: string): boolean {
  if (!input || typeof input !== "object" || Array.isArray(input)) return false;
  const value = input as Record<string, unknown>;
  if (Object.prototype.hasOwnProperty.call(value, "schema") && content === "The task tool uses `outputSchema`; rename the stale `schema` field.") return true;
  const disallowed = (["tasks", "context"] as const).filter((field) => value[field] !== undefined);
  if (disallowed.length > 0) {
    const expected = `task.batch is disabled, so the task tool does not accept ${disallowed.map((field) => `\`${field}\``).join(" or ")}. Spawn one agent per call with \`task\`, or enable the task.batch setting.`;
    if (content === expected) return true;
  }

  const tasks = value.tasks;
  const hasTask = typeof value.task === "string" && value.task.trim() !== "";
  if (Array.isArray(tasks) && tasks.length > 0) {
    if (hasTask && content === "Top-level `task` is not part of the batch shape. Put the work in `tasks[]` items.") return true;
    for (let index = 0; index < tasks.length; index += 1) {
      const item = tasks[index];
      const itemRecord = item && typeof item === "object" && !Array.isArray(item)
        ? item as Record<string, unknown>
        : undefined;
      const rawName = itemRecord?.name;
      const name = rawName ? ` (\`${String(rawName)}\`)` : "";
      if (!itemRecord || typeof itemRecord.task !== "string" || itemRecord.task.trim() === "") {
        const expected = `Task ${index + 1}${name} is missing \`task\`. Every task needs complete, self-contained instructions.`;
        if (content === expected) return true;
        continue;
      }
      const effort = itemRecord.effort;
      if (effort !== undefined && effort !== "lo" && effort !== "med" && effort !== "hi") {
        const expected = `Task ${index + 1}${name} has an invalid \`effort\` value ${JSON.stringify(effort)}. Use "lo", "med", or "hi".`;
        if (content === expected) return true;
      }
    }
    const seen = new Map<string, string>();
    for (const item of tasks) {
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      const rawName = (item as Record<string, unknown>).name;
      if (typeof rawName !== "string") continue;
      const name = rawName.trim();
      if (!name) continue;
      const key = name.toLowerCase();
      const existing = seen.get(key);
      if (existing !== undefined) {
        const expected = `Duplicate task name ${existing === name ? `\`${name}\`` : `\`${existing}\` / \`${name}\``}. Provided names must be unique within a call (case-insensitive).`;
        if (content === expected) return true;
      }
      seen.set(key, name);
    }
    if (
      (typeof value.context !== "string" || value.context.trim() === "")
      && content === "Missing `context`. Provide the shared background for this batch — goal, constraints, and any contract the tasks share."
    ) return true;
  } else if (
    Object.prototype.hasOwnProperty.call(value, "tasks")
    && content === "Missing `tasks`. Provide at least one task item ({ name?, agent?, task })."
  ) {
    return true;
  } else if (!hasTask) {
    if (content === "Missing `tasks`. Provide a `tasks` array (one subagent per item) with a shared `context.") return true;
    if (content === "Missing `task`. Provide complete, self-contained instructions for the agent.") return true;
  } else {
    const effort = value.effort;
    if (effort !== undefined && effort !== "lo" && effort !== "med" && effort !== "hi") {
      return content === `The call has an invalid \`effort\` value ${JSON.stringify(effort)}. Use "lo", "med", or "hi".`;
    }
  }
  return false;
}

/**
 * Return only slots for which the pinned Task host response proves that no
 * child lifecycle started. The exact empty-details image is paired with the
 * original input and one of the host's exact shape/preflight/schedule
 * messages; generic errors, empty results, and async acknowledgements remain
 * pending.
 */
function ctoPreSpawnRefusalIndexes(
  input: unknown,
  details: unknown,
  content: string,
  expectedCount: number,
): number[] {
  if (
    expectedCount === 0
    || ctoExpectedTaskCount(input) !== expectedCount
    || !ctoEmptyRefusalDetails(details)
  ) return [];
  const text = content.trim();
  if (
    !ctoPinnedTaskValidationError(input, text)
    && !ctoPinnedTaskPreflightError(input, text)
    && !ctoAllScheduleRefusal(text)
  ) return [];
  return Array.from({ length: expectedCount }, (_value, index) => index);
}

function ctoScheduleRefusalIndexes(details: unknown, content: string, expectedCount: number): number[] {
  if (!details || typeof details !== "object" || Array.isArray(details)) return [];
  const value = details as Record<string, unknown>;
  if (!Array.isArray(value.progress) || value.progress.length !== expectedCount || expectedCount === 0) return [];
  const rows = value.progress as unknown[];
  const seenIndexes = new Set<number>();
  const failed: Record<string, unknown>[] = [];
  for (const row of rows) {
    if (!row || typeof row !== "object" || Array.isArray(row)) return [];
    const progress = row as Record<string, unknown>;
    if (
      typeof progress.index !== "number"
      || !Number.isInteger(progress.index)
      || progress.index < 0
      || progress.index >= expectedCount
      || seenIndexes.has(progress.index)
    ) return [];
    seenIndexes.add(progress.index);
    if (progress.status === "failed") {
      if (typeof progress.id !== "string" || progress.id.length === 0) return [];
      failed.push(progress);
    }
  }
  if (seenIndexes.size !== expectedCount || failed.length === 0) return [];
  const summaryStart = content.indexOf("Failed to schedule ");
  if (summaryStart < 0) return [];
  const summary = content.slice(summaryStart).trim();
  const countMatch = /^Failed to schedule (\d+) spawns?:\s+(.+)$/.exec(summary);
  if (!countMatch || Number(countMatch[1]) !== failed.length) return [];
  const labels = new Set<string>();
  for (const entry of countMatch[2]!.split("; ")) {
    const separator = entry.indexOf(": ");
    const label = separator >= 0 ? entry.slice(0, separator) : "";
    if (!label || labels.has(label)) return [];
    labels.add(label);
  }
  if (labels.size !== failed.length || failed.some((row) => !labels.has(String(row.id)))) return [];
  const resultIndexes = new Set<number>();
  if (Array.isArray(value.results)) {
    for (const row of value.results) {
      if (!row || typeof row !== "object" || Array.isArray(row)) return [];
      const index = (row as Record<string, unknown>).index;
      if (
        typeof index !== "number"
        || !Number.isInteger(index)
        || index < 0
        || index >= expectedCount
        || resultIndexes.has(index)
      ) return [];
      resultIndexes.add(index);
    }
  }
  return failed
    .map((row) => row.index as number)
    .filter((index) => !resultIndexes.has(index))
    .sort((left, right) => left - right);
}

type CtoReservationHostIdentity = {
  cwd: string;
  origin_session_id?: string;
  origin_session_file?: string;
};

function ctoReservationMatchesResult(
  reservation: CtoReservationHostIdentity & { input: unknown },
  resultInput: unknown,
  ctx: unknown,
): boolean {
  if (!ctoInputsMatch(reservation.input, resultInput)) return false;
  const resultCwd = resolveCwdFromContext(ctx);
  if (!resultCwd) return false;
  try {
    if (resolve(resultCwd) !== resolve(reservation.cwd)) return false;
  } catch {
    return false;
  }
  const resultSessionId = sessionIdFromContext(ctx);
  if (reservation.origin_session_id !== resultSessionId) return false;
  const resultSessionFile = sessionFileFromContext(ctx);
  return reservation.origin_session_file === resultSessionFile;
}

type CtoReservation = CtoReservationHostIdentity & {
  run_id: string;
  token: string;
  worker_ids: string[];
  ownership_epoch: string;
  worker_indexes: number[];
  input: unknown;
};

/**
 * Tool result events expose only the host call id, input, and current session
 * context. Once a call's reservation is consumed, retaining its id privately
 * is the only fail-closed way to reject an indistinguishable same-id replay;
 * this ledger is process-local and never becomes execution-claim state.
 */
function ctoReservationReuseBlocked(
  toolCallId: string,
  reservations: ReadonlyMap<string, CtoReservation>,
  retiredToolCalls: ReadonlySet<string>,
): boolean {
  return reservations.has(toolCallId) || retiredToolCalls.has(toolCallId);
}

export function registerTeamWorkflow(pi: ExtensionAPI, opts: RegisterOptions = {}): void {
  const label = opts.label ?? "omp-workflows";
  const readOnlyBashAgents = opts.readOnlyBashAgents ? new Set(opts.readOnlyBashAgents) : undefined;
  const resolverConfigured = typeof opts.resolveTrustedToolCallActor === "function";
  const controllerConfigured = typeof opts.getSessionController === "function";
  const controllerProvided = opts.getSessionController !== undefined;
  if (controllerProvided && !resolverConfigured) {
    throw new Error(
      `[workflow_registration:missing_actor_resolver] getSessionController requires ` +
      `resolveTrustedToolCallActor, the bundle's authenticated actor resolver; update the compatible bundle without ` +
      `weakening controller or gate authority, then report this code, bundle label, and ` +
      `installed OMP/core/bundle versions if support is needed (bundle_label=${safeRegistrationLabel(label)})`,
    );
  }
  if (opts.cwd && opts.owner) {
    assertOwner(opts.cwd, ["workflow_registration", "config_writer"], opts.owner);
  }
  pi.setLabel(label);
  if (opts.workflowProfiles?.length) registerWorkflowProfiles(opts.workflowProfiles);

  const resolveCwd = opts.resolveCwd ?? resolveCwdFromContext;
  const resolveCwdForContext = (ctx: unknown): { cwd?: string; failed: boolean } => {
    if (opts.cwd !== undefined) {
      return { cwd: typeof opts.cwd === "string" && opts.cwd.length > 0 ? opts.cwd : undefined, failed: false };
    }
    try {
      const cwd = resolveCwd(ctx);
      return { cwd: typeof cwd === "string" && cwd.length > 0 ? cwd : undefined, failed: false };
    } catch {
      return { failed: true };
    }
  };
  const recoveryStoreFor = (ctx: unknown, cwd: string): AuthenticatedStageRecoveryStore | undefined => {
    if (!opts.getSessionController) return undefined;
    try {
      const controller = opts.getSessionController(ctx, cwd);
      if (!controller) return undefined;
      return recoveryStoreForController(controller, cwd);
    } catch {
      return undefined;
    }
  };
  stageRecoveryRuntimes.set(pi as unknown as object, {
    storeFor: recoveryStoreFor,
    host: createStageRecoveryHost(pi),
    staleAdmissions: new WeakMap(),
    automaticPending: new Set(),
    automaticOpen: true,
  });
  const ctoReservations = new Map<string, CtoReservation>();
  // Retain consumed host-call identities for this registration lifetime.
  // Host result events expose no immutable generation discriminator, so
  // shutdown or session replacement cannot safely make a same-id replay
  // reusable while an older delayed result may still be delivered.
  const retiredCtoToolCalls = new Set<string>();
  const bindSession = (ctx: unknown): void => {
    const cwd = resolveCwdForContext(ctx).cwd;
    if (!cwd) return;
    assertOwner(cwd, ["workflow_registration", "config_writer"], opts.owner);
    writeRuntimeConfig(opts, cwd);
    const runId = opts.getSessionController?.(ctx, cwd)?.selectedRunId();
    if (runId) restoreDispatchOrigins(cwd, runId);
  };
  type LifecycleBinding = {
    controller: WorkflowSessionController;
    key: string;
    identity: HostSessionIdentity;
    host_context: unknown;
  };
  let lifecycleBinding: LifecycleBinding | undefined;
  const recoveryRuntime = stageRecoveryRuntimes.get(pi as unknown as object);
  if (recoveryRuntime) {
    recoveryRuntime.ownerStoreFor = (cwd, runId, authority) => {
      const binding = lifecycleBinding;
      if (!binding?.identity.cwd) return undefined;
      try {
        if (resolve(binding.identity.cwd) !== resolve(cwd)) return undefined;
        const context = binding.controller.context();
        if (authority === "cto") {
          const claim = binding.controller.activeCtoClaim();
          if (!claim || claim.run_id !== runId) return undefined;
          return createNativeStageRecoveryStore(cwd, { context, runId, claim_scope: claim });
        }
        return binding.controller.selectedRunId() === runId
          && binding.controller.activeClaimRunId() === runId
          ? createOrdinaryStageRecoveryStore(cwd, { context, runId })
          : undefined;
      } catch {
        return undefined;
      }
    };
  }
  const resolveLifecycleBinding = (ctx: unknown): LifecycleBinding | undefined => {
    const cwd = resolveCwdForContext(ctx).cwd;
    if (!cwd || !opts.getSessionController) return undefined;
    const hostIdentity = hostSessionIdentityFromContext(ctx);
    if (!hostIdentity.session_id || !hostIdentity.cwd) return undefined;
    let controller: WorkflowSessionController | undefined;
    try {
      controller = opts.getSessionController(ctx, cwd);
    } catch {
      return undefined;
    }
    if (!controller) return undefined;
    let controllerContext: TrustedExecutionContext;
    try {
      controllerContext = controller.context();
    } catch {
      return undefined;
    }
    if (
      controllerContext.session_id !== hostIdentity.session_id
      || !controllerContext.worktree
    ) return undefined;
    try {
      if (
        resolve(controllerContext.worktree) !== resolve(hostIdentity.cwd)
        || resolve(controllerContext.worktree) !== resolve(cwd)
      ) return undefined;
    } catch {
      return undefined;
    }
    const identity: HostSessionIdentity = {
      ...(hostIdentity.session_id ? { session_id: hostIdentity.session_id } : {}),
      ...(hostIdentity.cwd ? { cwd: hostIdentity.cwd } : {}),
      ...(hostIdentity.session_manager ? { session_manager: hostIdentity.session_manager } : {}),
      ...(hostIdentity.session_file ? { session_file: hostIdentity.session_file } : {}),
    };
    return { controller, key: `${identity.session_id}\u0000${identity.cwd}`, identity, host_context: ctx };
  };
  const sameLifecycleIdentity = (left: HostSessionIdentity, right: HostSessionIdentity): boolean => {
    if (!left.session_id || !right.session_id || left.session_id !== right.session_id) return false;
    if (!left.cwd || !right.cwd) return false;
    try {
      if (resolve(left.cwd) !== resolve(right.cwd)) return false;
    } catch {
      return false;
    }
    if (left.session_manager || right.session_manager) {
      if (!left.session_manager || !right.session_manager || left.session_manager !== right.session_manager) return false;
    }
    if (left.session_file || right.session_file) {
      if (!left.session_file || !right.session_file || left.session_file !== right.session_file) return false;
    }
    return true;
  };
  const verifiedLifecycleHost = (ctx: unknown): { identity: HostSessionIdentity; mode: "tui" | "rpc" } | undefined => {
    if (!ctx || typeof ctx !== "object" || Array.isArray(ctx)) return undefined;
    const value = ctx as Record<string, unknown>;
    const actor = value.actor;
    if (actor !== undefined && actor !== "host") return undefined;
    if (value.mode !== undefined && value.mode !== "tui" && value.mode !== "rpc") return undefined;
    if (value.hasUI !== undefined && value.hasUI !== true) return undefined;
    const identity = hostSessionIdentityFromContext(ctx);
    if (!identity.session_id || !identity.cwd) return undefined;
    return {
      identity,
      mode: value.mode === "rpc" ? "rpc" : "tui",
    };
  };
  const lifecycleBindingFor = (ctx: unknown): LifecycleBinding | undefined => {
    try {
      return resolveLifecycleBinding(ctx);
    } catch {
      return undefined;
    }
  };
  const scanNativeOwner = (binding: LifecycleBinding | undefined, ctx: unknown): void => {
    if (!binding?.identity.cwd || !controllerHasActiveRecoveryOwner(binding.controller)) return;
    scheduleAutomaticRecoveryScan(stageRecoveryRuntimes.get(pi as unknown as object), ctx, binding.identity.cwd);
  };
  const recoveryOwnerContextFor = (
    ctx: unknown,
    cwd: string,
    authority: StageAuthority,
    runId: string,
  ): unknown => {
    const binding = lifecycleBinding;
    if (!binding?.identity.cwd) return ctx;
    try {
      if (resolve(binding.identity.cwd) !== resolve(cwd)) return ctx;
      if (authority === "cto") {
        const claim = binding.controller.activeCtoClaim();
        if (!claim || claim.run_id !== runId) return ctx;
      } else if (
        binding.controller.selectedRunId() !== runId
        || binding.controller.activeClaimRunId() !== runId
      ) {
        return ctx;
      }
      return binding.controller.context();
    } catch {
      return ctx;
    }
  };
  const nativeWorkerAuthority = createNativeWorkerAuthority(pi.events, {
    bundleLabel: label,
    legacyAuthority: (ctx, cwd, runId) => {
      if (!runId || !lifecycleBinding) return undefined;
      const verified = verifiedLifecycleHost(ctx);
      let currentController: WorkflowSessionController | undefined;
      try {
        currentController = opts.getSessionController?.(ctx, cwd);
      } catch {
        return undefined;
      }
      if (
        !verified
        || currentController !== lifecycleBinding.controller
        || !sameLifecycleIdentity(lifecycleBinding.identity, hostSessionIdentityFromContext(ctx))
      ) return undefined;
      let trustedContext: TrustedExecutionContext;
      try {
        trustedContext = lifecycleBinding.controller.context();
        if (lifecycleBinding.controller.activeCtoClaim()) return undefined;
      } catch {
        return undefined;
      }
      return trustedLegacyCtoOwnerForRun(cwd, runId, trustedContext, ctx) ? lifecycleBinding : undefined;
    },
    legacyAuthorityCurrent: (origin, cwd, runId, sessionId) => {
      const binding = lifecycleBinding;
      if (!binding || binding !== origin || binding.identity.session_id !== sessionId) return false;
      if (!binding.identity.cwd) return false;
      try {
        if (resolve(binding.identity.cwd) !== resolve(cwd)) return false;
      } catch {
        return false;
      }
      let trustedContext: TrustedExecutionContext;
      try {
        trustedContext = binding.controller.context();
        if (binding.controller.activeCtoClaim()) return false;
      } catch {
        return false;
      }
      if (trustedContext.session_id !== sessionId) return false;
      const rawContext = {
        ...(binding.identity.session_manager ? { sessionManager: binding.identity.session_manager } : {}),
        ...(binding.identity.session_id ? { session_id: binding.identity.session_id } : {}),
        ...(binding.identity.cwd ? { cwd: binding.identity.cwd } : {}),
        mode: "tui" as const,
        hasUI: true,
      };
      try {
        const currentController = opts.getSessionController?.(rawContext, cwd);
        if (currentController && currentController !== binding.controller) return false;
      } catch {
        return false;
      }
      return trustedLegacyCtoOwnerForRun(cwd, runId, trustedContext, rawContext);
    },
    onTerminalSettlement: async (settlement) => {
      const runtime = stageRecoveryRuntimes.get(pi as unknown as object);
      const binding = lifecycleBinding;
      if (!runtime || !binding || !binding.identity.cwd) return;
      try {
        if (resolve(binding.identity.cwd) !== resolve(settlement.cwd)) return;
      } catch {
        return;
      }
      let claim: CtoClaimScope | undefined;
      try {
        claim = binding.controller.activeCtoClaim();
      } catch {
        return;
      }
      if (!claim || claim.run_id !== settlement.run_id || !controllerHasActiveRecoveryOwner(binding.controller)) return;
      const persistence = persistRecoveryTerminalObservation(
        runtime,
        binding.controller.context(),
        settlement.cwd,
        "cto",
        settlement.run_id,
        settlement.identity,
        settlement.tool_call_id,
        settlement.outcome,
      );
      trackAutomaticPending(runtime, persistence);
      await persistence;
    },
    onOrdinaryTerminalSettlement: async (settlement) => {
      const runtime = stageRecoveryRuntimes.get(pi as unknown as object);
      const binding = lifecycleBinding;
      const origin = settlement.dispatch_origin;
      if (
        !binding?.identity.cwd
        || !binding.identity.session_id
        || !binding.identity.session_file
        || !binding.identity.session_manager
        || settlement.parent_session_id !== binding.identity.session_id
        || settlement.parent_session_file !== binding.identity.session_file
        || settlement.parent_manager !== binding.identity.session_manager
        || origin.origin_session_id !== settlement.parent_session_id
        || origin.run_id !== settlement.run_id
        || origin.dispatch_id !== settlement.dispatch_id
      ) return;
      try {
        if (resolve(binding.identity.cwd) !== resolve(settlement.cwd) || resolve(origin.cwd) !== resolve(settlement.cwd)) return;
      } catch {
        return;
      }
      let context: TrustedExecutionContext;
      try {
        if (binding.controller.activeCtoClaim()) return;
        if (binding.controller.selectedRunId() !== settlement.run_id || binding.controller.activeClaimRunId() !== settlement.run_id) return;
        context = binding.controller.context();
      } catch {
        return;
      }
      if (context.session_id !== settlement.parent_session_id || !context.worktree) return;
      try {
        if (resolve(context.worktree) !== resolve(settlement.cwd)) return;
      } catch {
        return;
      }
      const state = readRunState(settlement.cwd, settlement.run_id);
      const capability = state?.dispatch_capability;
      if (
        !state
        || state.run_id !== settlement.run_id
        || state.run_key !== settlement.run_id
        || !capability
        || capability.status === "invalidated"
        || capability.status === "complete"
        || !capability.issued_for
        || !Array.isArray(capability.dispatches)
      ) return;
      const matches = capability.dispatches.filter((record) => record.id === settlement.dispatch_id && record.tool_call_id === settlement.tool_call_id);
      if (matches.length !== 1) return;
      const record = matches[0]!;
      const identity = record.work_identity;
      if (
        !identity
        || record.status !== "authorized" && record.status !== "running" && record.status !== "pending"
        || record.completion
        || record.agent !== settlement.agent
        || record.origin_session_id !== settlement.parent_session_id
        || !record.origin_ownership_epoch
        || capability.capability_id !== identity.capability_id
        || capability.issued_for.run_key !== settlement.run_id
        || capability.issued_for.stage_cursor !== identity.stage_id
        || capability.issued_for.cursor_epoch !== identity.capability_epoch
        || identity.run_id !== settlement.run_id
        || origin.capability_id !== identity.capability_id
        || origin.stage_id !== identity.stage_id
        || origin.cursor_epoch !== identity.capability_epoch
        || origin.slot_id !== identity.slot_id
        || origin.task_id !== identity.task_id
      ) return;
      const captured: CapturedDispatchContext = {
        run_id: settlement.run_id,
        dispatch_id: settlement.dispatch_id,
        capability_id: identity.capability_id,
        ownership_epoch: record.origin_ownership_epoch,
        origin_session_id: record.origin_session_id,
        rework_generation: state.rework_generation ?? 0,
      };
      const reconciled = reconcileTrustedTaskResult(settlement.cwd, {
        run_id: settlement.run_id,
        dispatch_id: settlement.dispatch_id,
        tool_call_id: settlement.tool_call_id,
        capability_id: identity.capability_id,
        cursor_epoch: identity.capability_epoch,
        slot_id: identity.slot_id,
        task_id: identity.task_id,
        captured,
        outcome: settlement.outcome,
        evidence: "authoritative OMP subagent lifecycle terminal",
        terminal_signal: "provider_terminal",
      });
      if (!reconciled.ok) {
        if (!reconciled.error.includes("unknown or already reconciled")) {
          console.warn("omp workflow SDK lifecycle reconciliation failed: " + reconciled.error);
        }
        return;
      }
      const persistence = persistRecoveryTerminalObservation(
        runtime,
        context,
        settlement.cwd,
        "ordinary",
        settlement.run_id,
        identity,
        settlement.tool_call_id,
        settlement.outcome,
        {
          source: "omp-subagent-lifecycle",
          event_id: `subagent_lifecycle:${settlement.lifecycle_id}:${settlement.dispatch_id}`,
        },
      );
      if (runtime) trackAutomaticPending(runtime, persistence);
      await persistence;
    },
  });
  nativeWorkerAuthorities.set(pi as unknown as object, nativeWorkerAuthority);
  type LiveRootAuthorityRegistration = Pick<NativeRootAuthorityRegistration, "cwd" | "owner">;
  let liveRootAuthorityRegistration: LiveRootAuthorityRegistration | undefined;
  const unregisterLiveRootAuthority = (): void => {
    const registration = liveRootAuthorityRegistration;
    liveRootAuthorityRegistration = undefined;
    if (registration) nativeWorkerAuthority.unregisterRootAuthority(registration);
  };
  const registerLiveRootAuthority = (): void => {
    const binding = lifecycleBinding;
    if (!binding?.identity.cwd || !binding.host_context) {
      unregisterLiveRootAuthority();
      return;
    }
    const rootCwd = binding.identity.cwd;
    const verified = verifiedLifecycleHost(binding.host_context);
    if (!verified || !sameLifecycleIdentity(binding.identity, verified.identity)) {
      unregisterLiveRootAuthority();
      return;
    }
    let context: TrustedExecutionContext;
    try {
      context = binding.controller.context();
    } catch {
      unregisterLiveRootAuthority();
      return;
    }
    if (
      context.caller !== "host"
      || context.authority !== "coordinator"
      || !context.worktree
      || resolve(context.worktree) !== resolve(rootCwd)
      || !context.branch
    ) {
      unregisterLiveRootAuthority();
      return;
    }
    if (
      liveRootAuthorityRegistration
      && (
        liveRootAuthorityRegistration.owner !== binding.controller
        || resolve(liveRootAuthorityRegistration.cwd) !== resolve(rootCwd)
      )
    ) {
      unregisterLiveRootAuthority();
    }
    const registration: NativeRootAuthorityRegistration = {
      cwd: rootCwd,
      owner: binding.controller,
      read: (runId?: string) => {
        const current = lifecycleBinding;
        if (
          !current
          || current !== binding
          || current.host_context !== binding.host_context
          || !sameLifecycleIdentity(current.identity, binding.identity)
        ) return undefined;
        const currentVerified = verifiedLifecycleHost(current.host_context);
        if (!currentVerified || !sameLifecycleIdentity(current.identity, currentVerified.identity)) return undefined;
        try {
          const currentContext = binding.controller.context();
          const currentCtoClaim = binding.controller.activeCtoClaim();
          if (
            currentContext.caller !== "host"
            || currentContext.authority !== "coordinator"
            || !currentContext.worktree
            || resolve(currentContext.worktree) !== resolve(rootCwd)
            || !currentContext.branch
          ) return undefined;
          if (currentCtoClaim) {
            if (!runId || currentCtoClaim.run_id !== runId) return undefined;
            return {
              authority: "cto" as const,
              root_ctx: current.host_context,
              context: currentContext,
              run_id: currentCtoClaim.run_id,
              claim_scope: currentCtoClaim,
            };
          }
          const currentRunId = binding.controller.activeClaimRunId();
          if (!currentRunId || !runId || currentRunId !== runId || binding.controller.selectedRunId() !== currentRunId) return undefined;
          return {
            authority: "ordinary" as const,
            root_ctx: current.host_context,
            context: currentContext,
            run_id: currentRunId,
          };
        } catch {
          return undefined;
        }
      },
    };
    if (nativeWorkerAuthority.registerRootAuthority(registration)) {
      liveRootAuthorityRegistration = {
        cwd: registration.cwd,
        owner: registration.owner,
      };
    }
  };
  stageBindingResolvers.set(pi as unknown as object, (ctx, cwd, runId, authority) => {
    const resolution = nativeWorkerAuthority.resolve(ctx, cwd, runId);
    const expectedKind = authority === "ordinary" ? "workflow" : "cto";
    if (!resolution || resolution.kind !== expectedKind) return undefined;
    const native = nativeWorkerAuthority.binding(ctx, cwd, runId);
    return native ? deriveWorkerStageHostBinding({ cwd, runId, authority, native }) ?? undefined : undefined;
  });
  stageToolBindingResolvers.set(pi as unknown as object, (ctx, cwd, runId, toolName, callback) => {
    const resolution = nativeWorkerAuthority.resolve(ctx, cwd, runId);
    if (!resolution || resolution.kind !== "cto" || resolution.actor !== "lead") return undefined;
    const native = nativeWorkerAuthority.binding(ctx, cwd, runId);
    return native ? deriveWorkerStageHostBinding({ cwd, runId, authority: "cto", native, toolName, callback }) ?? undefined : undefined;
  });
  stageResultCommitters.set(pi as unknown as object, (input) => commitNativeCtoStageResult(input));
  pi.on("session_start", (event: unknown, ctx: unknown) => {
    if (!sessionSwitchActorIsAdmissible(event, ctx) || !lifecycleEventIdentityIsAdmissible(event, ctx, "session_start")) return;
    const verified = verifiedLifecycleHost(ctx);
    if (!verified) {
      nativeWorkerAuthority.observeSessionStart(ctx);
      return;
    }
    const next = lifecycleBindingFor(ctx);
    if (!next) {
      if (!lifecycleBinding) nativeWorkerAuthority.observeSessionStart(ctx);
      return;
    }
    if (!lifecycleBinding) {
      lifecycleBinding = next;
      nativeWorkerAuthority.observeSessionStart(ctx);
      registerLiveRootAuthority();
      scanNativeOwner(lifecycleBinding, ctx);
      return;
    }
    if (!sameLifecycleIdentity(lifecycleBinding.identity, next.identity)) return;
    if (lifecycleBinding.controller !== next.controller) return;
    nativeWorkerAuthority.observeSessionStart(ctx);
    registerLiveRootAuthority();
    scanNativeOwner(lifecycleBinding, ctx);
  });
  pi.on("session_switch", (event: unknown, ctx: unknown) => {
    const verified = verifiedLifecycleHost(ctx);
    const binding = lifecycleBinding;
    if (!verified || !sessionSwitchActorIsAdmissible(event, ctx) || !lifecycleEventIdentityIsAdmissible(event, ctx, "session_switch")) return;
    const next = lifecycleBindingFor(ctx);
    if (!next) return;
    const switchEvent = event && typeof event === "object" && !Array.isArray(event) ? event as Record<string, unknown> : {};
    const eventType = "type" in switchEvent ? switchEvent.type : undefined;
    const reason = "reason" in switchEvent ? switchEvent.reason : undefined;
    const hasPreviousSessionFile = Object.prototype.hasOwnProperty.call(switchEvent, "previousSessionFile");
    const rawPreviousSessionFile = hasPreviousSessionFile ? switchEvent.previousSessionFile : undefined;
    const previousSessionFile = typeof rawPreviousSessionFile === "string" && rawPreviousSessionFile.length > 0
      ? rawPreviousSessionFile
      : undefined;
    if (
      eventType !== "session_switch"
      || (reason !== "new" && reason !== "resume" && reason !== "fork")
      || hasPreviousSessionFile && rawPreviousSessionFile !== undefined && previousSessionFile === undefined
    ) return;
    if (!binding) {
      lifecycleBinding = next;
      nativeWorkerAuthority.observeSessionStart(ctx);
      registerLiveRootAuthority();
      scanNativeOwner(lifecycleBinding, ctx);
      return;
    }
    if (
      !binding.identity.session_manager
      || !verified.identity.session_manager
      || binding.identity.session_manager !== verified.identity.session_manager
      || !binding.identity.session_id
      || binding.identity.session_id === verified.identity.session_id
    ) return;
    if (
      !binding.identity.session_file
      || !previousSessionFile
      || binding.identity.session_file !== previousSessionFile
    ) return;
    unregisterLiveRootAuthority();
    let oldClaim: CtoClaimScope | undefined;
    try {
      oldClaim = binding.controller.activeCtoClaim();
    } catch {
      // A bound but unverifiable private claim is typed refusal, not absence.
      // Do not release or adopt a replacement binding after this failure.
      return;
    }
    if (oldClaim) {
      try {
        suspendCtoSession(binding.controller, "session-replacement");
      } catch {
        return;
      }
    }
    lifecycleBinding = next;
    nativeWorkerAuthority.observeSessionStart(ctx);
    registerLiveRootAuthority();
    scanNativeOwner(lifecycleBinding, ctx);
  });
  // session_shutdown is a type-only disposal event, not a session switch.
  // The host supplies no old-session id here; replacement uses session_switch.
  pi.on("session_shutdown", (event: unknown, ctx: unknown) => {
    if (!sessionSwitchActorIsAdmissible(event, ctx) || !lifecycleEventIdentityIsAdmissible(event, ctx, "session_shutdown")) return;
    const verified = verifiedLifecycleHost(ctx);
    const binding = lifecycleBinding;
    if (!verified || !binding || !sameLifecycleIdentity(binding.identity, verified.identity)) return;
    unregisterLiveRootAuthority();
    try {
      suspendCtoSession(binding.controller, "session-shutdown");
    } catch {
      // Canonical release failure is fail-closed, but must not leave the
      // process-local binding available to a later raw tool call.
      lifecycleBinding = undefined;
      nativeWorkerAuthority.observeSessionShutdown(ctx);
      return;
    }
    lifecycleBinding = undefined;
    nativeWorkerAuthority.observeSessionShutdown(ctx);
  });
  pi.on("tool_execution_start", (event, ctx: unknown) => {
    nativeWorkerAuthority.observeToolExecutionStart(event, ctx);
  });
  pi.on("tool_execution_end", (event, ctx: unknown) => {
    nativeWorkerAuthority.observeToolExecutionEnd(event, ctx);
  });
  pi.on("tool_call", (event: ToolCallEvent, ctx: unknown) => {
    const c: {
      cwd?: string;
      hasUI?: boolean;
      actor?: TrustedToolCallActor;
      session_id?: string;
      sessionId?: string;
      run_id?: unknown;
      cto_run_id?: unknown;
      cto_ownership_epoch?: unknown;
    } = ctx && typeof ctx === "object" && !Array.isArray(ctx)
      ? ctx as {
        cwd?: string;
        hasUI?: boolean;
        actor?: TrustedToolCallActor;
        session_id?: string;
        sessionId?: string;
        run_id?: unknown;
        cto_run_id?: unknown;
        cto_ownership_epoch?: unknown;
      }
      : {};
    const mixedTaskInput = normalizedMixedTaskInput(event.input);
    const normalizedTaskEvent = mixedTaskInput.mixed
      ? { ...event, input: mixedTaskInput.input }
      : event;
    const originSessionId = sessionIdFromContext(ctx);
    const originSessionFile = sessionFileFromContext(ctx);
    // Resolve admission exactly once. The configured bundle resolver is the
    // authority (fullstack resolves sessionManager.getCwd() before any stale
    // copied context value); never substitute the process cwd or selection.
    const cwdResolution = resolveCwdForContext(ctx);
    const admissionCwd = cwdResolution.cwd;
    const cwdResolverFailed = cwdResolution.failed;
    let admissionResolutionFailed = false;
    let workflowStateRecoveryRequired = false;
    let ctoClaimResolutionFailed = false;
    let nativeResolutionFailed = false;
    let sharedController: WorkflowSessionController | undefined;
    let selectedRunId: string | undefined;
    let authorityRunId: string | undefined;
    let activeClaimRunId: string | undefined;
    let activeCtoScope: CtoClaimScope | undefined;
    if (admissionCwd) {
      try {
        const controller = opts.getSessionController?.(ctx, admissionCwd);
        sharedController = controller;
        try {
          activeCtoScope = controller?.activeCtoClaim();
        } catch (error) {
          ctoClaimResolutionFailed = true;
          throw error;
        }
        if (activeCtoScope) {
          // A live CTO claim is the exact target for CTO authority and native
          // resolution, but it is not an ordinary canonical workflow run.
          authorityRunId = activeCtoScope.run_id;
          try {
            const ctoState = readCtoState(activeCtoScope.run_id, admissionCwd);
            if (!ctoState || ctoState.branch !== controller?.context().branch) {
              throw new Error("active CTO claim branch/state is unavailable");
            }
          } catch (error) {
            ctoClaimResolutionFailed = true;
            throw error;
          }
        } else {
          selectedRunId = controller?.selectedRunId();
          authorityRunId = selectedRunId;
          activeClaimRunId = controller?.activeClaimRunId();
        }
      } catch (error) {
        admissionResolutionFailed = true;
        workflowStateRecoveryRequired = error instanceof LifecycleError
          && (error.code === "recovery_required" || error.code === "run_state_invalid");
      }
    }
    if (!admissionResolutionFailed && activeCtoScope) registerLiveRootAuthority();
    const ctoMarkerIds = event.toolName === "task" ? ctoMarkerRunIds(event.input) : [];
    const sharedContext = (() => {
      try { return sharedController?.context(); } catch { return undefined; }
    })();
    const legacyCtoRunId = admissionCwd && sharedContext && !admissionResolutionFailed
      ? trustedLegacyCtoRunId(admissionCwd, event.input, sharedContext, activeCtoScope, ctx)
      : undefined;
    const legacyCtoAdmission = legacyCtoRunId !== undefined;
    if (authorityRunId === undefined && legacyCtoRunId) authorityRunId = legacyCtoRunId;
    let nativeActor: NativeWorkerResolution | undefined;
    if (admissionCwd && !admissionResolutionFailed) {
      try {
        nativeActor = nativeWorkerAuthority.resolve(ctx, admissionCwd, authorityRunId);
      } catch {
        nativeActor = undefined;
        nativeResolutionFailed = true;
      }
    }
    // Only an ordinary selected run or an ordinary native grant enters the
    // classification/monotonic namespace. CTO targets stay in cto_run_id.
    const trustedRunId = admissionResolutionFailed
      ? undefined
      : selectedRunId ?? (nativeActor?.kind === "workflow" ? nativeActor.runId : undefined);
    // A configured bundle resolver/controller is the sole authority for raw
    // tool calls. Model/tool actor fields and legacy hasUI are never
    // credentials; the legacy actor path is retained only without either
    // trusted contract.
    const explicitActor = c.actor === "orchestrator" || c.actor === "worker" || c.actor === "lead"
      ? c.actor
      : undefined;
    let adaptedActor: TrustedToolCallResolution | undefined;
    let actorResolverSignal: TrustedToolCallAdapterSignal = "missing";
    if (admissionCwd && resolverConfigured && !admissionResolutionFailed) {
      try {
        const candidate: unknown = opts.resolveTrustedToolCallActor!(ctx, admissionCwd, authorityRunId);
        if (candidate === undefined) {
          actorResolverSignal = "missing";
        } else if (!isTrustedToolCallResolution(candidate)) {
          actorResolverSignal = "invalid";
        } else {
          adaptedActor = candidate;
          actorResolverSignal = "reported";
        }
      } catch {
        actorResolverSignal = "threw";
      }
    }
    const actorResolverDiagnosticCode: AdmissionDiagnosticCode =
      actorResolverSignal === "threw"
        ? "actor_resolver_failed"
        : actorResolverSignal === "invalid"
          ? "actor_resolver_invalid_result"
          : "actor_unresolved";
    const adaptedDenialCode = adaptedActor
      && "kind" in adaptedActor
      && adaptedActor.kind === "denied"
      ? adaptedActor.code
      : undefined;
    const authenticatedCtoProofPresented = adaptedActor
      && "kind" in adaptedActor
      && adaptedActor.kind === "authenticated-interactive-host-cto";
    const authenticatedCtoScope =
      adaptedActor
      && "kind" in adaptedActor
      && adaptedActor.kind === "authenticated-interactive-host-cto"
      && activeCtoScope
      && activeCtoScope.run_id === adaptedActor.run_id
      && activeCtoScope.ownership_epoch === adaptedActor.ownership_epoch
      ? activeCtoScope
      : undefined;
    const ctoRunId = admissionResolutionFailed
      ? undefined
      : authenticatedCtoScope?.run_id
        ?? legacyCtoRunId
        ?? (nativeActor?.kind === "cto" ? nativeActor.runId : undefined);
    const {
      run_id: _rawRunId,
      cto_run_id: _rawCtoRunId,
      cto_ownership_epoch: _rawCtoOwnershipEpoch,
      ...gateContextBase
    } = c;
    const gateContext = admissionCwd
      ? {
        ...gateContextBase,
        cwd: admissionCwd,
        ...(trustedRunId ? { run_id: trustedRunId } : {}),
        ...(ctoRunId ? { cto_run_id: ctoRunId } : {}),
        ...(authenticatedCtoScope ? { cto_ownership_epoch: authenticatedCtoScope.ownership_epoch } : {}),
      }
      : undefined;
    let trustedProof: TrustedOrchestratorWriteProof | undefined;
    let artifactsScopeMismatch = false;
    const orchestratorClaimMismatch = adaptedActor
      && "actor" in adaptedActor
      && adaptedActor.actor === "orchestrator"
      && (selectedRunId !== undefined || activeClaimRunId !== undefined)
      && activeClaimRunId !== selectedRunId;
    if (
      !admissionResolutionFailed
      && controllerConfigured
      && !nativeActor
      && adaptedActor
      && "actor" in adaptedActor
      && adaptedActor.actor === "orchestrator"
      && typeof adaptedActor.artifactsDir === "string"
      && adaptedActor.artifactsDir.length > 0
      && admissionCwd
      && selectedRunId
      && activeClaimRunId === selectedRunId
    ) {
      try {
        const expectedArtifactsDir = runTarget(admissionCwd, selectedRunId).artifactsDir;
        if (expectedArtifactsDir && resolve(expectedArtifactsDir) === resolve(adaptedActor.artifactsDir)) {
          trustedProof = createTrustedOrchestratorWriteProof(expectedArtifactsDir);
        } else {
          artifactsScopeMismatch = true;
        }
      } catch {
        trustedProof = undefined;
        artifactsScopeMismatch = true;
      }
    }
    const adaptedTrustedActor = adaptedActor && "actor" in adaptedActor
      ? adaptedActor.actor === "orchestrator"
        ? (trustedProof ? adaptedActor.actor : undefined)
        : adaptedActor.actor
      : authenticatedCtoScope
        ? "orchestrator"
        : undefined;
    let authenticatedInteractiveHostNoRun = false;
    let authenticatedHostIdleBasicTools = false;
    let idleBasicSelectionPresent = false;
    let idleBasicSelectedRunPresent = false;
    let idleBasicAuthorityConflict = false;
    let noRunClaimPresent = false;
    let controlReadFailed = false;
    if (
      !admissionResolutionFailed
      && resolverConfigured
      && adaptedActor
      && "kind" in adaptedActor
      && adaptedActor.kind === "authenticated-interactive-host-no-run"
      && selectedRunId === undefined
      && trustedRunId === undefined
      && admissionCwd
    ) {
      try {
        const control = readRunControlNoRecovery(admissionCwd);
        noRunClaimPresent = control.execution_claim !== null;
        authenticatedInteractiveHostNoRun = !noRunClaimPresent;
      } catch {
        controlReadFailed = true;
        authenticatedInteractiveHostNoRun = false;
      }
    }
    // This is a per-call idle predicate, not a command lease or actor credential.
    if (
      adaptedActor
      && "kind" in adaptedActor
      && adaptedActor.kind === "authenticated-host-idle-basic-tools"
    ) {
      idleBasicSelectedRunPresent = selectedRunId !== undefined
        || trustedRunId !== undefined
        || authorityRunId !== undefined;
      idleBasicAuthorityConflict = Boolean(
        sharedController
        || activeCtoScope
        || activeClaimRunId !== undefined
        || nativeActor
        || nativeResolutionFailed
        || legacyCtoAdmission
        || idleBasicSelectedRunPresent
      );
      if (!admissionResolutionFailed && !idleBasicAuthorityConflict && admissionCwd) {
        try {
          const control = readRunControlNoRecovery(admissionCwd);
          noRunClaimPresent = control.execution_claim !== null;
          for (const selectionId in control.selections) {
            if (Object.prototype.hasOwnProperty.call(control.selections, selectionId)) {
              idleBasicSelectionPresent = true;
              break;
            }
          }
          authenticatedHostIdleBasicTools = !noRunClaimPresent && !idleBasicSelectionPresent;
        } catch {
          controlReadFailed = true;
          authenticatedHostIdleBasicTools = false;
        }
      }
    }
    const selectedNoRunConflict = selectedRunId !== undefined
      && adaptedActor
      && "kind" in adaptedActor
      && adaptedActor.kind === "authenticated-interactive-host-no-run";
    const ctoMarkedTask = event.toolName === "task" && ctoMarkerIds.length > 0;
    const nativeCtoMarkerAdmission = nativeActor?.kind === "cto"
      && ctoMarkerIds.length > 0
      && ctoMarkerIds.every((runId) => runId === nativeActor.runId);
    const legacyCtoTaskAdmission = legacyCtoAdmission && ctoMarkedTask;
    const ctoAuthorizedDispatch = authenticatedCtoScope !== undefined || legacyCtoAdmission || nativeCtoMarkerAdmission;
    const nativeCtoTargeted = authenticatedCtoScope !== undefined || legacyCtoTaskAdmission || nativeActor?.kind === "cto";
    const actorAuthorityConfigured = resolverConfigured || controllerConfigured;
    const trustedActor = admissionResolutionFailed
      ? undefined
      : nativeActor?.actor ?? (actorAuthorityConfigured ? adaptedTrustedActor : explicitActor);
    const { actor: _runtimeActor, ...writeGateBase } = gateContext ?? {};
    const writeGateContext = gateContext
      ? {
        ...writeGateBase,
        cwd: gateContext.cwd,
        ...(trustedActor ? { actor: trustedActor } : {}),
        ...(trustedProof ? { [TRUSTED_ORCHESTRATOR_WRITE_PROOF]: trustedProof } : {}),
        // A configured resolver/controller owns all raw-context authority;
        // bare actor and hasUI fields never infer a worker after failure.
        ...(actorAuthorityConfigured && !trustedActor ? { hasUI: undefined } : {}),
        }
      : undefined;
    let result: { block?: boolean; reason?: string } | undefined;
    const run = (candidate: { block?: boolean; reason?: string } | void) => { if (!result && candidate?.block) result = candidate; };
    const admissionScenario: TrustedToolCallAdmissionScenario = activeCtoScope || ctoMarkerIds.length > 0
      ? "cto"
      : selectedRunId
        ? "selected"
        : admissionResolutionFailed || !admissionCwd ? "unknown" : "idle";
    const runAdmission = (
      code: AdmissionDiagnosticCode,
      signal?: TrustedToolCallAdapterSignal,
    ): void => {
      if (result) return;
      result = {
        block: true,
        reason: trustedToolCallAdmissionDiagnostic(code, {
          bundleLabel: label,
          toolName: event.toolName,
          scenario: admissionScenario,
          ...(signal ? { adapterSignal: signal } : {}),
        }),
      };
    };
    let lifecycleDeviceWrite = false;
    if (event.toolName === "write") {
      try {
        lifecycleDeviceWrite = isRegisteredLifecycleDeviceWrite(
          event as unknown as { toolName: string; input?: Record<string, unknown> | string },
        );
      } catch {
        lifecycleDeviceWrite = false;
      }
    }
    if (
      !result
      && ctoMarkedTask
      && !authenticatedCtoScope
      && !legacyCtoRunId
      && !nativeCtoMarkerAdmission
    ) {
      runAdmission(
        adaptedDenialCode ?? "cto_marker_unauthenticated",
        adaptedDenialCode ? actorResolverSignal : undefined,
      );
    }
    if (
      admissionResolutionFailed
      && (
        event.toolName === "ask"
        || event.toolName === "task"
        || (
          (event.toolName === "write" || event.toolName === "edit" || event.toolName === "bash")
          && !lifecycleDeviceWrite
        )
      )
    ) {
      runAdmission(workflowStateRecoveryRequired
        ? "workflow_state_recovery_required"
        : ctoClaimResolutionFailed ? "cto_claim_mismatch" : "session_controller_resolution_failed");
    }
    if (!admissionCwd && (event.toolName === "ask" || event.toolName === "task" || event.toolName === "write" || event.toolName === "edit" || event.toolName === "bash")) {
      runAdmission(cwdResolverFailed ? "cwd_resolution_failed" : "cwd_unavailable");
    }
    if (
      !result
      && actorAuthorityConfigured
      && !trustedActor
      && !authenticatedInteractiveHostNoRun
      && !authenticatedHostIdleBasicTools
      && !lifecycleDeviceWrite
      && (event.toolName === "write" || event.toolName === "edit" || event.toolName === "bash")
    ) {
      const code: AdmissionDiagnosticCode = adaptedDenialCode
        ?? (artifactsScopeMismatch
          ? "artifacts_scope_mismatch"
          : orchestratorClaimMismatch
            ? "execution_claim_mismatch"
            : controlReadFailed
              ? "run_control_unreadable"
              : noRunClaimPresent
                ? "no_run_claim_present"
                : selectedNoRunConflict
                  ? "execution_claim_mismatch"
                  : idleBasicSelectionPresent || idleBasicSelectedRunPresent
                    ? "selected_run_mismatch"
                    : idleBasicAuthorityConflict
                      ? "execution_claim_mismatch"
                      : actorResolverDiagnosticCode);
      runAdmission(
        code,
        adaptedDenialCode || code === actorResolverDiagnosticCode ? actorResolverSignal : undefined,
      );
    }
    if (
      !result
      && event.toolName === "task"
      && actorAuthorityConfigured
      && !nativeActor
      && !legacyCtoTaskAdmission
      && (
        !sharedController
        || (selectedRunId !== undefined && activeClaimRunId !== selectedRunId)
      )
    ) {
      const code: AdmissionDiagnosticCode = adaptedDenialCode
        ?? (nativeResolutionFailed
          ? "native_authority_resolution_failed"
          : authenticatedCtoProofPresented
            ? "cto_claim_mismatch"
            : orchestratorClaimMismatch
              ? "execution_claim_mismatch"
              : !sharedController
                ? "session_controller_unavailable"
                : "selected_run_mismatch");
      runAdmission(code, adaptedDenialCode ? actorResolverSignal : undefined);
    }
    if (!result && nativeActor?.actor === "worker" && event.toolName === "bash" && readOnlyBashAgents && admissionCwd) {
      const worker = nativeWorkerAuthority.binding(ctx, admissionCwd, authorityRunId);
      if (!worker) run({ block: true, reason: "read-only worker bash requires the current authenticated native worker binding" });
      else if (readOnlyBashAgents.has(worker.agent)) run(readOnlyWorkerBashGate(event, admissionCwd));
    }
    if (nativeActor?.actor === "worker" && event.toolName === "task") {
      run({ block: true, reason: "native worker authority does not permit nested task delegation" });
    }
    const admissionResolutionBlocked = admissionResolutionFailed && !!result;
    if (!admissionResolutionBlocked) run(ctoNestingGuard(event as unknown as Parameters<typeof ctoNestingGuard>[0]));
    // These gates read workspace state before they inspect the tool name. A
    // missing authoritative cwd therefore skips them rather than passing
    // undefined into path/state consumers. Cwd-independent guards still run.
    if (!admissionResolutionBlocked && gateContext) {
      run(outboxEnforcementGate(event as unknown as Parameters<typeof outboxEnforcementGate>[0], gateContext));
      run(classificationToolGate(event as unknown as Parameters<typeof classificationToolGate>[0], gateContext));
      run(orchestratorWriteGate(event as unknown as Parameters<typeof orchestratorWriteGate>[0], writeGateContext ?? gateContext!));
      run(workerWriteScopeGate(event as unknown as Parameters<typeof workerWriteScopeGate>[0], { ...(writeGateContext ?? gateContext!), writeScope: opts.writeScope }));
      run(ctoSliceTaskGate(normalizedTaskEvent as unknown as Parameters<typeof ctoSliceTaskGate>[0], gateContext));
      if (!ctoAuthorizedDispatch) run(dispatchGate(normalizedTaskEvent as unknown as Parameters<typeof dispatchGate>[0], { ...gateContext, controller: sharedController }));
    }
    if (!admissionResolutionBlocked) run(safetyGuard(event as unknown as Parameters<typeof safetyGuard>[0], (gateContext ?? c) as Parameters<typeof safetyGuard>[1]));
    let eventRunId = event.toolName === "task" ? ctoRunId : trustedRunId;
    let eventRunIdTrusted = typeof eventRunId === "string" && eventRunId.length > 0;
    let nativeDispatchOrigins: DispatchOrigin[] | undefined;
    let ordinaryDispatchWitness = false;
    if (!result && mixedTaskInput.mixed && event.toolName === "task") {
      const normalizedAuthorization = gateContext
        ? trustedDispatchRequests(
            normalizedTaskEvent as unknown as { toolName?: string; toolCallId?: string; input?: unknown },
            { ...gateContext, session_id: originSessionId, controller: sharedController },
          )
        : { ok: true as const, requests: [] };
      if ("reason" in normalizedAuthorization) {
        run({ block: true, reason: normalizedAuthorization.reason });
      } else {
        run({ block: true, reason: "dispatch gate: mixed flat and batch task shape is unsupported; task admission was not attempted" });
        const request = normalizedAuthorization.requests.length === 1 ? normalizedAuthorization.requests[0] : undefined;
        const runId = request?.run_id ?? eventRunId;
        if (runId && admissionCwd && event.toolCallId) {
          const identity = request?.run_id
            ? recoveryIdentityForSlot(admissionCwd, { ...request, run_id: request.run_id })
            : canonicalRecoveryIdentity(
                stageRecoveryRuntimes.get(pi as unknown as object),
                ctx,
                admissionCwd,
                ctoAuthorizedDispatch ? "cto" : "ordinary",
                runId,
              );
          const recoveryRuntime = stageRecoveryRuntimes.get(pi as unknown as object);
          const recoveryAuthority: StageAuthority = ctoAuthorizedDispatch ? "cto" : "ordinary";
          const persisted = persistRecoveryPreflightObservation(
            recoveryRuntime,
            ctx,
            admissionCwd,
            recoveryAuthority,
            runId,
            identity,
            event.toolCallId,
            "mixed flat and batch task shape was rejected before normal task admission",
          );
          if (persisted && identity) {
            scheduleAutomaticRecovery(recoveryRuntime, {
              kind: "preflight",
              run_id: runId,
              authority: recoveryAuthority,
              cwd: admissionCwd,
              ctx,
              dispatch_id: identity.dispatch_id,
            });
          }
        }
      }
    }
    const nativeBatchContextMissing = !result
      && event.toolName === "task"
      && admissionCwd !== undefined
      && taskBatchMissingContext(event.input)
      && (
        authenticatedInteractiveHostNoRun
        || legacyCtoTaskAdmission
        || nativeCtoTargeted
        || ctoAuthorizedDispatch
      );
    if (nativeBatchContextMissing) {
      const nativeCwd = admissionCwd;
      const nativeRunId = eventRunId ?? trustedRunId ?? nativeActor?.runId;
      const nativeActorKind = trustedActor === "lead" || nativeActor?.actor === "lead" ? "lead" as const : "orchestrator" as const;
      run({
        block: true,
        reason: "dispatch gate: task batch context is required before native task admission",
      });
      if (event.toolCallId && nativeCwd) {
        let rejection: ReturnType<typeof nativeWorkerAuthority.admitTaskCall> | undefined;
        try {
          rejection = nativeWorkerAuthority.admitTaskCall(
            ctx,
            event as unknown as { toolName?: string; toolCallId?: string; input?: unknown },
            nativeActorKind,
            nativeRunId,
            undefined,
            "preflight:invalid_arguments",
          );
        } catch {
          rejection = undefined;
        }
        let ownerContext: TrustedExecutionContext | undefined;
        const binding = lifecycleBinding;
        if (nativeRunId && binding?.identity.cwd) {
          try {
            const claim = binding.controller.activeCtoClaim();
            if (
              claim
              && claim.run_id === nativeRunId
              && controllerHasActiveRecoveryOwner(binding.controller)
              && resolve(binding.identity.cwd) === resolve(nativeCwd)
            ) {
              ownerContext = binding.controller.context();
            }
          } catch {
            ownerContext = undefined;
          }
        }
        if (rejection && typeof rejection === "object" && rejection.ok && nativeRunId && ownerContext) {
          const runtime = stageRecoveryRuntimes.get(pi as unknown as object);
          for (const identity of rejection.identities) {
            const persisted = persistRecoveryPreflightObservation(
              runtime,
              ownerContext,
              nativeCwd,
              "cto",
              nativeRunId,
              identity,
              event.toolCallId,
              "task batch context was missing; native task admission was rejected before provider execution",
            );
            if (persisted) {
              scheduleAutomaticRecovery(runtime, {
                kind: "preflight",
                run_id: nativeRunId,
                authority: "cto",
                cwd: nativeCwd,
                ctx: ownerContext,
                dispatch_id: identity.dispatch_id,
              });
            }
          }
        }
      }
    }
    if (!result && event.toolName === "task" && !mixedTaskInput.mixed && !ctoAuthorizedDispatch) {
      const authorization = gateContext
        ? trustedDispatchRequests(
            event as unknown as { toolName?: string; toolCallId?: string; input?: unknown },
            { ...gateContext, session_id: originSessionId, controller: sharedController },
          )
        : { ok: true as const, requests: [] };
      if ("reason" in authorization) {
        run({ block: true, reason: authorization.reason });
      } else if (!admissionCwd) {
        run({ block: true, reason: "dispatch authorization failed: workflow cwd unavailable" });
      } else {
        const taskInput = event.input && typeof event.input === "object" && !Array.isArray(event.input)
          ? event.input as Record<string, unknown>
          : undefined;
        const missingBatchContext = taskBatchMissingContext(event.input);
        if (missingBatchContext) {
          let rejected = authorization.requests.length > 0;
          for (const request of authorization.requests) {
            const refusal = rejectDispatchPreflightTrusted(admissionCwd, {
              ...request,
              rejection_code: "invalid_arguments",
            });
            if (!refusal.ok) {
              rejected = false;
              run({ block: true, reason: `dispatch authorization failed: ${refusal.error}` });
              break;
            }
            if (request.run_id && event.toolCallId && refusal.record?.work_identity) {
              const runtime = stageRecoveryRuntimes.get(pi as unknown as object);
              const persisted = persistRecoveryPreflightObservation(
                runtime,
                ctx,
                admissionCwd,
                "ordinary",
                request.run_id,
                refusal.record.work_identity,
                event.toolCallId,
                "task batch context was missing; task admission was rejected before provider execution",
              );
              if (persisted) {
                scheduleAutomaticRecovery(runtime, {
                  kind: "preflight",
                  run_id: request.run_id,
                  authority: "ordinary",
                  cwd: admissionCwd,
                  ctx,
                  dispatch_id: refusal.record.work_identity.dispatch_id,
                });
              }
            }
          }
          if (rejected) run({ block: true, reason: "dispatch gate: task batch context is required before task admission" });
        } else {
        const origins: DispatchOrigin[] = [];
        for (const [index, request] of authorization.requests.entries()) {
          if (request.run_id) {
            eventRunId = request.run_id;
            eventRunIdTrusted = true;
          }
          const authorized = authorizeDispatchTrusted(admissionCwd, request);
          if (!authorized.ok) {
            run({ block: true, reason: `dispatch authorization failed: ${authorized.error}` });
            break;
          }
          const toolCallId = authorized.record?.tool_call_id ?? event.toolCallId;
          if (toolCallId && request.run_id && authorized.record) {
            const origin: DispatchOrigin = {
              cwd: admissionCwd,
              run_id: request.run_id,
              dispatch_id: authorized.record.id,
              ...(request.origin_session_id ? { origin_session_id: request.origin_session_id } : {}),
              ...(authorized.record.work_identity ? {
                capability_id: authorized.record.work_identity.capability_id,
                stage_id: authorized.record.work_identity.stage_id,
                cursor_epoch: authorized.record.work_identity.capability_epoch,
                slot_id: authorized.record.work_identity.slot_id,
                task_id: authorized.record.work_identity.task_id,
              } : {}),
            };
            origins[index] = origin;
            rememberDispatchOrigin(toolCallId, origin);
            rememberDispatchOriginLocator(toolCallId, origin);
          }
        }
        if (
          origins.length > 0
          && origins.length === authorization.requests.length
          && selectedRunId !== undefined
          && activeClaimRunId === selectedRunId
          && sharedContext?.caller === "host"
          && sharedContext.authority === "coordinator"
          && sharedContext.worktree === admissionCwd
          && authorization.requests.every((request) => request.run_id === selectedRunId)
        ) {
          nativeDispatchOrigins = origins;
          ordinaryDispatchWitness = true;
        }
      }
        }
    }
    let pendingCtoReservation: CtoReservation | undefined;
    const authenticatedCtoParent = Boolean(authenticatedCtoScope && trustedActor === "orchestrator");
    if (!result && authenticatedCtoParent && admissionCwd && event.toolName === "task") {
      const credentials = sharedController ? ctoClaimCredentials(sharedController) : undefined;
      const workerIds = ctoReservationWorkerIds(event.toolCallId, event.input, credentials?.ownership_epoch);
      const reservationInput = ctoSnapshotInput(event.input);
      if (
        !event.toolCallId
        || workerIds.length === 0
        || reservationInput === undefined
        || !credentials
        || credentials.run_id !== authenticatedCtoScope!.run_id
        || eventRunId !== undefined && eventRunId !== authenticatedCtoScope!.run_id
      ) {
        runAdmission("cto_claim_mismatch");
      } else {
        // Native admission owns the locked reservation. Keep the exact
        // authenticated slot image here so the matching host result can
        // settle/refuse it without a second deduplicating reservation.
        pendingCtoReservation = {
          cwd: admissionCwd,
          run_id: credentials.run_id,
          token: credentials.token,
          ownership_epoch: credentials.ownership_epoch,
          worker_ids: workerIds,
          worker_indexes: workerIds.map((_workerId, index) => index),
          input: reservationInput,
          ...(originSessionId ? { origin_session_id: originSessionId } : {}),
          ...(originSessionFile ? { origin_session_file: originSessionFile } : {}),
        };
        if (ctoReservationReuseBlocked(event.toolCallId, ctoReservations, retiredCtoToolCalls)) {
          pendingCtoReservation = undefined;
          run({ block: true, reason: "cto task call identity is still reserved by an earlier host invocation" });
        }
      }
    }
    if (
      !result
      && event.toolName === "task"
      && admissionCwd
      && (
        trustedActor === "orchestrator"
        || trustedActor === "lead"
        || authenticatedInteractiveHostNoRun
        || legacyCtoTaskAdmission
        || ordinaryDispatchWitness
      )
    ) {
      try {
        // A no-run host may bootstrap CTO leads; the native bridge still
        // requires lead-only slice markers and validates each live CTO slice.
        const admitted = nativeWorkerAuthority.admitTaskCall(
          ctx,
          event as unknown as { toolName?: string; toolCallId?: string; input?: unknown },
          trustedActor === "lead" ? "lead" : "orchestrator",
          ordinaryDispatchWitness ? selectedRunId : eventRunId ?? trustedRunId ?? nativeActor?.runId,
          nativeDispatchOrigins,
        );
        if (nativeCtoTargeted && !admitted) {
          pendingCtoReservation = undefined;
          runAdmission("cto_claim_mismatch");
        } else if (pendingCtoReservation && event.toolCallId) {
          ctoReservations.set(event.toolCallId, pendingCtoReservation);
        }
      } catch (error) {
        if (pendingCtoReservation) pendingCtoReservation = undefined;
        if (error instanceof NativeWorkerRouteError) {
          runAdmission("native_authority_route_denied");
        } else if (nativeCtoTargeted) {
          runAdmission("native_authority_resolution_failed");
        }
        // Native authority is fail-closed; a malformed host context never
        // changes the already-allowed task decision or creates a grant.
      }
    }
    if (
      event.toolName === "task"
      && event.toolCallId
      && admissionCwd
      && result?.block === true
      && typeof result.reason === "string"
      && /dispatch|admission|authority|identity|stale/i.test(result.reason)
      && (eventRunId ?? trustedRunId)
      && ctx !== null
      && (typeof ctx === "object" || typeof ctx === "function")
    ) {
      const runtime = stageRecoveryRuntimes.get(pi as unknown as object);
      runtime?.staleAdmissions.set(ctx as object, {
        cwd: admissionCwd,
        run_id: (eventRunId ?? trustedRunId)!,
        authority: ctoAuthorizedDispatch || nativeCtoTargeted ? "cto" : "ordinary",
        tool_call_id: event.toolCallId,
        reason: result.reason,
        observed_at: new Date().toISOString(),
      });
    }
    const preflightReason = result?.block === true
      && typeof result.reason === "string"
      && (
        result.reason === "dispatch gate: task marker disappeared during authorization"
        || result.reason === "dispatch gate: task slot identity is missing"
        || result.reason === "dispatch gate: task call identity is missing"
      )
      ? result.reason
      : undefined;
    if (preflightReason && event.toolName === "task" && event.toolCallId && admissionCwd) {
      const runId = eventRunId ?? trustedRunId;
      const authority: StageAuthority = ctoAuthorizedDispatch ? "cto" : "ordinary";
      const identity = runId
        ? canonicalRecoveryIdentity(stageRecoveryRuntimes.get(pi as unknown as object), ctx, admissionCwd, authority, runId)
        : undefined;
      if (runId) {
        const runtime = stageRecoveryRuntimes.get(pi as unknown as object);
        const persisted = persistRecoveryPreflightObservation(
          runtime,
          ctx,
          admissionCwd,
          authority,
          runId,
          identity,
          event.toolCallId,
          preflightReason,
        );
        if (persisted && identity) {
          scheduleAutomaticRecovery(runtime, {
            kind: "preflight",
            run_id: runId,
            authority,
            cwd: admissionCwd,
            ctx,
            dispatch_id: identity.dispatch_id,
          });
        }
      }
    }
    if (admissionCwd && opts.observability !== false) {
      if (eventRunIdTrusted && eventRunId) setObservabilityRun(admissionCwd, eventRunId);
      recordToolCallAttempt(admissionCwd, { ...(event as unknown as { toolName?: string; toolCallId?: string; input?: unknown }), ...(eventRunId ? { runId: eventRunId } : {}) }, result ? "blocked" : "allowed", result?.reason);
    }
    return result;
  });
  pi.on("tool_result", async (event: ToolResultEvent, ctx: unknown) => {
    const recoveryRuntime = stageRecoveryRuntimes.get(pi as unknown as object);
    if (event.toolName !== "task") return;
    if (nativeMigrationIngress(event.input) || nativeMigrationIngress(event.details) || nativeMigrationIngress(event.content)) {
      console.warn(`omp workflow task reconciliation rejected: migration-only completion provenance for tool call ${event.toolCallId}`);
      return;
    }
    const details = event.details as unknown;
    const asyncState = details && typeof details === "object" && !Array.isArray(details)
      && "async" in details
      && details.async && typeof details.async === "object" && !Array.isArray(details.async)
      && "state" in details.async
      && typeof details.async.state === "string"
      ? details.async.state
      : undefined;
    const asyncStatus = ctoToolResultAsyncStatus(details);
    const asyncActive = asyncStatus === "active";
    const unknownAsync = asyncStatus === "unknown";
    const content = event.content
      .filter((part): part is { type: "text"; text: string } => part.type === "text")
      .map((part) => part.text)
      .join("\n")
      .trim();
    const evidence = content || (event.isError ? "native task failed" : "native task completed");
    const ctoReservationCandidate = ctoReservations.get(event.toolCallId);
    if (
      ctoReservationCandidate
      && !ctoReservationMatchesResult(ctoReservationCandidate, event.input, ctx)
    ) {
      console.warn(`omp workflow CTO result rejected: host invocation identity does not match tool call ${event.toolCallId}`);
      return;
    }
    if (!ctoReservationCandidate && retiredCtoToolCalls.has(event.toolCallId)) {
      console.warn(`omp workflow CTO result rejected: consumed tool call identity cannot be replayed ${event.toolCallId}`);
      return;
    }
    const ctoReservation = ctoReservationCandidate;
    const markerRunIds = ctoMarkerRunIds(event.input);
    const markerRunId = markerRunIds.length > 0 && markerRunIds.every((runId) => runId === markerRunIds[0])
      ? markerRunIds[0]
      : undefined;
    const ctoRunId = ctoReservation?.run_id ?? markerRunId;
    const nativeCtoResult = ctoReservation !== undefined || markerRunId !== undefined;
    let ctoWorkerIds = ctoReservation?.worker_ids ?? [];
    let ctoWorkerIndexes = ctoReservation?.worker_indexes ?? [];
    const settlementCwd = ctoReservation?.cwd ?? resolveCwdFromContext(ctx);
    if (ctoReservation && settlementCwd && ctoRunId && ctoWorkerIds.length > 0) {
      const originalWorkerCount = ctoWorkerIndexes.length > 0 ? Math.max(...ctoWorkerIndexes) + 1 : 0;
      const refusalIndexes = ctoPreSpawnRefusalIndexes(
        ctoReservation.input,
        details,
        content,
        originalWorkerCount,
      );
      const scheduleRefusalIndexes = ctoScheduleRefusalIndexes(
        details,
        content,
        originalWorkerCount,
      );
      const refusedIndexes = [...new Set([...refusalIndexes, ...scheduleRefusalIndexes])].sort((left, right) => left - right);
      const refusedIndexSet = new Set(refusedIndexes);
      const refusedPositions = new Set<number>();
      for (let position = 0; position < ctoWorkerIndexes.length; position += 1) {
        if (refusedIndexSet.has(ctoWorkerIndexes[position]!)) refusedPositions.add(position);
      }
      const refusedWorkerIds = ctoWorkerIds
        .filter((_workerId, position) => refusedPositions.has(position));
      if (refusedWorkerIds.length > 0) {
        try {
          settleCtoExecutionClaimWorkersByToolCall(settlementCwd, {
            run_id: ctoReservation.run_id,
            tool_call_id: event.toolCallId,
            token: ctoReservation.token,
            ownership_epoch: ctoReservation.ownership_epoch,
            worker_ids: refusedWorkerIds,
          });
          ctoWorkerIds = ctoWorkerIds.filter((_workerId, position) => !refusedPositions.has(position));
          ctoWorkerIndexes = ctoWorkerIndexes.filter((_originalIndex, position) => !refusedPositions.has(position));
          if (ctoWorkerIds.length === 0) {
            ctoReservations.delete(event.toolCallId);
            retiredCtoToolCalls.add(event.toolCallId);
          } else {
            ctoReservations.set(event.toolCallId, {
              ...ctoReservation,
              worker_ids: ctoWorkerIds,
              worker_indexes: ctoWorkerIndexes,
            });
          }
        } catch {
          console.warn(`omp workflow CTO pre-spawn refusal settlement deferred for tool call ${event.toolCallId}`);
        }
      }
    }
    if (
      ctoReservation
      && settlementCwd
      && ctoWorkerIds.length > 0
      && ctoResultHasTerminalSlots(details, ctoWorkerIndexes, event.isError)
    ) {
      try {
        settleCtoExecutionClaimWorkersByToolCall(settlementCwd, {
          run_id: ctoReservation.run_id,
          tool_call_id: event.toolCallId,
          token: ctoReservation.token,
          ownership_epoch: ctoReservation.ownership_epoch,
          worker_ids: ctoWorkerIds,
        });
        ctoReservations.delete(event.toolCallId);
        retiredCtoToolCalls.add(event.toolCallId);
      } catch {
        console.warn(`omp workflow CTO reservation settlement deferred for tool call ${event.toolCallId}`);
      }
    }
    // The original task input carries the trusted structured marker. Use its
    // canonical run only to select an already persisted dispatch origin; the
    // marker itself never authorizes or invents a dispatch.
    const markerFilter = taskMarkerFilter(event.input);
    const origins = taskOriginsForResult(event.toolCallId, markerFilter);
    if (origins.length === 0) {
      if (nativeCtoResult) {
        // Native terminal authority is settled by the lifecycle grant bridge
        // after the canonical assignment transition. A raw task result is
        // never terminal evidence for native recovery on its own.
        return;
      }
      console.warn(`omp workflow task reconciliation rejected: no exact origin for tool call ${event.toolCallId}`);
      return;
    }
    const outcomes = unknownAsync
      ? { mapped: [], unresolved: origins }
      : taskOutcomeRows(event.input, event.details, evidence, origins);
    if (!outcomes) {
      console.warn("omp workflow task reconciliation rejected: incomplete or ambiguous batch result for tool call " + event.toolCallId);
      return;
    }
    const terminalWholeCallError = !asyncActive && !unknownAsync && (event.isError || (asyncState === "failed" && content.length > 0));
    const unresolvedPendingReason = asyncActive || unknownAsync
      ? (asyncState === "running" ? "provider_running" as const : "awaiting_result" as const)
      : terminalWholeCallError ? undefined : "transport_reconnect" as const;
    const unresolvedEvidence = terminalWholeCallError
      ? evidence
      : `transport_reconnect: task result omitted terminal row; recovery required (tool call ${event.toolCallId})`;
    const asyncPendingEvidence = asyncActive || unknownAsync
      ? `native task provider acknowledgement (${String(asyncState)}); awaiting result (tool call ${event.toolCallId})`
      : undefined;
    for (const { origin, outcome, evidence: slotEvidence } of outcomes.mapped) {
      const reconciled = reconcileTrustedTaskResult(origin.cwd, {
        run_id: origin.run_id,
        dispatch_id: origin.dispatch_id,
        tool_call_id: event.toolCallId,
        ...(origin.capability_id ? { capability_id: origin.capability_id } : {}),
        ...(origin.cursor_epoch ? { cursor_epoch: origin.cursor_epoch } : {}),
        ...(origin.slot_id ? { slot_id: origin.slot_id } : {}),
        ...(origin.task_id ? { task_id: origin.task_id } : {}),
        outcome,
        evidence: slotEvidence,
      });
      if (!reconciled.ok && !reconciled.error.includes("unknown or already reconciled")) {
        console.warn("omp workflow task reconciliation failed: " + reconciled.error);
      }
      if (!nativeCtoResult && !asyncActive && !unknownAsync) {
        await persistRecoveryTerminalObservation(
          recoveryRuntime,
          recoveryOwnerContextFor(ctx, origin.cwd, "ordinary", origin.run_id),
          origin.cwd,
          nativeCtoResult ? "cto" : "ordinary",
          origin.run_id,
          recoveryIdentityFromOrigin(origin),
          event.toolCallId,
          outcome,
        );
      }
    }
    for (const origin of outcomes.unresolved) {
      const reconciled = reconcileTrustedTaskResult(origin.cwd, {
        run_id: origin.run_id,
        dispatch_id: origin.dispatch_id,
        tool_call_id: event.toolCallId,
        ...(origin.capability_id ? { capability_id: origin.capability_id } : {}),
        ...(origin.cursor_epoch ? { cursor_epoch: origin.cursor_epoch } : {}),
        ...(origin.slot_id ? { slot_id: origin.slot_id } : {}),
        ...(origin.task_id ? { task_id: origin.task_id } : {}),
        // The durable pending branch ignores outcome/evidence; these fields
        // remain required by its terminal input shape and are never persisted
        // when pending is true.
        outcome: "failed",
        evidence: asyncPendingEvidence ?? unresolvedEvidence,
        ...(unresolvedPendingReason
          ? { pending: true, pending_reason: unresolvedPendingReason, provider_ref: event.toolCallId }
          : {}),
      });
      if (!reconciled.ok && !reconciled.error.includes("unknown or already reconciled")) {
        console.warn("omp workflow task reconciliation failed: " + reconciled.error);
      }
    }
  });
  registerObservabilityHooks(pi, {
    enabled: opts.observability,
    toolCall: false,
    getRunId: (ctx, cwd) => opts.getSessionController?.(ctx, cwd)?.selectedRunId(),
    getEventScope: (event, _ctx, cwd) => {
      const value = event && typeof event === "object" ? event as { toolCallId?: string; toolName?: string; input?: unknown } : {};
      if (value.toolName !== "task" || !value.toolCallId) return undefined;
      const markerFilter = taskMarkerFilter(value.input);
      const origins = taskOriginsForResult(value.toolCallId, markerFilter);
      const origin = origins[0];
      return origin ? { cwd: origin.cwd, runId: origin.run_id, ...(origin.origin_session_id ? { originSessionId: origin.origin_session_id } : {}) } : undefined;
    },
  });
}
/**
 * Legacy per-call main-session heuristic. Consulted ONLY when no
 * session_start host profile was captured (older OMP runtimes without a
 * session context, and direct tool harnesses). Installed OMP deliberately
 * leaves tool-call contexts without a mode or UI in plain rpc mode
 * (main.ts passes no setToolUIContext for `--mode rpc`), so a per-call
 * `hasUI=false` cannot distinguish a main RPC session from a Task subagent
 * — authoritative session ownership comes from the captured profile.
 */
function defaultMainSession(ctx: unknown): boolean {
  if (!ctx || typeof ctx !== "object" || !("hasUI" in ctx)) return true;
  return (ctx as { hasUI?: unknown }).hasUI !== false;
}

/**
 * Host-authored UI surface used for trusted checkpoint prompting. Only
 * objects the host itself attached to a context qualify (the tool-call
 * `ui` or the session_start profile `ui`); nothing model-supplied is ever
 * consulted.
 */
interface HostAskSurface {
  askDialog?(questions: Array<{ id: string; question: string; header?: string; options: Array<{ label: string }>; multi?: boolean }>, dialogOptions?: { signal?: AbortSignal }): Promise<{
    kind: "submit";
    results: Array<Record<string, unknown>>;
  } | { kind: "chat" } | undefined>;
  select?(title: string, options: string[], dialogOptions?: { helpText?: string; signal?: AbortSignal }): Promise<string | undefined>;
}
interface HostDecisionRequest {
  id: string;
  question: string;
  header: string;
  title: string;
  allowed: string[];
  signal?: AbortSignal;
}
type HostDecisionResult =
  | { ok: true; selected: string }
  | { ok: false; kind: "unavailable" | "declined" | "aborted"; error: string };
const HOST_DECISION_KEYS: Record<string, true> = {
  id: true,
  question: true,
  options: true,
  multi: true,
  selectedOptions: true,
  customInput: true,
  customInputImages: true,
  noteImages: true,
  note: true,
  timedOut: true,
};
const HOST_DECISION_IMAGE_KEYS = ["customInputImages", "noteImages"] as const;

async function askHostDecision(surface: HostAskSurface | undefined, request: HostDecisionRequest): Promise<HostDecisionResult> {
  const declined = (error: string): HostDecisionResult => ({ ok: false, kind: "declined", error });
  const aborted = (): HostDecisionResult => ({ ok: false, kind: "aborted", error: "the host decision was canceled; nothing was authorized" });
  if (request.signal?.aborted) return aborted();
  const askDialog = typeof surface?.askDialog === "function" ? surface.askDialog.bind(surface) : undefined;
  const select = typeof surface?.select === "function" ? surface.select.bind(surface) : undefined;
  if (!askDialog && !select) return { ok: false, kind: "unavailable", error: "an interactive host decision surface is required" };
  let selected: string | undefined;
  try {
    if (askDialog) {
      const result = await askDialog([{
        id: request.id,
        question: request.question,
        header: request.header,
        options: request.allowed.map((label) => ({ label })),
        multi: false,
      }], { signal: request.signal });
      if (request.signal?.aborted) return aborted();
      if (!result || result.kind !== "submit") return declined("no submitted human decision was received");
      const results = Array.isArray(result.results) ? result.results : [];
      if (results.length !== 1) return declined("exactly one host answer is required");
      const item = results[0];
      if (!item || typeof item !== "object" || Array.isArray(item)) return declined("the host answer must be an object");
      if (Object.keys(item).some((key) => !Object.hasOwn(HOST_DECISION_KEYS, key))) return declined("the host answer contains unsupported metadata");
      if (item.id !== request.id || item.question !== request.question) return declined("the host answer does not match the current question");
      if (!Array.isArray(item.options) || item.options.length !== request.allowed.length
        || item.options.some((option, index) => option !== request.allowed[index])) {
        return declined("the host answer does not match the allowed decisions");
      }
      if (item.multi !== false) return declined("the host answer must be single-select");
      // OMP's raw dialog items include image keys even for plain selections.
      // Empty metadata is compatible; images never authorize a checkpoint.
      for (const key of HOST_DECISION_IMAGE_KEYS) {
        const images = item[key];
        if (images !== undefined && (!Array.isArray(images) || images.length !== 0)) {
          return declined("image attachments are not supported for policy-bound decisions");
        }
      }
      if (item.timedOut !== undefined && typeof item.timedOut !== "boolean") return declined("the timeout marker must be boolean");
      if (item.timedOut === true) return declined("timeout selection is not human authorization");
      if (item.customInput !== undefined && typeof item.customInput !== "string") return declined("custom input must be a string");
      if (typeof item.customInput === "string" && item.customInput.trim()) return declined("custom text is not a policy-bound decision");
      if (item.note !== undefined && typeof item.note !== "string") return declined("the host answer note must be a string");
      const selections = item.selectedOptions;
      if (!Array.isArray(selections) || selections.length !== 1 || typeof selections[0] !== "string") return declined("exactly one selected decision is required");
      selected = selections[0];
    } else if (select) {
      selected = await select(request.title, request.allowed, { helpText: request.question, signal: request.signal });
      if (request.signal?.aborted) return aborted();
    }
  } catch (error) {
    if (request.signal?.aborted) return aborted();
    throw error;
  }
  return selected && request.allowed.includes(selected)
    ? { ok: true, selected }
    : declined("no policy-allowed human decision was selected");
}
interface HostSessionProfile {
  mode: string;
  hasUI: boolean;
  ui: unknown;
  session_id?: string;
  cwd?: string;
  session_manager?: object;
  session_file?: string;
}

type HostSessionIdentity = {
  session_id?: string;
  cwd?: string;
  session_manager?: object;
  session_file?: string;
};
type LifecycleIdentityPart = Partial<HostSessionIdentity>;
type LifecycleIdentityPartResult = { valid: true; identity?: LifecycleIdentityPart } | { valid: false };
type LifecycleSessionManager = {
  getCwd?: () => unknown;
  getSessionId?: () => unknown;
  getSessionFile?: () => unknown;
};

function lifecycleStringField(value: Record<string, unknown>, key: string): { valid: boolean; value?: string } {
  if (!Object.prototype.hasOwnProperty.call(value, key)) return { valid: true };
  return typeof value[key] === "string" && value[key].length > 0
    ? { valid: true, value: value[key] }
    : { valid: false };
}

function lifecycleAliasedString(value: Record<string, unknown>, first: string, second: string): { valid: boolean; value?: string } {
  const left = lifecycleStringField(value, first);
  const right = lifecycleStringField(value, second);
  if (!left.valid || !right.valid || left.value !== undefined && right.value !== undefined && left.value !== right.value) return { valid: false };
  return { valid: true, value: left.value ?? right.value };
}

function sameLifecyclePath(left: string, right: string): boolean {
  try {
    return resolve(left) === resolve(right);
  } catch {
    return false;
  }
}

function lifecycleAliasedPath(value: Record<string, unknown>, first: string, second: string): { valid: boolean; value?: string } {
  const left = lifecycleStringField(value, first);
  const right = lifecycleStringField(value, second);
  if (!left.valid || !right.valid || left.value !== undefined && right.value !== undefined && !sameLifecyclePath(left.value, right.value)) return { valid: false };
  return { valid: true, value: left.value ?? right.value };
}

function lifecycleSessionFile(value: Record<string, unknown>, manager: LifecycleSessionManager): { valid: boolean; value?: string } {
  const supplied = lifecycleAliasedPath(value, "sessionFile", "session_file");
  if (!supplied.valid) return supplied;
  if (typeof manager.getSessionFile !== "function") return supplied;
  let managerFile: unknown;
  try {
    managerFile = manager.getSessionFile();
  } catch {
    return supplied.value === undefined ? { valid: true } : { valid: false };
  }
  if (typeof managerFile !== "string" || managerFile.length === 0) {
    return supplied.value === undefined ? { valid: true } : { valid: false };
  }
  if (supplied.value !== undefined && !sameLifecyclePath(supplied.value, managerFile)) return { valid: false };
  return { valid: true, value: managerFile };
}

function lifecycleIdentityPart(value: unknown): LifecycleIdentityPartResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { valid: true };
  const objectValue = value as Record<string, unknown>;
  const hasManager = Object.prototype.hasOwnProperty.call(objectValue, "sessionManager");
  const managerValue = objectValue.sessionManager;
  const manager = managerValue && typeof managerValue === "object" ? managerValue as LifecycleSessionManager : undefined;
  if (hasManager && (
    !manager
    || typeof manager.getCwd !== "function"
    || typeof manager.getSessionId !== "function"
  )) return { valid: false };
  if (manager) {
    let cwd: unknown;
    let sessionId: unknown;
    try {
      cwd = manager.getCwd!();
      sessionId = manager.getSessionId!();
    } catch {
      return { valid: false };
    }
    if (typeof cwd !== "string" || cwd.length === 0 || typeof sessionId !== "string" || sessionId.length === 0) return { valid: false };
    const suppliedCwd = lifecycleStringField(objectValue, "cwd");
    const suppliedSessionId = lifecycleAliasedString(objectValue, "session_id", "sessionId");
    const suppliedFile = lifecycleSessionFile(objectValue, manager);
    if (
      !suppliedCwd.valid
      || !suppliedSessionId.valid
      || !suppliedFile.valid
      || suppliedCwd.value !== undefined && !sameLifecyclePath(suppliedCwd.value, cwd)
      || suppliedSessionId.value !== undefined && suppliedSessionId.value !== sessionId
    ) return { valid: false };
    return {
      valid: true,
      identity: {
        session_id: sessionId,
        cwd,
        session_manager: manager,
        ...(suppliedFile.value ? { session_file: suppliedFile.value } : {}),
      },
    };
  }
  const cwd = lifecycleStringField(objectValue, "cwd");
  const sessionId = lifecycleAliasedString(objectValue, "session_id", "sessionId");
  const sessionFile = lifecycleAliasedPath(objectValue, "sessionFile", "session_file");
  if (!cwd.valid || !sessionId.valid || !sessionFile.valid) return { valid: false };
  return cwd.value || sessionId.value || sessionFile.value
    ? {
      valid: true,
      identity: {
        ...(cwd.value ? { cwd: cwd.value } : {}),
        ...(sessionId.value ? { session_id: sessionId.value } : {}),
        ...(sessionFile.value ? { session_file: sessionFile.value } : {}),
      },
    }
    : { valid: true };
}

function hostSessionIdentityFromContext(ctx: unknown): HostSessionIdentity {
  const result = lifecycleIdentityPart(ctx);
  return result.valid ? result.identity ?? {} : {};
}

function sameHostSessionIdentity(left: HostSessionIdentity, right: HostSessionIdentity): boolean {
  if (!left.session_id || !right.session_id || left.session_id !== right.session_id) return false;
  if (!left.cwd || !right.cwd) return false;
  try {
    if (resolve(left.cwd) !== resolve(right.cwd)) return false;
  } catch {
    return false;
  }
  if (left.session_manager || right.session_manager) {
    if (!left.session_manager || !right.session_manager || left.session_manager !== right.session_manager) return false;
  }
  if (left.session_file || right.session_file) {
    if (!left.session_file || !right.session_file || left.session_file !== right.session_file) return false;
  }
  return true;
}
function trustedInteractiveHostProfileFromContext(ctx: unknown): HostSessionProfile | null {
  if (!ctx || typeof ctx !== "object" || Array.isArray(ctx)) return null;
  const actor = "actor" in ctx ? ctx.actor : undefined;
  const mode = "mode" in ctx ? ctx.mode : undefined;
  const hasUI = "hasUI" in ctx ? ctx.hasUI : undefined;
  if (actor !== undefined && actor !== "host") return null;
  if (hasUI !== true || (mode !== "tui" && mode !== "rpc")) return null;
  const identity = hostSessionIdentityFromContext(ctx);
  if (!identity.session_id || !identity.cwd) return null;
  const ui = "ui" in ctx ? ctx.ui : undefined;
  return {
    mode,
    hasUI: true,
    ui,
    session_id: identity.session_id,
    cwd: identity.cwd,
    ...(identity.session_manager ? { session_manager: identity.session_manager } : {}),
    ...(identity.session_file ? { session_file: identity.session_file } : {}),
  };
}
function capturedHostContextIsAdmissible(profile: HostSessionProfile, ctx: unknown): boolean {
  if (!ctx || typeof ctx !== "object" || Array.isArray(ctx)) return false;
  const identity = hostSessionIdentityFromContext(ctx);
  if (!sameHostSessionIdentity({
    ...(profile.session_id ? { session_id: profile.session_id } : {}),
    ...(profile.cwd ? { cwd: profile.cwd } : {}),
    ...(profile.session_manager ? { session_manager: profile.session_manager } : {}),
    ...(profile.session_file ? { session_file: profile.session_file } : {}),
  }, identity)) return false;
  const value = ctx as Record<string, unknown>;
  if (Object.prototype.hasOwnProperty.call(value, "actor") && value.actor !== undefined && value.actor !== "host") return false;
  if (Object.prototype.hasOwnProperty.call(value, "mode") && value.mode !== undefined && value.mode !== profile.mode) return false;
  if (Object.prototype.hasOwnProperty.call(value, "hasUI") && value.hasUI !== undefined && value.hasUI !== true) return false;
  return true;
}
function trustedLifecycleHostProfileFromContext(ctx: unknown, captured: HostSessionProfile | undefined): HostSessionProfile | null {
  const profile = trustedInteractiveHostProfileFromContext(ctx);
  if (profile) return profile;
  if (!captured || !capturedHostContextIsAdmissible(captured, ctx)) return null;
  return captured;
}



type WorkflowToolResult = { content: [{ type: "text"; text: string }]; details: unknown };
type LifecycleBoundaryError = LifecycleError & { candidates?: readonly unknown[]; snapshot?: unknown };

function toolResult(value: unknown): WorkflowToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value) }], details: value };
}

/** SDK tool-call ids are opaque; persist only a namespaced canonical digest. */
function nativeStageOperationIdFromSdkCall(sdkCallId: string): string {
  if (sdkCallId.length === 0) return sdkCallId;
  const digest = createHash("sha256")
    .update("omp-workflows:cto-stage-advance:sdk-operation-id:v1\0", "utf8")
    .update(sdkCallId, "utf8")
    .digest("hex");
  return `sdk-cto-stage-${digest}`;
}

export type StageResultPublisher = (outputs: Record<string, unknown>) => StageResultSubmissionOutcome;

export interface StageProducerToolDefinition {
  name: string;
  label: string;
  description: string;
  parameters: unknown;
  execute(
    id: string,
    params: unknown,
    signal: AbortSignal | undefined,
    update: unknown,
    ctx: unknown,
    publish: StageResultPublisher,
  ): Promise<{ content: Array<{ type: "text"; text: string }>; details: unknown }>;
}

export function registerStageProducerTool(
  pi: Pick<ExtensionAPI, "registerTool">,
  definition: StageProducerToolDefinition,
): void {
  const toolName = definition.name;
  const execute = definition.execute;
  const registrationId = randomUUID();
  pi.registerTool({
    ...definition,
    name: toolName,
    async execute(id: string, params: unknown, signal: AbortSignal | undefined, update: unknown, ctx: unknown) {
      const factory = stageToolPublisherFactories.get(pi);
      if (!factory) return toolResult({ ok: false, code: "STAGE_HOST_UNSUPPORTED", error: "trusted stage producer registration is unavailable" });
      let started: StageToolPublisherStart;
      try {
        started = factory(ctx, toolName, registrationId, id);
      } catch (error) {
        return toolResult({ ok: false, code: "STAGE_HOST_FACTORY_FAILED", error: String(error) });
      }
      if (!started.ok) return toolResult(started);
      let result: { content: Array<{ type: "text"; text: string }>; details: unknown };
      try {
        result = await execute(id, params, signal, update, ctx, started.publish);
      } catch (error) {
        try {
          started.close();
        } catch (closeError) {
          return toolResult({ ok: false, code: "STAGE_PRODUCER_FAILED", error: `${String(error)}; close failed: ${String(closeError)}` });
        }
        return toolResult({ ok: false, code: "STAGE_PRODUCER_FAILED", error: String(error) });
      }
      try {
        started.close();
      } catch (error) {
        return toolResult({ ok: false, code: "STAGE_PRODUCER_CLOSE_FAILED", error: String(error) });
      }
      return result;
    },
  } as never);
}

function lifecycleCandidatesForBoundary(cwd: string, mode: "resume" | "rework" | undefined, error: unknown): unknown[] | undefined {
  if (!mode || !(error instanceof LifecycleError) || !["run_not_found", "run_selection_required", "run_terminal"].includes(error.code)) return undefined;
  try {
    const branch = resolveActiveBranch(cwd);
    return listRuns(cwd, { branch, includeTerminal: mode === "rework" });
  } catch {
    return undefined;
  }
}

function lifecycleFailure(code: string, error: unknown, candidates?: readonly unknown[]): WorkflowToolResult {
  if (error instanceof WorkflowContractError) {
    const details = { code: error.code, error: error.message };
    return toolResult({ ok: false, code, error: String(error), details });
  }
  if (!(error instanceof LifecycleError)) return toolResult({ ok: false, code, error: String(error) });
  const boundaryError = error as LifecycleBoundaryError;
  const exactCandidates = boundaryError.candidates ?? candidates;
  const details = {
    ...error.toJSON(),
    ...(exactCandidates !== undefined ? { candidates: [...exactCandidates] } : {}),
    ...(boundaryError.snapshot !== undefined ? { snapshot: boundaryError.snapshot } : {}),
  };
  return toolResult({ ok: false, code, error: String(error), details });
}

function workflowStateSummary(cwd: string, mappingSummary?: (cwd: string) => unknown, runId?: string, _requireSelectedRun = false): unknown {
  if (!runId) return { ok: false, code: "no_active_run", error: "no canonical workflow run is selected for this trusted session" };
  const state = readRunState(cwd, runId);
  if (!state) return { ok: false, code: "WORKFLOW_RUN_NOT_FOUND", error: `run ${runId} was not found` }; 
  const capability = state.dispatch_capability;
  return {
    ok: true,
    run_id: runId,
    state_path: runStatePath(cwd, runId),
    branch: state.branch,
    workflow: state.classification?.workflow,
    profile_hash: state.profile_hash,
    stage_cursor: state.stage_cursor,
    cursor_epoch: state.cursor_epoch,
    stages: state.stages,
    pause: state.pause,
    agent_mapping: mappingSummary?.(cwd) ?? null,
    join_summary: state.join_summary,
    capability: capability
      ? {
          capability_id: capability.capability_id,
          kind: capability.kind,
          status: capability.status,
          expected_roles: capability.expected_roles,
          dispatches: (capability.dispatches ?? []).map(dispatch => ({
            id: dispatch.id,
            role: dispatch.role,
            agent: dispatch.agent,
            tool_call_id: dispatch.tool_call_id,
            status: dispatch.status,
            completed: Boolean(dispatch.completion),
            completed_by: dispatch.completion?.completed_by,
            artifact_ids: dispatch.completion?.artifact_ids ?? [],
            outcome: dispatch.completion?.outcome,
          })),
        }
      : null,
  };
}
function resolveToolRunId(cwd: string, selector?: LifecycleSelector, controller?: WorkflowSessionController): string | undefined {
  if (!selector) return controller?.selectedRunId();
  if (selector.run_id) return selector.run_id;
  const branch = resolveActiveBranch(cwd);
  const candidates = listRuns(cwd, { branch, includeTerminal: true });
  const snapshot = selector.list_item ? readSelectionSnapshot(cwd, selector.list_item.snapshot_id) : undefined;
  const resolved = resolveRunSelection({ mode: "rework", candidates, currentBranch: branch, selector, snapshot });
  if (!resolved.ok) {
    const boundaryError = resolved.error as LifecycleBoundaryError;
    boundaryError.candidates = resolved.candidates;
    if (resolved.snapshot) boundaryError.snapshot = retainSelectionSnapshot(cwd, resolved.snapshot);
    throw boundaryError;
  }
  return resolved.candidate.run_id;
}


/**
 * Core-owned typed workflow tool registration. Bundles adapt only cwd,
 * mapping and owner identity; preparation, checkpoint, completion and cursor
 * transitions remain one engine implementation.
 */
export function registerWorkflowTools(pi: ExtensionAPI, options: WorkflowToolAdapterOptions = {}): void {
  if (!pi.zod) return;
  if (options.cwd && options.owner) assertOwner(options.cwd, ["workflow_tools"], options.owner);
  const { z } = pi.zod;
  const emptyParameters = z.object({}) as never;
  const resolveCwd = options.resolveCwd ?? resolveCwdFromContext;
  const stageBindingResolver = options.resolveStageHostBinding ?? stageBindingResolvers.get(pi as unknown as object);
  const stageResultCommitter = stageResultCommitters.get(pi as unknown as object);
  const nativeWorkerAuthority = nativeWorkerAuthorities.get(pi as unknown as object);
  const existingRecoveryRuntime = stageRecoveryRuntimes.get(pi as unknown as object);
  if (existingRecoveryRuntime && options.stageRecoveryHost) {
    stageRecoveryRuntimes.set(pi as unknown as object, { ...existingRecoveryRuntime, host: options.stageRecoveryHost });
  } else if (!existingRecoveryRuntime && options.getSessionController) {
    const recoveryStoreFor = (ctx: unknown, cwd: string): AuthenticatedStageRecoveryStore | undefined => {
      try {
        const controller = options.getSessionController!(ctx, cwd);
        if (!controller) return undefined;
        return recoveryStoreForController(controller, cwd);
      } catch {
        return undefined;
      }
    };
    stageRecoveryRuntimes.set(pi as unknown as object, {
      storeFor: recoveryStoreFor,
      host: options.stageRecoveryHost ?? createStageRecoveryHost(pi),
      staleAdmissions: new WeakMap(),
      automaticPending: new Set(),
      automaticOpen: true,
    });
  }
  // Authoritative host session profile, captured once per session: the host
  // fires session_start only after the runner is initialized with the
  // runtime mode and the mode's UI context, so the handler observes the
  // final values.
  let hostSession: HostSessionProfile | null = null;
  let sessionController: WorkflowSessionController | null = null;
  const ownerRecoveryRuntime = stageRecoveryRuntimes.get(pi as unknown as object);
  if (ownerRecoveryRuntime && !ownerRecoveryRuntime.ownerStoreFor) {
    ownerRecoveryRuntime.ownerStoreFor = (cwd, runId, authority) => {
      const controller = sessionController;
      if (!controller) return undefined;
      try {
        const context = controller.context();
        if (!context.worktree || resolve(context.worktree) !== resolve(cwd)) return undefined;
        if (authority === "cto") {
          const claim = controller.activeCtoClaim();
          if (!claim || claim.run_id !== runId) return undefined;
          return createNativeStageRecoveryStore(cwd, { context, runId, claim_scope: claim });
        }
        return controller.selectedRunId() === runId
          && controller.activeClaimRunId() === runId
          ? createOrdinaryStageRecoveryStore(cwd, { context, runId })
          : undefined;
      } catch {
        return undefined;
      }
    };
  }
  let lifecycleRevoked = false;
  if (typeof (pi as { on?: unknown }).on === "function") {
    const resolveIncomingController = (profile: HostSessionProfile, ctx: unknown): WorkflowSessionController | null => {
      if (!options.getSessionController || !profile.cwd) return null;
      try {
        const controller = options.getSessionController(ctx, profile.cwd);
        if (!controller) return null;
        const controllerContext = controller.context();
        if (
          controllerContext.session_id !== profile.session_id
          || resolve(controllerContext.worktree) !== resolve(profile.cwd)
        ) return null;
        return controller;
      } catch {
        return null;
      }
    };
    const profileIdentity = (profile: HostSessionProfile | null): HostSessionIdentity => profile
      ? {
        ...(profile.session_id ? { session_id: profile.session_id } : {}),
        ...(profile.cwd ? { cwd: profile.cwd } : {}),
        ...(profile.session_manager ? { session_manager: profile.session_manager } : {}),
        ...(profile.session_file ? { session_file: profile.session_file } : {}),
      }
      : {};
    const createLocalController = (profile: HostSessionProfile): WorkflowSessionController | null => {
      if (options.getSessionController || !profile.session_id || !profile.cwd) return null;
      try {
        const branch = resolveActiveBranch(profile.cwd);
        const context: TrustedExecutionContext = {
          session_id: profile.session_id,
          caller: "host",
          process_id: process.pid,
          worktree: profile.cwd,
          branch,
          authority: "coordinator",
        };
        return createWorkflowSessionController({ cwd: profile.cwd, context });
      } catch {
        return null;
      }
    };
    pi.on("session_start", (event: unknown, ctx: unknown) => {
      if (!sessionSwitchActorIsAdmissible(event, ctx) || !lifecycleEventIdentityIsAdmissible(event, ctx, "session_start")) return;
      const incoming = trustedLifecycleHostProfileFromContext(ctx, hostSession ?? undefined);
      if (!incoming) return;
      const incomingIdentity = profileIdentity(incoming);
      if (hostSession && !sameHostSessionIdentity(profileIdentity(hostSession), incomingIdentity)) {
        // session_start is not a replacement proof; wait for session_switch.
        return;
      }
      const recoveryRuntime = stageRecoveryRuntimes.get(pi as unknown as object);
      if (recoveryRuntime) recoveryRuntime.automaticOpen = true;
      const incomingController = resolveIncomingController(incoming, ctx);
      hostSession = incoming;
      sessionController = incomingController ?? (hostSession ? sessionController : null) ?? createLocalController(incoming);
      lifecycleRevoked = false;
      if (incomingController && incoming.cwd && controllerHasActiveRecoveryOwner(incomingController)) {
        scheduleAutomaticRecoveryScan(recoveryRuntime, ctx, incoming.cwd);
      }
    });
    pi.on("session_switch", async (event: unknown, ctx: unknown) => {
      const prior = hostSession;
      const incoming = trustedLifecycleHostProfileFromContext(ctx, prior ?? undefined);
      if (
        !incoming
        || !prior
        || !sessionSwitchActorIsAdmissible(event, ctx)
        || !lifecycleEventIdentityIsAdmissible(event, ctx, "session_switch")
      ) return;
      const priorIdentity = profileIdentity(prior);
      const incomingIdentity = profileIdentity(incoming);
      if (
        !priorIdentity.session_manager
        || !incomingIdentity.session_manager
        || priorIdentity.session_manager !== incomingIdentity.session_manager
        || !priorIdentity.session_id
        || priorIdentity.session_id === incomingIdentity.session_id
      ) return;
      const switchEvent = event && typeof event === "object" && !Array.isArray(event) ? event : {};
      const eventType = "type" in switchEvent ? switchEvent.type : undefined;
      const reason = "reason" in switchEvent ? switchEvent.reason : undefined;
      const previousSessionFile = "previousSessionFile" in switchEvent && typeof switchEvent.previousSessionFile === "string" && switchEvent.previousSessionFile.length > 0
        ? switchEvent.previousSessionFile
        : undefined;
      if (
        eventType !== "session_switch"
        || (reason !== "new" && reason !== "resume" && reason !== "fork")
      ) return;
      if (
        !priorIdentity.session_file
        || !previousSessionFile
        || priorIdentity.session_file !== previousSessionFile
      ) return;
      const oldController = sessionController;
      let oldCto: CtoClaimScope | undefined;
      try {
        oldCto = oldController?.activeCtoClaim();
      } catch {
        // A stale private claim must not fall through to ordinary release or
        // reset the incoming binding.
        return;
      }
      let oldOrdinaryClaim = false;
      if (!oldCto) {
        try { oldOrdinaryClaim = oldController?.activeClaimRunId() !== undefined; } catch { return; }
      }
      const recoveryRuntime = stageRecoveryRuntimes.get(pi as unknown as object);
      if (recoveryRuntime) {
        recoveryRuntime.automaticOpen = false;
        await drainAutomaticRecovery(recoveryRuntime);
      }
      if (oldCto || oldOrdinaryClaim) {
        try {
          if (oldCto && oldController) suspendCtoSession(oldController, "session-replacement");
          else oldController?.release("host-session-replaced");
        } catch {
          return;
        }
      }
      const incomingController = resolveIncomingController(incoming, ctx);
      hostSession = incoming;
      sessionController = incomingController ?? createLocalController(incoming);
      lifecycleRevoked = false;
      if (recoveryRuntime) recoveryRuntime.automaticOpen = true;
      if (incomingController && incoming.cwd && controllerHasActiveRecoveryOwner(incomingController)) {
        scheduleAutomaticRecoveryScan(recoveryRuntime, ctx, incoming.cwd);
      }
    });
    // session_shutdown is a type-only disposal event; replacement uses session_switch.
    pi.on("session_shutdown", async (event: unknown, ctx: unknown) => {
      if (!sessionSwitchActorIsAdmissible(event, ctx) || !lifecycleEventIdentityIsAdmissible(event, ctx, "session_shutdown")) return;
      const incoming = trustedLifecycleHostProfileFromContext(ctx, hostSession ?? undefined);
      if (!incoming || !hostSession || !sameHostSessionIdentity(profileIdentity(hostSession), profileIdentity(incoming))) return;
      const recoveryRuntime = stageRecoveryRuntimes.get(pi as unknown as object);
      if (recoveryRuntime) {
        recoveryRuntime.automaticOpen = false;
        await drainAutomaticRecovery(recoveryRuntime);
      }
      try {
        const cto = sessionController?.activeCtoClaim();
        if (cto && sessionController) suspendCtoSession(sessionController, "session-shutdown");
        else sessionController?.release("host-session-shutdown");
      } catch {
        // Keep durable claim bytes untouched on a release failure; the
        // local binding is still revoked so stale authority cannot survive.
      } finally {
        lifecycleRevoked = true;
        sessionController = null;
        hostSession = null;
      }
    });
  }
  /**
   * The captured profile, but only when it names a trusted interactive
   * surface: a terminal TUI or a connected RPC client with a UI. json/print
   * headless runs and Task subagent/worker sessions (mode "print", no UI)
   * never qualify.
   */
  const trustedInteractiveProfile = (): HostSessionProfile | null =>
    hostSession !== null && hostSession.hasUI && (hostSession.mode === "tui" || hostSession.mode === "rpc") ? hostSession : null;
  const contextError = (ctx: unknown): WorkflowToolResult | null => {
    if (lifecycleRevoked) {
      return toolResult({ ok: false, code: "WORKFLOW_CONTEXT_REJECTED", error: "workflow host lifecycle identity was revoked; wait for a new trusted session_start" });
    }
    // Session ownership: the captured host profile is authoritative. The
    // per-call context cannot make this call — a plain-rpc main session and a
    // Task subagent report identical tool contexts (hasUI=false, no ui).
    // The bundle callback (or the legacy per-call heuristic) decides only
    // when no session_start profile was captured.
    const ownsTools = hostSession !== null
      ? trustedInteractiveProfile() !== null
        && capturedHostContextIsAdmissible(hostSession, ctx)
      : (options.isMainSession ?? defaultMainSession)(ctx);
    if (!ownsTools) {
      return toolResult({
        ok: false,
        code: "WORKFLOW_CONTEXT_REJECTED",
        error: "workflow control tools are available only in the interactive main session (terminal TUI or connected RPC client)",
      });
    }
    if (hostSession !== null && !hostSession.session_id && !sessionIdFromContext(ctx)) {
      return toolResult({ ok: false, code: "WORKFLOW_CONTEXT_REJECTED", error: "trusted session identity is unavailable; bind through the host session manager" });
    }
    const cwd = options.cwd ?? resolveCwd(ctx);
    if (!cwd) return toolResult({ ok: false, code: "WORKFLOW_STATE_UNAVAILABLE", error: "workflow cwd unavailable" });
    if (options.getSessionController && !options.getSessionController(ctx, cwd)) {
      return toolResult({ ok: false, code: "WORKFLOW_CONTEXT_REJECTED", error: "shared workflow session controller is unavailable" });
    }
    try {
      assertOwner(cwd, ["workflow_tools"], options.owner);
    } catch (error) {
      return toolResult({ ok: false, code: "WORKFLOW_OWNER_REJECTED", error: String(error) });
    }
    return null;
  };
  const currentCwd = (ctx: unknown): string | undefined => options.cwd ?? resolveCwd(ctx);
  const controllerFor = (ctx: unknown, cwd: string): WorkflowSessionController => {
    const shared = options.getSessionController?.(ctx, cwd);
    if (options.getSessionController && !shared) throw new Error("WORKFLOW_CONTEXT_REJECTED: shared workflow session controller is unavailable");
    if (shared) {
      sessionController = shared;
      return shared;
    }
    if (sessionController) {
      const existing = sessionController;
      let existingContext: TrustedExecutionContext | undefined;
      try {
        existingContext = existing.context();
      } catch {
        existingContext = undefined;
      }
      if (existingContext && resolve(existingContext.worktree) === resolve(cwd)) {
        const branch = resolveActiveBranch(cwd);
        if (existingContext.branch === branch) return existing;
        try {
          if (
            existing.activeCtoClaim() !== undefined
            || existing.activeClaimRunId() !== undefined
            || existing.selectedRunId() !== undefined
          ) return existing;
        } catch {
          return existing;
        }
        sessionController = createWorkflowSessionController({
          cwd,
          context: {
            ...existingContext,
            process_id: process.pid,
            branch,
          },
        });
        return sessionController;
      }
    }
    const sessionId = hostSession?.session_id ?? sessionIdFromContext(ctx);
    if (!sessionId) throw new Error("WORKFLOW_CONTEXT_REJECTED: trusted session identity is unavailable");
    const branch = resolveActiveBranch(cwd);
    sessionController = createWorkflowSessionController({ cwd, context: { session_id: sessionId, caller: "host", process_id: process.pid, worktree: cwd, branch, authority: "coordinator" } });
    return sessionController;
  };
  const stageTargetFor = (ctx: unknown, cwd: string): { runId: string; authority: StageAuthority } | null => {
    let controller: WorkflowSessionController | undefined;
    try {
      controller = options.getSessionController?.(ctx, cwd);
    } catch {
      controller = undefined;
    }
    let ctoRunId: string | undefined;
    try {
      ctoRunId = controller?.activeCtoClaim()?.run_id;
    } catch {
      ctoRunId = undefined;
    }
    const runId = ctoRunId
      ?? (() => {
        try {
          return controller?.selectedRunId() ?? readRunControlNoRecovery(cwd).execution_claim?.run_id ?? undefined;
        } catch {
          return undefined;
        }
      })();
    if (!runId) return null;
    const authority: StageAuthority = ctoRunId || readCtoState(runId, cwd) ? "cto" : "ordinary";
    return { runId, authority };
  };
  type AcceptedReplayCandidate = { readonly identity: WorkIdentity; readonly receipt: StageReceiptLedger };
  const acceptedReplayProjection = (candidate: AcceptedReplayCandidate): StageResultSubmissionOutcome | undefined => {
    const receipt = candidate.receipt;
    if (
      receipt.dispatch_id !== candidate.identity.dispatch_id
      || receipt.attempt !== candidate.identity.attempt
      || !receipt.binding
      || typeof receipt.binding !== "object"
      || Array.isArray(receipt.binding)
    ) return undefined;
    return {
      ok: true,
      receipt: receiptFromLedger(receipt.binding as StageProducerBinding, receipt),
    };
  };
  const acceptedReplay = (
    ctx: unknown,
    cwd: string,
    runId: string,
    outputs: Record<string, unknown>,
  ): StageResultSubmissionOutcome | undefined => {
    const lineage = nativeAcceptedReplayLineage(ctx, cwd);
    const root = nativeWorkerAuthority?.resolveRootAuthority(cwd, runId);
    if (!lineage || !root || root.run_id !== runId || root.context.authority !== "coordinator") return undefined;
    const rootContext: TrustedExecutionContext = { ...root.context, authority: "coordinator" };
    if (
      !rootContext.worktree
      || resolve(rootContext.worktree) !== resolve(cwd)
      || !rootContext.branch
    ) return undefined;
    if (root.authority === "ordinary") {
      const candidate = findAcceptedOrdinaryStageReceipt({
        cwd,
        runId,
        lineage,
        root: { context: rootContext, outputs },
      });
      return candidate ? acceptedReplayProjection(candidate) : undefined;
    }
    const claim = root.claim_scope;
    if (!claim || claim.run_id !== runId) return undefined;
    const candidate = findNativeAcceptedStageReceipt({
      cwd,
      runId,
      lineage,
      root: { context: rootContext, claim_scope: claim, outputs },
    });
    return candidate ? acceptedReplayProjection(candidate) : undefined;
  };
  const requireActiveClaimForMutation = (controller: WorkflowSessionController, expectedRunId?: string): WorkflowToolResult | null => {
    try {
      const selectedRunId = controller.selectedRunId();
      if (!selectedRunId) {
        if (!expectedRunId) return null;
      } else if ((!expectedRunId || selectedRunId === expectedRunId) && controller.activeClaimRunId() === selectedRunId) {
        return null;
      }
    } catch {
      // A canonical read error is not evidence of authority.
    }
    return toolResult({
      ok: false,
      code: "WORKFLOW_CONTEXT_REJECTED",
      error: "a workflow run is selected but this session does not hold its active execution claim; call workflow_prepare to rebind",
    });
  };
  const resolveProducerBinding: StageHostBindingResolver = (ctx, cwd, runId, authority) => {
    const native = stageBindingResolver?.(ctx, cwd, runId, authority);
    if (native) return native;
    if (authority !== "ordinary" || contextError(ctx)) return undefined;
    const controller = controllerFor(ctx, cwd);
    if (requireActiveClaimForMutation(controller, runId)) return undefined;
    return deriveMainStageHostBinding({ cwd, runId, context: controller.context() }) ?? undefined;
  };
  stageToolPublisherFactories.set(pi as unknown as object, (ctx, toolName, registrationId, invocationId) => {
    const denied = () => ({
      ok: false as const,
      code: "producer_authority_denied",
      error: "the registered callback does not own the current declared producer assignment",
    });
    const cwd = currentCwd(ctx);
    const sessionId = sessionIdFromContext(ctx);
    if (!cwd || !sessionId || !invocationId) return denied();
    const target = stageTargetFor(ctx, cwd);
    if (!target) return denied();
    const callback = createTrustedToolCallback({
      registration_id: registrationId,
      invocation_id: invocationId,
      host_session_id: sessionId,
    });
    const resolveCallbackBinding = (): StageHostBinding | undefined => {
      const currentTarget = stageTargetFor(ctx, cwd);
      if (!currentTarget || currentTarget.runId !== target.runId || currentTarget.authority !== target.authority) return undefined;
      if (target.authority === "cto") {
        return stageToolBindingResolvers.get(pi as unknown as object)?.(ctx, cwd, target.runId, toolName, callback);
      }
      if (contextError(ctx)) return undefined;
      const controller = controllerFor(ctx, cwd);
      if (requireActiveClaimForMutation(controller, target.runId)) return undefined;
      return deriveMainStageHostBinding({
        cwd,
        runId: target.runId,
        context: controller.context(),
        toolName,
        callback,
      }) ?? undefined;
    };
    const captured = resolveCallbackBinding();
    if (!captured) return denied();
    let active = true;
    const bindingResolver: StageHostBindingResolver = () => {
      if (!active) return undefined;
      const current = resolveCallbackBinding();
      return current && isDeepStrictEqual(current.binding, captured.binding) ? captured : undefined;
    };
    return {
      ok: true,
      publish: (outputs) => {
        if (!active) return denied();
        return submitStageResult({
          cwd,
          runId: target.runId,
          authority: target.authority,
          context: ctx,
          bindingResolver,
          ...(stageResultCommitter ? { ctoCommitter: stageResultCommitter } : {}),
        }, { outputs });
      },
      close: () => { active = false; },
    };
  });
  pi.registerTool({
    name: "cto_state",
    label: "Read or commit CTO state",
    description: "Read the exact authenticated CTO run state or commit a revision-checked candidate through the engine-owned lifecycle transaction. Canonical CTO state must not be written with Write, Edit, or Bash.",
    parameters: z.object({
      operation: z.enum(["read", "commit"]),
      run_id: z.string().min(1),
      expected_state_revision: z.string().min(1).optional(),
      state: z.unknown().optional(),
    }).strict() as never,
    async execute(_id, params, _signal, _update, ctx) {
      const denied = contextError(ctx);
      if (denied) return denied;
      const cwd = currentCwd(ctx);
      if (!cwd) return toolResult({ ok: false, code: "WORKFLOW_STATE_UNAVAILABLE", error: "workflow cwd unavailable" });
      const input = params as {
        operation: "read" | "commit";
        run_id: string;
        expected_state_revision?: string;
        state?: unknown;
      };
      try {
        const controller = controllerFor(ctx, cwd);
        if (input.operation === "read") {
          const result = readCtoStateForModel(controller, cwd, input.run_id);
          return toolResult({
            ok: true,
            operation: "read",
            run_id: input.run_id,
            state: result.state,
            state_revision: result.state_revision,
          });
        }
        if (!input.expected_state_revision || input.state === undefined) {
          return toolResult({
            ok: false,
            code: "CTO_STATE_REJECTED",
            error: "cto_state commit requires state and the exact state_revision returned by read",
          });
        }
        const result = commitCtoStateForModel({
          controller,
          cwd,
          run_id: input.run_id,
          expected_state_revision: input.expected_state_revision,
          state: input.state,
        });
        return toolResult({
          ok: true,
          operation: "commit",
          run_id: input.run_id,
          state: result.state,
          state_revision: result.state_revision,
          transition: result.transition,
        });
      } catch (error) {
        return lifecycleFailure("CTO_STATE_REJECTED", error);
      }
    },
  });
  pi.registerTool({
    name: "cto_stage_advance",
    label: "Advance native CTO stage",
    description: "Advance the current native CTO stage for one exact slice after canonical readiness. The host derives the active claim, current team, cursor, outputs, and approval; model input supplies only slice_id.",
    parameters: z.object({ slice_id: z.string().min(1) }).strict() as never,
    async execute(id, params, _signal, _update, ctx) {
      const denied = contextError(ctx);
      if (denied) return denied;
      const cwd = currentCwd(ctx);
      if (!cwd) return toolResult({ ok: false, code: "CTO_STATE_UNAVAILABLE", error: "workflow cwd unavailable" });
      try {
        const controller = controllerFor(ctx, cwd);
        const claim = controller.activeCtoClaim();
        if (!claim) return toolResult({ ok: false, code: "WORKFLOW_CONTEXT_REJECTED", error: "the session does not own an active CTO run" });
        const context = controller.context();
        const input = params as { slice_id: string };
        const result: NativeStageMutationResult = advanceNativeStageForCoordinator({
          cwd,
          runId: claim.run_id,
          sliceId: input.slice_id,
          coordinator_session_id: context.session_id,
          ownership_epoch: claim.ownership_epoch,
          ...(context.process_id === undefined ? {} : { coordinator_process_id: context.process_id }),
          operation_id: nativeStageOperationIdFromSdkCall(id),
        });
        return result.ok
          ? toolResult({ ok: true, transition: "cto_stage_advance", run_id: claim.run_id, slice_id: input.slice_id, progress: result.progress })
          : toolResult(result);
      } catch (error) {
        return toolResult({ ok: false, code: "CTO_STAGE_ADVANCE_FAILED", error: String(error) });
      }
    },
  });
  pi.registerTool({
    name: "cto_checkpoint_ask",
    label: "Ask for native CTO checkpoint approval",
    description: "Ask the human for the current profile-declared checkpoint of an assigned CTO slice. The host derives the active CTO run, ownership, stage, result version, and allowed decisions; model input cannot supply an approval.",
    parameters: z.object({ slice_id: z.string().min(1) }).strict() as never,
    async execute(_id, params, signal, _update, ctx) {
      const denied = contextError(ctx);
      if (denied) return denied;
      const cwd = currentCwd(ctx);
      if (!cwd) return toolResult({ ok: false, code: "CTO_STATE_UNAVAILABLE", error: "workflow cwd unavailable" });
      const aborted = () => toolResult({ ok: false, code: "CTO_CHECKPOINT_ASK_ABORTED", error: "the native checkpoint question was canceled; no approval was recorded" });
      if (signal?.aborted) return aborted();
      try {
        const controller = controllerFor(ctx, cwd);
        const claim = controller.activeCtoClaim();
        if (!claim) return toolResult({ ok: false, code: "WORKFLOW_CONTEXT_REJECTED", error: "the session does not own an active CTO run" });
        const state = readCtoState(claim.run_id, cwd);
        const { slice_id: sliceId } = params as { slice_id: string };
        const teams = state?.teams.filter((team) => team.slice_id === sliceId) ?? [];
        if (teams.length !== 1) return toolResult({ ok: false, code: "CTO_SLICE_REJECTED", error: "the requested slice does not identify one current native team" });
        const teamId = teams[0]!.id;
        const context = controller.context();
        const authority = {
          run_id: claim.run_id,
          coordinator_session_id: context.session_id,
          coordinator_process_id: context.process_id,
          ownership_epoch: claim.ownership_epoch,
          team_id: teamId,
        };
        const checked = preflightNativeStageCheckpoint(cwd, claim.run_id, teamId, authority);
        if (!checked.ok) return toolResult(checked);
        const preflight = checked.preflight;
        if (preflight.current_approval) {
          return toolResult({ ok: true, transition: "cto_checkpoint_answer", already_recorded: true, approval: preflight.current_approval });
        }
        if (preflight.default === "autonomous_allowed" && preflight.allowed_decisions.includes("proceed")) {
          if (signal?.aborted) return aborted();
          const contextDenied = contextError(ctx);
          if (contextDenied) return contextDenied;
          const currentClaim = controller.activeCtoClaim();
          if (!currentClaim || currentClaim.run_id !== claim.run_id || currentClaim.ownership_epoch !== claim.ownership_epoch) {
            return toolResult({ ok: false, code: "WORKFLOW_CONTEXT_REJECTED", error: "CTO ownership changed before policy-auto checkpoint authorization" });
          }
          const decision = "proceed" as const;
          const committed = commitNativeStageCheckpoint({
            cwd,
            runId: claim.run_id,
            teamId,
            authority,
            witness: preflight,
            expected_revision: preflight.revision,
            approval_id: randomUUID(),
            decision,
            source: "policy-auto",
          });
          return committed.ok
            ? toolResult({ ok: true, transition: "cto_checkpoint_answer", approval: committed.approval })
            : toolResult(committed);
        }
        const toolContext = ctx as unknown as { hasUI?: boolean; ui?: HostAskSurface };
        const surface = toolContext.hasUI === true && toolContext.ui
          ? toolContext.ui
          : trustedInteractiveProfile()?.ui as HostAskSurface | undefined;
        const answer = await askHostDecision(surface, {
          id: `cto-checkpoint:${preflight.checkpoint}:${preflight.identity_scope.capability_epoch}`,
          question: `Authorize native CTO checkpoint '${preflight.checkpoint}' for slice '${sliceId}', stage '${preflight.stage_id}', iteration ${preflight.iteration}. This decision applies only to the current result and profile scope.`,
          header: `${claim.run_id}/${sliceId}/${preflight.stage_id}`,
          title: `Authorize CTO checkpoint '${preflight.checkpoint}'`,
          allowed: [...preflight.allowed_decisions],
          signal,
        });
        if (!answer.ok) {
          if (answer.kind === "aborted") return aborted();
          return toolResult({
            ok: false,
            code: answer.kind === "unavailable" ? "CTO_CHECKPOINT_ASK_UNAVAILABLE" : "CTO_CHECKPOINT_DECLINED",
            error: answer.error,
          });
        }
        if (signal?.aborted) return aborted();
        const contextDenied = contextError(ctx);
        if (contextDenied) return contextDenied;
        const currentClaim = controller.activeCtoClaim();
        if (!currentClaim || currentClaim.run_id !== claim.run_id || currentClaim.ownership_epoch !== claim.ownership_epoch) {
          return toolResult({ ok: false, code: "WORKFLOW_CONTEXT_REJECTED", error: "CTO ownership changed while awaiting the human decision" });
        }
        const committed = commitNativeStageCheckpoint({
          cwd,
          runId: claim.run_id,
          teamId,
          authority,
          witness: preflight,
          expected_revision: preflight.revision,
          approval_id: randomUUID(),
          decision: answer.selected,
          source: "human",
        });
        return committed.ok
          ? toolResult({ ok: true, transition: "cto_checkpoint_answer", approval: committed.approval })
          : toolResult(committed);
      } catch (error) {
        return lifecycleFailure("CTO_CHECKPOINT_ASK_FAILED", error);
      }
    },
  });
  const classificationParameters = z.object({
    type: z.enum(["FEATURE", "REFACTOR", "OPS", "BUG_FIX", "SPEC", "REGRESS", "INVESTIGATION", "REVIEW", "HOTFIX", "PRODUCT_DISCOVERY"]),
    complexity: z.enum(["QUICK", "MEDIUM", "COMPLEX", "CRITICAL"]),
    confidence: z.enum(["HIGH", "MEDIUM", "LOW"]),
    autonomous: z.boolean(),
    autonomous_reason: z.string().optional(),
    workflow: z.string().optional(),
  });
  pi.registerTool({
    name: "workflow_prepare",
    label: "Prepare workflow state",
    description: "Persist an explicit new, resume, or rework lifecycle request; resolve every resume/rework target through read-only selectors before mutation. For rework, feedback must be mapped to a non-blank affected_stage from the selected profile before this tool is called; this field is conditionally required and whitespace is invalid. The request is revalidated under the workspace lock.",
    parameters: z.object({
      mode: z.enum(["new", "resume", "rework"]).default("new"),
      task: z.string().min(1).optional(),
      branch: z.string().min(1).optional(),
      run_id: z.string().min(1).optional(),
      command_intent_id: z.string().min(1).optional(),
      selector: z.object({
        run_id: z.string().min(1).optional(),
        title: z.string().min(1).optional(),
        list_item: z.object({ snapshot_id: z.string().min(1), index: z.number().int().min(0), run_id: z.string().min(1) }).strict().optional(),
      }).strict().optional(),
      feedback: z.string().min(1).optional(),
      affected_stage: z.string().optional(),
      classification: classificationParameters.optional(),
      files: z.array(z.string().min(1)).optional(),
      issue: z.union([z.number().int(), z.object({ number: z.number().int(), url: z.string().optional() })]).nullable().default(null),
    }) as never,
    async execute(_id, params, _signal, _update, ctx) {
      const denied = contextError(ctx);
      if (denied) return denied;
      const cwd = currentCwd(ctx);
      if (!cwd) return toolResult({ ok: false, code: "WORKFLOW_STATE_UNAVAILABLE", error: "workflow cwd unavailable" });
      const input = params as {
        mode?: "new" | "resume" | "rework";
        task?: string;
        branch?: string;
        run_id?: string;
        command_intent_id?: string;
        selector?: LifecycleSelector;
        feedback?: string;
        affected_stage?: string;
        classification?: ModelClassification;
        files?: string[];
        issue?: number | { number: number; url?: string } | null;
      };
      const mode = input.mode ?? "new";
      const selectionMode: "resume" | "rework" | undefined = mode === "new" ? undefined : mode;
      if (mode === "new" && (!input.task || !input.classification)) {
        return toolResult({ ok: false, code: "WORKFLOW_PREPARE_REJECTED", error: "new workflow preparation requires task and complete classification" });
      }
      if (mode === "rework" && !input.affected_stage?.trim()) {
        return lifecycleFailure(
          "WORKFLOW_PREPARE_FAILED",
          new LifecycleError(
            "lifecycle_request_conflict",
            "rework requires a non-blank affected_stage selected from the target workflow profile",
            {
              ...(input.run_id ? { run_id: input.run_id } : {}),
              next_action: "call workflow_status with the exact selector, then workflow_instructions with the same selector; map feedback to profile.stages and retry workflow_prepare with affected_stage",
            },
          ),
        );
      }
      if (mode === "rework" && !input.feedback) {
        return toolResult({ ok: false, code: "WORKFLOW_PREPARE_REJECTED", error: "rework requires feedback" });
      }
      try {
        const controller = controllerFor(ctx, cwd);
        // Resolve selector identity before consuming an explicit command intent.
        // The selector is read-only; prepare resolves it again under the
        // workspace lock. This lets a selector.run_id/list item satisfy an
        // ingress-bound --run without requiring a duplicate top-level alias.
        let resolvedSelectionRunId: string | undefined;
        if (selectionMode && input.selector) {
          const resolved = controller.readSelector().resolve(selectionMode, input.selector);
          if (!resolved.ok) {
            const boundaryError = resolved.error as LifecycleBoundaryError;
            boundaryError.candidates = resolved.candidates;
            if (resolved.snapshot) boundaryError.snapshot = resolved.snapshot;
            throw boundaryError;
          }
          resolvedSelectionRunId = resolved.candidate.run_id;
          if (input.run_id && input.run_id !== resolvedSelectionRunId) {
            throw new LifecycleError(
              "lifecycle_request_conflict",
              `workflow_prepare run_id '${input.run_id}' does not match the resolved selector run '${resolvedSelectionRunId}'`,
              { run_id: input.run_id },
            );
          }
        }
        const commandIntent = controller.consumeCommandIntent({
          command_intent_id: input.command_intent_id,
          mode,
          ...(input.run_id
            ? { run_id: input.run_id }
            : resolvedSelectionRunId
              ? { run_id: resolvedSelectionRunId }
              : {}),
        });
        const prepared = controller.prepare({
          mode,
          task: input.task,
          run_id: input.run_id,
          selector: input.selector,
          feedback: input.feedback,
          affected_stage: input.affected_stage,
          autonomous: input.classification?.autonomous ?? false,
          classification: input.classification,
          files: input.files,
          issue: typeof input.issue === "number" ? { number: input.issue } : input.issue ?? null,
          request_id: typeof _id === "string" && _id.length > 0 ? _id : undefined,
        });
        if (commandIntent) controller.commitCommandIntent(commandIntent.intent_id);
        if (controllerHasActiveRecoveryOwner(controller)) {
          scheduleAutomaticRecoveryScan(stageRecoveryRuntimes.get(pi as unknown as object), ctx, cwd);
        }
        return toolResult({
          ok: true,
          transition: prepared.transition,
          state_path: prepared.statePath,
          artifacts_dir: prepared.artifactsDir,
          workflow: prepared.profile.name,
          classification: prepared.classification,
          state: workflowStateSummary(cwd, options.mappingSummary, prepared.state.run_id),
        });
      } catch (error) {
        return lifecycleFailure("WORKFLOW_PREPARE_FAILED", error, lifecycleCandidatesForBoundary(cwd, selectionMode, error));
      }
    },
  });
  pi.registerTool({
    name: "workflow_begin",
    label: "Begin workflow stage",
    description: "Issue a durable opaque capability for the current workflow stage. Its handoff.profile_hash is intentionally a compact fingerprint (first 30 plus last 2 characters), not the full SHA-256 shown in state/workflow_instructions; different representations alone are not profile drift. Copy the current handoff binding verbatim, never reconstruct or replace its hash. Stages with a roster policy accept an optional semantic selection — role/facet/focus/reason occurrences only; concrete agent ids are rejected. The selection is validated against the allowed roles, multiplicity and the live registered agent mapping, then frozen: an identical re-issue is idempotent, a changed selection for an active capability is rejected.",
    parameters: z.object({
      selection: z.object({
        rationale: z.string().min(1).optional(),
        evidence: z.array(z.string().min(1)).max(8).optional(),
        occurrences: z.array(z.object({
          role: z.string().min(1),
          facet: z.string().min(1).nullable().optional(),
          focus: z.string().min(1).optional(),
          reason: z.string().min(1).optional(),
        }).strict()).min(1).max(8),
      }).strict().optional(),
    }) as never,
    async execute(_id, params, _signal, _update, ctx) {
      const denied = contextError(ctx);
      if (denied) return denied;
      const cwd = currentCwd(ctx);
      if (!cwd) return toolResult({ ok: false, code: "WORKFLOW_STATE_UNAVAILABLE", error: "workflow cwd unavailable" });
      const input = params as { selection?: RosterBeginSelection };
      try {
        // Per-transition trusted handoff, resolved for this exact cwd: only
        // an explicit undefined means "no handoff" and keeps the persisted
        // mapping. Any other value — including runtime null — is a handoff
        // attempt that must clear the engine's structural gate or
        // workflow_begin fails closed; it never silently selects the
        // persisted mapping.
        const controller = controllerFor(ctx, cwd);
        const claimDenied = requireActiveClaimForMutation(controller);
        if (claimDenied) return claimDenied;
        const runId = controller.selectedRunId();
        if (!runId) return toolResult({ ok: false, code: "no_active_run", error: "no canonical workflow run is selected for this trusted session" });
        const handoff = await options.beforeBegin?.(cwd);
        const claimAfterHandoff = requireActiveClaimForMutation(controller, runId);
        if (claimAfterHandoff) return claimAfterHandoff;
        const trustedMapping = handoff === undefined ? undefined : handoff as unknown as AgentMappingState;
        const transition = beginCapability(cwd, input.selection, { ...(trustedMapping !== undefined ? { trustedMapping } : {}), runId });
        if (!transition.ok) return toolResult({ ok: false, code: "WORKFLOW_BEGIN_REJECTED", error: transition.error, state: transition.state ? workflowStateSummary(cwd, options.mappingSummary, runId) : undefined });
        const profileHashNote = "handoff.profile_hash is intentionally a compact first-30/last-2 fingerprint; workflow_begin.state.profile_hash and workflow_instructions.profile.hash/state.profileHash are the full SHA-256. Do not compare these representations by string equality or treat their different lengths as profile drift. Copy the newest handoff.profile_hash verbatim; do not reconstruct it, replace it with the full hash, or edit state. Actual binding validation remains engine-owned.";
        const state = workflowStateSummary(cwd, options.mappingSummary, runId);
        const workflow = transition.state.classification?.workflow;
        const profile = workflow ? loadProfile(workflow) : undefined;
        const declaredDocument = profile?.stages.find((stage) => stage.id === "product_prd_document");
        if (transition.state.stage_cursor === "product_prd_document" && declaredDocument?.type === "document" && declaredDocument.document?.renderer === "product-prd") {
          const rendered = await publishDeclaredDocumentStage({ cwd, runId, context: controller.context() });
          if (!rendered.ok) {
            return toolResult({
              ok: false,
              code: rendered.code,
              error: rendered.error,
              transition: "begin",
              handoff: transition.handoff,
              profile_hash_note: profileHashNote,
              renderer: rendered,
              state,
            });
          }
          return toolResult({ ok: true, transition: "begin", profile_hash_note: profileHashNote, handoff: transition.handoff, renderer: rendered, state });
        }
        return toolResult({ ok: true, transition: "begin", profile_hash_note: profileHashNote, handoff: transition.handoff, state });
      } catch (error) {
        return toolResult({ ok: false, code: "WORKFLOW_BEGIN_FAILED", error: String(error) });
      }
    },
  });
  const persistProducerFormatFailure = (
    failure: StageResultValidationFailure,
    ctx: unknown,
    cwd: string,
  ): { ok: true } | { ok: false; code: string } => {
    const runtime = stageRecoveryRuntimes.get(pi as unknown as object);
    let store = failure.binding.producer.kind === "worker"
      ? runtime?.ownerStoreFor?.(cwd, failure.run_id, failure.authority)
      : runtime?.storeFor(ctx, cwd);
    let recoveryContext = ctx;
    if (!store && sessionController) {
      try {
        const ownerContext = sessionController.context();
        const ownerCto = sessionController.activeCtoClaim();
        if (failure.authority === "cto") {
          if (ownerCto?.run_id === failure.run_id) {
            store = createNativeStageRecoveryStore(cwd, { context: ownerContext, runId: failure.run_id, claim_scope: ownerCto });
            recoveryContext = ownerContext;
          }
        } else {
          const ownerRun = sessionController.selectedRunId();
          if (ownerRun === failure.run_id && sessionController.activeClaimRunId() === ownerRun) {
            store = createOrdinaryStageRecoveryStore(cwd, { context: ownerContext, runId: failure.run_id });
            recoveryContext = ownerContext;
          }
        }
      } catch {
        store = undefined;
      }
    }
    if (!store && (failure.binding.producer.kind === "worker"
      || (failure.authority === "cto" && failure.binding.producer.kind === "orchestrator" && failure.binding.producer.owner === "native-lead"))) {
      // Native workers and leads need the live coordinator, not their local
      // extension instance's lifecycle/controller, to record recovery context.
      // This fallback follows successful producer binding validation only.
      const root = nativeWorkerAuthority?.resolveRootAuthority(cwd, failure.run_id);
      if (root
        && root.authority === failure.authority
        && root.run_id === failure.run_id
        && root.context.authority === "coordinator"
        && root.context.worktree === cwd
        && root.context.branch === failure.binding.host.branch) {
        const rootContext: TrustedExecutionContext = { ...root.context, authority: "coordinator" };
        store = root.authority === "cto"
          ? createNativeStageRecoveryStore(cwd, { context: rootContext, runId: failure.run_id, claim_scope: root.claim_scope })
          : createOrdinaryStageRecoveryStore(cwd, { context: rootContext, runId: failure.run_id });
        recoveryContext = root.root_ctx;
      }
    }
    if (!store) return { ok: false, code: "recovery_context_unavailable" };
    try {
      const selection = store.selection(failure.binding.identity);
      if (selection.run_id !== failure.run_id || selection.authority !== failure.authority) {
        return { ok: false, code: "recovery_authority_denied" };
      }
      const read = store.read({
        run_id: failure.run_id,
        authority: failure.authority,
        selection,
        identity: failure.binding.identity,
      });
      if (typeof (read as { then?: unknown }).then === "function") {
        return { ok: false, code: "recovery_context_unavailable" };
      }
      const snapshot = read as StageRecoverySnapshot;
      if (!snapshot.identity || !isDeepStrictEqual(snapshot.identity, failure.binding.identity)) {
        return { ok: false, code: "recovery_identity_unavailable" };
      }
      const recorded = store.recordFormatValidation({
        run_id: failure.run_id,
        authority: failure.authority,
        expected_revision: snapshot.revision,
        selection,
        identity: failure.binding.identity,
        state_proof: snapshot.state_proof,
        producer: failure.binding,
        error_context: {
          class: "format_validation",
          code: failure.code,
          message: failure.error,
          field_errors: failure.field_errors,
          source: "canonical",
        },
      } satisfies StageRecoveryFormatValidationInput);
      if (recorded.ok && snapshot.terminal) {
        scheduleAutomaticRecovery(runtime, {
          kind: "terminal",
          run_id: failure.run_id,
          authority: failure.authority,
          cwd,
          ctx: recoveryContext,
          dispatch_id: snapshot.terminal.dispatch_id,
          outcome: snapshot.terminal.outcome,
        });
      }
      return recorded.ok ? { ok: true } : { ok: false, code: recorded.code };
    } catch {
      return { ok: false, code: "recovery_context_unavailable" };
    }
  };
  const submissionEnvelope = z.object({ outputs: z.record(z.string(), z.unknown()) }).strict();
  const submissionDelivery = z.union([
    submissionEnvelope,
    z.object({ outputs_path: z.string().min(1) }).strict(),
  ]);
  pi.registerTool({
    name: "workflow_submit_result",
    label: "Submit assigned stage result",
    description: "Submit logical artifact outputs for your current profile-declared worker or coordinator assignment. Input is exactly { outputs } or { outputs_path }; the latter reads a JSON { outputs } envelope from the authenticated producer workspace. Identity and authority remain host-derived. Tool-owned outputs can be published only by their registered callback.",
    parameters: submissionDelivery as never,
    async execute(_id, params, _signal, _update, ctx) {
      const cwd = currentCwd(ctx);
      if (!cwd) return toolResult({ ok: false, code: "WORKFLOW_STATE_UNAVAILABLE", error: "workflow cwd unavailable" });
      const target = stageTargetFor(ctx, cwd);
      if (!target) return toolResult({ ok: false, code: "WORKFLOW_CONTEXT_REJECTED", error: "no canonical workflow or CTO run is available for this producer context" });
      const delivery = submissionDelivery.safeParse(params);
      if (!delivery.success) return toolResult({ ok: false, code: "invalid_submission", error: "provide exactly one of outputs or outputs_path" });
      let submission: unknown = delivery.data;
      if ("outputs_path" in delivery.data) {
        const binding = resolveStageSubmissionBinding({ cwd, runId: target.runId, authority: target.authority, context: ctx, bindingResolver: resolveProducerBinding });
        // Terminal replay uses persisted producer lineage before file access;
        // the service still verifies exact replay and immutable artifact bytes.
        const lineage = !binding ? nativeAcceptedReplayLineage(ctx, cwd) : undefined;
        const root = lineage ? nativeWorkerAuthority?.resolveRootAuthority(cwd, target.runId) : undefined;
        let replayBinding: StageProducerBinding | undefined;
        if (lineage && root?.run_id === target.runId && root.authority === target.authority && root.context.authority === "coordinator") {
          const context: TrustedExecutionContext = { ...root.context, authority: "coordinator" };
          const candidate = root.authority === "ordinary"
            ? findAcceptedOrdinaryStageReceipt({ cwd, runId: target.runId, lineage, root: { context, outputs: {} } }, true)
            : root.claim_scope
              ? findNativeAcceptedStageReceipt({ cwd, runId: target.runId, lineage, root: { context, claim_scope: root.claim_scope, outputs: {} } }, true)
              : undefined;
          replayBinding = candidate?.receipt.binding as StageProducerBinding | undefined;
        }
        const workspace = binding?.binding.host.worktree ?? replayBinding?.host.worktree;
        if (!workspace || resolve(workspace) !== resolve(cwd)) return toolResult({ ok: false, code: "producer_authority_denied", error: "submission file requires an authenticated producer workspace" });
        const file = readArtifactFileSafe(workspace, delivery.data.outputs_path);
        if (file.status !== "present") return toolResult({ ok: false, code: file.status === "absent" ? "submission_file_unreadable" : "invalid_submission_path", error: file.status === "absent" ? "submission file does not exist in the producer workspace" : file.error });
        try {
          submission = JSON.parse(file.bytes.toString("utf8"));
        } catch {
          return toolResult({ ok: false, code: "invalid_submission_json", error: "submission file is not valid JSON; fix the file and submit again" });
        }
        const envelope = submissionEnvelope.safeParse(submission);
        if (!envelope.success) return toolResult({ ok: false, code: "invalid_submission", error: "submission file must contain exactly { outputs: { ... } }" });
        submission = envelope.data;
      }
      const result = submitStageResult({
        cwd,
        runId: target.runId,
        authority: target.authority,
        context: ctx,
        bindingResolver: resolveProducerBinding,
        acceptedReplay,
        ...(stageResultCommitter ? { ctoCommitter: stageResultCommitter } : {}),
        onValidationFailure: (failure) => persistProducerFormatFailure(failure, ctx, cwd),
      }, submission);
      return result.ok
        ? toolResult({ ok: true, receipt: result.receipt })
        : toolResult({ ok: false, code: result.code, error: result.error, ...(result.field_errors ? { field_errors: result.field_errors } : {}) });
    },
  });
  const executeRecovery = async (
    toolCallId: string,
    input: WorkflowRecoveryToolInput,
    signal: AbortSignal | undefined,
    ctx: unknown,
    requestedIdentity?: WorkIdentity,
  ): Promise<WorkflowToolResult> => {
    const cwd = currentCwd(ctx);
    if (!cwd) return toolResult({ ok: false, code: "WORKFLOW_STATE_UNAVAILABLE", error: "workflow cwd unavailable" });
    const runtime = stageRecoveryRuntimes.get(pi as unknown as object);
    if (!runtime) return toolResult({ ok: false, code: "STAGE_HOST_UNSUPPORTED", error: "the registered host does not expose recovery ownership and continuation" });
    // Resolve the owner-scoped store before any journal recovery. This is the
    // existing authenticated host/session and active-claim boundary; a random
    // context must not be able to roll a workspace journal forward.
    const authorizedStore = runtime.storeFor(ctx, cwd);
    if (!authorizedStore) return toolResult({ ok: false, code: "WORKFLOW_CONTEXT_REJECTED", error: "the session does not own an authenticated ordinary or native recovery target" });
    // A committed automatic replacement may still be awaiting its delivery ACK.
    // Let that existing operation finish before manual mutation captures its CAS
    // revision; diagnosis remains available while delivery is in flight.
    if (input.operation === "reconcile") await runtime.automaticContinuation;
    try {
      // Recovery reads use the no-recovery store APIs so a torn lifecycle
      // publication cannot be mistaken for canonical owner state. Repair
      // journals under the workspace lock, then resolve the owner-scoped
      // store again against the repaired generation. The transaction helper
      // preserves the active CTO claim; it only repairs durable publication
      // files after the host/session authority check above.
      withWorkspaceTransaction(cwd, () => undefined, { createIfMissing: false });
    } catch {
      return toolResult({ ok: false, code: "WORKFLOW_RECOVERY_STATE_UNAVAILABLE", error: "the canonical lifecycle journal could not be recovered safely" });
    }
    const store = runtime.storeFor(ctx, cwd);
    if (!store) return toolResult({ ok: false, code: "WORKFLOW_CONTEXT_REJECTED", error: "the session no longer owns the recovery target" });
    let selection: TrustedRecoverySelection;
    let snapshot: StageRecoverySnapshot;
    try {
      selection = store.selection(requestedIdentity);
      snapshot = await store.read({ run_id: selection.run_id, authority: selection.authority, selection, ...(requestedIdentity ? { identity: requestedIdentity } : {}) });
    } catch {
      return toolResult({ ok: false, code: "WORKFLOW_RECOVERY_STATE_UNAVAILABLE", error: "the canonical recovery owner could not be read safely" });
    }
    if (input.intent === "refresh_handoff") {
      const stale = ctx !== null && (typeof ctx === "object" || typeof ctx === "function")
        ? runtime.staleAdmissions.get(ctx as object)
        : undefined;
      let current;
      try {
        current = store.readCurrentHandoff({ run_id: selection.run_id, selection });
      } catch {
        return toolResult({ ok: false, code: "WORKFLOW_RECOVERY_STATE_UNAVAILABLE", error: "the canonical recovery owner could not expose a handoff safely" });
      }
      if (!current.ok) {
        return toolResult({
          ok: true,
          recovery: {
            operation_id: toolCallId,
            code: current.code,
            worker: "unknown",
            action: "wait",
            attempts_remaining: 0,
            state_revision: current.revision ?? snapshot.revision,
            blocking_condition: current.begin_required
              ? "the current canonical stage requires workflow_begin before a trusted handoff exists"
              : "the current owner could not expose a trusted handoff",
            next_action: current.begin_required ? "begin the current canonical stage before dispatch" : "reread the current owner-scoped stage handoff",
          },
          capabilities: runtime.host.capabilities,
        });
      }
      if (ctx !== null && (typeof ctx === "object" || typeof ctx === "function")) runtime.staleAdmissions.delete(ctx as object);
      const worker = snapshot.lifecycle === "pending" || snapshot.lifecycle === "not_started"
        ? "not_started" as const
        : snapshot.lifecycle === "running"
          ? "running" as const
          : snapshot.lifecycle === "disconnected"
            ? "disconnected" as const
            : snapshot.lifecycle === "terminal"
              ? "terminal" as const
              : "unknown" as const;
      return toolResult({
        ok: true,
        recovery: {
          operation_id: toolCallId,
          code: "handoff_refreshed",
          worker,
          action: "refresh_handoff",
          attempts_remaining: 0,
          state_revision: current.revision,
          state_proof: current.handoff.proof,
          handoff: current.handoff,
          blocking_condition: stale?.run_id === selection.run_id && stale.authority === selection.authority
            ? "the stale caller was rejected before admission"
            : "the current owner handoff was read without dispatching a worker",
          next_action: "admit the returned current handoff through the normal workflow task route",
        },
        capabilities: runtime.host.capabilities,
      });
    }
    if (!requestedIdentity && selection.authority === "ordinary") {
      let identities: WorkIdentity[];
      try {
        identities = currentRecoveryAssignments(cwd, selection.run_id);
      } catch {
        return toolResult({ ok: false, code: "WORKFLOW_RECOVERY_STATE_UNAVAILABLE", error: "the canonical recovery assignments could not be read safely" });
      }
      if (identities.length > 1) {
        const recoveries: Array<{ slot_id: string; dispatch_id: string; result: unknown }> = [];
        for (const identity of identities) {
          const result = await executeRecovery(`${toolCallId}:${identity.dispatch_id}`, input, signal, ctx, identity);
          recoveries.push({ slot_id: identity.slot_id, dispatch_id: identity.dispatch_id, result: result.details });
        }
        return toolResult({ ok: true, recoveries, capabilities: runtime.host.capabilities });
      }
      if (identities.length === 1) return executeRecovery(toolCallId, input, signal, ctx, identities[0]);
    }
    const request: StageRecoveryRequest = {
      run_id: selection.run_id,
      authority: selection.authority,
      operation: input.operation,
      operation_id: toolCallId,
      ...(input.intent ? { intent: input.intent } : {}),
      ...(snapshot.identity ? { identity: snapshot.identity } : {}),
      ...(input.operation === "reconcile" ? { expected_revision: snapshot.revision } : {}),
      selection,
    };
    const execute = async (currentRequest: StageRecoveryRequest): Promise<StageRecoveryResult> => {
      const options: StageRecoveryExecutionOptions = { request: currentRequest, store, host: runtime.host };
      return recoverStageExecution(options);
    };
    let recovery = await execute(request);
    if (recovery.code !== "recovery_grant_required" || !snapshot.identity) {
      return toolResult({ ok: true, recovery, capabilities: runtime.host.capabilities });
    }
    const errorClass: RecoveryErrorClass = snapshot.error_context?.class === "format_validation"
      ? "format_validation"
      : snapshot.preflight
        ? "preflight_not_started"
        : snapshot.terminal?.outcome === "cancelled"
          ? "cancelled"
          : "terminal_failure";
    let profile = trustedInteractiveProfile();
    if (!profile) profile = trustedInteractiveHostProfileFromContext(ctx);
    const surface = profile?.hasUI && profile.ui && typeof profile.ui === "object"
      ? profile.ui as HostAskSurface
      : undefined;
    let answer: HostDecisionResult;
    try {
      answer = await askHostDecision(surface, {
        id: "omp-recovery-grant",
        question: "Authorize one bounded recovery retry after the persisted budget is exhausted?",
        header: "Recovery authorization",
        title: "Authorize one bounded recovery retry?",
        allowed: ["authorize_one_retry", "do_not_retry"],
        signal,
      });
    } catch (error) {
      return toolResult({ ok: false, code: "WORKFLOW_RECOVERY_GRANT_FAILED", error: String(error) });
    }
    if (!answer.ok) {
      const decision = "kind" in answer ? answer.kind : "declined";
      const error = "error" in answer ? answer.error : "the host decision was declined";
      return toolResult({ ok: false, code: "WORKFLOW_RECOVERY_GRANT_REJECTED", error, decision });
    }
    if (answer.selected !== "authorize_one_retry") return toolResult({ ok: false, code: "WORKFLOW_RECOVERY_GRANT_REJECTED", error: "the host declined the bounded recovery grant" });
    let grantProof: Parameters<AuthenticatedStageRecoveryStore["commitGrant"]>[0]["proof"];
    try {
      grantProof = store.captureGrantAuthorization({
        expected_revision: snapshot.revision,
        selection,
        identity: snapshot.identity,
      });
    } catch (error) {
      return toolResult({ ok: false, code: "WORKFLOW_RECOVERY_GRANT_REJECTED", error: String(error) });
    }
    const grant = store.commitGrant({
      proof: grantProof,
      expected_revision: snapshot.revision,
      selection,
      grant_id: `omp-recovery-grant:${toolCallId}`,
      error_class: errorClass,
      identity: snapshot.identity,
      limit: 1,
      reason: "One bounded recovery retry authorized after persisted exhaustion.",
      authorizer: selection.owner_id,
    });
    if ("code" in grant) return toolResult({ ok: false, code: "WORKFLOW_RECOVERY_GRANT_REJECTED", error: grant.code, revision: grant.revision });
    let afterSelection: TrustedRecoverySelection;
    let afterSnapshot: StageRecoverySnapshot;
    try {
      afterSelection = store.selection(snapshot.identity);
      afterSnapshot = await store.read({
        run_id: afterSelection.run_id,
        authority: afterSelection.authority,
        selection: afterSelection,
        identity: snapshot.identity,
      });
    } catch (error) {
      return toolResult({ ok: false, code: "WORKFLOW_RECOVERY_GRANT_REJECTED", error: String(error) });
    }
    if (!afterSnapshot.identity || !isDeepStrictEqual(afterSnapshot.identity, snapshot.identity)) {
      return toolResult({ ok: false, code: "WORKFLOW_RECOVERY_GRANT_REJECTED", error: "recovery assignment changed while the grant was being committed" });
    }
    recovery = await execute({
      ...request,
      expected_revision: afterSnapshot.revision,
      selection: afterSelection,
      grant: grant.grant,
      identity: afterSnapshot.identity,
    });
    return toolResult({ ok: true, recovery, capabilities: runtime.host.capabilities });
  };
  pi.registerTool({
    name: "workflow_recover",
    label: "Recover assigned stage",
    description: "Diagnose or reconcile trusted host stage state through the owner-locked recovery ledger. The host derives the exact run, identity, retry scope, and any bounded grant; unsupported OMP operations return typed results.",
    parameters: z.object({
      operation: z.enum(["diagnose", "reconcile"]),
      intent: z.enum(["observe", "reconnect", "resume", "replace", "retry", "clarify", "cancel", "cancel_ack", "refresh_handoff", "repair_format"]).optional(),
    }).strict() as never,
    async execute(id, params, signal, _update, ctx) {
      const denied = contextError(ctx);
      if (denied) return denied;
      return executeRecovery(id, params as WorkflowRecoveryToolInput, signal, ctx);
    },
  });
  const selectorParameters = z.object({
    selector: z.object({
      run_id: z.string().min(1).optional(),
      title: z.string().min(1).optional(),
      list_item: z.object({ snapshot_id: z.string().min(1), index: z.number().int().min(0), run_id: z.string().min(1) }).strict().optional(),
    }).strict().optional(),
  }).strict();
  pi.registerTool({
    name: "workflow_status",
    label: "Workflow status",
    description: "Read one selected run's durable stage, profile hash, and dispatch status; an explicit selector never falls back to current selection.",
    parameters: selectorParameters as never,
    async execute(_id, params, _signal, _update, ctx) {
      const denied = contextError(ctx);
      if (denied) return denied;
      const cwd = currentCwd(ctx);
      if (!cwd) return toolResult({ ok: false, code: "WORKFLOW_STATE_UNAVAILABLE", error: "workflow cwd unavailable" });
      try {
        const input = params as { selector?: LifecycleSelector };
        const controller = controllerFor(ctx, cwd);
        return toolResult(workflowStateSummary(cwd, options.mappingSummary, resolveToolRunId(cwd, input.selector, controller), true));
      } catch (error) {
        return lifecycleFailure("WORKFLOW_STATUS_FAILED", error, lifecycleCandidatesForBoundary(cwd, "rework", error));
      }
    },
  });
  pi.registerTool({
    name: "workflow_instructions",
    label: "Workflow instructions",
    description: "Read one selected run's structured workflow stage contract and ordered informational profile.stages metadata (including pathless registered profiles); the selector must identify the same run used for rework discovery.",
    parameters: selectorParameters as never,
    async execute(_id, params, _signal, _update, ctx) {
      const denied = contextError(ctx);
      if (denied) return denied;
      const cwd = currentCwd(ctx);
      if (!cwd) return toolResult({ ok: false, code: "WORKFLOW_STATE_UNAVAILABLE", error: "workflow cwd unavailable" });
      try {
        const input = params as { selector?: LifecycleSelector };
        const controller = controllerFor(ctx, cwd);
        const runId = resolveToolRunId(cwd, input.selector, controller);
        if (!runId) return toolResult({ ok: false, code: "no_active_run", error: "no workflow run is selected for this trusted session" });
        return toolResult(resolveWorkflowContract(cwd, { runId, branch: resolveActiveBranch(cwd) }));
      } catch (error) {
        return lifecycleFailure("WORKFLOW_RESOLUTION_FAILED", error, lifecycleCandidatesForBoundary(cwd, "rework", error));
      }
    },
  });
  pi.registerTool({
    name: "workflow_checkpoint",
    label: "Record checkpoint decision",
    description: "Persist a typed, policy-bound decision envelope for a declared stage checkpoint. Use only the newest explicit `workflow_begin` handoff's `advance_token` as `token`; never use its `dispatch_token` or any pre-begin, auto-advance, or older-begin token. Copy `capability_id`, `run_key`, `branch`, `workflow`, `profile_hash`, `stage_cursor`, `cursor_epoch`, and `loop_iteration` exactly; human authorization requires a durable terminal/escalation answer proof from `workflow_checkpoint_ask`: copy the returned proof, decision, checkpoint_kind, and loop_iteration binding verbatim — any reconstructed or abbreviated value rejects. Legacy mode/actor fields never authorize a transition; fail closed rather than retrying with another token or disclosing secrets.",
    parameters: z.object({
      token: z.string().min(1),
      capability_id: z.string().min(1),
      run_key: z.string().min(1),
      branch: z.string().min(1),
      workflow: z.string().min(1),
      profile_hash: z.string().min(1),
      stage_cursor: z.string().min(1),
      cursor_epoch: z.string().min(1),
      checkpoint: z.string().min(1),
      checkpoint_id: z.string().min(1),
      checkpoint_kind: z.string().min(1),
      loop_iteration: z.number().int().min(1),
      authorization: z.enum(["human", "policy_auto"]),
      actor_provenance: z.object({
        kind: z.enum(["user", "orchestrator", "system"]),
        ref: z.string().min(1),
        proof: z.object({
          answer_id: z.string().min(1),
          nonce: z.string().min(1),
          channel: z.enum(["terminal", "escalation"]),
          reference: z.string().min(1),
          binding: z.string().min(1),
        }).strict().optional(),
      }).strict(),
      decision: z.string().min(1),
      rationale: z.string().default(""),
      run_id: z.string().min(1).optional(),
    }).strict() as never,
    async execute(_id, params, _signal, _update, ctx) {
      const denied = contextError(ctx);
      if (denied) return denied;
      const cwd = currentCwd(ctx);
      if (!cwd) return toolResult({ ok: false, code: "WORKFLOW_STATE_UNAVAILABLE", error: "workflow cwd unavailable" });
      const input = params as DispatchAuth & {
        checkpoint: string;
        checkpoint_id: string;
        checkpoint_kind: CheckpointRuleKind;
        authorization: "human" | "policy_auto";
        actor_provenance: { kind: "user" | "orchestrator" | "system"; ref: string; proof?: CheckpointAnswerProof };
        decision: string;
        rationale: string;
        run_id?: string;
      };
      try {
        const controller = controllerFor(ctx, cwd);
        const claimDenied = requireActiveClaimForMutation(controller);
        if (claimDenied) return claimDenied;
        const selectedRunId = controller.selectedRunId();
        const runId = input.run_id ?? selectedRunId;
        if (input.run_id && input.run_id !== selectedRunId) {
          return toolResult({ ok: false, code: "WORKFLOW_CONTEXT_REJECTED", error: "checkpoint run_id must match the selected run held by this session's active execution claim" });
        }
        const transition = recordCheckpointDecision(cwd, { ...input, run_id: runId });
        return transition.ok
          ? toolResult({ ok: true, transition: "checkpoint", checkpoint: input.checkpoint, state: workflowStateSummary(cwd, options.mappingSummary, runId) })
          : toolResult({ ok: false, code: "WORKFLOW_CHECKPOINT_REJECTED", error: transition.error });
      } catch (error) {
        return toolResult({ ok: false, code: "WORKFLOW_CHECKPOINT_FAILED", error: String(error) });
      }
    },
  });
  pi.registerTool({
    name: "workflow_checkpoint_ask",
    label: "Ask human to authorize checkpoint",
    description: "Trusted terminal ingest for the current stage checkpoint. Use only the newest explicit `workflow_begin` handoff's `advance_token` as `token`; never use its `dispatch_token` or any pre-begin, auto-advance, or older-begin token. This ask schema intentionally omits `profile_hash`; preserve its declared `capability_id`, `run_key`, `branch`, `workflow`, `stage_cursor`, `cursor_epoch`, and `loop_iteration` binding fields exactly, with checkpoint fields from the current stage contract. It validates the active capability and unresolved checkpoint, asks the human at the live UI surface (terminal dialog or connected RPC client), and commits the answer through the engine's durable checkpoint ledger in one cross-process transaction (fresh-state revalidation, live-proof supersession, and the CAS commit are engine-owned). Returns the proof plus actor_provenance for the follow-up `workflow_checkpoint` call — copy the returned proof, decision, checkpoint_kind, and loop_iteration verbatim; never reconstruct them. The human's selection is the only source of the recorded decision — never guess or fabricate it. Fails closed without an interactive UI surface; Esc, timeout, and custom free-text answers record nothing; cancellation and any state/capability/policy transition while the dialog is open reject without persisting. Do not retry with another token or disclose secrets.",
    parameters: z.object({
      token: z.string().min(1),
      capability_id: z.string().min(1),
      run_key: z.string().min(1),
      branch: z.string().min(1),
      workflow: z.string().min(1),
      stage_cursor: z.string().min(1),
      cursor_epoch: z.string().min(1),
      checkpoint: z.string().min(1),
      checkpoint_id: z.string().min(1),
      checkpoint_kind: z.string().min(1),
      loop_iteration: z.number().int().min(1),
      question: z.string().min(1).max(2000).optional(),
    }).strict() as never,
    async execute(_id, params, signal, _update, ctx) {
      const denied = contextError(ctx);
      if (denied) return denied;
      const cwd = currentCwd(ctx);
      if (!cwd) return toolResult({ ok: false, code: "WORKFLOW_STATE_UNAVAILABLE", error: "workflow cwd unavailable" });
      const input = params as {
        token: string;
        capability_id: string;
        run_key: string;
        branch: string;
        workflow: string;
        stage_cursor: string;
        cursor_epoch: string;
        checkpoint: string;
        checkpoint_id: string;
        checkpoint_kind: string;
        loop_iteration: number;
        question?: string;
        run_id?: string;
      };
      const controller = controllerFor(ctx, cwd);
      const claimDenied = requireActiveClaimForMutation(controller);
      if (claimDenied) return claimDenied;
      const selectedRunId = input.run_id ?? controller.selectedRunId();
      if (input.run_id && input.run_id !== controller.selectedRunId()) {
        return toolResult({ ok: false, code: "WORKFLOW_CONTEXT_REJECTED", error: "checkpoint run_id must match the selected run held by this session's active execution claim" });
      }
      if (!selectedRunId) return toolResult({ ok: false, code: "no_active_run", error: "no canonical workflow run is selected for this trusted session" });
      const scopedInput = { ...input, run_id: selectedRunId };
      const abortedResult = () => toolResult({
        ok: false,
        code: "WORKFLOW_CHECKPOINT_ASK_ABORTED",
        error: "workflow_checkpoint_ask was canceled; no human answer is minted and nothing was recorded",
      });
      try {
        if (signal?.aborted) return abortedResult();
        // Read-only preflight before any human prompt: the dialog is never
        // presented for an unauthenticated, stale, malformed, or
        // already-resolved request. The same validation runs again on the
        // freshly persisted state after the dialog resolves.
        const preflight = validateCheckpointAsk(cwd, scopedInput);
        if (!preflight.ok) return toolResult({ ok: false, code: "WORKFLOW_CHECKPOINT_ASK_REJECTED", error: preflight.error });
        const { stage, rule, allowed } = preflight.context;
        const existing = findCurrentCheckpointDecision(preflight.context.state, stage);
        if (existing) {
          return toolResult({
            ok: true,
            transition: "checkpoint_answer",
            checkpoint: input.checkpoint,
            decision: existing.decision,
            already_recorded: true,
            next: "decision already recorded; resume with workflow_advance using the current handoff",
            state: workflowStateSummary(cwd, options.mappingSummary, selectedRunId),
          });
        }
        // A live answer may have been minted by an earlier host turn before
        // this ask was retried. Verify every durable scope field (including the
        // current work-identity binding) before reusing it; a stale or forged
        // candidate must never be handed to the commit path as a decision,
        // because that path is allowed to mint a fresh answer.
        const currentCapability = preflight.context.state.dispatch_capability;
        const liveCandidate = (preflight.context.state.trusted_checkpoint_answers ?? []).find((candidate) =>
          candidate.consumed_at === undefined
          && candidate.consumed_reason === undefined
          && candidate.channel === "terminal"
          && candidate.run_id === selectedRunId
          && candidate.stage_id === stage.id
          && candidate.checkpoint_id === input.checkpoint
          && allowed.includes(candidate.decision)
          && candidate.capability_id === currentCapability?.capability_id
          && candidate.capability_epoch === currentCapability?.issued_for?.cursor_epoch
          && candidate.loop_iteration === currentCapability?.issued_for?.loop_iteration
        );
        let replayAnswer: typeof liveCandidate;
        if (liveCandidate) {
          try {
            const verified = recordTrustedCheckpointAnswer(preflight.context.state, {
              answer_id: liveCandidate.answer_id,
              channel: liveCandidate.channel,
              reference: liveCandidate.reference,
              stage_id: liveCandidate.stage_id,
              checkpoint_id: liveCandidate.checkpoint_id,
              decision: liveCandidate.decision,
            });
            if (verified.answer.answer_id === liveCandidate.answer_id) replayAnswer = verified.answer;
          } catch {
            // A malformed, stale, or forged live record is never replayed.
          }
        }
        let committed: CheckpointAnswerCommitResult;
        if (replayAnswer) {
          if (signal?.aborted) return abortedResult();
          const claimBeforeReplay = requireActiveClaimForMutation(controller, selectedRunId);
          if (claimBeforeReplay) return claimBeforeReplay;
          committed = commitCheckpointAnswer(cwd, {
            run_id: selectedRunId,
            token: input.token,
            capability_id: input.capability_id,
            run_key: input.run_key,
            branch: input.branch,
            workflow: input.workflow,
            stage_cursor: input.stage_cursor,
            cursor_epoch: input.cursor_epoch,
            checkpoint: input.checkpoint,
            checkpoint_id: input.checkpoint_id,
            checkpoint_kind: input.checkpoint_kind,
            loop_iteration: input.loop_iteration,
            decision: replayAnswer.decision,
          });
        } else {
          // Privileged ingest boundary: the answer may come only from a real
          // host UI surface — never from anything model-supplied. The
          // installed host wires the prompt capability through two
          // host-authored carriers: the per-call tool context (wired with
          // hasUI=true by the interactive TUI and by `--mode rpc-ui`) and the
          // session_start host profile (`--mode rpc` deliberately leaves the
          // tool-call context UI-less while the session context carries the
          // connected RPC client's live select bridge). Trusted interactive
          // session ownership is re-checked here, so json/print/headless
          // contexts and Task subagent/worker sessions fail closed before any
          // dialog is raised.
          const toolCtx = ctx as unknown as { hasUI?: boolean; ui?: HostAskSurface };
          const toolSurface = toolCtx.hasUI === true && toolCtx.ui ? toolCtx.ui : undefined;
          const profileSurface = trustedInteractiveProfile();
          const surface: HostAskSurface | undefined = toolSurface ?? (profileSurface?.ui as HostAskSurface | undefined);
          const dialogQuestion = [
            `Human authorization required — checkpoint '${input.checkpoint}' (${rule.kind}) at stage '${stage.id}' of workflow '${input.workflow}'.`,
            ...(input.question ? [`Orchestrator context: ${input.question}`] : []),
            "Select exactly one policy-allowed decision. Esc, timeout, or a custom answer records nothing.",
          ].join("\n");
          const answer = await askHostDecision(surface, {
            id: `checkpoint:${input.checkpoint}`,
            question: dialogQuestion,
            header: `${input.workflow}/${stage.id}`,
            title: `Authorize checkpoint '${input.checkpoint}' (${rule.kind}) — stage '${stage.id}'`,
            allowed,
            signal,
          });
          if (!answer.ok) {
            if (answer.kind === "aborted") return abortedResult();
            return toolResult({
              ok: false,
              code: answer.kind === "unavailable" ? "WORKFLOW_CHECKPOINT_ASK_UNAVAILABLE" : "WORKFLOW_CHECKPOINT_DECLINED",
              error: answer.error,
            });
          }
          const selected = answer.selected;
          // Last cancellation gate before the durable commit: the engine commit
          // below is fully synchronous (no await between the gate and the
          // ledger write), so a canceled call can never reach the ledger past
          // this point.
          if (signal?.aborted) return abortedResult();
          const claimBeforeCommit = requireActiveClaimForMutation(controller, selectedRunId);
          if (claimBeforeCommit) return claimBeforeCommit;
          // One engine-owned durable commit: commitCheckpointAnswer re-runs the
          // full state<->capability<->profile<->policy validation against the
          // freshly persisted state, resolves recorded/live-answer races, and
          // either supersedes stale live proofs and mints one engine-UUID
          // answer or reuses the exact live proof — always in one commit.
          committed = commitCheckpointAnswer(cwd, {
            run_id: selectedRunId,
            token: input.token,
            capability_id: input.capability_id,
            run_key: input.run_key,
            branch: input.branch,
            workflow: input.workflow,
            stage_cursor: input.stage_cursor,
            cursor_epoch: input.cursor_epoch,
            checkpoint: input.checkpoint,
            checkpoint_id: input.checkpoint_id,
            checkpoint_kind: input.checkpoint_kind,
            loop_iteration: input.loop_iteration,
            decision: selected,
          });
        }
        if (!committed.ok) {
          // Honest engine mapping: a conflict already carries the
          // dialog-aware text; a policy drift keeps its dedicated message;
          // every other post-dialog failure means the workflow world moved
          // while the dialog was open.
          const detail = committed.code === "policy_conflict"
            ? `checkpoint policy drifted between the workflow state and the declaring profile (${committed.error})`
            : committed.error;
          const error = committed.kind === "conflict"
            ? detail
            : `workflow state changed while the dialog was open: ${detail}`;
          return toolResult({ ok: false, code: "WORKFLOW_CHECKPOINT_ASK_REJECTED", error });
        }
        if (committed.outcome === "already_finalized") {
          return toolResult({
            ok: true,
            transition: "checkpoint_answer",
            checkpoint: input.checkpoint,
            decision: committed.decision,
            already_recorded: true,
            next: "decision already recorded; resume with workflow_advance using the current handoff",
            state: workflowStateSummary(cwd, options.mappingSummary, selectedRunId),
          });
        }
        if (!committed.answer || !committed.proof) {
          return toolResult({ ok: false, code: "WORKFLOW_CHECKPOINT_ASK_FAILED", error: "checkpoint ledger committed without a durable answer identity" });
        }
        return toolResult({
          ok: true,
          transition: "checkpoint_answer",
          checkpoint: input.checkpoint,
          checkpoint_kind: committed.checkpoint_kind,
          decision: committed.decision,
          channel: "terminal",
          loop_iteration: input.loop_iteration,
          actor_provenance: { kind: "user", ref: committed.answer.reference, proof: committed.proof },
          next: "call workflow_checkpoint now with authorization='human', this exact actor_provenance and decision, checkpoint_kind, rationale, loop_iteration, and the handoff identity fields — copy each returned value verbatim",
          state: workflowStateSummary(cwd, options.mappingSummary, selectedRunId),
        });
      } catch (error) {
        return toolResult({ ok: false, code: "WORKFLOW_CHECKPOINT_ASK_FAILED", error: String(error) });
      }
    },
  });
  pi.registerTool({
    name: "workflow_advance",
    label: "Advance workflow",
    description: "Join the current stage and advance its durable cursor after all dispatches complete. Use only the newest explicit `workflow_begin` handoff's `advance_token` as `token`; never use its `dispatch_token` or any pre-begin, auto-advance, or older-begin token. Copy `capability_id`, `run_key`, `branch`, `workflow`, `profile_hash`, `stage_cursor`, `cursor_epoch`, and `loop_iteration` exactly from that handoff; a binding replayed from a prior loop iteration rejects. Do not disclose secrets or retry with another token; fail closed on a swapped or stale binding.",
    parameters: z.object({
      token: z.string().min(1),
      capability_id: z.string().min(1),
      run_key: z.string().min(1),
      branch: z.string().min(1),
      workflow: z.string().min(1),
      profile_hash: z.string().min(1),
      stage_cursor: z.string().min(1),
      cursor_epoch: z.string().min(1),
      loop_iteration: z.number().int().min(1),
      evidence: z.string().min(1),
    }) as never,
    async execute(_id, params, _signal, _update, ctx) {
      const denied = contextError(ctx);
      if (denied) return denied;
      const cwd = currentCwd(ctx);
      if (!cwd) return toolResult({ ok: false, code: "WORKFLOW_STATE_UNAVAILABLE", error: "workflow cwd unavailable" });
      const input = params as DispatchAuth & { evidence: string };
      try {
        // Per-transition trusted handoff for this exact cwd — never a cached
        // mapping from another transition or project: only an explicit
        // undefined keeps the persisted mapping; runtime null or a value
        // failing the engine's structural gate fails the advance closed.
        const controller = controllerFor(ctx, cwd);
        const claimDenied = requireActiveClaimForMutation(controller);
        if (claimDenied) return claimDenied;
        const runId = controller.selectedRunId();
        if (!runId) return toolResult({ ok: false, code: "no_active_run", error: "no canonical workflow run is selected for this trusted session" });
        const handoff = await options.beforeBegin?.(cwd);
        const claimAfterHandoff = requireActiveClaimForMutation(controller, runId);
        if (claimAfterHandoff) return claimAfterHandoff;
        const trustedMapping = handoff === undefined ? undefined : handoff as unknown as AgentMappingState;
        const transition = advanceCursor(cwd, input, { ...(trustedMapping !== undefined ? { trustedMapping } : {}), runId });
        return transition.ok
          ? toolResult({ ok: true, transition: "advance", stage_cursor: transition.state.stage_cursor, cursor_epoch: transition.state.cursor_epoch, handoff: transition.handoff, state: workflowStateSummary(cwd, options.mappingSummary, runId) })
          : toolResult({ ok: false, code: "WORKFLOW_ADVANCE_REJECTED", error: transition.error });
      } catch (error) {
        return toolResult({ ok: false, code: "WORKFLOW_ADVANCE_FAILED", error: String(error) });
      }
    },
  });
}

export function createWorkflowToolAdapter(options: WorkflowToolAdapterOptions = {}): WorkflowToolAdapter {
  return {
    capabilities: ["workflow_tools"],
    register: (pi: ExtensionAPI) => registerWorkflowTools(pi, options),
  };
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
  type TrustedMappingOptions,
  type IssuedCapability,
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
  validateManualQaArtifact,
  DEFAULT_ARTIFACT_CONTRACT_POLICY,
  type ArtifactContractPolicy,
  type ArtifactIssue,
  type ArtifactValidationResult,
  type ConsumeDiagnostic,
  type ConsumeValidationResult,
  type JsonSchemaDef,
} from "./engine/artifact-contract.js";
export {
  findCurrentCheckpointDecision,
  findHistoricalCheckpointDecision,
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
  OMP_STAGE_HOST_CAPABILITIES,
  stageBindingFor,
  submitStageResult,
  type StageAuthority,
  type StageHostCapabilities,
  type StageHostBindingResolver,
  type StageRecoveryAction,
  type StageRecoveryServiceOptions,
  type StageRecoveryWorkerState,
  type StageReceiptEvidence,
  type StageReceiptOutput,
  type StageResultReceipt,
  type StageResultServiceOptions,
  type StageResultCommitter,
  type StageProducerBinding,
  type StageHostBinding,
  type StageResultSubmissionOutcome,
} from "./engine/reliable-stage.js";
export {
  recoverStageExecution,
  recoveryErrorDigest,
} from "./engine/stage-recovery.js";
export type {
  AuthenticatedRecoveryGrant,
  RecoveryCapability,
  RecoveryCapabilityState,
  RecoveryErrorClass,
  RecoveryEvidenceProof,
  RecoveryFormatRepairEvidence,
  RecoveryHandoffState,
  RecoveryHostInput,
  RecoveryIntent,
  RecoveryOperation,
  RecoveryPreflightNotStartedProof,
  RecoveryReplacementEvidence,
  RecoveryResponsePayload,
  RecoveryRevision,
  RecoveryStateProof,
  RecoveryTerminalEvidence,
  StageRecoveryCapabilities,
  StageRecoveryExecutionOptions,
  StageRecoveryHost,
  StageRecoveryRequest,
  StageRecoveryResult,
  StageRecoverySnapshot,
  StageRecoveryStore,
  StageRecoveryTransitionResult,
  TrustedRecoverySelection,
} from "./engine/stage-recovery.js";
export { createOrdinaryStageRecoveryStore, type OrdinaryStageRecoveryStore } from "./engine/stage-recovery-store.js";
export { createNativeStageRecoveryStore, type NativeStageRecoveryStore } from "./cto/stage-recovery-store.js";
export { commitNativeCtoStageResult, type NativeStageExecutionCommitResult } from "./cto/native-stage-execution.js";
export {
  sanitizeSlot,
  namespacedArtifactId,
  isNamespacedArtifactId,
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
  resolveConfig,
  resolveAgentForRole,
  agentMappingIssueForRole,
  type ConfigPreset,
  type ConfigSource,
  type ConfigDiagnosticCode,
  type ConfigDiagnostic,
  type ConfigProvenance,
  type ResolvedConfig,
} from "./engine/config.js";
export {
  RuntimeConfigError,
  resolveRuntimeConfigPath,
  writeConfig,
  type RuntimeConfigErrorCode,
  type RuntimeConfigWriteOptions,
} from "./runtime-config.js";
export {
  AGENT_MAPPING_SCHEMA,
  DEFAULT_GENERIC_AGENT,
  agentMappingPath,
  buildAgentMapping,
  mappingPreferencesHash,
  readAgentMapping,
  validateAgentMappingState,
  writeAgentMapping,
  type AgentMappingDiagnostic,
  type AgentMappingExpectation,
  type AgentMappingOptions,
  type AgentMappingState,
  type AgentMappingStateValidation,
  type AgentMappingStatus,
  type MappingPreferencesProvenance,
} from "./engine/agent-mapping.js";
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
  withWorkspaceTransaction,
  setStageStatus,
  setPause,
  checkMonotonic,
  resolveActiveBranch,
  resolveCanonicalRun,
  type ResolvedActiveRun,
  type StateSelector,
  type StateSnapshot,
  type StateMutation,
  type StateUpdateResult,
  type StateTxErrorCode,
  reopenFromFeedback,
} from "./engine/state.js";
export {
  resolveLifecycleIntent,
  selectRunCandidate,
  validateLifecycleRequest,
  validateTrustedExecutionContext,
  lifecyclePayloadHash,
  createLifecycleRequestId,
  validateExactPrepareReplay,
  assertValidLifecycleRequest,
  assertTrustedExecutionContext,
  newRequestForTask,
  LifecycleError,
  type LifecycleIntent,
  type LifecycleIntentSource,
  type RunSelectionResult,
} from "./engine/run-lifecycle.js";
export {
  readRunControl,
  updateRunControl,
  runTarget,
  runStatePath,
  readRunState,
  listRuns,
  candidateForState,
  createSelectionSnapshot,
  resolveRunSelection,
  acquireExecutionClaim,
  releaseExecutionClaim,
  reserveExecutionClaimWorkers,
  settleExecutionClaimWorkers,
  handoverExecutionClaim,
  persistCanonicalRun,
  updateCanonicalRun,
  selectSession,
  sessionSelection,
  snapshotCanonicalRun,
  lifecycleTransactionPath,
  ordinaryRunIdentity,
  resumeCanonicalRun,
  finalizeCanonicalRun,
  terminalControlPublication,
  locateDispatchByToolCall,
  locateDispatchesByToolCall,
  type ClaimResult,
  type DispatchLocator,
  type CanonicalRunCommitOptions,
} from "./engine/run-store.js";
export {
  validateOrdinaryRunIdentityValue,
  validateTrustedExecutionContextValue,
  validateLifecycleRequestValue,
  validatePrepareRequestReceiptValue,
  validatePrepareReplay,
} from "./engine/control-plane-contract.js";
export {
  beginLifecycleTransaction,
  commitLifecycleTransaction,
  recoverLifecycleTransactions,
  lifecycleTransactionStatus,
  LifecycleRecoveryError,
  type LifecycleTransactionStatus,
  type LifecycleTransactionRecord,
  type LifecycleFileContent,
} from "./engine/lifecycle-journal.js";
export {
  discoverLegacySources,
  preflightLegacyMigration,
  migrateLegacySource,
  recoverLegacyMigrations,
  type LegacySource,
  type LegacyDiscovery,
  type LegacyDiscoveryIssue,
  type MigrationPreflight,
  type MigrationFailure,
  type MigrationResult,
  type MigrationOutcome,
} from "./engine/run-migration.js";
export {
  readArtifact,
} from "./engine/artifacts.js";
export {
  ACQUISITION_STATUSES,
  ACQUISITION_FAILURE_CODES,
  EVIDENCE_KINDS,
  EVIDENCE_CONFIDENCES,
  DEFAULT_ACQUISITION_LIMITS,
  HARD_ACQUISITION_LIMITS,
  normalizeAcquisitionLimits,
  isValidEvidenceTimestamp,
  isEvidenceSegment,
  validateEvidenceSegment,
  validateTimestampedTranscriptSegment,
  isTimestampedTranscriptSegment,
  normalizeTimestampedTranscriptSegments,
  chunkTimestampedTranscript,
  normalizeAnalysisCandidates,
  validateLectureAcquisitionArtifact,
  type EvidenceIdFactory,
  type AcquisitionStatus,
  type AcquisitionFailureCode,
  type EvidenceKind,
  type EvidenceConfidence,
  type AcquisitionLimits,
  type ParsedLectureUrl,
  type ResolvedVideoSource,
  type AcquisitionFailure,
  type BoundedSourceSet,
  type EvidenceSegment,
  type TimestampedTranscriptSegment,
  type EphemeralAudio,
  type MediaLease,
  type PreparedAudioLease,
  type LectureAuthorization,
  type PipelineLimits,
  type LectureAudioAcquirer,
  type AuthorizedMediaAcquisitionPort,
  type BoundedAudioPreprocessorPort,
  type TimestampedTranscript,
  type TranscriptChunk,
  type AnalysisCandidate,
  type EvidenceDraft,
  type AnalysisResult,
  type PipelineProviderMetadata,
  type LectureAsrPort,
  type TimestampedAsrPort,
  type LectureTextAnalysisPort,
  type TextAnalysisPort,
  type OmpTextInvoker,
  type OmpRuntimeCapabilityProbe,
  type LectureAcquisitionRequest,
  type LectureAcquisitionArtifact,
  type LectureSourceParser,
  type PlaylistExpander,
  type LectureEvidenceProvider,
  type LectureAcquisitionPort,
  type AcquisitionValidationIssue,
} from "./lecture/acquisition.js";
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
	DevAgentUnavailableError,
	type TaskCaller,
	type TaskInvocationOptions,
	type OrchestratorResult,
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
  OrdinaryRunSchema,
  OrdinaryRunIdentity,
  LifecycleMode,
  TrustedExecutionContext,
  CtoClaimScope,
  CtoReleaseProvenance,
  LifecycleSelector,
  LifecycleRequestBase,
  NewLifecycleRequest,
  ResumeLifecycleRequest,
  ReworkLifecycleRequest,
  LifecycleRequest,
  PrepareRequestReceipt,
  RunCandidate,
  RunSelectionSnapshot,
  WorktreeExecutionClaim,
  RunControl,
  LifecycleErrorCode,
  LifecycleErrorShape,
  CapturedDispatchContext,
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
	readCtoState,
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
export {
  runCto,
  ctoRunId,
  finalizeCtoExecution,
  suspendCtoSession,
  finalizeCtoSession,
  type RunCtoOptions,
  type RunCtoResult,
  type CtoIngressOptions,
  type CtoIngressResult,
} from "./cto/run.js";
export {
  parseCtoCommand,
  parseEnvelope as parseCtoEnvelope,
  buildCtoPrompt,
  buildAmendPrompt,
  buildStandbyCtoPrompt,
  renderChannelSection,
  findActiveCtoRun,
  type ParsedCtoEnvelope,
  type ParsedCtoCommand,
  type ParsedCtoCommandFailure,
  type CtoCommandParseResult,
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
export { CtoMigrationError } from "./cto/state.js";
export type { CtoMigrationErrorCode } from "./cto/state.js";
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
	buildCanonicalRunReport,
} from "./report/assemble.js";
export { renderReportHtml } from "./report/html.js";
export { resolveCanonicalRunSource, listCanonicalRunSources } from "./report/canonical-source.js";
export type { CanonicalReportSelector, CanonicalRunReportSource, CanonicalRunReportListEntry } from "./report/canonical-source.js";
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

export {
  createWorkflowReadSelector,
  type ReadSelectorContext,
  type WorkflowReadSelector,
  type WorkflowRunRead,
} from "./engine/read-selector.js";
export {
  createWorkflowSessionController,
  type WorkflowSessionController,
  type WorkflowSessionControllerOptions,
  type WorkflowControllerPrepareRequest,
} from "./engine/host-controller.js";
export {
  parseWorkflowCommand,
  type WorkflowCommandMode,
  type WorkflowCommandParseResult,
  type WorkflowCommandParseSuccess,
  type WorkflowCommandParseFailure,
} from "./commands/envelope.js";

