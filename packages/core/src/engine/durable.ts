/* <!-- omp-cto-slice run=01a03ee4-7dd6-7580-8ad7-16d26dc886ba slice=workflow-v2-core --> */
import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, realpathSync, unlinkSync } from "node:fs";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { loadProfileByIdentity } from "./profile.js";
import { isProviderId, isWorkflowV2Digest, validateProjectIdentity, validateWorkflowRunIdentity } from "../workflow-v2/identity.js";
import { createDiagnostic } from "../workflow-v2/diagnostics.js";
import { resolveState, writeState, isSafeStateSegment, resolveActiveBranch, type ResolvedState, retireCurrentCapability, clearStageBindings } from "./state.js";
import { resolveStageDispatchSlots, selectRoster, type RosterSelectionContext, type RosterSelectionResult } from "./stage.js";
import { readArtifact, writeArtifact } from "./artifacts.js";
import { isDoDComplete, isRootCauseDocumented, readDoD } from "./dod.js";
import { validationGate } from "../gates/validation.js";
import { buildDispatchMarker, dispatchTaskId } from "../gates/dispatch.js";
import { evaluatePredicate } from "./predicate.js";
import {
  appendCheckpointDecision,
  checkpointPolicyHash,
  findCheckpointDecision,
  resolveCheckpointPolicy,
  validateCheckpointDecision,
  unresolvedCheckpointError,
} from "./checkpoints.js";
import { loopExhaustionKind, loopIterationRecord, loopReentryDecision, loopStateFor, resolveBackToStage } from "./loops.js";
import {
  DEFAULT_FAN_IN_POLICY,
  isNamespacedArtifactId,
  namespacedArtifactId,
  synthesizeArtifacts,
  type FanInPolicy,
} from "./fan-in.js";
import {
  artifactSchemaFor,
  validateConsumedArtifacts,
  validateProducedArtifact,
  DEFAULT_ARTIFACT_CONTRACT_POLICY,
  type ArtifactContractPolicy,
} from "./artifact-contract.js";
import type {
  AgentRef,
  EffectivePolicy,
  ProfileIdentity,
  ProjectIdentity,
  ProviderCatalog,
  WorkflowRunIdentity,
  WorkflowV2Diagnostic,
} from "../workflow-v2/types.js";
import type { ScopeFlags } from "./scope.js";
import {
  WorkflowLifecycleError,
  type CapabilityRosterEntry,
  type CheckpointDecision,
  type ChildJoin,
  type CompletionArtifactRef,
  type CompletionEnvelope,
  type DispatchCapabilityState,
  type DispatchCompletion,
  type DispatchRecord,
  type DispatchSlot,
  type LoopState,
  type PendingState,
  type Profile,
  type StageDef,
  type TeamState,
  type TypedCheckpointDecision,
  type WorkIdentity,
  type WorkIdentityScope,
} from "./types.js";
import { PRD_SOURCE_ARTIFACT_IDS, writeProductPrdDocument } from "./product-prd.js";

export type DispatchAuth = {
  token: string;
  capability_id: string;
  run_key: string;
  branch: string;
  workflow: string;
  profile_hash: string;
  stage_cursor: string;
  cursor_epoch: string;
  /** Complete profile-free project binding and required run identity. */
  project_identity: ProjectIdentity;
  run_identity: WorkflowRunIdentity;
  role?: string;
  slot_id?: string;
  task_id?: string;
  retry_of?: string;
  evidence?: string;
  agent?: string;
  agent_ref?: AgentRef;
  expected_count?: number;
  tool_call_id?: string;
  pending?: boolean;
  pending_reason?: PendingState["pending_reason"];
  provider_ref?: string;
};

export interface CapabilityContext {
  readonly project_identity: ProjectIdentity;
  readonly run_identity: WorkflowRunIdentity;
  readonly catalog: Readonly<ProviderCatalog>;
  readonly effective_policy: Readonly<EffectivePolicy>;
  readonly agent_inventory: readonly AgentRef[];
  /** Caller-bound scope required when a prepared state is not yet armed. */
  readonly work_identity_scope?: WorkIdentityScope;
}

type ActiveCapability = DispatchCapabilityState;
/**
 * Project pins and run identity are validated independently.  Runtime
 * activation is project-level; durable authorization additionally requires
 * the exact run id and profile identity selected during workflow_prepare.
 */
function projectIdentityRouteKey(identity: ProjectIdentity): string {
  return JSON.stringify([
    identity.root_instance_id,
    identity.provider_id,
    identity.descriptor_fingerprint,
    identity.executable_provenance.build_fingerprint,
    identity.executable_provenance.runtime_fingerprint,
    identity.catalog_content_digest,
    identity.config_byte_sha256,
    identity.config_semantic_sha256,
    identity.session.session_id,
    identity.session.lifecycle_id,
  ]);
}

function projectIdentityOf(identity: WorkflowRunIdentity): ProjectIdentity {
  return {
    root_instance_id: identity.root_instance_id,
    provider_id: identity.provider_id,
    descriptor_fingerprint: identity.descriptor_fingerprint,
    executable_provenance: identity.executable_provenance,
    catalog_content_digest: identity.catalog_content_digest,
    config_byte_sha256: identity.config_byte_sha256,
    config_semantic_sha256: identity.config_semantic_sha256,
    session: identity.session,
  };
}

function profileIdentityMatches(left: ProfileIdentity, right: ProfileIdentity): boolean {
  return left.id === right.id && left.fingerprint === right.fingerprint;
}

function projectIdentityMatches(expected: ProjectIdentity | undefined, provided: ProjectIdentity | undefined): boolean {
  if (!expected || !provided) return false;
  const expectedChecked = validateProjectIdentity(expected);
  const providedChecked = validateProjectIdentity(provided);
  return expectedChecked.ok && providedChecked.ok && projectIdentityRouteKey(expectedChecked.value) === projectIdentityRouteKey(providedChecked.value);
}

function runIdentityMatches(expected: WorkflowRunIdentity | undefined, provided: WorkflowRunIdentity | undefined): boolean {
  if (!expected || !provided) return false;
  const expectedChecked = validateWorkflowRunIdentity(expected);
  const providedChecked = validateWorkflowRunIdentity(provided);
  return expectedChecked.ok
    && providedChecked.ok
    && projectIdentityMatches(projectIdentityOf(expectedChecked.value), projectIdentityOf(providedChecked.value))
    && expectedChecked.value.run_id === providedChecked.value.run_id
    && profileIdentityMatches(expectedChecked.value.profile_identity, providedChecked.value.profile_identity);
}

function requireProjectIdentity(value: ProjectIdentity | undefined, operation: string): ProjectIdentity {
  const checked = validateProjectIdentity(value);
  if (!checked.ok) {
    throw new WorkflowLifecycleError(createDiagnostic({
      code: "MIGRATION_REQUIRED",
      operation: "runtime.activate",
      severity: "error",
      evidence: { operation, identity_level: "project" },
      remediation: `${operation} requires a complete profile-free project identity`,
    }));
  }
  return checked.value;
}

function requireRunIdentity(value: WorkflowRunIdentity | undefined, operation: string): WorkflowRunIdentity {
  const checked = validateWorkflowRunIdentity(value);
  if (!checked.ok) {
    throw new WorkflowLifecycleError(createDiagnostic({
      code: "MIGRATION_REQUIRED",
      operation: "runtime.activate",
      severity: "error",
      evidence: { operation, identity_level: "run" },
      remediation: `${operation} requires a complete workflow run identity with exact profile identity`,
    }));
  }
  return checked.value;
}

function identityMatches(
  expectedProject: ProjectIdentity | undefined,
  expectedRun: WorkflowRunIdentity | undefined,
  providedProject: ProjectIdentity | undefined,
  providedRun: WorkflowRunIdentity | undefined,
): boolean {
  return projectIdentityMatches(expectedProject, providedProject)
    && runIdentityMatches(expectedRun, providedRun)
    && expectedRun !== undefined
    && providedRun !== undefined
    && projectIdentityMatches(expectedProject, projectIdentityOf(expectedRun))
    && projectIdentityMatches(providedProject, projectIdentityOf(providedRun));
}

function requireIdentity(
  projectIdentity: ProjectIdentity | undefined,
  runIdentity: WorkflowRunIdentity | undefined,
  operation: string,
): { project_identity: ProjectIdentity; run_identity: WorkflowRunIdentity } {
  const project = requireProjectIdentity(projectIdentity, operation);
  const run = requireRunIdentity(runIdentity, operation);
  if (!projectIdentityMatches(project, projectIdentityOf(run))) {
    throw new WorkflowLifecycleError(createDiagnostic({
      code: "IDENTITY_MISMATCH",
      operation: "runtime.activate",
      severity: "error",
      evidence: { operation, identity_level: "project" },
      remediation: `${operation} requires inherited project pins to match the run identity`,
    }));
  }
  return { project_identity: project, run_identity: run };
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isWorkflowName(value: unknown): value is TeamState["classification"]["workflow"] {
  return isNonEmptyString(value);
}

function isCapabilityKind(value: unknown): value is DispatchCapabilityState["kind"] {
  return value === "none" || value === "single" || value === "consilium";
}

function isCapabilityStatus(value: unknown): value is DispatchCapabilityState["status"] {
  return value === "ready"
    || value === "dispatched"
    || value === "joining"
    || value === "complete"
    || value === "invalidated";
}

function isDispatchStatus(value: unknown): value is DispatchRecord["status"] {
  return value === "authorized"
    || value === "running"
    || value === "pending"
    || value === "succeeded"
    || value === "failed"
    || value === "cancelled";
}

function isCompletionOutcome(value: unknown): value is CompletionEnvelope["outcome"] {
  return value === "pending" || value === "succeeded" || value === "failed" || value === "cancelled";
}

function isCompletionTerminalSignal(value: unknown): value is Exclude<CompletionEnvelope["terminal_signal"], null> {
  return value === "workflow_complete"
    || value === "native_tool_result"
    || value === "provider_terminal"
    || value === "contract_failure";
}

function isCompletedBy(value: unknown): value is CompletionEnvelope["completed_by"] {
  return value === "workflow_complete"
    || value === "synchronous_tool_result"
    || value === "engine_task_caller";
}

function isAgentRef(value: unknown): value is AgentRef {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value);
  return keys.length === 3
    && keys.every((key) => ["registered_name", "provider_id", "source_fingerprint"].includes(key))
    && isNonEmptyString(value.registered_name)
    && isProviderId(value.provider_id)
    && isWorkflowV2Digest(value.source_fingerprint);
}

function isWorkIdentity(value: unknown): value is WorkIdentity {
  if (!isRecord(value)) return false;
  const keys = [
    "run_id", "wave_id", "slice_id", "session_id", "workflow", "stage_id", "stage_cursor",
    "capability_id", "capability_epoch", "slot_id", "task_id", "dispatch_id", "attempt", "worker_id",
  ] as const;
  if (Object.keys(value).length !== keys.length || !keys.every((key) => Object.prototype.hasOwnProperty.call(value, key))) return false;
  const requiredStrings = keys.filter((key) => key !== "attempt").map((key) => value[key]);
  return requiredStrings.every(isNonEmptyString) && isWorkflowName(value.workflow) && isPositiveInteger(value.attempt);
}
function isCapabilityRosterEntry(value: unknown): value is CapabilityRosterEntry {
  if (!isRecord(value) || !isNonEmptyString(value.role) || !isNonEmptyString(value.agent) || !isAgentRef(value.agent_ref)) return false;
  if (Object.prototype.hasOwnProperty.call(value, "slot_id") && value.slot_id === undefined) return false;
  if (Object.prototype.hasOwnProperty.call(value, "semantic_role") && value.semantic_role === undefined) return false;
  if (Object.prototype.hasOwnProperty.call(value, "occurrence") && value.occurrence === undefined) return false;
  if (Object.prototype.hasOwnProperty.call(value, "facet") && value.facet === undefined) return false;
  if (value.agent_ref.registered_name !== value.agent) return false;
  if (value.slot_id !== undefined && !isNonEmptyString(value.slot_id)) return false;
  if (value.semantic_role !== undefined && !isNonEmptyString(value.semantic_role)) return false;
  if (value.occurrence !== undefined && !isPositiveInteger(value.occurrence)) return false;
  return value.facet === undefined || value.facet === null || isNonEmptyString(value.facet);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isNonEmptyString);
}

function isCapabilityRosterArray(value: unknown): value is CapabilityRosterEntry[] {
  return Array.isArray(value) && value.every(isCapabilityRosterEntry);
}

function isPendingState(value: unknown): value is PendingState {
  if (!isRecord(value) || !isWorkIdentity(value.identity) || !isNonEmptyString(value.updated_at)) return false;
  const run = validateWorkflowRunIdentity(value.run_identity);
  if (!run.ok || !isDispatchStatus(value.status)) return false;
  if (run.value.run_id !== value.identity.run_id || run.value.session.session_id !== value.identity.session_id) return false;
  if (
    value.pending_reason !== undefined
    && value.pending_reason !== "provider_running"
    && value.pending_reason !== "awaiting_result"
    && value.pending_reason !== "transport_reconnect"
  ) return false;
  if (Object.prototype.hasOwnProperty.call(value, "pending_reason") && value.pending_reason === undefined) return false;
  if (value.provider_ref !== undefined && !isNonEmptyString(value.provider_ref)) return false;
  if (Object.prototype.hasOwnProperty.call(value, "provider_ref") && value.provider_ref === undefined) return false;
  if (value.lease !== undefined) {
    if (!isRecord(value.lease) || !isNonEmptyString(value.lease.token) || !isNonEmptyString(value.lease.observed_at)) return false;
    if (value.lease.revoked_at !== null && !isNonEmptyString(value.lease.revoked_at)) return false;
  }
  if (Object.prototype.hasOwnProperty.call(value, "lease") && value.lease === undefined) return false;
  if (
    value.terminal_signal !== undefined
    && value.terminal_signal !== null
    && !isCompletionTerminalSignal(value.terminal_signal)
  ) return false;
  if (Object.prototype.hasOwnProperty.call(value, "terminal_signal") && value.terminal_signal === undefined) return false;
  if (value.retry_of !== undefined && value.retry_of !== null && !isNonEmptyString(value.retry_of)) return false;
  if (Object.prototype.hasOwnProperty.call(value, "retry_of") && value.retry_of === undefined) return false;
  return value.status !== "pending" || value.terminal_signal === undefined || value.terminal_signal === null;
}

function isPendingStateArray(value: unknown): value is PendingState[] {
  return Array.isArray(value) && value.every(isPendingState);
}

function isCompletionArtifactRef(value: unknown): value is CompletionArtifactRef {
  if (!isRecord(value)) return false;
  const artifactId = value.artifact_id;
  const path = value.path;
  const sha256 = value.sha256;
  const schemaStatus = value.schema_status;
  const dodStatus = value.dod_status;
  return isNonEmptyString(artifactId)
    && isNonEmptyString(path)
    && typeof sha256 === "string"
    && /^[0-9a-f]{64}$/.test(sha256)
    && (schemaStatus === "met" || schemaStatus === "failed")
    && (dodStatus === "met" || dodStatus === "pending" || dodStatus === "failed");
}

function isCompletionEnvelope(value: unknown): value is CompletionEnvelope {
  if (!isRecord(value)) return false;
  const identity = value.identity;
  const runIdentity = value.run_identity;
  const outcome = value.outcome;
  const terminalSignal = value.terminal_signal;
  const artifactRefs = value.artifact_refs;
  const run = validateWorkflowRunIdentity(runIdentity);
  if (
    value.schema_version !== 1
    || !isWorkIdentity(identity)
    || !run.ok
    || run.value.run_id !== identity.run_id
    || run.value.session.session_id !== identity.session_id
    || !isCompletionOutcome(outcome)
    || (terminalSignal !== null && !isCompletionTerminalSignal(terminalSignal))
    || (Object.prototype.hasOwnProperty.call(value, "terminal_signal") && terminalSignal === undefined)
    || !Array.isArray(artifactRefs)
    || !artifactRefs.every(isCompletionArtifactRef)
    || (value.evidence_ref !== null && !isNonEmptyString(value.evidence_ref))
    || (value.conflict_ref !== null && !isNonEmptyString(value.conflict_ref))
    || !isCompletedBy(value.completed_by)
    || !isNonEmptyString(value.emitted_at)
  ) return false;
  return true;
}

function isDispatchCompletion(value: unknown): value is DispatchCompletion {
  if (!isRecord(value)) return false;
  const outcome = value.outcome;
  const artifactIds = value.artifact_ids;
  const runIdentity = value.run_identity;
  const run = validateWorkflowRunIdentity(runIdentity);
  if (
    !isNonEmptyString(value.dispatch_id)
    || !isNonEmptyString(value.cursor_epoch)
    || !isCompletionOutcome(outcome)
    || outcome === "pending"
    || !isStringArray(artifactIds)
    || artifactIds.some((id) => !isSafeStateSegment(id))
    || !isNonEmptyString(value.evidence)
    || !isCompletedBy(value.completed_by)
    || !isNonEmptyString(value.completed_at)
    || !run.ok
    || (Object.prototype.hasOwnProperty.call(value, "work_identity") && value.work_identity === undefined)
  ) return false;
  if (value.work_identity !== undefined) {
    if (!isWorkIdentity(value.work_identity)) return false;
    if (run.value.run_id !== value.work_identity.run_id || run.value.session.session_id !== value.work_identity.session_id) return false;
  }
  return true;
}

function isDispatchRecord(value: unknown): value is DispatchRecord {
  if (!isRecord(value)) return false;
  const run = validateWorkflowRunIdentity(value.run_identity);
  if (
    !isNonEmptyString(value.id)
    || !isNonEmptyString(value.role)
    || !isNonEmptyString(value.agent)
    || !isDispatchStatus(value.status)
    || !isPositiveInteger(value.attempt)
    || !isNonEmptyString(value.created_at)
    || !run.ok
    || !isWorkIdentity(value.work_identity)
    || run.value.run_id !== value.work_identity.run_id
    || run.value.session.session_id !== value.work_identity.session_id
  ) return false;
  if (Object.prototype.hasOwnProperty.call(value, "agent_ref") && value.agent_ref === undefined) return false;
  if (value.agent_ref !== undefined && !isAgentRef(value.agent_ref)) return false;
  if (Object.prototype.hasOwnProperty.call(value, "tool_call_id") && value.tool_call_id === undefined) return false;
  if (value.tool_call_id !== undefined && !isNonEmptyString(value.tool_call_id)) return false;
  if (Object.prototype.hasOwnProperty.call(value, "completed_at") && value.completed_at === undefined) return false;
  if (value.completed_at !== undefined && !isNonEmptyString(value.completed_at)) return false;
  if (Object.prototype.hasOwnProperty.call(value, "pending") && value.pending === undefined) return false;
  if (value.pending !== undefined && !isPendingState(value.pending)) return false;
  if (Object.prototype.hasOwnProperty.call(value, "completion") && value.completion === undefined) return false;
  if (value.completion !== undefined && !isDispatchCompletion(value.completion)) return false;
  if (Object.prototype.hasOwnProperty.call(value, "completion_envelope") && value.completion_envelope === undefined) return false;
  if (value.completion_envelope !== undefined && !isCompletionEnvelope(value.completion_envelope)) return false;
  return true;
}

function isDispatchRecordArray(value: unknown): value is DispatchRecord[] {
  return Array.isArray(value) && value.every(isDispatchRecord);
}

function isDispatchCapabilityState(value: unknown): value is DispatchCapabilityState {
  if (!isRecord(value)) return false;
  const issued = value.issued_for;
  if (!isRecord(issued)) return false;
  const project = validateProjectIdentity(value.project_identity);
  const run = validateWorkflowRunIdentity(value.run_identity);
  const issuedProject = validateProjectIdentity(issued.project_identity);
  const issuedRun = validateWorkflowRunIdentity(issued.run_identity);
  if (
    !project.ok
    || !run.ok
    || !issuedProject.ok
    || !issuedRun.ok
    || !projectIdentityMatches(project.value, issuedProject.value)
    || !runIdentityMatches(run.value, issuedRun.value)
    || !projectIdentityMatches(project.value, projectIdentityOf(run.value))
    || !projectIdentityMatches(issuedProject.value, projectIdentityOf(issuedRun.value))
  ) return false;
  const capabilityId = value.capability_id;
  const dispatchTokenHash = value.dispatch_token_hash;
  const advanceTokenHash = value.advance_token_hash;
  if (
    !isNonEmptyString(capabilityId)
    || typeof dispatchTokenHash !== "string"
    || !/^[0-9a-f]{64}$/.test(dispatchTokenHash)
    || typeof advanceTokenHash !== "string"
    || !/^[0-9a-f]{64}$/.test(advanceTokenHash)
    || !isCapabilityKind(value.kind)
    || !isCapabilityStatus(value.status)
  ) return false;
  const issuedStrings = [issued.run_key, issued.branch, issued.profile_hash, issued.stage_cursor, issued.cursor_epoch];
  const issuedWorkflowValue = issued.workflow;
  if (!issuedStrings.every(isNonEmptyString) || !isWorkflowName(issuedWorkflowValue)) return false;
  const issuedWorkflow = issuedWorkflowValue;
  if (
    issued.profile_hash !== run.value.profile_identity.fingerprint
    || issuedRun.value.run_id !== run.value.run_id
    || issuedRun.value.profile_identity.id !== run.value.profile_identity.id
    || issuedRun.value.profile_identity.fingerprint !== run.value.profile_identity.fingerprint
  ) return false;
  const expectedRolesValue = value.expected_roles;
  const expectedRosterValue = value.expected_roster;
  const expectedCountValue = value.expected_count;
  const dispatchesValue = value.dispatches;
  if (
    !isStringArray(expectedRolesValue)
    || !isNonNegativeInteger(expectedCountValue)
    || !isCapabilityRosterArray(expectedRosterValue)
    || !isDispatchRecordArray(dispatchesValue)
  ) return false;
  const expectedRoles = expectedRolesValue;
  const expectedRoster = expectedRosterValue;
  const expectedCount = expectedCountValue;
  const dispatches = dispatchesValue;
  if (
    (value.kind === "none" ? expectedCount !== 0 : expectedCount <= 0)
    || expectedCount !== expectedRoles.length
    || expectedCount !== expectedRoster.length
    || new Set(expectedRoles).size !== expectedRoles.length
    || new Set(expectedRoster.map((entry) => entry.role)).size !== expectedRoster.length
    || expectedRoles.some((role) => !expectedRoster.some((entry) => entry.role === role))
    || expectedRoster.some((entry) => {
      const agentRef = entry.agent_ref;
      return !isAgentRef(agentRef) || agentRef.provider_id !== project.value.provider_id;
    })
  ) return false;
  if (value.pending !== undefined && (!isPendingStateArray(value.pending) || value.pending.some((pending) =>
    !runIdentityMatches(run.value, pending.run_identity)
    || pending.identity.workflow !== issuedWorkflow
    || pending.identity.stage_id !== issued.stage_cursor
    || pending.identity.stage_cursor !== issued.stage_cursor
    || pending.identity.capability_id !== capabilityId
    || pending.identity.capability_epoch !== issued.cursor_epoch
  ))) return false;
  if (value.work_identity !== undefined && !isWorkIdentity(value.work_identity)) return false;
  const identityValid = (identity: WorkIdentity, record: DispatchRecord): boolean =>
    identity.run_id === run.value.run_id
    && identity.workflow === issuedWorkflow
    && identity.stage_id === issued.stage_cursor
    && identity.stage_cursor === issued.stage_cursor
    && identity.capability_id === capabilityId
    && identity.capability_epoch === issued.cursor_epoch
    && identity.slot_id === record.role
    && identity.task_id.length > 0
    && identity.dispatch_id === record.id
    && identity.attempt === record.attempt
    && identity.worker_id === record.agent;
  const recordIdentityValid = (record: DispatchRecord): boolean => {
    const recordRun = validateWorkflowRunIdentity(record.run_identity);
    return recordRun.ok && runIdentityMatches(run.value, recordRun.value);
  };
  const envelopeValid = (
    envelope: CompletionEnvelope | undefined,
    identity: WorkIdentity,
    outcome: CompletionEnvelope["outcome"],
  ): boolean => envelope !== undefined
    && envelope.schema_version === 1
    && sameIdentity(envelope.identity, identity)
    && runIdentityMatches(run.value, envelope.run_identity)
    && envelope.outcome === outcome
    && (outcome === "pending" ? envelope.terminal_signal === null : envelope.terminal_signal !== null);
  for (const record of dispatches) {
    const identity = record.work_identity;
    if (
      !identity
      || !recordIdentityValid(record)
      || !identityValid(identity, record)
      || !expectedRoles.includes(record.role)
    ) return false;
    const expected = expectedRoster.find((entry) => entry.role === record.role);
    if (
      !expected
      || !record.agent_ref
      || expected.agent !== record.agent
      || expected.agent_ref?.registered_name !== record.agent_ref.registered_name
      || expected.agent_ref?.provider_id !== record.agent_ref.provider_id
      || expected.agent_ref?.source_fingerprint !== record.agent_ref.source_fingerprint
    ) return false;
    const completion = record.completion;
    if (record.status !== "succeeded" && record.status !== "failed" && record.status !== "cancelled") {
      if (completion !== undefined || !envelopeValid(record.completion_envelope, identity, "pending")) return false;
      const pending = record.pending;
      if (
        pending !== undefined
        && (
          !runIdentityMatches(run.value, pending.run_identity)
          || pending.identity.dispatch_id !== record.id
          || pending.identity.slot_id !== record.role
          || pending.identity.workflow !== identity.workflow
          || pending.identity.stage_id !== identity.stage_id
          || pending.identity.stage_cursor !== identity.stage_cursor
          || pending.identity.capability_id !== identity.capability_id
          || pending.identity.capability_epoch !== identity.capability_epoch
          || pending.status !== record.status
          || (record.status === "pending" && pending.terminal_signal !== undefined && pending.terminal_signal !== null)
        )
      ) return false;
      continue;
    }
    if (
      !completion
      || completion.dispatch_id !== record.id
      || completion.cursor_epoch !== issued.cursor_epoch
      || completion.outcome !== record.status
      || !completion.evidence.trim()
      || !completion.artifact_ids.every((id) => isSafeStateSegment(id))
      || record.completed_at !== completion.completed_at
      || !completion.work_identity
      || !sameIdentity(completion.work_identity, identity)
      || !runIdentityMatches(run.value, completion.run_identity)
      || !envelopeValid(record.completion_envelope, identity, record.status)
    ) return false;
  }
  const latestByRole = new Map<string, DispatchRecord>();
  for (const record of dispatches) {
    const previous = latestByRole.get(record.role);
    if (previous && previous.status !== "failed" && previous.status !== "cancelled") return false;
    latestByRole.set(record.role, record);
  }
  return true;
}

const activeCapability = (value: unknown): ActiveCapability | null =>
  isDispatchCapabilityState(value) ? value : null;
/** Issued capability secrets plus the persisted capability state (see createCapability). */
export type IssuedCapability = {
  capability_id: string;
  dispatch_token: string;
  advance_token: string;
  work_identity: WorkIdentity;
  state: DispatchCapabilityState;
};

export type TransitionResult =
  | { ok: true; state: TeamState; record?: DispatchRecord; handoff?: CapabilityHandoff; child_join?: ChildJoin }
  | { ok: false; error: string; state?: TeamState; child_join?: ChildJoin; diagnostic?: WorkflowV2Diagnostic };

export interface CapabilityHandoff {
  capability_id: string;
  dispatch_token: string;
  advance_token: string;
  run_key: string;
  branch: string;
  workflow: TeamState["classification"]["workflow"];
  /** Complete profile-free project identity used for runtime preflight. */
  project_identity: ProjectIdentity;
  /** Exact profile/run identity selected during workflow_prepare. */
  run_identity: WorkflowRunIdentity;
  /** Complete profile fingerprint from the selected catalog identity. */
  profile_hash: string;
  stage_cursor: string;
  cursor_epoch: string;
  kind: "none" | "single" | "consilium";
  expected_roster: Array<{ role: string; agent: string }>;
  dispatch_markers: Array<{ role: string; agent: string; marker: string }>;
}

function handoffFromState(
  state: TeamState,
  secrets: { capability_id: string; dispatch_token: string; advance_token: string },
  stage: StageDef,
): CapabilityHandoff | undefined {
  const cap = activeCapability(state.dispatch_capability);
  if (!cap || cap.capability_id !== secrets.capability_id) return undefined;
  const roles = cap.expected_roster.map(({ role }) => role);
  const dispatch_markers = cap.kind === "none"
    ? []
    : cap.expected_roster.map(({ role, agent }) => ({
      role,
      agent,
      marker: buildDispatchMarker(
        cap.issued_for.run_key,
        stage,
        roles,
        role,
        cap.issued_for.cursor_epoch,
        cap.capability_id,
        role,
        expectedTaskId(cap, role),
      ),
    }));
  return {
    capability_id: secrets.capability_id,
    dispatch_token: secrets.dispatch_token,
    advance_token: secrets.advance_token,
    run_key: cap.issued_for.run_key,
    branch: cap.issued_for.branch,
    workflow: cap.issued_for.workflow,
    project_identity: cap.project_identity,
    run_identity: cap.run_identity,
    profile_hash: cap.issued_for.profile_hash,
    stage_cursor: cap.issued_for.stage_cursor,
    cursor_epoch: cap.issued_for.cursor_epoch,
    kind: cap.kind,
    expected_roster: cap.expected_roster.map(({ role, agent }) => ({ role, agent })),
    dispatch_markers,
  };
}
const hash = (value: string): string => createHash("sha256").update(value).digest("hex");
const now = (): string => new Date().toISOString();
type StageStateEntry = TeamState["stages"][number];
function stageWithStatus(entry: StageStateEntry, status: StageStateEntry["status"]): StageStateEntry {
  return { ...entry, status };
}
const current = (cwd: string, expectedRunIdentity: WorkflowRunIdentity): { state: TeamState; target: ResolvedState } | null => {
  const target = resolveState(cwd, resolveActiveBranch(cwd), expectedRunIdentity);
  return target.state ? { state: target.state, target } : null;
};
const persist = (cwd: string, state: TeamState, target: ResolvedState): void => {
  if (!target.statePath || !target.stateDir || !target.artifactsDir) throw new Error("state target missing");
  writeState(cwd, state, { target });
};

function transitionFailure(
  code: WorkflowV2Diagnostic["code"],
  operation: WorkflowV2Diagnostic["operation"],
  remediation: string,
  state?: TeamState,
  evidence: Record<string, unknown> = {},
): TransitionResult {
  const diagnostic = createDiagnostic({ code, operation, severity: "error", evidence, remediation });
  return { ok: false, error: `${code}: ${remediation}`, ...(state ? { state } : {}), diagnostic };
}
function workIdentityFor(
  state: TeamState,
  cap: Pick<ActiveCapability, "issued_for" | "capability_id" | "work_identity">,
  role: string,
  agent: string,
  dispatchId: string,
  attempt: number,
  taskId?: string,
): WorkIdentity {
  const stateIdentity = state.work_identity;
  const capIdentity = cap.work_identity;
  if (!isWorkIdentity(stateIdentity) || !isWorkIdentity(capIdentity)) {
    throw new WorkflowLifecycleError(createDiagnostic({
      code: "MIGRATION_REQUIRED",
      operation: "runtime.activate",
      severity: "error",
      evidence: { field: "work_identity" },
      remediation: "The workflow caller must issue matching complete work identities before dispatch.",
    }));
  }
  const identityFields = [
    "run_id", "wave_id", "slice_id", "session_id", "workflow", "stage_id",
    "stage_cursor", "capability_id", "capability_epoch", "slot_id", "task_id",
    "dispatch_id", "attempt", "worker_id",
  ] as const;
  if (identityFields.some((field) => stateIdentity[field] !== capIdentity[field])) {
    throw new WorkflowLifecycleError(createDiagnostic({
      code: "IDENTITY_MISMATCH",
      operation: "runtime.activate",
      severity: "error",
      evidence: { field: "work_identity" },
      remediation: "The persisted dispatch work identities do not match; migrate the workflow before dispatch.",
    }));
  }
  return {
    ...capIdentity,
    workflow: cap.issued_for.workflow,
    stage_id: cap.issued_for.stage_cursor,
    stage_cursor: cap.issued_for.stage_cursor,
    capability_id: cap.capability_id,
    capability_epoch: cap.issued_for.cursor_epoch,
    slot_id: role,
    task_id: taskId ?? capIdentity.task_id,
    dispatch_id: dispatchId,
    attempt,
    worker_id: agent,
  };
}

function pendingFor(
  identity: WorkIdentity,
  runIdentity: WorkflowRunIdentity,
  status: PendingState["status"],
  reason?: PendingState["pending_reason"],
  providerRef?: string,
  retryOf?: string | null,
): PendingState {
  return {
    identity,
    run_identity: runIdentity,
    status,
    ...(reason ? { pending_reason: reason } : {}),
    ...(providerRef ? { provider_ref: providerRef } : {}),
    ...(status === "pending" ? { lease: { token: randomUUID(), observed_at: now(), revoked_at: null }, terminal_signal: null } : {}),
    ...(retryOf !== undefined ? { retry_of: retryOf } : {}),
    updated_at: now(),
  };
}

function completionArtifactRefs(
  artifactsDir: string,
  artifactIds: string[],
): CompletionArtifactRef[] {
  return artifactIds.map((artifactId) => {
    const value = readArtifact(artifactsDir, artifactId);
    return {
      artifact_id: artifactId,
      path: `${artifactId}.json`,
      sha256: hash(JSON.stringify(value)),
      schema_status: value === null ? "failed" : "met",
      dod_status: value === null ? "failed" : "met",
    };
  });
}
function completionEnvelopeFor(
  identity: WorkIdentity,
  runIdentity: WorkflowRunIdentity,
  outcome: CompletionEnvelope["outcome"],
  terminalSignal: CompletionEnvelope["terminal_signal"],
  artifactRefs: CompletionArtifactRef[],
  evidence: string,
  completedBy: CompletionEnvelope["completed_by"],
): CompletionEnvelope {
  return {
    schema_version: 1,
    identity,
    run_identity: runIdentity,
    outcome,
    terminal_signal: terminalSignal,
    artifact_refs: artifactRefs,
    evidence_ref: evidence.trim() ? `evidence/${identity.dispatch_id}` : null,
    conflict_ref: null,
    completed_by: completedBy,
    emitted_at: now(),
  };
}

function workIdentityScopeForStage(state: TeamState, stageId: string): WorkIdentityScope {
  const identity = state.work_identity;
  if (!isWorkIdentity(identity)) {
    throw new WorkflowLifecycleError(createDiagnostic({
      code: "MIGRATION_REQUIRED",
      operation: "runtime.activate",
      severity: "error",
      evidence: { field: "work_identity" },
      remediation: "The persisted workflow must carry a complete work identity before capability creation.",
    }));
  }
  const { capability_id: _capability_id, capability_epoch: _capability_epoch, ...scope } = identity;
  return { ...scope, stage_id: stageId, stage_cursor: stageId };
}

const WORK_IDENTITY_SCOPE_KEYS = [
  "run_id",
  "wave_id",
  "slice_id",
  "session_id",
  "workflow",
  "stage_id",
  "stage_cursor",
  "slot_id",
  "task_id",
  "dispatch_id",
  "attempt",
  "worker_id",
] as const;

function isWorkIdentityScope(value: unknown): value is WorkIdentityScope {
  if (!isRecord(value) || Object.keys(value).length !== WORK_IDENTITY_SCOPE_KEYS.length) return false;
  if (!WORK_IDENTITY_SCOPE_KEYS.every((key) => Object.prototype.hasOwnProperty.call(value, key))) return false;
  return WORK_IDENTITY_SCOPE_KEYS.filter((key) => key !== "attempt").every((key) => isNonEmptyString(value[key]))
    && isWorkflowName(value.workflow)
    && isPositiveInteger(value.attempt);
}

export function createCapability(input: {
  run_key: string;
  branch: string;
  workflow: TeamState["classification"]["workflow"];
  profile_hash: string;
  stage_cursor: string;
  kind: "none" | "single" | "consilium";
  expected_roles?: string[];
  expected_roster?: Array<{
    role: string;
    agent: string;
    agent_ref: AgentRef;
    slot_id?: string;
    semantic_role?: string;
    occurrence?: number;
    facet?: string | null;
  }>;
  roster_selection?: TeamState["roster_selection"];
  work_identity_scope: WorkIdentityScope;
  project_identity: ProjectIdentity;
  run_identity: WorkflowRunIdentity;
}): IssuedCapability {
  const { project_identity, run_identity } = requireIdentity(input.project_identity, input.run_identity, "capability creation");
  const scope = input.work_identity_scope;
  if (
    !input.run_key
    || !input.branch
    || !input.workflow
    || !input.stage_cursor
    || !input.profile_hash
    || input.profile_hash !== run_identity.profile_identity.fingerprint
  ) {
    throw new WorkflowLifecycleError(createDiagnostic({
      code: "IDENTITY_MISMATCH",
      operation: "runtime.activate",
      severity: "error",
      evidence: { operation: "capability creation", run_id: run_identity.run_id, profile_id: run_identity.profile_identity.id },
      remediation: "Use the selected catalog run identity and its complete profile fingerprint for the capability.",
    }));
  }
  if (!isWorkIdentityScope(scope)) {
    throw new WorkflowLifecycleError(createDiagnostic({
      code: "MIGRATION_REQUIRED",
      operation: "runtime.activate",
      severity: "error",
      evidence: { operation: "capability work identity", field: "work_identity_scope" },
      remediation: "The workflow caller must provide an exact twelve-field work identity scope before dispatch.",
    }));
  }
  if (
    scope.run_id !== run_identity.run_id
    || scope.session_id !== run_identity.session.session_id
    || scope.workflow !== input.workflow
    || scope.stage_id !== input.stage_cursor
    || scope.stage_cursor !== input.stage_cursor
  ) {
    throw new WorkflowLifecycleError(createDiagnostic({
      code: "IDENTITY_MISMATCH",
      operation: "runtime.activate",
      severity: "error",
      evidence: {
        operation: "capability work identity",
        run_id: run_identity.run_id,
        stage_cursor: input.stage_cursor,
      },
      remediation: "Bind the capability to the exact prepared run, session, workflow, and target stage.",
    }));
  }
  const capability_id = randomUUID();
  const capability_epoch = randomUUID();
  const dispatch_token = randomUUID();
  const advance_token = randomUUID();
  const work_identity: WorkIdentity = {
    ...scope,
    capability_id,
    capability_epoch,
  };
  const roster: CapabilityRosterEntry[] = (input.expected_roster ?? []).map((entry) => ({
    role: entry.role,
    agent: entry.agent,
    agent_ref: entry.agent_ref,
    ...(entry.slot_id !== undefined ? { slot_id: entry.slot_id } : {}),
    ...(entry.semantic_role !== undefined ? { semantic_role: entry.semantic_role } : {}),
    ...(entry.occurrence !== undefined ? { occurrence: entry.occurrence } : {}),
    ...(entry.facet !== undefined ? { facet: entry.facet } : {}),
  }));
  if ((input.kind === "none" && roster.length !== 0) || (input.kind === "single" && roster.length !== 1) || (input.kind === "consilium" && roster.length === 0)) {
    throw new Error("capability roster does not match dispatch kind");
  }
  const expected_roles = input.expected_roles ?? roster.map((entry) => entry.role);
  if (
    !isStringArray(expected_roles)
    || new Set(expected_roles).size !== expected_roles.length
    || expected_roles.length !== roster.length
    || expected_roles.some((role, index) => role !== roster[index]?.role)
    || roster.some((entry) =>
      !entry.role
      || !entry.agent
      || !entry.agent_ref
      || entry.agent_ref.registered_name !== entry.agent
      || entry.agent_ref.provider_id !== project_identity.provider_id
      || !isProviderId(entry.agent_ref.provider_id)
      || !isWorkflowV2Digest(entry.agent_ref.source_fingerprint))
  ) {
    throw new WorkflowLifecycleError(createDiagnostic({
      code: "MIGRATION_REQUIRED",
      operation: "runtime.activate",
      severity: "error",
      evidence: { operation: "capability roster" },
      remediation: "Persist provider-qualified agent references for every dispatch slot.",
    }));
  }
  const state: DispatchCapabilityState = {
    capability_id,
    dispatch_token_hash: hash(dispatch_token),
    advance_token_hash: hash(advance_token),
    issued_for: {
      run_key: input.run_key,
      branch: input.branch,
      workflow: input.workflow,
      profile_hash: input.profile_hash,
      stage_cursor: input.stage_cursor,
      cursor_epoch: capability_epoch,
      project_identity,
      run_identity,
    },
    kind: input.kind,
    project_identity,
    run_identity,
    expected_roles,
    expected_count: roster.length,
    expected_roster: roster,
    ...(input.roster_selection ? { roster_selection: input.roster_selection } : {}),
    work_identity,
    status: "ready",
    dispatches: [],
  };
  return { capability_id, dispatch_token, advance_token, work_identity, state };
}
function reissueActiveCapability(cap: ActiveCapability): IssuedCapability {
  const dispatch_token = randomUUID();
  const advance_token = randomUUID();
  return {
    capability_id: cap.capability_id,
    dispatch_token,
    advance_token,
    work_identity: cap.work_identity,
    state: {
      ...cap,
      dispatch_token_hash: hash(dispatch_token),
      advance_token_hash: hash(advance_token),
    },
  };
}

/** Remove one stale slot snapshot only after validating it stays in the target artifact tree. */
function removeClearedArtifactFile(target: ResolvedState, candidate: string): void {
  const artifactsDir = target.artifactsDir;
  if (!artifactsDir || !isAbsolute(candidate)) return;
  try {
    const realRoot = realpathSync(artifactsDir);
    if (!existsSync(candidate) || !lstatSync(candidate).isFile()) return;
    const realCandidate = realpathSync(candidate);
    const rel = relative(realRoot, realCandidate);
    if (rel === "" || rel === ".." || rel.startsWith(".." + sep) || isAbsolute(rel)) return;
    unlinkSync(candidate);
  } catch {
    // Stale cleanup is intentionally best-effort; capability reset remains authoritative.
  }
}

function resetReopenedStageState(
  state: TeamState,
  target: ResolvedState,
  profile: Profile,
  stageId: string,
  existing: ActiveCapability | null,
): TeamState {
  const index = state.stages.findIndex((entry) => entry.id === stageId);
  if (index < 0) return state;
  const clearedStageIds = new Set(state.stages.slice(index).map((entry) => entry.id));
  const profileIndex = profile.stages.findIndex((entry) => entry.id === stageId);
  if (profileIndex >= 0) {
    for (const stage of profile.stages.slice(profileIndex)) clearedStageIds.add(stage.id);
  }
  const clearedProduced = new Set(
    profileIndex < 0 ? [] : profile.stages.slice(profileIndex).flatMap((stage) => stageProduces(stage)),
  );
  const staleFiles = new Set<string>();
  const clearedArtifactIds = new Set<string>();
  for (const clearedStageId of clearedStageIds) {
    const records = state.slot_artifacts?.[clearedStageId];
    for (const slotRecords of Object.values(records?.slots ?? {})) {
      for (const [artifactId, record] of Object.entries(slotRecords ?? {})) {
        clearedArtifactIds.add(artifactId);
        if (record && typeof record.path === "string") staleFiles.add(record.path);
      }
    }
  }
  if (existing && clearedStageIds.has(existing.issued_for.stage_cursor)) {
    for (const record of existing.dispatches) {
      for (const id of record.completion?.artifact_ids ?? []) {
        clearedArtifactIds.add(id);
        if (clearedProduced.has(id) && target.artifactsDir) staleFiles.add(join(target.artifactsDir, id + ".json"));
      }
    }
  }
  for (const path of staleFiles) removeClearedArtifactFile(target, path);

  const retainedSlotArtifacts = Object.fromEntries(
    Object.entries(state.slot_artifacts ?? {}).filter(([id]) => !clearedStageIds.has(id)),
  );
  // Upstream mappings are intentionally retained; only artifacts named by cleared records are stale.
  const retainedArtifacts = Object.fromEntries(
    Object.entries(state.artifacts ?? {}).filter(([id]) => !clearedArtifactIds.has(id)),
  );
  const retainedState: TeamState = {
    ...state,
    artifacts: retainedArtifacts,
    ...(Object.keys(retainedSlotArtifacts).length > 0 ? { slot_artifacts: retainedSlotArtifacts } : {}),
  };
  const retired = retireCurrentCapability(retainedState, "reopen_from_feedback");
  return clearStageBindings(retired, clearedStageIds);
}
/**
 * Resolve the selected profile strictly from the caller-provided catalog.
 * Configuration and process-global registries are never consulted here.
 */
type ContextProfileResult =
  | { profile: Profile; profile_identity: ProfileIdentity }
  | { error: string; diagnostic: WorkflowV2Diagnostic };

function contextProfile(context: CapabilityContext): ContextProfileResult {
  const { project_identity, run_identity } = requireIdentity(context.project_identity, context.run_identity, "workflow dispatch");
  if (
    context.effective_policy.provider.id !== project_identity.provider_id
    || context.effective_policy.provider.descriptor_fingerprint !== project_identity.descriptor_fingerprint
    || context.effective_policy.provider.catalog_content_digest !== project_identity.catalog_content_digest
    || context.catalog.content_digest !== project_identity.catalog_content_digest
  ) {
    const diagnostic = createDiagnostic({
      code: "IDENTITY_MISMATCH",
      operation: "runtime.activate",
      severity: "error",
      evidence: { operation: "workflow dispatch" },
      remediation: "Use the provider catalog and effective policy selected by this workflow run identity.",
    });
    return { error: `${diagnostic.code}: ${diagnostic.remediation}`, diagnostic };
  }
  if (context.effective_policy.workflow.selection === "fixed"
    && context.effective_policy.workflow.profile_identity !== undefined
    && (
      context.effective_policy.workflow.profile_identity.id !== run_identity.profile_identity.id
      || context.effective_policy.workflow.profile_identity.fingerprint !== run_identity.profile_identity.fingerprint
    )) {
    const diagnostic = createDiagnostic({
      code: "IDENTITY_MISMATCH",
      operation: "runtime.activate",
      severity: "error",
      evidence: { operation: "fixed workflow profile", profile: run_identity.profile_identity.id },
      remediation: "Use the fixed workflow profile identity selected for this run.",
    });
    return { error: `${diagnostic.code}: ${diagnostic.remediation}`, diagnostic };
  }
  const loaded = loadProfileByIdentity(context.catalog, run_identity.profile_identity);
  if (!loaded.ok) {
    const diagnostic = createDiagnostic({
      code: "PROFILE_UNAVAILABLE",
      operation: "profile.resolve",
      severity: "error",
      evidence: { operation: "workflow dispatch", profile: run_identity.profile_identity.id },
      remediation: "Re-select a profile from the current provider catalog before dispatch.",
    });
    return { error: `${diagnostic.code}: ${diagnostic.remediation}`, diagnostic };
  }
  return { profile: loaded.value, profile_identity: run_identity.profile_identity };
}

function qualifiedAgentForRole(
  role: string,
  context: CapabilityContext,
): AgentRef | undefined {
  const ref = context.effective_policy.roles[role];
  if (!ref || ref.provider_id !== context.project_identity.provider_id) return undefined;
  const observed = context.agent_inventory.find((candidate) =>
    candidate.registered_name === ref.registered_name
    && candidate.provider_id === ref.provider_id
    && candidate.source_fingerprint === ref.source_fingerprint);
  return observed ? ref : undefined;
}


function rosterWithQualifiedAgents(
  slots: DispatchSlot[],
  context: CapabilityContext,
): Array<{ role: string; agent: string; agent_ref: AgentRef }> | undefined {
  const roster: Array<{ role: string; agent: string; agent_ref: AgentRef }> = [];
  for (const slot of slots) {
    const agent_ref = qualifiedAgentForRole(slot.role, context);
    if (!agent_ref) return undefined;
    roster.push({ role: slot.slot, agent: agent_ref.registered_name, agent_ref });
  }
  return roster;
}


export function beginCapability(cwd: string, context: CapabilityContext): TransitionResult {
  const identity = requireIdentity(context.project_identity, context.run_identity, "workflow dispatch");
  const branch = resolveActiveBranch(cwd);
  const target = resolveState(cwd, branch, identity.run_identity);
  if (target.invalid) return transitionFailure("MIGRATION_REQUIRED", "runtime.activate", "workflow state is invalid or requires explicit migration", target.state ?? undefined);
  if (!target.state || !target.statePath) return { ok: false, error: "workflow state not found" };
  if (target.isStale) return { ok: false, error: "workflow state is stale for the active branch", state: target.state };
  const state = target.state;
  if (!state.project_identity || !state.run_identity) {
    return transitionFailure("MIGRATION_REQUIRED", "runtime.activate", "workflow state has no canonical project/run identity", state, { field: "run_identity" });
  }
  if (!identityMatches(state.project_identity, state.run_identity, identity.project_identity, identity.run_identity)) {
    return transitionFailure("IDENTITY_MISMATCH", "runtime.activate", "workflow state belongs to a different provider/config/run identity", state);
  }
  const selected = contextProfile(context);
  if ("error" in selected) return { ok: false, error: selected.error, state, diagnostic: selected.diagnostic };
  const { profile, profile_identity } = selected;
  const workflow = state.classification?.workflow;
  if (!workflow) {
    return transitionFailure(
      "MIGRATION_REQUIRED",
      "runtime.activate",
      "workflow classification is missing from the persisted v2 state",
      state,
      { field: "classification.workflow" },
    );
  }
  if (workflow !== profile.name || profile_identity.id !== workflow) {
    return transitionFailure("IDENTITY_MISMATCH", "runtime.activate", "workflow profile does not match selected catalog identity", state);
  }
  if (!Array.isArray(state.stages) || state.stages.length === 0) {
    return transitionFailure(
      "MIGRATION_REQUIRED",
      "runtime.activate",
      "workflow stages are missing from the persisted v2 state",
      state,
      { field: "stages" },
    );
  }
  const stages = state.stages;
  const stageId = typeof state.stage_cursor === "string" && state.stage_cursor.trim() ? state.stage_cursor : null;
  if (!stageId) {
    return transitionFailure(
      "MIGRATION_REQUIRED",
      "runtime.activate",
      "workflow stage cursor is missing from the persisted v2 state",
      state,
      { field: "stage_cursor" },
    );
  }
  const stage = profile.stages.find((candidate) => candidate.id === stageId);
  if (!stage) return transitionFailure("IDENTITY_MISMATCH", "runtime.activate", "workflow stage cursor is not present in the selected profile", state);
  const stageEntry = stages.find((entry) => entry.id === stage.id);
  if (!stageEntry) return transitionFailure("MIGRATION_REQUIRED", "runtime.activate", "workflow stage cursor is not present in persisted stages", state, { field: "stages" });
  const workIdentityScope = isWorkIdentity(state.work_identity)
    ? workIdentityScopeForStage(state, stage.id)
    : context.work_identity_scope;
  if (
    !isWorkIdentityScope(workIdentityScope)
    || workIdentityScope.run_id !== identity.run_identity.run_id
    || workIdentityScope.session_id !== identity.run_identity.session.session_id
    || workIdentityScope.workflow !== workflow
    || workIdentityScope.stage_id !== stage.id
    || workIdentityScope.stage_cursor !== stage.id
  ) {
    return transitionFailure(
      "IDENTITY_MISMATCH",
      "runtime.activate",
      "capability creation requires a caller-bound work identity for the selected stage",
      state,
      { field: "work_identity_scope" },
    );
  }
  const existing = activeCapability(state.dispatch_capability);
  const runKey = typeof state.run_key === "string" && state.run_key.trim() ? state.run_key : null;
  if (!runKey) {
    return transitionFailure(
      "MIGRATION_REQUIRED",
      "runtime.activate",
      "workflow state must carry a canonical run key before dispatch",
      state,
      { field: "run_key" },
    );
  }
  const capabilityEpoch = existing?.issued_for.stage_cursor === stage.id
    ? existing.issued_for.cursor_epoch
    : typeof state.cursor_epoch === "string" && state.cursor_epoch.trim() ? state.cursor_epoch : null;
  if (!capabilityEpoch) {
    return transitionFailure(
      "MIGRATION_REQUIRED",
      "runtime.activate",
      "workflow state must carry a canonical cursor epoch before dispatch",
      state,
      { field: "cursor_epoch" },
    );
  }
  const existingDispatches = existing?.issued_for.stage_cursor === stage.id ? existing.dispatches : [];
  const flags = state.scope;
  if (!flags) return transitionFailure("MIGRATION_REQUIRED", "runtime.activate", "workflow scope must be bound before dispatch", state, { field: "scope" });
  const kind: "none" | "single" | "consilium" =
    stage.type === "single" ? "single" : stage.type === "consilium" ? "consilium" : "none";
  const reuseSelection = stage.roster_policy
    ? state.roster_selection?.stage_id === stage.id
      ? state.roster_selection
      : state.roster_selections?.[stage.id]
    : undefined;
  let rosterSelection = reuseSelection;
  let slots: DispatchSlot[] = [];
  let expectedRoster: Array<{ role: string; agent: string; agent_ref: AgentRef; slot_id?: string; semantic_role?: string; occurrence?: number; facet?: string | null }> = [];
  if (kind === "none") {
    slots = [];
  } else if (stage.roster_policy) {
    const selection: RosterSelectionResult = reuseSelection && reuseSelection.capability_epoch === capabilityEpoch
      ? {
          ok: true,
          selection: reuseSelection,
          slots: reuseSelection.selected.map((entry) => ({ slot: entry.slot_id, slot_id: entry.slot_id, role: entry.role, occurrence: entry.occurrence, facet: entry.facet })),
          expected_roster: reuseSelection.selected.map((entry) => ({ role: entry.slot_id, agent: entry.agent })),
        }
      : selectRoster(stage, {
          cwd,
          flags,
          project_identity: context.project_identity,
          run_identity: context.run_identity,
          catalog: context.catalog,
          effectivePolicy: context.effective_policy,
          agentInventory: context.agent_inventory,
          resolveDevAgent: () => flags.dev_agent,
          state,
          profile_hash: profile_identity.fingerprint,
          run_key: runKey,
          workflow,
          capability_epoch: capabilityEpoch,
          resolveAgent: (role) => qualifiedAgentForRole(role, context)?.registered_name ?? "",
        } satisfies RosterSelectionContext);
    if (selection.ok === false) return { ok: false, error: `workflow stage '${stage.id}' roster selection failed: ${selection.error}`, state };
    if (!selection.selection) return { ok: false, error: `workflow stage '${stage.id}' roster selection is missing`, state };
    rosterSelection = selection.selection;
    slots = selection.slots;
    const qualifiedRoster: Array<{ role: string; agent: string; agent_ref: AgentRef }> = [];
    for (const entry of selection.expected_roster) {
      const slot = slots.find((candidate) => candidate.slot === entry.role);
      const agent_ref = qualifiedAgentForRole(slot?.role ?? entry.role, context);
      if (!agent_ref) {
        return { ok: false, error: `workflow stage '${stage.id}' roster contains an unqualified agent`, state };
      }
      qualifiedRoster.push({ ...entry, agent: agent_ref.registered_name, agent_ref });
    }
    expectedRoster = qualifiedRoster;
  } else {
    try {
      slots = resolveStageDispatchSlots(stage, {
        cwd,
        flags,
        project_identity: context.project_identity,
        run_identity: context.run_identity,
        catalog: context.catalog,
        resolveDevAgent: () => flags.dev_agent,
        effectivePolicy: context.effective_policy,
        agentInventory: context.agent_inventory,
        state,
      });
      expectedRoster = rosterWithQualifiedAgents(slots, context) ?? [];
    } catch (error) {
      return { ok: false, error: `workflow stage '${stage.id}' dispatch roster unresolved: ${String(error)}`, state };
    }
  }
  if ((kind === "single" && slots.length !== 1) || (kind === "consilium" && slots.length === 0)) {
    return { ok: false, error: `workflow stage '${stage.id}' has an invalid dispatch roster`, state };
  }
  if (kind !== "none" && expectedRoster.length !== slots.length) {
    return { ok: false, error: `workflow stage '${stage.id}' has no complete qualified agent roster`, state };
  }

  if (
    existing
    && existing.issued_for.stage_cursor === stage.id
    && stageEntry.status === "in_progress"
    && existing.status !== "complete"
    && existing.status !== "invalidated"
  ) {
    const rosterChanged = JSON.stringify(existing.expected_roster) !== JSON.stringify(expectedRoster);
    if (existingDispatches.length > 0 && rosterChanged) return { ok: false, error: "active dispatch capability roster is inconsistent", state };
    if (!rosterChanged) {
      const identityFields = [
        "run_id", "wave_id", "slice_id", "session_id", "workflow", "stage_id", "stage_cursor", "capability_id", "capability_epoch",
      ] as const;
      if (!isWorkIdentity(state.work_identity) || !isWorkIdentity(existing.work_identity)
        || identityFields.some((field) =>
          state.work_identity?.[field] !== existing.work_identity?.[field])) {
        return transitionFailure("IDENTITY_MISMATCH", "runtime.activate", "active capability work identity is missing or mismatched", state);
      }
      const reissued = reissueActiveCapability(existing);
      const pendingActive = reissued.state.dispatches.some((record) => record.status === "pending" || record.status === "running");
      const resumedCapability: DispatchCapabilityState = {
        ...reissued.state,
        roster_selection: rosterSelection ?? reissued.state.roster_selection,
      };
      const next: TeamState = {
        ...state,
        project_identity: identity.project_identity,
        run_identity: identity.run_identity,
        run_key: runKey,
        profile_hash: profile_identity.fingerprint,
        cursor_epoch: reissued.state.issued_for.cursor_epoch,
        stage_cursor: stage.id,
        scope: flags,
        policy: { ...(state.policy ?? {}), strict_orchestrator: true },
        stages: stages.map((entry) => entry.id === stage.id ? stageWithStatus(entry, "in_progress") : entry),
        ...(rosterSelection ? { roster_selection: rosterSelection, roster_selections: { ...(state.roster_selections ?? {}), [stage.id]: rosterSelection } } : {}),
        dispatch_capability: resumedCapability,
        pause: pendingActive ? { kind: "background_wait", reason: "provider work remains pending" } : { kind: "none", reason: "" },
        updated_at: now(),
      };
      persist(cwd, next, target);
      return { ok: true, state: next, handoff: handoffFromState(next, { capability_id: reissued.capability_id, dispatch_token: reissued.dispatch_token, advance_token: reissued.advance_token }, stage) };
    }
  }
  const resetState = stageEntry.status === "in_progress" ? state : resetReopenedStageState(state, target, profile, stage.id, existing);
  const retainedDispatches = stageEntry.status === "in_progress" ? existingDispatches : [];
  const issued = createCapability({
    run_key: runKey,
    branch: resetState.branch,
    workflow,
    profile_hash: profile_identity.fingerprint,
    stage_cursor: stage.id,
    kind,
    expected_roster: expectedRoster,
    roster_selection: rosterSelection,
    work_identity_scope: workIdentityScope,
    project_identity: identity.project_identity,
    run_identity: identity.run_identity,
  });
  const armedCapability: DispatchCapabilityState = {
    ...issued.state,
    status: retainedDispatches.length > 0 ? "dispatched" : "ready",
    dispatches: retainedDispatches,
  };
  const next: TeamState = {
    ...resetState,
    project_identity: identity.project_identity,
    run_identity: identity.run_identity,
    run_key: runKey,
    profile_hash: profile_identity.fingerprint,
    cursor_epoch: issued.state.issued_for.cursor_epoch,
    stage_cursor: stage.id,
    scope: flags,
    policy: { ...(resetState.policy ?? {}), strict_orchestrator: true },
    work_identity: issued.work_identity,
    ...(rosterSelection ? { roster_selection: rosterSelection, roster_selections: { ...(resetState.roster_selections ?? {}), [stage.id]: rosterSelection } } : {}),
    dispatch_capability: armedCapability,
    pause: { kind: "none", reason: "" },
    updated_at: now(),
  };
  persist(cwd, next, target);
  return {
    ok: true,
    state: next,
    handoff: handoffFromState(next, { capability_id: issued.capability_id, dispatch_token: issued.dispatch_token, advance_token: issued.advance_token }, stage),
  };
}
function auth(cap: ActiveCapability, a: DispatchAuth, secretHash: string): string | null {
  if (!a.capability_id || a.capability_id !== cap.capability_id) return "capability identity mismatch";
  if (!identityMatches(cap.project_identity, cap.run_identity, a.project_identity, a.run_identity)) return "workflow run identity mismatch";
  if (!a.token || hash(a.token) !== secretHash) return "invalid secret";
  const b = cap.issued_for;
  if (a.run_key !== b.run_key || a.branch !== b.branch || a.workflow !== b.workflow || a.profile_hash !== b.profile_hash || a.stage_cursor !== b.stage_cursor || a.cursor_epoch !== b.cursor_epoch) return "capability binding mismatch";
  if (a.agent_ref !== undefined && a.agent_ref.provider_id !== cap.project_identity.provider_id) return "qualified agent provider mismatch";
  return null;
}

function authFailure(error: string, state: TeamState): TransitionResult {
  const identityError = error === "workflow run identity mismatch" || error === "capability identity mismatch" || error === "capability binding mismatch";
  return transitionFailure(
    identityError ? "IDENTITY_MISMATCH" : "ACTIVATION_FAILED",
    "runtime.activate",
    error,
    state,
    { boundary: "dispatch authorization" },
  );
}

function expectedTaskId(cap: ActiveCapability, role: string): string {
  return dispatchTaskId(cap.capability_id, cap.issued_for.run_key, cap.issued_for.branch, cap.issued_for.workflow, cap.issued_for.stage_cursor, role);
}

function authorizeBoundRecord(
  cwd: string,
  state: TeamState,
  target: ResolvedState,
  cap: ActiveCapability,
  input: DispatchAuth,
): TransitionResult {
  if (cap.status === "invalidated" || cap.status === "complete") return { ok: false, error: "capability invalidated", state };
  const role = input.slot_id ?? input.role ?? "";
  const rosterEntry = cap.expected_roster.find((entry) => entry.role === role);
  if (!rosterEntry) return { ok: false, error: "role/slot not expected", state };
  if (
    !input.agent_ref
    || input.agent_ref.provider_id !== cap.project_identity.provider_id
    || input.agent_ref.registered_name !== rosterEntry.agent
    || input.agent_ref.provider_id !== rosterEntry.agent_ref?.provider_id
    || input.agent_ref.source_fingerprint !== rosterEntry.agent_ref?.source_fingerprint
  ) return { ok: false, error: "qualified agent identity mismatch", state };
  if (input.role !== undefined && input.role !== role) return { ok: false, error: "slot identity mismatch", state };
  if (input.expected_count !== undefined && input.expected_count !== cap.expected_count) return { ok: false, error: "cardinality mismatch", state };
  const taskId = expectedTaskId(cap, role);
  if (input.task_id !== undefined && input.task_id !== taskId) return { ok: false, error: "task identity mismatch", state };
  const recordsForRole = cap.dispatches.filter((record) => record.role === role);
  const latest = recordsForRole[recordsForRole.length - 1];
  if (latest && latest.status !== "failed" && latest.status !== "cancelled") {
    const sameTool = Boolean(input.tool_call_id && latest.tool_call_id === input.tool_call_id);
    const sameTask = Boolean(input.task_id && latest.work_identity?.task_id === input.task_id);
    if (sameTask && !latest.tool_call_id && input.tool_call_id) {
      const rebound: DispatchRecord = { ...latest, tool_call_id: input.tool_call_id };
      const reboundCapability: DispatchCapabilityState = {
        ...cap,
        dispatches: cap.dispatches.map((candidate) => candidate.id === latest.id ? rebound : candidate),
      };
      const reboundState: TeamState = {
        ...state,
        dispatch_capability: reboundCapability,
        updated_at: now(),
      };
      persist(cwd, reboundState, target);
      return { ok: true, state: reboundState, record: rebound };
    }
    if ((sameTool || sameTask) && (!input.task_id || latest.work_identity?.task_id === input.task_id)) return { ok: true, state, record: latest };
  }
  if (latest && (!input.retry_of || input.retry_of !== latest.id || (latest.status !== "failed" && latest.status !== "cancelled"))) {
    return { ok: false, error: "retry requires an explicit terminal failure linkage", state };
  }
  const dispatchId = randomUUID();
  const attempt = latest ? latest.attempt + 1 : 1;
  const identity = workIdentityFor(state, cap, role, rosterEntry.agent, dispatchId, attempt, taskId);
  const pending = pendingFor(identity, cap.issued_for.run_identity, "authorized", undefined, undefined, latest?.id ?? null);
  const record: DispatchRecord = {
    id: dispatchId,
    role,
    agent: rosterEntry.agent,
    ...(rosterEntry.agent_ref !== undefined ? { agent_ref: rosterEntry.agent_ref } : {}),
    ...(input.tool_call_id !== undefined ? { tool_call_id: input.tool_call_id } : {}),
    status: "authorized",
    attempt,
    created_at: now(),
    run_identity: cap.issued_for.run_identity,
    work_identity: identity,
    pending,
    completion_envelope: completionEnvelopeFor(identity, cap.issued_for.run_identity, "pending", null, [], "authorized", "engine_task_caller"),
  };
  const authorizedCapability: DispatchCapabilityState = {
    ...cap,
    status: "dispatched",
    work_identity: identity,
    dispatches: [...cap.dispatches, record],
    pending: [...(cap.pending ?? []), pending],
  };
  const next: TeamState = {
    ...state,
    work_identity: identity,
    completion_envelope: completionEnvelopeFor(identity, cap.issued_for.run_identity, "pending", null, [], "authorized", "engine_task_caller"),
    dispatch_capability: authorizedCapability,
  };
  persist(cwd, next, target);
  return { ok: true, state: next, record };
}

/** Persist authorization before any native task is executed. */
export function authorizeDispatch(cwd: string, authInput: DispatchAuth): TransitionResult {
  const found = current(cwd, authInput.run_identity);
  if (!found) return transitionFailure("MIGRATION_REQUIRED", "runtime.activate", "dispatch state requires a bound project/run identity");
  const { state, target } = found;
  if (target.invalid) return transitionFailure("IDENTITY_MISMATCH", "runtime.activate", "dispatch state identity does not match the authorization run identity", state);
  if (target.isStale) return { ok: false, error: "workflow state is stale for the active branch", state };
  const cap = activeCapability(state.dispatch_capability);
  if (!cap) return transitionFailure("MIGRATION_REQUIRED", "runtime.activate", "dispatch capability is unavailable or not v2-bound", state);
  const error = auth(cap, authInput, cap.dispatch_token_hash);
  if (error) return authFailure(error, state);
  return authorizeBoundRecord(cwd, state, target, cap, authInput);
}

export interface TrustedDispatchInput {
  capability_id: string;
  run_key: string;
  branch: string;
  workflow: string;
  profile_hash: string;
  stage_cursor: string;
  cursor_epoch: string;
  project_identity: ProjectIdentity;
  run_identity: WorkflowRunIdentity;
  role: string;
  slot_id?: string;
  task_id?: string;
  agent: string;
  agent_ref: AgentRef;
  tool_call_id: string;
  expected_count?: number;
  retry_of?: string;
}
export function authorizeDispatchTrusted(cwd: string, input: TrustedDispatchInput): TransitionResult {
  const found = current(cwd, input.run_identity);
  if (!found) return transitionFailure("MIGRATION_REQUIRED", "tool.dispatch", "trusted dispatch requires a bound project/run state");
  const { state, target } = found;
  if (target.invalid) return transitionFailure("IDENTITY_MISMATCH", "tool.dispatch", "trusted dispatch identity does not match the persisted workflow state", state);
  if (resolveActiveBranch(cwd) !== state.branch) return { ok: false, error: "workflow state is stale for the active branch", state };
  const cap = activeCapability(state.dispatch_capability);
  if (!cap) return transitionFailure("MIGRATION_REQUIRED", "tool.dispatch", "dispatch capability is unavailable or not v2-bound", state);
  const binding = cap.issued_for;
  if (
    input.capability_id !== cap.capability_id
    || !identityMatches(cap.project_identity, cap.run_identity, input.project_identity, input.run_identity)
    || input.run_key !== binding.run_key
    || input.branch !== binding.branch
    || input.workflow !== binding.workflow
    || input.profile_hash !== binding.profile_hash
    || input.stage_cursor !== binding.stage_cursor
    || input.cursor_epoch !== binding.cursor_epoch
  ) return transitionFailure("IDENTITY_MISMATCH", "tool.dispatch", "trusted dispatch capability binding does not match the persisted capability", state);
  if (!input.tool_call_id) return { ok: false, error: "tool call identity required", state };
  return authorizeBoundRecord(cwd, state, target, cap, {
    token: "__trusted_gate__",
    capability_id: input.capability_id,
    run_key: input.run_key,
    branch: input.branch,
    workflow: input.workflow,
    profile_hash: input.profile_hash,
    stage_cursor: input.stage_cursor,
    cursor_epoch: input.cursor_epoch,
    project_identity: input.project_identity,
    run_identity: input.run_identity,
    role: input.role,
    slot_id: input.slot_id,
    task_id: input.task_id,
    agent: input.agent,
    agent_ref: input.agent_ref,
    tool_call_id: input.tool_call_id,
    expected_count: input.expected_count,
    retry_of: input.retry_of,
  });
}

type CompletionInput = {
  outcome: DispatchCompletion["outcome"];
  evidence: string;
  artifact_ids?: string[];
  completed_by?: DispatchCompletion["completed_by"];
  terminal_signal?: CompletionEnvelope["terminal_signal"];
};

function pendingRecord(
  cwd: string,
  state: TeamState,
  target: ResolvedState,
  cap: ActiveCapability,
  record: DispatchRecord,
  reason: PendingState["pending_reason"] = "provider_running",
  providerRef?: string,
): TransitionResult {
  if (record.status === "succeeded" || record.status === "failed" || record.status === "cancelled") return { ok: false, error: "terminal dispatch cannot become pending", state };
  const identity = record.work_identity;
  if (!identity) {
    return transitionFailure(
      "MIGRATION_REQUIRED",
      "runtime.activate",
      "pending dispatch requires the persisted work identity",
      state,
      { field: "work_identity" },
    );
  }
  const previous = record.pending;
  if (previous?.status === "pending" && previous.provider_ref === providerRef && previous.pending_reason === reason) return { ok: true, state, record };
  if (previous?.status === "pending" && previous.provider_ref !== providerRef) return { ok: false, error: "conflicting pending replay", state };
  const pending = pendingFor(identity, cap.issued_for.run_identity, "pending", reason, providerRef, previous?.retry_of ?? null);
  const envelope = completionEnvelopeFor(identity, cap.issued_for.run_identity, "pending", null, [], providerRef ?? reason, "engine_task_caller");
  const updated: DispatchRecord = {
    ...record,
    status: "pending",
    run_identity: cap.issued_for.run_identity,
    work_identity: identity,
    pending,
    completion_envelope: envelope,
  };
  const nextCapability: DispatchCapabilityState = {
    ...cap,
    status: "dispatched",
    dispatches: cap.dispatches.map((candidate) => candidate.id === record.id ? updated : candidate),
    pending: [...(cap.pending ?? []).filter((candidate) => candidate.identity.dispatch_id !== record.id), pending],
  };
  const next: TeamState = {
    ...state,
    work_identity: identity,
    pending,
    completion_envelope: envelope,
    dispatch_capability: nextCapability,
    pause: { kind: "background_wait", reason: providerRef ? `provider work pending (${providerRef})` : "provider work remains pending" },
    updated_at: now(),
  };
  persist(cwd, next, target);
  return { ok: true, state: next, record: updated };
}

/** Persist a neutral provider-running state before returning to the caller. */
export function persistPendingDispatch(
  cwd: string,
  input: DispatchAuth & { dispatch_id: string; pending_reason?: PendingState["pending_reason"]; provider_ref?: string },
): TransitionResult {
  const found = current(cwd, input.run_identity);
  if (!found) return transitionFailure("MIGRATION_REQUIRED", "runtime.activate", "pending dispatch requires a bound project/run state");
  const { state, target } = found;
  if (target.invalid) return transitionFailure("IDENTITY_MISMATCH", "runtime.activate", "pending dispatch identity does not match the persisted workflow state", state);
  if (target.isStale) return { ok: false, error: "workflow state is stale for the active branch", state };
  const cap = activeCapability(state.dispatch_capability);
  if (!cap) return transitionFailure("MIGRATION_REQUIRED", "runtime.activate", "dispatch capability is unavailable or not v2-bound", state);
  const error = auth(cap, input, cap.dispatch_token_hash);
  if (error) return authFailure(error, state);
  const record = cap.dispatches.find((candidate) => candidate.id === input.dispatch_id);
  if (!record) return { ok: false, error: "unknown dispatch", state };
  if (input.role !== undefined && input.role !== record.role) return { ok: false, error: "dispatch slot mismatch", state };
  return pendingRecord(cwd, state, target, cap, record, input.pending_reason, input.provider_ref);
}


function withoutTopLevelPendingCompletion(state: TeamState): TeamState {
  const next = { ...state };
  delete next.pending;
  delete next.completion_envelope;
  return next;
}

function normalizeTopLevelCompletionState(
  state: TeamState,
  capability: DispatchCapabilityState,
  completedIdentity: WorkIdentity,
  completedEnvelope: CompletionEnvelope | undefined,
): TeamState {
  const normalized = withoutTopLevelPendingCompletion(state);
  const active = capability.dispatches.find((candidate) =>
    (candidate.status === "pending" || candidate.status === "running") && candidate.pending !== undefined);
  if (active?.pending) {
    return {
      ...normalized,
      work_identity: active.work_identity,
      pending: active.pending,
    };
  }
  return {
    ...normalized,
    work_identity: completedIdentity,
    ...(completedEnvelope ? { completion_envelope: completedEnvelope } : {}),
  };
}

function completeRecord(
  cwd: string,
  state: TeamState,
  target: ResolvedState,
  cap: ActiveCapability,
  record: DispatchRecord,
  input: CompletionInput,
): TransitionResult {
  if (cap.status === "invalidated" || cap.status === "complete") return { ok: false, error: "capability invalidated", state };
  if (!input.evidence.trim()) return { ok: false, error: "completion evidence required", state };
  const identity = record.work_identity;
  if (!identity) {
    return transitionFailure(
      "MIGRATION_REQUIRED",
      "runtime.activate",
      "completion requires the persisted work identity",
      state,
      { field: "work_identity" },
    );
  }
  const artifact_ids = input.artifact_ids ?? [];
  const artifactDir = target.artifactsDir ?? "";
  const declaredArtifacts = state.artifacts ?? {};
  const unsafeArtifacts = new Set(artifact_ids).size !== artifact_ids.length || artifact_ids.some((id) => !isSafeStateSegment(id));
  const previousCompletion = record.completion;
  const sameOutcome = previousCompletion?.outcome === input.outcome;
  const sameArtifacts = previousCompletion !== undefined && JSON.stringify(previousCompletion.artifact_ids) === JSON.stringify(artifact_ids);
  const deferredNativeArtifacts = previousCompletion?.completed_by === "synchronous_tool_result"
    && sameOutcome
    && previousCompletion.artifact_ids.length === 0
    && artifact_ids.length > 0;
  const missingArtifacts = artifact_ids.some((id) => !existsSync(join(artifactDir, `${id}.json`)) && !Object.prototype.hasOwnProperty.call(declaredArtifacts, id));
  if (unsafeArtifacts || (missingArtifacts && !deferredNativeArtifacts)) return { ok: false, error: "declared artifact missing or unsafe", state };
  if (previousCompletion && !(sameOutcome && sameArtifacts) && !deferredNativeArtifacts) return { ok: false, error: "conflicting replay", state };
  const completedBy = input.completed_by ?? "workflow_complete";
  const terminalSignal = input.terminal_signal ?? (completedBy === "synchronous_tool_result" ? "native_tool_result" : "workflow_complete");
  const snapshotted = snapshotSlotArtifacts(state, cap, record, artifact_ids, artifactDir);
  if (snapshotted.ok === false) {
    if (snapshotted.retryable && previousCompletion) {
      const deferredCompletion: DispatchCompletion = {
        ...previousCompletion,
        artifact_ids,
        evidence: input.evidence,
        work_identity: identity,
      };
      const deferredEnvelope = completionEnvelopeFor(identity, cap.issued_for.run_identity, input.outcome, "native_tool_result", completionArtifactRefs(artifactDir, artifact_ids), input.evidence, "synchronous_tool_result");
      const deferredRecord: DispatchRecord = { ...record, run_identity: cap.issued_for.run_identity, work_identity: identity, completion: deferredCompletion, completion_envelope: deferredEnvelope };
      const deferredCapability: DispatchCapabilityState = {
        ...cap,
        work_identity: identity,
        dispatches: cap.dispatches.map((candidate) => candidate.id === record.id ? deferredRecord : candidate),
      };
      const deferredState: TeamState = {
        ...normalizeTopLevelCompletionState(state, deferredCapability, identity, deferredEnvelope),
        dispatch_capability: deferredCapability,
        updated_at: now(),
      };
      persist(cwd, deferredState, target);
      return { ok: true, state: deferredState, record: deferredRecord };
    }
    return { ok: false, error: snapshotted.error, state };
  }
  if (previousCompletion && sameOutcome && sameArtifacts) {
    const replayedRecord: DispatchRecord = { ...record, work_identity: identity };
    const replayedCapability: DispatchCapabilityState = {
      ...cap,
      work_identity: identity,
      dispatches: cap.dispatches.map((candidate) => candidate.id === record.id ? replayedRecord : candidate),
    };
    const replayedState: TeamState = {
      ...normalizeTopLevelCompletionState(snapshotted.state, replayedCapability, identity, record.completion_envelope),
      dispatch_capability: replayedCapability,
      updated_at: now(),
    };
    persist(cwd, replayedState, target);
    return { ok: true, state: replayedState, record: replayedRecord };
  }
  const completedAt = now();
  const completion: DispatchCompletion = {
    dispatch_id: record.id,
    cursor_epoch: cap.issued_for.cursor_epoch,
    outcome: input.outcome,
    artifact_ids,
    evidence: input.evidence,
    completed_by: completedBy,
    run_identity: cap.issued_for.run_identity,
    completed_at: completedAt,
    work_identity: identity,
  };
  const envelope = completionEnvelopeFor(identity, cap.issued_for.run_identity, input.outcome, terminalSignal, completionArtifactRefs(artifactDir, artifact_ids), input.evidence, completedBy);
  const terminalPending = pendingFor(identity, cap.issued_for.run_identity, input.outcome, undefined, undefined, record.pending?.retry_of ?? null);
  const updated: DispatchRecord = {
    ...record,
    status: input.outcome,
    completed_at: completedAt,
    run_identity: cap.issued_for.run_identity,
    pending: terminalPending,
    completion,
    completion_envelope: envelope,
  };
  const nextCapabilityRaw: DispatchCapabilityState = {
    ...cap,
    work_identity: identity,
    dispatches: cap.dispatches.map((candidate) => candidate.id === record.id ? updated : candidate),
    pending: [...(cap.pending ?? []).filter((candidate) => candidate.identity.dispatch_id !== record.id), terminalPending],
  };
  const activePendingRecord = nextCapabilityRaw.dispatches.find((candidate) =>
    (candidate.status === "pending" || candidate.status === "running") && candidate.pending !== undefined);
  const nextCapability: DispatchCapabilityState = {
    ...nextCapabilityRaw,
    work_identity: activePendingRecord?.work_identity ?? identity,
  };
  const activePending = nextCapability.dispatches.some((candidate) => candidate.status === "pending" || candidate.status === "running");
  const next: TeamState = {
    ...normalizeTopLevelCompletionState(snapshotted.state, nextCapability, identity, envelope),
    dispatch_capability: nextCapability,
    pause: activePending ? { kind: "background_wait", reason: "provider work remains pending" } : { kind: "none", reason: "" },
    updated_at: now(),
  };
  persist(cwd, next, target);
  return { ok: true, state: next, record: updated };
}

/**
 * For multi-slot consilium stages, capture each slot's artifact content into
 * a namespaced snapshot (`<id>-<slot>.json`) at completion time, before a
 * later slot can overwrite the shared file. Recording the same artifact for
 * the same slot twice with different content is a collision and fails
 * closed. The namespaced snapshots are the provenance source for the
 * deterministic synthesis performed at advance.
 */
function snapshotSlotArtifacts(
  state: TeamState,
  cap: ActiveCapability,
  record: DispatchRecord,
  artifactIds: string[],
  artifactsDir: string,
): { ok: true; state: TeamState } | { ok: false; error: string; retryable?: boolean } {
  if (cap.kind !== "consilium" || cap.expected_count <= 1 || artifactIds.length === 0) {
    return { ok: true, state };
  }
  const stageId = cap.issued_for.stage_cursor;
  const existing = state.slot_artifacts?.[stageId] ?? { slots: {} };
  const slots = { ...existing.slots };
  const slotMap = { ...(slots[record.role] ?? {}) };
  const values: Array<{ id: string; value: unknown }> = [];
  for (const id of artifactIds) {
    const value = readArtifact(artifactsDir, id);
    if (value === null) {
      return {
        ok: false,
        retryable: true,
        error: `slot '${record.role}' artifact '${id}' is not readable yet; retry completion or workflow_advance`,
      };
    }
    values.push({ id, value });
  }
  for (const { id, value } of values) {
    const hash = hashValue(value);
    const previous = slotMap[id];
    if (previous && previous.hash !== hash) {
      return { ok: false, error: `slot artifact conflict: slot '${record.role}' wrote '${id}' with different content` };
    }
    // Already slot-scoped ids are the slot's own provenance; only copy the
    // shared-id writes into the namespace before a later slot can clobber.
    const namespaced = isNamespacedArtifactId(id, record.role) ? id : namespacedArtifactId(id, record.role);
    if (namespaced !== id) {
      writeArtifact(artifactsDir, namespaced, value);
    }
    slotMap[id] = { path: join(artifactsDir, `${namespaced}.json`), hash };
  }
  slots[record.role] = slotMap;
  return { ok: true, state: { ...state, slot_artifacts: { ...(state.slot_artifacts ?? {}), [stageId]: { ...existing, slots } } } };
}

function hashValue(value: unknown): string {
  return hash(JSON.stringify(value));
}
export function completeDispatch(cwd: string, input: DispatchAuth & { dispatch_id: string } & Partial<CompletionInput>): TransitionResult {
  const found = current(cwd, input.run_identity);
  if (!found) return transitionFailure("MIGRATION_REQUIRED", "runtime.activate", "completion requires a bound project/run state");
  const { state, target } = found;
  if (target.invalid) return transitionFailure("IDENTITY_MISMATCH", "runtime.activate", "completion identity does not match the persisted workflow state", state);
  if (target.isStale) return { ok: false, error: "workflow state is stale for the active branch", state };
  const cap = activeCapability(state.dispatch_capability);
  if (!cap) return transitionFailure("MIGRATION_REQUIRED", "runtime.activate", "dispatch capability is unavailable or not v2-bound", state);
  const error = auth(cap, input, cap.dispatch_token_hash);
  if (error) return authFailure(error, state);
  const record = cap.dispatches.find((d) => d.id === input.dispatch_id);
  if (!record) return { ok: false, error: "unknown dispatch", state };
  if (input.role !== undefined && input.role !== record.role) return { ok: false, error: "dispatch role mismatch", state };
  if (input.slot_id !== undefined && input.slot_id !== record.work_identity?.slot_id && input.slot_id !== record.role) return { ok: false, error: "dispatch slot mismatch", state };
  if (input.task_id !== undefined && input.task_id !== record.work_identity?.task_id) return { ok: false, error: "dispatch task mismatch", state };
  if (input.agent !== undefined && input.agent !== record.agent) return { ok: false, error: "dispatch agent mismatch", state };
  if (input.tool_call_id !== undefined && record.tool_call_id !== undefined && input.tool_call_id !== record.tool_call_id) return { ok: false, error: "dispatch tool-call mismatch", state };
  if (input.pending === true) return pendingRecord(cwd, state, target, cap, record, input.pending_reason, input.provider_ref);
  const outcome = input.outcome;
  const evidence = input.evidence;
  if (!outcome || !evidence) return { ok: false, error: "terminal completion outcome and evidence are required", state };
  const completionInput: CompletionInput = {
    outcome,
    evidence,
    ...(input.artifact_ids !== undefined ? { artifact_ids: input.artifact_ids } : {}),
    ...(input.completed_by !== undefined ? { completed_by: input.completed_by } : {}),
    ...(input.terminal_signal !== undefined ? { terminal_signal: input.terminal_signal } : {}),
  };
  return completeRecord(cwd, state, target, cap, record, completionInput);
}

/** Reconcile a native task result without exposing capability secrets to hooks. */
export function reconcileTrustedTaskResult(cwd: string, input: {
  project_identity: ProjectIdentity;
  run_identity: WorkflowRunIdentity;
  tool_call_id?: string;
  capability_id?: string;
  cursor_epoch?: string;
  dispatch_id?: string;
  role?: string;
  slot_id?: string;
  task_id?: string;
  work_identity?: WorkIdentity;
  outcome: DispatchCompletion["outcome"];
  evidence: string;
  artifact_ids?: string[];
  pending?: boolean;
  pending_reason?: PendingState["pending_reason"];
  provider_ref?: string;
  terminal_signal?: CompletionEnvelope["terminal_signal"];
}): TransitionResult {
  if (!input.tool_call_id && !input.dispatch_id && !input.work_identity) return { ok: false, error: "dispatch identity required" };
  const found = current(cwd, input.run_identity);
  if (!found) return transitionFailure("MIGRATION_REQUIRED", "runtime.activate", "trusted result requires a bound workflow state");
  if (found.target.invalid) return transitionFailure("IDENTITY_MISMATCH", "runtime.activate", "trusted result identity does not match the persisted workflow state", found.state);
  if (resolveActiveBranch(cwd) !== found.state.branch) return { ok: false, error: "workflow state is stale for the active branch", state: found.state };
  if (!found.state.project_identity || !found.state.run_identity || !identityMatches(found.state.project_identity, found.state.run_identity, input.project_identity, input.run_identity)) {
    return transitionFailure("IDENTITY_MISMATCH", "runtime.activate", "trusted result lacks the active project/run identity", found.state);
  }
  const cap = activeCapability(found.state.dispatch_capability);
  if (!cap) return transitionFailure("MIGRATION_REQUIRED", "runtime.activate", "dispatch capability is unavailable or not v2-bound", found.state);
  if (!identityMatches(cap.project_identity, cap.run_identity, input.project_identity, input.run_identity)) return transitionFailure("IDENTITY_MISMATCH", "runtime.activate", "trusted result run identity mismatches the active capability", found.state);
  if (input.capability_id && input.capability_id !== cap.capability_id) return transitionFailure("IDENTITY_MISMATCH", "runtime.activate", "trusted result capability id mismatches the active capability", found.state);
  if (input.cursor_epoch && input.cursor_epoch !== cap.issued_for.cursor_epoch) return transitionFailure("IDENTITY_MISMATCH", "runtime.activate", "trusted result cursor epoch mismatches the active capability", found.state);
  const candidates = cap.dispatches.filter((record) => {
    if (input.dispatch_id && record.id !== input.dispatch_id) return false;
    if (input.tool_call_id && record.tool_call_id !== input.tool_call_id) return false;
    if (input.slot_id && input.slot_id !== record.role && input.slot_id !== record.work_identity?.slot_id) return false;
    if (input.task_id && input.task_id !== record.work_identity?.task_id) return false;
    if (input.work_identity && JSON.stringify(record.work_identity) !== JSON.stringify(input.work_identity)) return false;
    return !record.completion;
  });
  if (candidates.length !== 1) return { ok: false, error: candidates.length === 0 ? "unknown or already reconciled dispatch" : "ambiguous positional result", state: found.state };
  const record = candidates[0];
  if (!record) return { ok: false, error: "dispatch result identity disappeared", state: found.state };
  if (input.role && input.role !== record.role) return { ok: false, error: "dispatch role mismatch", state: found.state };
  if (input.pending) return pendingRecord(cwd, found.state, found.target, cap, record, input.pending_reason, input.provider_ref);
  return completeRecord(cwd, found.state, found.target, cap, record, {
    outcome: input.outcome,
    evidence: input.evidence,
    artifact_ids: input.artifact_ids,
    completed_by: "synchronous_tool_result",
    terminal_signal: input.terminal_signal ?? "native_tool_result",
  });
}
function stageProduces(stage: StageDef): string[] {
  if (Array.isArray(stage.produces)) return stage.produces;
  return stage.produces ? [stage.produces] : [];
}

/**
 * Native task results are reconciled before the orchestrator can inspect the
 * executor's output, so they intentionally carry no artifact ids. The
 * orchestrator may also bind those ids before a concurrent artifact write is
 * readable. Recover both forms deterministically at the advance boundary.
 * Shared ids are never inferred for a multi-slot consilium: a clobbered shared
 * file cannot prove which slot produced it.
 */
function recoverSynchronousArtifactIds(
  cwd: string,
  state: TeamState,
  target: ResolvedState,
  cap: ActiveCapability,
  stage: StageDef,
): { ok: true; state: TeamState } | { ok: false; error: string } {
  const artifactsDir = target.artifactsDir ?? "";
  const produces = stageProduces(stage);
  const multiSlot = cap.kind === "consilium" && cap.expected_count > 1;
  let recovered = state;
  for (const candidate of cap.dispatches) {
    const completion = candidate.completion;
    if (!completion || completion.completed_by !== "synchronous_tool_result" || completion.outcome !== "succeeded") continue;

    let artifactIds = completion.artifact_ids;
    if (artifactIds.length > 0) {
      // Explicit ids are already bound. Only re-enter completion to create
      // missing consilium snapshots; single-stage artifacts are validated
      // directly by the stage contract below.
      if (!multiSlot) continue;
      const slotMap = recovered.slot_artifacts?.[stage.id]?.slots?.[candidate.role] ?? {};
      const needsSnapshot = artifactIds.some((id) => !slotMap[id]);
      if (!needsSnapshot || !artifactIds.every((id) => readArtifact(artifactsDir, id) !== null)) continue;
    } else {
      artifactIds = multiSlot
        ? produces.map((id) => namespacedArtifactId(id, candidate.role)).filter((id) => readArtifact(artifactsDir, id) !== null)
        : produces.every((id) => readArtifact(artifactsDir, id) !== null) ? produces : [];
      if (artifactIds.length === 0) continue;
    }

    const currentCap = activeCapability(recovered.dispatch_capability);
    if (!currentCap) return { ok: false, error: "dispatch capability disappeared during artifact recovery" };
    const record = currentCap.dispatches.find((entry) => entry.id === candidate.id);
    if (!record) return { ok: false, error: "dispatch disappeared during artifact recovery" };
    const result = completeRecord(cwd, recovered, target, currentCap, record, {
      outcome: completion.outcome,
      evidence: `${completion.evidence}\nRecovered declared artifact ids at workflow advance.`,
      artifact_ids: artifactIds,
      completed_by: "synchronous_tool_result",
    });
    if (!result.ok) return { ok: false, error: result.error };
    recovered = result.state;
  }
  return { ok: true, state: recovered };
}

function objectArtifact(artifactsDir: string, id: string): Record<string, unknown> | null {
  const value = readArtifact(artifactsDir, id);
  if (!isRecord(value)) return null;
  return value;
}

function evaluateStageGate(stage: StageDef, state: TeamState, artifactsDir: string, flags: ScopeFlags): string | null {
  const gate = stage.gate?.trim();
  if (!gate) return null;
  const result = evaluatePredicate(gate, {
    flags,
    artifactsDir,
    state,
    stage,
    namedGate: (name) => {
      const named = NAMED_GATES[name];
      return named ? named(state, artifactsDir) : undefined;
    },
  });
  if (!result.ok) return result.error;
  return result.value ? null : `gate '${gate}' is not satisfied`;
}

/** Named gates are plain identifiers resolved by the predicate evaluator. */
const NAMED_GATES: Record<string, (state: TeamState, artifactsDir: string) => string | null> = {
  branch_created: (state) => (state.branch.trim() ? null : "branch_created gate requires a persisted branch"),
  root_cause_documented: (_state, artifactsDir) => {
    const result = isRootCauseDocumented(artifactsDir);
    return result.ok ? null : result.reason;
  },
  dod_complete: (_state, artifactsDir) => {
    const result = isDoDComplete(readDoD(artifactsDir));
    return result.ok ? null : `dod_complete gate is not satisfied (${result.pending.length} pending items)`;
  },
  plan_valid: (_state, artifactsDir) => {
    const plan = objectArtifact(artifactsDir, "team_plan");
    return plan && Array.isArray(plan.teams) && plan.teams.length > 0 ? null : "plan_valid gate requires a non-empty team_plan.teams array";
  },
  contract_complete: (_state, artifactsDir) => {
    const architecture = objectArtifact(artifactsDir, "architecture");
    return architecture && Array.isArray(architecture.options) && architecture.options.length > 0 && typeof architecture.chosen === "string" && architecture.chosen.trim() ? null : "contract_complete gate requires architecture options and a chosen option";
  },
  feature_spec_present: (_state, artifactsDir) => {
    const spec = objectArtifact(artifactsDir, "feature_spec");
    return spec && typeof spec.goal === "string" && spec.goal.trim() && Array.isArray(spec.acceptance_criteria) && spec.acceptance_criteria.length > 0 ? null : "feature_spec_present gate requires a goal and acceptance criteria";
  },
  tests_passed: (_state, artifactsDir) => {
    const tests = objectArtifact(artifactsDir, "qa_tests");
    return tests?.build_status === "pass" ? null : "tests_passed gate requires qa_tests.build_status=pass";
  },
  /**
   * Product approval gate. Requires a durable decision for the
   * (stage, checkpoint) pair ('product_approval', 'product_approval'):
   * recorded interactively, never autonomous, normalized to exactly one of
   * the four allowed product decisions. Attached to both the
   * `product_approval` stage (which records the decision) and the
   * `product_handoff` stage (which consumes the approval record), so the
   * decision lookup is keyed by the declaring stage id, not the gate host.
   */
  product_approval_recorded: (state) => {
    const PRODUCT_APPROVAL_STAGE = "product_approval";
    const PRODUCT_APPROVAL_CHECKPOINT = "product_approval";
    const PRODUCT_DECISIONS = ["proceed", "needs_more_validation", "defer", "reject"];
    const decision = findCheckpointDecision(state, PRODUCT_APPROVAL_STAGE, PRODUCT_APPROVAL_CHECKPOINT);
    if (!decision) {
      return "product_approval_recorded gate: no durable decision recorded for checkpoint 'product_approval' (stage 'product_approval'); the product owner must answer via workflow_checkpoint with checkpoint_kind=product_approval, authorization=human, and actor_provenance bound to the product-owner answer; decision exactly one of proceed | needs_more_validation | defer | reject — no inferred consent";
    }
    if (decision.mode !== "interactive") {
      return `product_approval_recorded gate: checkpoint 'product_approval' was not recorded with interactive human authorization (projection mode '${decision.mode}'); product approval requires actor provenance from the product owner — autonomous decisions are rejected`;
    }
    const normalized = decision.decision.trim().toLowerCase();
    if (!PRODUCT_DECISIONS.includes(normalized)) {
      return `product_approval_recorded gate: decision '${decision.decision}' is not one of the four allowed product approval decisions (proceed | needs_more_validation | defer | reject)`;
    }
    return null;
  },
};

type StageCompletionResult = { ok: true; notes: string[] } | { ok: false; error: string };

/**
 * Executable artifact contract policy for durable advance. Additive and
 * compatibility-first: the shipped default validates every schema-defined
 * artifact with no grandfathering; legacy artifacts can be grandfathered
 * explicitly via {@link setArtifactContractPolicy}.
 */
let artifactContractPolicy: ArtifactContractPolicy = DEFAULT_ARTIFACT_CONTRACT_POLICY;

/** Override the artifact contract policy (e.g. explicit legacy grandfathering). */
export function setArtifactContractPolicy(policy: ArtifactContractPolicy): void {
  artifactContractPolicy = policy;
}

/** Fan-in policy for multi-slot consilium synthesis. */
let fanInPolicy: FanInPolicy = DEFAULT_FAN_IN_POLICY;

/** Override the consilium fan-in policy. */
export function setFanInPolicy(policy: FanInPolicy): void {
  fanInPolicy = policy;
}

function validateStageCompletion(
  stage: StageDef,
  state: TeamState,
  target: ResolvedState,
  evidence: string,
  flags: ScopeFlags,
  profile: Profile,
): StageCompletionResult {
  if (!evidence.trim()) return { ok: false, error: "stage completion evidence required" };
  const artifactsDir = target.artifactsDir ?? "";
  for (const id of stageProduces(stage)) {
    if (!isSafeStateSegment(id)) return { ok: false, error: `unsafe stage artifact id '${id}'` };
    const value = readArtifact(artifactsDir, id);
    if (value === null) return { ok: false, error: `required stage artifact '${id}.json' is missing or invalid` };
    const validated = validateProducedArtifact(id, value, artifactContractPolicy);
    if (!validated.ok) {
      return {
        ok: false,
        error: `produced artifact '${id}' violates its contract: ${validated.issues.map((issue) => `${issue.field}: ${issue.message}`).join("; ")}`,
      };
    }
  }
  const consumed = validateConsumedArtifacts(stage, artifactsDir, state, profile, artifactContractPolicy);
  if (!consumed.ok) return { ok: false, error: consumed.error };
  const validation = validationGate({ cwd: target.stateDir ?? "", stageId: stage.id, artifactsDir, produces: stage.produces });
  if (!validation.ok) return { ok: false, error: validation.reason };
  const gateError = evaluateStageGate(stage, state, artifactsDir, flags);
  if (gateError) return { ok: false, error: gateError };
  const notes = consumed.diagnostics
    .filter((diagnostic) => diagnostic.missing && diagnostic.issues.length === 0)
    .map((diagnostic) => `consumed artifact '${diagnostic.id}' is absent (producer ${diagnostic.producer_status ?? "unknown"})`);
  return { ok: true, notes };
}

/**
 * Executable `document` stage render at the durable advance boundary: the
 * engine — not an agent — renders the declared document from the stage's
 * declared sources and persists the document plus the typed artifact.
 * Fail-closed: a missing source, an unsupported contract or an unsafe
 * path blocks the transition before anything is marked done.
 */
function renderStageDocument(stage: StageDef, target: ResolvedState): { ok: true } | { ok: false; error: string } {
  const contract = stage.document;
  if (!contract) return { ok: false, error: `document stage '${stage.id}' is missing its document declaration` };
  if (contract.format !== "markdown" || contract.renderer !== "product-prd") {
    return { ok: false, error: `document stage '${stage.id}' declares an unsupported document contract (format '${contract.format}', renderer '${contract.renderer}')` };
  }
  const artifactsDir = target.artifactsDir;
  if (!artifactsDir) return { ok: false, error: `document stage '${stage.id}': artifacts dir unavailable` };
  const sourceArtifacts: Record<string, unknown> = {};
  for (const id of PRD_SOURCE_ARTIFACT_IDS) {
    const artifact = readArtifact(artifactsDir, id);
    if (artifact === null) return { ok: false, error: `document stage '${stage.id}': source artifact '${id}.json' not found` };
    sourceArtifacts[id] = artifact;
  }
  const written = writeProductPrdDocument({
    stateDir: dirname(artifactsDir),
    artifactsDir,
    path: contract.path,
    sourceArtifacts,
  });
  if (!written.ok) return { ok: false, error: `document stage '${stage.id}' render failed: ${written.error}` };
  return { ok: true };
}

export function advanceCursor(cwd: string, input: DispatchAuth, context: CapabilityContext): TransitionResult {
  const identity = requireIdentity(context.project_identity, context.run_identity, "workflow advance");
  const found = current(cwd, identity.run_identity);
  if (!found) return transitionFailure("MIGRATION_REQUIRED", "runtime.activate", "advance requires a bound workflow state");
  const { state: rawState, target } = found;
  if (target.invalid) return transitionFailure("IDENTITY_MISMATCH", "runtime.activate", "advance identity does not match the persisted workflow state", rawState);
  if (target.isStale) return { ok: false, error: "workflow state is stale for the active branch", state: rawState };
  if (!rawState.project_identity || !rawState.run_identity || !identityMatches(rawState.project_identity, rawState.run_identity, identity.project_identity, identity.run_identity)) {
    return transitionFailure("IDENTITY_MISMATCH", "runtime.activate", "workflow state project/run identity does not match the advance context", rawState);
  }
  const cap = activeCapability(rawState.dispatch_capability);
  if (!cap) return transitionFailure("MIGRATION_REQUIRED", "runtime.activate", "dispatch capability is unavailable or not v2-bound", rawState);
  const error = auth(cap, input, cap.advance_token_hash);
  if (error) return authFailure(error, rawState);
  if (cap.status === "invalidated" || cap.status === "complete") return { ok: false, error: "capability invalidated", state: rawState };
  if (input.cursor_epoch !== cap.issued_for.cursor_epoch || rawState.stage_cursor !== cap.issued_for.stage_cursor || rawState.cursor_epoch !== cap.issued_for.cursor_epoch) return { ok: false, error: "stale cursor binding", state: rawState };
  if (typeof input.evidence !== "string" || !input.evidence.trim()) return { ok: false, error: "stage advancement evidence required", state: rawState };
  const selected = contextProfile(context);
  if ("error" in selected) return { ok: false, error: selected.error, state: rawState, diagnostic: selected.diagnostic };
  const { profile, profile_identity } = selected;
  if (profile.name !== cap.issued_for.workflow || profile_identity.fingerprint !== cap.issued_for.profile_hash) {
    return { ok: false, error: "workflow profile is missing or stale", state: rawState };
  }
  const currentStage = profile.stages.find((candidate) => candidate.id === rawState.stage_cursor);
  if (!currentStage) return { ok: false, error: "current workflow stage unavailable", state: rawState };

  const flags = rawState.scope;
  if (!flags) return { ok: false, error: "MIGRATION_REQUIRED: workflow scope must be bound before advance", state: rawState };
  const recovered = recoverSynchronousArtifactIds(cwd, rawState, target, cap, currentStage);
  if (!recovered.ok) return { ok: false, error: recovered.error, state: rawState };
  let state = recovered.state;

  // Join by the persisted slot identity, never by array position or provider
  // result order. A retry replaces only the same slot's terminal record.
  const joinCap = activeCapability(state.dispatch_capability) ?? cap;
  const expected = new Set(joinCap.expected_roles);
  const latest = new Map<string, DispatchRecord>();
  for (const record of joinCap.dispatches) {
    const prior = latest.get(record.role);
    if (!prior || record.attempt > prior.attempt) latest.set(record.role, record);
  }
  const records = Array.from(latest.values()).sort((left, right) => left.role.localeCompare(right.role));
  const incomplete = records.some((record) => !expected.has(record.role) || record.status !== "succeeded")
    || records.length !== joinCap.expected_count
    || joinCap.expected_roles.some((role) => !latest.has(role));
  if (incomplete) {
    const pending = records.find((record) => record.status === "pending")?.pending ?? state.pending;
    if (pending) {
      const pendingState: TeamState = {
        ...state,
        pending,
        pause: { kind: "background_wait", reason: "dispatch join remains pending" },
        updated_at: now(),
      };
      persist(cwd, pendingState, target);
      return { ok: false, error: "dispatch join pending", state: pendingState };
    }
    return { ok: false, error: "dispatch join incomplete", state };
  }
  const joinSummary = {
    stage_id: rawState.stage_cursor,
    cursor_epoch: cap.issued_for.cursor_epoch,
    run_identity: cap.issued_for.run_identity,
    dispatch_ids: records.map((r) => r.id),
    roles: records.map((r) => r.role),
    evidence: input.evidence.trim(),
    joined_at: now(),
  };

  // Fan-in: deterministically synthesize multi-slot consilium results into
  // the stable shared artifact ids before any validation or handoff. Missing
  // slot results and collisions fail closed; schema-required scalar
  // disagreements block by default (strict) unless the stage declares an
  // explicit, documented resolution — every applied resolution is recorded
  // in the synthesis provenance (`conflicts`).
  const isMultiSlotConsilium = cap.kind === "consilium" && cap.expected_count > 1;
  if (isMultiSlotConsilium) {
    const currentRecords = activeCapability(state.dispatch_capability)?.dispatches ?? records;
    const withoutArtifacts = currentRecords
      .filter((record) => record.status === "succeeded" && (record.completion?.artifact_ids.length ?? 0) === 0)
      .map((record) => `${record.role} (${namespacedArtifactId(stageProduces(currentStage)[0] ?? "artifact", record.role)})`);
    if (withoutArtifacts.length > 0) {
      return {
        ok: false,
        error: `consilium fan-in incomplete: dispatches without recorded artifact_ids: ${withoutArtifacts.join(", ")}; call workflow_complete with each slot's artifact ids before workflow_advance`,
        state,
      };
    }
  }
  if (isMultiSlotConsilium) {
    const policy: FanInPolicy = {
      ...fanInPolicy,
      resolutions: [...(fanInPolicy.resolutions ?? []), ...(currentStage.fan_in?.resolutions ?? [])],
    };
    const synthesized = synthesizeArtifacts(
      state,
      currentStage.id,
      target.artifactsDir ?? "",
      stageProduces(currentStage),
      cap.expected_roster.map((entry) => entry.role),
      policy,
    );
    if (!synthesized.ok) return { ok: false, error: synthesized.error, state };
    state = synthesized.state;
  }

  // Executable document stage: the engine renders the declared document
  // from the stage's declared sources BEFORE the completion validation
  // commits the transition — the native /do-work path never depends on an
  // agent having rendered it, and a failed render fails the advance closed.
  if (currentStage.type === "document") {
    const rendered = renderStageDocument(currentStage, target);
    if (!rendered.ok) return { ok: false, error: rendered.error, state };
  }

  // Stage completion validation: consumes, produces, schema contracts, the
  // validation gate and the gate expression all fail closed.
  const completion = validateStageCompletion(currentStage, state, target, input.evidence, flags, profile);
  if (!completion.ok) return { ok: false, error: completion.error, state };

  // Unresolved declared checkpoints block advance.
  const checkpointError = unresolvedCheckpointError(currentStage, state);
  if (checkpointError) {
    persist(cwd, state, target);
    return { ok: false, error: checkpointError, state };
  }

  // Bounded loop: evaluate `until`; re-enter `back_to` with a fresh
  // epoch/capability or map exhaustion to needs_human/failed.
  if (currentStage.loop) {
    const until = evaluatePredicate(currentStage.loop.until, {
      flags,
      artifactsDir: target.artifactsDir ?? "",
      state,
      stage: currentStage,
    });
    if (!until.ok) return { ok: false, error: `loop until evaluation failed: ${until.error}`, state };
    if (!until.value) {
      const loop = loopStateFor(state, currentStage.id);
      const decision = loopReentryDecision(loop, currentStage.loop.max_iterations);
      if (decision.exhausted) {
        const kind = loopExhaustionKind(currentStage.loop.on_exhausted);
        const exhausted: LoopState = {
          ...(loop ?? { reentries: 0, history: [], epoch: cap.issued_for.cursor_epoch }),
          stage_id: currentStage.id,
          back_to: currentStage.loop.back_to,
          until: currentStage.loop.until,
          max_iterations: currentStage.loop.max_iterations,
          on_exhausted: currentStage.loop.on_exhausted,
          status: "exhausted",
          outcome: kind,
          ended_at: now(),
        };
        const exhaustedCapability: DispatchCapabilityState = {
          ...cap,
          status: "complete",
          dispatches: [],
        };
        const next: TeamState = {
          ...state,
          loop_state: exhausted,
          pause: { kind, reason: `loop '${currentStage.id}' exhausted after ${currentStage.loop.max_iterations} iteration(s)` },
          stages: state.stages.map((s) => s.id === currentStage.id ? stageWithStatus(s, "done") : s),
          join_summary: joinSummary,
          dispatch_capability: exhaustedCapability,
          updated_at: now(),
        };
        persist(cwd, next, target);
        return { ok: true, state: next };
      }
      return reenterLoop(cwd, state, target, profile, cap, currentStage, records, joinSummary, decision.reentries, flags, context);
    }
    const existingLoop = loopStateFor(state, currentStage.id);
    if (existingLoop) {
      const completedLoop: LoopState = { ...existingLoop, status: "complete", ended_at: now() };
      state = { ...state, loop_state: completedLoop };
    }
  }

  const index = state.stages.findIndex((s) => s.id === state.stage_cursor);
  if (index < 0) return { ok: false, error: "current workflow stage unavailable", state };

  // Skip-aware advance (WF-3): evaluate every consecutive next stage's
  // `skip_if` with the same fail-closed predicate evaluator the interpreter
  // uses before arming a capability. A stage whose skip_if holds is marked
  // terminal `skipped` and is never armed or counted as an expected
  // dispatch; the first runnable stage is armed atomically under this
  // advance token. Malformed or unsupported skip expressions fail closed —
  // they block advance instead of silently skipping or silently running.
  const skippedStageIds: string[] = [];
  let nextStage: StageDef | undefined;
  for (let i = index + 1; i < state.stages.length; i += 1) {
    const entry = state.stages[i];
    const candidate = entry ? profile.stages.find((s) => s.id === entry.id) : undefined;
    if (entry && !candidate) return { ok: false, error: "next workflow stage unavailable", state };
    if (!entry || !candidate) break;
    if (candidate.skip_if) {
      const skip = evaluatePredicate(candidate.skip_if, {
        flags,
        artifactsDir: target.artifactsDir ?? "",
        state,
        stage: candidate,
      });
      if (!skip.ok) {
        return { ok: false, error: `next stage '${candidate.id}' skip_if evaluation failed: ${skip.error}`, state };
      }
      if (skip.value) {
        skippedStageIds.push(candidate.id);
        continue;
      }
    }
    nextStage = candidate;
    break;
  }
  const epoch = randomUUID();
  let handoffSecrets: { capability_id: string; dispatch_token: string; advance_token: string } | undefined;
  let nextCap: DispatchCapabilityState;
  let nextSelection: TeamState["roster_selection"];
  if (nextStage) {
    const nextKind: "none" | "single" | "consilium" =
      nextStage.type === "single" || nextStage.type === "consilium" ? nextStage.type : "none";
    let slots: DispatchSlot[] = [];
    let expectedRoster: Array<{ role: string; agent: string; agent_ref: AgentRef; slot_id?: string; semantic_role?: string; occurrence?: number; facet?: string | null }> = [];
    if (nextKind !== "none" && nextStage.roster_policy) {
      const selection = selectRoster(nextStage, {
        cwd,
        flags,
        project_identity: context.project_identity,
        run_identity: context.run_identity,
        catalog: context.catalog,
        effectivePolicy: context.effective_policy,
        agentInventory: context.agent_inventory,
        resolveDevAgent: () => flags.dev_agent,
        state,
        profile_hash: cap.issued_for.profile_hash,
        run_key: cap.issued_for.run_key,
        workflow: cap.issued_for.workflow,
        capability_epoch: epoch,
        resolveAgent: (role) => qualifiedAgentForRole(role, context)?.registered_name ?? "",
      } satisfies RosterSelectionContext);
      if (selection.ok === false) return { ok: false, error: `next stage '${nextStage.id}' roster selection failed: ${selection.error}`, state };
      if (!selection.selection) return { ok: false, error: `next stage '${nextStage.id}' roster selection is missing`, state };
      nextSelection = selection.selection;
      slots = selection.slots;
      expectedRoster = rosterWithQualifiedAgents(slots, context) ?? [];
    } else if (nextKind !== "none") {
      try {
        slots = resolveStageDispatchSlots(nextStage, {
          cwd,
          flags,
          project_identity: context.project_identity,
          run_identity: context.run_identity,
          catalog: context.catalog,
          resolveDevAgent: () => flags.dev_agent,
          effectivePolicy: context.effective_policy,
          agentInventory: context.agent_inventory,
          state,
        });
        expectedRoster = rosterWithQualifiedAgents(slots, context) ?? [];
      } catch (error) {
        return { ok: false, error: `next stage '${nextStage.id}' dispatch roster unresolved: ${String(error)}`, state };
      }
    }
    if ((nextKind === "single" && slots.length !== 1) || (nextKind === "consilium" && slots.length === 0)) {
      return { ok: false, error: `next stage '${nextStage.id}' has an invalid dispatch roster`, state };
    }
    if (nextKind !== "none" && expectedRoster.length !== slots.length) {
      return { ok: false, error: `next stage '${nextStage.id}' has no complete qualified agent roster`, state };
    }
    const nextWorkIdentityScope = workIdentityScopeForStage(state, nextStage.id);
    state = retireCurrentCapability(state, "advance");
    const issued = createCapability({
      run_key: cap.issued_for.run_key,
      branch: cap.issued_for.branch,
      workflow: cap.issued_for.workflow,
      profile_hash: cap.issued_for.profile_hash,
      stage_cursor: nextStage.id,
      kind: nextKind,
      expected_roster: expectedRoster,
      roster_selection: nextSelection,
      work_identity_scope: nextWorkIdentityScope,
      project_identity: cap.project_identity,
      run_identity: cap.run_identity,
    });
    nextCap = issued.state;
    handoffSecrets = { capability_id: issued.capability_id, dispatch_token: issued.dispatch_token, advance_token: issued.advance_token };
  } else {
    nextCap = { ...cap, status: "complete" };
  }
  const nextRosterState = nextSelection && nextStage
    ? {
        roster_selection: nextSelection,
        roster_selections: { ...(state.roster_selections ?? {}), [nextStage.id]: nextSelection },
      }
    : {};
  const base = nextStage
    ? state
    : normalizeTopLevelCompletionState(state, nextCap, cap.work_identity, state.completion_envelope);
  const next: TeamState = {
    ...base,
    stage_cursor: nextStage?.id ?? state.stage_cursor,
    cursor_epoch: nextStage ? nextCap.issued_for.cursor_epoch : cap.issued_for.cursor_epoch,
    work_identity: nextCap.work_identity,
    // The newly armed ready capability must never be persisted while its
    // stage cursor is still pending: mark the next stage in_progress in the
    // same atomic state update that arms the capability, so a resumed run
    // can dispatch against it immediately. Consecutive skip_if stages are
    // marked terminal `skipped` in the same update; they are never armed.
    stages: state.stages.map((s) => {
      if (s.id === state.stage_cursor) return stageWithStatus(s, "done");
      if (skippedStageIds.includes(s.id)) return stageWithStatus(s, "skipped");
      if (nextStage && s.id === nextStage.id) return stageWithStatus(s, "in_progress");
      return s;
    }),
    join_summary: joinSummary,
    ...nextRosterState,
    dispatch_capability: nextCap,
    pause: nextStage ? { kind: "none", reason: "" } : { kind: "done", reason: "" },
  };
  persist(cwd, next, target);
  return { ok: true, state: next, handoff: nextStage && handoffSecrets ? handoffFromState(next, handoffSecrets, nextStage) : undefined };
}

/**
 * Loop re-entry: point the cursor back at the loop's `back_to` stage and
 * issue a fresh capability with a fresh cursor epoch. Old epochs can never
 * authorize a re-entered iteration — the durable binding rotates with every
 * loop-back. Iteration history is appended durably.
 */
function reenterLoop(
  cwd: string,
  state: TeamState,
  target: ResolvedState,
  profile: Profile,
  cap: ActiveCapability,
  currentStage: StageDef,
  records: DispatchRecord[],
  joinSummary: TeamState["join_summary"],
  reentries: number,
  flags: ScopeFlags,
  context: CapabilityContext,
): TransitionResult {
  const loop = currentStage.loop;
  if (!loop) return { ok: false, error: "loop definition is missing for the current stage", state };
  const backToStage = resolveBackToStage(profile, loop.back_to);
  if (!backToStage) return { ok: false, error: `loop back_to '${loop.back_to}' is not a stage in the profile`, state };
  const kind: "none" | "single" | "consilium" =
    backToStage.type === "single" || backToStage.type === "consilium" ? backToStage.type : "none";
  const epoch = randomUUID();
  let rosterSelection: TeamState["roster_selection"];
  let slots: DispatchSlot[] = [];
  let expectedRoster: Array<{ role: string; agent: string; agent_ref: AgentRef; slot_id?: string; semantic_role?: string; occurrence?: number; facet?: string | null }> = [];
  if (kind !== "none" && backToStage.roster_policy) {
    const selection = selectRoster(backToStage, {
      cwd,
      flags,
      project_identity: context.project_identity,
      run_identity: context.run_identity,
      catalog: context.catalog,
      effectivePolicy: context.effective_policy,
      agentInventory: context.agent_inventory,
      resolveDevAgent: () => flags.dev_agent,
      state,
      profile_hash: cap.issued_for.profile_hash,
      run_key: cap.issued_for.run_key,
      workflow: cap.issued_for.workflow,
      capability_epoch: epoch,
      resolveAgent: (role) => qualifiedAgentForRole(role, context)?.registered_name ?? "",
    } satisfies RosterSelectionContext);
    if (selection.ok === false) return { ok: false, error: `loop target stage '${backToStage.id}' roster selection failed: ${selection.error}`, state };
    if (!selection.selection) return { ok: false, error: `loop target stage '${backToStage.id}' roster selection is missing`, state };
    rosterSelection = selection.selection;
    slots = selection.slots;
    expectedRoster = rosterWithQualifiedAgents(slots, context) ?? [];
  } else if (kind !== "none") {
    try {
      slots = resolveStageDispatchSlots(backToStage, {
        cwd,
        flags,
        project_identity: context.project_identity,
        run_identity: context.run_identity,
        catalog: context.catalog,
        resolveDevAgent: () => flags.dev_agent,
        effectivePolicy: context.effective_policy,
        agentInventory: context.agent_inventory,
        state,
      });
      expectedRoster = rosterWithQualifiedAgents(slots, context) ?? [];
    } catch (error) {
      return { ok: false, error: `loop target stage '${backToStage.id}' dispatch roster unresolved: ${String(error)}`, state };
    }
  }
  if ((kind === "single" && slots.length !== 1) || (kind === "consilium" && slots.length === 0)) {
    return { ok: false, error: `loop target stage '${backToStage.id}' has an invalid dispatch roster`, state };
  }
  if (kind !== "none" && expectedRoster.length !== slots.length) {
    return { ok: false, error: `loop target stage '${backToStage.id}' has no complete qualified agent roster`, state };
  }
  const nextWorkIdentityScope = workIdentityScopeForStage(state, backToStage.id);
  state = retireCurrentCapability(state, "loop_reentry");
  const issued = createCapability({
    run_key: cap.issued_for.run_key,
    branch: cap.issued_for.branch,
    workflow: cap.issued_for.workflow,
    profile_hash: cap.issued_for.profile_hash,
    stage_cursor: backToStage.id,
    kind,
    expected_roster: expectedRoster,
    roster_selection: rosterSelection,
    work_identity_scope: nextWorkIdentityScope,
    project_identity: cap.project_identity,
    run_identity: cap.run_identity,
  });
  const iteration = reentries + 1;
  const issuedEpoch = issued.state.issued_for.cursor_epoch;
  const loopState: LoopState = {
    stage_id: currentStage.id,
    back_to: loop.back_to,
    until: loop.until,
    max_iterations: loop.max_iterations,
    on_exhausted: loop.on_exhausted,
    reentries: iteration,
    epoch: issuedEpoch,
    status: "running",
    history: [
      ...(loopStateFor(state, currentStage.id)?.history ?? []),
      loopIterationRecord(iteration, cap.issued_for.cursor_epoch, issuedEpoch, false),
    ],
  };
  const loopCapability: DispatchCapabilityState = {
    ...issued.state,
    status: "ready",
    dispatches: [],
  };
  const next: TeamState = {
    ...state,
    stage_cursor: backToStage.id,
    cursor_epoch: issuedEpoch,
    work_identity: issued.work_identity,
    loop_state: loopState,
    stages: state.stages.map((s) =>
      s.id === currentStage.id
        ? stageWithStatus(s, "done")
        : s.id === backToStage.id
          ? stageWithStatus(s, "in_progress")
          : s,
    ),
    join_summary: joinSummary,
    dispatch_capability: loopCapability,
    updated_at: now(),
  };
  persist(cwd, next, target);
  return {
    ok: true,
    state: next,
    handoff: handoffFromState(next, {
      capability_id: issued.capability_id,
      dispatch_token: issued.dispatch_token,
      advance_token: issued.advance_token,
    }, backToStage),
  };
}

export interface ChildJoinInput {
  /** The parent and child result must be bound to this exact workflow run identity. */
  project_identity: ProjectIdentity;
  run_identity: WorkflowRunIdentity;
  parent: WorkIdentity;
  child: WorkIdentity;
  state: ChildJoin["state"];
  expected_artifact_ids: string[];
  completion_envelope_ref: string | null;
  attempt: number;
  completion_envelope?: CompletionEnvelope;
}

function sameIdentity(left: WorkIdentity | undefined, right: WorkIdentity | undefined): boolean {
  return left !== undefined && right !== undefined && JSON.stringify(left) === JSON.stringify(right);
}

/** Append a child result to the durable parent ledger without positional joins. */
export function appendChildJoin(cwd: string, input: ChildJoinInput): TransitionResult {
  const found = current(cwd, input.run_identity);
  if (!found) return transitionFailure("MIGRATION_REQUIRED", "runtime.activate", "child join requires a bound project/run state");
  const { state, target } = found;
  if (target.invalid) return transitionFailure("IDENTITY_MISMATCH", "runtime.activate", "child join identity does not match the persisted workflow state", state);
  if (target.isStale) return { ok: false, error: "workflow state is stale for the active branch", state };
  const cap = activeCapability(state.dispatch_capability);
  if (!cap) return transitionFailure("MIGRATION_REQUIRED", "runtime.activate", "dispatch capability is unavailable or not v2-bound", state);
  if (!state.project_identity || !state.run_identity || !identityMatches(state.project_identity, state.run_identity, input.project_identity, input.run_identity) || !identityMatches(cap.project_identity, cap.run_identity, input.project_identity, input.run_identity)) {
    return transitionFailure("IDENTITY_MISMATCH", "runtime.activate", "child join identity does not match the active capability", state);
  }
  if (!input.parent.run_id || input.parent.run_id !== input.run_identity.run_id || !input.child.run_id || input.child.run_id !== input.run_identity.run_id || !input.child.task_id || !input.child.dispatch_id || !input.child.worker_id) return { ok: false, error: "child identity is incomplete or belongs to another run", state };
  if (sameIdentity(input.parent, state.work_identity) && input.parent.run_id !== input.run_identity.run_id) return { ok: false, error: "parent identity belongs to another run", state };
  if (!sameIdentity(input.parent, state.work_identity) && (
    input.parent.capability_id !== cap.capability_id
    || input.parent.capability_epoch !== cap.issued_for.cursor_epoch
  )) return { ok: false, error: "parent identity is not bound to the active capability", state };
  if (sameIdentity(input.parent, input.child)) return { ok: false, error: "parent and child identities must differ", state };
  if (!Number.isInteger(input.attempt) || input.attempt < 1) return { ok: false, error: "child attempt must be a positive integer", state };
  if (new Set(input.expected_artifact_ids).size !== input.expected_artifact_ids.length || input.expected_artifact_ids.some((id) => !isSafeStateSegment(id))) {
    return { ok: false, error: "child artifact ids are unsafe or duplicated", state };
  }
  const terminal = input.state === "succeeded" || input.state === "failed" || input.state === "cancelled";
  if (input.completion_envelope) {
    if (
      !sameIdentity(input.completion_envelope.identity, input.child)
      || !input.completion_envelope.run_identity
      || !runIdentityMatches(input.completion_envelope.run_identity, input.run_identity)
      || input.completion_envelope.outcome !== (terminal ? input.state : "pending")
      || (terminal ? input.completion_envelope.terminal_signal === null : input.completion_envelope.terminal_signal !== null)
    ) return { ok: false, error: "child completion envelope is not a validated terminal/pending envelope", state };
  }
  if (terminal && !input.completion_envelope) {
    return { ok: false, error: "terminal child join requires a completion envelope", state };
  }
  const existing = (state.child_joins ?? []).find((join) => sameIdentity(join.parent, input.parent) && sameIdentity(join.child, input.child));
  if (existing) {
    const exact = existing.state === input.state
      && existing.attempt === input.attempt
      && existing.completion_envelope_ref === input.completion_envelope_ref
      && JSON.stringify(existing.expected_artifact_ids) === JSON.stringify(input.expected_artifact_ids);
    const conflictRef = `conflict:${hash(JSON.stringify({ existing, input }))}`;
    const conflict: ChildJoin = {
      run_identity: input.run_identity,
      parent: input.parent,
      child: input.child,
      state: "conflict",
      expected_artifact_ids: [...input.expected_artifact_ids],
      completion_envelope_ref: conflictRef,
      attempt: Math.max(existing.attempt, input.attempt),
      created_at: existing.created_at,
      joined_at: now(),
    };
    const next: TeamState = { ...state, child_join: conflict, child_joins: [...(state.child_joins ?? []), conflict], updated_at: now() };
    persist(cwd, next, target);
    return { ok: false, error: `child join conflict (${conflictRef})`, state: next, child_join: conflict };
  }
  const priorChild = (state.child_joins ?? []).find((join) => sameIdentity(join.parent, input.parent) && join.child.task_id === input.child.task_id);
  if (priorChild && priorChild.state !== "succeeded" && priorChild.state !== "failed" && priorChild.state !== "cancelled") {
    return { ok: false, error: "active child join cannot be replaced", state };
  }
  if (priorChild && input.attempt <= priorChild.attempt) return { ok: false, error: "child replacement attempt must increase", state };
  const joined: ChildJoin = {
    run_identity: input.run_identity,
    parent: input.parent,
    child: input.child,
    state: input.state,
    expected_artifact_ids: [...input.expected_artifact_ids],
    completion_envelope_ref: input.completion_envelope_ref,
    attempt: input.attempt,
    created_at: now(),
    joined_at: now(),
  };
  const next: TeamState = {
    ...state,
    child_join: joined,
    child_joins: [...(state.child_joins ?? []), joined],
    updated_at: now(),
  };
  persist(cwd, next, target);
  return { ok: true, state: next, child_join: joined };
}

export const joinChild = appendChildJoin;

export interface CheckpointDecisionInput extends DispatchAuth {
  checkpoint: string;
  decision: string;
  rationale: string;
  run_id?: string;
  checkpoint_id?: string;
  checkpoint_kind?: TypedCheckpointDecision["checkpoint_kind"];
  authorization?: TypedCheckpointDecision["authorization"];
  actor_provenance?: TypedCheckpointDecision["actor"];
  /** Legacy fields are accepted as display input only and never authorize. */
  mode?: "interactive" | "autonomous";
  actor?: string;
}

/** Persist a policy-bound typed checkpoint decision. */
export function recordCheckpointDecision(
  cwd: string,
  input: CheckpointDecisionInput,
  context: CapabilityContext,
): TransitionResult {
  const found = current(cwd, context.run_identity);
  if (!found) return transitionFailure("MIGRATION_REQUIRED", "runtime.activate", "checkpoint requires a bound project/run state");
  const { state, target } = found;
  if (target.invalid) return transitionFailure("IDENTITY_MISMATCH", "runtime.activate", "checkpoint identity does not match the persisted workflow state", state);
  if (target.isStale) return { ok: false, error: "workflow state is stale for the active branch", state };
  if (!state.project_identity || !state.run_identity || !identityMatches(state.project_identity, state.run_identity, context.project_identity, context.run_identity)) {
    return transitionFailure("IDENTITY_MISMATCH", "runtime.activate", "workflow state project/run identity is not bound to the checkpoint context", state);
  }
  const cap = activeCapability(state.dispatch_capability);
  if (!cap) return transitionFailure("MIGRATION_REQUIRED", "runtime.activate", "dispatch capability is unavailable or not v2-bound", state);
  const error = auth(cap, input, cap.advance_token_hash);
  if (error) return authFailure(error, state);
  if (cap.status === "invalidated" || cap.status === "complete") return { ok: false, error: "capability invalidated", state };
  if (input.stage_cursor !== cap.issued_for.stage_cursor) return { ok: false, error: "checkpoint stage does not match the active capability", state };
  if (!input.checkpoint.trim() || !input.decision.trim()) return { ok: false, error: "checkpoint name and decision are required", state };
  if (!input.authorization || !input.actor_provenance) {
    return { ok: false, error: "typed checkpoint authorization and actor provenance are required; legacy mode/actor fields cannot authorize", state };
  }
  const selected = contextProfile(context);
  if ("error" in selected) return { ok: false, error: selected.error, state, diagnostic: selected.diagnostic };
  if (selected.profile_identity.fingerprint !== cap.issued_for.profile_hash) {
    return { ok: false, error: "IDENTITY_MISMATCH: checkpoint profile is stale", state };
  }
  const stage = selected.profile.stages.find((candidate) => candidate.id === cap.issued_for.stage_cursor);
  if (!stage?.checkpoint) return { ok: false, error: `stage '${cap.issued_for.stage_cursor}' declares no checkpoint`, state };
  if (input.checkpoint !== stage.checkpoint || (input.checkpoint_id && input.checkpoint_id !== input.checkpoint)) {
    return { ok: false, error: `checkpoint '${input.checkpoint}' does not match declared checkpoint '${stage.checkpoint}'`, state };
  }
  const policy = resolveCheckpointPolicy(stage, state);
  if (!policy) return { ok: false, error: `checkpoint '${input.checkpoint}' has no policy`, state };
  const rule = policy.rules[input.checkpoint];
  if (!rule) return { ok: false, error: `checkpoint policy has no rule for '${input.checkpoint}'`, state };
  if (input.run_id !== undefined && input.run_id !== context.run_identity.run_id) {
    return transitionFailure("IDENTITY_MISMATCH", "runtime.activate", "checkpoint scalar run id does not match the required run identity", state);
  }
  const decision: TypedCheckpointDecision = {
    run_id: context.run_identity.run_id,
    run_identity: cap.issued_for.run_identity,
    stage_id: stage.id,
    checkpoint_id: input.checkpoint,
    checkpoint_kind: input.checkpoint_kind ?? rule.kind,
    decision: input.decision.trim(),
    authorization: input.authorization,
    actor: input.actor_provenance,
    capability_id: cap.capability_id,
    capability_epoch: cap.issued_for.cursor_epoch,
    policy_hash: checkpointPolicyHash(policy),
    rationale: input.rationale.trim(),
    decided_at: now(),
  };
  const validated = validateCheckpointDecision(state, decision, { stage, policy });
  if (!validated.ok) return { ok: false, error: `${validated.code}: ${validated.error}`, state };
  const next = appendCheckpointDecision(state, decision);
  next.updated_at = now();
  persist(cwd, next, target);
  return { ok: true, state: next };
}
export function reconcileTaskResult(cwd: string, input: {
  project_identity: ProjectIdentity;
  run_identity: WorkflowRunIdentity;
  dispatch_id?: string;
  tool_call_id?: string;
  slot_id?: string;
  task_id?: string;
  token?: string;
  capability_id: string;
  cursor_epoch?: string;
  output?: string;
  isError?: boolean;
  details?: { async?: { state?: string; provider_ref?: string } };
}): TransitionResult {
  if (!input.dispatch_id && !input.tool_call_id) return { ok: false, error: "dispatch identity required" };
  if (!input.token) return { ok: false, error: "dispatch token required" };
  const found = current(cwd, input.run_identity);
  if (!found) return transitionFailure("MIGRATION_REQUIRED", "runtime.activate", "task reconciliation requires a bound project/run state");
  if (found.target.invalid) return transitionFailure("IDENTITY_MISMATCH", "runtime.activate", "task result identity does not match the persisted workflow state", found.state);
  if (found.target.isStale) return { ok: false, error: "workflow state is stale for the active branch", state: found.state };
  if (!found.state.project_identity || !found.state.run_identity || !identityMatches(found.state.project_identity, found.state.run_identity, input.project_identity, input.run_identity)) {
    return transitionFailure("IDENTITY_MISMATCH", "runtime.activate", "task result identity does not match the active project/run identity", found.state);
  }
  const cap = activeCapability(found.state.dispatch_capability);
  if (!cap || cap.capability_id !== input.capability_id || !identityMatches(cap.project_identity, cap.run_identity, input.project_identity, input.run_identity) || (input.cursor_epoch && cap.issued_for.cursor_epoch !== input.cursor_epoch)) {
    return transitionFailure("IDENTITY_MISMATCH", "runtime.activate", "task result capability binding mismatch", found.state);
  }
  const records = cap.dispatches.filter((record) =>
    !record.completion
    && (input.dispatch_id ? record.id === input.dispatch_id : record.tool_call_id === input.tool_call_id)
    && (!input.slot_id || input.slot_id === record.role || input.slot_id === record.work_identity?.slot_id)
    && (!input.task_id || input.task_id === record.work_identity?.task_id),
  );
  if (records.length !== 1) return { ok: false, error: records.length === 0 ? "unknown dispatch" : "ambiguous positional result", state: found.state };
  const record = records[0];
  if (!record) return { ok: false, error: "dispatch result identity disappeared", state: found.state };
  const asyncState = input.details?.async?.state;
  const remainsPending = asyncState === "running" || asyncState === "spawned" || asyncState === "scheduled" || (!input.output && !input.isError);
  if (remainsPending) {
    return completeDispatch(cwd, {
      dispatch_id: record.id,
      token: input.token,
      capability_id: input.capability_id,
      run_key: cap.issued_for.run_key,
      branch: cap.issued_for.branch,
      workflow: cap.issued_for.workflow,
      profile_hash: cap.issued_for.profile_hash,
      stage_cursor: cap.issued_for.stage_cursor,
      cursor_epoch: cap.issued_for.cursor_epoch,
      project_identity: input.project_identity,
      run_identity: input.run_identity,
      role: record.role,
      slot_id: record.work_identity?.slot_id,
      task_id: record.work_identity?.task_id,
      agent: record.agent,
      tool_call_id: record.tool_call_id,
      pending: true,
      pending_reason: "provider_running",
      provider_ref: input.details?.async?.provider_ref ?? asyncState,
    });
  }
  const evidence = input.output?.trim() || (input.isError ? "task failed" : "");
  return completeDispatch(cwd, {
    dispatch_id: record.id,
    token: input.token,
    capability_id: input.capability_id,
    run_key: cap.issued_for.run_key,
    branch: cap.issued_for.branch,
    workflow: cap.issued_for.workflow,
    profile_hash: cap.issued_for.profile_hash,
    stage_cursor: cap.issued_for.stage_cursor,
    cursor_epoch: cap.issued_for.cursor_epoch,
    project_identity: input.project_identity,
    run_identity: input.run_identity,
    role: record.role,
    slot_id: record.work_identity?.slot_id,
    task_id: record.work_identity?.task_id,
    agent: record.agent,
    tool_call_id: record.tool_call_id,
    outcome: input.isError ? "failed" : "succeeded",
    evidence,
    completed_by: "synchronous_tool_result",
  });
}
