/* <!-- omp-cto-slice run=01a03ee4-7dd6-7580-8ad7-16d26dc886ba slice=workflow-v2-core --> */

import { createHash } from "node:crypto";
import { createDiagnostic, failureResult, successResult } from "./diagnostics.js";
import type {
  CanonicalRoot,
  DiagnosticResult,
  ExecutableProvenance,
  ProfileIdentity,
  ProjectIdentity,
  ProjectIdentityInput,
  ProjectRuntimeKey,
  ProviderId,
  RootEvidence,
  SessionIdentity,
  WorkflowRunIdentity,
  WorkflowRunIdentityInput,
  WorkflowV2Digest,
  WorkflowV2Diagnostic,
} from "./types.js";

const WORKFLOW_V2_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const PROVIDER_ID_PATTERN = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u;
const SAFE_COMPONENT_PATTERN = /^[^\u0000\u0001-\u001f\u007f\u0080-\u009f]+$/u;
const SAFE_IDENTIFIER_PATTERN = /^[A-Za-z0-9@._:/#-]+$/u;
const MAX_CTO_ID_LENGTH = 128;
const SAFE_CTO_ID_RE = /^[A-Za-z0-9._-]+$/u;

const PROJECT_IDENTITY_KEYS = [
  "root_instance_id",
  "provider_id",
  "descriptor_fingerprint",
  "executable_provenance",
  "catalog_content_digest",
  "config_byte_sha256",
  "config_semantic_sha256",
  "session",
] as const;
const RUN_IDENTITY_KEYS = [...PROJECT_IDENTITY_KEYS, "run_id", "profile_identity"] as const;
const RUN_INPUT_KEYS = ["project_identity", "run_id", "profile_identity"] as const;
const PROFILE_IDENTITY_KEYS = ["id", "fingerprint"] as const;
const SESSION_IDENTITY_KEYS = ["session_id", "lifecycle_id"] as const;
const EXECUTABLE_PROVENANCE_KEYS = ["build_fingerprint", "runtime_fingerprint"] as const;
const ROOT_EVIDENCE_KEYS = [
  "canonical_root",
  "root_device",
  "root_inode",
  "git_device",
  "git_inode",
  "root_instance_nonce",
] as const;

/** Runtime check for the branded SHA-256 representation used by v2. */
export function isWorkflowV2Digest(value: unknown): value is WorkflowV2Digest {
  return typeof value === "string" && WORKFLOW_V2_DIGEST_PATTERN.test(value);
}

/** Brand a digest only after validating its complete wire representation. */
export function createWorkflowV2Digest(value: string): WorkflowV2Digest | undefined {
  return isWorkflowV2Digest(value) ? value : undefined;
}

/** Runtime check for lowercase npm/package-qualified provider identifiers. */
export function isProviderId(value: unknown): value is ProviderId {
  return typeof value === "string" && value === value.trim() && PROVIDER_ID_PATTERN.test(value);
}

/** Brand a provider id only after validating the lowercase package form. */
export function createProviderId(value: string): ProviderId | undefined {
  return isProviderId(value) ? value : undefined;
}

/** Canonical roots are already resolved by the manager; this helper never resolves or reads them. */
export function isCanonicalRoot(value: unknown): value is CanonicalRoot {
  if (typeof value !== "string" || value.length === 0 || value !== value.trim() || !value.startsWith("/")) return false;
  if (!SAFE_COMPONENT_PATTERN.test(value) || value.includes("\\") || value.includes("//")) return false;
  if (value.length > 1 && value.endsWith("/")) return false;
  const segments = value.split("/");
  return segments.every((segment) => segment !== "." && segment !== "..");
}

/** Brand an already-canonical absolute root without performing filesystem work. */
export function createCanonicalRoot(value: string): CanonicalRoot | undefined {
  return isCanonicalRoot(value) ? value : undefined;
}

/** Runtime check for the canonical safe ASCII token used by durable CTO run paths. */
export function isSafeCtoId(value: unknown): value is string {
  return (
    typeof value === "string"
    && value.length > 0
    && value.length <= MAX_CTO_ID_LENGTH
    && value !== "."
    && value !== ".."
    && SAFE_CTO_ID_RE.test(value)
  );
}

function identityDiagnostic(field: string, remediation: string): WorkflowV2Diagnostic {
  return createDiagnostic({
    code: "IDENTITY_MISMATCH",
    operation: "admission",
    severity: "error",
    evidence: { changed_field: field },
    remediation,
  });
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function nonEmptySafeString(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 512
    && value === value.trim()
    && SAFE_COMPONENT_PATTERN.test(value)
    && SAFE_IDENTIFIER_PATTERN.test(value);
}

function ownKeysDiagnostics(value: Record<string, unknown>, expected: readonly string[], path: string): WorkflowV2Diagnostic[] {
  const diagnostics: WorkflowV2Diagnostic[] = [];
  for (const key of expected) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      diagnostics.push(identityDiagnostic(`${path}.${key}`, "Provide every required identity field exactly once."));
    }
  }
  for (const key of Object.keys(value)) {
    if (!expected.includes(key)) {
      diagnostics.push(identityDiagnostic(`${path}.${key}`, "Remove identity fields that are not part of the v2 contract."));
    }
  }
  return diagnostics;
}

function profileIdentityValid(value: unknown): value is ProfileIdentity {
  if (!isPlainRecord(value)) return false;
  const profile = value;
  return ownKeysDiagnostics(profile, PROFILE_IDENTITY_KEYS, "profile_identity").length === 0
    && nonEmptySafeString(profile.id)
    && isWorkflowV2Digest(profile.fingerprint);
}

function sessionIdentityValid(value: unknown): value is SessionIdentity {
  if (!isPlainRecord(value)) return false;
  const session = value;
  return ownKeysDiagnostics(session, SESSION_IDENTITY_KEYS, "session").length === 0
    && nonEmptySafeString(session.session_id)
    && nonEmptySafeString(session.lifecycle_id);
}

function executableProvenanceValid(value: unknown): value is ExecutableProvenance {
  if (!isPlainRecord(value)) return false;
  const executable = value;
  return ownKeysDiagnostics(executable, EXECUTABLE_PROVENANCE_KEYS, "executable_provenance").length === 0
    && isWorkflowV2Digest(executable.build_fingerprint)
    && isWorkflowV2Digest(executable.runtime_fingerprint);
}

/**
 * Validate and freeze the root identity evidence supplied by a trusted root
 * manager. No path is canonicalized and no filesystem metadata is read here.
 */
export function validateRootEvidence(value: unknown): DiagnosticResult<RootEvidence> {
  if (!isPlainRecord(value)) {
    return failureResult(identityDiagnostic("root_evidence", "Provide verified canonical root and device/inode evidence."));
  }
  try {
    const diagnostics = ownKeysDiagnostics(value, ROOT_EVIDENCE_KEYS, "root_evidence");
    for (const field of ROOT_EVIDENCE_KEYS) {
      const entry = value[field];
      if (field === "canonical_root" ? isCanonicalRoot(entry) : nonEmptySafeString(entry)) continue;
      diagnostics.push(identityDiagnostic(`root_evidence.${field}`, "Re-resolve the physical root and provide complete stable worktree evidence."));
    }
    if (diagnostics.length > 0) return failureResult(diagnostics);
    const evidence: RootEvidence = Object.freeze({
      canonical_root: value.canonical_root as CanonicalRoot,
      root_device: value.root_device as string,
      root_inode: value.root_inode as string,
      git_device: value.git_device as string,
      git_inode: value.git_inode as string,
      root_instance_nonce: value.root_instance_nonce as string,
    });
    return successResult(evidence);
  } catch {
    return failureResult(identityDiagnostic("root_evidence", "Provide a complete, readable root evidence record."));
  }
}

/**
 * Derive the stable worktree-instance digest from manager-verified identity
 * evidence. The canonical path is retained as evidence but intentionally not
 * included in the digest, so a symlink alias cannot create a second identity.
 */
export function buildProjectWorktreeInstanceId(evidence: RootEvidence): WorkflowV2Digest {
  const checked = validateRootEvidence(evidence);
  if (!checked.ok) throw new TypeError("invalid root evidence");
  const stableIdentity = JSON.stringify([
    "workflow-v2-project-worktree",
    checked.value.root_device,
    checked.value.root_inode,
    checked.value.git_device,
    checked.value.git_inode,
    checked.value.root_instance_nonce,
  ]);
  return `sha256:${createHash("sha256").update(stableIdentity, "utf8").digest("hex")}`;
}

function freezeProfile(value: ProfileIdentity): ProfileIdentity {
  return Object.freeze({ id: value.id, fingerprint: value.fingerprint });
}

function freezeExecutable(value: ExecutableProvenance): ExecutableProvenance {
  return Object.freeze({
    build_fingerprint: value.build_fingerprint,
    runtime_fingerprint: value.runtime_fingerprint,
  });
}

function freezeSession(value: SessionIdentity): SessionIdentity {
  return Object.freeze({ session_id: value.session_id, lifecycle_id: value.lifecycle_id });
}

function validateProjectIdentityRecord(value: unknown): DiagnosticResult<ProjectIdentity> {
  if (!isPlainRecord(value)) {
    return failureResult(identityDiagnostic("project_identity", "Provide every required profile-free project identity pin."));
  }
  try {
    const candidate = value;
    const diagnostics = ownKeysDiagnostics(candidate, PROJECT_IDENTITY_KEYS, "project_identity");
    const digestFields = [
      "root_instance_id",
      "descriptor_fingerprint",
      "catalog_content_digest",
      "config_byte_sha256",
      "config_semantic_sha256",
    ] as const;
    for (const field of digestFields) {
      if (!isWorkflowV2Digest(candidate[field])) {
        diagnostics.push(identityDiagnostic(`project_identity.${field}`, "Use a sha256:<64 lowercase hex> digest from the validated project snapshot."));
      }
    }
    if (!isProviderId(candidate.provider_id)) {
      diagnostics.push(identityDiagnostic("project_identity.provider_id", "Use the exact lowercase package-qualified provider id."));
    }
    if (!executableProvenanceValid(candidate.executable_provenance)) {
      diagnostics.push(identityDiagnostic("project_identity.executable_provenance", "Provide build and runtime executable fingerprints from the admitted provider."));
    }
    if (!sessionIdentityValid(candidate.session)) {
      diagnostics.push(identityDiagnostic("project_identity.session", "Provide non-empty session_id and lifecycle_id values from the active session."));
    }
    if (diagnostics.length > 0) return failureResult(diagnostics);

    const executable = candidate.executable_provenance as ExecutableProvenance;
    const session = candidate.session as SessionIdentity;
    const identity: ProjectIdentity = Object.freeze({
      root_instance_id: candidate.root_instance_id as WorkflowV2Digest,
      provider_id: candidate.provider_id as ProviderId,
      descriptor_fingerprint: candidate.descriptor_fingerprint as WorkflowV2Digest,
      executable_provenance: freezeExecutable(executable),
      catalog_content_digest: candidate.catalog_content_digest as WorkflowV2Digest,
      config_byte_sha256: candidate.config_byte_sha256 as WorkflowV2Digest,
      config_semantic_sha256: candidate.config_semantic_sha256 as WorkflowV2Digest,
      session: freezeSession(session),
    });
    return successResult(identity);
  } catch {
    return failureResult(identityDiagnostic("project_identity", "Provide a complete, readable project identity record."));
  }
}

/** Build and freeze a complete profile-free project identity. */
export function buildProjectIdentity(input: ProjectIdentityInput): DiagnosticResult<ProjectIdentity> {
  return validateProjectIdentityRecord(input);
}

/** Validate a project identity received across a runtime or persistence boundary. */
export function validateProjectIdentity(value: unknown): DiagnosticResult<ProjectIdentity> {
  return validateProjectIdentityRecord(value);
}

function validateRunFields(
  value: Record<string, unknown>,
  path: string,
  diagnostics: WorkflowV2Diagnostic[],
): { readonly run_id?: string; readonly profile_identity?: ProfileIdentity } {
  const runId = isSafeCtoId(value.run_id) ? value.run_id : undefined;
  if (runId === undefined) {
    diagnostics.push(identityDiagnostic(
      `${path}.run_id`,
      "Provide a non-empty ASCII run id using only letters, digits, '.', '_' or '-' and no more than 128 characters.",
    ));
  }
  if (!profileIdentityValid(value.profile_identity)) {
    diagnostics.push(identityDiagnostic(`${path}.profile_identity`, "Provide the exact catalog profile id and fingerprint selected during workflow_prepare."));
  }
  const profile = profileIdentityValid(value.profile_identity) ? value.profile_identity : undefined;
  return {
    run_id: runId,
    profile_identity: profile,
  };
}

function buildRunIdentity(
  project: ProjectIdentity,
  runId: string,
  profile: ProfileIdentity,
): WorkflowRunIdentity {
  return Object.freeze({
    ...project,
    run_id: runId,
    profile_identity: freezeProfile(profile),
  });
}

/** Build and freeze a durable run identity from one project identity and one exact profile. */
export function buildWorkflowRunIdentity(input: WorkflowRunIdentityInput): DiagnosticResult<WorkflowRunIdentity> {
  if (!isPlainRecord(input)) {
    return failureResult(identityDiagnostic("workflow_run_identity", "Provide project_identity, run_id and profile_identity for the prepared run."));
  }
  try {
    const diagnostics = ownKeysDiagnostics(input, RUN_INPUT_KEYS, "workflow_run_identity");
    const project = validateProjectIdentityRecord(input.project_identity);
    if (!project.ok) diagnostics.push(...project.diagnostics);
    const fields = validateRunFields(input, "workflow_run_identity", diagnostics);
    if (diagnostics.length > 0 || !project.ok || !fields.run_id || !fields.profile_identity) {
      return failureResult(diagnostics.length > 0 ? diagnostics : identityDiagnostic("workflow_run_identity", "Provide a complete durable run identity."));
    }
    return successResult(buildRunIdentity(project.value, fields.run_id, fields.profile_identity));
  } catch {
    return failureResult(identityDiagnostic("workflow_run_identity", "Provide a complete, readable durable run identity record."));
  }
}

/** Validate a durable run identity, including inherited project pins and exact profile identity. */
export function validateWorkflowRunIdentity(value: unknown): DiagnosticResult<WorkflowRunIdentity> {
  if (!isPlainRecord(value)) {
    return failureResult(identityDiagnostic("workflow_run_identity", "Provide project pins, a required run id and an exact profile identity."));
  }
  try {
    const candidate = value;
    const diagnostics = ownKeysDiagnostics(candidate, RUN_IDENTITY_KEYS, "workflow_run_identity");
    const projectCandidate: Record<string, unknown> = {};
    for (const key of PROJECT_IDENTITY_KEYS) {
      if (Object.prototype.hasOwnProperty.call(candidate, key)) projectCandidate[key] = candidate[key];
    }
    const project = validateProjectIdentityRecord(projectCandidate);
    if (!project.ok) diagnostics.push(...project.diagnostics);
    const fields = validateRunFields(candidate, "workflow_run_identity", diagnostics);
    if (diagnostics.length > 0 || !project.ok || !fields.run_id || !fields.profile_identity) {
      return failureResult(diagnostics.length > 0 ? diagnostics : identityDiagnostic("workflow_run_identity", "Provide a complete durable run identity."));
    }
    return successResult(buildRunIdentity(project.value, fields.run_id, fields.profile_identity));
  } catch {
    return failureResult(identityDiagnostic("workflow_run_identity", "Provide a complete, readable durable run identity record."));
  }
}

function projectForRuntimeKey(identity: ProjectIdentity): ProjectIdentity {
  if (!isPlainRecord(identity)) throw new TypeError("invalid project identity");
  const hasRunFields = Object.prototype.hasOwnProperty.call(identity, "run_id")
    || Object.prototype.hasOwnProperty.call(identity, "profile_identity");
  if (hasRunFields) {
    const run = validateWorkflowRunIdentity(identity);
    if (!run.ok) throw new TypeError("invalid workflow run identity");
    return run.value;
  }
  const project = validateProjectIdentity(identity);
  if (!project.ok) throw new TypeError("invalid project identity");
  return project.value;
}

/**
 * Compute the stable project runtime key. Every project pin participates;
 * profile_identity and run_id never do, so profile changes create new runs
 * without replacing the active project/provider runtime.
 */
export function projectRuntimeKeyFor(identity: ProjectIdentity): ProjectRuntimeKey {
  const project = projectForRuntimeKey(identity);
  const stable = JSON.stringify([
    "workflow-v2-project-runtime",
    project.root_instance_id,
    project.provider_id,
    project.descriptor_fingerprint,
    [project.executable_provenance.build_fingerprint, project.executable_provenance.runtime_fingerprint],
    project.catalog_content_digest,
    project.config_byte_sha256,
    project.config_semantic_sha256,
    [project.session.session_id, project.session.lifecycle_id],
  ]);
  return `sha256:${createHash("sha256").update(stable, "utf8").digest("hex")}` as ProjectRuntimeKey;
}
