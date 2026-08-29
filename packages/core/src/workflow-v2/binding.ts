/** No-follow, root-bound workflow-v2 binding sidecar reader and writer. */
/* <!-- omp-cto-slice run=01a03ee4-7dd6-7580-8ad7-16d26dc886ba slice=workflow-v2-core --> */

import { randomUUID } from "node:crypto";
import { join } from "node:path";

import {
  createDiagnostic,
  failureResult,
  successResult,
} from "./diagnostics.js";
import {
  buildProjectWorktreeInstanceId,
  createCanonicalRoot,
  isCanonicalRoot,
  isProviderId,
  isWorkflowV2Digest,
  validateProjectIdentity,
} from "./identity.js";
import {
  readTransactionStatusFromPinned,
  runTransactionReadHook,
  transactionReadAllowed,
  TRANSACTION_READ_AUTHORITY,
  type TransactionStatus,
} from "./transaction.js";
import {
  isTrustedFsAuthority,
  type FsAuthorityFailure,
  type FsRootDirectory,
  type FsTargetFingerprint,
  type PinnedFsRoot,
  type TrustedFsAuthority,
} from "./fs-authority.js";

import {
  canonicalPolicyJson,
  computePolicyByteHash,
  parseStrictJsonValue,
} from "./policy.js";
import type {
  BindingDocument,
  BindingReadResult,
  BindingWriteResult,
  BindingSnapshot,
  BindingValidatedIdentity,
  CanonicalRoot,
  DiagnosticResult,
  PolicyPrecondition,
  ProjectIdentity,
  RootBoundBindingWrite,
  RootEvidence,
  WorkflowV2Digest,
  WorkflowV2Diagnostic,
} from "./types.js";

export const BINDING_RELATIVE_PATH = ".omp/team.config.binding.json" as const;
export const BINDING_VERSION = 1 as const;
/** Sidecars contain only fixed identity data and stay far below policy limits. */
export const BINDING_MAX_BYTES = 64 * 1024;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9@._:/#-]+$/u;
const NONCE_PATTERN = /^[A-Za-z0-9-]+$/u;
const BINDING_KEYS = ["binding_version", "project_worktree_instance", "last_validated"] as const;
const BINDING_IDENTITY_KEYS = [
  "provider_id",
  "descriptor_fingerprint",
  "executable_provenance",
  "catalog_content_digest",
  "config_byte_sha256",
  "config_semantic_sha256",
  "session",
] as const;
const EXECUTABLE_KEYS = ["build_fingerprint", "runtime_fingerprint"] as const;
const SESSION_KEYS = ["session_id", "lifecycle_id"] as const;


/** The nonce is retained only in memory; it is not persisted in tracked policy. */
const nonceByRoot = new Map<string, string>();

function safeIdentifier(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 512
    && value === value.trim()
    && IDENTIFIER_PATTERN.test(value);
}

function diagnostic(
  code: "ROOT_UNAVAILABLE" | "UNSAFE_PATH" | "BINDING_REQUIRED" | "CONFIG_MALFORMED" | "IDENTITY_MISMATCH" | "TRANSACTION_INCOMPLETE" | "ACTIVATION_FAILED",
  operation: "root.resolve" | "binding.read" | "binding.write",
  field: string,
  remediation: string,
  evidence: Record<string, unknown> = {},
): WorkflowV2Diagnostic {
  return createDiagnostic({
    code,
    operation,
    evidence: { field: field.replace(/[^A-Za-z0-9@._:/#-]/gu, "_").slice(0, 256), ...evidence },
    remediation,
  });
}

function safeOpaque(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 512
    && value === value.trim()
    && /^[^\u0000-\u001f\u007f\u0080-\u009f]+$/u.test(value);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  if (Object.keys(value).length !== expected.length) return false;
  return expected.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

function canonicalRoot(root: CanonicalRoot | string): CanonicalRoot | undefined {
  if (typeof root !== "string" || !isCanonicalRoot(root)) return undefined;
  return createCanonicalRoot(root);
}

function bindingPath(root: CanonicalRoot | string): string | undefined {
  const checked = canonicalRoot(root);
  return checked ? join(checked, BINDING_RELATIVE_PATH) : undefined;
}

export function bindingFilePath(root: CanonicalRoot | string): string {
  const path = bindingPath(root);
  if (!path) throw new TypeError("workflow-v2 binding requires a canonical absolute root");
  return path;
}

function policyPath(root: CanonicalRoot): string {
  return join(root, ".omp", "team.config.json");
}

function authorityDiagnostic(
  operation: "root.resolve" | "binding.read" | "binding.write",
  field: string,
  path: string,
  result: FsAuthorityFailure,
): WorkflowV2Diagnostic {
  const code = result.reason === "unsafe"
    ? "UNSAFE_PATH"
    : result.reason === "conflict"
      ? "IDENTITY_MISMATCH"
      : result.reason === "limit"
        ? "CONFIG_MALFORMED"
        : result.reason === "root_missing" || result.reason === "omp_missing" || result.reason === "invalid_root"
          ? "ROOT_UNAVAILABLE"
          : "ACTIVATION_FAILED";
  return diagnostic(
    code,
    operation,
    field,
    result.message ?? "Use the trusted descriptor-relative filesystem authority; no pathname fallback is available.",
    { path, reason: result.reason },
  );
}

function transactionDiagnostic(
  operation: "binding.read" | "binding.write",
  transaction: TransactionStatus,
): WorkflowV2Diagnostic | undefined {
  if (transaction.status === "clear") return undefined;
  const reason = transaction.status === "invalid" ? transaction.reason : transaction.status;
  return diagnostic(
    "TRANSACTION_INCOMPLETE",
    operation,
    "transaction_journal",
    "Recover the workflow-v2 transaction through management before accessing the binding sidecar.",
    { path: transaction.path, status: reason },
  );
}

function identityIsValid(value: unknown): value is BindingValidatedIdentity {
  if (!isPlainRecord(value) || !hasExactKeys(value, BINDING_IDENTITY_KEYS)) return false;
  const candidate = value;
  if (!isProviderId(candidate.provider_id)) return false;
  if (!isWorkflowV2Digest(candidate.descriptor_fingerprint) || !isWorkflowV2Digest(candidate.catalog_content_digest)) return false;
  if (!isWorkflowV2Digest(candidate.config_byte_sha256) || !isWorkflowV2Digest(candidate.config_semantic_sha256)) return false;

  const executable = candidate.executable_provenance;
  if (!isPlainRecord(executable)
    || !hasExactKeys(executable, EXECUTABLE_KEYS)
    || !isWorkflowV2Digest(executable.build_fingerprint)
    || !isWorkflowV2Digest(executable.runtime_fingerprint)) return false;

  const session = candidate.session;
  if (!isPlainRecord(session)
    || !hasExactKeys(session, SESSION_KEYS)
    || !safeIdentifier(session.session_id)
    || !safeIdentifier(session.lifecycle_id)) return false;
  return true;
}

function bindingDocumentIsValid(value: unknown): value is BindingDocument {
  if (!isPlainRecord(value) || !hasExactKeys(value, BINDING_KEYS)) return false;
  return value.binding_version === BINDING_VERSION
    && isWorkflowV2Digest(value.project_worktree_instance)
    && identityIsValid(value.last_validated);
}

function freezeBindingIdentity(value: BindingValidatedIdentity): BindingValidatedIdentity {
  return Object.freeze({
    provider_id: value.provider_id,
    descriptor_fingerprint: value.descriptor_fingerprint,
    executable_provenance: Object.freeze({
      build_fingerprint: value.executable_provenance.build_fingerprint,
      runtime_fingerprint: value.executable_provenance.runtime_fingerprint,
    }),
    catalog_content_digest: value.catalog_content_digest,
    config_byte_sha256: value.config_byte_sha256,
    config_semantic_sha256: value.config_semantic_sha256,
    session: Object.freeze({
      session_id: value.session.session_id,
      lifecycle_id: value.session.lifecycle_id,
    }),
  });
}

function freezeBindingDocument(value: BindingDocument): BindingDocument {
  return Object.freeze({
    binding_version: BINDING_VERSION,
    project_worktree_instance: value.project_worktree_instance,
    last_validated: freezeBindingIdentity(value.last_validated),
  });
}

function parseBinding(bytes: Buffer, path: string): DiagnosticResult<BindingDocument> {
  let parsed: unknown;
  try {
    parsed = parseStrictJsonValue(bytes);
  } catch {
    return failureResult(diagnostic("CONFIG_MALFORMED", "binding.read", "document", "Read a strict JSON binding document with unique keys and valid UTF-8.", { path }));
  }
  if (!bindingDocumentIsValid(parsed)) {
    return failureResult(diagnostic("CONFIG_MALFORMED", "binding.read", "document", "Read a closed binding_version 1 document with complete profile-free project pins.", { path }));
  }
  try {
    const canonicalBytes = Buffer.from(`${canonicalPolicyJson(parsed)}\n`, "utf8");
    if (!canonicalBytes.equals(bytes)) {
      return failureResult(diagnostic("CONFIG_MALFORMED", "binding.read", "document", "Rewrite the binding as canonical JSON with one trailing newline.", { path }));
    }
  } catch {
    return failureResult(diagnostic("CONFIG_MALFORMED", "binding.read", "document", "Read a canonical JSON binding document.", { path }));
  }
  return successResult(freezeBindingDocument(parsed));
}

function rootEvidenceAtPinned(
  authority: TrustedFsAuthority,
  pinned: FsRootDirectory,
  nonce: string,
): DiagnosticResult<RootEvidence> {
  if (!NONCE_PATTERN.test(nonce)) return failureResult(diagnostic("IDENTITY_MISMATCH", "binding.read", "root_instance_nonce", "Use the nonce issued by the binding boundary."));
  const git = authority.inspect(pinned.rootDirectory, ".git");
  const gitPath = join(pinned.canonicalRoot, ".git");
  if (!git.ok) return failureResult(authorityDiagnostic("binding.read", "git_identity", gitPath, git));
  if (git.value === null) return failureResult(diagnostic("BINDING_REQUIRED", "binding.read", "git_identity", "Bind a repository root with stable .git device/inode evidence.", { path: gitPath }));
  if (git.value.kind === "other") return failureResult(diagnostic("UNSAFE_PATH", "binding.read", "git_identity", "Use a regular .git file or directory without symlink indirection.", { path: gitPath }));
  return successResult(Object.freeze({
    canonical_root: pinned.canonicalRoot,
    root_device: pinned.rootDevice,
    root_inode: pinned.rootInode,
    git_device: git.value.device,
    git_inode: git.value.inode,
    root_instance_nonce: nonce,
  }));
}

/** Read verified root/git descriptor evidence and issue a lifecycle nonce. */
export function readRootEvidence(root: CanonicalRoot | string, filesystemAuthority?: TrustedFsAuthority): DiagnosticResult<RootEvidence> {
  const checked = canonicalRoot(root);
  if (!checked) return failureResult(diagnostic("ROOT_UNAVAILABLE", "root.resolve", "canonical_root", "Resolve one canonical absolute project root before binding."));
  if (!isTrustedFsAuthority(filesystemAuthority)) {
    return failureResult(diagnostic("ACTIVATION_FAILED", "root.resolve", "filesystem_authority", "Provide a factory-issued trusted descriptor-relative filesystem authority before reading root evidence.", { reason: filesystemAuthority === undefined ? "missing" : "foreign" }));
  }
  const issueEvidence = (pinned: FsRootDirectory): DiagnosticResult<RootEvidence> => {
    let nonce = nonceByRoot.get(checked);
    if (!nonce) {
      nonce = randomUUID();
      nonceByRoot.set(checked, nonce);
    }
    return rootEvidenceAtPinned(filesystemAuthority, pinned, nonce);
  };
  const opened = filesystemAuthority.openRoot(checked, { createOmp: false });
  if (opened.ok) {
    try {
      return issueEvidence(opened.value);
    } finally {
      opened.value.close();
    }
  }
  if (opened.reason !== "omp_missing" || !filesystemAuthority.openRootDirectory) {
    return failureResult(authorityDiagnostic("root.resolve", "canonical_root", checked, opened));
  }
  const rootOnly = filesystemAuthority.openRootDirectory(checked);
  if (!rootOnly.ok) return failureResult(authorityDiagnostic("root.resolve", "canonical_root", checked, rootOnly));
  try {
    return issueEvidence(rootOnly.value);
  } finally {
    rootOnly.value.close();
  }
}

/** Build the sidecar document only from binding-owned verified root evidence. */
export function buildBindingDocument(
  root: CanonicalRoot | string,
  validatedIdentity: BindingValidatedIdentity,
  filesystemAuthority?: TrustedFsAuthority,
): DiagnosticResult<BindingDocument> {
  const evidence = readRootEvidence(root, filesystemAuthority);
  if (!evidence.ok) return evidence;
  if (!identityIsValid(validatedIdentity)) {
    return failureResult(diagnostic("IDENTITY_MISMATCH", "binding.write", "last_validated", "Provide complete validated provider, executable, catalog, session and policy hashes."));
  }
  const document: BindingDocument = Object.freeze({
    binding_version: BINDING_VERSION,
    project_worktree_instance: buildProjectWorktreeInstanceId(evidence.value),
    last_validated: freezeBindingIdentity(validatedIdentity),
  });
  return successResult(document);
}

function projectIdentityMatchesDocument(identity: ProjectIdentity, document: BindingDocument): boolean {
  const validated = document.last_validated;
  return identity.root_instance_id === document.project_worktree_instance
    && identity.provider_id === validated.provider_id
    && identity.descriptor_fingerprint === validated.descriptor_fingerprint
    && identity.executable_provenance.build_fingerprint === validated.executable_provenance.build_fingerprint
    && identity.executable_provenance.runtime_fingerprint === validated.executable_provenance.runtime_fingerprint
    && identity.catalog_content_digest === validated.catalog_content_digest
    && identity.config_byte_sha256 === validated.config_byte_sha256
    && identity.config_semantic_sha256 === validated.config_semantic_sha256
    && identity.session.session_id === validated.session.session_id
    && identity.session.lifecycle_id === validated.session.lifecycle_id;
}


function presentPreconditionValid(
  expected: Extract<PolicyPrecondition, { readonly state: "present" }>,
  root: CanonicalRoot,
): boolean {
  const project = validateProjectIdentity(expected.project_identity);
  return project.ok
    && expected.policy_path === policyPath(root)
    && safeOpaque(expected.policy_file_identity)
    && isWorkflowV2Digest(expected.raw_hash)
    && isWorkflowV2Digest(expected.semantic_hash);
}

function absentPreconditionMatches(
  expected: Extract<PolicyPrecondition, { readonly state: "absent" }>,
  root: CanonicalRoot,
  document: BindingDocument,
): boolean {
  return expected.canonical_root === root
    && expected.worktree_id === document.project_worktree_instance
    && safeIdentifier(expected.session_id)
    && expected.session_id === document.last_validated.session.session_id
    && expected.policy_path === policyPath(root)
    && safeOpaque(expected.parent_path_identity)
    && expected.expected_exclusive_create === true;
}


function expectedMatchesDocument(
  expected: PolicyPrecondition,
  root: CanonicalRoot,
  document: BindingDocument,
): boolean {
  if (expected.state === "absent") return absentPreconditionMatches(expected, root, document);
  if (!presentPreconditionValid(expected, root)) return false;
  return projectIdentityMatchesDocument(expected.project_identity, document)
    && expected.raw_hash === document.last_validated.config_byte_sha256
    && expected.semantic_hash === document.last_validated.config_semantic_sha256;
}

interface PinnedBindingRead {
  readonly snapshot: BindingSnapshot;
  readonly fingerprint: Extract<FsTargetFingerprint, { readonly state: "present" }>;
}

function readBindingAtPinned(
  authority: TrustedFsAuthority,
  pinned: PinnedFsRoot,
  transactionAuthority: typeof TRANSACTION_READ_AUTHORITY | undefined,
): DiagnosticResult<PinnedBindingRead | null> {
  const path = bindingPath(pinned.canonicalRoot) ?? BINDING_RELATIVE_PATH;
  const transaction = readTransactionStatusFromPinned(pinned.canonicalRoot, pinned, authority);
  if (!transactionReadAllowed(pinned.canonicalRoot, transaction, transactionAuthority)) {
    const blocked = transactionDiagnostic("binding.read", transaction);
    if (blocked) return failureResult(blocked);
  }
  const read = authority.readBounded(pinned.ompDirectory, "team.config.binding.json", BINDING_MAX_BYTES);
  if (!read.ok) return failureResult(authorityDiagnostic("binding.read", "path", path, read));
  if (read.value === null) return successResult(null);
  const parsed = parseBinding(read.value.bytes, path);
  if (!parsed.ok) return parsed;
  const hadKnownNonce = nonceByRoot.has(pinned.canonicalRoot);
  let nonce = nonceByRoot.get(pinned.canonicalRoot);
  if (!nonce) {
    nonce = randomUUID();
    nonceByRoot.set(pinned.canonicalRoot, nonce);
  }
  const evidence = rootEvidenceAtPinned(authority, pinned, nonce);
  if (!evidence.ok) return evidence;
  if (!hadKnownNonce) {
    return failureResult(diagnostic("BINDING_REQUIRED", "binding.read", "root_instance_nonce", "Explicitly rebind this sidecar in the current lifecycle before activation.", { path }));
  }
  const expectedInstance = buildProjectWorktreeInstanceId(evidence.value);
  if (parsed.value.project_worktree_instance !== expectedInstance) {
    return failureResult(diagnostic("BINDING_REQUIRED", "binding.read", "project_worktree_instance", "The sidecar belongs to another root/worktree instance; explicitly rebind after restart.", { path }));
  }
  runTransactionReadHook(pinned.canonicalRoot);
  const finalTransaction = readTransactionStatusFromPinned(pinned.canonicalRoot, pinned, authority);
  if (!transactionReadAllowed(pinned.canonicalRoot, finalTransaction, transactionAuthority)) {
    const blocked = transactionDiagnostic("binding.read", finalTransaction);
    return failureResult(blocked ?? diagnostic("TRANSACTION_INCOMPLETE", "binding.read", "transaction", "Recover the workflow-v2 transaction marker before reading the binding sidecar."));
  }
  return successResult({
    snapshot: Object.freeze({
      root: pinned.canonicalRoot,
      path,
      document: parsed.value,
      byte_sha256: computePolicyByteHash(read.value.bytes),
      evidence: evidence.value,
    }),
    fingerprint: read.value.fingerprint,
  });
}

function readBindingSnapshotInternal(
  root: CanonicalRoot | string,
  filesystemAuthority: TrustedFsAuthority | undefined,
  transactionAuthority: typeof TRANSACTION_READ_AUTHORITY | undefined,
  providedPinned?: PinnedFsRoot,
): BindingReadResult {
  const path = bindingPath(root) ?? BINDING_RELATIVE_PATH;
  const checked = canonicalRoot(root);
  if (!checked) return failureResult(diagnostic("ROOT_UNAVAILABLE", "root.resolve", "canonical_root", "Resolve one existing physical project root before reading its binding.", { path }));
  if (!isTrustedFsAuthority(filesystemAuthority)) {
    return failureResult(diagnostic("ACTIVATION_FAILED", "root.resolve", "filesystem_authority", "Provide a factory-issued trusted descriptor-relative filesystem authority before reading the binding.", { path, reason: filesystemAuthority === undefined ? "missing" : "foreign" }));
  }
  const authority = filesystemAuthority;
  if (providedPinned && providedPinned.canonicalRoot !== checked) {
    return failureResult(diagnostic("IDENTITY_MISMATCH", "root.resolve", "canonical_root", "The pinned filesystem root does not match the requested canonical root.", { path }));
  }
  let pinned: PinnedFsRoot;
  let ownsPinned = false;
  if (providedPinned) {
    pinned = providedPinned;
  } else {
    const opened = authority.openRoot(checked, { createOmp: false });
    if (!opened.ok) return failureResult(authorityDiagnostic("root.resolve", "canonical_root", path, opened));
    pinned = opened.value;
    ownsPinned = true;
  }
  try {
    const result = readBindingAtPinned(authority, pinned, transactionAuthority);
    if (!result.ok) return result;
    if (result.value === null) return failureResult(diagnostic("BINDING_REQUIRED", "binding.read", "path", "Create an explicit root-bound binding before activation.", { path }));
    return successResult(result.value.snapshot);
  } finally {
    if (ownsPinned) pinned.close();
  }
}

/** Read exactly root/.omp/team.config.binding.json through one pinned authority. */
export function readBindingSnapshot(root: CanonicalRoot | string, filesystemAuthority?: TrustedFsAuthority): BindingReadResult {
  return readBindingSnapshotInternal(root, filesystemAuthority, undefined);
}

/** Read binding bytes while management owns a valid transaction journal and explicit filesystem authority. */
export function readBindingSnapshotDuringTransaction(
  root: CanonicalRoot,
  filesystemAuthority: TrustedFsAuthority | undefined,
  transactionAuthority: typeof TRANSACTION_READ_AUTHORITY,
  pinnedRoot?: PinnedFsRoot,
): BindingReadResult {
  return readBindingSnapshotInternal(root, filesystemAuthority, transactionAuthority, pinnedRoot);
}

function writeBindingAfterConfirmationInternal(
  input: RootBoundBindingWrite,
  filesystemAuthority: TrustedFsAuthority | undefined,
  transactionAuthority: typeof TRANSACTION_READ_AUTHORITY | undefined,
  providedPinned?: PinnedFsRoot,
): BindingWriteResult {
  if (!input || input.confirm_root !== true) {
    return failureResult(diagnostic("BINDING_REQUIRED", "binding.write", "confirm_root", "Explicitly confirm the canonical project root before writing a binding."));
  }
  const checked = canonicalRoot(input.root);
  const path = bindingPath(input.root) ?? BINDING_RELATIVE_PATH;
  if (!checked) return failureResult(diagnostic("ROOT_UNAVAILABLE", "root.resolve", "canonical_root", "Write only inside a canonical absolute project root.", { path }));
  if (!isTrustedFsAuthority(filesystemAuthority)) {
    return failureResult(diagnostic("ACTIVATION_FAILED", "root.resolve", "filesystem_authority", "Provide a factory-issued trusted descriptor-relative filesystem authority before writing the binding.", { path, reason: filesystemAuthority === undefined ? "missing" : "foreign" }));
  }
  const authority = filesystemAuthority;
  if (!authority.supportsAtomicCas) return failureResult(diagnostic("ACTIVATION_FAILED", "root.resolve", "filesystem_authority", "Configure a native descriptor-relative CAS implementation before writing the binding.", { path, reason: "atomic_cas_unsupported" }));
  if (!bindingDocumentIsValid(input.document)) {
    return failureResult(diagnostic("CONFIG_MALFORMED", "binding.write", "document", "Write only a closed binding_version 1 document.", { path }));
  }

  let bytes: Buffer;
  try {
    bytes = Buffer.from(`${canonicalPolicyJson(input.document)}\n`, "utf8");
  } catch {
    return failureResult(diagnostic("CONFIG_MALFORMED", "binding.write", "document", "Write only a canonical JSON binding document.", { path }));
  }
  if (bytes.byteLength > BINDING_MAX_BYTES) {
    return failureResult(diagnostic("CONFIG_MALFORMED", "binding.write", "limits", "Keep the binding sidecar below its strict byte limit.", { path }));
  }

  let pinned: PinnedFsRoot;
  let ownsPinned = false;
  if (providedPinned) {
    if (providedPinned.canonicalRoot !== checked) {
      return failureResult(diagnostic("IDENTITY_MISMATCH", "binding.write", "canonical_root", "The pinned filesystem root does not match the requested canonical root.", { path }));
    }
    pinned = providedPinned;
  } else {
    const firstOpen = authority.openRoot(checked, { createOmp: false });
    if (firstOpen.ok) {
      pinned = firstOpen.value;
      ownsPinned = true;
    } else if (firstOpen.reason === "omp_missing") {
      const created = authority.openRoot(checked, { createOmp: true });
      if (!created.ok) return failureResult(authorityDiagnostic("binding.write", "canonical_root", path, created));
      pinned = created.value;
      ownsPinned = true;
    } else {
      return failureResult(authorityDiagnostic("binding.write", "canonical_root", path, firstOpen));
    }
  }

  try {
    const nonce = nonceByRoot.get(checked);
    if (!nonce) return failureResult(diagnostic("BINDING_REQUIRED", "binding.write", "root_instance_nonce", "Build the binding document through the current root evidence boundary.", { path }));
    const evidence = rootEvidenceAtPinned(authority, pinned, nonce);
    if (!evidence.ok) return evidence;
    if (input.document.project_worktree_instance !== buildProjectWorktreeInstanceId(evidence.value)) {
      return failureResult(diagnostic("IDENTITY_MISMATCH", "binding.write", "project_worktree_instance", "Build the binding document from verified root evidence; caller-supplied digests are not accepted.", { path }));
    }

    const currentRead = readBindingAtPinned(authority, pinned, transactionAuthority);
    if (!currentRead.ok) return currentRead;
    const current = currentRead.value;
    const currentSnapshot = current?.snapshot ?? null;
    const currentFingerprint: FsTargetFingerprint = current?.fingerprint ?? Object.freeze({ state: "absent" as const });
    if (currentSnapshot !== null && !input.expected) {
      return failureResult(diagnostic("IDENTITY_MISMATCH", "binding.write", "expected", "Supply unchanged project preconditions for rebind/apply.", { path }));
    }
    if (input.expected && (currentSnapshot === null
      ? input.expected.state !== "absent" || !expectedMatchesDocument(input.expected, checked, input.document)
      : input.expected.state === "absent" || !expectedMatchesDocument(input.expected, checked, input.document))) {
      return failureResult(diagnostic("IDENTITY_MISMATCH", "binding.write", "identity", "Reread the current policy and regenerate the root-bound binding proposal.", { path }));
    }
    if (input.current && (
      currentSnapshot === null
      || input.current.root !== currentSnapshot.root
      || input.current.path !== currentSnapshot.path
      || input.current.byte_sha256 !== currentSnapshot.byte_sha256
      || input.current.document.project_worktree_instance !== currentSnapshot.document.project_worktree_instance
    )) {
      return failureResult(diagnostic("IDENTITY_MISMATCH", "binding.write", "current", "Discard the stale binding proposal and reread the sidecar.", { path }));
    }

    const published = authority.atomicReplaceIfCurrent(pinned.ompDirectory, "team.config.binding.json", currentFingerprint, bytes);
    if (!published.ok) return failureResult(authorityDiagnostic("binding.write", "path", path, published));
    if (published.value.state !== "present"
      || published.value.byte_sha256 !== computePolicyByteHash(bytes)
      || published.value.byte_length !== bytes.byteLength) {
      return failureResult(diagnostic("IDENTITY_MISMATCH", "binding.write", "binding_bytes", "The descriptor-relative CAS returned bytes different from the requested binding.", { path }));
    }
    const finalRead = readBindingAtPinned(authority, pinned, transactionAuthority);
    if (!finalRead.ok) return finalRead;
    if (finalRead.value === null) return failureResult(diagnostic("IDENTITY_MISMATCH", "binding.write", "binding_bytes", "The binding disappeared after descriptor-relative publication.", { path }));
    const finalBytes = Buffer.from(`${canonicalPolicyJson(finalRead.value.snapshot.document)}\n`, "utf8");
    if (!bytes.equals(finalBytes)) {
      return failureResult(diagnostic("IDENTITY_MISMATCH", "binding.write", "binding_bytes", "The final sidecar bytes differ from the requested exact document.", { path }));
    }
    return successResult(finalRead.value.snapshot);
  } finally {
    if (ownsPinned) pinned.close();
  }
}

/** Explicit, confirmed, root-bound sidecar writer. It never infers identity. */
export function writeBindingAfterConfirmation(input: RootBoundBindingWrite, filesystemAuthority?: TrustedFsAuthority): BindingWriteResult {
  return writeBindingAfterConfirmationInternal(input, filesystemAuthority, undefined);
}

/** Write the binding sidecar while management owns a valid transaction journal and explicit filesystem authority. */
export function writeBindingAfterConfirmationDuringTransaction(
  input: RootBoundBindingWrite,
  filesystemAuthority: TrustedFsAuthority | undefined,
  transactionAuthority: typeof TRANSACTION_READ_AUTHORITY,
  pinnedRoot?: PinnedFsRoot,
): BindingWriteResult {
  return writeBindingAfterConfirmationInternal(input, filesystemAuthority, transactionAuthority, pinnedRoot);
}

export type { BindingDocument, BindingSnapshot, BindingValidatedIdentity, RootEvidence } from "./types.js";
