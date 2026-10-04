import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

import { loadProfile } from "../engine/profile.js";
import { validateWorkIdentityValue, type ControlPlaneValidation } from "../engine/control-plane-contract.js";
import { readRunControlNoRecovery } from "../engine/run-store.js";
import type {
  AuthenticatedRecoveryGrant,
  RecoveryAction,
  RecoveryAuthority,
  RecoveryBudget,
  RecoveryCancelAcknowledgement,
  RecoveryErrorClass,
  RecoveryEvidenceProof,
  RecoveryHandoffState,
  RecoveryMutation,
  RecoveryOperationRecord,
  RecoveryOwnershipProof,
  RecoveryPreflightNotStartedProof,
  RecoveryResponsePayload,
  RecoveryRevision,
  RecoveryStateProof,
  RecoveryTerminalProof,
  RecoveryTransitionEvidence,
  StageProducerBinding,
  StageRecoveryAckRequest,
  StageRecoveryPrepareRequest,
  StageRecoverySnapshot,
  StageRecoveryStore,
  StageRecoveryTransitionRequest,
  StageRecoveryTransitionResult,
  TrustedRecoveryHandoff,
  TrustedRecoverySelection,
} from "../engine/stage-recovery.js";
import {
  consumePreparedRecoveryAdmission,
  formatValidationContextValid,
  formatValidationProducerValid,
  migrateStageRecoveryLedger,
  recoveryBudgetsWithDefaults,
  recoveryBudgetsForPrepare,
  STAGE_RECOVERY_FIELD,
  STAGE_RECOVERY_SCHEMA_VERSION,
  type ConsumePreparedRecoveryAdmissionResult,
  type StageRecoveryFormatValidationInput,
  type StageRecoveryFormatValidationResult,
  type CurrentRecoveryHandoffInput,
  type CurrentRecoveryHandoffResult,
  type PreparedRecoveryAdmissionScope,
  type RecoveryGrantAuthorizationProof,
  type StageRecoveryGrantAuthorizationInput,
  type StageRecoveryGrantCommitInput,
  type StageRecoveryGrantCommitResult,
  type StageRecoveryGrantRecord,
  type StageRecoveryLedger,
  type StageRecoveryLineage,
  type StageRecoveryOperationRecord,
  type StageRecoveryStoreAuthentication,
} from "../engine/stage-recovery-store.js";
import type { CtoClaimScope, RunControl, TrustedExecutionContext, WorkIdentity, WorktreeExecutionClaim } from "../engine/types.js";
import type { CtoState, NativeStageAssignment, NativeStageProgress } from "./types.js";
import { activeWave, ctoStatePath, readCtoState, writeCtoState } from "./state.js";

export interface NativeStageRecoveryStoreOptions {
  readonly context: TrustedExecutionContext;
  readonly runId: string;
  readonly claim_scope?: CtoClaimScope;
}

export type NativeStageRecoveryStore = StageRecoveryStore & StageRecoveryStoreAuthentication & {
  readonly recordFormatValidation: (input: StageRecoveryFormatValidationInput) => StageRecoveryFormatValidationResult;
  readonly consumePreparedRecoveryAdmission: (
    ledger: StageRecoveryLedger,
    scope: PreparedRecoveryAdmissionScope,
    toolCallId: string,
  ) => ConsumePreparedRecoveryAdmissionResult;
};

interface CurrentOwner {
  readonly claim: WorktreeExecutionClaim;
  readonly owner_id: string;
  readonly ownership_epoch: string;
  readonly binding_id: string;
  readonly proof: string;
}
interface NativeCandidate {
  readonly identity: WorkIdentity;
  readonly progress?: NativeStageProgress;
  readonly assignment?: NativeStageAssignment;
}
interface CanonicalRead {
  readonly state: CtoState;
  readonly raw_hash: string;
  readonly revision: number;
  readonly owner: CurrentOwner;
}
interface BudgetConsumption {
  readonly ok: true;
  readonly line: StageRecoveryLineage;
  readonly remaining: number;
}
interface BudgetFailure {
  readonly ok: false;
  readonly code: string;
}
type BudgetResult = BudgetConsumption | BudgetFailure;


function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
function integer(value: unknown, min = 0): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= min;
}
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (record(value)) return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => [key, canonicalize(entry)]));
  return value;
}
function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value)) ?? "null";
}
function digest(value: unknown): string {
  return createHash("sha256").update(typeof value === "string" ? value : canonicalJson(value), "utf8").digest("hex");
}
function clone<T>(value: T): T {
  return structuredClone(value);
}
function sanitizePersisted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizePersisted);
  if (!record(value)) return value;
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) result[key] = sanitizePersisted(entry);
  const proof = result.proof;
  if (record(proof) && typeof proof.authenticated === "boolean") {
    result.proof = {
      ...proof,
      authenticated: false,
      ...(Object.prototype.hasOwnProperty.call(proof, "binding_id") ? { binding_id: "historical" } : {}),
    };
  }
  if (typeof result.authenticated === "boolean" && typeof result.source === "string" && typeof result.run_id === "string" && (result.authority === "ordinary" || result.authority === "cto")) {
    result.authenticated = false;
    if (Object.prototype.hasOwnProperty.call(result, "binding_id")) result.binding_id = "historical";
  }
  return result;
}
function persistedClone<T>(value: T): T {
  return sanitizePersisted(clone(value)) as T;
}
function identityValid(value: unknown): value is WorkIdentity {
  const validation: ControlPlaneValidation = validateWorkIdentityValue(value);
  return validation.ok;
}
function sameIdentity(left: WorkIdentity | undefined, right: WorkIdentity | undefined): boolean {
  return left !== undefined && right !== undefined && canonicalJson(left) === canonicalJson(right);
}
function lineageIdentity(identity: WorkIdentity, rootDispatchId = identity.dispatch_id): Record<string, unknown> {
  const { dispatch_id: _dispatchId, attempt: _attempt, ...stable } = identity;
  return { root_dispatch_id: rootDispatchId, ...stable };
}
function sameScope(left: WorkIdentity, right: WorkIdentity): boolean {
  // Native child binding replaces session/task identities when a retry starts
  // in a new SDK session; recovery lineage remains the same declared slot.
  return left.run_id === right.run_id
    && left.wave_id === right.wave_id
    && left.slice_id === right.slice_id
    && left.workflow === right.workflow
    && left.stage_id === right.stage_id
    && left.stage_cursor === right.stage_cursor
    && left.capability_id === right.capability_id
    && left.capability_epoch === right.capability_epoch
    && left.loop_iteration === right.loop_iteration
    && left.slot_id === right.slot_id;
}
function lineageKey(identity: WorkIdentity, generation: number, rootDispatchId = identity.dispatch_id): string {
  return digest({ schema: 1, generation, identity: lineageIdentity(identity, rootDispatchId) });
}
function stateLedger(state: CtoState): StageRecoveryLedger | undefined {
  return migrateStageRecoveryLedger((state as unknown as Record<string, unknown>)[STAGE_RECOVERY_FIELD]);
}
function stateWithLedger(state: CtoState, ledger: StageRecoveryLedger): CtoState {
  (state as unknown as Record<string, unknown>)[STAGE_RECOVERY_FIELD] = ledger;
  return state;
}
function stateRaw(runId: string, cwd: string): string {
  return readFileSync(ctoStatePath(runId, cwd), "utf8");
}
function stateRevision(state: CtoState): number {
  let revision = 0;
  for (const progress of Object.values(state.native_stage_progress ?? {})) revision = Math.max(revision, progress.revision);
  const ledger = stateLedger(state);
  for (const line of Object.values(ledger?.lineages ?? {})) {
    for (const operation of line.operations) {
      if (typeof operation.expected_revision === "number") revision = Math.max(revision, operation.expected_revision);
      if (typeof operation.revision === "number") revision = Math.max(revision, operation.revision);
    }
  }
  return revision;
}

function exactClaim(claim: WorktreeExecutionClaim | null, runId: string, context: TrustedExecutionContext, scope?: CtoClaimScope): WorktreeExecutionClaim | undefined {
  if (!claim || claim.owner_kind !== "cto" || claim.run_id !== runId || claim.released_at !== null) return undefined;
  if (claim.coordinator_session_id !== context.session_id || (claim.coordinator_process_id ?? undefined) !== (context.process_id ?? undefined)) return undefined;
  if (scope && (scope.run_id !== runId || scope.ownership_epoch !== claim.ownership_epoch)) return undefined;
  return claim;
}
function currentOwner(control: RunControl, runId: string, context: TrustedExecutionContext, scope?: CtoClaimScope, identity?: WorkIdentity): CurrentOwner {
  const claim = exactClaim(control.execution_claim, runId, context, scope);
  if (!claim) throw new Error("authenticated CTO claim is not current");
  const binding_id = digest({ version: 1, authority: "cto", run_id: runId, owner_id: claim.coordinator_session_id, ownership_epoch: claim.ownership_epoch, identity: identity ?? null });
  const proof = digest({ version: 1, authority: "cto", run_id: runId, owner_id: claim.coordinator_session_id, ownership_epoch: claim.ownership_epoch, binding_id });
  return { claim, owner_id: claim.coordinator_session_id, ownership_epoch: claim.ownership_epoch, binding_id, proof };
}
function candidates(state: CtoState): NativeCandidate[] {
  const result: NativeCandidate[] = [];
  const wave = activeWave(state);
  const add = (identity: WorkIdentity | undefined, progress?: NativeStageProgress, assignment?: NativeStageAssignment): void => {
    if (!identity || !identityValid(identity) || identity.run_id !== state.id) return;
    if (wave && identity.wave_id !== wave.id) return;
    const existingIndex = result.findIndex((entry) => sameIdentity(entry.identity, identity));
    if (existingIndex >= 0) {
      const existing = result[existingIndex]!;
      if ((!existing.progress && progress) || (!existing.assignment && assignment)) {
        result[existingIndex] = { ...existing, ...(progress && !existing.progress ? { progress } : {}), ...(assignment && !existing.assignment ? { assignment } : {}) };
      }
      return;
    }
    result.push({ identity: clone(identity), ...(progress ? { progress } : {}), ...(assignment ? { assignment } : {}) });
  };
  add((state as unknown as { work_identity?: WorkIdentity }).work_identity);
  if (wave) add(wave.work_identity);
  for (const progress of Object.values(state.native_stage_progress ?? {})) {
    if (progress.run_id !== state.id || (wave && progress.wave_id !== wave.id)) continue;
    for (const assignment of Object.values(progress.assignments)) add(assignment.identity, progress, assignment);
  }
  for (const team of state.teams) {
    add(team.work_identity);
    add(team.pending?.identity);
  }
  return result;
}
function identityForState(state: CtoState, requested?: WorkIdentity): NativeCandidate | undefined {
  const all = candidates(state);
  if (requested) return all.find((entry) => sameIdentity(entry.identity, requested));

  const assigned = all.filter((entry) => entry.assignment !== undefined);
  const teamPointers = state.teams.flatMap((team) => [team.work_identity, team.pending?.identity]).filter((identity): identity is WorkIdentity => identity !== undefined);
  const pointed = (entries: readonly NativeCandidate[]): NativeCandidate[] => {
    const matches = entries.filter((entry) => teamPointers.some((identity) => sameIdentity(identity, entry.identity)) && entry.progress?.declared_slots.some((slot) => slot.slot_id === entry.assignment?.slot_id));
    return matches.filter((entry, index) => matches.findIndex((candidate) => sameIdentity(candidate.identity, entry.identity)) === index);
  };
  const activeAssignments = assigned.filter((entry) => entry.assignment?.status !== "terminal");
  if (activeAssignments.length === 0 && assigned.length > 1) {
    const newestAttempt = Math.max(...assigned.map((entry) => entry.identity.attempt));
    const newest = assigned.filter((entry) => entry.identity.attempt === newestAttempt);
    const newestPointers = pointed(newest);
    if (newestPointers.length === 1) return newestPointers[0];
    if (newest.length === 1) return newest[0];
    return undefined;
  }
  const currentPointer = pointed(assigned);
  if (currentPointer.length > 1) return undefined;
  if (currentPointer.length === 1) {
    const pointer = currentPointer[0]!;
    const linkedActive = activeAssignments.filter((entry) => sameScope(entry.identity, pointer.identity));
    if (linkedActive.length > 1) return undefined;
    if (linkedActive.length === 1) return linkedActive[0];
    return pointer;
  }
  if (activeAssignments.length === 1) return activeAssignments[0];
  if (activeAssignments.length > 1) return undefined;
  if (assigned.length === 1) return assigned[0];
  if (assigned.length > 1) return undefined;

  const root = state.work_identity;
  const rootFound = root ? all.find((entry) => sameIdentity(entry.identity, root)) : undefined;
  return rootFound ?? (all.length === 1 ? all[0] : undefined);
}
function lineFor(ledger: StageRecoveryLedger | undefined, identity: WorkIdentity, generation: number, rootDispatchId?: string): { key: string; line?: StageRecoveryLineage } {
  const key = lineageKey(identity, generation, rootDispatchId);
  const direct = ledger?.lineages[key];
  if (direct) return { key, line: direct };
  const matches = Object.entries(ledger?.lineages ?? {}).filter(([, line]) => line.generation === generation && sameScope(line.identity, identity));
  if (matches.length === 1) return { key: matches[0]![0], line: matches[0]![1] };
  const linked = matches.filter(([, line]) => line.operations.some((operation) => operation.replacement_identity && sameIdentity(operation.replacement_identity, identity)));
  return linked.length === 1 ? { key: linked[0]![0], line: linked[0]![1] } : { key };
}
function generationFor(_candidate: NativeCandidate): number {
  return 0;
}
function nativeOwnerEpoch(identity: WorkIdentity): string | undefined {
  const workerId = identity.worker_id;
  if (!workerId.startsWith("cto:")) return undefined;
  const firstSeparator = workerId.indexOf(":", 4);
  const lastSeparator = workerId.lastIndexOf(":");
  if (firstSeparator <= 4 || firstSeparator >= lastSeparator) return undefined;
  const epoch = workerId.slice(4, firstSeparator);
  return epoch.length > 0 ? epoch : undefined;
}
function lifecycleFor(candidate: NativeCandidate, line: StageRecoveryLineage | undefined, ownerEpoch: string): StageRecoverySnapshot["lifecycle"] {
  if (line?.lifecycle === "terminal" || line?.lifecycle === "not_started") return line.lifecycle;
  const recordedOwner = line?.lifecycle_owner_epoch;
  const currentOwner = recordedOwner !== undefined ? recordedOwner === ownerEpoch : nativeOwnerEpoch(candidate.identity) === ownerEpoch;
  // Host lifecycle receipts are owner-scoped. A receipt from an older CTO
  // claim cannot re-establish liveness after handover, but a current-owner
  // receipt must override the assignment's last persisted transport status.
  if (line?.lifecycle === "disconnected" || line?.lifecycle === "running") return currentOwner ? line.lifecycle : "unknown";
  const status = candidate.assignment?.status;
  if (status === "reserved") return "pending";
  if (status === "running") return currentOwner ? "running" : "unknown";
  if (status === "accepted" || status === "terminal") return "terminal";
  return "unknown";
}
function proofFor(runId: string, revision: number, rawHash: string, identity?: WorkIdentity): RecoveryStateProof {
  return { authenticated: true, source: "cto-canonical-state", run_id: runId, authority: "cto", revision, digest: rawHash, ...(identity ? { dispatch_id: identity.dispatch_id, identity: clone(identity), event_id: identity.dispatch_id } : {}), observed_at: new Date().toISOString() };
}
function ownershipFor(runId: string, owner: CurrentOwner): RecoveryOwnershipProof {
  return { authenticated: true, run_id: runId, authority: "cto", owner_id: owner.owner_id, ownership_epoch: owner.ownership_epoch, binding_id: owner.binding_id, proof: owner.proof };
}
function grantProofDigest(value: StageRecoveryGrantRecord, owner: CurrentOwner): string {
  return digest({ version: 1, run_id: value.run_id, authority: value.authority, grant_id: value.grant_id, owner_id: owner.owner_id, ownership_epoch: owner.ownership_epoch, error_class: value.error_class, identity: value.identity, limit: value.limit, reason: value.reason, authorizer: value.authorizer });
}
function grantSnapshot(value: StageRecoveryGrantRecord, owner?: CurrentOwner): AuthenticatedRecoveryGrant {
  return { authenticated: true, grant_id: value.grant_id, run_id: value.run_id, authority: value.authority, owner_id: owner?.owner_id ?? value.owner_id, ownership_epoch: owner?.ownership_epoch ?? value.ownership_epoch, error_class: value.error_class, identity: clone(value.identity), limit: value.limit, used: value.used, reason: value.reason, authorizer: value.authorizer, proof: owner ? grantProofDigest(value, owner) : value.proof_digest };
}
function historicalProof(proof: RecoveryEvidenceProof, bindingId: string): RecoveryEvidenceProof | undefined {
  if ((proof.authenticated !== true && proof.authenticated !== false) || !nonEmpty(proof.source) || !nonEmpty(proof.event_id) || !nonEmpty(proof.observed_at) || (proof.authenticated === false && proof.binding_id !== "historical") || (proof.authenticated === true && !nonEmpty(proof.binding_id))) return undefined;
  return { ...proof, authenticated: true, binding_id: bindingId };
}
function terminalForRead(
  terminal: RecoveryTerminalProof | undefined,
  identity: WorkIdentity | undefined,
  assignment: NativeStageAssignment | undefined,
  bindingId: string,
): RecoveryTerminalProof | undefined {
  if (!terminal || !identity || !assignment || !sameIdentity(terminal.identity, identity) || terminal.dispatch_id !== identity.dispatch_id || !sameIdentity(assignment.identity, identity) || assignment.status !== "terminal") return undefined;
  const proof = historicalProof(terminal.proof, bindingId);
  return proof ? { ...clone(terminal), proof } : undefined;
}
function preflightReceiptMatches(
  preflight: RecoveryPreflightNotStartedProof,
  operations: readonly StageRecoveryOperationRecord[],
  identity: WorkIdentity,
): boolean {
  const expected = canonicalJson(persistedClone(preflight));
  return operations.some((operation) => {
    if (operation.status !== "acked" || operation.dispatch_id !== identity.dispatch_id || (operation.action !== "observe" && operation.action !== "preflight")) return false;
    const preparedRevision = typeof operation.expected_revision === "number" ? operation.expected_revision + 1 : undefined;
    if (preparedRevision !== undefined && preflight.proof.state_revision !== preparedRevision) return false;
    if (operation.response?.state_revision !== preflight.proof.state_revision) return false;
    const evidence = operation.evidence;
    const responseEvidence = operation.response?.evidence;
    return evidence?.kind === "preflight_not_started"
      && responseEvidence?.kind === "preflight_not_started"
      && canonicalJson(persistedClone(evidence)) === expected
      && canonicalJson(persistedClone(responseEvidence)) === expected;
  });
}
function preflightForRead(
  preflight: RecoveryPreflightNotStartedProof | undefined,
  operations: readonly StageRecoveryOperationRecord[],
  identity: WorkIdentity | undefined,
  assignment: NativeStageAssignment | undefined,
  bindingId: string,
  line: StageRecoveryLineage | undefined,
): RecoveryPreflightNotStartedProof | undefined {
  const terminalSignal = assignment?.terminal_signal;
  if (!preflight || !line || line.lifecycle !== "not_started" || !identity || !assignment || !sameIdentity(preflight.identity, identity) || preflight.dispatch_id !== identity.dispatch_id || !sameIdentity(assignment.identity, identity) || assignment.status !== "terminal" || (terminalSignal !== "preflight:missing_prompt" && terminalSignal !== "preflight:invalid_arguments") || !preflightReceiptMatches(preflight, operations, identity)) return undefined;
  const proof = historicalProof(preflight.proof, bindingId);
  return proof ? { ...clone(preflight), proof } : undefined;
}
function materializeOperation(
  operation: StageRecoveryOperationRecord,
  revision: RecoveryRevision,
  stateProof: RecoveryStateProof,
  terminal?: RecoveryTerminalProof,
  preflight?: RecoveryPreflightNotStartedProof,
): StageRecoveryOperationRecord {
  const historicalEvidence = operation.evidence;
  let evidence = historicalEvidence;
  if (historicalEvidence?.kind === "preflight_not_started" && preflight && canonicalJson(persistedClone(historicalEvidence)) === canonicalJson(persistedClone(preflight))) {
    evidence = preflight;
  }
  if (
    historicalEvidence?.kind === "terminal"
    && terminal
    && historicalEvidence.authoritative === terminal.authoritative
    && historicalEvidence.run_id === terminal.run_id
    && historicalEvidence.dispatch_id === terminal.dispatch_id
    && sameIdentity(historicalEvidence.identity, terminal.identity)
    && historicalEvidence.outcome === terminal.outcome
    && historicalEvidence.terminal_event_id === terminal.terminal_event_id
    && historicalEvidence.observed_at === terminal.observed_at
    && canonicalJson(persistedClone(historicalEvidence.proof)) === canonicalJson(persistedClone(terminal.proof))
  ) {
    evidence = { ...historicalEvidence, proof: terminal.proof };
  }
  const historicalResponseEvidence = operation.response?.evidence;
  const responseEvidence = evidence && evidence.kind !== "handoff_refresh" ? evidence : undefined;
  const response = operation.response
    ? {
        ...operation.response,
        state_revision: revision,
        state_proof: stateProof,
        ...(responseEvidence && historicalResponseEvidence && historicalEvidence && canonicalJson(persistedClone(historicalResponseEvidence)) === canonicalJson(persistedClone(historicalEvidence)) ? { evidence: responseEvidence } : {}),
      }
    : undefined;
  return { ...operation, ...(evidence ? { evidence } : {}), ...(response ? { response } : {}) };
}
function snapshotFromRead(input: { cwd: string; run_id: string; state: CtoState; raw_hash: string; revision: number; owner: CurrentOwner; identity?: WorkIdentity }): StageRecoverySnapshot {
  const selected = identityForState(input.state, input.identity);
  const identity = selected?.identity;
  const generation = selected ? generationFor(selected) : 0;
  const ledger = stateLedger(input.state);
  const selectedLine = identity ? lineFor(ledger, identity, generation).line : undefined;
  const producer = selected && identity ? producerFor(input, selected, selectedLine) : undefined;
  const bindingId = identity ? digest({ version: 1, authority: "cto", run_id: input.run_id, owner_id: input.owner.owner_id, ownership_epoch: input.owner.ownership_epoch, identity }) : input.owner.binding_id;
  const owner = { ...input.owner, binding_id: bindingId, proof: digest({ version: 1, authority: "cto", run_id: input.run_id, owner_id: input.owner.owner_id, ownership_epoch: input.owner.ownership_epoch, binding_id: bindingId }) };
  const rawLifecycle = selected ? lifecycleFor(selected, selectedLine, input.owner.ownership_epoch) : "unknown";
  const terminal = terminalForRead(selectedLine?.terminal, identity, selected?.assignment, bindingId);
  const preflight = preflightForRead(selectedLine?.preflight, selectedLine?.operations ?? [], identity, selected?.assignment, bindingId, selectedLine);
  const lifecycle = (rawLifecycle === "terminal" && !terminal) || (rawLifecycle === "not_started" && !preflight) ? "unknown" : rawLifecycle;
  const stateProof = proofFor(input.run_id, input.revision, input.raw_hash, identity);
  return {
    run_id: input.run_id,
    authority: "cto",
    revision: input.revision,
    state_proof: stateProof,
    ownership: ownershipFor(input.run_id, owner),
    ...(identity ? { identity: clone(identity) } : {}),
    ...(producer ? { producer } : {}),
    binding_id: bindingId,
    ...(selectedLine?.producer_available === undefined ? { producer_available: producer !== undefined && lifecycle !== "terminal" } : { producer_available: selectedLine.producer_available }),
    lifecycle,
    ...(terminal ? { terminal } : {}),
    ...(preflight ? { preflight } : {}),
    ...(selectedLine?.error_context ? { error_context: clone(selectedLine.error_context) } : {}),
    budgets: clone(recoveryBudgetsWithDefaults(selectedLine?.budgets ?? [])),
    grants: clone((selectedLine?.grants ?? []).map((entry) => grantSnapshot(entry, owner))),
    operations: clone((selectedLine?.operations ?? []).map((entry) => {
      const materialized = materializeOperation(entry, input.revision, stateProof, terminal, preflight);
      const { mutation_digest: _digest, ...operation } = materialized;
      return operation;
    })),
    ...(selectedLine?.handoff ? { handoff: clone(selectedLine.handoff) } : {}),
    ...(selectedLine?.cancellation ? { cancellation: persistedClone(selectedLine.cancellation) } : {}),
  };
}
function producerFor(input: { cwd: string; state: CtoState; owner: CurrentOwner }, candidate: NativeCandidate, line?: StageRecoveryLineage): StageProducerBinding | undefined {
  if (line?.producer) return clone(line.producer);
  const profile = loadProfile(candidate.identity.workflow);
  const stage = profile?.stages.find((entry) => entry.id === candidate.identity.stage_id);
  const base = { authority: "cto" as const, identity: clone(candidate.identity), host: { session_id: input.owner.claim.coordinator_session_id, worktree: input.cwd, branch: input.state.branch } };
  const generation = generationFor(candidate);
  if (candidate.assignment) return undefined;
  if (stage?.producer?.kind === "tool") return { ...base, producer: { kind: "tool", profile: profile!.name, stage_id: candidate.identity.stage_id, iteration: candidate.identity.loop_iteration ?? generation, generation, wave_id: candidate.identity.wave_id, slice_id: candidate.identity.slice_id, tool_name: stage.producer.tool_name } };
  if (profile) return { ...base, producer: { kind: "orchestrator", profile: profile.name, stage_id: candidate.identity.stage_id, iteration: candidate.identity.loop_iteration ?? generation, generation, wave_id: candidate.identity.wave_id, slice_id: candidate.identity.slice_id, owner: "native-lead" } };
  return undefined;
}
function nativeProducerKindMatches(candidate: NativeCandidate, producer: StageProducerBinding): boolean {
  const profile = loadProfile(candidate.identity.workflow);
  const stage = profile?.stages.find((entry) => entry.id === candidate.identity.stage_id);
  const assignment = candidate.assignment;
  if (!profile || !stage || !assignment) return false;
  const expected = assignment.role === "lead" && stage.producer?.kind === "tool"
    ? "tool"
    : stage.type === "orchestrator" && assignment.role === "lead"
      ? "orchestrator"
      : stage.type !== "orchestrator" && assignment.role !== "lead"
        ? "worker"
        : undefined;
  if (expected === undefined || producer.producer.kind !== expected) return false;
  if (producer.producer.profile !== profile.name || producer.producer.stage_id !== candidate.identity.stage_id || producer.producer.wave_id !== candidate.identity.wave_id || producer.producer.slice_id !== candidate.identity.slice_id) return false;
  if (producer.producer.iteration !== candidate.identity.loop_iteration || producer.producer.generation !== generationFor(candidate)) return false;
  if (expected === "worker" && producer.producer.kind === "worker") return producer.producer.role === assignment.role && producer.producer.slot_id === assignment.slot_id && producer.producer.agent === assignment.agent;
  if (expected === "tool" && producer.producer.kind === "tool") return stage.producer?.kind === "tool" && producer.producer.tool_name === stage.producer.tool_name;
  if (expected === "orchestrator" && producer.producer.kind === "orchestrator") return producer.producer.owner === "native-lead";
  return false;
}
function readCanonical(cwd: string, runId: string, context: TrustedExecutionContext, scope?: CtoClaimScope, identity?: WorkIdentity): CanonicalRead {
  if (!nonEmpty(runId) || context.caller !== "host" || context.authority !== "coordinator" || context.worktree !== cwd) throw new Error("native recovery requires the authenticated coordinator host");
  const state = readCtoState(runId, cwd);
  if (!state || state.id !== runId || state.branch !== context.branch) throw new Error("native canonical run is unavailable or branch-mismatched");
  const owner = currentOwner(readRunControlNoRecovery(cwd), runId, context, scope, identityForState(state, identity)?.identity);
  return { state, raw_hash: createHash("sha256").update(stateRaw(runId, cwd), "utf8").digest("hex"), revision: stateRevision(state), owner };
}
function selectionFor(cwd: string, runId: string, context: TrustedExecutionContext, scope?: CtoClaimScope, requested?: WorkIdentity): TrustedRecoverySelection {
  const current = readCanonical(cwd, runId, context, scope, requested);
  const identity = identityForState(current.state, requested)?.identity;
  if (requested && !identity) throw new Error("native recovery identity is not a canonical assignment");
  const bindingId = identity ? digest({ version: 1, authority: "cto", run_id: runId, owner_id: current.owner.owner_id, ownership_epoch: current.owner.ownership_epoch, identity }) : current.owner.binding_id;
  const proof = digest({ version: 1, authority: "cto", run_id: runId, owner_id: current.owner.owner_id, ownership_epoch: current.owner.ownership_epoch, binding_id: bindingId });
  return { authenticated: true, run_id: runId, authority: "cto", owner_id: current.owner.owner_id, ownership_epoch: current.owner.ownership_epoch, binding_id: bindingId, proof };
}
function selectionMatches(selection: TrustedRecoverySelection | undefined, snapshot: StageRecoverySnapshot, owner: CurrentOwner): boolean {
  if (!selection || selection.authenticated !== true || selection.run_id !== snapshot.run_id || selection.authority !== "cto" || selection.owner_id !== owner.owner_id || selection.ownership_epoch !== owner.ownership_epoch) return false;
  if (selection.binding_id !== undefined && selection.binding_id !== snapshot.binding_id && selection.binding_id !== owner.binding_id) return false;
  const expected = digest({ version: 1, authority: "cto", run_id: snapshot.run_id, owner_id: owner.owner_id, ownership_epoch: owner.ownership_epoch, binding_id: selection.binding_id ?? snapshot.binding_id });
  return selection.proof === expected;
}
function stateProofMatches(proof: RecoveryStateProof, snapshot: StageRecoverySnapshot): boolean {
  return proof.authenticated === true && proof.run_id === snapshot.run_id && proof.authority === "cto" && proof.revision === snapshot.revision && (!proof.digest || proof.digest === snapshot.state_proof.digest);
}
function operationFingerprint(mutation: RecoveryMutation): string {
  const value = { ...mutation, state_proof: undefined } as Record<string, unknown>;
  delete value.state_proof;
  delete value.grant;
  return digest(value);
}
function operationFor(line: StageRecoveryLineage | undefined, id: string): StageRecoveryOperationRecord | undefined {
  return line?.operations.find((entry) => entry.operation_id === id || entry.parent_operation_id === id);
}
function failure(code: string, revision?: RecoveryRevision, operation?: RecoveryOperationRecord, remaining_attempts?: number): StageRecoveryTransitionResult {
  return { ok: false, code, ...(revision === undefined ? {} : { revision }), ...(operation ? { operation } : {}), ...(remaining_attempts === undefined ? {} : { remaining_attempts }) };
}
function currentLine(snapshot: StageRecoverySnapshot, ledger: StageRecoveryLedger | undefined, state: CtoState, selected?: NativeCandidate): { key: string; line: StageRecoveryLineage } | undefined {
  if (!snapshot.identity) return undefined;
  const generation = selected ? generationFor(selected) : 0;
  const info = lineFor(ledger, snapshot.identity, generation);
  if (info.line) return { key: info.key, line: clone(info.line) };
  return {
    key: info.key,
    line: { generation, identity: clone(snapshot.identity), ...(snapshot.producer ? { producer: clone(snapshot.producer) } : {}), ...(snapshot.producer_available === undefined ? {} : { producer_available: snapshot.producer_available }), lifecycle: snapshot.lifecycle, ...(snapshot.terminal ? { terminal: clone(snapshot.terminal) } : {}), ...(snapshot.preflight ? { preflight: clone(snapshot.preflight) } : {}), ...(snapshot.error_context ? { error_context: clone(snapshot.error_context) } : {}), budgets: clone(snapshot.budgets ?? []), grants: [], operations: [], ...(snapshot.handoff ? { handoff: clone(snapshot.handoff) } : {}), ...(snapshot.cancellation ? { cancellation: clone(snapshot.cancellation) } : {}) },
  };
}
function remaining(line: StageRecoveryLineage, errorClass?: RecoveryErrorClass): number {
  if (!errorClass) return 0;
  const budget = line.budgets.find((entry) => entry.error_class === errorClass);
  const base = budget ? Math.max(0, budget.limit - budget.used) : 0;
  const grants = line.grants.filter((entry) => entry.error_class === errorClass).reduce((total, entry) => total + Math.max(0, entry.limit - entry.used), 0);
  return base + grants;
}
function grantExact(input: AuthenticatedRecoveryGrant, line: StageRecoveryLineage, owner: CurrentOwner, snapshot: StageRecoverySnapshot): StageRecoveryGrantRecord | undefined {
  const found = line.grants.find((entry) => entry.grant_id === input.grant_id);
  if (!found) return undefined;
  const currentProof = grantProofDigest(found, owner);
  if (input.authenticated !== true || input.run_id !== snapshot.run_id || input.authority !== "cto" || input.error_class !== found.error_class || input.limit !== found.limit || input.used !== found.used || input.reason !== found.reason || input.authorizer !== found.authorizer || (input.proof !== found.proof_digest && input.proof !== currentProof) || !sameScope(input.identity, found.identity)) return undefined;
  return found;
}
function consumeBudget(line: StageRecoveryLineage, input: StageRecoveryPrepareRequest, snapshot: StageRecoverySnapshot, owner: CurrentOwner, errorClass: RecoveryErrorClass): BudgetResult {
  const mutation = input.mutation;
  if (mutation.kind !== "replacement" && mutation.kind !== "format_repair") return { ok: true, line, remaining: remaining(line, errorClass) };
  if (!snapshot.identity) return { ok: false, code: "recovery_identity_unavailable" };
  const budgetLine: StageRecoveryLineage = { ...line, budgets: recoveryBudgetsForPrepare(line.budgets, errorClass) };
  if (mutation.kind === "replacement") {
    if (!mutation.proof || !stateProofMatches(mutation.state_proof, snapshot)) return { ok: false, code: "invalid_terminal_proof" };
    if ("kind" in mutation.proof && mutation.proof.kind === "preflight_not_started") {
      if (!snapshot.preflight || canonicalJson(snapshot.preflight) !== canonicalJson(mutation.proof)) return { ok: false, code: "preflight_proof_unpersisted" };
    } else {
      if ("outcome" in mutation.proof && mutation.proof.outcome === "succeeded") return { ok: false, code: "executor_not_attested_stopped" };
      if (!snapshot.terminal || canonicalJson(snapshot.terminal) !== canonicalJson(mutation.proof)) return { ok: false, code: "executor_not_attested_stopped" };
    }
  }
  if (mutation.kind === "format_repair" && !stateProofMatches(mutation.state_proof, snapshot)) return { ok: false, code: "stale_revision" };
  const grant = mutation.kind === "replacement" ? mutation.grant : undefined;
  if (grant) {
    const persisted = grantExact(grant, budgetLine, owner, snapshot);
    if (!persisted) return { ok: false, code: "grant_unpersisted" };
    if (persisted.used >= persisted.limit) return { ok: false, code: "recovery_budget_exhausted" };
    const grants = budgetLine.grants.map((entry) => entry.grant_id === persisted.grant_id ? { ...entry, used: entry.used + 1 } : entry);
    const next = { ...budgetLine, grants };
    return { ok: true, line: next, remaining: remaining(next, errorClass) };
  }
  const index = budgetLine.budgets.findIndex((entry) => entry.error_class === errorClass && entry.used < entry.limit);
  if (index < 0) return { ok: false, code: "recovery_budget_exhausted" };
  const budgets = budgetLine.budgets.map((entry, position) => position === index ? { ...entry, used: entry.used + 1 } : entry);
  const next = { ...budgetLine, budgets };
  return { ok: true, line: next, remaining: remaining(next, errorClass) };
}
function mutationErrorClass(mutation: RecoveryMutation): RecoveryErrorClass | undefined {
  return mutation.kind === "replacement" ? mutation.error_class : mutation.kind === "format_repair" ? "format_validation" : undefined;
}
function proofTerminalMatchesCurrent(mutation: RecoveryMutation, snapshot: StageRecoverySnapshot): boolean {
  if (mutation.kind !== "replacement") return true;
  const proof = mutation.proof;
  if (!snapshot.identity || !sameIdentity(proof.identity, snapshot.identity) || proof.run_id !== snapshot.run_id || proof.dispatch_id !== snapshot.identity.dispatch_id) return false;
  return proof.proof.authenticated === true && proof.proof.binding_id === snapshot.binding_id && nonEmpty(proof.proof.event_id) && nonEmpty(proof.proof.source);
}
function evidenceValid(evidence: RecoveryTransitionEvidence, request: StageRecoveryAckRequest, snapshot: StageRecoverySnapshot, operation: StageRecoveryOperationRecord): boolean {
  if (evidence.kind === "handoff_refresh") return evidence.authoritative === true && evidence.run_id === request.run_id && evidence.authority === "cto" && evidence.binding_id === snapshot.binding_id && evidence.revision === operation.revision && evidence.proof.authenticated === true && evidence.proof.run_id === request.run_id && evidence.proof.authority === "cto" && evidence.proof.revision === operation.revision;
  if (evidence.authoritative !== true || evidence.run_id !== request.run_id || !snapshot.identity || !sameIdentity(evidence.identity, snapshot.identity) || evidence.dispatch_id !== (operation.dispatch_id ?? snapshot.identity.dispatch_id)) return false;
  if (!evidence.proof || evidence.proof.authenticated !== true || evidence.proof.binding_id !== snapshot.binding_id || !nonEmpty(evidence.proof.event_id) || !nonEmpty(evidence.proof.source) || !nonEmpty(evidence.proof.observed_at)) return false;
  if (evidence.proof.state_revision !== undefined && evidence.proof.state_revision !== operation.expected_revision && evidence.proof.state_revision !== operation.revision) return false;
  return evidence.kind !== "replacement_dispatched" || Boolean(operation.replacement_identity && sameIdentity(operation.replacement_identity, evidence.new_identity));
}
function nextLineFromEvidence(line: StageRecoveryLineage, evidence: RecoveryTransitionEvidence, response: RecoveryResponsePayload, ownerEpoch: string): StageRecoveryLineage {
  if (evidence.kind === "handoff_refresh") {
    const handoff = evidence.handoff;
    return handoff ? { ...line, handoff: { status: "current", revision: handoff.revision, binding_id: handoff.binding_id, identity: clone(handoff.identity), run_id: handoff.run_id, authority: handoff.authority } } : line;
  }
  let lifecycle = line.lifecycle;
  if (evidence.kind === "running" || evidence.kind === "resume" && evidence.result === "running" || evidence.kind === "clarified" && evidence.result === "running" || evidence.kind === "format_repair" && evidence.accepted) lifecycle = "running";
  else if (evidence.kind === "disconnected" || evidence.kind === "clarified" && evidence.result === "disconnected") lifecycle = "disconnected";
  else if (evidence.kind === "terminal" || evidence.kind === "cancel_ack" || evidence.kind === "resume" && evidence.result === "terminal" || evidence.kind === "clarified" && evidence.result === "terminal" || evidence.kind === "format_repair" && !evidence.accepted) lifecycle = "terminal";
  else if (evidence.kind === "unknown" || evidence.kind === "resume" && evidence.result === "unknown" || evidence.kind === "clarified" && evidence.result === "unknown") lifecycle = "unknown";
  const lifecycleOwnerEpoch = lifecycle === "running" || lifecycle === "disconnected" || lifecycle === "unknown" ? ownerEpoch : line.lifecycle_owner_epoch;
  let next: StageRecoveryLineage = { ...line, lifecycle, ...(lifecycleOwnerEpoch ? { lifecycle_owner_epoch: lifecycleOwnerEpoch } : {}) };
  if (evidence.kind === "preflight_not_started") next = { ...next, lifecycle: "not_started", preflight: persistedClone(evidence) };
  if (evidence.kind === "terminal") next = { ...next, terminal: { authoritative: true, run_id: evidence.run_id, dispatch_id: evidence.dispatch_id, identity: clone(evidence.identity), outcome: evidence.outcome, terminal_event_id: evidence.terminal_event_id, observed_at: evidence.observed_at, proof: persistedClone(evidence.proof) } };
  if (response.error_context?.class === "format_validation") next = { ...next, error_context: { class: "format_validation", code: response.error_context.code, message: response.error_context.message, ...(response.error_context.field_errors ? { field_errors: clone(response.error_context.field_errors) } : {}) } };
  return next;
}
function responseMatches(left: RecoveryResponsePayload | undefined, right: RecoveryResponsePayload): boolean {
  return left !== undefined && canonicalJson(persistedClone(left)) === canonicalJson(persistedClone(right));
}
function evidenceMatches(left: RecoveryTransitionEvidence | undefined, right: RecoveryTransitionEvidence): boolean {
  return left !== undefined && canonicalJson(persistedClone(left)) === canonicalJson(persistedClone(right));
}
function replacementIdentityFor(state: CtoState, identity: WorkIdentity, owner: CurrentOwner, operationId: string): WorkIdentity | undefined {
  const progress = Object.values(state.native_stage_progress ?? {}).find((entry) => Object.values(entry.assignments).some((assignment) => sameIdentity(assignment.identity, identity)));
  if (!progress) return undefined;
  const attempts = Object.values(progress.assignments).filter((assignment) => sameScope(assignment.identity, identity)).map((assignment) => assignment.identity.attempt);
  const workerId = `cto:${owner.ownership_epoch}:recovery-${digest({ version: 1, run_id: identity.run_id, operation_id: operationId, retry_of: identity.dispatch_id }).slice(0, 32)}:0`;
  if (workerId === identity.worker_id) return undefined;
  return { ...clone(identity), dispatch_id: randomUUID(), attempt: Math.max(identity.attempt, ...attempts, 0) + 1, worker_id: workerId };
}
function writeRecoveryLedger(cwd: string, state: CtoState, ledger: StageRecoveryLedger): void {
  writeCtoState(stateWithLedger(state, ledger), cwd);
}
function transitionIdentity(input: StageRecoveryTransitionRequest): WorkIdentity | undefined {
  if (input.phase === "ack") return input.evidence.identity;
  if (input.phase === "prepare") return input.mutation.state_proof.identity ?? (input.mutation.kind === "replacement" ? input.mutation.proof.identity : undefined);
  return undefined;
}
function operationLocated(ledger: StageRecoveryLedger | undefined, operationId: string): StageRecoveryOperationRecord | undefined {
  for (const line of Object.values(ledger?.lineages ?? {})) {
    const operation = operationFor(line, operationId);
    if (operation) return operation;
  }
  return undefined;
}
function terminalEvidenceReconciled(state: CtoState, evidence: Extract<RecoveryTransitionEvidence, { kind: "terminal" }>): boolean {
  const selected = identityForState(state, evidence.identity);
  return Boolean(selected?.identity && selected.assignment && sameIdentity(selected.assignment.identity, evidence.identity) && selected.assignment.status === "terminal");
}

function transitionNative(cwd: string, context: TrustedExecutionContext, scope: CtoClaimScope | undefined, input: StageRecoveryTransitionRequest): StageRecoveryTransitionResult {
  let canonical: CanonicalRead;
  const requestedIdentity = transitionIdentity(input);
  try { canonical = readCanonical(cwd, input.run_id, context, scope, requestedIdentity); } catch { return failure("recovery_authority_denied"); }
  const selected = identityForState(canonical.state, requestedIdentity);
  const snapshot = snapshotFromRead({ cwd, run_id: input.run_id, state: canonical.state, raw_hash: canonical.raw_hash, revision: canonical.revision, owner: canonical.owner, identity: requestedIdentity ?? selected?.identity });
  if (input.run_id !== canonical.state.id || input.authority !== "cto") return failure("recovery_authority_denied", snapshot.revision);
  if ((input.phase === "prepare" || input.phase === "ack") && !selectionMatches(input.selection, snapshot, canonical.owner)) return failure("recovery_authority_denied", snapshot.revision);
  if (input.phase === "replay" && input.selection && !selectionMatches(input.selection, snapshot, canonical.owner)) return failure("recovery_authority_denied", snapshot.revision);
  const ledger = stateLedger(canonical.state);
  const lineInfo = currentLine(snapshot, ledger, canonical.state, selected);
  if (input.phase === "replay") {
    const operation = operationLocated(ledger, input.operation_id) ?? operationFor(lineInfo?.line, input.operation_id);
    const materialized = operation ? materializeOperation(operation, snapshot.revision, snapshot.state_proof, snapshot.terminal, snapshot.preflight) : undefined;
    return materialized ? { ok: true, revision: snapshot.revision, operation: materialized, state_proof: snapshot.state_proof } : failure("operation_not_found", snapshot.revision);
  }
  if (input.expected_revision !== snapshot.revision) return failure("stale_revision", snapshot.revision);
  if (!lineInfo) return failure("recovery_identity_unavailable", snapshot.revision);
  const nextRevision = canonical.revision + 1;
  if (input.phase === "prepare") {
    const mutationDigest = operationFingerprint(input.mutation);
    const existing = operationFor(lineInfo.line, input.operation_id);
    if (existing) {
      if (existing.mutation_digest !== mutationDigest || existing.run_id !== input.run_id || existing.authority !== input.authority) return failure("operation_conflict", snapshot.revision, existing);
      return { ok: true, revision: snapshot.revision, operation: existing, state_proof: snapshot.state_proof, remaining_attempts: remaining(lineInfo.line, existing.error_class) };
    }
    if (input.parent_operation_id && !operationFor(lineInfo.line, input.parent_operation_id)) return failure("parent_operation_not_found", snapshot.revision);
    if (input.mutation.kind === "replacement") {
      if (!proofTerminalMatchesCurrent(input.mutation, snapshot)) return failure("executor_not_attested_stopped", snapshot.revision);
      const retryOf = input.mutation.retry_of;
      const linked = lineInfo.line.operations.find((entry) => entry.retry_of === retryOf && entry.operation_id !== input.operation_id && (entry.action === "replace" || entry.action === "retry"));
      if (linked) return failure("operation_conflict", snapshot.revision, linked);
    }
    const errorClass = mutationErrorClass(input.mutation);
    let consumed: BudgetResult = { ok: true, line: lineInfo.line, remaining: remaining(lineInfo.line, errorClass) };
    if (errorClass) consumed = consumeBudget(lineInfo.line, input, snapshot, canonical.owner, errorClass);
    if (!consumed.ok) return failure(consumed.code, snapshot.revision, undefined, remaining(lineInfo.line, errorClass));
    const replacementIdentity = input.mutation.kind === "replacement" ? replacementIdentityFor(canonical.state, snapshot.identity!, canonical.owner, input.operation_id) : undefined;
    if (input.mutation.kind === "replacement" && !replacementIdentity) return failure("replacement_identity_unavailable", snapshot.revision);
    const action: RecoveryAction = input.mutation.kind === "host_action" ? input.mutation.action : input.mutation.kind === "handoff_refresh" ? input.mutation.action : input.mutation.kind === "format_repair" ? "repair_format" : "replace";
    const operation: StageRecoveryOperationRecord = {
      operation_id: input.operation_id,
      ...(input.parent_operation_id ? { parent_operation_id: input.parent_operation_id } : {}),
      run_id: input.run_id,
      authority: "cto",
      action,
      status: "prepared",
      ...(input.mutation.kind === "host_action" && input.mutation.dispatch_id ? { dispatch_id: input.mutation.dispatch_id } : {}),
      ...(input.mutation.kind === "replacement" ? { dispatch_id: input.mutation.dispatch_id ?? snapshot.identity!.dispatch_id, replacement_identity: replacementIdentity!, admission: { state: "ready" as const }, retry_of: input.mutation.retry_of, error_class: input.mutation.error_class, ...(input.mutation.producer_correction ? { producer_correction: true } : {}) } : input.mutation.kind === "format_repair" ? { dispatch_id: input.mutation.dispatch_id, error_class: input.mutation.error_class } : input.mutation.kind !== "host_action" && errorClass ? { error_class: errorClass } : {}),
      expected_revision: snapshot.revision,
      revision: nextRevision,
      mutation_digest: mutationDigest,
    };
    const nextLine: StageRecoveryLineage = { ...consumed.line, operations: [...consumed.line.operations, operation] };
    const nextLedger: StageRecoveryLedger = { schema_version: STAGE_RECOVERY_SCHEMA_VERSION, lineages: { ...(ledger?.lineages ?? {}), [lineInfo.key]: nextLine } };
    try { writeRecoveryLedger(cwd, canonical.state, nextLedger); } catch { return failure("stale_revision", snapshot.revision); }
    return { ok: true, revision: nextRevision, operation, state_proof: { authenticated: true, source: "cto-canonical-state", run_id: input.run_id, authority: "cto", revision: nextRevision }, remaining_attempts: consumed.remaining };
  }
  const existing = operationFor(lineInfo.line, input.operation_id);
  if (!existing) return failure("operation_not_found", snapshot.revision);
  if (existing.status === "acked") {
    if (!responseMatches(existing.response, input.response) || !evidenceMatches(existing.evidence, input.evidence)) return failure("operation_conflict", snapshot.revision, existing);
    return { ok: true, revision: snapshot.revision, operation: existing, state_proof: snapshot.state_proof };
  }
  if (input.evidence.kind === "terminal" && !terminalEvidenceReconciled(canonical.state, input.evidence)) return failure("terminal_reconciliation_pending", snapshot.revision, existing);
  if (input.evidence.kind === "handoff_refresh" && !input.evidence.handoff) return failure("handoff_unissued", snapshot.revision, existing);
  const acked: StageRecoveryOperationRecord = { ...existing, status: "acked", revision: nextRevision, response: persistedClone(input.response), evidence: persistedClone(input.evidence) };
  const nextLine = nextLineFromEvidence({ ...lineInfo.line, operations: lineInfo.line.operations.map((entry) => entry.operation_id === existing.operation_id ? acked : entry) }, input.evidence, input.response, canonical.owner.ownership_epoch);
  const nextLedger: StageRecoveryLedger = { schema_version: STAGE_RECOVERY_SCHEMA_VERSION, lineages: { ...(ledger?.lineages ?? {}), [lineInfo.key]: nextLine } };
  try { writeRecoveryLedger(cwd, canonical.state, nextLedger); } catch { return failure("stale_revision", snapshot.revision, existing); }
  return { ok: true, revision: nextRevision, operation: acked, state_proof: { authenticated: true, source: "cto-canonical-state", run_id: input.run_id, authority: "cto", revision: nextRevision }, ...(nextLine.handoff && nextLine.handoff.status === "current" && input.evidence.kind === "handoff_refresh" ? { handoff: input.evidence.handoff } : {}) };
}

function makeGrantProof(): RecoveryGrantAuthorizationProof {
  return Object.freeze({}) as RecoveryGrantAuthorizationProof;
}
function trustedHandoffFromSnapshot(snapshot: StageRecoverySnapshot): TrustedRecoveryHandoff | undefined {
  const ownership = snapshot.ownership;
  const bindingId = snapshot.binding_id;
  if (!snapshot.identity || !ownership || !nonEmpty(bindingId) || snapshot.authority !== "cto" || snapshot.state_proof.revision !== snapshot.revision || snapshot.state_proof.run_id !== snapshot.run_id || snapshot.state_proof.authority !== "cto" || snapshot.state_proof.authenticated !== true) return undefined;
  return {
    run_id: snapshot.run_id,
    authority: snapshot.authority,
    revision: snapshot.revision,
    binding_id: bindingId,
    identity: clone(snapshot.identity),
    owner_id: ownership.owner_id,
    ownership_epoch: ownership.ownership_epoch,
    proof: clone(snapshot.state_proof),
  };
}

function currentHandoffFailure(error: unknown): CurrentRecoveryHandoffResult {
  const message = String(error);
  if (message.includes("branch-mismatched")) return { ok: false, code: "recovery_branch_mismatch" };
  if (message.includes("canonical run is unavailable")) return { ok: false, code: "recovery_run_unavailable" };
  if (message.includes("authenticated") || message.includes("coordinator")) return { ok: false, code: "recovery_foreign_owner" };
  return { ok: false, code: "recovery_state_corrupt" };
}
export function createNativeStageRecoveryStore(cwd: string, options: NativeStageRecoveryStoreOptions): NativeStageRecoveryStore {
  const context: TrustedExecutionContext = {
    session_id: options.context.session_id,
    caller: options.context.caller,
    ...(options.context.process_id === undefined ? {} : { process_id: options.context.process_id }),
    worktree: options.context.worktree,
    branch: options.context.branch,
    authority: options.context.authority,
  };
  const runId = options.runId;
  const scope = options.claim_scope;
  const activeProofs = new WeakMap<object, { expected_revision: RecoveryRevision; selection: TrustedRecoverySelection; identity: WorkIdentity }>();
  const selection = (identity?: WorkIdentity): TrustedRecoverySelection => selectionFor(cwd, runId, context, scope, identity);
  const captureGrantAuthorization = (input: StageRecoveryGrantAuthorizationInput): RecoveryGrantAuthorizationProof => {
    const current = readCanonical(cwd, runId, context, scope, input.identity);
    const snapshot = snapshotFromRead({ cwd, run_id: runId, state: current.state, raw_hash: current.raw_hash, revision: current.revision, owner: current.owner, identity: input.identity });
    if (!snapshot.identity || input.expected_revision !== snapshot.revision || !selectionMatches(input.selection, snapshot, current.owner)) throw new Error("grant authorization is stale or not owned by the current CTO");
    const proof = makeGrantProof();
    activeProofs.set(proof as object, { expected_revision: input.expected_revision, selection: clone(input.selection), identity: clone(snapshot.identity) });
    return proof;
  };
  const commitGrant = (input: StageRecoveryGrantCommitInput): StageRecoveryGrantCommitResult => {
    const captured = activeProofs.get(input.proof as object);
    if (!captured || captured.expected_revision !== input.expected_revision || canonicalJson(captured.selection) !== canonicalJson(input.selection) || !sameIdentity(captured.identity, input.identity)) return { ok: false, code: "grant_proof_invalid" };
    let current: CanonicalRead;
    try { current = readCanonical(cwd, runId, context, scope, input.identity); } catch { return { ok: false, code: "recovery_authority_denied" }; }
    const snapshot = snapshotFromRead({ cwd, run_id: runId, state: current.state, raw_hash: current.raw_hash, revision: current.revision, owner: current.owner, identity: input.identity });
    if (snapshot.revision !== input.expected_revision || !selectionMatches(input.selection, snapshot, current.owner) || !snapshot.identity || !sameIdentity(snapshot.identity, input.identity)) return { ok: false, code: "stale_revision", revision: snapshot.revision };
    if (!Number.isSafeInteger(input.limit) || input.limit < 1 || !nonEmpty(input.grant_id) || !nonEmpty(input.reason) || !nonEmpty(input.authorizer)) return { ok: false, code: "invalid_grant", revision: snapshot.revision };
    const ledger = stateLedger(current.state);
    const lineInfo = currentLine(snapshot, ledger, current.state, identityForState(current.state, input.identity));
    if (!lineInfo) return { ok: false, code: "recovery_identity_unavailable", revision: snapshot.revision };
    const existing = lineInfo.line.grants.find((entry) => entry.grant_id === input.grant_id);
    const proofDigest = digest({ version: 1, run_id: runId, authority: "cto", grant_id: input.grant_id, owner_id: current.owner.owner_id, ownership_epoch: current.owner.ownership_epoch, error_class: input.error_class, identity: input.identity, limit: input.limit, reason: input.reason, authorizer: input.authorizer });
    if (existing) {
      if (existing.error_class !== input.error_class || existing.limit !== input.limit || existing.reason !== input.reason || existing.authorizer !== input.authorizer || existing.proof_digest !== proofDigest || !sameIdentity(existing.identity, input.identity)) return { ok: false, code: "grant_conflict", revision: snapshot.revision };
      activeProofs.delete(input.proof as object);
      return { ok: true, grant: grantSnapshot(existing, current.owner), revision: snapshot.revision, state_proof: snapshot.state_proof };
    }
    const grant: StageRecoveryGrantRecord = { grant_id: input.grant_id, run_id: runId, authority: "cto", owner_id: current.owner.owner_id, ownership_epoch: current.owner.ownership_epoch, error_class: input.error_class, identity: clone(input.identity), limit: input.limit, used: 0, reason: input.reason, authorizer: input.authorizer, proof_digest: proofDigest };
    const nextLine: StageRecoveryLineage = { ...lineInfo.line, grants: [...lineInfo.line.grants, grant] };
    const nextLedger: StageRecoveryLedger = { schema_version: STAGE_RECOVERY_SCHEMA_VERSION, lineages: { ...(ledger?.lineages ?? {}), [lineInfo.key]: nextLine } };
    try { writeRecoveryLedger(cwd, current.state, nextLedger); } catch { return { ok: false, code: "stale_revision", revision: snapshot.revision }; }
    activeProofs.delete(input.proof as object);
    return { ok: true, grant: grantSnapshot(grant, current.owner), revision: current.revision + 1, state_proof: { authenticated: true, source: "cto-canonical-state", run_id: runId, authority: "cto", revision: current.revision + 1 } };
  };
  const recordFormatValidation = (input: StageRecoveryFormatValidationInput): StageRecoveryFormatValidationResult => {
    if (input.run_id !== runId || input.authority !== "cto") return { ok: false, code: "recovery_authority_denied" };
    if (!formatValidationContextValid(input.error_context) || !formatValidationProducerValid(input.producer, input.authority, input.identity)) return { ok: false, code: "invalid_format_validation" };
    let current: CanonicalRead;
    try { current = readCanonical(cwd, runId, context, scope, input.identity); } catch { return { ok: false, code: "recovery_authority_denied" }; }
    const selected = identityForState(current.state, input.identity);
    const snapshot = snapshotFromRead({ cwd, run_id: runId, state: current.state, raw_hash: current.raw_hash, revision: current.revision, owner: current.owner, identity: input.identity });
    if (snapshot.revision !== input.expected_revision || !selectionMatches(input.selection, snapshot, current.owner)) return { ok: false, code: "stale_revision", revision: snapshot.revision };
    if (!snapshot.identity || !selected?.identity || !sameIdentity(snapshot.identity, input.identity) || !sameIdentity(selected.identity, input.identity) || !input.state_proof.identity || !sameIdentity(input.state_proof.identity, input.identity) || input.state_proof.dispatch_id !== input.identity.dispatch_id || !stateProofMatches(input.state_proof, snapshot)) return { ok: false, code: "stale_revision", revision: snapshot.revision };
    if (!nativeProducerKindMatches(selected, input.producer)) return { ok: false, code: "invalid_format_validation", revision: snapshot.revision };
    const ledger = stateLedger(current.state);
    const lineInfo = currentLine(snapshot, ledger, current.state, selected);
    if (!lineInfo) return { ok: false, code: "recovery_identity_unavailable", revision: snapshot.revision };
    const persistedLine = ledger?.lineages[lineInfo.key];
    const existing = persistedLine?.error_context;
    const existingProducer = persistedLine?.producer;
    if (existingProducer && canonicalJson(existingProducer) !== canonicalJson(input.producer)) return { ok: false, code: "format_validation_conflict", revision: snapshot.revision };
    if (existing) {
      if (canonicalJson(existing) !== canonicalJson(input.error_context)) return { ok: false, code: "format_validation_conflict", revision: snapshot.revision };
      return { ok: true, revision: snapshot.revision, state_proof: snapshot.state_proof, error_context: clone(input.error_context) };
    }
    const baseLine = persistedLine ?? { ...lineInfo.line, budgets: [], grants: [], operations: [] };
    const nextLine: StageRecoveryLineage = {
      ...baseLine,
      producer: clone(input.producer),
      producer_available: snapshot.lifecycle === "terminal" ? false : true,
      error_context: clone(input.error_context),
    };
    const nextLedger: StageRecoveryLedger = { schema_version: STAGE_RECOVERY_SCHEMA_VERSION, lineages: { ...(ledger?.lineages ?? {}), [lineInfo.key]: nextLine } };
    try { writeRecoveryLedger(cwd, current.state, nextLedger); } catch { return { ok: false, code: "stale_revision", revision: snapshot.revision }; }
    const nextRevision = current.revision + 1;
    const { digest: _digest, ...proofWithoutDigest } = snapshot.state_proof;
    return { ok: true, revision: nextRevision, state_proof: { ...proofWithoutDigest, revision: nextRevision, observed_at: new Date().toISOString() }, error_context: clone(input.error_context) };
  };
  const read = (input: { run_id: string; authority: RecoveryAuthority; identity?: WorkIdentity; selection?: TrustedRecoverySelection }): StageRecoverySnapshot => {
    if (input.run_id !== runId || input.authority !== "cto") throw new Error("native recovery store received a foreign authority or run");
    const current = readCanonical(cwd, runId, context, scope, input.identity);
    const snapshot = snapshotFromRead({ cwd, run_id: runId, state: current.state, raw_hash: current.raw_hash, revision: current.revision, owner: current.owner, identity: input.identity });
    if (input.selection && !selectionMatches(input.selection, snapshot, current.owner)) throw new Error("native recovery selection is stale or not owned by the current CTO");
    return snapshot;
  };
  const readCurrentHandoff = (input: CurrentRecoveryHandoffInput): CurrentRecoveryHandoffResult => {
    if (input.run_id !== runId) return { ok: false, code: "recovery_foreign_run" };
    try {
      const current = readCanonical(cwd, runId, context, scope, input.identity);
      const snapshot = snapshotFromRead({ cwd, run_id: runId, state: current.state, raw_hash: current.raw_hash, revision: current.revision, owner: current.owner, identity: input.identity });
      if (input.selection && !selectionMatches(input.selection, snapshot, current.owner)) return { ok: false, code: "recovery_foreign_owner", revision: snapshot.revision };
      if (input.identity && !snapshot.identity) return { ok: false, code: "recovery_foreign_assignment", revision: snapshot.revision };
      const handoff = trustedHandoffFromSnapshot(snapshot);
      const candidate = identityForState(current.state, input.identity);
      const stageCursor = candidate?.progress?.stage_cursor ?? activeWave(current.state)?.work_identity?.stage_cursor;
      const metadata = { begin_required: true as const, ...(stageCursor ? { stage_cursor: stageCursor } : {}), generation: 0 };
      return handoff ? { ok: true, revision: snapshot.revision, handoff } : { ok: false, code: "handoff_unavailable", revision: snapshot.revision, ...metadata };
    } catch (error) {
      return currentHandoffFailure(error);
    }
  };
  const transition = (input: StageRecoveryTransitionRequest): StageRecoveryTransitionResult => {
    if (input.run_id !== runId || input.authority !== "cto") return failure("recovery_authority_denied");
    return transitionNative(cwd, context, scope, input);
  };
  return { read, transition, selection, captureGrantAuthorization, commitGrant, recordFormatValidation, consumePreparedRecoveryAdmission, readCurrentHandoff };
}
