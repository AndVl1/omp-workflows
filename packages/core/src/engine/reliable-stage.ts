import { createHash } from "node:crypto";
import { join, resolve, relative } from "node:path";

import type { NativeWorkerBinding } from "../native-worker-authority.js";
import { activeWave, readCtoState } from "../cto/state.js";
import { resolveNativeStageProducer, type NativeStageProducerDescriptor } from "../cto/native-stage.js";
import { validateProducedArtifact } from "./artifact-contract.js";
import { isSafeArtifactId, readArtifactFileSafe, type ArtifactFileRead } from "./artifacts.js";
import { acceptTrustedStageResult, type TrustedStageResultInput } from "./durable.js";
import { isRecord } from "./control-plane-contract.js";
import { loadProfile } from "./profile.js";
import type { StatePublication } from "./state.js";
import type { StageReceiptLedger, TeamState, TrustedExecutionContext, WorkIdentity, WorkflowName } from "./types.js";
import { readRunState, runTarget } from "./run-store.js";

export type StageAuthority = "ordinary" | "cto";

export interface StageProducerCommon {
  readonly authority: StageAuthority;
  readonly identity: WorkIdentity;
  readonly host: {
    readonly session_id: string;
    readonly worktree: string;
    readonly branch: string;
  };
}

export type StageProducerBinding =
  | (StageProducerCommon & {
      readonly producer: {
        readonly kind: "worker";
        readonly profile: WorkflowName;
        readonly role: string;
        readonly slot_id: string;
        readonly agent: string;
        readonly generation: number;
        readonly wave_id: string;
        readonly slice_id: string;
        readonly stage_id: string;
        readonly iteration: number;
        readonly lineage: {
          readonly session_id: string;
          readonly session_file: string;
          readonly parent_session_file: string;
          readonly parent_tool_call_id: string;
          readonly lifecycle_id: string;
        };
      };
    })
  | (StageProducerCommon & {
      readonly producer: {
        readonly kind: "orchestrator";
        readonly profile: WorkflowName;
        readonly stage_id: string;
        readonly iteration: number;
        readonly generation: number;
        readonly wave_id: string;
        readonly slice_id: string;
        readonly owner: "main-session" | "native-lead";
      };
    })
  | (StageProducerCommon & {
      readonly producer: {
        readonly kind: "tool";
        readonly profile: WorkflowName;
        readonly stage_id: string;
        readonly iteration: number;
        readonly generation: number;
        readonly wave_id: string;
        readonly slice_id: string;
        readonly tool_name: string;
      };
    });

export interface TrustedToolCallback {
  readonly registration_id: string;
  readonly invocation_id: string;
  readonly host_session_id: string;
  /** Opaque host-created proof; never copied to a receipt. */
  readonly proof: symbol;
}

/** Trusted host output of a resolver; callback proof is intentionally private to this envelope. */
export interface StageHostBinding {
  readonly binding: StageProducerBinding;
  readonly native?: NativeWorkerBinding;
  readonly callback?: TrustedToolCallback;
}

export interface StageNativeBindingInput {
  readonly cwd: string;
  readonly runId: string;
  readonly authority: StageAuthority;
  readonly native: NativeWorkerBinding;
  readonly toolName?: string;
  readonly callback?: TrustedToolCallback;
}


/** Exact model-facing shape. All authority fields are host-derived. */
export interface StageResultSubmission {
  readonly outputs: Record<string, unknown>;
}

export interface StageReceiptOutput {
  readonly artifact_id: string;
  readonly immutable_ref: string;
  readonly sha256: string;
}

export interface StageReceiptEvidence {
  readonly artifact_id: string;
  readonly relative_path: string;
  readonly immutable_ref: string;
  readonly sha256: string;
}

export interface StageResultReceipt {
  readonly receipt_id: string;
  readonly submission_id: string;
  readonly binding: StageProducerBinding;
  readonly digest: string;
  readonly outputs: readonly StageReceiptOutput[];
  readonly evidence: readonly StageReceiptEvidence[];
  readonly accepted_at: string;
}
export type StageResultSubmissionOutcome =
  | { ok: true; receipt: StageResultReceipt }
  | {
      ok: false;
      code: string;
      error: string;
      field_errors?: readonly { field: string; message: string }[];
    };
/**
 * Host-private cold-revive path for an already accepted stage result.
 * A resolver may return only the persisted receipt; it MUST NOT construct a
 * binding or enter the result committer. `undefined` means this call is not
 * an exact accepted replay and normal live binding resolution may continue.
 */
export type AcceptedReplayResolver = (
  ctx: unknown,
  cwd: string,
  runId: string,
  outputs: Record<string, unknown>,
) => StageResultSubmissionOutcome | undefined;


export type StageRecoveryWorkerState = "not_started" | "running" | "disconnected" | "terminal" | "unknown" | "unsupported";
export type StageRecoveryAction = "none" | "observe" | "resume" | "retry" | "wait" | "clarify" | "cancel";

export interface StageRecoveryResult {
  readonly code: string;
  readonly worker: StageRecoveryWorkerState;
  readonly action: StageRecoveryAction;
  readonly attempts_remaining: number;
  readonly receipt?: StageResultReceipt;
  readonly retry_of?: string;
  readonly blocking_condition?: string;
  readonly next_action?: string;
}

export interface StageHostCapabilities {
  readonly runtime: string;
  readonly version: string;
  readonly trusted_lineage: "supported" | "unsupported" | "unknown";
  readonly terminal_lifecycle: "supported" | "unsupported" | "unknown";
  readonly preflight_not_started: "supported" | "unsupported" | "unknown";
  readonly inspect: "supported" | "unsupported" | "unknown";
  readonly resume: "supported" | "unsupported" | "unknown";
  readonly cancel_ack: "supported" | "unsupported" | "unknown";
}

export interface StageHostBindingResolver {
  (ctx: unknown, cwd: string, runId: string, authority: StageAuthority): StageHostBinding | undefined;
}

export interface StageResultCommitter {
  (input: {
    cwd: string;
    runId: string;
    binding: NativeWorkerBinding;
    trusted: TrustedStageResultInput;
  }): { ok: true; receipt: StageReceiptLedger } | { ok: false; code: string; error: string };
}

export interface StageResultValidationFailure {
  readonly run_id: string;
  readonly authority: StageAuthority;
  readonly binding: StageProducerBinding;
  readonly code: string;
  readonly error: string;
  readonly field_errors: readonly { field: string; message: string }[];
}

export type StageResultValidationPersistenceResult = { ok: true } | { ok: false; code: string };

export interface StageResultServiceOptions {
  cwd: string;
  runId: string;
  authority: StageAuthority;
  context: unknown;
  bindingResolver: StageHostBindingResolver;
  ctoCommitter?: StageResultCommitter;
  /**
   * Private cold-revive read-only replay. The resolver owns root claim
   * authentication and canonical lineage checks; a returned receipt is
   * returned directly and never passed through a committer.
   */
  acceptedReplay?: AcceptedReplayResolver;
  /** Engine-private canonical recording of producer format failures. */
  onValidationFailure?: (failure: StageResultValidationFailure) => StageResultValidationPersistenceResult;
}
export interface StagePublicationEvidence {
  readonly artifact_id: string;
  readonly relative_path: string;
}

/** Engine-private sidecars/evidence carried by deterministic renderer publication. */
export interface TrustedStagePublication {
  readonly evidence?: readonly StagePublicationEvidence[];
  readonly publication?: StatePublication;
}


export interface StageRecoveryServiceOptions {
  cwd: string;
  runId: string;
  authority: StageAuthority;
  operation: "diagnose" | "reconcile";
  context: unknown;
  bindingResolver: StageHostBindingResolver;
}

type StageOutput = { artifact_id: string; value: unknown; immutable_id: string; sha256: string };

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (isRecord(value)) return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, entry]) => [key, canonicalize(entry)]));
  return value;
}

function canonicalJson(value: unknown): string {
  const json = JSON.stringify(canonicalize(value));
  if (json === undefined) throw new Error("non-serializable stage output");
  return json;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function sha256Bytes(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");

}
function stateFor(cwd: string, runId: string, authority: StageAuthority): TeamState | null {
  return authority === "ordinary" ? readRunState(cwd, runId) : null;
}

function branchFor(cwd: string, runId: string, authority: StageAuthority): string {
  return authority === "ordinary" ? stateFor(cwd, runId, authority)?.branch ?? "" : readCtoState(runId, cwd)?.branch ?? "";
}

function artifactRoot(cwd: string, runId: string, authority: StageAuthority): string {
  return authority === "ordinary" ? runTarget(cwd, runId).artifactsDir : join(resolve(cwd), ".work-state", "cto", runId, "artifacts");
}

function evidencePathIssues(
  root: string,
  value: unknown,
  path: string,
  key: string,
  reads: Map<string, ArtifactFileRead>,
): Array<{ field: string; message: string }> {
  if (typeof value === "string") {
    const evidenceKey = key === "evidence_path" || key === "relative_evidence_path" || key === "evidence_ref";
    if (!evidenceKey) return [];
    let read = reads.get(value);
    if (!read) {
      read = readArtifactFileSafe(root, value);
      reads.set(value, read);
    }
    if (read.status !== "present") {
      return [{ field: path, message: "evidence reference is missing, outside the assigned artifact root, or symlinked" }];
    }
    return [];
  }
  if (Array.isArray(value)) {
    return value.flatMap((entry, index) => evidencePathIssues(root, entry, `${path}[${index}]`, key, reads));
  }
  if (isRecord(value)) {
    return Object.entries(value).flatMap(([childKey, childValue]) => evidencePathIssues(root, childValue, `${path}.${childKey}`, childKey, reads));
  }
  return [];
}

function declaredOutputs(authority: StageAuthority, cwd: string, runId: string, identity: WorkIdentity): Set<string> | null {
  if (authority === "ordinary") {
    const profile = loadProfile(identity.workflow);
    const stage = profile?.stages.find((candidate) => candidate.id === identity.stage_id);
    if (!stage) return null;
    const produces = Array.isArray(stage.produces) ? stage.produces : stage.produces ? [stage.produces] : [];
    return new Set(produces);
  }
  const state = readCtoState(runId, cwd);
  const progressValues = state?.native_stage_progress && typeof state.native_stage_progress === "object"
    ? Object.values(state.native_stage_progress as Record<string, unknown>)
    : [];
  const matches = progressValues.filter((value): value is Record<string, unknown> =>
    isRecord(value)
    && value.stage_id === identity.stage_id
    && value.capability_id === identity.capability_id
    && value.capability_epoch === identity.capability_epoch
    && isRecord(value.assignments)
    && isRecord(value.assignments[identity.dispatch_id])
  );
  if (matches.length !== 1) return null;
  const declared = matches[0]!.declared_outputs;
  if (!Array.isArray(declared) || !declared.every((id): id is string => typeof id === "string" && isSafeArtifactId(id))) return null;
  return new Set(declared);
}

function ordinaryAssignedIdentity(cwd: string, runId: string, binding: NativeWorkerBinding): WorkIdentity | null {
  const state = stateFor(cwd, runId, "ordinary");
  if (!state || state.run_id !== runId || state.run_key !== runId) return null;
  const origin = binding.dispatch_origin;
  const candidates = state.dispatch_capability?.dispatches?.filter((candidate) => {
    const terminalSuccess = candidate.status === "succeeded" && candidate.completion?.outcome === "succeeded";
    const current = candidate.status !== "succeeded" && candidate.status !== "failed" && candidate.status !== "cancelled";
    return (origin?.dispatch_id === undefined ? candidate.tool_call_id === binding.parent_tool_call_id : candidate.id === origin.dispatch_id)
      && (current || terminalSuccess)
      && candidate.agent === binding.agent;
  }) ?? [];
  if (candidates.length !== 1) return null;
  const record = candidates[0]!;
  const identity = record.work_identity;
  if (!identity) return null;
  if (
    identity.run_id !== runId
    || identity.stage_cursor !== state.stage_cursor
    || identity.stage_id !== state.stage_cursor
    || identity.worker_id !== binding.agent
    || (record.tool_call_id !== undefined && record.tool_call_id !== binding.parent_tool_call_id)
  ) return null;
  if (
    (origin?.run_id !== undefined && origin.run_id !== runId)
    || (origin?.cwd !== undefined && resolve(origin.cwd) !== resolve(cwd))
    || (origin?.capability_id !== undefined && origin.capability_id !== identity.capability_id)
    || (origin?.stage_id !== undefined && origin.stage_id !== identity.stage_id)
    || (origin?.cursor_epoch !== undefined && origin.cursor_epoch !== identity.capability_epoch)
    || (origin?.slot_id !== undefined && origin.slot_id !== identity.slot_id)
    || (origin?.task_id !== undefined && origin.task_id !== identity.task_id)
    || (origin?.origin_session_id !== undefined && origin.origin_session_id !== record.origin_session_id)
  ) return null;
  return structuredClone(identity);
}
function ordinaryAssignedRole(cwd: string, runId: string, dispatchId: string): string | null {
  const state = stateFor(cwd, runId, "ordinary");
  if (!state || state.run_id !== runId || state.run_key !== runId) return null;
  const record = state.dispatch_capability?.dispatches?.find((candidate) => candidate.id === dispatchId);
  return record?.role ?? null;
}


function assignedIdentityForNative(input: StageNativeBindingInput): WorkIdentity | null {
  if (input.authority === "ordinary") return ordinaryAssignedIdentity(input.cwd, input.runId, input.native);
  const identity = input.native.assigned_identity;
  if (!identity || identity.run_id !== input.runId || identity.session_id !== input.native.session_id) return null;
  return structuredClone(identity);
}

function workerProducerBinding(
  input: StageNativeBindingInput,
  identity: WorkIdentity,
  branch: string,
  descriptor?: NativeStageProducerDescriptor,
  ordinaryRole?: string,
): StageProducerBinding {
  return {
    authority: input.authority,
    identity,
    host: { session_id: input.native.session_id, worktree: input.cwd, branch },
    producer: {
      kind: "worker",
      profile: descriptor?.profile ?? identity.workflow,
      stage_id: descriptor?.stage_id ?? identity.stage_id,
      iteration: descriptor?.iteration ?? identity.loop_iteration ?? 1,
      generation: descriptor?.generation ?? stateFor(input.cwd, input.runId, input.authority)?.rework_generation ?? 0,
      wave_id: descriptor?.wave_id ?? identity.wave_id,
      slice_id: descriptor?.slice_id ?? identity.slice_id,
      role: descriptor?.role ?? ordinaryRole ?? input.native.agent,
      slot_id: identity.slot_id,
      agent: descriptor?.agent ?? input.native.agent,
      lineage: {
        session_id: input.native.session_id,
        session_file: input.native.session_file,
        parent_session_file: input.native.parent_session_file,
        parent_tool_call_id: input.native.parent_tool_call_id,
        lifecycle_id: input.native.lifecycle_id,
      },
    },
  };
}

/** Resolve a raw worker/lead binding against the current persisted assignment. */
export function deriveWorkerStageHostBinding(input: StageNativeBindingInput): StageHostBinding | null {
  const expectedKind = input.authority === "ordinary" ? "workflow" : "cto";
  const native = input.native;
  if (
    native.resolution.kind !== expectedKind
    || native.resolution.runId !== input.runId
    || (native.resolution.actor !== "worker" && native.resolution.actor !== "lead")
  ) return null;
  const branch = branchFor(input.cwd, input.runId, input.authority);
  if (!branch) return null;
  if (input.authority === "cto") {
    const descriptor = resolveNativeStageProducer(input.cwd, input.runId, native);
    if (!descriptor || descriptor.identity.run_id !== input.runId || descriptor.agent !== native.agent) return null;
    if (descriptor.kind === "tool") {
      if (
        !descriptor.tool_name
        || input.toolName !== descriptor.tool_name
        || !input.callback
        || input.callback.proof !== TRUSTED_TOOL_PROOF
        || input.callback.host_session_id !== native.session_id
      ) return null;
      return {
        binding: {
          authority: "cto",
          identity: structuredClone(descriptor.identity),
          host: { session_id: native.session_id, worktree: input.cwd, branch },
          producer: {
            kind: "tool",
            profile: descriptor.profile,
            stage_id: descriptor.stage_id,
            iteration: descriptor.iteration,
            generation: descriptor.generation,
            wave_id: descriptor.wave_id,
            slice_id: descriptor.slice_id,
            tool_name: descriptor.tool_name,
          },
        },
        native,
        callback: input.callback,
      };
    }
    if (input.toolName !== undefined || input.callback !== undefined) return null;
    if (descriptor.kind === "orchestrator") {
      return {
        binding: {
          authority: "cto",
          identity: structuredClone(descriptor.identity),
          host: { session_id: native.session_id, worktree: input.cwd, branch },
          producer: {
            kind: "orchestrator",
            profile: descriptor.profile,
            stage_id: descriptor.stage_id,
            iteration: descriptor.iteration,
            generation: descriptor.generation,
            wave_id: descriptor.wave_id,
            slice_id: descriptor.slice_id,
            owner: "native-lead",
          },
        },
        native,
      };
    }
    return {
      binding: workerProducerBinding(input, descriptor.identity, branch, descriptor),
      native,
    };
  }
  if (input.toolName !== undefined || input.callback !== undefined) return null;
  const identity = assignedIdentityForNative(input);
  if (!identity || identity.run_id !== input.runId || identity.worker_id !== native.agent) return null;
  const role = ordinaryAssignedRole(input.cwd, input.runId, identity.dispatch_id);
  if (!role) return null;
  return { binding: workerProducerBinding(input, identity, branch, undefined, role), native };
}

function sameProducerBinding(left: StageProducerBinding, right: StageProducerBinding): boolean {
  try {
    return canonicalJson(left) === canonicalJson(right);
  } catch {
    return false;
  }
}

const TRUSTED_TOOL_PROOF = Symbol("omp.trusted-stage-tool-callback");
const TRUSTED_RENDERER_PROOF = Symbol("omp.trusted-stage-renderer-callback");

export function createTrustedToolCallback(input: Omit<TrustedToolCallback, "proof">): TrustedToolCallback {
  return Object.freeze({ ...input, proof: TRUSTED_TOOL_PROOF });
}

export function createTrustedRendererCallback(input: Omit<TrustedToolCallback, "proof">): TrustedToolCallback {
  return Object.freeze({ ...input, proof: TRUSTED_RENDERER_PROOF });
}

function hostSessionId(context: unknown): string | null {
  if (!isRecord(context)) return null;
  try {
    const manager = context.sessionManager;
    // OMP ExtensionContext carries its live identity on the official manager,
    // not a session_id alias. Use the same manager-first rule as registration.
    if (manager !== undefined) {
      if (!manager || typeof manager !== "object" || !("getSessionId" in manager) || typeof manager.getSessionId !== "function") return null;
      const id = manager.getSessionId();
      return typeof id === "string" && id.length > 0 ? id : null;
    }
    return typeof context.session_id === "string" && context.session_id.length > 0 ? context.session_id : null;
  } catch {
    return null;
  }
}

export function deriveMainStageHostBinding(input: {
  readonly cwd: string;
  readonly runId: string;
  readonly context: TrustedExecutionContext;
  readonly toolName?: string;
  readonly callback?: TrustedToolCallback;
}): StageHostBinding | null {
  const context = input.context;
  if (context.caller !== "host" || context.authority !== "coordinator" || resolve(context.worktree) !== resolve(input.cwd)) return null;
  const state = stateFor(input.cwd, input.runId, "ordinary");
  const capability = state?.dispatch_capability;
  const issuedFor = capability?.issued_for;
  const identity = capability?.producer_assignment;
  const profile = identity ? loadProfile(identity.workflow) : undefined;
  const stage = profile?.stages.find((candidate) => candidate.id === identity?.stage_id);
  const branch = state?.branch;
  if (
    !state
    || !identity
    || !capability
    || !issuedFor
    || !profile
    || !stage
    || !branch
    || identity.run_id !== input.runId
    || identity.stage_id !== state.stage_cursor
    || identity.stage_cursor !== issuedFor.stage_cursor
    || identity.capability_id !== capability.capability_id
    || identity.capability_epoch !== issuedFor.cursor_epoch
    || identity.workflow !== state.classification.workflow
    || identity.session_id.length === 0
    || context.branch !== branch
  ) return null;
  const common = {
    authority: "ordinary" as const,
    identity: structuredClone(identity),
    host: { session_id: context.session_id, worktree: input.cwd, branch },
  };
  if (input.toolName !== undefined) {
    if (
      stage.type !== "orchestrator"
      || !stage.producer
      || stage.producer.kind !== "tool"
      || stage.producer.tool_name !== input.toolName
      || !input.callback
      || input.callback.proof !== TRUSTED_TOOL_PROOF
      || input.callback.host_session_id !== context.session_id
    ) return null;
    return {
      binding: {
        ...common,
        producer: {
          kind: "tool",
          profile: identity.workflow,
          stage_id: identity.stage_id,
          iteration: identity.loop_iteration ?? 1,
          generation: state.rework_generation ?? 0,
          wave_id: identity.wave_id,
          slice_id: identity.slice_id,
          tool_name: input.toolName,
        },
      },
      callback: input.callback,
    };
  }
  if (input.callback || stage.type !== "orchestrator" || stage.producer) return null;
  return {
    binding: {
      ...common,
      producer: {
        kind: "orchestrator",
        profile: identity.workflow,
        stage_id: identity.stage_id,
        iteration: identity.loop_iteration ?? 1,
        generation: state.rework_generation ?? 0,
        wave_id: identity.wave_id,
        slice_id: identity.slice_id,
        owner: "main-session",
      },
    },
  };
}

export function deriveRendererStageHostBinding(input: {
  readonly cwd: string;
  readonly runId: string;
  readonly renderer: string;
  readonly hostSessionId: string;
}): StageHostBinding | null {
  if (!input.renderer || !input.hostSessionId) return null;
  const state = stateFor(input.cwd, input.runId, "ordinary");
  const capability = state?.dispatch_capability;
  const issuedFor = capability?.issued_for;
  const identity = capability?.producer_assignment;
  const profile = identity ? loadProfile(identity.workflow) : undefined;
  const stage = profile?.stages.find((candidate) => candidate.id === identity?.stage_id);
  if (
    !state
    || !capability
    || !issuedFor
    || !identity
    || !profile
    || !stage
    || stage.type !== "document"
    || stage.document?.renderer !== input.renderer
    || identity.run_id !== input.runId
    || identity.stage_id !== state.stage_cursor
    || identity.capability_id !== capability.capability_id
    || identity.capability_epoch !== issuedFor.cursor_epoch
  ) return null;
  const callback = createTrustedRendererCallback({
    registration_id: `engine-renderer:${input.renderer}`,
    invocation_id: identity.dispatch_id,
    host_session_id: input.hostSessionId,
  });
  return {
    binding: {
      authority: "ordinary",
      identity: structuredClone(identity),
      host: { session_id: input.hostSessionId, worktree: input.cwd, branch: state.branch },
      producer: {
        kind: "tool",
        profile: identity.workflow,
        stage_id: identity.stage_id,
        iteration: identity.loop_iteration ?? 1,
        generation: state.rework_generation ?? 0,
        wave_id: identity.wave_id,
        slice_id: identity.slice_id,
        tool_name: input.renderer,
      },
    },
    callback,
  };
}

function producerBindingFor(options: StageResultServiceOptions): StageHostBinding | null {
  const resolved = options.bindingResolver(options.context, options.cwd, options.runId, options.authority);
  if (!resolved) return null;
  if (resolved.binding.producer.kind === "worker") {
    if (!resolved.native) return null;
    const derived = deriveWorkerStageHostBinding({
      cwd: options.cwd,
      runId: options.runId,
      authority: options.authority,
      native: resolved.native,
    });
    if (!derived || !sameProducerBinding(derived.binding, resolved.binding)) return null;
    return derived;
  }
  const identity = resolved.binding.identity;
  const state = stateFor(options.cwd, options.runId, options.authority);
  const ctoState = options.authority === "cto" ? readCtoState(options.runId, options.cwd) : null;
  const ctoProgress = ctoState
    ? Object.values(ctoState.native_stage_progress ?? {}).find((candidate) => candidate.assignments[identity.dispatch_id]?.identity)
    : undefined;
  const ctoAssignment = ctoProgress?.assignments[identity.dispatch_id]?.identity;
  const ctoIdentityMatches = (() => {
    if (!ctoAssignment) return false;
    try {
      return canonicalJson(ctoAssignment) === canonicalJson(identity);
    } catch {
      return false;
    }
  })();
  const currentStageId = state?.stage_cursor ?? (ctoIdentityMatches ? ctoProgress?.stage_cursor : undefined);
  const branch = branchFor(options.cwd, options.runId, options.authority);
  const profile = loadProfile(identity.workflow);
  const stage = profile?.stages.find((candidate) => candidate.id === identity.stage_id);
  if (
    (!state && !ctoIdentityMatches)
    || !branch
    || !profile
    || !stage
    || identity.run_id !== options.runId
    || identity.stage_id !== currentStageId
    || identity.stage_cursor !== currentStageId
    || resolved.binding.authority !== options.authority
    || resolved.binding.host.branch !== branch
    || resolved.binding.host.worktree !== options.cwd
    || resolved.binding.host.session_id !== hostSessionId(options.context)
  ) return null;
  if (resolved.binding.producer.kind === "orchestrator" && stage.type !== "orchestrator") return null;
  if (resolved.binding.producer.kind === "tool") {
    const rendererBinding = stage.type === "document" && stage.document?.renderer === resolved.binding.producer.tool_name;
    const declaredToolBinding = stage.type === "orchestrator"
      && stage.producer?.kind === "tool"
      && stage.producer.tool_name === resolved.binding.producer.tool_name;
    if (
      (!rendererBinding && !declaredToolBinding)
      || !resolved.callback
      || (rendererBinding ? resolved.callback.proof !== TRUSTED_RENDERER_PROOF : resolved.callback.proof !== TRUSTED_TOOL_PROOF)
      || resolved.callback.host_session_id !== resolved.binding.host.session_id
    ) return null;
  }
  return resolved;
}

function isStageProducerBinding(value: unknown): value is StageProducerBinding {
  if (!isRecord(value) || !isRecord(value.host) || !isRecord(value.producer) || !isRecord(value.identity)) return false;
  if (Object.prototype.hasOwnProperty.call(value, "callback")) return false;
  if ((value.authority !== "ordinary" && value.authority !== "cto") || typeof value.host.session_id !== "string" || typeof value.host.worktree !== "string" || typeof value.host.branch !== "string") return false;
  if (value.producer.kind !== "worker" && value.producer.kind !== "orchestrator" && value.producer.kind !== "tool") return false;
  return true;
}

/** Internal cold-replay projection shared by ordinary and native readers. */
export function receiptFromLedger(binding: StageProducerBinding, ledger: StageReceiptLedger): StageResultReceipt {
  const persistedBinding = isStageProducerBinding(ledger.binding) ? ledger.binding : binding;
  return {
    receipt_id: ledger.receipt_id,
    submission_id: ledger.submission_id,
    binding: persistedBinding,
    digest: ledger.digest,
    outputs: ledger.outputs,
    evidence: ledger.evidence,
    accepted_at: ledger.accepted_at,
  };
}


function acceptedReceiptFor(options: StageResultServiceOptions, identity: WorkIdentity): StageReceiptLedger | undefined {
  const state = options.authority === "ordinary"
    ? stateFor(options.cwd, options.runId, "ordinary")
    : readCtoState(options.runId, options.cwd);
  return state?.stage_receipts?.[identity.dispatch_id];
}

function outputIssues(
  root: string,
  outputs: Record<string, unknown>,
  declared: Set<string> | null,
  allowMissingEvidence: boolean,
  evidenceReads: Map<string, ArtifactFileRead>,
): Array<{ field: string; message: string }> {
  const issues: Array<{ field: string; message: string }> = [];
  if (Object.keys(outputs).length === 0) issues.push({ field: "outputs", message: "at least one logical artifact is required" });
  if (declared) {
    for (const id of declared) {
      if (!Object.prototype.hasOwnProperty.call(outputs, id)) {
        issues.push({ field: `outputs.${id}`, message: "required artifact is missing" });
      }
    }
  }
  for (const [id, value] of Object.entries(outputs)) {
    if (!/^[A-Za-z0-9._-]+$/.test(id) || id === "." || id === "..") issues.push({ field: `outputs.${id}`, message: "artifact id is unsafe" });
    else if (declared && !declared.has(id)) issues.push({ field: `outputs.${id}`, message: "artifact is not declared by the current assigned stage" });
    const validation = validateProducedArtifact(id, value);
    if (!validation.ok) issues.push(...validation.issues.map((issue) => ({ field: `outputs.${id}${issue.field === "$" ? "" : issue.field.slice(1)}`, message: issue.message })));
    if (!allowMissingEvidence) issues.push(...evidencePathIssues(root, value, `outputs.${id}`, "", evidenceReads));
  }
  return issues;
}

export function submitStageResult(options: StageResultServiceOptions, input: unknown, trustedPublication?: TrustedStagePublication): StageResultSubmissionOutcome {
  if (!isRecord(input) || !isRecord(input.outputs)) return { ok: false, code: "invalid_submission", error: "submission input must contain only an outputs record", field_errors: [{ field: "outputs", message: "must be an object" }] };
  const outputs = input.outputs;
  if (options.acceptedReplay) {
    let readonlyReplay: StageResultSubmissionOutcome | undefined;
    try {
      readonlyReplay = options.acceptedReplay(options.context, options.cwd, options.runId, outputs);
    } catch {
      return { ok: false, code: "producer_authority_denied", error: "accepted replay authority could not be verified" };
    }
    if (readonlyReplay !== undefined) return readonlyReplay;
  }
  const host = producerBindingFor(options);
  if (!host) return { ok: false, code: "producer_authority_denied", error: "submission requires the exact current trusted producer binding" };
  const binding = host.binding;
  const native = host.native;
  const declared = declaredOutputs(options.authority, options.cwd, options.runId, binding.identity);
  if (!declared) return { ok: false, code: "stage_contract_unavailable", error: "the current assigned stage has no trusted output schema" };
  let submissionDigest: string;
  try {
    submissionDigest = sha256(`${canonicalJson(binding.identity)}\n${canonicalJson(outputs)}`);
  } catch {
    return { ok: false, code: "invalid_outputs", error: "submitted outputs are not serializable", field_errors: [{ field: "outputs", message: "outputs must be JSON-serializable" }] };
  }
  const previous = acceptedReceiptFor(options, binding.identity);
  const evidenceReads = new Map<string, ArtifactFileRead>();
  let exactReplay = false;
  if (previous?.digest === submissionDigest) {
    try {
      exactReplay = canonicalJson(previous.work_identity) === canonicalJson(binding.identity);
    } catch {
      exactReplay = false;
    }
  }
  const reportValidationFailure = (code: string, error: string, field_errors: readonly { field: string; message: string }[]): boolean => {
    if (previous || !options.onValidationFailure) return true;
    try {
      return options.onValidationFailure({
        run_id: options.runId,
        authority: options.authority,
        binding,
        code,
        error,
        field_errors,
      }).ok === true;
    } catch {
      return false;
    }
  };
  const issues = outputIssues(artifactRoot(options.cwd, options.runId, options.authority), outputs, declared, exactReplay, evidenceReads);
  if (issues.length > 0) {
    const error = "one or more submitted artifacts failed validation";
    if (!reportValidationFailure("invalid_outputs", error, issues)) {
      return {
        ok: false,
        code: "recovery_context_unavailable",
        error: "canonical recovery validation context could not be recorded",
        field_errors: issues,
      };
    }
    return { ok: false, code: "invalid_outputs", error, field_errors: issues };
  }
  let outputValues: StageOutput[];
  try {
    const assignmentKey = sha256(`${binding.identity.dispatch_id}|${binding.identity.attempt}`).slice(0, 32);
    outputValues = Object.entries(outputs).map(([artifact_id, value]) => ({
      artifact_id,
      value,
      immutable_id: `stage-${assignmentKey}-${artifact_id}`,
      sha256: sha256(canonicalJson(value)),
    }));
    const digest = submissionDigest;
    const outputEvidence = exactReplay
      ? []
      : Object.entries(outputs).flatMap(([artifact_id, value]) => {
        if (!isRecord(value) || typeof value.evidence_path !== "string") return [];
        const read = evidenceReads.get(value.evidence_path);
        return read?.status === "present"
          ? [{ artifact_id, relative_path: value.evidence_path, immutable_ref: "", sha256: sha256Bytes(read.bytes) }]
          : [];
      });
    const privateEvidenceIssues: Array<{ field: string; message: string }> = [];
    const privateEvidence = (trustedPublication?.evidence ?? []).flatMap(({ artifact_id, relative_path }) => {
      const root = artifactRoot(options.cwd, options.runId, options.authority);
      let read = evidenceReads.get(relative_path);
      if (!read) {
        read = readArtifactFileSafe(root, relative_path);
        evidenceReads.set(relative_path, read);
      }
      if (read.status !== "present") {
        privateEvidenceIssues.push({
          field: `publication.evidence.${artifact_id}`,
          message: "evidence reference is missing, outside the assigned artifact root, or symlinked",
        });
        return [];
      }
      return [{ artifact_id, relative_path, immutable_ref: "", sha256: sha256Bytes(read.bytes) }];
    });
    if (privateEvidenceIssues.length > 0) {
      return {
        ok: false,
        code: "invalid_outputs",
        error: "one or more publication evidence references failed validation",
        field_errors: privateEvidenceIssues,
      };
    }
    const receiptBase: StageReceiptLedger = {
      receipt_id: `receipt-${assignmentKey}`,
      submission_id: `submission-${assignmentKey}`,
      digest,
      dispatch_id: binding.identity.dispatch_id,
      attempt: binding.identity.attempt,
      accepted_at: "",
      work_identity: binding.identity,
      outputs: exactReplay && previous ? previous.outputs : outputValues.map((entry) => ({ artifact_id: entry.artifact_id, immutable_ref: "", sha256: entry.sha256 })),
      evidence: exactReplay && previous ? previous.evidence : [...outputEvidence, ...privateEvidence],
    };
    const trusted: TrustedStageResultInput = {
      run_id: options.runId,
      dispatch_id: binding.identity.dispatch_id,
      work_identity: binding.identity,
      binding,
      receipt: receiptBase,
      artifacts: outputValues.map(({ artifact_id, value, immutable_id }) => ({ artifact_id, value, immutable_id })),
      ...(trustedPublication?.publication ? { publication: trustedPublication.publication } : {}),
    };
    const committed = options.authority === "ordinary"
      ? acceptTrustedStageResult(options.cwd, trusted)
      : (native && options.ctoCommitter
        ? options.ctoCommitter({ cwd: options.cwd, runId: options.runId, binding: native, trusted })
        : { ok: false as const, code: "STAGE_HOST_UNSUPPORTED", error: "native CTO producer receipt commit is unavailable for this host" });
    if (!committed.ok) {
      return {
        ok: false,
        code: "code" in committed && typeof committed.code === "string" ? committed.code : "submission_rejected",
        error: committed.error,
      };
    }
    const ledger = "stage_receipt" in committed
      ? committed.stage_receipt
      : "receipt" in committed
        ? committed.receipt
        : undefined;
    if (!ledger) return { ok: false, code: "submission_not_committed", error: "submission transaction returned no receipt" };
    return { ok: true, receipt: receiptFromLedger(binding, ledger) };
  } catch {
    return { ok: false, code: "submission_persist_failed", error: "the stage submission transaction could not be committed" };
  }
}

function ordinaryRecovery(options: StageRecoveryServiceOptions): StageRecoveryResult {
  const state = readRunState(options.cwd, options.runId);
  if (!state) return { code: "run_unavailable", worker: "unsupported", action: "clarify", attempts_remaining: 0, blocking_condition: "ordinary run state is unavailable", next_action: "repair or select the canonical run" };
  const dispatches = state.dispatch_capability?.dispatches ?? [];
  const active = dispatches.find((record) => record.status === "authorized" || record.status === "running" || record.status === "pending");
  const terminal = dispatches.find((record) => record.status === "succeeded" || record.status === "failed" || record.status === "cancelled");
  if (terminal) return { code: "worker_terminal", worker: "terminal", action: "none", attempts_remaining: 0, retry_of: terminal.id, next_action: "wait for the stage evaluator or submit a linked producer correction" };
  if (!active) return { code: "worker_outcome_unknown", worker: "unknown", action: "wait", attempts_remaining: 0, blocking_condition: "no authoritative start or terminal event is persisted", next_action: "wait for a host lifecycle result; do not replace the worker" };
  if (active.status === "pending" && active.pending?.pending_reason === "awaiting_result" && active.pending.provider_ref?.startsWith("preflight:")) {
    return { code: "preflight_not_started", worker: "not_started", action: options.operation === "reconcile" ? "retry" : "observe", attempts_remaining: 0, retry_of: active.id, blocking_condition: "the host supplied a deterministic preflight refusal", next_action: options.operation === "reconcile" ? "request a new bounded assignment through the coordinator" : "reconcile the persisted preflight refusal before retrying" };
  }
  if (active.status === "running") return { code: "worker_running", worker: "running", action: "observe", attempts_remaining: 0, next_action: "wait for the authoritative terminal lifecycle" };
  return { code: "worker_outcome_unknown", worker: "unknown", action: "wait", attempts_remaining: 0, blocking_condition: "worker assignment exists but host start/terminal proof is unavailable", next_action: "do not create a replacement writer" };
}

function ctoRecovery(options: StageRecoveryServiceOptions): StageRecoveryResult {
  const state = readCtoState(options.runId, options.cwd);
  if (!state) return { code: "cto_state_unavailable", worker: "unsupported", action: "clarify", attempts_remaining: 0, blocking_condition: "canonical CTO state is unavailable", next_action: "reread or reconcile the exact CTO claim" };
  const wave = activeWave(state);
  if (!wave) return { code: "cto_wave_inactive", worker: "unknown", action: "wait", attempts_remaining: 0, blocking_condition: "no active native wave proves a worker assignment", next_action: "await a new admitted wave or explicit END" };
  const host = options.bindingResolver(options.context, options.cwd, options.runId, "cto");
  if (host?.binding.producer.kind === "worker" && host.binding.identity) return { code: "native_worker_running", worker: "running", action: "observe", attempts_remaining: 0, next_action: "wait for the authoritative native terminal lifecycle" };
  return { code: "native_worker_outcome_unknown", worker: "unknown", action: "wait", attempts_remaining: 0, blocking_condition: "native host exposes no authoritative preflight or reconnect event", next_action: "do not replace the native worker without a persisted terminal/preflight proof" };
}

export function recoverStage(options: StageRecoveryServiceOptions): StageRecoveryResult {
  if (options.operation !== "diagnose" && options.operation !== "reconcile") return { code: "invalid_recovery_operation", worker: "unsupported", action: "clarify", attempts_remaining: 0, blocking_condition: "unsupported recovery operation" };
  return options.authority === "ordinary" ? ordinaryRecovery(options) : ctoRecovery(options);
}

export const OMP_STAGE_HOST_CAPABILITIES: StageHostCapabilities = {
  runtime: "omp",
  version: "18.0.6",
  trusted_lineage: "supported",
  terminal_lifecycle: "supported",
  preflight_not_started: "unsupported",
  inspect: "unsupported",
  resume: "unsupported",
  cancel_ack: "unsupported",
};

export function stageBindingFor(options: StageResultServiceOptions): StageHostBinding | null {
  return producerBindingFor(options);
}
