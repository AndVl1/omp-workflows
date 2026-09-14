import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { PinnedProjectRoot } from "../specification/pinned-root.js";
import { deriveRuntimeSecretKey, readOrCreateRootRuntimeSecret } from "../runtime-secret.js";
import type { ConstitutionBinding } from "../specification/types.js";
import type { Classification, TeamState } from "./types.js";
import { canonicalJson, digestOf } from "../specification/validation.js";

export interface PreparationRootIdentity {
  canonical_path: string;
  dev: number;
  ino: number;
}

/** Maximum UTF-8 bytes for the task carried by a preparation handoff. */
export const MAX_PREPARATION_HANDOFF_TASK_BYTES = 4096;
const PREPARATION_TASK_CONTROL_OR_FORMAT = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

/** Validate task text shared by the public schema, producer, and state reader. */
export function isValidPreparationHandoffTask(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && Buffer.byteLength(value, "utf8") <= MAX_PREPARATION_HANDOFF_TASK_BYTES
    && !PREPARATION_TASK_CONTROL_OR_FORMAT.test(value);
}

export type PreparationSourceKind = "native" | "legacy" | "external";

/** Opaque authority returned by workflow_prepare and consumed by native start. */
export interface WorkflowPreparationHandoff {
  schema_version: 1;
  status: "prepared";
  token: string;
  digest: string;
  feature_id: string;
  run_key: string;
  branch: string;
  task: string;
  classification: Classification;
  state_revision: number;
  state_digest: string;
  root_identity: PreparationRootIdentity;
  /** Native preparation source and constitution metadata authenticated by the root-scoped proof. */
  source_kind?: PreparationSourceKind;
  constitution_binding?: ConstitutionBinding | null;
  constitution_gate_ref?: string | null;
  /** Maximum native worker capacity authorized by this handoff. */
  capacity?: number;
  /** Root-scoped HMAC over the complete unsigned handoff and its binding metadata. */
  auth_proof?: string;
}

/** Durable postimage proving native begin and subsequent dispatch consumed that authority. A begun marker is written atomically with capability issuance. */
export interface NativePreparationStartMarker {
  status: "begun" | "started";
  phase: "specify" | "plan" | "tasks";
  capability_id: string;
  capability_epoch?: string;
  request_id: string;
  dispatch_id?: string;
  start_postimage_digest: string;
  token: string;
  preparation_digest: string;
  preparation_state_revision?: number;
  expected_state_revision?: number;
  profile_hash?: string;
  policy_hash?: string;
  expected_roster?: Array<{ role: string; agent: string; slot_id?: string; semantic_role?: string; occurrence?: number; facet?: string | null }>;
  /* Optional exact CTO routing marker supplied by the engine for preparation waves. */
  cto_slice_marker?: string;
}

export interface PreparationHandoffAuthentication {
  source_kind: PreparationSourceKind;
  constitution_binding: ConstitutionBinding | null;
  constitution_gate_ref: string | null;
  capacity: number;
  pinned_root: PinnedProjectRoot;
}

type PreparationHandoffUnsigned = Omit<WorkflowPreparationHandoff, "digest">;
type PreparationHandoffAuthUnsigned = Omit<PreparationHandoffUnsigned, "auth_proof">;
const PREPARATION_HANDOFF_AUTH_DOMAIN = "native-preparation-handoff-v1";

function preparationHandoffAuthPayload(value: PreparationHandoffAuthUnsigned): Record<string, unknown> {
  return {
    domain: PREPARATION_HANDOFF_AUTH_DOMAIN,
    root_identity: value.root_identity,
    feature_id: value.feature_id,
    run_key: value.run_key,
    branch: value.branch,
    workflow: value.classification.workflow ?? "",
    state_revision: value.state_revision,
    state_digest: value.state_digest,
    source_kind: value.source_kind ?? null,
    constitution_binding: value.constitution_binding ?? null,
    constitution_gate_ref: value.constitution_gate_ref ?? null,
    capacity: value.capacity ?? null,
    handoff: value,
  };
}

function preparationHandoffAuthProof(pinnedRoot: PinnedProjectRoot, value: PreparationHandoffAuthUnsigned): string | null {
  if (!pinnedRoot.isStable()) return null;
  const master = readOrCreateRootRuntimeSecret(pinnedRoot);
  const key = master ? deriveRuntimeSecretKey(master, PREPARATION_HANDOFF_AUTH_DOMAIN) : null;
  if (!key) return null;
  return createHmac("sha256", key).update(canonicalJson(preparationHandoffAuthPayload(value)), "utf8").digest("hex");
}

export function verifyPreparationHandoffAuth(pinnedRoot: PinnedProjectRoot, value: WorkflowPreparationHandoff): boolean {
  if (!pinnedRoot.isStable() || !value || typeof value !== "object" || Array.isArray(value)) return false;
  const rootIdentity = value.root_identity;
  const classification = value.classification;
  if (!rootIdentity || typeof rootIdentity !== "object" || Array.isArray(rootIdentity)
    || !classification || typeof classification !== "object" || Array.isArray(classification)) return false;
  if (!value.auth_proof || !/^[a-f0-9]{64}$/u.test(value.auth_proof)) return false;
  if (rootIdentity.canonical_path !== pinnedRoot.canonical_root || rootIdentity.dev !== pinnedRoot.dev || rootIdentity.ino !== pinnedRoot.ino) return false;
  const { auth_proof: _authProof, digest: _digest, ...unsigned } = value;
  const expected = preparationHandoffAuthProof(pinnedRoot, unsigned);
  if (!expected) return false;
  const provided = Buffer.from(value.auth_proof, "hex");
  const computed = Buffer.from(expected, "hex");
  return provided.length === computed.length && timingSafeEqual(provided, computed);
}

export function newPreparationToken(): string {
  return randomUUID();
}

export function preparationHandoffDigest(value: PreparationHandoffUnsigned): string {
  return digestOf(value);
}

export function createPreparationHandoff(
  input: Omit<WorkflowPreparationHandoff, "digest" | "token" | "schema_version" | "status" | "auth_proof"> & {
    token?: string;
    auth_proof?: string;
    authentication?: PreparationHandoffAuthentication;
  },
): WorkflowPreparationHandoff {
  if (!isValidPreparationHandoffTask(input.task)) {
    throw new Error(`preparation handoff task must be bounded line-inert text of at most ${MAX_PREPARATION_HANDOFF_TASK_BYTES} UTF-8 bytes`);
  }
  const unsignedWithoutAuth: PreparationHandoffAuthUnsigned = {
    schema_version: 1,
    status: "prepared",
    token: input.token ?? newPreparationToken(),
    feature_id: input.feature_id,
    run_key: input.run_key,
    branch: input.branch,
    task: input.task,
    classification: input.classification,
    state_revision: input.state_revision,
    state_digest: input.state_digest,
    root_identity: input.root_identity,
    ...(input.source_kind === undefined ? {} : { source_kind: input.source_kind }),
    ...(input.constitution_binding === undefined ? {} : { constitution_binding: input.constitution_binding }),
    ...(input.constitution_gate_ref === undefined ? {} : { constitution_gate_ref: input.constitution_gate_ref }),
    ...(input.capacity === undefined ? {} : { capacity: input.capacity }),
  };
  const authentication = input.authentication;
  const authProof = authentication
    ? preparationHandoffAuthProof(authentication.pinned_root, {
        ...unsignedWithoutAuth,
        source_kind: authentication.source_kind,
        constitution_binding: authentication.constitution_binding,
        constitution_gate_ref: authentication.constitution_gate_ref,
        capacity: authentication.capacity,
      })
    : input.auth_proof;
  if (authentication && !authProof) throw new Error("preparation handoff root-scoped authentication proof is unavailable");
  const unsigned: PreparationHandoffUnsigned = {
    ...unsignedWithoutAuth,
    ...(authentication ? {
      source_kind: authentication.source_kind,
      constitution_binding: authentication.constitution_binding,
      constitution_gate_ref: authentication.constitution_gate_ref,
      capacity: authentication.capacity,
    } : {}),
    ...(authProof == null ? {} : { auth_proof: authProof }),
  };
  return { ...unsigned, digest: preparationHandoffDigest(unsigned) };
}

/**
 * Hash the prepared/start state semantics without handoff/start marker or
 * migration/profile projection metadata. Timestamps and observability are
 * non-authoritative state projections.
 */
export function preparationStateDigest(state: TeamState, stateRevision: number): string {
  const copy: Record<string, unknown> = { ...(state as unknown as Record<string, unknown>), state_revision: stateRevision };
  delete copy.preparation_handoff;
  delete copy.work_identity;
  delete copy.control_plane_provenance;
  const capability = copy.dispatch_capability;
  if (capability && typeof capability === "object" && !Array.isArray(capability)) { copy.dispatch_capability = { ...(capability as Record<string, unknown>) }; delete (copy.dispatch_capability as Record<string, unknown>).dispatch_token_hash; delete (copy.dispatch_capability as Record<string, unknown>).advance_token_hash; const issuedFor = (copy.dispatch_capability as Record<string, unknown>).issued_for; if (issuedFor && typeof issuedFor === "object" && !Array.isArray(issuedFor)) { (copy.dispatch_capability as Record<string, unknown>).issued_for = { ...(issuedFor as Record<string, unknown>), cursor_epoch: undefined }; } }
  delete copy.preparation_start;
  delete copy.completion_intent;
  delete copy.checkpoint_policy;
  delete copy.roster_policy;
  delete copy.migration;
  delete copy.updated_at;
  delete copy.observability;
  return digestOf(copy);
}

export function preparationStartPostimageDigest(state: TeamState): string {
  const capability = state.dispatch_capability;
  const dispatches = capability?.dispatches ?? [];
  return digestOf({
    feature_id: state.specification?.feature_id,
    run_key: state.run_key,
    phase: state.stage_cursor,
    capability: capability && {
      capability_id: capability.capability_id,
      status: capability.status,
      issued_for: capability.issued_for && { run_key: capability.issued_for.run_key, branch: capability.issued_for.branch, workflow: capability.issued_for.workflow, profile_hash: capability.issued_for.profile_hash, stage_cursor: capability.issued_for.stage_cursor },
      expected_roster: capability.expected_roster,
      policy_hash: capability.policy_hash,
      dispatches: dispatches.map((record) => ({ id: record.id, purpose: record.purpose, phase_version: record.phase_version, role: record.role, agent: record.agent, tool_call_id: record.tool_call_id, status: record.status, work_identity: record.work_identity }))
    }
  });
}

export function preparationHandoffUnsigned(value: WorkflowPreparationHandoff): PreparationHandoffUnsigned {
  const { digest: _digest, ...unsigned } = value;
  return unsigned;
}

export function verifyPreparationHandoffDigest(value: WorkflowPreparationHandoff): boolean {
  return value.digest === preparationHandoffDigest(preparationHandoffUnsigned(value));
}
