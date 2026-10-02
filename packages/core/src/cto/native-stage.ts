import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

import { parseExpression } from "../engine/predicate.js";
import { resolveAgentForRole, resolveConfig } from "../engine/config.js";
import { consumePreparedRecoveryAdmission, migrateStageRecoveryLedger, STAGE_RECOVERY_FIELD, type StageRecoveryLedger } from "../engine/stage-recovery-store.js";
import { teamDoDComplete } from "./gates.js";
import { loopExhaustionKind, loopReentryDecision, resolveBackToStage } from "../engine/loops.js";
import { isRecord, validateWorkIdentityValue } from "../engine/control-plane-contract.js";
import { isSafeArtifactId, readArtifactFileSafe } from "../engine/artifacts.js";
import { resolveScope, type ScopeFlags } from "../engine/scope.js";
import { resolveStageDispatchSlots } from "../engine/stage.js";
import { loadProfile, profileHash, resolveProfileControlPlane } from "../engine/profile.js";
import type { CtoClaimScope, DispatchSlot, Profile, StageDef, StageReceiptLedger, TeamState, TrustedExecutionContext, WorkIdentity, WorkflowName } from "../engine/types.js";
import { readRunControlHeldLock, readRunControlNoRecovery } from "../engine/run-store.js";
import { activeWave, ctoStatePath, readCtoState, writeCtoState } from "./state.js";
import { withWorkspaceReadNoRecovery, withWorkspaceTransaction } from "../engine/state.js";
import type {
  CtoState,
  NativeStageApproval,
  NativeStageAssignment,
  NativeStagePreflightTerminalSignal,
  NativeStageProgress,
  NativeStageSlotDeclaration,
} from "./types.js";
import type { NativeWorkerResolution } from "../native-worker-authority.js";
type NativeCtoTeam = CtoState["teams"][number];

export type NativeStageActor = "lead" | "worker";

export interface NativeStageBindingLike {
  resolution: NativeWorkerResolution;
  session_id: string;
  agent: string;
  assigned_identity?: WorkIdentity;
}

export interface NativeStageProducerDescriptor {
  kind: "orchestrator" | "worker" | "tool";
  identity: WorkIdentity;
  role: string;
  agent: string;
  profile: WorkflowName;
  stage_id: string;
  iteration: number;
  generation: number;
  wave_id: string;
  slice_id: string;
  tool_name?: string;
}

export interface NativeStageAdmissionItem {
  index: number;
  agent: string;
  worker_id: string;
}
type NativeStageRecoveryReservation = {
  operation_id: string;
  retry_of: string;
  generation: number;
  original: WorkIdentity;
  replacement_identity: WorkIdentity;
};

type NativeStageClaimReservation = {
  reserve: (input: {
    worker_ids: readonly string[];
    recovery_permits: readonly NativeStageRecoveryReservation[];
  }) => readonly string[];
  settle: (worker_ids: readonly string[]) => void;
};



export interface NativeStageAdmissionRequest {
  cwd: string;
  runId: string;
  teamId: string;
  sliceId: string;
  actor: NativeStageActor;
  lead: string;
  roster: readonly string[];
  toolCallId: string;
  ownershipEpoch: string;
  parentSessionId: string;
  items: readonly NativeStageAdmissionItem[];
  /** Private host-only claim reservation bridge; never accepted from model input. */
  claim_reservation?: NativeStageClaimReservation;
  /** Private host rejection path; never accepted from model-facing input. */
  preflight_terminal_signal?: NativeStagePreflightTerminalSignal;
}

export type NativeStageAdmissionResult =
  | { ok: true; identities: WorkIdentity[]; progress: NativeStageProgress }
  | { ok: false; code: string; error: string };
type NativeStageAdmissionPlan = {
  result: NativeStageAdmissionResult;
  worker_ids: readonly string[];
  recovery_permits: readonly NativeStageRecoveryReservation[];
  recovery_ledger?: StageRecoveryLedger;
  changed: boolean;
};



export type NativeStageReadiness =
  | {
    ok: true;
    ready: boolean;
    stage_id: string;
    missing: string[];
    progress: NativeStageProgress;
  }
  | { ok: false; code: string; error: string };

export type NativeStageMutationResult =
  | { ok: true; progress: NativeStageProgress }
  | { ok: false; code: string; error: string };
export interface NativeStageWorkerTerminalAuthority {
  readonly run_id: string;
  readonly claim_token: string;
  readonly ownership_epoch: string;
  readonly coordinator_session_id: string;
  readonly coordinator_process_id?: number;
  readonly dispatch_id: string;
  readonly worker_id: string;
}

export type NativeStageWorkerTerminalSettlement =
  | { readonly ok: true; readonly worker_terminal_required: boolean; readonly changed: boolean }
  | { readonly ok: false; readonly code: string; readonly error: string };


export interface NativeStageCheckpointAuthority {
  run_id: string;
  coordinator_session_id: string;
  ownership_epoch: string;
  coordinator_process_id?: number;
  team_id: string;
}

export interface NativeStageCheckpointPreflight {
  run_id: string;
  team_id: string;
  stage_id: string;
  iteration: number;
  revision: number;
  state_revision: string;
  ownership_epoch: string;
  checkpoint: string;
  phase: "before_dispatch" | "before_advance";
  default: "required_human" | "autonomous_allowed";
  allowed_decisions: string[];
  profile_hash: string;
  receipt_digest: string;
  accepted_dispatch_ids: string[];
  identity_scope: {
    wave_id: string;
    slice_id: string;
    capability_id: string;
    capability_epoch: string;
    declared_outputs: string[];
    declared_slots: NativeStageSlotDeclaration[];
  };
  current_approval?: NativeStageApproval;
}

export type NativeStageCheckpointPreflightResult =
  | { ok: true; preflight: NativeStageCheckpointPreflight }
  | { ok: false; code: string; error: string };

export interface NativeStageCheckpointCommitInput {
  cwd: string;
  runId: string;
  teamId: string;
  authority: NativeStageCheckpointAuthority;
  witness: NativeStageCheckpointPreflight;
  expected_revision: number;
  approval_id: string;
  decision: string;
  source: "human" | "policy-auto";
}

export interface NativeStageAdvanceRequest {
  cwd: string;
  runId: string;
  sliceId: string;
  coordinator_session_id: string;
  ownership_epoch: string;
  coordinator_process_id?: number;
  operation_id: string;
}

export type NativeStageCheckpointCommitResult =
  | { ok: true; progress: NativeStageProgress; approval: NativeStageApproval }
  | { ok: false; code: string; error: string };

type NativeStageFailure = { ok: false; code: string; error: string };

function fail(code: string, error: string): NativeStageFailure {
  return { ok: false, code, error };
}

function safeNativeId(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex").slice(0, 32);
}

function now(): string {
  return new Date().toISOString();
}

function stateRevision(cwd: string, runId: string): string | undefined {
  try {
    return createHash("sha256").update(readFileSync(ctoStatePath(runId, cwd), "utf8"), "utf8").digest("hex");
  } catch {
    return undefined;
  }
}

function acceptedReceiptDigest(state: CtoState, progress: NativeStageProgress): string {
  const receipts = Object.values(progress.assignments)
    .map((assignment) => ({ assignment, receipt: state.stage_receipts?.[assignment.identity.dispatch_id] }))
    .filter((entry): entry is { assignment: NativeStageAssignment; receipt: NonNullable<CtoState["stage_receipts"]>[string] } => entry.receipt !== undefined && sameIdentity(entry.receipt.work_identity, entry.assignment.identity))
    .map(({ receipt }) => ({
      receipt_id: receipt.receipt_id,
      dispatch_id: receipt.dispatch_id,
      attempt: receipt.attempt,
      digest: receipt.digest,
      work_identity: receipt.work_identity,
      binding: receipt.binding,
      outputs: receipt.outputs,
      evidence: receipt.evidence,
    }))
    .sort((left, right) => left.dispatch_id.localeCompare(right.dispatch_id));
  return createHash("sha256").update(JSON.stringify(receipts), "utf8").digest("hex");
}

function teamFor(state: CtoState, teamId: string): CtoState["teams"][number] | undefined {
  return state.teams.find((team) => team.id === teamId);
}

function planFor(state: CtoState, teamId: string): CtoState["plan"]["teams"][number] | undefined {
  return state.plan.teams.find((team) => team.team === teamId);
}

function profileForTeam(cwd: string, team: NativeCtoTeam): { profile: Profile; hash: string } | { error: string } {
  if (!team.workflow) return { error: `team '${team.id}' has no resolved workflow` };
  const profile = loadProfile(team.workflow as WorkflowName);
  if (!profile) return { error: `workflow profile '${team.workflow}' is unavailable` };
  try {
    const control = resolveProfileControlPlane(profile, undefined);
    if (!control) return { error: `workflow profile '${team.workflow}' has no control-plane policy` };
  } catch (error) {
    return { error: `workflow profile '${team.workflow}' is invalid: ${error instanceof Error ? error.message : String(error)}` };
  }
  return { profile, hash: profileHash(profile) };
}

function stageForProgress(profile: Profile, progress: NativeStageProgress | undefined, team: NativeCtoTeam): StageDef | undefined {
  const requested = progress?.stage_id ?? team.work_identity?.stage_id ?? profile.stages[0]?.id;
  return profile.stages.find((stage) => stage.id === requested);
}

function flagsForTeam(cwd: string, state: CtoState, teamId: string): ScopeFlags {
  const config = resolveConfig(cwd);
  const plan = planFor(state, teamId);
  const scopes = plan?.scope ?? [];
  const lower = scopes.map((scope) => scope.toLowerCase());
  const has = (needle: string): boolean => lower.some((scope) => scope.includes(needle));
  const selectedDevAgent = scopes
    .map((scope) => config.scope_map.find((entry) => entry.scope === scope)?.dev_agent)
    .find((agent): agent is string => typeof agent === "string" && agent.length > 0);
  const base = resolveScope([], config);
  return {
    ...base,
    scope: [...scopes],
    dev_agent: selectedDevAgent ?? base.dev_agent,
    has_security: base.has_security || has("security"),
    has_infra: base.has_infra || has("infra") || has("ops"),
    has_ui: base.has_ui || has("ui") || has("frontend"),
    has_runtime: base.has_runtime || has("runtime") || has("backend"),
  };
}

function resolveSlots(cwd: string, state: CtoState, teamId: string, stage: StageDef): NativeStageSlotDeclaration[] | { error: string } {
  const config = resolveConfig(cwd);
  const flags = flagsForTeam(cwd, state, teamId);
  let slots: DispatchSlot[];
  try {
    slots = resolveStageDispatchSlots(stage, { cwd, flags, resolveDevAgent: () => flags.dev_agent });
  } catch (error) {
    return { error: `stage '${stage.id}' roster cannot be resolved: ${error instanceof Error ? error.message : String(error)}` };
  }
  return slots.map((slot, index) => ({
    slot_id: slot.slot_id ?? slot.slot,
    role: slot.role,
    agent: resolveAgentForRole(slot.role, config),
    occurrence: slot.occurrence ?? index + 1,
    ...(slot.facet === undefined ? {} : { facet: slot.facet }),
  }));
}

function outputIds(stage: StageDef): string[] {
  const values = stage.produces === undefined ? [] : Array.isArray(stage.produces) ? stage.produces : [stage.produces];
  return [...new Set(values.filter((value): value is string => typeof value === "string" && isSafeArtifactId(value)))];
}
type NativeArtifactReference = {
  immutable_ref: string;
  sha256: string;
};

function nativeArtifactBytes(cwd: string, runId: string, output: NativeArtifactReference): Buffer | null {
  if (!output.immutable_ref || output.immutable_ref.startsWith("/") || output.immutable_ref.split(/[\\/]/).includes("..")) return null;
  const root = join(dirname(ctoStatePath(runId, cwd)), "artifacts");
  const raw = readArtifactFileSafe(root, output.immutable_ref);
  if (raw.status !== "present" || createHash("sha256").update(raw.bytes).digest("hex") !== output.sha256) return null;
  return raw.bytes;
}
function loopStageIdsForProfile(profile: Profile): Set<string> {
  const ids = new Set<string>();
  for (const owner of profile.stages) {
    if (!owner.loop) continue;
    const backTo = resolveBackToStage(profile, owner.loop.back_to);
    if (!backTo) continue;
    const ownerIndex = profile.stages.findIndex((stage) => stage.id === owner.id);
    const backToIndex = profile.stages.findIndex((stage) => stage.id === backTo.id);
    if (ownerIndex < 0 || backToIndex < 0) continue;
    for (let index = Math.min(ownerIndex, backToIndex); index <= Math.max(ownerIndex, backToIndex); index += 1) {
      ids.add(profile.stages[index]!.id);
    }
  }
  return ids;
}

function nativeReceiptGeneration(receipt: { binding?: unknown }): number | undefined {
  if (!receipt.binding || typeof receipt.binding !== "object" || Array.isArray(receipt.binding)) return undefined;
  const producer = (receipt.binding as Record<string, unknown>).producer;
  if (!producer || typeof producer !== "object" || Array.isArray(producer)) return undefined;
  const generation = (producer as Record<string, unknown>).generation;
  return typeof generation === "number" && Number.isSafeInteger(generation) && generation >= 0 ? generation : undefined;
}


function nativeArtifactValue(cwd: string, runId: string, state: CtoState, teamId: string, artifactId: string): unknown | null {
  const progress = state.native_stage_progress?.[teamId];
  if (!progress) return null;
  const profile = loadProfile(progress.workflow);
  const loopStageIds = profile ? loopStageIdsForProfile(profile) : new Set<string>();
  const consumerInLoop = loopStageIds.has(progress.stage_id);
  const generation = nativeStageGeneration(state);
  const receipts = state.stage_receipts ?? {};
  const currentAssignments = Object.values(progress.assignments)
    .filter((assignment) => assignment.status === "accepted" || assignment.status === "terminal");
  const currentDispatchIds = new Set(Object.keys(progress.assignments));
  const currentReceipts = [...currentAssignments]
    .reverse()
    .map((assignment) => receipts[assignment.identity.dispatch_id])
    .filter((receipt): receipt is NonNullable<typeof receipt> => receipt !== undefined)
    .filter((receipt) => {
      const assignment = progress.assignments[receipt.dispatch_id];
      return assignment !== undefined && sameIdentity(receipt.work_identity, assignment.identity);
    });
  const historicalReceipts = Object.values(receipts)
    .map((receipt, index) => ({ receipt, index }))
    .filter(({ receipt }) => {
      if (currentDispatchIds.has(receipt.dispatch_id)) return false;
      const identity = receipt.work_identity;
      const sameScope = identity.run_id === state.id
        && identity.workflow === progress.workflow
        && identity.wave_id === progress.wave_id
        && identity.slice_id === progress.slice_id;
      const sourceInLoop = loopStageIds.has(identity.stage_id);
      const sameIteration = identity.loop_iteration === progress.iteration;
      const iterationAllowed = !consumerInLoop || !sourceInLoop || sameIteration;
      return sameScope
        && iterationAllowed
        && nativeReceiptGeneration(receipt) === generation;
    })
    .sort((left, right) => {
      const leftIteration = left.receipt.work_identity.loop_iteration ?? 1;
      const rightIteration = right.receipt.work_identity.loop_iteration ?? 1;
      return rightIteration - leftIteration
        || right.index - left.index
        || right.receipt.dispatch_id.localeCompare(left.receipt.dispatch_id);
    })
    .map(({ receipt }) => receipt);
  for (const receipt of [...currentReceipts, ...historicalReceipts]) {
    const output = receipt.outputs.find((entry) => entry.artifact_id === artifactId);
    if (!output) continue;
    const raw = nativeArtifactBytes(cwd, runId, output);
    if (!raw) return null;
    try {
      return JSON.parse(raw.toString("utf8"));
    } catch {
      return null;
    }
  }
  return null;
}

function nativeEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) && Array.isArray(right)) return left.length === right.length && left.every((entry, index) => nativeEqual(entry, right[index]));
  if (left && right && typeof left === "object" && typeof right === "object") {
    const leftRecord = left as Record<string, unknown>;
    const rightRecord = right as Record<string, unknown>;
    const keys = Object.keys(leftRecord);
    return keys.length === Object.keys(rightRecord).length && keys.every((key) => Object.prototype.hasOwnProperty.call(rightRecord, key) && nativeEqual(leftRecord[key], rightRecord[key]));
  }
  return false;
}

function nativeNamedGate(cwd: string, runId: string, state: CtoState, teamId: string, name: string): boolean | undefined {
  if (name === "branch_created") return state.branch.trim().length > 0;
  if (name === "dod_complete" || name === "team_dod_complete") return teamDoDComplete(state, teamId, cwd).ok;
  const diagnosis = nativeArtifactValue(cwd, runId, state, teamId, "diagnosis");
  if (name === "root_cause_documented") {
    return !!diagnosis
      && typeof diagnosis === "object"
      && !Array.isArray(diagnosis)
      && typeof (diagnosis as Record<string, unknown>).root_cause === "string"
      && Boolean(((diagnosis as Record<string, unknown>).root_cause as string).trim())
      && typeof (diagnosis as Record<string, unknown>).explanation === "string"
      && Boolean(((diagnosis as Record<string, unknown>).explanation as string).trim());
  }
  if (name === "tests_passed") {
    const tests = nativeArtifactValue(cwd, runId, state, teamId, "qa_tests");
    return !!tests && typeof tests === "object" && !Array.isArray(tests) && (tests as Record<string, unknown>).build_status === "pass";
  }
  if (name === "plan_valid") {
    const plan = nativeArtifactValue(cwd, runId, state, teamId, "team_plan");
    return !!plan && typeof plan === "object" && Array.isArray((plan as Record<string, unknown>).teams) && ((plan as Record<string, unknown>).teams as unknown[]).length > 0;
  }
  if (name === "contract_complete") {
    const contract = nativeArtifactValue(cwd, runId, state, teamId, "architecture");
    return !!contract && typeof contract === "object" && !Array.isArray(contract)
      && Array.isArray((contract as Record<string, unknown>).options)
      && typeof (contract as Record<string, unknown>).chosen === "string"
      && Boolean(((contract as Record<string, unknown>).chosen as string).trim());
  }
  return undefined;
}

function nativePredicate(
  cwd: string,
  runId: string,
  state: CtoState,
  teamId: string,
  stage: StageDef,
  expression: string,
): { ok: true; value: boolean } | { ok: false; error: string } {
  const parsed = parseExpression(expression);
  if (!parsed.ok) return parsed;
  const flags = flagsForTeam(cwd, state, teamId);
  let firstError: string | undefined;
  for (const term of parsed.ast.terms) {
    let value: boolean;
    if (term.kind === "flag") {
      value = Boolean(flags[term.flag]);
    } else if (term.kind === "named") {
      const named = nativeNamedGate(cwd, runId, state, teamId, term.name);
      if (named === undefined) {
        firstError ??= `unsupported native predicate '${term.name}'`;
        continue;
      }
      value = named;
    } else {
      const candidateIds = term.artifact
        ? [term.artifact]
        : [
            ...(Array.isArray(stage.produces) ? stage.produces : stage.produces ? [stage.produces] : []),
            ...(stage.consumes ?? []),
          ];
      let found = false;
      value = false;
      for (const artifactId of candidateIds) {
        const artifact = nativeArtifactValue(cwd, runId, state, teamId, artifactId);
        if (!artifact || typeof artifact !== "object" || Array.isArray(artifact) || !Object.prototype.hasOwnProperty.call(artifact, term.field)) continue;
        found = true;
        value = nativeEqual((artifact as Record<string, unknown>)[term.field], term.value);
        break;
      }
      if (!found) {
        firstError ??= `native predicate requires a produced or consumed artifact with field '${term.field}'`;
        continue;
      }
      if (term.op === "!=") value = !value;
    }
    if (term.negated) value = !value;
    if (value) return { ok: true, value: true };
  }
  return firstError ? { ok: false, error: firstError } : { ok: true, value: false };
}

function currentWaveFor(state: CtoState, sliceId: string): { id: string } | undefined {
  const wave = activeWave(state);
  return wave && wave.slice_ids.includes(sliceId) ? wave : undefined;
}

function capability(runId: string, waveId: string, teamId: string, stageId: string, iteration: number, hash: string): { id: string; epoch: string } {
  const base = `${runId}\u0000${waveId}\u0000${teamId}\u0000${stageId}\u0000${iteration}\u0000${hash}`;
  return {
    id: `native-cap-${safeNativeId(base)}`,
    epoch: `native-epoch-${safeNativeId(`${base}\u0000epoch`)}`,
  };
}

function progressContract(
  cwd: string,
  state: CtoState,
  teamId: string,
): { team: NativeCtoTeam; profile: Profile; profile_hash: string; stage: StageDef; progress?: NativeStageProgress; slots: NativeStageSlotDeclaration[]; wave: { id: string } }
  | { error: string; code: string } {
  const team = teamFor(state, teamId);
  if (!team) return { code: "worker_assignment_unavailable", error: `unknown CTO team '${teamId}'` };
  const plan = planFor(state, teamId);
  if (!plan) return { code: "worker_assignment_unavailable", error: `team '${teamId}' has no canonical plan entry` };
  if (!team.slice_id) return { code: "worker_assignment_unavailable", error: `team '${teamId}' has no canonical slice assignment` };
  const wave = currentWaveFor(state, team.slice_id);
  if (!wave) return { code: "worker_assignment_unavailable", error: `team '${teamId}' slice '${team.slice_id}' is not in the active wave` };
  const resolved = profileForTeam(cwd, team);
  if ("error" in resolved) return { code: "profile_unavailable", error: resolved.error };
  const progress = state.native_stage_progress?.[teamId];
  const stage = stageForProgress(resolved.profile, progress, team);
  if (!stage) return { code: "stage_unavailable", error: `current native stage for team '${teamId}' is not present in workflow '${resolved.profile.name}'` };
  if (progress && (
    progress.run_id !== state.id
    || progress.wave_id !== wave.id
    || progress.slice_id !== team.slice_id
    || progress.workflow !== resolved.profile.name
    || progress.profile_hash !== resolved.hash
    || progress.stage_id !== stage.id
  )) return { code: "stage_assignment_stale", error: `persisted native stage progress for team '${teamId}' is stale` };
  const slots = progress
    ? progress.declared_slots
    : resolveSlots(cwd, state, teamId, stage);
  if ("error" in slots) return { code: "roster_unavailable", error: slots.error };
  return { team, profile: resolved.profile, profile_hash: resolved.hash, stage, progress, slots, wave };
}

function assignmentFor(progress: NativeStageProgress, dispatchId: string): NativeStageAssignment | undefined {
  return progress.assignments[dispatchId];
}

function identityMatches(a: WorkIdentity, b: WorkIdentity): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
export function nativeStageGeneration(state: CtoState): number {
  const candidate = (state as unknown as Record<string, unknown>).rework_generation;
  return typeof candidate === "number" && Number.isSafeInteger(candidate) && candidate >= 0 ? candidate : 0;
}
function canonicalNativeReplayJson(value: unknown): string {
  const canonicalize = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(canonicalize);
    if (input && typeof input === "object") {
      return Object.fromEntries(Object.entries(input as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalize(entry)]));
    }
    return input;
  };
  const result = JSON.stringify(canonicalize(value));
  if (result === undefined) throw new Error("native replay payload is not serializable");
  return result;
}

function nativeAcceptedReplayDigest(identity: WorkIdentity, outputs: Record<string, unknown>): string {
  return createHash("sha256")
    .update(`${canonicalNativeReplayJson(identity)}\n${canonicalNativeReplayJson(outputs)}`, "utf8")
    .digest("hex");
}

export interface NativeAcceptedStageReceiptLineage {
  readonly session_id: string;
  readonly session_file: string;
  readonly parent_session_file: string;
}
export interface NativeAcceptedStageReceiptRoot {
  readonly context: TrustedExecutionContext;
  readonly claim_scope: CtoClaimScope;
  readonly outputs: Record<string, unknown>;
}


export interface NativeAcceptedStageReceiptCandidate {
  readonly identity: WorkIdentity;
  readonly receipt: StageReceiptLedger;
}

/**
 * Select an already accepted native worker receipt for a cold-revived child.
 *
 * This is deliberately a read-only proof. It never creates an assignment,
 * claim reservation, binding, terminal record, or recovery operation. The
 * trusted root context and claim scope are checked together with the canonical
 * state and immutable artifacts while the workspace read lock is held.
 */
export function findNativeAcceptedStageReceipt(
  input: {
    cwd: string;
    runId: string;
    lineage: NativeAcceptedStageReceiptLineage;
    root: NativeAcceptedStageReceiptRoot;
  },
): NativeAcceptedStageReceiptCandidate | undefined {
  if (
    !input.cwd
    || !input.runId
    || !input.lineage.session_id
    || !isAbsolute(input.lineage.session_file)
    || !isAbsolute(input.lineage.parent_session_file)
    || !input.root
    || !input.root.context
    || input.root.context.caller !== "host"
    || input.root.context.authority !== "coordinator"
    || !input.root.context.session_id
    || !input.root.context.worktree
    || !input.root.context.branch
    || input.root.claim_scope.run_id !== input.runId
    || !input.root.claim_scope.ownership_epoch
    || !isRecord(input.root.outputs)
    || Array.isArray(input.root.outputs)
  ) return undefined;
  try {
    return withWorkspaceReadNoRecovery(input.cwd, () => {
      const context = input.root.context;
      if (resolve(context.worktree) !== resolve(input.cwd)) return undefined;
      const claim = readRunControlHeldLock(input.cwd).execution_claim;
      if (
        !claim
        || claim.owner_kind !== "cto"
        || claim.run_id !== input.runId
        || claim.released_at !== null
        || claim.coordinator_session_id !== context.session_id
        || (claim.coordinator_process_id ?? undefined) !== (context.process_id ?? undefined)
        || claim.ownership_epoch !== input.root.claim_scope.ownership_epoch
      ) return undefined;
      const state = readCtoState(input.runId, input.cwd);
      if (!state || state.id !== input.runId || state.branch !== context.branch) return undefined;
      const generation = nativeStageGeneration(state);
      const receipts = Object.values(state.stage_receipts ?? {});
      const candidates = receipts.filter((receipt) => {
        const identity = receipt.work_identity;
        if (!identity || identity.run_id !== input.runId) return false;
        if (!Array.isArray(receipt.outputs) || receipt.outputs.length === 0) return false;
        if (!receipt.outputs.every((output) => nativeArtifactBytes(input.cwd, input.runId, output) !== null)) return false;
        const binding = receipt.binding;
        if (!isRecord(binding) || binding.authority !== "cto" || !isRecord(binding.identity) || !sameIdentity(binding.identity, identity)) return false;
        const host = binding.host;
        const producer = binding.producer;
        if (!isRecord(host) || !isRecord(producer) || producer.kind !== "worker") return false;
        if (
          host.session_id !== input.lineage.session_id
          || typeof host.worktree !== "string"
          || resolve(host.worktree) !== resolve(input.cwd)
          || host.branch !== state.branch
          || producer.profile !== identity.workflow
          || producer.stage_id !== identity.stage_id
          || producer.iteration !== (identity.loop_iteration ?? 1)
          || producer.generation !== generation
          || producer.wave_id !== identity.wave_id
          || producer.slice_id !== identity.slice_id
        ) return false;
        const lineage = producer.lineage;
        if (!isRecord(lineage)) return false;
        if (
          lineage.session_id !== input.lineage.session_id
          || typeof lineage.session_file !== "string"
          || typeof lineage.parent_session_file !== "string"
          || !isAbsolute(lineage.session_file)
          || !isAbsolute(lineage.parent_session_file)
          || resolve(lineage.session_file) !== resolve(input.lineage.session_file)
          || resolve(lineage.parent_session_file) !== resolve(input.lineage.parent_session_file)
        ) return false;
        const progressMatches = Object.values(state.native_stage_progress ?? {}).filter((progress) => {
          if (
            progress.run_id !== input.runId
            || progress.stage_id !== identity.stage_id
            || progress.stage_cursor !== identity.stage_cursor
            || progress.iteration !== (identity.loop_iteration ?? 1)
            || progress.workflow !== identity.workflow
            || progress.wave_id !== identity.wave_id
            || progress.slice_id !== identity.slice_id
          ) return false;
          const assignment = progress.assignments[identity.dispatch_id];
          return !!assignment
            && (assignment.status === "accepted" || assignment.status === "terminal")
            && sameIdentity(assignment.identity, identity)
            && assignment.role !== "lead"
            && assignment.agent === producer.agent
            && assignment.slot_id === producer.slot_id
            && assignment.role === producer.role;
        });
        if (progressMatches.length !== 1) return false;
        try {
          return receipt.digest === nativeAcceptedReplayDigest(identity, input.root.outputs);
        } catch {
          return false;
        }
      });
      if (candidates.length !== 1) return undefined;
      const receipt = candidates[0]!;
      return { identity: structuredClone(receipt.work_identity), receipt: structuredClone(receipt) };
    }, () => undefined);
  } catch {
    return undefined;
  }
}


function sameIdentity(left: unknown, right: unknown): boolean {
  try {
    return JSON.stringify(left) === JSON.stringify(right);
  } catch {
    return false;
  }
}

function statusForProgress(progress: NativeStageProgress): NativeStageProgress["status"] {
  const values = Object.values(progress.assignments);
  if (values.length === 0) return "ready";
  if (values.some((entry) => entry.status === "accepted")) return "accepted";
  return "running";
}
type NativeRecoveryCandidate = {
  original: WorkIdentity;
  operation_id: string;
  retry_of: string;
  replacement_identity: WorkIdentity;
  generation: number;
  admission_state: "ready" | "consumed";
};

function nativeRecoveryCandidates(
  state: CtoState,
  progress: NativeStageProgress,
  declarations: readonly NativeStageSlotDeclaration[],
  item: NativeStageAdmissionItem,
  toolCallId: string,
  ledger: StageRecoveryLedger | undefined,
): NativeRecoveryCandidate[] {
  if (!ledger) return [];
  const candidates: NativeRecoveryCandidate[] = [];
  for (const line of Object.values(ledger.lineages)) {
    const original = line.identity;
    if (
      line.generation !== nativeStageGeneration(state)
      || original.run_id !== state.id
      || original.wave_id !== progress.wave_id
      || original.slice_id !== progress.slice_id
      || original.workflow !== progress.workflow
      || original.stage_id !== progress.stage_id
      || original.stage_cursor !== progress.stage_cursor
    ) continue;
    const assignment = progress.assignments[original.dispatch_id];
    if (!assignment || assignment.status !== "terminal") continue;
    for (const operation of line.operations) {
      const replacement = operation.replacement_identity;
      if (
        !["prepared", "acked"].includes(operation.status)
        || operation.retry_of !== original.dispatch_id
        || !replacement
        || !operation.admission
        || (operation.admission.state !== "ready" && operation.admission.state !== "consumed")
        || (operation.admission.state === "consumed" && operation.admission.tool_call_id !== toolCallId)
        || replacement.wave_id !== progress.wave_id
        || replacement.slice_id !== progress.slice_id
        || replacement.workflow !== progress.workflow
        || replacement.stage_id !== progress.stage_id
        || replacement.stage_cursor !== progress.stage_cursor
        || replacement.loop_iteration !== progress.iteration
        || replacement.capability_id !== progress.capability_id
        || replacement.capability_epoch !== progress.capability_epoch
      ) continue;
      const slot = declarations.find((entry) => entry.slot_id === replacement.slot_id && entry.agent === item.agent);
      if (!slot) continue;
      candidates.push({
        original: structuredClone(original),
        operation_id: operation.operation_id,
        retry_of: operation.retry_of,
        replacement_identity: structuredClone(replacement),
        generation: line.generation,
        admission_state: operation.admission.state,
      });
    }
  }
  return candidates;
}


/**
 * Reserve the exact native CTO stage identity at host task admission. The
 * caller has already authenticated the lead/roster; this function binds that
 * admission to the current wave, profile stage, profile roster and a fresh
 * engine capability rather than accepting model-supplied identity fields.
 */
function planNativeStageAssignments(
  request: NativeStageAdmissionRequest,
  state: CtoState,
  recoveryLedger: StageRecoveryLedger | undefined,
): NativeStageAdmissionPlan {
  try {
    if (
      request.preflight_terminal_signal !== undefined
      && request.preflight_terminal_signal !== "preflight:missing_prompt"
      && request.preflight_terminal_signal !== "preflight:invalid_arguments"
    ) {
      return { result: fail("admission_invalid", "native preflight terminal signal is not supported"), worker_ids: [], recovery_permits: [], changed: false };
    }
    if (request.items.length === 0) {
      return { result: fail("worker_assignment_unavailable", "native CTO admission contains no task items"), worker_ids: [], recovery_permits: [], changed: false };
    }
    const contract = progressContract(request.cwd, state, request.teamId);
    if ("error" in contract) return { result: fail(contract.code, contract.error), worker_ids: [], recovery_permits: [], changed: false };
    if (contract.team.slice_id !== request.sliceId) {
      return { result: fail("worker_assignment_conflict", "native task slice does not match the canonical team slice"), worker_ids: [], recovery_permits: [], changed: false };
    }
    const progress: NativeStageProgress = contract.progress ?? (() => {
      const capabilityIds = capability(state.id, contract.wave.id, request.teamId, contract.stage.id, 1, contract.profile_hash);
      return {
        schema: 1 as const,
        run_id: state.id,
        wave_id: contract.wave.id,
        slice_id: request.sliceId,
        team_id: request.teamId,
        workflow: contract.profile.name,
        stage_id: contract.stage.id,
        stage_cursor: contract.stage.id,
        profile_hash: contract.profile_hash,
        capability_id: capabilityIds.id,
        capability_epoch: capabilityIds.epoch,
        iteration: 1,
        declared_outputs: outputIds(contract.stage),
        declared_slots: contract.slots,
        assignments: {},
        status: "ready" as const,
        revision: 0,
        updated_at: now(),
      } satisfies NativeStageProgress;
    })();
    if (progress.status === "complete") {
      return { result: fail("stage_assignment_stale", `native stage '${progress.stage_id}' is already complete`), worker_ids: [], recovery_permits: [], changed: false };
    }
    const admissionRule = resolveProfileControlPlane(contract.profile, contract.stage.id).checkpoint_rule;
    if (admissionRule?.phase === "before_dispatch") {
      const approval = progress.approval;
      if (
        !approval
        || approval.phase !== admissionRule.phase
        || approval.progress_revision !== progress.revision - 1
        || approval.receipt_digest !== acceptedReceiptDigest(state, progress)
        || !admissionRule.allowed_decisions.includes(approval.decision)
      ) {
        return { result: fail("checkpoint_human_required", `native stage '${contract.stage.id}' requires a valid before-dispatch checkpoint approval`), worker_ids: [], recovery_permits: [], changed: false };
      }
    }
    if (request.actor === "lead" && contract.stage.type !== "orchestrator") {
      return {
        result: { ok: true, identities: [], progress },
        worker_ids: request.preflight_terminal_signal === undefined ? request.items.map((item) => item.worker_id) : [],
        recovery_permits: [],
        recovery_ledger: recoveryLedger,
        changed: false,
      };
    }
    const declarations = [...progress.declared_slots];
    if (request.actor === "lead" && !declarations.some((slot) => slot.agent === request.lead)) {
      declarations.push({ slot_id: "lead", role: "lead", agent: request.lead, occurrence: 1 });
    }
    let consumedRecoveryLedger: StageRecoveryLedger | undefined;
    const preflightSignal = request.preflight_terminal_signal;
    const used = new Set(Object.values(progress.assignments).filter((entry) => entry.status !== "terminal").map((entry) => entry.slot_id));
    const identities: WorkIdentity[] = [];
    const resolvedDispatchIds = new Set<string>();
    const resolvedWorkerIds = new Set<string>();
    const reservationWorkerIds = new Set<string>();
    const recoveryPermits = new Map<string, NativeStageRecoveryReservation>();
    const updated = structuredClone(progress);
    updated.declared_slots = declarations;
    const timestamp = now();
    let workingRecoveryLedger = recoveryLedger;
    for (const item of request.items) {
      if (!item.agent || (request.actor === "worker" ? !request.roster.includes(item.agent) : item.agent !== request.lead)) {
        return { result: fail("worker_authority_denied", `native agent '${item.agent}' is not assigned to the configured CTO lead/roster`), worker_ids: [], recovery_permits: [], changed: false };
      }
      const candidates = nativeRecoveryCandidates(state, progress, declarations, item, request.toolCallId, workingRecoveryLedger);
      if (preflightSignal && candidates.length > 0) {
        return { result: fail("admission_conflict", "a rejected native preflight cannot consume a recovery permit"), worker_ids: [], recovery_permits: [], changed: false };
      }
      if (candidates.length > 1) {
        return { result: fail("admission_ambiguous", "multiple native recovery permits match the current stage slot"), worker_ids: [], recovery_permits: [], changed: false };
      }
      const candidate = candidates[0];
      if (candidate?.admission_state === "ready") {
        recoveryPermits.set(candidate.operation_id, {
          operation_id: candidate.operation_id,
          retry_of: candidate.retry_of,
          generation: candidate.generation,
          original: structuredClone(candidate.original),
          replacement_identity: structuredClone(candidate.replacement_identity),
        });
      }
      let replacementForItem: WorkIdentity | undefined;
      if (candidate) {
        const consumed = consumePreparedRecoveryAdmission(workingRecoveryLedger!, {
          run_id: state.id,
          authority: "cto",
          generation: candidate.generation,
          identity: candidate.original,
          retry_of: candidate.retry_of,
          replacement_identity: candidate.replacement_identity,
        }, request.toolCallId);
        if (!consumed.ok) {
          return { result: fail(consumed.code, `native recovery admission cannot be consumed: ${consumed.code}`), worker_ids: [], recovery_permits: [], changed: false };
        }
        workingRecoveryLedger = consumed.ledger;
        consumedRecoveryLedger = consumed.ledger;
        replacementForItem = consumed.replacement_identity;
      }
      const dispatchId = replacementForItem?.dispatch_id
        ?? `native-${safeNativeId(`${state.id}\u0000${request.teamId}\u0000${request.toolCallId}\u0000${item.index}`)}`;
      const existing = assignmentFor(updated, dispatchId);
      if (existing) {
        if (
          existing.agent !== item.agent
          || (!replacementForItem && existing.identity.worker_id !== item.worker_id)
          || replacementForItem && !sameIdentity(existing.identity, replacementForItem)
          || existing.terminal_signal !== preflightSignal
        ) {
          return { result: fail("worker_assignment_conflict", `native replay '${dispatchId}' changes its assigned worker or terminal signal`), worker_ids: [], recovery_permits: [], changed: false };
        }
        if (resolvedDispatchIds.has(existing.identity.dispatch_id) || resolvedWorkerIds.has(existing.identity.worker_id)) {
          return { result: fail("worker_assignment_conflict", `native batch reuses resolved dispatch '${existing.identity.dispatch_id}' or worker identity`), worker_ids: [], recovery_permits: [], changed: false };
        }
        resolvedDispatchIds.add(existing.identity.dispatch_id);
        resolvedWorkerIds.add(existing.identity.worker_id);
        identities.push(structuredClone(existing.identity));
        reservationWorkerIds.add(existing.identity.worker_id);
        continue;
      }
      const declaration = replacementForItem
        ? declarations.find((slot) => slot.slot_id === replacementForItem!.slot_id && !used.has(slot.slot_id))
        : request.actor === "lead"
          ? declarations.find((slot) => slot.agent === request.lead && !used.has(slot.slot_id))
          : declarations.find((slot) => slot.agent === item.agent && !used.has(slot.slot_id));
      if (!declaration) {
        return { result: fail("worker_assignment_denied", `native agent '${item.agent}' is not assigned to current stage '${contract.stage.id}'`), worker_ids: [], recovery_permits: [], changed: false };
      }
      used.add(declaration.slot_id);
      const priorAttempts = Object.values(updated.assignments).filter((entry) => entry.slot_id === declaration.slot_id).map((entry) => entry.identity.attempt);
      const attempt = Math.max(0, ...priorAttempts) + 1;
      const identity: WorkIdentity = replacementForItem ? structuredClone(replacementForItem) : {
        run_id: state.id,
        wave_id: contract.wave.id,
        slice_id: request.sliceId,
        session_id: request.parentSessionId,
        workflow: contract.profile.name,
        stage_id: contract.stage.id,
        stage_cursor: contract.stage.id,
        capability_id: updated.capability_id,
        capability_epoch: updated.capability_epoch,
        loop_iteration: updated.iteration,
        slot_id: declaration.slot_id,
        task_id: `native-task-${safeNativeId(`${dispatchId}\u0000${item.worker_id}`)}`,
        dispatch_id: dispatchId,
        attempt,
        worker_id: item.worker_id,
      };
      const validation = validateWorkIdentityValue(identity);
      if (!validation.ok) {
        return { result: fail("worker_assignment_conflict", `native identity is invalid: ${validation.issues.map((issue) => `${issue.path} ${issue.message}`).join("; ")}`), worker_ids: [], recovery_permits: [], changed: false };
      }
      if (resolvedDispatchIds.has(identity.dispatch_id) || resolvedWorkerIds.has(identity.worker_id)) {
        return { result: fail("worker_assignment_conflict", `native batch reuses resolved dispatch '${identity.dispatch_id}' or worker identity`), worker_ids: [], recovery_permits: [], changed: false };
      }
      resolvedDispatchIds.add(identity.dispatch_id);
      resolvedWorkerIds.add(identity.worker_id);
      updated.assignments[dispatchId] = {
        identity,
        slot_id: declaration.slot_id,
        role: declaration.role,
        agent: item.agent,
        status: preflightSignal ? "terminal" : "reserved",
        ...(preflightSignal ? { terminal_signal: preflightSignal } : {}),
        reserved_at: timestamp,
        updated_at: timestamp,
      };
      identities.push(structuredClone(identity));
      reservationWorkerIds.add(identity.worker_id);
    }
    updated.status = statusForProgress(updated);
    updated.revision += 1;
    updated.updated_at = timestamp;
    state.native_stage_progress = { ...(state.native_stage_progress ?? {}), [request.teamId]: updated };
    state.teams = state.teams.map((team) => team.id !== request.teamId ? team : {
      ...team,
      pending: {
        ...(team.pending ?? {}),
        status: "authorized" as const,
        identity: structuredClone(identities[identities.length - 1]!),
        updated_at: timestamp,
      },
      work_identity: structuredClone(identities[identities.length - 1]!),
    });
    return {
      result: { ok: true, identities, progress: updated },
      worker_ids: [...reservationWorkerIds],
      recovery_permits: [...recoveryPermits.values()],
      recovery_ledger: workingRecoveryLedger,
      changed: true,
    };
  } catch (error) {
    return {
      result: fail("cto_state_conflict", `native stage assignment CAS failed: ${error instanceof Error ? error.message : String(error)}`),
      worker_ids: [],
      recovery_permits: [],
      changed: false,
    };
  }
}

function batchAdmissionFailure(
  requests: readonly NativeStageAdmissionRequest[],
  failure: NativeStageFailure,
): NativeStageAdmissionResult[] {
  return requests.map(() => ({ ...failure }));
}

/**
 * Reserve native CTO identities for all route groups in one canonical
 * workspace transaction. Planning mutates only the in-memory state snapshot;
 * the claim reservation and single state publication happen after every group
 * has passed validation.
 */
export function reserveNativeStageAssignmentsBatch(
  requests: readonly NativeStageAdmissionRequest[],
): NativeStageAdmissionResult[] {
  if (requests.length === 0) return [];
  const first = requests[0]!;
  try {
    return withWorkspaceTransaction(first.cwd, () => {
      if (requests.some((request) => request.cwd !== first.cwd || request.runId !== first.runId || request.toolCallId !== first.toolCallId)) {
        return batchAdmissionFailure(requests, fail("admission_invalid", "native batch requests must share one workspace, run and tool call"));
      }
      const reservation = first.claim_reservation;
      if (requests.some((request) => request.claim_reservation !== reservation)) {
        return batchAdmissionFailure(requests, fail("admission_invalid", "native batch requests must share one claim reservation bridge"));
      }
      const state = readCtoState(first.runId, first.cwd);
      if (!state) return batchAdmissionFailure(requests, fail("cto_state_unavailable", `canonical CTO state '${first.runId}' is unavailable`));
      let recoveryLedger: StageRecoveryLedger | undefined;
      try {
        recoveryLedger = migrateStageRecoveryLedger((state as unknown as Record<string, unknown>)[STAGE_RECOVERY_FIELD]);
      } catch (error) {
        return batchAdmissionFailure(requests, fail("admission_invalid", `native recovery ledger is malformed: ${error instanceof Error ? error.message : String(error)}`));
      }
      const originalRecoveryLedger = recoveryLedger;
      const plans: Array<{ request: NativeStageAdmissionRequest; plan: NativeStageAdmissionPlan }> = [];
      const dispatchIds = new Set<string>();
      const reservedWorkerIds = new Set<string>();
      const permitIds = new Set<string>();
      let changed = false;
      for (const request of requests) {
        const plan = planNativeStageAssignments(request, state, recoveryLedger);
        if (!plan.result.ok) return batchAdmissionFailure(requests, plan.result);
        const reservedBefore = new Set(reservedWorkerIds);
        for (const identity of plan.result.identities) {
          if (dispatchIds.has(identity.dispatch_id) || reservedBefore.has(identity.worker_id)) {
            return batchAdmissionFailure(requests, fail("worker_assignment_conflict", `native batch reuses resolved dispatch '${identity.dispatch_id}' or worker identity`));
          }
          dispatchIds.add(identity.dispatch_id);
        }
        for (const workerId of plan.worker_ids) {
          if (reservedBefore.has(workerId)) {
            return batchAdmissionFailure(requests, fail("worker_assignment_conflict", `native batch reuses worker identity '${workerId}'`));
          }
          reservedWorkerIds.add(workerId);
        }
        for (const permit of plan.recovery_permits) {
          if (permitIds.has(permit.operation_id)) {
            return batchAdmissionFailure(requests, fail("admission_ambiguous", `native batch reuses recovery permit '${permit.operation_id}'`));
          }
          permitIds.add(permit.operation_id);
        }
        recoveryLedger = plan.recovery_ledger;
        changed = changed || plan.changed;
        plans.push({ request, plan });
      }
      const reserveWorkerIds = new Set<string>();
      const reservePermits = new Map<string, NativeStageRecoveryReservation>();
      for (const entry of plans) {
        if (entry.request.preflight_terminal_signal !== undefined) continue;
        for (const workerId of entry.plan.worker_ids) reserveWorkerIds.add(workerId);
        for (const permit of entry.plan.recovery_permits) reservePermits.set(permit.operation_id, permit);
      }
      if (reservePermits.size > 0 && !reservation) {
        return batchAdmissionFailure(requests, fail("worker_assignment_conflict", "native recovery admission requires a claim reservation bridge"));
      }
      let newlyReservedWorkerIds: readonly string[] = [];
      if (reservation && reserveWorkerIds.size > 0) {
        try {
          const requestedWorkerIds = new Set(reserveWorkerIds);
          const reserved = reservation.reserve({
            worker_ids: [...requestedWorkerIds],
            recovery_permits: [...reservePermits.values()],
          });
          newlyReservedWorkerIds = [...new Set(reserved)].filter((workerId) => requestedWorkerIds.has(workerId));
        } catch (error) {
          return batchAdmissionFailure(requests, fail("worker_assignment_conflict", `native claim reservation failed: ${error instanceof Error ? error.message : String(error)}`));
        }
      }
      if (recoveryLedger !== originalRecoveryLedger) {
        (state as unknown as Record<string, unknown>)[STAGE_RECOVERY_FIELD] = recoveryLedger;
        changed = true;
      }
      try {
        if (changed) writeCtoState(state, first.cwd, { assumeWorkspaceLock: true });
      } catch (error) {
        if (newlyReservedWorkerIds.length > 0) {
          try {
            reservation?.settle(newlyReservedWorkerIds);
          } catch {
            // Preserve the canonical state publication failure; settlement is best effort.
          }
        }
        return batchAdmissionFailure(requests, fail("cto_state_conflict", `native stage assignment CAS failed: ${error instanceof Error ? error.message : String(error)}`));
      }
      return plans.map((entry) => entry.plan.result);
    });
  } catch (error) {
    return batchAdmissionFailure(requests, fail("cto_state_conflict", `native stage assignment CAS failed: ${error instanceof Error ? error.message : String(error)}`));
  }
}

/**
 * Resolve the persisted native producer kind for the shared StageHostBinding
 * bridge. This never trusts an actor/model field: the current profile stage
 * declaration and engine-owned assignment role decide whether this is a
 * declared tool callback, native lead/orchestrator, or child worker.
 */
export function resolveNativeStageProducer(cwd: string, runId: string, native: NativeStageBindingLike): NativeStageProducerDescriptor | null {
  if (native.resolution.kind !== "cto" || native.resolution.runId !== runId || !native.assigned_identity) return null;
  const identity = native.assigned_identity;
  if (identity.run_id !== runId || identity.session_id !== native.session_id) return null;
  const state = readCtoState(runId, cwd);
  if (!state) return null;
  const progress = Object.values(state.native_stage_progress ?? {}).find((candidate) =>
    candidate.run_id === runId
    && candidate.assignments[identity.dispatch_id]?.identity
    && identityMatches(candidate.assignments[identity.dispatch_id]!.identity, identity),
  );
  if (!progress) return null;
  const assignment = progress.assignments[identity.dispatch_id];
  if (!assignment || !["reserved", "running", "accepted", "terminal"].includes(assignment.status) || assignment.agent !== native.agent || assignment.terminal_signal !== undefined) return null;
  const team = teamFor(state, progress.team_id);
  if (!team) return null;
  const resolved = profileForTeam(cwd, team);
  if ("error" in resolved || resolved.hash !== progress.profile_hash) return null;
  const stage = resolved.profile.stages.find((candidate) => candidate.id === progress.stage_id);
  if (!stage || progress.stage_cursor !== stage.id || identity.stage_id !== stage.id || identity.stage_cursor !== stage.id) return null;
  const toolName = stage.producer?.kind === "tool" ? stage.producer.tool_name : undefined;
  const kind = toolName && assignment.role === "lead" && native.resolution.actor === "lead"
    ? "tool"
    : stage.type === "orchestrator" && assignment.role === "lead" && native.resolution.actor === "lead"
      ? "orchestrator"
      : stage.type !== "orchestrator" && assignment.role !== "lead" && native.resolution.actor === "worker"
        ? "worker"
        : null;
  if (!kind) return null;
  return {
    ...(kind === "tool" && toolName ? { tool_name: toolName } : {}),
    kind,
    identity: structuredClone(identity),
    role: assignment.role,
    agent: assignment.agent,
    profile: progress.workflow,
    stage_id: progress.stage_id,
    iteration: progress.iteration,
    generation: nativeStageGeneration(state),
    wave_id: progress.wave_id,
    slice_id: progress.slice_id,
  };
}

/** Bind the reserved identity to the actual child session after lifecycle start. */
export function bindNativeStageAssignment(cwd: string, runId: string, dispatchId: string, sessionId: string): WorkIdentity | undefined {
  const state = readCtoState(runId, cwd);
  const progress = state && Object.values(state.native_stage_progress ?? {}).find((entry) => entry.assignments[dispatchId]);
  const assignment = progress?.assignments[dispatchId];
  if (!state || !progress || !assignment || !sessionId) return undefined;
  if (assignment.status === "terminal") return undefined;
  if (assignment.status === "accepted") return assignment.identity.session_id === sessionId ? structuredClone(assignment.identity) : undefined;
  if (assignment.status === "running" && assignment.identity.session_id === sessionId) return structuredClone(assignment.identity);
  const identity = { ...assignment.identity, session_id: sessionId };
  const updated = structuredClone(progress);
  updated.assignments[dispatchId] = { ...assignment, identity, status: "running", updated_at: now() };
  updated.status = "running";
  updated.revision += 1;
  updated.updated_at = now();
  state.native_stage_progress = { ...(state.native_stage_progress ?? {}), [progress.team_id]: updated };
  state.teams = state.teams.map((team) => {
    if (team.id !== progress.team_id) return team;
    const pending = team.pending?.identity?.dispatch_id === dispatchId ? { ...(team.pending ?? {}), identity: structuredClone(identity) } : team.pending;
    const workIdentity = team.work_identity?.dispatch_id === dispatchId ? structuredClone(identity) : team.work_identity;
    return { ...team, ...(pending ? { pending } : {}), ...(workIdentity ? { work_identity: workIdentity } : {}) };
  });
  try {
    writeCtoState(state, cwd);
  } catch {
    return undefined;
  }
  return identity;
}

/** Pure state update used by the native receipt committer inside its CAS transaction. */
export function updateNativeStageAssignment(state: CtoState, dispatchId: string, status: NativeStageAssignment["status"]): CtoState {
  const entries = Object.entries(state.native_stage_progress ?? {});
  for (const [teamId, progress] of entries) {
    const assignment = progress.assignments[dispatchId];
    if (!assignment) continue;
    const updatedProgress = structuredClone(progress);
    updatedProgress.assignments[dispatchId] = { ...assignment, status, updated_at: now() };
    updatedProgress.status = status === "accepted" ? "accepted" : statusForProgress(updatedProgress);
    if (status === "accepted" || status === "terminal") delete updatedProgress.approval;
    updatedProgress.revision += 1;
    updatedProgress.updated_at = now();
    return { ...state, native_stage_progress: { ...(state.native_stage_progress ?? {}), [teamId]: updatedProgress } };
  }
  return state;
}
function workerTerminalRequired(progress: NativeStageProgress, assignment: NativeStageAssignment): boolean {
  const profile = loadProfile(progress.workflow);
  const stage = profile?.stages.find((candidate) => candidate.id === progress.stage_id);
  if (!stage || stage.producer?.kind === "tool") return false;
  return stage.type !== "orchestrator" && assignment.role !== "lead";
}

/**
 * Record an actual native child lifecycle terminal before its grant is
 * revoked. The private claim/assignment witness is checked again while the
 * workspace lock is held; receipts remain independent from this transition.
 */
export function settleNativeStageWorkerTerminal(
  cwd: string,
  authority: NativeStageWorkerTerminalAuthority,
): NativeStageWorkerTerminalSettlement {
  if (
    !authority.run_id
    || !authority.claim_token
    || !authority.ownership_epoch
    || !authority.coordinator_session_id
    || !authority.dispatch_id
    || !authority.worker_id
  ) return { ok: false, code: "worker_terminal_invalid", error: "native worker terminal witness is incomplete" };
  try {
    return withWorkspaceTransaction(cwd, () => {
      const state = readCtoState(authority.run_id, cwd);
      if (!state) return { ok: false, code: "cto_state_unavailable", error: `canonical CTO state '${authority.run_id}' is unavailable` };
      const claim = readRunControlNoRecovery(cwd).execution_claim;
      if (
        !claim
        || claim.owner_kind !== "cto"
        || claim.run_id !== authority.run_id
        || claim.token !== authority.claim_token
        || claim.ownership_epoch !== authority.ownership_epoch
        || claim.coordinator_session_id !== authority.coordinator_session_id
        || (claim.coordinator_process_id ?? undefined) !== (authority.coordinator_process_id ?? undefined)
        || claim.released_at !== null
        || !claim.worker_ids.includes(authority.worker_id)
      ) return { ok: false, code: "worker_authority_denied", error: "native worker terminal witness is not the current reserved CTO claim" };
      for (const progress of Object.values(state.native_stage_progress ?? {})) {
        const assignment = progress.assignments[authority.dispatch_id];
        if (!assignment) continue;
        if (assignment.identity.worker_id !== authority.worker_id) {
          return { ok: false, code: "worker_assignment_conflict", error: "native worker terminal witness does not match the assigned worker" };
        }
        const required = workerTerminalRequired(progress, assignment);
        if (!required) return { ok: true, worker_terminal_required: false, changed: false };
        if (assignment.terminal_signal !== undefined) {
          return { ok: false, code: "worker_assignment_conflict", error: "native preflight terminal assignment cannot receive a worker lifecycle terminal" };
        }
        if (assignment.status === "terminal") return { ok: true, worker_terminal_required: true, changed: false };
        if (assignment.status !== "reserved" && assignment.status !== "running" && assignment.status !== "accepted") {
          return { ok: false, code: "worker_assignment_conflict", error: "native worker assignment is not terminalizable" };
        }
        const next = updateNativeStageAssignment(state, authority.dispatch_id, "terminal");
        Object.assign(state, next);
        writeCtoState(state, cwd, { assumeWorkspaceLock: true });
        return { ok: true, worker_terminal_required: true, changed: true };
      }
      return { ok: false, code: "worker_assignment_unavailable", error: "native worker terminal dispatch is not assigned in canonical state" };
    });
  } catch (error) {
    return { ok: false, code: "cto_state_conflict", error: `native worker terminal CAS failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}


function gateSatisfied(cwd: string, runId: string, stage: StageDef, state: CtoState, teamId: string): boolean {
  if (!stage.gate) return true;
  const evaluated = nativePredicate(cwd, runId, state, teamId, stage, stage.gate);
  return evaluated.ok && evaluated.value;
}

/** Evaluate accepted producer outputs, fan-in, DoD and the current checkpoint. */
export function evaluateNativeStageReadiness(cwd: string, runId: string, teamId: string): NativeStageReadiness {
  const state = readCtoState(runId, cwd);
  if (!state) return fail("cto_state_unavailable", `canonical CTO state '${runId}' is unavailable`);
  const contract = progressContract(cwd, state, teamId);
  if ("error" in contract) return fail(contract.code, contract.error);
  if (!contract.progress) return fail("stage_assignment_unavailable", `native stage '${contract.stage.id}' has not been admitted`);
  const progress = contract.progress;
  const receipts = state.stage_receipts ?? {};
  const accepted = new Set<string>();
  const invalidOutputs = new Set<string>();
  const receiptSlots = new Set<string>();
  for (const assignment of Object.values(progress.assignments)) {
    const receipt = receipts[assignment.identity.dispatch_id];
    if (!receipt || !identityMatches(receipt.work_identity, assignment.identity)) continue;
    for (const output of receipt.outputs) {
      if (nativeArtifactBytes(cwd, runId, output) === null) {
        invalidOutputs.add(output.artifact_id);
        continue;
      }
      accepted.add(output.artifact_id);
    }
    receiptSlots.add(assignment.slot_id);
  }
  const missing = progress.declared_outputs.filter((id) => !accepted.has(id) || invalidOutputs.has(id));
  for (const assignment of Object.values(progress.assignments)) {
    if (workerTerminalRequired(progress, assignment) && assignment.status !== "terminal") {
      missing.push(`worker terminal '${assignment.identity.dispatch_id}'`);
    }
  }
  if (Object.keys(progress.assignments).length === 0) missing.push("native producer assignment");
  if (progress.declared_slots.some((slot) => slot.role !== "lead") && progress.declared_slots.some((slot) => !receiptSlots.has(slot.slot_id))) missing.push("declared stage fan-in");
  const control = resolveProfileControlPlane(contract.profile, contract.stage.id);
  const rule = control.checkpoint_rule;
  if (rule) {
    const approval = progress.approval;
    const validApproval = !!approval
      && approval.stage_id === progress.stage_id
      && approval.iteration === progress.iteration
      && approval.phase === rule.phase
      && approval.progress_revision === progress.revision - 1
      && approval.receipt_digest === acceptedReceiptDigest(state, progress)
      && rule.allowed_decisions.includes(approval.decision);
    if (!validApproval) missing.push(`checkpoint approval '${contract.stage.checkpoint ?? contract.stage.id}'`);
  }
  if (!gateSatisfied(cwd, runId, contract.stage, state, teamId)) missing.push(`stage gate '${contract.stage.gate}'`);
  return { ok: true, ready: missing.length === 0, stage_id: progress.stage_id, missing, progress };
}


function checkpointClaimCurrent(cwd: string, runId: string, teamId: string, authority: NativeStageCheckpointAuthority, state: CtoState): boolean {
  if (
    authority.run_id !== runId
    || authority.team_id !== teamId
    || !authority.coordinator_session_id
    || state.id !== runId
  ) return false;
  try {
    const claim = readRunControlNoRecovery(cwd).execution_claim;
    return !!claim
      && claim.owner_kind === "cto"
      && claim.run_id === runId
      && claim.released_at === null
      && claim.coordinator_session_id === authority.coordinator_session_id
      && claim.ownership_epoch === authority.ownership_epoch
      && (authority.coordinator_process_id === undefined || claim.coordinator_process_id === authority.coordinator_process_id);
  } catch {
    return false;
  }
}

/** Read the current native checkpoint policy and immutable result identity scope. */
export function preflightNativeStageCheckpoint(
  cwd: string,
  runId: string,
  teamId: string,
  authority: NativeStageCheckpointAuthority,
): NativeStageCheckpointPreflightResult {
  const state = readCtoState(runId, cwd);
  if (!state) return fail("cto_state_unavailable", `canonical CTO state '${runId}' is unavailable`);
  if (!checkpointClaimCurrent(cwd, runId, teamId, authority, state)) return fail("worker_authority_denied", "native checkpoint preflight requires the current CTO claim");
  const contract = progressContract(cwd, state, teamId);
  if ("error" in contract) return fail(contract.code, contract.error);
  if (!contract.progress) return fail("stage_assignment_unavailable", `native stage '${contract.stage.id}' has not been admitted`);
  const rule = resolveProfileControlPlane(contract.profile, contract.stage.id).checkpoint_rule;
  if (!rule) return fail("checkpoint_invalid", `native stage '${contract.stage.id}' has no checkpoint policy`);
  if (rule.phase === "before_advance") {
    const readiness = evaluateNativeStageReadiness(cwd, runId, teamId);
    if (!readiness.ok) return readiness;
    const blocking = readiness.missing.filter((missing) => !missing.startsWith("checkpoint approval"));
    if (blocking.length > 0) return fail("stage_not_ready", blocking.join("; "));
  }
  const revision = stateRevision(cwd, runId);
  if (!revision) return fail("cto_state_unavailable", "canonical CTO state revision is unavailable");
  const acceptedDispatchIds = Object.values(contract.progress.assignments)
    .filter((assignment) => {
      const receipt = state.stage_receipts?.[assignment.identity.dispatch_id];
      return !!receipt && sameIdentity(receipt.work_identity, assignment.identity);
    })
    .map((assignment) => assignment.identity.dispatch_id)
    .sort();
  return {
    ok: true,
    preflight: {
      run_id: runId,
      team_id: teamId,
      stage_id: contract.progress.stage_id,
      iteration: contract.progress.iteration,
      revision: contract.progress.revision,
      state_revision: revision,
      ownership_epoch: authority.ownership_epoch,
      checkpoint: contract.stage.checkpoint ?? contract.stage.id,
      phase: rule.phase,
      default: rule.default,
      allowed_decisions: [...rule.allowed_decisions],
      profile_hash: contract.progress.profile_hash,
      receipt_digest: acceptedReceiptDigest(state, contract.progress),
      accepted_dispatch_ids: acceptedDispatchIds,
      identity_scope: {
        wave_id: contract.progress.wave_id,
        slice_id: contract.progress.slice_id,
        capability_id: contract.progress.capability_id,
        capability_epoch: contract.progress.capability_epoch,
        declared_outputs: [...contract.progress.declared_outputs],
        declared_slots: structuredClone(contract.progress.declared_slots),
      },
      ...(contract.progress.approval ? { current_approval: structuredClone(contract.progress.approval) } : {}),
    },
  };
}

/** Commit a host-approved decision with a fresh claim/scope check and replay safety. */
export function commitNativeStageCheckpoint(input: NativeStageCheckpointCommitInput): NativeStageCheckpointCommitResult {
  if (!/^[A-Za-z0-9._-]+$/.test(input.approval_id) || input.approval_id === "." || input.approval_id === "..") {
    return fail("checkpoint_invalid", "native checkpoint approval id is unsafe");
  }
  if (input.expected_revision !== input.witness.revision) return fail("cto_state_conflict", "native checkpoint witness revision is inconsistent");
  try {
    return withWorkspaceTransaction(input.cwd, () => {
      const state = readCtoState(input.runId, input.cwd);
      if (!state) return fail("cto_state_unavailable", `canonical CTO state '${input.runId}' is unavailable`);
      if (!checkpointClaimCurrent(input.cwd, input.runId, input.teamId, input.authority, state)) {
        return fail("worker_authority_denied", "native checkpoint commit requires the current CTO claim");
      }
      const contract = progressContract(input.cwd, state, input.teamId);
      if ("error" in contract) return fail(contract.code, contract.error);
      if (!contract.progress) return fail("stage_assignment_unavailable", `native stage '${contract.stage.id}' has not been admitted`);
      const progress = contract.progress;
      const rule = resolveProfileControlPlane(contract.profile, contract.stage.id).checkpoint_rule;
      if (!rule) return fail("checkpoint_invalid", `native stage '${contract.stage.id}' has no checkpoint policy`);
      const revision = stateRevision(input.cwd, input.runId);
      const receiptDigest = acceptedReceiptDigest(state, progress);
      const acceptedDispatchIds = Object.values(progress.assignments)
        .filter((assignment) => {
          const receipt = state.stage_receipts?.[assignment.identity.dispatch_id];
          return !!receipt && sameIdentity(receipt.work_identity, assignment.identity);
        })
        .map((assignment) => assignment.identity.dispatch_id)
        .sort();
      const witness = input.witness;
      const scopeMatches = JSON.stringify(witness.identity_scope) === JSON.stringify({
        wave_id: progress.wave_id,
        slice_id: progress.slice_id,
        capability_id: progress.capability_id,
        capability_epoch: progress.capability_epoch,
        declared_outputs: progress.declared_outputs,
        declared_slots: progress.declared_slots,
      });
      if (
        !revision
        || revision !== witness.state_revision
        || witness.run_id !== input.runId
        || witness.team_id !== input.teamId
        || witness.stage_id !== progress.stage_id
        || witness.iteration !== progress.iteration
        || witness.revision !== progress.revision
        || witness.ownership_epoch !== input.authority.ownership_epoch
        || witness.phase !== rule.phase
        || witness.default !== rule.default
        || JSON.stringify(witness.allowed_decisions) !== JSON.stringify(rule.allowed_decisions)
        || witness.profile_hash !== progress.profile_hash
        || witness.receipt_digest !== receiptDigest
        || JSON.stringify(witness.accepted_dispatch_ids) !== JSON.stringify(acceptedDispatchIds)
        || !scopeMatches
      ) return fail("cto_state_conflict", "native checkpoint witness is stale for the current stage result scope");
      const current = progress.approval;
      if (current) {
        if (
          current.approval_id === input.approval_id
          && current.decision === input.decision
          && current.source === input.source
          && current.phase === rule.phase
          && current.progress_revision === witness.revision
          && current.receipt_digest === receiptDigest
        ) return { ok: true, progress, approval: structuredClone(current) };
        return fail("checkpoint_conflict", "native stage already has a different current approval");
      }
      if (rule.phase === "before_advance") {
        const readiness = evaluateNativeStageReadiness(input.cwd, input.runId, input.teamId);
        if (!readiness.ok) return readiness;
        const blocking = readiness.missing.filter((missing) => !missing.startsWith("checkpoint approval"));
        if (blocking.length > 0) return fail("stage_not_ready", blocking.join("; "));
      }
      if (!rule.allowed_decisions.includes(input.decision)) return fail("checkpoint_invalid", `decision '${input.decision}' is not allowed by the current checkpoint policy`);
      if (input.source === "policy-auto" && rule.default !== "autonomous_allowed") return fail("checkpoint_human_required", "current native checkpoint requires human approval");
      const approval: NativeStageApproval = {
        approval_id: input.approval_id,
        stage_id: progress.stage_id,
        iteration: progress.iteration,
        checkpoint: contract.stage.checkpoint ?? contract.stage.id,
        decision: input.decision,
        phase: rule.phase,
        source: input.source,
        progress_revision: progress.revision,
        receipt_digest: receiptDigest,
        at: now(),
      };
      const updated = structuredClone(progress);
      updated.approval = approval;
      updated.revision += 1;
      updated.updated_at = now();
      state.native_stage_progress = { ...(state.native_stage_progress ?? {}), [input.teamId]: updated };
      writeCtoState(state, input.cwd, { assumeWorkspaceLock: true });
      return { ok: true, progress: updated, approval };
    });
  } catch (error) {
    return fail("cto_state_conflict", `native checkpoint commit CAS failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}


/** Canonical root-owned stage transition; callers must establish the real current claim before this runs. */
function advanceNativeStageCanonical(cwd: string, runId: string, teamId: string, authority: NativeStageCheckpointAuthority, operationId: string): NativeStageMutationResult {
  if (!/^[A-Za-z0-9._-]+$/.test(operationId) || operationId === "." || operationId === "..") return fail("stage_transition_invalid", "native stage operation id is unsafe");
  const state = readCtoState(runId, cwd);
  if (!state) return fail("cto_state_unavailable", `canonical CTO state '${runId}' is unavailable`);
  if (!checkpointClaimCurrent(cwd, runId, teamId, authority, state)) return fail("worker_authority_denied", "native stage advance requires the current CTO coordinator claim");
  const progress = state.native_stage_progress?.[teamId];
  if (progress?.advance_history?.some((record) => record.operation_id === operationId)) return { ok: true, progress };
  const readiness = evaluateNativeStageReadiness(cwd, runId, teamId);
  if (!readiness.ok) return readiness;
  if (!readiness.ready) return fail("native_stage_not_ready", readiness.missing.join("; "));
  const contract = progressContract(cwd, state, teamId);
  if ("error" in contract) return fail(contract.code, contract.error);
  if (!contract.progress) return fail("stage_assignment_unavailable", `native stage '${teamId}' has not been admitted`);
  const currentProgress = contract.progress;
  const currentIndex = contract.profile.stages.findIndex((stage) => stage.id === currentProgress.stage_id);
  if (currentIndex < 0) return fail("stage_unavailable", `native stage '${currentProgress.stage_id}' is not in the current profile`);
  let nextStage: StageDef | undefined = contract.profile.stages[currentIndex + 1];
  const loopStageIds = loopStageIdsForProfile(contract.profile);
  let nextIteration = nextStage
    && loopStageIds.has(currentProgress.stage_id)
    && loopStageIds.has(nextStage.id)
    ? currentProgress.iteration
    : 1;
  const currentLoop = contract.stage.loop;
  if (currentLoop) {
    const until = nativePredicate(cwd, runId, state, teamId, contract.stage, currentLoop.until);
    if (!until.ok) return fail("stage_gate_invalid", until.error);
    if (!until.value) {
      const decision = loopReentryDecision({
        stage_id: contract.stage.id,
        back_to: currentLoop.back_to,
        until: currentLoop.until,
        max_iterations: currentLoop.max_iterations,
        on_exhausted: currentLoop.on_exhausted,
        reentries: Math.max(0, currentProgress.iteration - 1),
        epoch: currentProgress.capability_epoch,
        status: "running",
        history: [],
      }, currentLoop.max_iterations);
      if (decision.exhausted) {
        const outcome = loopExhaustionKind(currentLoop.on_exhausted);
        const toRevision = currentProgress.revision + 1;
        const exhausted = {
          ...currentProgress,
          status: "complete" as const,
          approval: undefined,
          advance_history: [...(currentProgress.advance_history ?? []), {
            operation_id: operationId,
            from_stage_id: currentProgress.stage_id,
            from_revision: currentProgress.revision,
            to_stage_id: currentProgress.stage_id,
            to_revision: toRevision,
            at: now(),
          }],
          revision: toRevision,
          updated_at: now(),
        } satisfies NativeStageProgress;
        try {
          state.pause = { kind: outcome, reason: `loop '${contract.stage.id}' exhausted after ${currentLoop.max_iterations} iteration(s)` };
          state.native_stage_progress = { ...(state.native_stage_progress ?? {}), [teamId]: exhausted };
          writeCtoState(state, cwd, { assumeWorkspaceLock: true });
        } catch (error) {
          return fail("cto_state_conflict", `native loop exhaustion CAS failed: ${error instanceof Error ? error.message : String(error)}`);
        }
        return { ok: true, progress: exhausted };
      }
      nextStage = resolveBackToStage(contract.profile, currentLoop.back_to) ?? undefined;
      if (!nextStage) return fail("stage_unavailable", `loop '${contract.stage.id}' references missing back_to stage '${currentLoop.back_to}'`);
      nextIteration = decision.reentries + 2;
    }
  }
  while (nextStage?.skip_if) {
    const skip = nativePredicate(cwd, runId, state, teamId, nextStage, nextStage.skip_if);
    if (!skip.ok) return fail("stage_gate_invalid", skip.error);
    if (!skip.value) break;
    const nextIndex = contract.profile.stages.findIndex((stage) => stage.id === nextStage!.id);
    nextStage = nextIndex < 0 ? undefined : contract.profile.stages[nextIndex + 1];
    nextIteration = nextStage
      && loopStageIds.has(currentProgress.stage_id)
      && loopStageIds.has(nextStage.id)
      ? currentProgress.iteration
      : 1;
  }
  const toStageId = nextStage?.id ?? currentProgress.stage_id;
  const toRevision = currentProgress.revision + 1;
  const advanceRecord = {
    operation_id: operationId,
    from_stage_id: currentProgress.stage_id,
    from_revision: currentProgress.revision,
    to_stage_id: toStageId,
    to_revision: toRevision,
    at: now(),
  };
  let nextProgress: NativeStageProgress;
  if (!nextStage) {
    const { approval: _approval, ...withoutApproval } = currentProgress;
    nextProgress = { ...withoutApproval, status: "complete", advance_history: [...(currentProgress.advance_history ?? []), advanceRecord], revision: toRevision, updated_at: now() };
  } else {
    const slots = resolveSlots(cwd, state, teamId, nextStage);
    if ("error" in slots) return fail("roster_unavailable", slots.error);
    const ids = capability(state.id, contract.wave.id, teamId, nextStage.id, nextIteration, contract.profile_hash);
    nextProgress = {
      schema: 1,
      run_id: state.id,
      wave_id: contract.wave.id,
      slice_id: contract.team.slice_id!,
      team_id: teamId,
      workflow: contract.profile.name,
      stage_id: nextStage.id,
      stage_cursor: nextStage.id,
      profile_hash: contract.profile_hash,
      capability_id: ids.id,
      capability_epoch: ids.epoch,
      iteration: nextIteration,
      declared_outputs: outputIds(nextStage),
      declared_slots: slots,
      assignments: {},
      status: "ready",
      revision: toRevision,
      advance_history: [...(currentProgress.advance_history ?? []), advanceRecord],
      updated_at: now(),
    };
  }
  try {
    state.native_stage_progress = { ...(state.native_stage_progress ?? {}), [teamId]: nextProgress };
    writeCtoState(state, cwd, { assumeWorkspaceLock: true });
  } catch (error) {
    return fail("cto_state_conflict", `native stage advance CAS failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  return { ok: true, progress: nextProgress };
}

/** Root-owned advance ingress: derive the current CTO team from a slice and claim, never from model stage fields. */
export function advanceNativeStageForCoordinator(input: NativeStageAdvanceRequest): NativeStageMutationResult {
  if (!/^[A-Za-z0-9._-]+$/.test(input.operation_id) || input.operation_id === "." || input.operation_id === "..") {
    return fail("stage_transition_invalid", "native stage operation id is unsafe");
  }
  const authority: NativeStageCheckpointAuthority = {
    run_id: input.runId,
    team_id: "",
    coordinator_session_id: input.coordinator_session_id,
    ownership_epoch: input.ownership_epoch,
    ...(input.coordinator_process_id === undefined ? {} : { coordinator_process_id: input.coordinator_process_id }),
  };
  try {
    return withWorkspaceTransaction(input.cwd, () => {
      const state = readCtoState(input.runId, input.cwd);
      if (!state) return fail("cto_state_unavailable", `canonical CTO state '${input.runId}' is unavailable`);
      const teams = state.teams.filter((team) => team.slice_id === input.sliceId);
      if (teams.length !== 1) return fail("worker_assignment_unavailable", `slice '${input.sliceId}' does not resolve to one CTO team`);
      const team = teams[0]!;
      const scopedAuthority = { ...authority, team_id: team.id };
      return advanceNativeStageCanonical(input.cwd, input.runId, team.id, scopedAuthority, input.operation_id);
    });
  } catch (error) {
    return fail("cto_state_conflict", `native stage advance transaction failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}