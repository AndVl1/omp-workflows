import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";

import type { NativeWorkerBinding } from "../native-worker-authority.js";
import { validateProducedArtifact } from "../engine/artifact-contract.js";
import { isSafeArtifactId, readArtifactFileSafe } from "../engine/artifacts.js";
import { controlPlaneValueEquals, isRecord, validateWorkIdentityValue } from "../engine/control-plane-contract.js";
import type { TrustedStageResultInput } from "../engine/durable.js";
import { beginLifecycleTransaction, commitLifecycleTransaction, type LifecycleFileContent } from "../engine/lifecycle-journal.js";
import { readRunControlHeldLock } from "../engine/run-store.js";
import type { StageProducerBinding, StageResultCommitter } from "../engine/reliable-stage.js";
import { withWorkspaceTransaction } from "../engine/state.js";
import type { RunControl, StageReceiptLedger, WorkIdentity } from "../engine/types.js";
import { nativeStageGeneration, updateNativeStageAssignment } from "./native-stage.js";
import type { CtoState } from "./types.js";
import { ctoStatePath, parseCtoState } from "./state.js";

/** The result shape is intentionally the exact native branch of StageResultCommitter. */
export type NativeStageExecutionCommitResult =
  | { ok: true; receipt: StageReceiptLedger }
  | NativeStageExecutionFailure;

type NativeStageExecutionFailure = { ok: false; code: string; error: string };

type NativeTeam = CtoState["teams"][number];
type ArtifactPlan = {
  artifact_id: string;
  immutable_ref: string;
  body: string;
  sha256: string;
};
type EvidencePlan = {
  artifact_id: string;
  relative_path: string;
  immutable_ref: string;
  sha256: string;
  bytes: Buffer;
};
type ReceiptNormalization = {
  receipt: StageReceiptLedger;
  evidence: EvidencePlan[];
};

type StateRead = { raw: string; state: CtoState };



function canonicalize(value: unknown, ancestors = new Set<object>()): unknown {
  if (Array.isArray(value)) return value.map((entry) => canonicalize(entry, ancestors));
  if (!isRecord(value)) return value;
  if (ancestors.has(value)) throw new Error("cyclic stage output");
  ancestors.add(value);
  try {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalize(entry, ancestors)]),
    );
  } finally {
    ancestors.delete(value);
  }
}

function canonicalJson(value: unknown): string {
  const encoded = JSON.stringify(canonicalize(value));
  if (encoded === undefined) throw new Error("stage output is not JSON serializable");
  return encoded;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function sha256Bytes(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function sameIdentity(left: unknown, right: unknown): boolean {
  try {
    return controlPlaneValueEquals(left, right);
  } catch {
    return false;
  }
}

function failure(code: string, error: string): NativeStageExecutionFailure {
  return { ok: false, code, error };
}

function readCanonicalState(runId: string, cwd: string): StateRead | NativeStageExecutionCommitResult {
  const path = ctoStatePath(runId, cwd);
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return failure("cto_state_unavailable", `canonical CTO state for run '${runId}' is unavailable`);
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    return failure("cto_state_invalid", `canonical CTO state for run '${runId}' is not valid JSON`);
  }
  const parsed = parseCtoState(decoded, runId);
  if (!parsed.ok) return failure("cto_state_invalid", `canonical CTO state for run '${runId}' is invalid: ${parsed.error}`);
  return { raw, state: parsed.state };
}

function safeArtifactRoot(statePath: string): string | NativeStageExecutionCommitResult {
  const stateDir = dirname(statePath);
  try {
    const stateDirInfo = lstatSync(stateDir);
    if (!stateDirInfo.isDirectory() || stateDirInfo.isSymbolicLink()) return failure("artifact_root_invalid", "canonical CTO state directory is not a real directory");
  } catch {
    return failure("artifact_root_invalid", "canonical CTO state directory is unavailable");
  }
  const root = join(stateDir, "artifacts");
  try {
    const rootInfo = lstatSync(root);
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) return failure("artifact_root_invalid", "canonical CTO artifact directory is not a real directory");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") return failure("artifact_root_invalid", "canonical CTO artifact directory is unreadable");
  }
  return root;
}

function safeArtifactPath(root: string, reference: string): string | null {
  if (!reference || reference.startsWith("/") || reference.startsWith("\\") || /^[A-Za-z]:[\\/]/.test(reference)) return null;
  const candidate = resolve(root, reference);
  const canonicalRoot = resolve(root);
  const prefix = canonicalRoot.endsWith(sep) ? canonicalRoot : `${canonicalRoot}${sep}`;
  if (candidate !== canonicalRoot && !candidate.startsWith(prefix)) return null;
  return candidate;
}

function readPriorArtifact(root: string, reference: string): Buffer | null | NativeStageExecutionFailure {
  const path = safeArtifactPath(root, reference);
  if (!path) return failure("artifact_conflict", `immutable artifact '${reference}' escapes the CTO artifact root`);
  const read = readArtifactFileSafe(root, reference);
  if (read.status === "present") return read.bytes;
  if (read.status === "absent") return null;
  return failure("artifact_conflict", `immutable artifact '${path}' is unreadable: ${read.error}`);
}

function immutableEvidenceRef(relativePath: string, digest: string): string {
  const base = `evidence-${digest}`;
  return relativePath === base ? `${base}-immutable` : base;
}

function lifecycleContent(bytes: Buffer): LifecycleFileContent {
  const text = bytes.toString("utf8");
  return Buffer.from(text, "utf8").equals(bytes)
    ? text
    : { encoding: "base64", data: bytes.toString("base64") };
}

function identityFromTeam(team: NativeTeam): WorkIdentity[] {
  const identities: WorkIdentity[] = [];
  if (team.pending?.identity) identities.push(team.pending.identity);
  if (team.work_identity) identities.push(team.work_identity);
  return identities;
}

function hasTerminalSignal(assignment: unknown): boolean {
  return isRecord(assignment) && assignment.terminal_signal !== undefined;
}
function currentNativePublicationIssue(
  cwd: string,
  runId: string,
  binding: NativeWorkerBinding,
  identity: WorkIdentity,
  replay: boolean,
): NativeStageExecutionFailure | null {
  const owner = binding.publication_owner;
  if (!owner) return failure("worker_authority_denied", "native receipt publication has no verified CTO claim witness");
  // The caller holds the workspace transaction lock; use the validated image directly.
  let control: RunControl;
  try {
    control = readRunControlHeldLock(cwd);
  } catch {
    return failure("worker_authority_denied", "current CTO execution claim is unavailable for native receipt publication");
  }
  const claim = control.execution_claim;
  if (!claim || claim.owner_kind !== "cto" || claim.run_id !== runId || claim.released_at !== null) {
    return failure("worker_authority_denied", "native receipt publication requires the current active CTO execution claim");
  }
  if (
    owner.run_id !== runId
    || owner.claim_token !== claim.token
    || owner.ownership_epoch !== claim.ownership_epoch
    || owner.coordinator_session_id !== claim.coordinator_session_id
    || owner.coordinator_process_id !== claim.coordinator_process_id
    || owner.worker_id !== identity.worker_id
    || owner.assignment_dispatch_id !== identity.dispatch_id
  ) return failure("worker_authority_denied", "native receipt publication claim witness is stale");
  if (!replay && !claim.worker_ids.includes(owner.worker_id)) {
    return failure("worker_authority_denied", "native worker grant is not reserved by the current CTO execution claim");
  }
  return null;
}



function locateAssignedTeam(state: CtoState, binding: NativeWorkerBinding, identity: WorkIdentity): NativeTeam | NativeStageExecutionCommitResult {
  if (binding.cto_slice && (binding.cto_slice.runId !== state.id || binding.cto_slice.sliceId !== identity.slice_id)) {
    return failure("worker_assignment_conflict", "native binding slice does not match its assigned identity");
  }
  const candidates = state.teams.filter((team) =>
    team.slice_id === identity.slice_id && (binding.cto_team_id === undefined || team.id === binding.cto_team_id),
  );
  if (candidates.length !== 1) return failure("worker_assignment_unavailable", "canonical CTO state has no unique team assignment for the native worker");
  const team = candidates[0]!;
  if (binding.cto_team_id !== undefined && team.id !== binding.cto_team_id) return failure("worker_assignment_conflict", "native binding team does not match canonical CTO state");
  const progress = state.native_stage_progress?.[team.id];
  if (progress) {
    if (
      progress.run_id !== state.id
      || progress.team_id !== team.id
      || progress.slice_id !== identity.slice_id
      || progress.stage_id !== identity.stage_id
      || progress.stage_cursor !== identity.stage_cursor
      || progress.workflow !== identity.workflow
      || progress.capability_id !== identity.capability_id
      || progress.capability_epoch !== identity.capability_epoch
      || progress.iteration !== (identity.loop_iteration ?? 1)
    ) return failure("worker_assignment_conflict", "native assigned identity is stale for the current persisted stage progress");
    const assignment = progress.assignments[identity.dispatch_id];
    if (!assignment || !sameIdentity(assignment.identity, identity)) return failure("worker_assignment_conflict", "native assigned identity does not match the current persisted stage assignment");
    if (hasTerminalSignal(assignment)) return failure("worker_assignment_conflict", "native stage assignment has a terminal preflight signal and cannot accept a stage result");
    return team;
  }
  const persisted = identityFromTeam(team);
  if (persisted.length === 0 || persisted.some((entry) => !sameIdentity(entry, identity))) {
    return failure("worker_assignment_conflict", "native assigned identity does not match the team pending/work identity persisted in canonical CTO state");
  }
  return team;
}

function validateNativeBinding(input: Parameters<StageResultCommitter>[0]): NativeStageExecutionCommitResult | null {
  const { binding, runId, trusted } = input;
  const assigned = binding.assigned_identity;
  if (binding.resolution.kind !== "cto" || binding.resolution.runId !== runId || (binding.resolution.actor !== "worker" && binding.resolution.actor !== "lead")) return failure("worker_authority_denied", "native CTO receipt commit requires the exact CTO host lineage");
  if (!assigned) return failure("worker_assignment_unavailable", "native host binding has no assigned identity");
  const identityValidation = validateWorkIdentityValue(assigned);
  if (!identityValidation.ok) return failure("worker_assignment_conflict", "native assigned identity is malformed");
  if (binding.session_id !== assigned.session_id || assigned.run_id !== runId || assigned.dispatch_id !== trusted.dispatch_id || !Number.isInteger(assigned.attempt) || assigned.attempt < 1) {
    return failure("worker_assignment_conflict", "native assigned identity has an invalid run, dispatch, attempt, or session binding");
  }
  if (trusted.run_id !== runId || !sameIdentity(trusted.work_identity, assigned)) return failure("worker_assignment_conflict", "trusted stage result identity does not match the native assigned identity");
  const producerBinding = trusted.binding;
  const producer = producerBinding?.producer;
  if (
    !producerBinding
    || producerBinding.authority !== "cto"
    || !sameIdentity(producerBinding.identity, assigned)
    || producerBinding.host.session_id !== assigned.session_id
    || !producer
    || producer.profile !== assigned.workflow
    || producer.stage_id !== assigned.stage_id
    || producer.iteration !== (assigned.loop_iteration ?? 1)
    || !Number.isSafeInteger(producer.generation)
    || producer.generation < 0
    || producer.wave_id !== assigned.wave_id
    || producer.slice_id !== assigned.slice_id
    || (binding.resolution.actor === "lead"
      ? !(producer.kind === "tool" || (producer.kind === "orchestrator" && producer.owner === "native-lead"))
      : producer.kind !== "worker" || producer.slot_id !== assigned.slot_id)
  ) return failure("worker_assignment_conflict", "trusted producer binding does not match the native assigned identity");
  if (trusted.receipt.binding !== undefined && !sameIdentity(trusted.receipt.binding, trusted.binding)) {
    return failure("worker_assignment_conflict", "trusted receipt producer binding does not match its submission binding");
  }
  if (trusted.receipt.dispatch_id !== assigned.dispatch_id || trusted.receipt.attempt !== assigned.attempt || !sameIdentity(trusted.receipt.work_identity, assigned)) {
    return failure("worker_assignment_conflict", "trusted receipt identity does not match the native assigned identity");
  }
  if (!Array.isArray(trusted.receipt.evidence)) return failure("invalid_outputs", "native stage receipt evidence ledger is malformed");
  if (typeof trusted.receipt.receipt_id !== "string" || trusted.receipt.receipt_id.length === 0 || typeof trusted.receipt.submission_id !== "string" || trusted.receipt.submission_id.length === 0 || typeof trusted.receipt.digest !== "string" || trusted.receipt.digest.length === 0) return failure("invalid_outputs", "native stage receipt identifiers are malformed");
  if (!Array.isArray(trusted.artifacts) || trusted.artifacts.length === 0) return failure("invalid_outputs", "native stage submission must include at least one artifact");
  if (!Array.isArray(trusted.receipt.outputs)) return failure("invalid_outputs", "native stage receipt output ledger is malformed");
  const artifactIds = new Set<string>();
  const immutableIds = new Set<string>();
  const outputRows = new Map<string, { sha256: string; immutable_ref: string }>();
  for (const output of trusted.receipt.outputs) {
    if (!isRecord(output) || typeof output.artifact_id !== "string" || typeof output.sha256 !== "string" || typeof output.immutable_ref !== "string") return failure("invalid_outputs", "native stage receipt output ledger is malformed");
    if (outputRows.has(output.artifact_id)) return failure("invalid_outputs", "native stage receipt contains duplicate artifact ids");
    outputRows.set(output.artifact_id, { sha256: output.sha256, immutable_ref: output.immutable_ref });
  }
  for (const artifact of trusted.artifacts) {
    if (!isRecord(artifact) || typeof artifact.artifact_id !== "string" || typeof artifact.immutable_id !== "string") return failure("invalid_outputs", "native stage artifact payload is malformed");
    if (!isSafeArtifactId(artifact.artifact_id) || artifactIds.has(artifact.artifact_id)) return failure("invalid_outputs", "native stage artifact id is unsafe or duplicated");
    if (!isSafeArtifactId(artifact.immutable_id) || immutableIds.has(artifact.immutable_id)) return failure("invalid_outputs", "native stage immutable artifact id is unsafe or duplicated");
    artifactIds.add(artifact.artifact_id);
    immutableIds.add(artifact.immutable_id);
    let digest: string;
    try {
      digest = sha256(canonicalJson(artifact.value));
    } catch {
      return failure("invalid_outputs", `native stage artifact '${artifact.artifact_id}' is not JSON serializable`);
    }
    const row = outputRows.get(artifact.artifact_id);
    if (!row || row.sha256 !== digest) return failure("invalid_outputs", `native stage artifact '${artifact.artifact_id}' does not match its receipt hash`);
    const validation = validateProducedArtifact(artifact.artifact_id, artifact.value);
    if (!validation.ok) return failure("invalid_outputs", `native stage artifact '${artifact.artifact_id}' failed its declared contract`);
  }
  if (outputRows.size !== artifactIds.size) return failure("invalid_outputs", "native stage receipt outputs do not match submitted artifacts");
  let expectedDigest: string;
  try {
    const outputs = Object.fromEntries(trusted.artifacts.map((artifact) => [artifact.artifact_id, artifact.value]));
    expectedDigest = sha256(`${canonicalJson(assigned)}\n${canonicalJson(outputs)}`);
  } catch {
    return failure("invalid_outputs", "native stage submission digest cannot be computed");
  }
  if (trusted.receipt.digest !== expectedDigest) return failure("invalid_outputs", "native stage receipt digest does not match the assigned output payload");
  return null;
}

function buildArtifactPlan(trusted: TrustedStageResultInput, declared: Set<string>): ArtifactPlan[] | NativeStageExecutionCommitResult {
  const plans: ArtifactPlan[] = [];
  for (const artifact of trusted.artifacts) {
    if (!declared.has(artifact.artifact_id)) return failure("invalid_outputs", `native stage artifact '${artifact.artifact_id}' is not declared by the persisted assigned stage`);
    let body: string;
    let digest: string;
    try {
      body = canonicalJson(artifact.value);
      digest = sha256(body);
    } catch {
      return failure("invalid_outputs", `native stage artifact '${artifact.artifact_id}' is not JSON serializable`);
    }
    plans.push({
      artifact_id: artifact.artifact_id,
      immutable_ref: `${artifact.immutable_id}.json`,
      body,
      sha256: digest,
    });
  }
  return plans;
}
function normalizeReceiptMetadata(
  receipt: StageReceiptLedger,
  plans: ArtifactPlan[],
  binding: StageProducerBinding,
  artifactRoot: string,
  readEvidence: boolean,
): ReceiptNormalization | NativeStageExecutionFailure {
  const byArtifact = new Map(plans.map((plan) => [plan.artifact_id, plan]));
  const evidenceIds = new Set<string>();
  const evidence: StageReceiptLedger["evidence"] = [];
  const evidencePlans: EvidencePlan[] = [];
  for (const entry of receipt.evidence) {
    if (
      !isSafeArtifactId(entry.artifact_id)
      || evidenceIds.has(entry.artifact_id)
      || typeof entry.relative_path !== "string"
      || !entry.relative_path
      || entry.relative_path.startsWith("/")
      || entry.relative_path.startsWith("\\")
      || entry.relative_path.split(/[\\/]/).includes("..")
      || typeof entry.immutable_ref !== "string"
      || typeof entry.sha256 !== "string"
    ) return failure("invalid_outputs", "native stage receipt evidence provenance is malformed");
    const plan = byArtifact.get(entry.artifact_id);
    if (!plan) return failure("invalid_outputs", `native stage evidence '${entry.artifact_id}' is not a declared output`);
    const expectedEvidenceRef = immutableEvidenceRef(entry.relative_path, entry.sha256);
    if (entry.immutable_ref !== "" && entry.immutable_ref !== plan.immutable_ref && entry.immutable_ref !== expectedEvidenceRef) {
      return failure("invalid_outputs", "native stage receipt evidence provenance is malformed");
    }
    let digest = entry.sha256;
    let bytes: Buffer | undefined;
    if (readEvidence) {
      const read = readArtifactFileSafe(artifactRoot, entry.relative_path);
      if (read.status === "absent") return failure("artifact_conflict", `native stage evidence '${entry.relative_path}' is missing`);
      if (read.status === "invalid") return failure("artifact_conflict", `native stage evidence '${entry.relative_path}' is unreadable: ${read.error}`);
      digest = sha256Bytes(read.bytes);
      if (entry.sha256 !== digest) return failure("invalid_outputs", `native stage evidence '${entry.artifact_id}' does not match the referenced bytes`);
      bytes = read.bytes;
    }
    const immutable_ref = immutableEvidenceRef(entry.relative_path, digest);
    evidenceIds.add(entry.artifact_id);
    evidence.push({ ...entry, immutable_ref, sha256: digest });
    if (bytes !== undefined) evidencePlans.push({ artifact_id: entry.artifact_id, relative_path: entry.relative_path, immutable_ref, sha256: digest, bytes });
  }
  return {
    receipt: {
      ...receipt,
      binding,
      outputs: plans.map(({ artifact_id, immutable_ref, sha256: digest }) => ({ artifact_id, immutable_ref, sha256: digest })),
      evidence,
    },
    evidence: evidencePlans,
  };
}


function receiptMetadataMatches(left: StageReceiptLedger, right: StageReceiptLedger): boolean {
  if (left.receipt_id !== right.receipt_id || left.submission_id !== right.submission_id || left.dispatch_id !== right.dispatch_id || left.attempt !== right.attempt || left.digest !== right.digest || !sameIdentity(left.work_identity, right.work_identity)) return false;
  if (left.binding !== undefined || right.binding !== undefined) {
    if (left.binding === undefined || right.binding === undefined || !sameIdentity(left.binding, right.binding)) return false;
  }
  if (left.outputs.length !== right.outputs.length || left.evidence.length !== right.evidence.length) return false;
  return left.outputs.every((entry) => {
    const other = right.outputs.find((candidate) => candidate.artifact_id === entry.artifact_id);
    return !!other && other.immutable_ref === entry.immutable_ref && other.sha256 === entry.sha256;
  }) && left.evidence.every((entry) => {
    const other = right.evidence.find((candidate) => candidate.artifact_id === entry.artifact_id);
    return !!other && other.relative_path === entry.relative_path && other.immutable_ref === entry.immutable_ref && other.sha256 === entry.sha256;
  });
}

function verifyCommittedArtifacts(root: string, previous: StageReceiptLedger, plans: ArtifactPlan[]): NativeStageExecutionFailure | null {
  for (const plan of plans) {
    const prior = previous.outputs.find((entry) => entry.artifact_id === plan.artifact_id);
    if (!prior || prior.immutable_ref !== plan.immutable_ref || prior.sha256 !== plan.sha256) return failure("native_stage_receipt_conflict", "accepted native stage receipt does not match the immutable output assignment");
    const content = readPriorArtifact(root, prior.immutable_ref);
    if (content === null) return failure("artifact_conflict", "accepted immutable output is missing");
    if (!Buffer.isBuffer(content)) return content;
    const expectedBytes = Buffer.from(plan.body, "utf8");
    if (sha256Bytes(content) !== plan.sha256 || !content.equals(expectedBytes)) return failure("artifact_conflict", `immutable output '${prior.immutable_ref}' changed after acceptance`);
  }
  for (const evidence of previous.evidence) {
    if (evidence.immutable_ref !== immutableEvidenceRef(evidence.relative_path, evidence.sha256)) return failure("native_stage_receipt_conflict", "accepted native stage receipt does not match the immutable evidence assignment");
    const content = readPriorArtifact(root, evidence.immutable_ref);
    if (content === null) return failure("artifact_conflict", "accepted immutable evidence is missing");
    if (!Buffer.isBuffer(content)) return content;
    if (sha256Bytes(content) !== evidence.sha256) return failure("artifact_conflict", `immutable evidence '${evidence.immutable_ref}' changed after acceptance`);
  }
  return null;
}

/**
 * Persist one trusted native CTO stage result. This is deliberately separate
 * from ordinary workflow storage: the only state target is the canonical CTO
 * run image and the output declaration is the persisted native stage's
 * `declared_outputs`, never the stage id.
*/
export const commitNativeCtoStageResult: StageResultCommitter = (input): NativeStageExecutionCommitResult => {
  const bindingIssue = validateNativeBinding(input);
  if (bindingIssue) return bindingIssue;
  const assigned = input.binding.assigned_identity!;
  try {
    const statePath = ctoStatePath(input.runId, input.cwd);
    return withWorkspaceTransaction(input.cwd, () => {
      const loaded = readCanonicalState(input.runId, input.cwd);
      if (!("state" in loaded)) return loaded;
      const { raw: beforeState, state } = loaded;
      const team = locateAssignedTeam(state, input.binding, assigned);
      if (!("id" in team)) return team;
      const progress = state.native_stage_progress?.[team.id];
      if (!progress || progress.team_id !== team.id || progress.run_id !== state.id) return failure("worker_assignment_unavailable", "persisted native stage progress is unavailable for the assigned team");
      const assignment = progress.assignments[assigned.dispatch_id];
      if (!assignment || !sameIdentity(assignment.identity, assigned)) return failure("worker_assignment_conflict", "persisted native stage assignment does not match the trusted identity");
      if (hasTerminalSignal(assignment)) return failure("worker_assignment_conflict", "native stage assignment has a terminal preflight signal and cannot accept a stage result");
      const producer = input.trusted.binding.producer;
      if (producer.generation !== nativeStageGeneration(state)) return failure("worker_assignment_conflict", "trusted native producer generation does not match the canonical native stage generation");
      if (
        producer.kind === "worker"
          ? producer.role !== assignment.role || producer.agent !== assignment.agent || producer.slot_id !== assignment.slot_id
          : assignment.role !== "lead"
      ) return failure("worker_assignment_conflict", "trusted producer binding does not match the persisted stage slot");
      const declared = new Set(progress.declared_outputs);
      if (declared.size === 0) return failure("worker_assignment_conflict", "persisted native stage declares no output artifacts");
      const plans = buildArtifactPlan(input.trusted, declared);
      if (!Array.isArray(plans)) return plans;
      if (plans.length !== declared.size) return failure("invalid_outputs", "native stage submission must cover every declared output artifact");
      const artifactRoot = safeArtifactRoot(statePath);
      if (typeof artifactRoot !== "string") return artifactRoot;
      const previous = state.stage_receipts?.[assigned.dispatch_id];
      const publicationIssue = currentNativePublicationIssue(input.cwd, input.runId, input.binding, assigned, previous !== undefined);
      if (publicationIssue) return publicationIssue;
      const normalized = normalizeReceiptMetadata(input.trusted.receipt, plans, input.trusted.binding, artifactRoot, previous === undefined);
      if (!("receipt" in normalized)) return normalized;
      if (previous) {
        if (!sameIdentity(previous.work_identity, assigned) || previous.dispatch_id !== assigned.dispatch_id || previous.attempt !== assigned.attempt) return failure("cto_state_invalid", "persisted native stage receipt identity conflicts with its assignment");
        if (!receiptMetadataMatches(previous, normalized.receipt)) return failure("native_stage_receipt_conflict", "conflicting replay for accepted native stage assignment");
        const replayIssue = verifyCommittedArtifacts(artifactRoot, previous, plans);
        if (replayIssue) return replayIssue;
        return { ok: true, receipt: previous };
      }
      const receipt: StageReceiptLedger = {
        ...normalized.receipt,
        dispatch_id: assigned.dispatch_id,
        attempt: assigned.attempt,
        accepted_at: new Date().toISOString(),
        work_identity: structuredClone(assigned),
      };
      const withReceipt: CtoState = {
        ...state,
        stage_receipts: { ...(state.stage_receipts ?? {}), [assigned.dispatch_id]: receipt },
      };
      const nextState: CtoState = {
        ...updateNativeStageAssignment(withReceipt, assigned.dispatch_id, "accepted"),
        updated_at: new Date().toISOString(),
      };
      const candidateCheck = parseCtoState(nextState, input.runId);
      if (!candidateCheck.ok) return failure("cto_state_invalid", `native CTO receipt candidate is invalid: ${candidateCheck.error}`);
      const stateContent = `${JSON.stringify(nextState, null, 2)}\n`;
      const before: Record<string, LifecycleFileContent> = { [statePath]: beforeState };
      const after: Record<string, LifecycleFileContent> = { [statePath]: stateContent };
      for (const plan of plans) {
        const path = safeArtifactPath(artifactRoot, plan.immutable_ref);
        if (!path) return failure("artifact_conflict", "native stage immutable output reference escapes the CTO artifact root");
        const prior = readPriorArtifact(artifactRoot, plan.immutable_ref);
        if (prior === null) {
          before[path] = null;
        } else {
          if (!Buffer.isBuffer(prior)) return prior;
          if (!prior.equals(Buffer.from(plan.body, "utf8"))) return failure("artifact_conflict", `immutable output '${plan.immutable_ref}' already contains a different payload`);
          before[path] = lifecycleContent(prior);
        }
        after[path] = plan.body;
      }
      for (const evidence of normalized.evidence) {
        const path = safeArtifactPath(artifactRoot, evidence.immutable_ref);
        if (!path) return failure("artifact_conflict", "native stage immutable evidence reference escapes the CTO artifact root");
        const prior = readPriorArtifact(artifactRoot, evidence.immutable_ref);
        if (prior === null) {
          before[path] = null;
        } else {
          if (!Buffer.isBuffer(prior)) return prior;
          if (!prior.equals(evidence.bytes)) return failure("artifact_conflict", `immutable evidence '${evidence.immutable_ref}' already contains different bytes`);
          before[path] = lifecycleContent(prior);
        }
        after[path] = lifecycleContent(evidence.bytes);
      }
      // The exact state byte image is the CAS revision. The lifecycle journal
      // repeats this check immediately before publication and recovery can
      // complete the same before/after image after a process interruption.
      const revision = sha256(beforeState);
      let currentState: string;
      try {
        currentState = readFileSync(statePath, "utf8");
      } catch {
        return failure("cto_state_conflict", "canonical CTO state disappeared before native receipt commit");
      }
      if (sha256(currentState) !== revision || currentState !== beforeState) return failure("cto_state_conflict", "canonical CTO state changed before native receipt commit");
      const transaction = beginLifecycleTransaction({ cwd: input.cwd, operation: "resume", before, after });
      try {
        commitLifecycleTransaction(input.cwd, transaction.transaction_id);
      } catch (error) {
        return failure("cto_state_conflict", `native CTO receipt commit CAS failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      return { ok: true, receipt };
    });
  } catch (error) {
    return failure("native_stage_commit_failed", `native CTO stage receipt transaction failed: ${error instanceof Error ? error.message : String(error)}`);
  }
};

