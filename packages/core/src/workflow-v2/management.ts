/* <!-- omp-cto-slice run=01a03ee4-7dd6-7580-8ad7-16d26dc886ba slice=workflow-v2-core --> */

import { createHash } from "node:crypto";
import { closeSync } from "node:fs";
import { join } from "node:path";

import {
  createDiagnostic,
  failureResult,
  successResult,
} from "./diagnostics.js";
import {
  type FsAuthorityResult,
  type FsDirectoryHandle,
  type FsRootDirectory,
  type PinnedFsRoot,
  type TrustedFsAuthority,
  isTrustedFsAuthority,
} from "./fs-authority.js";
import {
  buildBindingDocument,
  readBindingSnapshot,
  readBindingSnapshotDuringTransaction,
  writeBindingAfterConfirmationDuringTransaction,
} from "./binding.js";
import {
  advanceTransactionWitness,
  beginTransactionWitness,
  bindTransactionWitnessJournal,
  forgetTransactionWitness,
  readTransactionStatus,
  readTransactionStatusFromPinned,
  readTransactionStatusFromRoot,
  transactionJournalPath,
  transactionWitnessValid,
  TRANSACTION_JOURNAL_NAME,
  TRANSACTION_READ_AUTHORITY,
  TRANSACTION_MAX_BYTES,
  type TargetFingerprint,
  type TransactionJournal,
  type TransactionOldTarget,
  type TransactionPhase,
  type TransactionStatus,
  type TransactionWitness,
} from "./transaction.js";
import {
  createCanonicalRoot,
  createProviderId,
  isCanonicalRoot,
  isProviderId,
  isWorkflowV2Digest,
} from "./identity.js";
import {
  buildProviderAgentInventory,
  validateProviderAgentInventory,
} from "./descriptor.js";
import {
  listProviderQuarantine,
  listProviders,
  lookupProvider,
  validateProviderCapabilities,
} from "./registry.js";
import {
  canonicalPolicyJson,
  computePolicySemanticHash,
  mergePolicy,
  readPolicySnapshot,
  parsePolicyDocument,
  readPolicySnapshotDuringTransaction,
  writePolicyDocumentDuringTransaction,
  type PolicyWriteResult,
} from "./policy.js";
import { parseStrictJsonValue } from "./strict-json.js";
import type {
  AgentRef,
  BindingDocument,
  BindingReadResult,
  BindingSnapshot,
  BindingValidatedIdentity,
  CanonicalRoot,
  DiagnosticOperation,
  DiagnosticResult,
  EffectivePolicy,
  FieldOperation,
  ManagementContext as TrustedManagementContext,
  ManagementProposal,
  PolicyReadResult,
  ProviderManagementResult,
  BindingWriteResult,
  ManagementResult,
  PathIdentity,
  PolicyDocument,
  PolicyFieldValue,
  PolicyPrecondition,
  PromptContextEntry,
  PolicyFragment,
  PolicyProviderRef,
  PolicySnapshot,
  PresentPolicyPrecondition,
  ProjectIdentity,
  ProviderApplyRequest,
  ProviderCreateRequest,
  ProviderId,
  ProviderListRequest,
  ProviderManagementRequest,
  ProviderMigrateRequest,
  ProviderQuarantine,
  ProviderRecord,
  ProviderRefreshRequest,
  ProviderSelectRequest,
  ProviderStatusRequest,
  ProviderRegistry,
  RootEvidence,
  RosterOverride,
  RosterPatch,
  ScopePatch,
  ScopeRule,
  WorkflowPolicy,
  WorkflowSelection,
  WorkflowV2Diagnostic,
  WorkflowV2Digest,
} from "./types.js";

const POLICY_PARTS = [".omp", "team.config.json"] as const;
const LEGACY_PARTS = [".claude", "team.config.json"] as const;
const TRANSACTION_LOCK_NAME = ".workflow-v2.transaction.lock" as const;
const SAFE_IDENTIFIER = /^[A-Za-z0-9@._:/#-]+$/u;
const SAFE_CAPABILITY = /^[A-Za-z][A-Za-z0-9@._:/#-]*$/u;
type RecordValue = Record<string, unknown>;
type V2Diagnostic = WorkflowV2Diagnostic;
type ReadPolicy = { readonly snapshot: PolicySnapshot | null; readonly diagnostics: readonly V2Diagnostic[] };
type ReadBinding = { readonly snapshot: BindingSnapshot | null; readonly diagnostics: readonly V2Diagnostic[] };
type RootEvidenceResult = DiagnosticResult<RootEvidence>;
type ManagementOperation = ManagementResult["operation"];
type ProviderObservations = Readonly<{
  providers: readonly ProviderRecord[];
  quarantined: readonly ProviderQuarantine[];
  diagnostics: readonly V2Diagnostic[];
}>;

type LegacyExpectation = Readonly<{
  path: string;
  byte_sha256: WorkflowV2Digest;
  fingerprint: TargetFingerprint;
}>;

type InternalProposal = ManagementProposal & {
  readonly legacy_input?: LegacyExpectation;
};

type ManagementReadContext = Readonly<{
  policy: ReadPolicy;
  binding: ReadBinding;
  rootEvidence: RootEvidenceResult;
  manager: TrustedManagementContext;
}>;

type LegacyCandidate = Readonly<{
  path: string;
  bytes: Buffer;
  byte_sha256: WorkflowV2Digest;
  fingerprint: TargetFingerprint;
  value: RecordValue;
}>;


type ApplyState = Readonly<{
  candidate: InternalProposal;
  current: PolicySnapshot | null;
  binding: BindingSnapshot | null;
  root_instance_id: WorkflowV2Digest;
  manager: TrustedManagementContext;
  provider: ProviderRecord;
  merged: DiagnosticResult<EffectivePolicy>;
  diagnostics: readonly V2Diagnostic[];
  legacy: LegacyCandidate | null;
}>;

function record(value: unknown): value is RecordValue {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function opFor(operation: unknown): DiagnosticOperation {
  switch (operation) {
    case "list":
      return "management.list";
    case "status":
      return "management.status";
    case "select":
      return "management.select";
    case "create":
      return "management.create";
    case "refresh":
      return "management.refresh";
    case "migrate":
      return "management.migrate";
    case "apply":
      return "management.apply";
    default:
      return "management.list";
  }
}

function diag(
  code: V2Diagnostic["code"],
  operation: DiagnosticOperation,
  remediation: string,
  evidence: RecordValue = {},
  severity: V2Diagnostic["severity"] = "error",
): V2Diagnostic {
  return createDiagnostic({ code, operation, remediation, evidence, severity });
}

function failed<T>(
  code: V2Diagnostic["code"],
  operation: DiagnosticOperation,
  remediation: string,
  evidence: RecordValue = {},
): DiagnosticResult<T> {
  return failureResult(diag(code, operation, remediation, evidence));
}

function remapDiagnostics(
  diagnostics: readonly V2Diagnostic[],
  operation: DiagnosticOperation,
): readonly V2Diagnostic[] {
  return Object.freeze(diagnostics.map((entry) => createDiagnostic({
    code: entry.code,
    operation,
    severity: entry.severity,
    evidence: entry.evidence,
    remediation: entry.remediation,
  })));
}

function policyPath(root: CanonicalRoot): string {
  return join(root, ...POLICY_PARTS);
}
function legacyPath(root: CanonicalRoot): string {
  return join(root, ...LEGACY_PARTS);
}
function bindingPath(root: CanonicalRoot): string {
  return join(root, ".omp", "team.config.binding.json");
}

type AuthorityResult<T> = FsAuthorityResult<T>;
type ManagementFsAuthority = TrustedFsAuthority;

type TransactionLock = Readonly<{
  authority: ManagementFsAuthority;
  pinned: PinnedFsRoot;
  token: object;
  fingerprint: TargetFingerprint;
  parent_identity: PathIdentity;
  release: () => void;
}>;

type TargetRead = Readonly<{
  fingerprint: TargetFingerprint;
  bytes: Buffer | null;
}>;

type BegunTransaction = Readonly<{
  journal: TransactionJournal;
  witness: TransactionWitness;
  journal_fingerprint: TargetFingerprint;
}>;

function managerAuthority(manager: TrustedManagementContext): ManagementFsAuthority | undefined {
  const authority = manager.filesystem_authority;
  return isTrustedFsAuthority(authority) ? authority : undefined;
}

function transactionLockPath(root: CanonicalRoot): string {
  return join(root, TRANSACTION_LOCK_NAME);
}

function authorityFailure<T>(
  result: AuthorityResult<T>,
  operation: DiagnosticOperation,
  remediation: string,
  evidence: RecordValue,
): DiagnosticResult<T> {
  const reason = result.ok ? "unsupported" : result.reason;
  const code = reason === "unsafe" || reason === "invalid_root" || reason === "omp_missing"
    ? "UNSAFE_PATH"
    : "ACTIVATION_FAILED";
  return failed(code, operation, remediation, { ...evidence, authority_reason: reason });
}

function authorityFingerprint(value: unknown): TargetFingerprint | undefined {
  if (!record(value) || value.state === "absent") {
    return record(value) && value.state === "absent" ? Object.freeze({ state: "absent" as const }) : undefined;
  }
  const length = value.byte_length;
  if (
    value.state !== "present"
    || (typeof value.device !== "string" && typeof value.device !== "number")
    || (typeof value.inode !== "string" && typeof value.inode !== "number")
    || typeof value.byte_sha256 !== "string"
    || !/^sha256:[0-9a-f]{64}$/u.test(value.byte_sha256)
    || typeof length !== "number"
    || !Number.isSafeInteger(length)
    || length < 0
    || length > TRANSACTION_MAX_BYTES
  ) return undefined;
  return Object.freeze({
    state: "present" as const,
    device: String(value.device),
    inode: String(value.inode),
    byte_sha256: value.byte_sha256 as WorkflowV2Digest,
    byte_length: length,
  });
}

function targetFingerprintValid(value: unknown): value is TargetFingerprint {
  if (!record(value)) return false;
  if (value.state === "absent") return Object.keys(value).length === 1;
  if (value.state !== "present" || Object.keys(value).length !== 5) return false;
  const fingerprint = authorityFingerprint(value);
  return fingerprint !== undefined
    && fingerprint.state === "present"
    && fingerprint.device === value.device
    && fingerprint.inode === value.inode
    && fingerprint.byte_sha256 === value.byte_sha256
    && fingerprint.byte_length === value.byte_length;
}

function sameTargetFingerprint(left: TargetFingerprint, right: TargetFingerprint): boolean {
  if (left.state !== right.state) return false;
  if (left.state === "absent" || right.state === "absent") return true;
  return left.device === right.device
    && left.inode === right.inode
    && left.byte_sha256 === right.byte_sha256
    && left.byte_length === right.byte_length;
}

function sameTargetContent(left: TargetFingerprint, right: TargetFingerprint): boolean {
  if (left.state !== right.state) return false;
  return left.state === "absent"
    || (right.state === "present"
      && left.byte_sha256 === right.byte_sha256
      && left.byte_length === right.byte_length);
}

function targetRead(
  authority: ManagementFsAuthority,
  directory: FsDirectoryHandle,
  leaf: string,
  maxBytes: number,
  operation: DiagnosticOperation,
  root: CanonicalRoot,
): DiagnosticResult<TargetRead> {
  const result = authority.readBounded(directory, leaf, maxBytes);
  if (!result.ok) {
    return authorityFailure(result, operation, "Use the trusted descriptor-relative filesystem authority for bounded target reads.", {
      canonical_root: root,
      leaf,
    });
  }
  if (result.value === null) return successResult(Object.freeze({ fingerprint: Object.freeze({ state: "absent" as const }), bytes: null }));
  const fingerprint = authorityFingerprint(result.value.fingerprint);
  if (!fingerprint || fingerprint.state !== "present" || result.value.bytes.byteLength !== fingerprint.byte_length) {
    return failed(
      "ACTIVATION_FAILED",
      operation,
      "The descriptor-relative target read returned an invalid bounded fingerprint; preserve the root.",

      { canonical_root: root, leaf },
    );
  }
  return successResult(Object.freeze({ fingerprint, bytes: result.value.bytes }));
}
function pathIdentityFromDirectory(device: string, inode: string): PathIdentity {
  return `${device}:${inode}` as PathIdentity;
}

function pathIdentityFromTarget(fingerprint: TargetFingerprint): PathIdentity | undefined {
  return fingerprint.state === "present"
    ? `${fingerprint.device}:${fingerprint.inode}:${fingerprint.byte_length}` as PathIdentity
    : undefined;
}

function targetIdentityMatches(identity: PathIdentity, fingerprint: TargetFingerprint): boolean {
  if (fingerprint.state !== "present") return false;
  const fields = identity.split(":");
  if (fields.length !== 3 || fields[0] !== fingerprint.device || fields[1] !== fingerprint.inode) return false;
  return fields[2] === String(fingerprint.byte_length);
}

type ProposalPathIdentities = Readonly<{
  parent: PathIdentity;
  policy: PathIdentity | undefined;
}>;

function proposalPathIdentities(
  root: CanonicalRoot,
  current: PolicySnapshot | null,
  operation: DiagnosticOperation,
  authority: ManagementFsAuthority,
): DiagnosticResult<ProposalPathIdentities> {
  const opened = authority.openRoot(root, { createOmp: false });
  if (opened.ok) {
    try {
      const policy = current === null
        ? undefined
        : (() => {
          const read = targetRead(authority, opened.value.ompDirectory, "team.config.json", TRANSACTION_MAX_BYTES, operation, root);
          if (!read.ok || read.value.fingerprint.state !== "present") return undefined;
          if (
            read.value.fingerprint.byte_sha256 !== current.byte_sha256
            || read.value.fingerprint.byte_length !== current.byte_length
          ) return undefined;
          return pathIdentityFromTarget(read.value.fingerprint);
        })();
      if (current !== null && policy === undefined) {
        return failed("IDENTITY_MISMATCH", operation, "The descriptor-relative policy fingerprint changed while creating the proposal; reread the project.", {
          canonical_root: root,
          policy_path: policyPath(root),
        });
      }
      return successResult(Object.freeze({
        parent: pathIdentityFromDirectory(opened.value.ompDevice, opened.value.ompInode),
        policy,
      }));
    } finally {
      try { opened.value.close(); } catch { /* preserve the immutable proposal result */ }
    }
  }
  if (opened.reason !== "omp_missing" || current !== null || !authority.openRootDirectory) {
    return authorityFailure(opened, operation, "Open the proposal root and .omp parent through the trusted descriptor-relative authority.", {
      canonical_root: root,
      policy_path: policyPath(root),
    });
  }
  const rootOpened = authority.openRootDirectory(root);
  if (!rootOpened.ok) {
    return authorityFailure(rootOpened, operation, "Open the proposal root parent through the trusted descriptor-relative authority.", {
      canonical_root: root,
      policy_path: policyPath(root),
    });
  }
  try {
    return successResult(Object.freeze({
      parent: pathIdentityFromDirectory(rootOpened.value.rootDevice, rootOpened.value.rootInode),
      policy: undefined,
    }));
  } finally {
    try { rootOpened.value.close(); } catch { /* preserve the immutable proposal result */ }
  }
}

function rootTargetPresent(
  root: CanonicalRoot,
  leaf: string,
  operation: DiagnosticOperation,
  authority: ManagementFsAuthority,
): DiagnosticResult<boolean> {
  const opened = authority.openRoot(root, { createOmp: false });
  if (!opened.ok) {
    if (opened.reason === "omp_missing") return successResult(false);
    return authorityFailure(opened, operation, "Open the root target through the trusted descriptor-relative authority.", {
      canonical_root: root,
      leaf,
    });
  }
  try {
    const inspected = authority.inspect(opened.value.ompDirectory, leaf);
    if (!inspected.ok) {
      return authorityFailure(inspected, operation, "Inspect the root target through the trusted descriptor-relative authority.", {
        canonical_root: root,
        leaf,
      });
    }
    return successResult(inspected.value !== null);
  } finally {
    try { opened.value.close(); } catch { /* preserve the immutable read result */ }
  }
}

function syncDirectory(
  root: CanonicalRoot,
  authority: ManagementFsAuthority,
  directory: FsDirectoryHandle,
  operation: DiagnosticOperation,
  leaf: string,
): readonly V2Diagnostic[] {
  const synced = authority.fsyncDirectory(directory);
  return synced.ok
    ? []
    : authorityFailure(synced, operation, "Durably synchronize the descriptor-relative directory after publication.", {
      canonical_root: root,
      leaf,
    }).diagnostics;
}

function oldTarget(read: TargetRead, image: TransactionOldTarget["image"]): TransactionOldTarget {
  if (read.fingerprint.state === "absent") {
    return Object.freeze({ state: "absent" as const, image: Object.freeze({ kind: "none" as const }) });
  }
  return Object.freeze({
    state: "present" as const,
    device: read.fingerprint.device,
    inode: read.fingerprint.inode,
    byte_sha256: read.fingerprint.byte_sha256,
    byte_length: read.fingerprint.byte_length,
    image: Object.freeze(image),
  });
}

function cleanupTransactionImages(
  root: CanonicalRoot,
  authority: ManagementFsAuthority,
  pinned: PinnedFsRoot,
  journal: TransactionJournal,
): readonly V2Diagnostic[] {
  const images = new Map<string, TargetFingerprint>();
  for (const image of [journal.old_policy.image, journal.old_binding.image]) {
    if (image.kind !== "backup") continue;
    const previous = images.get(image.path);
    if (previous && !sameTargetFingerprint(previous, image.fingerprint)) {
      return [diag("IDENTITY_MISMATCH", "management.apply", "The completed transaction references one backup path with conflicting fingerprints; preserve targets and retry bounded backup cleanup.", {
        canonical_root: root,
        path: image.path,
      })];
    }
    images.set(image.path, image.fingerprint);
  }
  for (const [path, expected] of images) {
    const current = targetRead(authority, pinned.ompDirectory, path, TRANSACTION_MAX_BYTES, "management.apply", root);
    if (!current.ok) return current.diagnostics;
    if (current.value.fingerprint.state === "absent") continue;
    if (!sameTargetFingerprint(current.value.fingerprint, expected)) {
      return [diag("IDENTITY_MISMATCH", "management.apply", "The completed transaction backup changed; preserve targets and retry bounded backup cleanup.", {
        canonical_root: root,
        path,
      })];
    }
    const removed = authority.atomicRemoveIfCurrent(pinned.ompDirectory, path, expected);
    if (!removed.ok) {
      return authorityFailure(removed, "management.apply", "The completed transaction backup could not be removed through descriptor-relative CAS; preserve targets and retry bounded backup cleanup.", {
        canonical_root: root,
        path,
      }).diagnostics;
    }
    const removedFingerprint = authorityFingerprint(removed.value);
    if (!removedFingerprint || removedFingerprint.state !== "absent") {
      return [diag("IDENTITY_MISMATCH", "management.apply", "The completed transaction backup removal returned a present target; preserve targets and retry bounded backup cleanup.", {
        canonical_root: root,
        path,
      })];
    }
    const synced = syncDirectory(root, authority, pinned.ompDirectory, "management.apply", path);
    if (synced.length > 0) return synced;
}

  return [];
}
function cleanupBackupCandidate(
  authority: ManagementFsAuthority,
  directory: FsDirectoryHandle,
  root: CanonicalRoot,
  transactionId: string,
  target: "policy" | "binding",
  source: TargetRead,
): readonly V2Diagnostic[] {
  const path = backupPath(transactionId, target);
  const current = targetRead(authority, directory, path, TRANSACTION_MAX_BYTES, "management.apply", root);
  if (!current.ok) return current.diagnostics;
  if (current.value.fingerprint.state === "absent") return [];
  if (!sameTargetContent(current.value.fingerprint, source.fingerprint)) {
    return [diag("IDENTITY_MISMATCH", "management.apply", "A transaction backup candidate changed before cleanup; preserve the root.", {
      canonical_root: root,
      path,
    })];
  }
  const removed = authority.atomicRemoveIfCurrent(directory, path, current.value.fingerprint);
  if (!removed.ok) {
    return authorityFailure(removed, "management.apply", "The transaction backup candidate could not be removed safely; preserve the root.", {
      canonical_root: root,
      path,
    }).diagnostics;
  }
  const removedFingerprint = authorityFingerprint(removed.value);
  if (!removedFingerprint || removedFingerprint.state !== "absent") {
    return [diag("IDENTITY_MISMATCH", "management.apply", "The transaction backup candidate removal returned a present target; preserve the root.", {
      canonical_root: root,
      path,
    })];
  }
  return syncDirectory(root, authority, directory, "management.apply", "transaction-backups");
}

function backupPath(transactionId: string, target: "policy" | "binding"): string {
  return `.workflow-v2.transaction.${transactionId}.${target}.bak`;
}
function createBackup(
  authority: ManagementFsAuthority,
  directory: FsDirectoryHandle,
  root: CanonicalRoot,
  transactionId: string,
  target: "policy" | "binding",
  read: TargetRead,
): DiagnosticResult<TransactionOldTarget["image"]> {
  if (read.fingerprint.state === "absent" || read.bytes === null) {
    return successResult(Object.freeze({ kind: "none" as const }));
  }
  const path = backupPath(transactionId, target);
  const replaced = authority.atomicReplaceIfCurrent(
    directory,
    path,
    Object.freeze({ state: "absent" as const }),
    read.bytes,
  );
  if (!replaced.ok) {
    return authorityFailure(replaced, "management.apply", "The transaction backup could not be published through descriptor-relative CAS; preserve the root.", {
      canonical_root: root,
      path,
    });
  }
  const backupSync = syncDirectory(root, authority, directory, "management.apply", path);
  if (backupSync.length > 0) return failureResult(backupSync);
  const fingerprint = authorityFingerprint(replaced.value);
  if (!fingerprint || fingerprint.state !== "present" || !sameTargetContent(fingerprint, read.fingerprint)) {
    return failed(
      "IDENTITY_MISMATCH",
      "management.apply",
      "The descriptor-relative transaction backup fingerprint differs from the source bytes; preserve the root.",
      { canonical_root: root, path },
    );
  }
  return successResult(Object.freeze({ kind: "backup" as const, path, fingerprint }));
}
function transactionJournalStatus(
  root: CanonicalRoot,
  authority: ManagementFsAuthority,
  pinned?: PinnedFsRoot,
): TransactionStatus {
  return pinned
    ? readTransactionStatusFromPinned(root, pinned, authority)
    : readTransactionStatus(root, authority);
}
function writeTransactionJournal(
  root: CanonicalRoot,
  authority: ManagementFsAuthority,
  pinned: PinnedFsRoot,
  journal: TransactionJournal,
  expected: TargetFingerprint,
): DiagnosticResult<TargetFingerprint> {
  let bytes: Buffer;
  try {
    bytes = Buffer.from(`${canonicalPolicyJson(journal)}\n`, "utf8");
  } catch {
    return failed("CONFIG_MALFORMED", "management.apply", "The transaction journal must remain strict canonical JSON.", {
      canonical_root: root,
      journal_path: transactionJournalPath(root),
    });
  }
  if (bytes.byteLength > TRANSACTION_MAX_BYTES) {
    return failed("CONFIG_MALFORMED", "management.apply", "The transaction journal exceeds its bounded byte limit; preserve the root.", {
      canonical_root: root,
      journal_path: transactionJournalPath(root),
    });
  }
  const replaced = authority.atomicReplaceIfCurrent(
    pinned.rootDirectory,
    TRANSACTION_JOURNAL_NAME,
    expected,
    bytes,
  );
  if (!replaced.ok) {
    return authorityFailure(replaced, "management.apply", "The transaction journal CAS failed; preserve all targets and retry explicit recovery.", {
      canonical_root: root,
      journal_path: transactionJournalPath(root),
    });
  }
  const journalSync = syncDirectory(root, authority, pinned.rootDirectory, "management.apply", TRANSACTION_JOURNAL_NAME);
  if (journalSync.length > 0) return failureResult(journalSync);
  const fingerprint = authorityFingerprint(replaced.value);
  if (
    !fingerprint
    || fingerprint.state !== "present"
    || fingerprint.byte_sha256 !== byteDigest(bytes)
    || fingerprint.byte_length !== bytes.byteLength
  ) {
    return failed("IDENTITY_MISMATCH", "management.apply", "The transaction journal authority returned bytes different from the canonical journal; preserve the root.", {
      canonical_root: root,
      journal_path: transactionJournalPath(root),
    });
  }
  const reread = targetRead(authority, pinned.rootDirectory, TRANSACTION_JOURNAL_NAME, TRANSACTION_MAX_BYTES, "management.apply", root);
  if (
    !reread.ok
    || reread.value.bytes === null
    || !reread.value.bytes.equals(bytes)
    || !sameTargetFingerprint(reread.value.fingerprint, fingerprint)
  ) {
    return failed("IDENTITY_MISMATCH", "management.apply", "The transaction journal changed after publication; preserve all targets and retry explicit recovery.", {
      canonical_root: root,
      journal_path: transactionJournalPath(root),
    });
  }
  return successResult(fingerprint);
}
function readTransactionJournal(
  root: CanonicalRoot,
  authority: ManagementFsAuthority,
  pinned?: PinnedFsRoot,
): DiagnosticResult<TransactionJournal | null> {
  const status = transactionJournalStatus(root, authority, pinned);
  if (status.status === "clear") return successResult(null);
  if (status.status === "incomplete") return successResult(status.journal);
  if (status.reason === "unsafe") {
    return failed("ACTIVATION_FAILED", "management.apply", "The transaction journal is unsafe or unavailable; preserve the root and use explicit recovery.", {
      canonical_root: root,
      journal_path: status.path,
    });
  }
  if (status.reason === "malformed") {
    return failed("ACTIVATION_FAILED", "management.apply", "The transaction journal is malformed or oversized; preserve the root and recover it explicitly.", {
      canonical_root: root,
      journal_path: status.path,
    });
  }
  return failed("ACTIVATION_FAILED", "management.apply", "The transaction journal does not match this canonical root; preserve the root and recover it explicitly.", {
    canonical_root: root,
    journal_path: status.path,
  });
}

function clearTransactionJournal(
  root: CanonicalRoot,
  authority: ManagementFsAuthority,
  pinned: PinnedFsRoot,
  expected: TargetFingerprint,
  journal?: TransactionJournal,
): readonly V2Diagnostic[] {
  // Remove and durably publish the marker before deleting backups. If backup
  // cleanup fails, the bounded orphan images are no longer recovery authority.
  const removed = authority.atomicRemoveIfCurrent(
    pinned.rootDirectory,
    TRANSACTION_JOURNAL_NAME,
    expected,
  );
  if (!removed.ok) {
    return [diag(
      "ACTIVATION_FAILED",
      "management.apply",
      "The completed transaction journal CAS failed; management remains fail-closed until explicit recovery.",
      { canonical_root: root, journal_path: transactionJournalPath(root) },
    )];
  }
  const removedFingerprint = authorityFingerprint(removed.value);
  if (!removedFingerprint || removedFingerprint.state !== "absent") {
    return [diag(
      "IDENTITY_MISMATCH",
      "management.apply",
      "The completed transaction journal removal returned a present target; preserve the root.",
      { canonical_root: root, journal_path: transactionJournalPath(root) },
    )];
  }
  const synced = authority.fsyncDirectory(pinned.rootDirectory);
  if (!synced.ok) {
    return [diag(
      "ACTIVATION_FAILED",
      "management.apply",
      "The transaction journal directory could not be durably synchronized; preserve the root.",
      { canonical_root: root, journal_path: transactionJournalPath(root), authority_reason: synced.reason },
    )];
  }
  if (!journal) return [];
  const cleanup = cleanupTransactionImages(root, authority, pinned, journal);
  return cleanup;
}

function acquireTransactionLock(
  root: CanonicalRoot,
  authority: ManagementFsAuthority,
): DiagnosticResult<TransactionLock> {
  let parentIdentity: PathIdentity;
  let parentIsOmp = false;
  const existingRoot = authority.openRoot(root, { createOmp: false });
  if (existingRoot.ok) {
    parentIdentity = pathIdentityFromDirectory(existingRoot.value.ompDevice, existingRoot.value.ompInode);
    parentIsOmp = true;
    try { existingRoot.value.close(); } catch { /* preserve the descriptor-relative preflight result */ }
  } else if (existingRoot.reason === "omp_missing" && authority.openRootDirectory) {
    const rootOnly = authority.openRootDirectory(root);
    if (!rootOnly.ok) {
      return authorityFailure(rootOnly, "management.apply", "Open the canonical root parent through the trusted descriptor-relative authority.", {
        canonical_root: root,
        lock_path: transactionLockPath(root),
      });
    }
    parentIdentity = pathIdentityFromDirectory(rootOnly.value.rootDevice, rootOnly.value.rootInode);
    try { rootOnly.value.close(); } catch { /* preserve the descriptor-relative preflight result */ }
  } else {
    return authorityFailure(existingRoot, "management.apply", "Open the canonical root and .omp parent through the trusted descriptor-relative authority.", {
      canonical_root: root,
      lock_path: transactionLockPath(root),
    });
  }
  const opened = authority.openRoot(root, { createOmp: true });
  if (!opened.ok) {
    return authorityFailure(opened, "management.apply", "Open the canonical root and .omp directory through the trusted descriptor-relative authority.", {
      canonical_root: root,
      lock_path: transactionLockPath(root),
    });
  }
  const pinned = opened.value;
  const closeOnFailure = (): void => {
    try { pinned.close(); } catch { /* preserve the typed acquisition result */ }
  };
  const observedParent = parentIsOmp
    ? pathIdentityFromDirectory(pinned.ompDevice, pinned.ompInode)
    : pathIdentityFromDirectory(pinned.rootDevice, pinned.rootInode);
  if (observedParent !== parentIdentity) {
    closeOnFailure();
    return failed(
      "IDENTITY_MISMATCH",
      "management.apply",
      "The trusted root or .omp parent changed while establishing the transaction boundary; preserve the root.",
      {
        canonical_root: root,
        expected_parent_identity: parentIdentity,
        actual_parent_identity: observedParent,
      },
    );
  }
  try {
    const existing = targetRead(authority, pinned.rootDirectory, TRANSACTION_LOCK_NAME, 4096, "management.apply", root);
    if (!existing.ok) {
      closeOnFailure();
      return failureResult(existing.diagnostics);
    }
    const existingFingerprint = existing.value.fingerprint;
    if (existingFingerprint.state === "present") {
      closeOnFailure();
      return failed("ACTIVATION_FAILED", "management.apply", "Another workflow-v2 transaction owns the project lock; stale lock bytes are never deleted automatically.", {
        canonical_root: root,
        lock_path: transactionLockPath(root),
      });
    }
    const token = Object.freeze({});
    const lockBytes = Buffer.from(`${process.pid}:${Date.now()}\n`, "utf8");
    const created = authority.atomicReplaceIfCurrent(
      pinned.rootDirectory,
      TRANSACTION_LOCK_NAME,
      Object.freeze({ state: "absent" as const }),
      lockBytes,
    );
    if (!created.ok) {
      closeOnFailure();
      return authorityFailure(created, "management.apply", "The workflow-v2 project lock could not be acquired by descriptor-relative CAS.", {
        canonical_root: root,
        lock_path: transactionLockPath(root),
      });
    }
    const lockSync = syncDirectory(root, authority, pinned.rootDirectory, "management.apply", TRANSACTION_LOCK_NAME);
    if (lockSync.length > 0) {
      closeOnFailure();
      return failureResult(lockSync);
    }
    const fingerprint = authorityFingerprint(created.value);
    if (
      !fingerprint
      || fingerprint.state !== "present"
      || fingerprint.byte_sha256 !== byteDigest(lockBytes)
      || fingerprint.byte_length !== lockBytes.byteLength
    ) {
      closeOnFailure();
      return failed("IDENTITY_MISMATCH", "management.apply", "The workflow-v2 lock authority returned bytes different from the lock token; preserve the root.", {
        canonical_root: root,
        lock_path: transactionLockPath(root),
      });
    }
    const reread = targetRead(authority, pinned.rootDirectory, TRANSACTION_LOCK_NAME, 4096, "management.apply", root);
    if (
      !reread.ok
      || reread.value.bytes === null
      || !reread.value.bytes.equals(lockBytes)
      || !sameTargetFingerprint(reread.value.fingerprint, fingerprint)
    ) {
      closeOnFailure();
      return failed("IDENTITY_MISMATCH", "management.apply", "The workflow-v2 lock changed after publication; preserve the root.", {
        canonical_root: root,
        lock_path: transactionLockPath(root),
      });
    }
    return successResult(Object.freeze({
      authority,
      pinned,
      token,
      fingerprint,
      parent_identity: parentIdentity,
      release: (): void => {
        try {
          const removed = authority.atomicRemoveIfCurrent(pinned.rootDirectory, TRANSACTION_LOCK_NAME, fingerprint);
          if (!removed.ok) return;
          const removedFingerprint = authorityFingerprint(removed.value);
          if (!removedFingerprint || removedFingerprint.state !== "absent") return;
          const synced = authority.fsyncDirectory(pinned.rootDirectory);
          if (!synced.ok) return;
        } finally {
          try { pinned.close(); } catch { /* preserve stale lock for fail-closed recovery */ }
        }
      },
    }));
  } catch {
    closeOnFailure();
    return failed("ACTIVATION_FAILED", "management.apply", "The workflow-v2 project lock could not be acquired safely.", {
      canonical_root: root,
      lock_path: transactionLockPath(root),
    });
  }
}

function beginTransactionJournal(
  root: CanonicalRoot,
  state: ApplyState,
  lock: TransactionLock,
): DiagnosticResult<BegunTransaction> {
  const authority = lock.authority;
  const policyRead = targetRead(authority, lock.pinned.ompDirectory, "team.config.json", 262_144, "management.apply", root);
  if (!policyRead.ok) return policyRead;
  const bindingRead = targetRead(authority, lock.pinned.ompDirectory, "team.config.binding.json", 64 * 1024, "management.apply", root);
  if (!bindingRead.ok) return bindingRead;
  const issued = beginTransactionWitness({
    canonical_root: root,
    proposal_digest: state.candidate.proposal_digest,
    worktree_id: state.manager.worktree_id,
    session_id: state.manager.session.session_id,
    lifecycle_id: state.manager.session.lifecycle_id,
    old_policy: policyRead.value.fingerprint,
    old_binding: bindingRead.value.fingerprint,
    new_policy: Object.freeze({ state: "absent" as const }),
    new_binding: Object.freeze({ state: "absent" as const }),
    lock_token: lock.token,
  });
  const policyImage = createBackup(authority, lock.pinned.ompDirectory, root, issued.transaction_id, "policy", policyRead.value);
  if (!policyImage.ok) {
    const cleanup = cleanupBackupCandidate(authority, lock.pinned.ompDirectory, root, issued.transaction_id, "policy", policyRead.value);
    forgetTransactionWitness(issued.witness);
    return cleanup.length > 0
      ? failureResult([...policyImage.diagnostics, ...cleanup])
      : policyImage;
  }
  const bindingImage = createBackup(authority, lock.pinned.ompDirectory, root, issued.transaction_id, "binding", bindingRead.value);
  if (!bindingImage.ok) {
    const cleanup = [
      ...cleanupBackupCandidate(authority, lock.pinned.ompDirectory, root, issued.transaction_id, "policy", policyRead.value),
      ...cleanupBackupCandidate(authority, lock.pinned.ompDirectory, root, issued.transaction_id, "binding", bindingRead.value),
    ];
    forgetTransactionWitness(issued.witness);
    return cleanup.length > 0
      ? failureResult([...bindingImage.diagnostics, ...cleanup])
      : bindingImage;
  }
  const journal: TransactionJournal = Object.freeze({
    version: 2,
    transaction_id: issued.transaction_id,
    canonical_root: root,
    policy_path: policyPath(root),
    binding_path: bindingPath(root),
    phase: "prepared",
    old_policy: oldTarget(policyRead.value, policyImage.value),
    old_binding: oldTarget(bindingRead.value, bindingImage.value),
    new_policy: Object.freeze({ state: "absent" as const }),
    new_binding: Object.freeze({ state: "absent" as const }),
  });
  const written = writeTransactionJournal(root, lock.authority, lock.pinned, journal, Object.freeze({ state: "absent" as const }));
  if (!written.ok) {
    forgetTransactionWitness(issued.witness);
    return written;
  }
  if (!bindTransactionWitnessJournal(issued.witness, journal)) {
    forgetTransactionWitness(issued.witness);
    return failed("ACTIVATION_FAILED", "management.apply", "The private transaction witness could not bind the prepared journal; preserve the root.", {
      canonical_root: root,
      journal_path: transactionJournalPath(root),
    });
  }
  return successResult(Object.freeze({
    journal,
    witness: issued.witness,
    journal_fingerprint: written.value,
  }));
}

function isManagementOperation(value: unknown): value is Exclude<ManagementOperation, "list" | "status" | "apply"> {
  return value === "select" || value === "create" || value === "refresh" || value === "migrate";
}

function readPolicy(
  root: CanonicalRoot,
  filesystemAuthority: ManagementFsAuthority,
  transactionAuthority?: typeof TRANSACTION_READ_AUTHORITY,
  pinned?: PinnedFsRoot,
): ReadPolicy {
  try {
    const result = transactionAuthority === TRANSACTION_READ_AUTHORITY
      ? readPolicySnapshotDuringTransaction(root, filesystemAuthority, TRANSACTION_READ_AUTHORITY, pinned)
      : readPolicySnapshot(root, filesystemAuthority);
    return result.ok
      ? { snapshot: result.value, diagnostics: result.diagnostics }
      : { snapshot: null, diagnostics: result.diagnostics };
  } catch {
    return {
      snapshot: null,
      diagnostics: [diag(
        "CONFIG_MALFORMED",
        "policy.read",
        "Read the strict v2 policy at the exact manager-owned root.",
        { canonical_root: root, path: policyPath(root) },
      )],
    };
  }
}

function readBinding(
  root: CanonicalRoot,
  filesystemAuthority: ManagementFsAuthority,
  transactionAuthority?: typeof TRANSACTION_READ_AUTHORITY,
  pinned?: PinnedFsRoot,
): ReadBinding {
  try {
    const result = transactionAuthority === TRANSACTION_READ_AUTHORITY
      ? readBindingSnapshotDuringTransaction(root, filesystemAuthority, TRANSACTION_READ_AUTHORITY, pinned)
      : readBindingSnapshot(root, filesystemAuthority);
    return result.ok
      ? { snapshot: result.value, diagnostics: result.diagnostics }
      : { snapshot: null, diagnostics: result.diagnostics };
  } catch {
    return {
      snapshot: null,
      diagnostics: [diag(
        "BINDING_REQUIRED",
        "binding.read",
        "Read or explicitly establish the root-local v2 binding before applying management changes.",
        { canonical_root: root, binding_path: bindingPath(root) },
      )],
    };
  }
}
function missingPolicy(read: ReadPolicy): boolean {
  return read.snapshot === null
    && read.diagnostics.length > 0
    && read.diagnostics.every((entry) => entry.code === "CONFIG_MISSING");
}

function readPolicyDuringTransaction(
  root: CanonicalRoot,
  filesystemAuthority: ManagementFsAuthority,
  pinned: PinnedFsRoot,
): PolicyReadResult {
  return readPolicySnapshotDuringTransaction(root, filesystemAuthority, TRANSACTION_READ_AUTHORITY, pinned);
}

function readBindingDuringTransaction(
  root: CanonicalRoot,
  filesystemAuthority: ManagementFsAuthority,
  pinned: PinnedFsRoot,
): BindingReadResult {
  return readBindingSnapshotDuringTransaction(root, filesystemAuthority, TRANSACTION_READ_AUTHORITY, pinned);
}

function writePolicyDuringTransaction(
  input: Parameters<typeof writePolicyDocumentDuringTransaction>[0],
  filesystemAuthority: ManagementFsAuthority,
  pinned: PinnedFsRoot,
): PolicyWriteResult {
  return writePolicyDocumentDuringTransaction(input, filesystemAuthority, TRANSACTION_READ_AUTHORITY, pinned);
}

function writeBindingDuringTransaction(
  input: Parameters<typeof writeBindingAfterConfirmationDuringTransaction>[0],
  filesystemAuthority: ManagementFsAuthority,
  pinned: PinnedFsRoot,
): BindingWriteResult {
  return writeBindingAfterConfirmationDuringTransaction(input, filesystemAuthority, TRANSACTION_READ_AUTHORITY, pinned);
}

function readContext(
  root: CanonicalRoot,
  manager: TrustedManagementContext,
  operation: DiagnosticOperation = "management.apply",
  providedPinned?: PinnedFsRoot,
): ManagementReadContext {
  const authority = managerAuthority(manager);
  if (!authority) {
    const diagnostics = [diag(
      "ACTIVATION_FAILED",
      operation,
      "Provide a factory-issued trusted descriptor-relative filesystem authority before reading workflow-v2 state.",
      {
        canonical_root: root,
        reason: manager.filesystem_authority === undefined ? "missing" : "foreign",
      },
    )];
    return Object.freeze({
      policy: { snapshot: null, diagnostics },
      binding: { snapshot: null, diagnostics },
      rootEvidence: successResult(manager.root),
      manager,
    });
  }
  let pinned = providedPinned;
  let ownsPinned = false;
  let rootOnly: FsRootDirectory | undefined;
  if (!pinned) {
    const opened = authority.openRoot(root, { createOmp: false });
    if (opened.ok) {
      pinned = opened.value;
      ownsPinned = true;
    } else if (opened.reason === "omp_missing" && authority.openRootDirectory) {
      const openedRoot = authority.openRootDirectory(root);
      if (openedRoot.ok) rootOnly = openedRoot.value;
    }
  }
  const status = pinned
    ? readTransactionStatusFromPinned(root, pinned, authority)
    : rootOnly
      ? readTransactionStatusFromRoot(root, rootOnly, authority)
      : readTransactionStatus(root, authority);
  const blockedDiagnostics = status.status === "clear"
    ? []
    : status.status === "incomplete"
      ? [diag(
        "TRANSACTION_INCOMPLETE",
        operation,
        "An incomplete policy transaction is present; recover it through an explicit trusted transaction boundary before reading workflow-v2 state.",
        { canonical_root: root, journal_path: transactionJournalPath(root), phase: status.journal.phase },
      )]
      : [diag(
        "TRANSACTION_INCOMPLETE",
        operation,
        "The transaction marker is malformed, unsafe, or foreign; preserve it and recover it explicitly before reading workflow-v2 state.",
        { canonical_root: root, journal_path: status.path, status: status.reason },
      )];
  const context = Object.freeze({
    policy: blockedDiagnostics.length > 0
      ? { snapshot: null, diagnostics: blockedDiagnostics }
      : readPolicy(root, authority, undefined, pinned),
    binding: blockedDiagnostics.length > 0
      ? { snapshot: null, diagnostics: blockedDiagnostics }
      : readBinding(root, authority, undefined, pinned),
    rootEvidence: successResult(manager.root),
    manager,
  });
  if (ownsPinned && pinned) {
    try { pinned.close(); } catch { /* snapshots are already immutable */ }
  }
  if (rootOnly) {
    try { rootOnly.close(); } catch { /* snapshots are already immutable */ }
  }
  return context;
}
function providerRef(provider: ProviderRecord): PolicyProviderRef {
  return Object.freeze({
    id: provider.provider_id,
    protocol_version: 2 as const,
    descriptor_fingerprint: provider.descriptor_fingerprint,
    catalog_content_digest: provider.catalog.content_digest,
  });
}

function emptyCommands(): WorkflowPolicy["commands"] {
  return Object.freeze({
    "do-work": Object.freeze({ fragments: Object.freeze([]) }),
    team: Object.freeze({ alias_of: "do-work" as const }),
    cto: Object.freeze({ fragments: Object.freeze([]) }),
  });
}

function providerInventory(provider: ProviderRecord): readonly AgentRef[] {
  return buildProviderAgentInventory(provider.descriptor);
}

function defaultPolicy(provider: ProviderRecord): PolicyDocument {
  const defaults = provider.descriptor.defaults;
  const workflow = defaults.workflow?.selection === "fixed"
    ? Object.freeze({
      selection: "fixed" as const,
      profile_identity: Object.freeze({
        id: defaults.workflow.profile_identity.id,
        fingerprint: defaults.workflow.profile_identity.fingerprint,
      }),
    })
    : Object.freeze({ selection: "matrix" as const });
  const policy = Object.freeze({
    roles: Object.freeze({}),
    scope_map: Object.freeze([]),
    roster_overrides: Object.freeze([]),
    flags: Object.freeze({}),
    runtime_classes: Object.freeze({}),
    ui_classes: Object.freeze({}),
    design_system: defaults.design_system ?? null,
    commands: emptyCommands(),
    workflow,
    prompt_context: Object.freeze({}),
    required_capabilities: Object.freeze([]),
  });
  return Object.freeze({ schema_version: 2 as const, provider: providerRef(provider), policy });
}

function digestManagement(value: unknown): WorkflowV2Digest {
  return `sha256:${createHash("sha256").update(canonicalPolicyJson(value), "utf8").digest("hex")}`;
}
function policyValue(value: unknown): value is PolicyFieldValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(policyValue);
  return record(value) && Object.values(value).every(policyValue);
}

function fieldsEqual(left: unknown, right: unknown): boolean {
  try {
    return canonicalPolicyJson(left) === canonicalPolicyJson(right);
  } catch {
    return false;
  }
}

function compareKeys(left: string, right: string): number {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const leftCode = left.charCodeAt(index);
    const rightCode = right.charCodeAt(index);
    if (leftCode !== rightCode) return leftCode - rightCode;
  }
  return left.length - right.length;
}

function fieldOperations(before: unknown, after: unknown, path = ""): readonly FieldOperation[] {
  if (fieldsEqual(before, after)) return Object.freeze([]);
  if (record(before) && record(after)) {
    const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort(compareKeys);
    const operations: FieldOperation[] = [];
    for (const key of keys) {
      const child = `${path}/${key}`;
      const hasBefore = Object.prototype.hasOwnProperty.call(before, key);
      const hasAfter = Object.prototype.hasOwnProperty.call(after, key);
      const oldValue = before[key];
      const newValue = after[key];
      if (!hasBefore && policyValue(newValue)) {
        operations.push(Object.freeze({ operation: "add", path: child, after: newValue }));
      } else if (!hasAfter && policyValue(oldValue)) {
        operations.push(Object.freeze({ operation: "remove", path: child, before: oldValue }));
      } else if (hasBefore && hasAfter) {
        operations.push(...fieldOperations(oldValue, newValue, child));
      }
    }
    return Object.freeze(operations);
  }
  if (policyValue(before) && policyValue(after)) {
    return Object.freeze([{ operation: "replace", path: path || "/", before, after }]);
  }
  return Object.freeze([]);
}

function proposalUnsigned(candidate: InternalProposal): RecordValue {
  const unsigned: RecordValue = {
    operation: candidate.operation,
    provider: candidate.provider,
    next_policy: candidate.next_policy,
    field_operations: candidate.field_operations,
    expected: candidate.expected,
  };
  if (candidate.legacy_input !== undefined) unsigned.legacy_input = candidate.legacy_input;
  return unsigned;
}

function proposalDigest(candidate: RecordValue): WorkflowV2Digest {
  return digestManagement(candidate);
}


function projectIdentityFromBinding(binding: BindingSnapshot): ProjectIdentity {
  const validated = binding.document.last_validated;
  return Object.freeze({
    root_instance_id: binding.document.project_worktree_instance,
    provider_id: validated.provider_id,
    descriptor_fingerprint: validated.descriptor_fingerprint,
    executable_provenance: Object.freeze({ ...validated.executable_provenance }),
    catalog_content_digest: validated.catalog_content_digest,
    config_byte_sha256: validated.config_byte_sha256,
    config_semantic_sha256: validated.config_semantic_sha256,
    session: Object.freeze({ ...validated.session }),
  });
}

function proposalPrecondition(
  root: CanonicalRoot,
  manager: TrustedManagementContext,
  current: PolicySnapshot | null,
  binding: BindingSnapshot | null,
  operation: DiagnosticOperation,
  parentIdentity?: PathIdentity,
): DiagnosticResult<PolicyPrecondition> {
  const path = policyPath(root);
  const authority = managerAuthority(manager);
  if (!authority) {
    return failed(
      "ACTIVATION_FAILED",
      operation,
      "Provide a factory-issued trusted descriptor-relative filesystem authority before proposing a management change.",
      { canonical_root: root, reason: manager.filesystem_authority === undefined ? "missing" : "foreign" },
    );
  }
  const identities = proposalPathIdentities(root, current, operation, authority);
  if (!identities.ok) return identities;
  if (current === null) {
    return successResult(Object.freeze({
      state: "absent" as const,
      canonical_root: root,
      worktree_id: manager.worktree_id,
      session_id: manager.session.session_id,
      policy_path: path,
      parent_path_identity: parentIdentity ?? identities.value.parent,
      expected_exclusive_create: true as const,
    }));
  }
  if (binding === null) {
    return failed(
      "BINDING_REQUIRED",
      operation,
      "An existing policy proposal requires a complete root-local binding.",
      { canonical_root: root, binding_path: bindingPath(root) },
    );
  }
  const project = projectIdentityFromBinding(binding);
  if (project.root_instance_id !== manager.worktree_id) {
    return failed(
      "IDENTITY_MISMATCH",
      operation,
      "The trusted worktree identity differs from the existing root binding.",
      {
        canonical_root: root,
        expected_digest: manager.worktree_id,
        actual_digest: project.root_instance_id,
      },
    );
  }
  if (identities.value.policy === undefined) {
    return failed(
      "IDENTITY_MISMATCH",
      operation,
      "The descriptor-relative policy fingerprint is unavailable; reread the project before proposing a change.",
      { canonical_root: root, policy_path: path },
    );
  }
  return successResult(Object.freeze({
    state: "present" as const,
    project_identity: project,
    policy_path: path,
    policy_file_identity: identities.value.policy,
    raw_hash: current.byte_sha256,
    semantic_hash: current.semantic_sha256,
  }));
}

function makeProposal(
  operation: Exclude<ManagementProposal["operation"], "apply">,
  root: CanonicalRoot,
  manager: TrustedManagementContext,
  provider: ProviderRecord,
  nextPolicy: PolicyDocument,
  current: PolicySnapshot | null,
  binding: BindingSnapshot | null,
  legacyInput?: LegacyExpectation,
  parentIdentity?: PathIdentity,
): DiagnosticResult<InternalProposal> {
  const expected = proposalPrecondition(
    root,
    manager,
    current,
    binding,
    `management.${operation}` as DiagnosticOperation,
    parentIdentity,
  );
  if (!expected.ok) return expected;
  const providerReference = providerRef(provider);
  const operations = fieldOperations(current?.document ?? null, nextPolicy);
  const unsigned = {
    operation,
    provider: providerReference,
    next_policy: nextPolicy,
    field_operations: operations,
    expected: expected.value,
    ...(legacyInput === undefined ? {} : { legacy_input: legacyInput }),
  };
  const proposal: InternalProposal = Object.freeze({
    ...unsigned,
    proposal_digest: proposalDigest(unsigned),
  });
  return successResult(proposal);
}

function providerFor(providerId: unknown, registry: ProviderRegistry): DiagnosticResult<ProviderRecord> {
  if (!isProviderId(providerId)) {
    return failed(
      "PROVIDER_UNAVAILABLE",
      "provider.lookup",
      "Use the exact lowercase package-qualified provider id.",
      { provider_id: typeof providerId === "string" ? providerId : null },
    );
  }
  const result = lookupProvider(registry, providerId);
  return result.ok ? result : failureResult(result.diagnostics);
}

function capabilities(
  provider: ProviderRecord,
  required: readonly string[],
  operation: DiagnosticOperation,
): DiagnosticResult<true> {
  const check = validateProviderCapabilities(provider, [...new Set(["workflow_execution", ...required])]);
  if (!check.ok) {
    return failureResult(check.diagnostics.map((entry) => createDiagnostic({
      code: entry.code,
      operation,
      severity: "error",
      evidence: entry.evidence,
      remediation: entry.remediation,
    })));
  }
  return successResult(true, check.diagnostics);
}

function rootInstance(
  root: CanonicalRoot,
  binding: BindingSnapshot | null,
  manager: TrustedManagementContext,
): DiagnosticResult<WorkflowV2Digest> {
  if (manager.root.canonical_root !== root) {
    return failed(
      "IDENTITY_MISMATCH",
      "root.resolve",
      "The trusted management context belongs to a different canonical root.",
      { canonical_root: root },
    );
  }
  const identity = manager.worktree_id;
  if (binding && binding.document.project_worktree_instance !== identity) {
    return failed(
      "IDENTITY_MISMATCH",
      "binding.read",
      "The binding root-instance digest does not match the trusted management context.",
      {
        canonical_root: root,
        expected_digest: identity,
        actual_digest: binding.document.project_worktree_instance,
      },
    );
  }
  return successResult(identity);
}

function bindingStatus(
  root: CanonicalRoot,
  policy: PolicySnapshot | null,
  binding: BindingSnapshot | null,
  provider: ProviderRecord | null,
  operation: DiagnosticOperation,
): readonly V2Diagnostic[] {
  if (!binding) {
    return [diag(
      "BINDING_REQUIRED",
      operation,
      "Create or explicitly apply a root-local v2 binding before activation.",
      { canonical_root: root, binding_path: bindingPath(root) },
    )];
  }
  const result: V2Diagnostic[] = [];
  const current = binding.document.last_validated;
  if (provider && current.provider_id !== provider.provider_id) {
    result.push(diag(
      "IDENTITY_MISMATCH",
      operation,
      "The root binding provider identity is stale; apply an explicit provider-bound proposal.",
      {
        canonical_root: root,
        provider_id: provider.provider_id,
        expected_digest: provider.descriptor_fingerprint,
        actual_digest: current.descriptor_fingerprint,
      },
    ));
  }
  if (provider && current.descriptor_fingerprint !== provider.descriptor_fingerprint) {
    result.push(diag(
      "IDENTITY_MISMATCH",
      operation,
      "The root binding descriptor identity is stale; apply an explicit provider-bound proposal.",
      {
        canonical_root: root,
        provider_id: provider.provider_id,
        expected_digest: provider.descriptor_fingerprint,
        actual_digest: current.descriptor_fingerprint,
      },
    ));
  }
  if (provider && current.catalog_content_digest !== provider.catalog.content_digest) {
    result.push(diag(
      "IDENTITY_MISMATCH",
      operation,
      "The root binding catalog identity is stale; apply an explicit provider-bound proposal.",
      {
        canonical_root: root,
        provider_id: provider.provider_id,
        expected_digest: provider.catalog.content_digest,
        actual_digest: current.catalog_content_digest,
      },
    ));
  }
  if (policy) {
    const checks: readonly [string, WorkflowV2Digest, WorkflowV2Digest][] = [
      ["config_byte_sha256", current.config_byte_sha256, policy.byte_sha256],
      ["config_semantic_sha256", current.config_semantic_sha256, policy.semantic_sha256],
    ];
    for (const [field, actual, expected] of checks) {
      if (actual !== expected) {
        result.push(diag(
          "IDENTITY_MISMATCH",
          operation,
          "The root binding does not describe the current policy bytes; apply an explicit root-bound proposal.",
          { canonical_root: root, field, expected_digest: expected, actual_digest: actual },
        ));
      }
    }
  }
  return Object.freeze(result);
}

function providerObservations(registry: ProviderRegistry): ProviderObservations {
  const providers = listProviders(registry);
  const quarantined = listProviderQuarantine(registry);
  const diagnostics: V2Diagnostic[] = [];
  if (providers.length === 0) {
    diagnostics.push(diag(
      "PROVIDER_UNAVAILABLE",
      "management.list",
      "Publish one immutable provider descriptor/catalog before selecting a provider.",
      { status: "available", count: 0 },
      "info",
    ));
  }
  if (quarantined.length > 0) {
    diagnostics.push(diag(
      "PROVIDER_QUARANTINED",
      "management.list",
      "Resolve the conflicting provider publication and restart the lifecycle; no publisher wins.",
      {
        candidate_id: quarantined.map((entry) => entry.provider_id),
        count: quarantined.length,
        status: "quarantined",
      },
      "warning",
    ));
  }
  return {
    providers,
    quarantined,
    diagnostics,
  };
}
function contextEvidence(root: CanonicalRoot, context: ManagementReadContext): RecordValue {
  const evidence: RecordValue = {
    canonical_root: root,
    path: policyPath(root),
    binding_path: bindingPath(root),
    config_byte_sha256: context.policy.snapshot?.byte_sha256 ?? null,
    config_semantic_sha256: context.policy.snapshot?.semantic_sha256 ?? null,
    binding_byte_sha256: context.binding.snapshot?.byte_sha256 ?? null,
  };
  if (context.rootEvidence.ok) {
    const rootEvidence = context.rootEvidence.value;
    evidence.root_device = rootEvidence.root_device;
    evidence.root_inode = rootEvidence.root_inode;
    evidence.git_device = rootEvidence.git_device;
    evidence.git_inode = rootEvidence.git_inode;
    evidence.root_instance_nonce = rootEvidence.root_instance_nonce;
    evidence.root_instance_id = context.manager.worktree_id;
  }
  if (context.policy.snapshot) evidence.provider_id = context.policy.snapshot.document.provider.id;
  return evidence;
}

function augmentDiagnostics(
  diagnostics: readonly V2Diagnostic[],
  evidence: RecordValue,
): readonly V2Diagnostic[] {
  return Object.freeze(diagnostics.map((entry) => createDiagnostic({
    code: entry.code,
    operation: entry.operation,
    severity: entry.severity,
    evidence: { ...entry.evidence, ...evidence },
    remediation: entry.remediation,
  })));
}

function dedupeDiagnostics(diagnostics: readonly V2Diagnostic[]): readonly V2Diagnostic[] {
  const seen = new Set<string>();
  const result: V2Diagnostic[] = [];
  for (const entry of diagnostics) {
    const key = `${entry.code}|${entry.operation}|${canonicalPolicyJson(entry.evidence)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(entry);
  }
  return Object.freeze(result);
}
function managementObservations(
  root: CanonicalRoot,
  context: ManagementReadContext,
  listed: ProviderObservations,
  extra: RecordValue = {},
): RecordValue {
  const providers = listed.providers.map((provider) => Object.freeze({
    provider_id: provider.provider_id,
    descriptor_fingerprint: provider.descriptor_fingerprint,
    catalog_content_digest: provider.catalog.content_digest,
    capabilities: Object.freeze([...provider.descriptor.capabilities]),
    agent_count: providerInventory(provider).length,
  }));
  return {
    root_instance_id: context.manager.worktree_id,
    policy_path: policyPath(root),
    binding_path: bindingPath(root),
    root_evidence: context.rootEvidence.ok ? context.rootEvidence.value : null,
    provider_candidates: Object.freeze(providers),
    provider_ids: Object.freeze(listed.providers.map((entry) => entry.provider_id)),
    quarantined_provider_ids: Object.freeze(listed.quarantined.map((entry) => entry.provider_id)),
    policy_provider_id: context.policy.snapshot?.document.provider.id ?? null,
    policy_byte_sha256: context.policy.snapshot?.byte_sha256 ?? null,
    policy_semantic_sha256: context.policy.snapshot?.semantic_sha256 ?? null,
    binding_byte_sha256: context.binding.snapshot?.byte_sha256 ?? null,
    ...extra,
  };
}
function result(
  operation: ManagementOperation,
  diagnostics: readonly V2Diagnostic[],
  proposal?: ManagementProposal,
  applied?: boolean,
  observations: RecordValue = {},
): ManagementResult {
  return Object.freeze({
    operation,
    diagnostics: Object.freeze([...diagnostics]),
    ...(proposal === undefined ? {} : { proposal }),
    ...(applied === undefined ? {} : { applied }),
    ...observations,
  });
}

function proposalDiagnostics(context: ManagementReadContext): readonly V2Diagnostic[] {
  return dedupeDiagnostics([
    ...context.policy.diagnostics.filter((entry) => entry.code !== "CONFIG_MISSING"),
    ...context.binding.diagnostics.filter((entry) => entry.code !== "BINDING_REQUIRED"),
  ]);
}

function listFor(root: CanonicalRoot, manager: TrustedManagementContext, _request: ProviderListRequest, registry: ProviderRegistry): ProviderManagementResult {
  const context = readContext(root, manager, "management.list");
  const listed = providerObservations(registry);
  const diagnostics = dedupeDiagnostics([
    ...context.policy.diagnostics,
    ...context.binding.diagnostics,
    ...(!context.rootEvidence.ok ? context.rootEvidence.diagnostics : []),
    ...listed.diagnostics,
  ]);
  return successResult(
    result(
      "list",
      diagnostics,
      undefined,
      undefined,
      managementObservations(root, context, listed),
    ),
    diagnostics,
  );
}

function statusFor(root: CanonicalRoot, manager: TrustedManagementContext, _request: ProviderStatusRequest, registry: ProviderRegistry): ProviderManagementResult {
  const context = readContext(root, manager, "management.status");
  const listed = providerObservations(registry);
  const diagnostics: V2Diagnostic[] = [
    ...context.policy.diagnostics,
    ...context.binding.diagnostics,
    ...(!context.rootEvidence.ok ? context.rootEvidence.diagnostics : []),
    ...listed.diagnostics.map((entry) => createDiagnostic({ ...entry, operation: "management.status" })),
  ];
  let provider: ProviderRecord | null = null;
  let providerStatus: "unconfigured" | "available" | "unavailable" | "quarantined" = "unconfigured";
  if (context.policy.snapshot) {
    const lookup = providerFor(context.policy.snapshot.document.provider.id, registry);
    if (lookup.ok) {
      provider = lookup.value;
      providerStatus = "available";
      diagnostics.push(...lookup.diagnostics);
      if (
        provider.descriptor_fingerprint !== context.policy.snapshot.document.provider.descriptor_fingerprint
        || provider.catalog.content_digest !== context.policy.snapshot.document.provider.catalog_content_digest
      ) {
        diagnostics.push(diag(
          "IDENTITY_MISMATCH",
          "management.status",
          "Refresh the provider descriptor/catalog explicitly; status never reseals policy.",
          {
            canonical_root: root,
            provider_id: provider.provider_id,
            expected_digest: provider.descriptor_fingerprint,
            actual_digest: context.policy.snapshot.document.provider.descriptor_fingerprint,
          },
          "warning",
        ));
      }
      diagnostics.push(...bindingStatus(root, context.policy.snapshot, context.binding.snapshot, provider, "management.status"));
    } else {
      providerStatus = lookup.diagnostics.some((entry) => entry.code === "PROVIDER_QUARANTINED")
        ? "quarantined"
        : "unavailable";
      diagnostics.push(...lookup.diagnostics);
      if (context.binding.snapshot) diagnostics.push(...bindingStatus(root, context.policy.snapshot, context.binding.snapshot, null, "management.status"));
    }
  } else if (context.binding.snapshot) {
    diagnostics.push(...bindingStatus(root, null, context.binding.snapshot, null, "management.status"));
  }
  const allDiagnostics = dedupeDiagnostics(diagnostics);
  return successResult(
    result(
      "status",
      allDiagnostics,
      undefined,
      undefined,
      managementObservations(root, context, listed, {
        provider_status: providerStatus,
        selected_descriptor_fingerprint: provider?.descriptor_fingerprint ?? null,
        selected_catalog_content_digest: provider?.catalog.content_digest ?? null,
      }),
    ),
    allDiagnostics,
  );
}

function validateProfile(
  provider: ProviderRecord,
  document: Readonly<PolicyDocument>,
  operation: DiagnosticOperation,
): DiagnosticResult<true> {
  if (document.policy.workflow.selection === "matrix") return successResult(true);
  const profile = document.policy.workflow.profile_identity;
  const match = provider.catalog.profiles.find((candidate) => (
    candidate.identity.id === profile.id && candidate.identity.fingerprint === profile.fingerprint
  ));
  if (!match) {
    return failed(
      "PROFILE_UNAVAILABLE",
      operation,
      "The fixed workflow profile is not available in the immutable provider catalog.",
      {
        provider_id: provider.provider_id,
        profile_identity: profile,
        expected_digest: profile.fingerprint,
      },
    );
  }
  return successResult(true);
}

function validatePolicyIdentity(
  provider: ProviderRecord,
  document: Readonly<PolicyDocument>,
  operation: DiagnosticOperation,
): DiagnosticResult<EffectivePolicy> {
  const merged = mergePolicy(provider.descriptor, document);
  if (!merged.ok) return failureResult(remapDiagnostics(merged.diagnostics, operation));
  if (document.provider.descriptor_fingerprint !== provider.descriptor_fingerprint) {
    return failed(
      "IDENTITY_MISMATCH",
      operation,
      "Use the exact immutable provider descriptor fingerprint published for the selected provider.",
      {
        provider_id: provider.provider_id,
        expected_digest: provider.descriptor_fingerprint,
        actual_digest: document.provider.descriptor_fingerprint,
      },
    );
  }
  const profile = validateProfile(provider, document, operation);
  if (!profile.ok) return profile;
  const references: AgentRef[] = [
    ...Object.values(merged.value.roles),
    ...merged.value.scope_map.map((rule: ScopeRule) => rule.dev_agent),
  ];
  const inventory = validateProviderAgentInventory(provider.descriptor, references);
  if (!inventory.ok) return failureResult(remapDiagnostics(inventory.diagnostics, operation));
  const capability = capabilities(provider, merged.value.required_capabilities, operation);
  if (!capability.ok) return capability;
  return successResult(merged.value, [...merged.diagnostics, ...capability.diagnostics]);
}

function selectFor(root: CanonicalRoot, manager: TrustedManagementContext, request: ProviderSelectRequest, registry: ProviderRegistry): ProviderManagementResult {
  const operation = "management.select" as const;
  const context = readContext(root, manager);
  const provider = providerFor(request.provider_id, registry);
  if (!provider.ok) return failureResult(augmentDiagnostics(provider.diagnostics, contextEvidence(root, context)));
  const capability = capabilities(provider.value, [], operation);
  if (!capability.ok) return failureResult(capability.diagnostics);
  if (!missingPolicy(context.policy) && !context.policy.snapshot) return failureResult(context.policy.diagnostics);
  if (context.policy.snapshot) {
    const currentProvider = providerFor(context.policy.snapshot.document.provider.id, registry);
    const bindingDiagnostics = bindingStatus(
      root,
      context.policy.snapshot,
      context.binding.snapshot,
      currentProvider.ok ? currentProvider.value : null,
      operation,
    );
    if (bindingDiagnostics.length > 0) return failureResult(bindingDiagnostics);
  }
  const rootCheck = rootInstance(root, context.binding.snapshot, manager);
  if (!rootCheck.ok) return failureResult(rootCheck.diagnostics);
  const next = context.policy.snapshot && context.policy.snapshot.document.provider.id === provider.value.provider_id
    ? Object.freeze({
      schema_version: 2 as const,
      provider: providerRef(provider.value),
      policy: context.policy.snapshot.document.policy,
    })
    : defaultPolicy(provider.value);
  const validation = validatePolicyIdentity(provider.value, next, operation);
  if (!validation.ok) return failureResult(validation.diagnostics);
  const proposalResult = makeProposal(
    "select",
    root,
    manager,
    provider.value,
    next,
    context.policy.snapshot,
    context.binding.snapshot,
  );
  if (!proposalResult.ok) return failureResult(proposalResult.diagnostics);
  const proposal = proposalResult.value;
  const diagnostics = dedupeDiagnostics([
    ...proposalDiagnostics(context),
    ...capability.diagnostics,
  ]);
  return successResult(
    result(
      "select",
      diagnostics,
      proposal,
      false,
      managementObservations(root, context, providerObservations(registry), {
        field_operations: proposal.field_operations,
      }),
    ),
    diagnostics,
  );
}

function createFor(
  root: CanonicalRoot,
  manager: TrustedManagementContext,
  request: ProviderCreateRequest,
  registry: ProviderRegistry,
  lock?: TransactionLock,
): ProviderManagementResult {
  const operation = "management.create" as const;
  const authority = managerAuthority(manager);
  if (!authority) {
    return failed(
      "ACTIVATION_FAILED",
      operation,
      "Provide a factory-issued trusted descriptor-relative filesystem authority before creating policy and binding.",
      { canonical_root: root, reason: manager.filesystem_authority === undefined ? "missing" : "foreign" },
    );
  }
  if (request.confirm_root !== true) {
    return failed(
      "IDENTITY_MISMATCH",
      operation,
      "Confirm the exact manager-owned project root before creating policy and binding.",
      { canonical_root: root, path: policyPath(root), binding_path: bindingPath(root) },
    );
  }
  const context = readContext(root, manager, operation, lock?.pinned);
  if (context.policy.snapshot) {
    return failed(
      "TRANSITION_REQUIRED",
      operation,
      "Create is absent-only and will never replace an existing v2 policy.",
      { canonical_root: root, config_byte_sha256: context.policy.snapshot.byte_sha256 },
    );
  }
  if (!missingPolicy(context.policy)) return failureResult(context.policy.diagnostics);
  const bindingPresence = rootTargetPresent(root, "team.config.binding.json", operation, authority);
  if (!bindingPresence.ok) return failureResult(bindingPresence.diagnostics);
  const bindingPresent = bindingPresence.value;
  if (context.binding.snapshot || bindingPresent) {
    if (context.binding.snapshot) {
      return failed(
        "TRANSITION_REQUIRED",
        operation,
        "Create will not rebind an existing sidecar; restart the lifecycle and obtain an explicit root-bound proposal.",
        {
          canonical_root: root,
          binding_byte_sha256: context.binding.snapshot.byte_sha256,
          provider_id: context.binding.snapshot.document.last_validated.provider_id,
        },
      );
    }
    return failureResult(context.binding.diagnostics.length > 0
      ? context.binding.diagnostics
      : [diag(
        "BINDING_REQUIRED",
        operation,
        "The root already contains a binding target; reread it and obtain an explicit root-bound proposal.",
        { canonical_root: root, binding_path: bindingPath(root) },
      )]);
  }
  const provider = providerFor(request.provider_id, registry);
  if (!provider.ok) return failureResult(augmentDiagnostics(provider.diagnostics, contextEvidence(root, context)));
  const capability = capabilities(provider.value, [], operation);
  if (!capability.ok) return failureResult(capability.diagnostics);
  const rootCheck = rootInstance(root, null, manager);
  if (!rootCheck.ok) return failureResult(rootCheck.diagnostics);
  const next = defaultPolicy(provider.value);
  const validation = validatePolicyIdentity(provider.value, next, operation);
  if (!validation.ok) return failureResult(validation.diagnostics);
  const proposalResult = makeProposal("create", root, manager, provider.value, next, null, null, undefined, lock?.parent_identity);
  if (!proposalResult.ok) return failureResult(proposalResult.diagnostics);
  const proposal = proposalResult.value;
  const diagnostics = dedupeDiagnostics([
    ...proposalDiagnostics(context),
    ...capability.diagnostics,
  ]);
  if (request.dry_run === true) {
    return successResult(
      result(
        "create",
        diagnostics,
        proposal,
        false,
        managementObservations(root, context, providerObservations(registry), {
          field_operations: proposal.field_operations,
        }),
      ),
      diagnostics,
    );
  }
  if (!lock) {
    return failed(
      "ACTIVATION_FAILED",
      operation,
      "Acquire a trusted transaction lock before applying a create proposal.",
      { canonical_root: root },
    );
  }
  return applyProposal(root, manager, {
    operation: "apply",
    proposal,
    proposal_digest: proposal.proposal_digest,
    confirm_root: true,
    expected: proposal.expected,
  }, registry, lock);
}

function refreshFor(root: CanonicalRoot, manager: TrustedManagementContext, request: ProviderRefreshRequest, registry: ProviderRegistry): ProviderManagementResult {
  const operation = "management.refresh" as const;
  const context = readContext(root, manager);
  if (!context.policy.snapshot) return failureResult(context.policy.diagnostics);
  const selected = request.provider_id ?? context.policy.snapshot.document.provider.id;
  if (selected !== context.policy.snapshot.document.provider.id) {
    return failed(
      "TRANSITION_REQUIRED",
      operation,
      "Refresh cannot switch providers; issue a selection proposal and apply it in a fresh lifecycle.",
      { canonical_root: root, provider_id: selected },
    );
  }
  const provider = providerFor(selected, registry);
  if (!provider.ok) return failureResult(augmentDiagnostics(provider.diagnostics, contextEvidence(root, context)));
  const capability = capabilities(provider.value, context.policy.snapshot.document.policy.required_capabilities, operation);
  if (!capability.ok) return failureResult(capability.diagnostics);
  const bindingDiagnostics = bindingStatus(
    root,
    context.policy.snapshot,
    context.binding.snapshot,
    provider.value,
    operation,
  );
  if (bindingDiagnostics.length > 0) return failureResult(bindingDiagnostics);
  const rootCheck = rootInstance(root, context.binding.snapshot, manager);
  if (!rootCheck.ok) return failureResult(rootCheck.diagnostics);
  const next = Object.freeze({
    schema_version: 2 as const,
    provider: providerRef(provider.value),
    policy: context.policy.snapshot.document.policy,
  });
  const validation = validatePolicyIdentity(provider.value, next, operation);
  if (!validation.ok) return failureResult(validation.diagnostics);
  const proposalResult = makeProposal(
    "refresh",
    root,
    manager,
    provider.value,
    next,
    context.policy.snapshot,
    context.binding.snapshot,
  );
  if (!proposalResult.ok) return failureResult(proposalResult.diagnostics);
  const proposal = proposalResult.value;
  const diagnostics = dedupeDiagnostics([
    ...proposalDiagnostics(context),
    ...capability.diagnostics,
  ]);
  return successResult(
    result(
      "refresh",
      diagnostics,
      proposal,
      false,
      managementObservations(root, context, providerObservations(registry), {
        field_operations: proposal.field_operations,
      }),
    ),
    diagnostics,
  );
}

function byteDigest(bytes: Uint8Array): WorkflowV2Digest {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function readLegacyCandidate(
  authority: ManagementFsAuthority,
  directory: FsDirectoryHandle,
  leaf: string,
  path: string,
  root: CanonicalRoot,
): DiagnosticResult<LegacyCandidate> | null {
  const inspected = authority.inspect(directory, leaf);
  if (!inspected.ok) {
    return authorityFailure(inspected, "management.migrate", "Inspect the explicit legacy policy through the trusted descriptor-relative authority.", {
      canonical_root: root,
      path,
    });
  }
  if (inspected.value === null) return null;
  if (inspected.value.kind !== "file") {
    return failed("UNSAFE_PATH", "management.migrate", "Use a regular legacy policy file beneath the trusted root.", {
      canonical_root: root,
      path,
    });
  }
  const read = authority.readBounded(directory, leaf, TRANSACTION_MAX_BYTES);
  if (!read.ok) {
    return authorityFailure(read, "management.migrate", "Read the explicit legacy policy through the trusted descriptor-relative authority.", {
      canonical_root: root,
      path,
    });
  }
  if (read.value === null) return null;
  const bytes = read.value.bytes;
  const fingerprint = authorityFingerprint(read.value.fingerprint);
  if (
    !fingerprint
    || fingerprint.state !== "present"
    || fingerprint.byte_length !== bytes.byteLength
    || fingerprint.byte_sha256 !== byteDigest(bytes)
  ) {
    return failed("IDENTITY_MISMATCH", "management.migrate", "The descriptor-relative migration source fingerprint does not match its exact bytes; preserve the source.", { path });
  }
  try {
    const parsed = parseStrictJsonValue(bytes);
    if (!record(parsed)) {
      return failed("CONFIG_MALFORMED", "management.migrate", "The explicit legacy policy must contain one JSON object.", { path });
    }
    if (parsed.schema_version === 2) {
      return failed("MIGRATION_REQUIRED", "management.migrate", "Migration accepts v1 input only and never replaces an existing v2 policy.", { path });
    }
    if (parsed.schema_version !== undefined && parsed.schema_version !== 1) {
      return failed("MIGRATION_REQUIRED", "management.migrate", "Provide an explicit v1 .omp or .claude policy input; other schemas are not migration sources.", { path });
    }
    return successResult(Object.freeze({
      path,
      bytes,
      byte_sha256: fingerprint.byte_sha256,
      fingerprint,
      value: parsed,
    }));
  } catch {
    return failed("CONFIG_MALFORMED", "management.migrate", "Read the explicit legacy policy as strict UTF-8 JSON before migration.", { path });
  }
}

function readLegacy(
  root: CanonicalRoot,
  authority: ManagementFsAuthority,
  providedPinned?: PinnedFsRoot,
): DiagnosticResult<LegacyCandidate> {
  let pinned = providedPinned;
  let ownsPinned = false;
  let rootOnly: FsRootDirectory | undefined;
  if (!pinned) {
    const opened = authority.openRoot(root, { createOmp: false });
    if (opened.ok) {
      pinned = opened.value;
      ownsPinned = true;
    } else if (opened.reason === "omp_missing" && authority.openRootDirectory) {
      const openedRoot = authority.openRootDirectory(root);
      if (!openedRoot.ok) {
        return authorityFailure(openedRoot, "management.migrate", "Open the canonical root through the trusted descriptor before reading migration input.", {
          canonical_root: root,
        });
      }
      rootOnly = openedRoot.value;
    } else {
      return authorityFailure(opened, "management.migrate", "Open the canonical root through the trusted descriptor before reading migration input.", {
        canonical_root: root,
      });
    }
  }
  const rootDirectory = pinned?.rootDirectory ?? rootOnly?.rootDirectory;
  if (!rootDirectory) {
    if (ownsPinned && pinned) {
      try { pinned.close(); } catch { /* preserve the typed migration result */ }
    }
    if (rootOnly) {
      try { rootOnly.close(); } catch { /* preserve the typed migration result */ }
    }
    return failed("ACTIVATION_FAILED", "management.migrate", "The canonical root descriptor could not be retained for migration.", {
      canonical_root: root,
    });
  }
  try {
    if (pinned) {
      const omp = readLegacyCandidate(authority, pinned.ompDirectory, "team.config.json", policyPath(root), root);
      if (omp !== null) return omp;
    }
    const legacyDirectory = authority.inspect(rootDirectory, ".claude");
    if (!legacyDirectory.ok) {
      return authorityFailure(legacyDirectory, "management.migrate", "Inspect the explicit .claude migration directory through the trusted descriptor.", {
        canonical_root: root,
        path: legacyPath(root),
      });
    }
    if (legacyDirectory.value !== null && legacyDirectory.value.kind !== "directory") {
      return failed("UNSAFE_PATH", "management.migrate", "The explicit .claude migration directory must be a regular directory.", {
        canonical_root: root,
        path: legacyPath(root),
      });
    }
    if (legacyDirectory.value !== null) {
      const legacyOpened = authority.openDirectory(rootDirectory, ".claude");
      if (!legacyOpened.ok) {
        return authorityFailure(legacyOpened, "management.migrate", "Open the explicit .claude migration directory through the trusted descriptor.", {
          canonical_root: root,
          path: legacyPath(root),
        });
      }
      try {
        const claude = readLegacyCandidate(authority, legacyOpened.value, "team.config.json", legacyPath(root), root);
        if (claude !== null) return claude;
      } finally {
        try { closeSync(legacyOpened.value.fd); } catch { /* preserve the typed migration result */ }
      }
    }
    return failed("MIGRATION_REQUIRED", "management.migrate", "Provide one explicit v1 .omp or .claude policy input before migration.", {
      canonical_root: root,
      path: policyPath(root),
    });
  } finally {
    if (ownsPinned && pinned) {
      try { pinned.close(); } catch { /* preserve the typed migration result */ }
    }
    if (rootOnly) {
      try { rootOnly.close(); } catch { /* preserve the typed migration result */ }
    }
  }
}

function pushMigrationDiagnostic(
  diagnostics: V2Diagnostic[],
  field: string,
  remediation: string,
): void {
  diagnostics.push(diag("MIGRATION_REQUIRED", "management.migrate", remediation, { field }));
}

function safeLegacyKey(value: string): boolean {
  return value.length > 0 && value.length <= 256 && SAFE_IDENTIFIER.test(value);
}

function legacyAgent(
  value: unknown,
  provider: ProviderRecord,
  field: string,
  diagnostics: V2Diagnostic[],
): AgentRef | null {
  if (value === null || value === undefined) return null;
  const inventory = providerInventory(provider);
  if (typeof value === "string") {
    const found = inventory.find((entry) => entry.registered_name === value);
    if (found) return found;
    pushMigrationDiagnostic(
      diagnostics,
      field,
      "Legacy agent names must exactly match one provider-qualified immutable identity; inference is forbidden.",
    );
    return null;
  }
  if (
    record(value)
    && typeof value.registered_name === "string"
    && isProviderId(value.provider_id)
    && isWorkflowV2Digest(value.source_fingerprint)
  ) {
    const found = inventory.find((entry) => (
      entry.registered_name === value.registered_name
      && entry.provider_id === value.provider_id
      && entry.source_fingerprint === value.source_fingerprint
    ));
    if (found) return found;
  }
  pushMigrationDiagnostic(
    diagnostics,
    field,
    "Retain only provider-qualified agent references with immutable source fingerprints.",
  );
  return null;
}

function legacyScopes(
  value: unknown,
  provider: ProviderRecord,
  diagnostics: V2Diagnostic[],
): readonly ScopePatch[] {
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value)) {
    pushMigrationDiagnostic(diagnostics, "scope_map", "Retain the legacy ordered scope map as an array of complete routing entries.");
    return Object.freeze([]);
  }
  const patches: ScopePatch[] = [];
  value.forEach((entry, index) => {
    if (!record(entry)) {
      pushMigrationDiagnostic(diagnostics, `scope_map[${index}]`, "Retain complete legacy scope values; missing routing data cannot be inferred.");
      return;
    }
    const patterns = typeof entry.glob === "string"
      ? [entry.glob]
      : Array.isArray(entry.glob) && entry.glob.every((item) => typeof item === "string")
        ? entry.glob
        : Array.isArray(entry.patterns) && entry.patterns.every((item) => typeof item === "string")
          ? entry.patterns
          : [];
    const scope = typeof entry.scope === "string" ? entry.scope : "";
    const agent = legacyAgent(entry.dev_agent, provider, `scope_map[${index}].dev_agent`, diagnostics);
    const id = typeof entry.id === "string" ? entry.id : `scope-${index + 1}`;
    if (!safeLegacyKey(id) || patterns.length === 0 || !scope || agent === null) {
      pushMigrationDiagnostic(diagnostics, `scope_map[${index}]`, "Retain complete legacy scope values; missing routing data cannot be inferred.");
      return;
    }
    const rule: ScopeRule = Object.freeze({
      patterns: Object.freeze([...patterns]),
      scope,
      dev_agent: agent,
      ...(typeof entry.runtime_class === "string" || typeof entry.runtime_class === "boolean" || entry.runtime_class === null
        ? { runtime_class: entry.runtime_class }
        : {}),
      ...(typeof entry.ui_class === "string" || typeof entry.ui_class === "boolean" || entry.ui_class === null
        ? { ui_class: entry.ui_class }
        : {}),
    });
    patches.push(Object.freeze({ op: "add", id, rule }));
  });
  return Object.freeze(patches);
}

function legacyRoster(
  value: unknown,
  diagnostics: V2Diagnostic[],
): WorkflowPolicy["roster_overrides"] {
  if (value === undefined) return Object.freeze([]);
  if (!record(value)) {
    pushMigrationDiagnostic(diagnostics, "roster_overrides", "Retain roster overrides as a bounded object map.");
    return Object.freeze([]);
  }
  const patches: RosterPatch[] = [];
  for (const [id, raw] of Object.entries(value)) {
    if (!safeLegacyKey(id) || !record(raw)) {
      pushMigrationDiagnostic(diagnostics, `roster_overrides.${id}`, "Retain roster overrides as bounded objects.");
      continue;
    }
    const next: {
      replace?: readonly string[];
      add?: readonly string[];
      remove?: readonly string[];
    } = {};
    let valid = true;
    for (const key of ["replace", "add", "remove"] as const) {
      const entries = raw[key];
      if (entries === undefined) continue;
      if (!Array.isArray(entries) || !entries.every((entry) => typeof entry === "string")) {
        valid = false;
        pushMigrationDiagnostic(
          diagnostics,
          `roster_overrides.${id}.${key}`,
          "Roster override values must be arrays of strings.",
        );
      } else if (key === "replace") {
        next.replace = Object.freeze([...entries]);
      } else if (key === "add") {
        next.add = Object.freeze([...entries]);
      } else {
        next.remove = Object.freeze([...entries]);
      }
    }
    if (valid) patches.push(Object.freeze({ op: "add", id, value: Object.freeze(next) }));
  }
  return Object.freeze(patches);
}

function legacyMap<T extends string | boolean | null>(
  value: unknown,
  field: string,
  diagnostics: V2Diagnostic[],
  valid: (entry: unknown) => entry is T,
): Readonly<Record<string, T>> {
  if (value === undefined) return Object.freeze({});
  if (!record(value)) {
    pushMigrationDiagnostic(diagnostics, field, "Retain legacy map values as a bounded object map.");
    return Object.freeze({});
  }
  const output: Record<string, T> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (!safeLegacyKey(key) || !valid(entry)) {
      pushMigrationDiagnostic(diagnostics, `${field}.${key}`, "Retain complete legacy map values without coercion or inference.");
      continue;
    }
    output[key] = entry;
  }
  return Object.freeze(output);
}

function legacyPromptContext(
  value: unknown,
  diagnostics: V2Diagnostic[],
): Readonly<Record<string, PromptContextEntry>> {
  if (value === undefined) return Object.freeze({});
  if (!record(value)) {
    pushMigrationDiagnostic(diagnostics, "prompt_context", "Retain typed prompt context as a bounded object map.");
    return Object.freeze({});
  }
  const output: Record<string, PromptContextEntry> = {};
  for (const [id, raw] of Object.entries(value)) {
    if (!safeLegacyKey(id) || !record(raw) || raw.id !== id) {
      pushMigrationDiagnostic(diagnostics, `prompt_context.${id}`, "Retain complete typed prompt context entries.");
      continue;
    }
    if (raw.type === "number") {
      if (typeof raw.value !== "number" || !Number.isFinite(raw.value)) {
        pushMigrationDiagnostic(diagnostics, `prompt_context.${id}`, "Retain complete typed prompt context entries.");
        continue;
      }
      output[id] = Object.freeze({ id, type: "number", value: raw.value });
      continue;
    }
    if (raw.type === "boolean") {
      if (typeof raw.value !== "boolean") {
        pushMigrationDiagnostic(diagnostics, `prompt_context.${id}`, "Retain complete typed prompt context entries.");
        continue;
      }
      output[id] = Object.freeze({ id, type: "boolean", value: raw.value });
      continue;
    }
    if (raw.type === "text" || raw.type === "enum") {
      if (typeof raw.value !== "string") {
        pushMigrationDiagnostic(diagnostics, `prompt_context.${id}`, "Retain complete typed prompt context entries.");
        continue;
      }
      output[id] = raw.type === "text"
        ? Object.freeze({ id, type: "text", value: raw.value })
        : Object.freeze({ id, type: "enum", value: raw.value });
      continue;
    }
    pushMigrationDiagnostic(diagnostics, `prompt_context.${id}`, "Retain complete typed prompt context entries.");
  }
  return Object.freeze(output);
}

function legacyCommands(
  value: unknown,
  diagnostics: V2Diagnostic[],
): WorkflowPolicy["commands"] {
  if (value === undefined) return emptyCommands();
  if (!record(value)) {
    pushMigrationDiagnostic(diagnostics, "commands", "Retain command policy as bounded append-only fragments.");
    return emptyCommands();
  }
  const ids = new Set<string>();
  const readCommand = (name: "do-work" | "cto"): { readonly fragments: readonly PolicyFragment[] } => {
    const raw = value[name];
    if (raw === undefined) return { fragments: Object.freeze([]) };
    if (!record(raw) || !Array.isArray(raw.fragments)) {
      pushMigrationDiagnostic(diagnostics, `commands.${name}`, "Retain command policy as bounded append-only fragments.");
      return { fragments: Object.freeze([]) };
    }
    const fragments: PolicyFragment[] = [];
    raw.fragments.forEach((fragment, index) => {
      if (!record(fragment) || typeof fragment.id !== "string" || typeof fragment.text !== "string" || !safeLegacyKey(fragment.id) || ids.has(fragment.id)) {
        pushMigrationDiagnostic(diagnostics, `commands.${name}.fragments[${index}]`, "Retain unique bounded command fragments without coercion.");
        return;
      }
      ids.add(fragment.id);
      fragments.push(Object.freeze({
        id: fragment.id,
        text: fragment.text,
        owner: Object.freeze({ kind: "project_policy" as const, source: ".omp/team.config.json" as const }),
      }));
    });
    return { fragments: Object.freeze(fragments) };
  };
  const team = value.team;
  if (team !== undefined && (!record(team) || team.alias_of !== "do-work")) {
    pushMigrationDiagnostic(diagnostics, "commands.team", "The team command may only retain the semantic do-work alias.");
  }
  const doWork = readCommand("do-work");
  const cto = readCommand("cto");
  return Object.freeze({
    "do-work": Object.freeze({ fragments: doWork.fragments }),
    team: Object.freeze({ alias_of: "do-work" as const }),
    cto: Object.freeze({ fragments: cto.fragments }),
  });
}


function legacyWorkflow(value: unknown, diagnostics: V2Diagnostic[]): WorkflowSelection {
  if (value === undefined) return Object.freeze({ selection: "matrix" as const });
  if (!record(value) || (value.selection !== "matrix" && value.selection !== "fixed")) {
    pushMigrationDiagnostic(diagnostics, "workflow", "Retain workflow selection as matrix or fixed without inference.");
    return Object.freeze({ selection: "matrix" as const });
  }
  if (value.selection === "matrix") return Object.freeze({ selection: "matrix" as const });
  if (value.selection !== "fixed") {
    pushMigrationDiagnostic(diagnostics, "workflow", "Retain workflow selection as matrix or fixed without inference.");
    return Object.freeze({ selection: "matrix" as const });
  }
  const profileValue = value.profile;
  if (
    !record(profileValue)
    || typeof profileValue.id !== "string"
    || !safeLegacyKey(profileValue.id)
    || !isWorkflowV2Digest(profileValue.fingerprint)
  ) {
    pushMigrationDiagnostic(diagnostics, "workflow.profile", "A fixed workflow must retain the exact profile id and fingerprint.");
    return Object.freeze({ selection: "matrix" as const });
  }
  return Object.freeze({
    selection: "fixed" as const,
    profile_identity: Object.freeze({ id: profileValue.id, fingerprint: profileValue.fingerprint }),
  });
}

function legacyCapabilities(value: unknown, diagnostics: V2Diagnostic[]): readonly string[] {
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string" && SAFE_CAPABILITY.test(entry))) {
    pushMigrationDiagnostic(diagnostics, "required_capabilities", "Retain additive capability names as a unique bounded array.");
    return Object.freeze([]);
  }
  const unique = [...new Set(value)];
  if (unique.length !== value.length) {
    pushMigrationDiagnostic(diagnostics, "required_capabilities", "Retain additive capability names without duplicates.");
  }
  return Object.freeze(unique);
}

function migrateDocument(provider: ProviderRecord, legacy: RecordValue): DiagnosticResult<PolicyDocument> {
  const diagnostics: V2Diagnostic[] = [];
  const roles: Record<string, AgentRef | null> = {};
  if (legacy.roles !== undefined && !record(legacy.roles)) {
    pushMigrationDiagnostic(diagnostics, "roles", "Retain roles as a bounded provider-qualified agent map.");
  } else if (record(legacy.roles)) {
    for (const [role, value] of Object.entries(legacy.roles)) {
      if (!safeLegacyKey(role)) {
        pushMigrationDiagnostic(diagnostics, `roles.${role}`, "Retain bounded role identifiers without coercion.");
        continue;
      }
      roles[role] = legacyAgent(value, provider, `roles.${role}`, diagnostics);
    }
  }
  const flags = legacyMap(legacy.flags, "flags", diagnostics, (entry): entry is boolean | null => entry === null || typeof entry === "boolean");
  const runtimeSource = legacy.runtime_classes ?? legacy.scope_runtime_classes;
  const runtime = legacyMap(runtimeSource, "runtime_classes", diagnostics, (entry): entry is string | boolean | null => entry === null || typeof entry === "string" || typeof entry === "boolean");
  const uiSource = legacy.ui_classes ?? legacy.scope_ui_classes;
  const ui = legacyMap(uiSource, "ui_classes", diagnostics, (entry): entry is string | boolean | null => entry === null || typeof entry === "string" || typeof entry === "boolean");
  let designSystem: string | null = null;
  if (legacy.design_system === undefined || legacy.design_system === null) {
    designSystem = null;
  } else if (typeof legacy.design_system === "string") {
    designSystem = legacy.design_system;
  } else {
    pushMigrationDiagnostic(diagnostics, "design_system", "Retain a bounded design-system identifier or null.");
  }
  const policy: WorkflowPolicy = Object.freeze({
    roles: Object.freeze(roles),
    scope_map: legacyScopes(legacy.scope_map, provider, diagnostics),
    roster_overrides: legacyRoster(legacy.roster_overrides, diagnostics),
    flags,
    runtime_classes: runtime,
    ui_classes: ui,
    design_system: designSystem,
    commands: legacyCommands(legacy.commands, diagnostics),
    workflow: legacyWorkflow(legacy.workflow, diagnostics),
    prompt_context: legacyPromptContext(legacy.prompt_context, diagnostics),
    required_capabilities: legacyCapabilities(legacy.required_capabilities, diagnostics),
  });
  if (diagnostics.length > 0) return failureResult(diagnostics);
  return successResult(Object.freeze({
    schema_version: 2 as const,
    provider: providerRef(provider),
    policy,
  }));
}

function migrateFor(root: CanonicalRoot, manager: TrustedManagementContext, request: ProviderMigrateRequest, registry: ProviderRegistry): ProviderManagementResult {
  const operation = "management.migrate" as const;
  const authority = managerAuthority(manager);
  if (!authority) {
    return failed(
      "ACTIVATION_FAILED",
      operation,
      "Provide a factory-issued trusted descriptor-relative filesystem authority before reading migration input.",
      { canonical_root: root, reason: manager.filesystem_authority === undefined ? "missing" : "foreign" },
    );
  }
  if (request.dry_run !== true) {
    return failed(
      "MIGRATION_REQUIRED",
      operation,
      "Migration requires an explicit dry-run proposal before any root-bound apply.",
      { canonical_root: root, path: policyPath(root) },
    );
  }
  const context = readContext(root, manager, "management.migrate");
  const legacy = readLegacy(root, authority);
  if (!legacy.ok) return failureResult(augmentDiagnostics(legacy.diagnostics, contextEvidence(root, context)));
  if (!context.policy.snapshot && !missingPolicy(context.policy) && legacy.value.path !== policyPath(root)) {
    return failureResult(context.policy.diagnostics);
  }
  if (context.policy.snapshot) {
    return failed(
      "MIGRATION_REQUIRED",
      operation,
      "Migration accepts v1 input only and never replaces an existing v2 policy.",
      { canonical_root: root, path: policyPath(root), config_byte_sha256: context.policy.snapshot.byte_sha256 },
    );
  }
  const provider = providerFor(request.provider_id, registry);
  if (!provider.ok) return failureResult(augmentDiagnostics(provider.diagnostics, contextEvidence(root, context)));
  const capability = capabilities(provider.value, [], operation);
  if (!capability.ok) return failureResult(capability.diagnostics);
  const rootCheck = rootInstance(root, context.binding.snapshot, manager);
  if (!rootCheck.ok) return failureResult(rootCheck.diagnostics);
  const migrated = migrateDocument(provider.value, legacy.value.value);
  if (!migrated.ok) return failureResult(migrated.diagnostics);
  const validation = validatePolicyIdentity(provider.value, migrated.value, operation);
  if (!validation.ok) return failureResult(validation.diagnostics);
  const legacyInput: LegacyExpectation = Object.freeze({
    path: legacy.value.path,
    byte_sha256: legacy.value.byte_sha256,
    fingerprint: legacy.value.fingerprint,
  });
  const proposalResult = makeProposal(
    "migrate",
    root,
    manager,
    provider.value,
    migrated.value,
    null,
    context.binding.snapshot,
    legacyInput,
  );
  if (!proposalResult.ok) return failureResult(proposalResult.diagnostics);
  const proposal = proposalResult.value;
  const diagnostics = dedupeDiagnostics([
    ...context.binding.diagnostics.filter((entry) => entry.code !== "BINDING_REQUIRED"),
    ...capability.diagnostics,
  ]);
  return successResult(
    result(
      "migrate",
      diagnostics,
      proposal,
      false,
      managementObservations(root, context, providerObservations(registry), {
        legacy_path: legacy.value.path,
        legacy_byte_sha256: legacy.value.byte_sha256,
        legacy_backup_path: legacy.value.path === policyPath(root)
          ? `${legacy.value.path}.v1.${legacy.value.byte_sha256.slice("sha256:".length)}.bak`
          : null,
        field_operations: proposal.field_operations,
      }),
    ),
    diagnostics,
  );
}
function hasExactKeys(
  value: RecordValue,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.prototype.hasOwnProperty.call(value, key))
    && Object.keys(value).every((key) => allowed.has(key));
}

function providerRefValid(value: unknown): value is PolicyProviderRef {
  return record(value)
    && hasExactKeys(value, ["id", "protocol_version", "descriptor_fingerprint", "catalog_content_digest"])
    && isProviderId(value.id)
    && value.protocol_version === 2
    && isWorkflowV2Digest(value.descriptor_fingerprint)
    && isWorkflowV2Digest(value.catalog_content_digest);
}

function projectIdentityValid(value: unknown): value is ProjectIdentity {
  if (
    !record(value)
    || !hasExactKeys(value, [
      "root_instance_id",
      "provider_id",
      "descriptor_fingerprint",
      "executable_provenance",
      "catalog_content_digest",
      "config_byte_sha256",
      "config_semantic_sha256",
      "session",
    ])
    || !record(value.executable_provenance)
    || !hasExactKeys(value.executable_provenance, ["build_fingerprint", "runtime_fingerprint"])
    || !record(value.session)
    || !hasExactKeys(value.session, ["session_id", "lifecycle_id"])
  ) {
    return false;
  }
  return isWorkflowV2Digest(value.root_instance_id)
    && isProviderId(value.provider_id)
    && isWorkflowV2Digest(value.descriptor_fingerprint)
    && isWorkflowV2Digest(value.executable_provenance.build_fingerprint)
    && isWorkflowV2Digest(value.executable_provenance.runtime_fingerprint)
    && isWorkflowV2Digest(value.catalog_content_digest)
    && isWorkflowV2Digest(value.config_byte_sha256)
    && isWorkflowV2Digest(value.config_semantic_sha256)
    && typeof value.session.session_id === "string"
    && safeLegacyKey(value.session.session_id)
    && typeof value.session.lifecycle_id === "string"
    && safeLegacyKey(value.session.lifecycle_id);
}

function pathIdentityValid(value: unknown): value is PathIdentity {
  return typeof value === "string" && value.length > 0 && SAFE_IDENTIFIER.test(value);
}

function preconditionsValid(value: unknown): value is PolicyPrecondition {
  if (!record(value) || (value.state !== "absent" && value.state !== "present")) return false;
  if (value.state === "absent") {
    return hasExactKeys(value, [
      "state",
      "canonical_root",
      "worktree_id",
      "session_id",
      "policy_path",
      "parent_path_identity",
      "expected_exclusive_create",
    ])
      && isCanonicalRoot(value.canonical_root)
      && isWorkflowV2Digest(value.worktree_id)
      && typeof value.session_id === "string"
      && safeLegacyKey(value.session_id)
      && typeof value.policy_path === "string"
      && value.policy_path.length > 0
      && pathIdentityValid(value.parent_path_identity)
      && value.expected_exclusive_create === true;
  }
  return hasExactKeys(value, [
    "state",
    "project_identity",
    "policy_path",
    "policy_file_identity",
    "raw_hash",
    "semantic_hash",
  ])
    && projectIdentityValid(value.project_identity)
    && typeof value.policy_path === "string"
    && value.policy_path.length > 0
    && pathIdentityValid(value.policy_file_identity)
    && isWorkflowV2Digest(value.raw_hash)
    && isWorkflowV2Digest(value.semantic_hash);
}
function policyPreconditionsEqual(left: PolicyPrecondition, right: PolicyPrecondition): boolean {
  if (left.state === "absent") {
    if (right.state !== "absent") return false;
    return left.canonical_root === right.canonical_root
      && left.worktree_id === right.worktree_id
      && left.session_id === right.session_id
      && left.policy_path === right.policy_path
      && left.parent_path_identity === right.parent_path_identity
      && left.expected_exclusive_create === right.expected_exclusive_create;
  }
  if (right.state !== "present") return false;
  const leftProject = left.project_identity;
  const rightProject = right.project_identity;
  return left.policy_path === right.policy_path
    && left.policy_file_identity === right.policy_file_identity
    && left.raw_hash === right.raw_hash
    && left.semantic_hash === right.semantic_hash
    && leftProject.root_instance_id === rightProject.root_instance_id
    && leftProject.provider_id === rightProject.provider_id
    && leftProject.descriptor_fingerprint === rightProject.descriptor_fingerprint
    && leftProject.executable_provenance.build_fingerprint === rightProject.executable_provenance.build_fingerprint
    && leftProject.executable_provenance.runtime_fingerprint === rightProject.executable_provenance.runtime_fingerprint
    && leftProject.catalog_content_digest === rightProject.catalog_content_digest
    && leftProject.config_byte_sha256 === rightProject.config_byte_sha256
    && leftProject.config_semantic_sha256 === rightProject.config_semantic_sha256
    && leftProject.session.session_id === rightProject.session.session_id
    && leftProject.session.lifecycle_id === rightProject.session.lifecycle_id;
}


function fieldOperationValid(value: unknown): value is FieldOperation {
  if (
    !record(value)
    || !hasExactKeys(value, ["operation", "path"], ["before", "after", "id"])
    || typeof value.path !== "string"
    || value.path.length === 0
    || !SAFE_IDENTIFIER.test(value.path)
    || (value.id !== undefined && (typeof value.id !== "string" || !safeLegacyKey(value.id)))
  ) {
    return false;
  }
  const hasBefore = Object.prototype.hasOwnProperty.call(value, "before");
  const hasAfter = Object.prototype.hasOwnProperty.call(value, "after");
  if (value.operation === "add") {
    return !hasBefore && hasAfter && policyValue(value.after);
  }
  if (value.operation === "replace") {
    return hasBefore && hasAfter && policyValue(value.before) && policyValue(value.after);
  }
  if (value.operation === "remove") {
    return hasBefore && !hasAfter && policyValue(value.before);
  }
  return false;
}

function fieldOperationsValid(value: unknown): value is readonly FieldOperation[] {
  if (!Array.isArray(value)) return false;
  for (let index = 0; index < value.length; index += 1) {
    if (
      !Object.prototype.hasOwnProperty.call(value, index)
      || !fieldOperationValid(value[index])
    ) {
      return false;
    }
  }
  return true;
}

function policyDocumentValid(value: unknown): value is Readonly<PolicyDocument> {
  if (!record(value)) return false;
  try {
    return parsePolicyDocument(canonicalPolicyJson(value)).ok;
  } catch {
    return false;
  }
}

function proposalShapeValid(value: unknown): value is InternalProposal {
  if (
    !record(value)
    || !hasExactKeys(
      value,
      ["operation", "proposal_digest", "provider", "next_policy", "field_operations", "expected"],
      ["legacy_input"],
    )
    || !isManagementOperation(value.operation)
    || !isWorkflowV2Digest(value.proposal_digest)
    || !providerRefValid(value.provider)
    || !policyDocumentValid(value.next_policy)
    || !fieldOperationsValid(value.field_operations)
    || !preconditionsValid(value.expected)
  ) {
    return false;
  }
  const hasLegacyInput = Object.prototype.hasOwnProperty.call(value, "legacy_input");
  if (value.operation === "migrate" ? !hasLegacyInput : hasLegacyInput) return false;
  if (!hasLegacyInput) return true;
  const legacyInput = value.legacy_input;
  return record(legacyInput)
    && hasExactKeys(legacyInput, ["path", "byte_sha256", "fingerprint"])
    && typeof legacyInput.path === "string"
    && legacyInput.path.length > 0
    && isWorkflowV2Digest(legacyInput.byte_sha256)
    && targetFingerprintValid(legacyInput.fingerprint);
}

function policyMatchesExpected(
  snapshot: PolicySnapshot,
  expected: PolicyPrecondition,
  fingerprint?: TargetFingerprint,
): boolean {
  if (expected.state !== "present") return false;
  const project = expected.project_identity;
  return expected.policy_path === policyPath(snapshot.root)
    && (fingerprint === undefined || targetIdentityMatches(expected.policy_file_identity, fingerprint))
    && snapshot.byte_sha256 === expected.raw_hash
    && snapshot.semantic_sha256 === expected.semantic_hash
    && snapshot.byte_sha256 === project.config_byte_sha256
    && snapshot.semantic_sha256 === project.config_semantic_sha256
    && snapshot.document.provider.id === project.provider_id
    && snapshot.document.provider.descriptor_fingerprint === project.descriptor_fingerprint
    && snapshot.document.provider.catalog_content_digest === project.catalog_content_digest;
}

function bindingMatchesExpected(
  binding: BindingSnapshot,
  expected: PolicyPrecondition,
  worktreeId: WorkflowV2Digest,
): boolean {
  if (expected.state !== "present") return false;
  const project = expected.project_identity;
  const validated = binding.document.last_validated;
  return binding.document.project_worktree_instance === worktreeId
    && binding.document.project_worktree_instance === project.root_instance_id
    && validated.provider_id === project.provider_id
    && validated.descriptor_fingerprint === project.descriptor_fingerprint
    && validated.executable_provenance.build_fingerprint === project.executable_provenance.build_fingerprint
    && validated.executable_provenance.runtime_fingerprint === project.executable_provenance.runtime_fingerprint
    && validated.catalog_content_digest === project.catalog_content_digest
    && validated.config_byte_sha256 === project.config_byte_sha256
    && validated.config_semantic_sha256 === project.config_semantic_sha256
    && fieldsEqual(validated.session, project.session);
}

function bindingIdentity(
  root: CanonicalRoot,
  manager: TrustedManagementContext,
  provider: ProviderRecord,
  policy: PolicySnapshot,
  rootId: WorkflowV2Digest,
): DiagnosticResult<BindingDocument> {
  const authority = managerAuthority(manager);
  if (!authority) {
    return failed(
      "ACTIVATION_FAILED",
      "binding.write",
      "Provide a factory-issued trusted descriptor-relative filesystem authority before building the binding.",
      { canonical_root: root, reason: manager.filesystem_authority === undefined ? "missing" : "foreign" },
    );
  }
  const validated: BindingValidatedIdentity = Object.freeze({
    provider_id: provider.provider_id,
    descriptor_fingerprint: provider.descriptor_fingerprint,
    executable_provenance: Object.freeze({ ...provider.descriptor.executable_provenance }),
    catalog_content_digest: provider.catalog.content_digest,
    config_byte_sha256: policy.byte_sha256,
    config_semantic_sha256: policy.semantic_sha256,
    session: Object.freeze({ ...manager.session }),
  });
  const built = buildBindingDocument(root, validated, authority);
  if (!built.ok) return built;
  if (built.value.project_worktree_instance !== rootId) {
    return failed(
      "IDENTITY_MISMATCH",
      "binding.write",
      "The root binding identity changed during the policy transaction; obtain a new proposal.",
      {
        canonical_root: root,
        expected_digest: rootId,
        actual_digest: built.value.project_worktree_instance,
      },
    );
  }
  return built;
}
function presentPolicyPrecondition(
  root: CanonicalRoot,
  manager: TrustedManagementContext,
  provider: ProviderRecord,
  snapshot: PolicySnapshot,
  pinned: PinnedFsRoot,
): DiagnosticResult<PresentPolicyPrecondition> {
  const policyPathValue = policyPath(root);
  const authority = managerAuthority(manager);
  if (!authority) {
    return failed(
      "ACTIVATION_FAILED",
      "management.apply",
      "Provide a factory-issued trusted descriptor-relative filesystem authority before checking the policy precondition.",
      { canonical_root: root, reason: manager.filesystem_authority === undefined ? "missing" : "foreign" },
    );
  }
  const policyTarget = targetRead(authority, pinned.ompDirectory, "team.config.json", TRANSACTION_MAX_BYTES, "management.apply", root);
  if (!policyTarget.ok) return policyTarget;
  if (
    policyTarget.value.fingerprint.state !== "present"
    || policyTarget.value.fingerprint.byte_sha256 !== snapshot.byte_sha256
    || policyTarget.value.fingerprint.byte_length !== snapshot.byte_length
  ) {
    return failed(
      "IDENTITY_MISMATCH",
      "management.apply",
      "The descriptor-relative policy changed while constructing the binding precondition; preserve the transaction.",
      { canonical_root: root, policy_path: policyPathValue },
    );
  }
  const fileIdentity = pathIdentityFromTarget(policyTarget.value.fingerprint);
  if (fileIdentity === undefined) {
    return failed(
      "IDENTITY_MISMATCH",
      "management.apply",
      "The descriptor-relative policy has no stable file identity; preserve the transaction.",
      { canonical_root: root, policy_path: policyPathValue },
    );
  }
  const projectIdentity: ProjectIdentity = Object.freeze({
    root_instance_id: manager.worktree_id,
    provider_id: provider.provider_id,
    descriptor_fingerprint: provider.descriptor_fingerprint,
    executable_provenance: Object.freeze({ ...provider.descriptor.executable_provenance }),
    catalog_content_digest: provider.catalog.content_digest,
    config_byte_sha256: snapshot.byte_sha256,
    config_semantic_sha256: snapshot.semantic_sha256,
    session: Object.freeze({ ...manager.session }),
  });
  return successResult(Object.freeze({
    state: "present" as const,
    project_identity: projectIdentity,
    policy_path: policyPathValue,
    policy_file_identity: fileIdentity,
    raw_hash: snapshot.byte_sha256,
    semantic_hash: snapshot.semantic_sha256,
  }));
}
function policyWriteExpected(
  expected: PolicyPrecondition,
  pinned: PinnedFsRoot,
): PolicyPrecondition {
  if (expected.state !== "absent") return expected;
  const pinnedIdentity = pathIdentityFromDirectory(pinned.ompDevice, pinned.ompInode);
  if (expected.parent_path_identity === pinnedIdentity) return expected;
  // The management absent-policy precondition retains the trusted root
  // identity across exclusive .omp creation. The policy writer's pinned
  // directory check must use the directory descriptor it writes through;
  // management has already rechecked the original root identity before
  // journaling and keeps it for the remaining absent-policy checks.
  return Object.freeze({
    ...expected,
    parent_path_identity: pinnedIdentity,
  });
}




type RestorePlan = Readonly<{
  directory: FsDirectoryHandle;
  leaf: string;
  current: TargetFingerprint;
  desired: TargetFingerprint;
  bytes: Buffer | null;
}>;

function targetFingerprintOfOld(value: TransactionOldTarget): TargetFingerprint {
  if (value.state === "absent") return Object.freeze({ state: "absent" as const });
  return Object.freeze({
    state: "present" as const,
    device: value.device,
    inode: value.inode,
    byte_sha256: value.byte_sha256,
    byte_length: value.byte_length,
  });
}

function decodeJournalImage(
  authority: ManagementFsAuthority,
  directory: FsDirectoryHandle,
  image: TransactionOldTarget["image"],
  expected: TargetFingerprint,
  root: CanonicalRoot,
): DiagnosticResult<Buffer | null> {
  if (image.kind === "none") {
    return expected.state === "absent"
      ? successResult(null)
      : failed("CONFIG_MALFORMED", "management.apply", "A present journal target requires a bounded rollback image.", {
        canonical_root: root,
      });
  }
  if (image.kind === "inline") {
    if (expected.state !== "present") {
      return failed("CONFIG_MALFORMED", "management.apply", "An absent journal target cannot carry an inline rollback image.", {
        canonical_root: root,
      });
    }
    const padding = image.base64.endsWith("==") ? 2 : image.base64.endsWith("=") ? 1 : 0;
    const decodedLength = Math.floor(image.base64.length / 4) * 3 - padding;
    if (decodedLength !== expected.byte_length || decodedLength > TRANSACTION_MAX_BYTES) {
      return failed("CONFIG_MALFORMED", "management.apply", "The encoded rollback image exceeds its independent bounded length.", {
        canonical_root: root,
      });
    }
    const bytes = Buffer.from(image.base64, "base64");
    if (
      bytes.byteLength !== expected.byte_length
      || byteDigest(bytes) !== expected.byte_sha256
    ) {
      return failed("IDENTITY_MISMATCH", "management.apply", "The rollback image hash or length differs from the journal target.", {
        canonical_root: root,
      });
    }
    return successResult(bytes);
  }
  if (expected.state !== "present") {
    return failed("CONFIG_MALFORMED", "management.apply", "An absent journal target cannot carry a backup image.", {
      canonical_root: root,
    });
  }
  const backup = targetRead(authority, directory, image.path, TRANSACTION_MAX_BYTES, "management.apply", root);
  if (!backup.ok || backup.value.bytes === null) {
    return backup.ok
      ? failed("ACTIVATION_FAILED", "management.apply", "The descriptor-relative rollback backup is missing; preserve the journal and targets.", {
        canonical_root: root,
        path: image.path,
      })
      : failureResult(backup.diagnostics);
  }
  if (
    !sameTargetFingerprint(backup.value.fingerprint, image.fingerprint)
    || backup.value.bytes.byteLength !== expected.byte_length
    || byteDigest(backup.value.bytes) !== expected.byte_sha256
  ) {
    return failed("IDENTITY_MISMATCH", "management.apply", "The descriptor-relative rollback backup changed; preserve the journal and targets.", {
      canonical_root: root,
      path: image.path,
    });
  }
  return successResult(backup.value.bytes);
}

function restorePlan(
  authority: ManagementFsAuthority,
  directory: FsDirectoryHandle,
  leaf: string,
  expectedCurrent: TargetFingerprint,
  oldTargetValue: TransactionOldTarget,
  root: CanonicalRoot,
  maxBytes: number,
): DiagnosticResult<RestorePlan> {
  const current = targetRead(authority, directory, leaf, maxBytes, "management.apply", root);
  if (!current.ok) return current;
  if (!sameTargetFingerprint(current.value.fingerprint, expectedCurrent)) {
    return failed("IDENTITY_MISMATCH", "management.apply", "A transaction target changed inode, hash, length, or absence state; leave the journal and targets untouched.", {
      canonical_root: root,
      leaf,
    });
  }
  const desired = targetFingerprintOfOld(oldTargetValue);
  if (sameTargetFingerprint(current.value.fingerprint, desired)) {
    return successResult(Object.freeze({ directory, leaf, current: current.value.fingerprint, desired, bytes: null }));
  }
  const image = decodeJournalImage(authority, directory, oldTargetValue.image, desired, root);
  if (!image.ok) return image;
  return successResult(Object.freeze({ directory, leaf, current: current.value.fingerprint, desired, bytes: image.value }));
}

function applyRestorePlan(
  authority: ManagementFsAuthority,
  plan: RestorePlan,
  root: CanonicalRoot,
): DiagnosticResult<TargetFingerprint> {
  if (plan.bytes === null) return successResult(plan.current);
  const result = plan.desired.state === "absent"
    ? authority.atomicRemoveIfCurrent(plan.directory, plan.leaf, plan.current)
    : authority.atomicReplaceIfCurrent(plan.directory, plan.leaf, plan.current, plan.bytes);
  if (!result.ok) {
    return authorityFailure(result, "management.apply", "Descriptor-relative rollback CAS was unsupported or conflicted; preserve the journal and targets.", {
      canonical_root: root,
      leaf: plan.leaf,
    });
  }
  const actual = authorityFingerprint(result.value);
  if (!actual || !sameTargetContent(actual, plan.desired)) {
    return failed("IDENTITY_MISMATCH", "management.apply", "Rollback CAS produced bytes that do not match the journal's old target.", {
      canonical_root: root,
      leaf: plan.leaf,
    });
  }
  const synced = authority.fsyncDirectory(plan.directory);
  if (!synced.ok) {
    return authorityFailure(synced, "management.apply", "The rollback target directory could not be durably synchronized; preserve the journal and targets.", {
      canonical_root: root,
      leaf: plan.leaf,
    });
  }
  return successResult(actual);
}

function recoveryExpected(
  journal: TransactionJournal,
  target: "policy" | "binding",
): TargetFingerprint {
  if (journal.phase === "prepared") return target === "policy" ? targetFingerprintOfOld(journal.old_policy) : targetFingerprintOfOld(journal.old_binding);
  if (journal.phase === "policy_written") return target === "policy" ? journal.new_policy : targetFingerprintOfOld(journal.old_binding);
  return target === "policy" ? journal.new_policy : journal.new_binding;
}

function transactionWitnessBinding(
  state: ApplyState,
  lock: TransactionLock,
  journal: TransactionJournal,
): {
  canonical_root: CanonicalRoot;
  proposal_digest: WorkflowV2Digest;
  worktree_id: WorkflowV2Digest;
  session_id: string;
  lifecycle_id: string;
  old_policy: TargetFingerprint;
  old_binding: TargetFingerprint;
  new_policy: TargetFingerprint;
  new_binding: TargetFingerprint;
  lock_token: object;
} {
  return {
    canonical_root: journal.canonical_root,
    proposal_digest: state.candidate.proposal_digest,
    worktree_id: state.manager.worktree_id,
    session_id: state.manager.session.session_id,
    lifecycle_id: state.manager.session.lifecycle_id,
    old_policy: targetFingerprintOfOld(journal.old_policy),
    old_binding: targetFingerprintOfOld(journal.old_binding),
    new_policy: journal.new_policy,
    new_binding: journal.new_binding,
    lock_token: lock.token,
  };
}

function clearCommittedTransaction(
  root: CanonicalRoot,
  lock: TransactionLock,
  journal: TransactionJournal,
): readonly V2Diagnostic[] {
  const authority = lock.authority;
  const current = targetRead(
    authority,
    lock.pinned.rootDirectory,
    TRANSACTION_JOURNAL_NAME,
    TRANSACTION_MAX_BYTES,
    "management.apply",
    root,
  );
  if (!current.ok || current.value.fingerprint.state !== "present") {
    return [diag("ACTIVATION_FAILED", "management.apply", "The committed journal changed or disappeared before removal; preserve the root.", {
      canonical_root: root,
      journal_path: transactionJournalPath(root),
    })];
  }
  return clearTransactionJournal(root, authority, lock.pinned, current.value.fingerprint, journal);
}

function recoverTransaction(
  root: CanonicalRoot,
  state: ApplyState,
  lock: TransactionLock,
  witness: TransactionWitness,
): readonly V2Diagnostic[] {
  const authority = lock.authority;
  const journalResult = readTransactionJournal(root, authority, lock.pinned);
  if (!journalResult.ok) return journalResult.diagnostics;
  const journal = journalResult.value;
  if (journal === null) return [];
  const binding = transactionWitnessBinding(state, lock, journal);
  if (!transactionWitnessValid(witness, journal, binding)) {
    return [diag(
      "TRANSACTION_INCOMPLETE",
      "management.apply",
      "Only the private same-process transaction witness may authorize recovery; preserve the journal for explicit repair.",
      { canonical_root: root, journal_path: transactionJournalPath(root), transaction_id: journal.transaction_id },
    )];
  }
  if (journal.phase === "committed") {
    const policy = targetRead(authority, lock.pinned.ompDirectory, "team.config.json", 262_144, "management.apply", root);
    const sidecar = targetRead(authority, lock.pinned.ompDirectory, "team.config.binding.json", 64 * 1024, "management.apply", root);
    if (
      !policy.ok
      || !sidecar.ok
      || !sameTargetContent(policy.ok ? policy.value.fingerprint : Object.freeze({ state: "absent" as const }), journal.new_policy)
      || !sameTargetContent(sidecar.ok ? sidecar.value.fingerprint : Object.freeze({ state: "absent" as const }), journal.new_binding)
    ) {
      return [diag("IDENTITY_MISMATCH", "management.apply", "A committed transaction target changed; do not roll it back and preserve the journal.", {
        canonical_root: root,
        journal_path: transactionJournalPath(root),
      })];
    }
    return clearCommittedTransaction(root, lock, journal);
  }
  const policyPlan = restorePlan(
    authority,
    lock.pinned.ompDirectory,
    "team.config.json",
    recoveryExpected(journal, "policy"),
    journal.old_policy,
    root,
    262_144,
  );
  if (!policyPlan.ok) return policyPlan.diagnostics;
  const bindingPlan = restorePlan(
    authority,
    lock.pinned.ompDirectory,
    "team.config.binding.json",
    recoveryExpected(journal, "binding"),
    journal.old_binding,
    root,
    64 * 1024,
  );
  if (!bindingPlan.ok) return bindingPlan.diagnostics;
  const restoredBinding = applyRestorePlan(authority, bindingPlan.value, root);
  if (!restoredBinding.ok) return restoredBinding.diagnostics;
  const restoredPolicy = applyRestorePlan(authority, policyPlan.value, root);
  if (!restoredPolicy.ok) return restoredPolicy.diagnostics;
  const finalPolicy = targetRead(authority, lock.pinned.ompDirectory, "team.config.json", 262_144, "management.apply", root);
  const finalBinding = targetRead(authority, lock.pinned.ompDirectory, "team.config.binding.json", 64 * 1024, "management.apply", root);
  if (
    !finalPolicy.ok
    || !finalBinding.ok
    || !sameTargetContent(finalPolicy.ok ? finalPolicy.value.fingerprint : Object.freeze({ state: "absent" as const }), targetFingerprintOfOld(journal.old_policy))
    || !sameTargetContent(finalBinding.ok ? finalBinding.value.fingerprint : Object.freeze({ state: "absent" as const }), targetFingerprintOfOld(journal.old_binding))
  ) {
    return [diag("IDENTITY_MISMATCH", "management.apply", "Rollback did not reproduce both old target contents; preserve the journal for explicit repair.", {
      canonical_root: root,
      journal_path: transactionJournalPath(root),
    })];
  }
  return clearCommittedTransaction(root, lock, journal);
}

function transactionFailure(
  root: CanonicalRoot,
  state: ApplyState,
  lock: TransactionLock,
  witness: TransactionWitness,
  original: readonly V2Diagnostic[],
): ProviderManagementResult {
  const recovery = recoverTransaction(root, state, lock, witness);
  forgetTransactionWitness(witness);
  return failureResult([...original, ...recovery]);
}

function recheckApplyWitness(
  root: CanonicalRoot,
  state: ApplyState,
  lock: TransactionLock,
): DiagnosticResult<true> {
  const pinned = lock.pinned;
  const authority = lock.authority;
  const policy = readPolicy(root, authority, undefined, pinned);
  const expected = state.candidate.expected;
  const binding = readBinding(root, authority, undefined, pinned);
  const migrationPolicySource = state.candidate.operation === "migrate"
    && state.legacy?.path === policyPath(root);
  if (state.candidate.operation === "migrate") {
    const captured = state.candidate.legacy_input;
    const rereadLegacy = readLegacy(root, authority, pinned);
    if (!rereadLegacy.ok) return failureResult(rereadLegacy.diagnostics);
    if (
      !state.legacy
      || !captured
      || rereadLegacy.value.path !== state.legacy.path
      || rereadLegacy.value.byte_sha256 !== state.legacy.byte_sha256
      || !sameTargetFingerprint(rereadLegacy.value.fingerprint, state.legacy.fingerprint)
      || rereadLegacy.value.path !== captured.path
      || rereadLegacy.value.byte_sha256 !== captured.byte_sha256
      || !sameTargetFingerprint(rereadLegacy.value.fingerprint, captured.fingerprint)
    ) {
      return failed(
        "IDENTITY_MISMATCH",
        "management.apply",
        "The validated v1 migration source changed after proposal validation; obtain a new migration proposal.",
        { canonical_root: root, path: state.legacy?.path ?? captured?.path ?? null },
      );
    }
  }
  const bindingEntry = authority.inspect(pinned.ompDirectory, "team.config.binding.json");
  if (!bindingEntry.ok) {
    return authorityFailure(bindingEntry, "management.apply", "Inspect the root-local binding through the trusted descriptor-relative authority.", {
      canonical_root: root,
      binding_path: bindingPath(root),
    });
  }
  if (expected.state === "absent") {
    if (!migrationPolicySource && !missingPolicy(policy)) {
      return failed(
        "IDENTITY_MISMATCH",
        "management.apply",
        "The policy changed after proposal validation; obtain a new proposal before journaling.",
        { canonical_root: root, policy_path: policyPath(root) },
      );
    }
    if (
      expected.canonical_root !== root
      || expected.worktree_id !== state.manager.worktree_id
      || expected.session_id !== state.manager.session.session_id
      || expected.policy_path !== policyPath(root)
      || expected.parent_path_identity !== lock.parent_identity
      || binding.snapshot !== null
      || bindingEntry.value !== null
    ) {
      return failed(
        "IDENTITY_MISMATCH",
        "management.apply",
        "The absent policy or root-local sidecar changed before the transaction journal was created.",
        { canonical_root: root, policy_path: policyPath(root), binding_path: bindingPath(root) },
      );
    }
    const rootCheck = rootInstance(root, null, state.manager);
    return rootCheck.ok && rootCheck.value === state.root_instance_id
      ? successResult(true)
      : failed("IDENTITY_MISMATCH", "management.apply", "The trusted worktree changed before the transaction journal was created.", {
        canonical_root: root,
        expected_digest: state.root_instance_id,
        actual_digest: rootCheck.ok ? rootCheck.value : null,
      });
  }
  const policyTarget = targetRead(authority, pinned.ompDirectory, "team.config.json", TRANSACTION_MAX_BYTES, "management.apply", root);
  if (!policyTarget.ok) return policyTarget;
  if (!policy.snapshot || !policyMatchesExpected(policy.snapshot, expected, policyTarget.value.fingerprint)) {
    return failed(
      "IDENTITY_MISMATCH",
      "management.apply",
      "The existing policy changed before the transaction journal was created; obtain a new proposal.",
      { canonical_root: root, policy_path: policyPath(root) },
    );
  }
  if (
    expected.project_identity.root_instance_id !== state.manager.worktree_id
    || !fieldsEqual(expected.project_identity.session, state.manager.session)
    || !binding.snapshot
    || !bindingMatchesExpected(binding.snapshot, expected, state.manager.worktree_id)
  ) {
    return failed(
      "IDENTITY_MISMATCH",
      "management.apply",
      "The existing policy or root-local sidecar changed before the transaction journal was created; obtain a new proposal.",
      { canonical_root: root, policy_path: policyPath(root), binding_path: bindingPath(root) },
    );
  }
  const rootCheck = rootInstance(root, binding.snapshot, state.manager);
  return rootCheck.ok && rootCheck.value === state.root_instance_id
    ? successResult(true)
    : failed("IDENTITY_MISMATCH", "management.apply", "The trusted worktree changed before the transaction journal was created.", {
      canonical_root: root,
      expected_digest: state.root_instance_id,
      actual_digest: rootCheck.ok ? rootCheck.value : null,
    });
}

function advanceJournal(
  root: CanonicalRoot,
  lock: TransactionLock,
  witness: TransactionWitness,
  previous: BegunTransaction,
  phase: TransactionPhase,
  newPolicy: TargetFingerprint,
  newBinding: TargetFingerprint,
): DiagnosticResult<BegunTransaction> {
  const journal: TransactionJournal = Object.freeze({
    ...previous.journal,
    phase,
    new_policy: newPolicy,
    new_binding: newBinding,
  });
  const written = writeTransactionJournal(root, lock.authority, lock.pinned, journal, previous.journal_fingerprint);
  if (!written.ok) return written;
  if (!advanceTransactionWitness(witness, journal)) {
    return failed("ACTIVATION_FAILED", "management.apply", "The private transaction witness rejected the phase transition; preserve the journal and targets.", {
      canonical_root: root,
      journal_path: transactionJournalPath(root),
      phase,
    });
  }
  return successResult(Object.freeze({ journal, witness, journal_fingerprint: written.value }));
}

function applyTransaction(
  root: CanonicalRoot,
  state: ApplyState,
  lock: TransactionLock,
): ProviderManagementResult {
  const rootCheck = rootInstance(root, state.binding, state.manager);
  if (!rootCheck.ok) return failureResult(rootCheck.diagnostics);
  if (rootCheck.value !== state.root_instance_id) {
    return failed(
      "IDENTITY_MISMATCH",
      "management.apply",
      "The physical root instance changed before the transaction write; obtain a new proposal.",
      {
        canonical_root: root,
        expected_digest: state.root_instance_id,
        actual_digest: rootCheck.value,
      },
    );
  }
  const witnessCheck = recheckApplyWitness(root, state, lock);
  if (!witnessCheck.ok) return failureResult(witnessCheck.diagnostics);
  const begun = beginTransactionJournal(root, state, lock);
  if (!begun.ok) return failureResult(begun.diagnostics);
  let currentTransaction = begun.value;

  const authority = lock.authority;
  const migrationPolicySource = state.candidate.operation === "migrate"
    && state.legacy?.path === policyPath(root);
  if (migrationPolicySource) {
    const captured = state.candidate.legacy_input;
    const journalSource = targetFingerprintOfOld(currentTransaction.journal.old_policy);
    if (
      !captured
      || !sameTargetFingerprint(captured.fingerprint, journalSource)
    ) {
      return transactionFailure(root, state, lock, begun.value.witness, [diag(
        "IDENTITY_MISMATCH",
        "management.apply",
        "The v1 .omp migration source changed before replacement; preserve the journal and obtain a new proposal.",
        { canonical_root: root, path: state.legacy?.path ?? null },
      )]);
    }
  }
  let written: PolicyWriteResult;
  if (migrationPolicySource) {
    let bytes: Buffer;
    try {
      bytes = Buffer.from(`${canonicalPolicyJson(state.candidate.next_policy)}\n`, "utf8");
    } catch {
      return transactionFailure(root, state, lock, begun.value.witness, [diag("CONFIG_MALFORMED", "management.apply", "The migrated policy is not canonical JSON.", {
        canonical_root: root,
      })]);
    }
    const expected = targetFingerprintOfOld(currentTransaction.journal.old_policy);
    const replaced = authority.atomicReplaceIfCurrent(lock.pinned.ompDirectory, "team.config.json", expected, bytes);
    if (!replaced.ok) {
      return transactionFailure(root, state, lock, begun.value.witness, authorityFailure(replaced, "management.apply", "The validated v1 .omp source changed before migration publication; preserve the journal and targets.", {
        canonical_root: root,
        path: policyPath(root),
      }).diagnostics);
    }
    const replacementFingerprint = authorityFingerprint(replaced.value);
    if (
      !replacementFingerprint
      || replacementFingerprint.state !== "present"
      || replacementFingerprint.byte_sha256 !== byteDigest(bytes)
      || replacementFingerprint.byte_length !== bytes.byteLength
    ) {
      return transactionFailure(root, state, lock, begun.value.witness, [diag(
        "IDENTITY_MISMATCH",
        "management.apply",
        "The migrated policy publication returned bytes different from the requested policy; preserve the journal and targets.",
        { canonical_root: root, path: policyPath(root) },
      )]);
    }
    const replacementSync = syncDirectory(root, authority, lock.pinned.ompDirectory, "management.apply", "team.config.json");
    if (replacementSync.length > 0) {
      return transactionFailure(root, state, lock, begun.value.witness, replacementSync);
    }
    written = readPolicyDuringTransaction(root, authority, lock.pinned);
  } else {
    written = writePolicyDuringTransaction({
      root,
      document: state.candidate.next_policy,
      confirm_root: true,
      expected: policyWriteExpected(state.candidate.expected, lock.pinned),
      current: state.current,
    }, authority, lock.pinned);
  }
  if (!written.ok) {
    return transactionFailure(root, state, lock, begun.value.witness, written.diagnostics);
  }
  const policyTarget = targetRead(authority, lock.pinned.ompDirectory, "team.config.json", 262_144, "management.apply", root);
  if (!policyTarget.ok) return transactionFailure(root, state, lock, begun.value.witness, policyTarget.diagnostics);
  const policyPhase = advanceJournal(
    root,
    lock,
    begun.value.witness,
    currentTransaction,
    "policy_written",
    policyTarget.value.fingerprint,
    targetFingerprintOfOld(currentTransaction.journal.old_binding),
  );
  if (!policyPhase.ok) return transactionFailure(root, state, lock, begun.value.witness, policyPhase.diagnostics);
  currentTransaction = policyPhase.value;
  const reread = readPolicyDuringTransaction(root, authority, lock.pinned);
  if (!reread.ok) return transactionFailure(root, state, lock, begun.value.witness, reread.diagnostics);
  if (
    reread.value.byte_sha256 !== written.value.byte_sha256
    || reread.value.semantic_sha256 !== computePolicySemanticHash(state.candidate.next_policy)
  ) {
    return transactionFailure(root, state, lock, begun.value.witness, [diag(
      "IDENTITY_MISMATCH",
      "management.apply",
      "The policy changed during the management transaction; obtain a new proposal.",
      {
        canonical_root: root,
        expected_digest: written.value.byte_sha256,
        actual_digest: reread.value.byte_sha256,
      },
    )]);
  }
  const builtBinding = bindingIdentity(root, state.manager, state.provider, reread.value, state.root_instance_id);
  if (!builtBinding.ok) return transactionFailure(root, state, lock, begun.value.witness, builtBinding.diagnostics);
  const postWriteExpected = presentPolicyPrecondition(root, state.manager, state.provider, reread.value, lock.pinned);
  if (!postWriteExpected.ok) return transactionFailure(root, state, lock, begun.value.witness, postWriteExpected.diagnostics);
  const bindingWrite = writeBindingDuringTransaction({
    root,
    document: builtBinding.value,
    confirm_root: true,
    expected: state.candidate.expected.state === "absent" ? state.candidate.expected : postWriteExpected.value,
    current: state.binding,
  }, authority, lock.pinned);
  if (!bindingWrite.ok) return transactionFailure(root, state, lock, begun.value.witness, bindingWrite.diagnostics);
  const finalBinding = readBindingDuringTransaction(root, authority, lock.pinned);
  if (!finalBinding.ok) return transactionFailure(root, state, lock, begun.value.witness, finalBinding.diagnostics);
  const bindingTarget = targetRead(authority, lock.pinned.ompDirectory, "team.config.binding.json", 64 * 1024, "management.apply", root);
  if (!bindingTarget.ok) return transactionFailure(root, state, lock, begun.value.witness, bindingTarget.diagnostics);
  const bindingPhase = advanceJournal(
    root,
    lock,
    begun.value.witness,
    currentTransaction,
    "binding_written",
    policyTarget.value.fingerprint,
    bindingTarget.value.fingerprint,
  );
  if (!bindingPhase.ok) return transactionFailure(root, state, lock, begun.value.witness, bindingPhase.diagnostics);
  currentTransaction = bindingPhase.value;
  const finalValidated = finalBinding.value.document.last_validated;
  const bindingMatches = finalBinding.value.document.project_worktree_instance === state.root_instance_id
    && finalValidated.provider_id === state.provider.provider_id
    && finalValidated.descriptor_fingerprint === state.provider.descriptor_fingerprint
    && fieldsEqual(finalValidated.executable_provenance, state.provider.descriptor.executable_provenance)
    && finalValidated.catalog_content_digest === state.provider.catalog.content_digest
    && finalValidated.config_byte_sha256 === reread.value.byte_sha256
    && finalValidated.config_semantic_sha256 === reread.value.semantic_sha256
    && fieldsEqual(finalValidated.session, state.manager.session);
  if (!bindingMatches) {
    return transactionFailure(root, state, lock, begun.value.witness, [diag(
      "IDENTITY_MISMATCH",
      "management.apply",
      "The final binding identity differs from the applied policy; the transaction was rolled back.",
      {
        canonical_root: root,
        provider_id: state.provider.provider_id,
        expected_digest: reread.value.semantic_sha256,
        actual_digest: finalValidated.config_semantic_sha256,
      },
    )]);
  }
  const committed = advanceJournal(
    root,
    lock,
    begun.value.witness,
    currentTransaction,
    "committed",
    policyTarget.value.fingerprint,
    bindingTarget.value.fingerprint,
  );
  if (!committed.ok) return transactionFailure(root, state, lock, begun.value.witness, committed.diagnostics);
  const journalDiagnostics = clearTransactionJournal(root, authority, lock.pinned, committed.value.journal_fingerprint, committed.value.journal);
  if (journalDiagnostics.length > 0) {
    forgetTransactionWitness(begun.value.witness);
    return failureResult(journalDiagnostics);
  }
  forgetTransactionWitness(begun.value.witness);
  return successResult(
    result(
      "apply",
      state.diagnostics,
      undefined,
      true,
      {
        canonical_root: root,
        policy_path: policyPath(root),
        binding_path: bindingPath(root),
        root_instance_id: state.root_instance_id,
        policy_byte_sha256: reread.value.byte_sha256,
        policy_semantic_sha256: reread.value.semantic_sha256,
        binding_byte_sha256: finalBinding.value.byte_sha256,
        field_operations: state.candidate.field_operations,
      },
    ),
    state.diagnostics,
  );
}

function validateApplyRequest(
  root: CanonicalRoot,
  request: ProviderApplyRequest,
): DiagnosticResult<InternalProposal> {
  const operation = "management.apply" as const;
  if (!request || request.confirm_root !== true) {
    return failed(
      "IDENTITY_MISMATCH",
      operation,
      "Confirm the exact manager-owned project root before applying a proposal.",
      { canonical_root: root, path: policyPath(root), binding_path: bindingPath(root) },
    );
  }
  if (request.dry_run !== undefined && request.dry_run !== false) {
    return failed(
      "CONFIG_MALFORMED",
      operation,
      "Apply requests cannot enable dry-run mode.",
      { canonical_root: root },
    );
  }
  const candidateValue: unknown = request.proposal;
  if (!proposalShapeValid(candidateValue)) {
    return failed(
      "CONFIG_MALFORMED",
      operation,
      "Provide one typed management proposal before apply.",
      { canonical_root: root },
    );
  }
  const candidate = candidateValue;
  if (request.proposal_digest !== candidate.proposal_digest || !isWorkflowV2Digest(request.proposal_digest)) {
    return failed(
      "IDENTITY_MISMATCH",
      operation,
      "Apply requires the exact proposal digest returned by the read-only management operation.",
      {
        expected_digest: candidate.proposal_digest,
        actual_digest: request.proposal_digest,
      },
    );
  }
  let actualDigest: WorkflowV2Digest;
  try {
    actualDigest = proposalDigest(proposalUnsigned(candidate));
  } catch {
    return failed(
      "CONFIG_MALFORMED",
      operation,
      "The management proposal contains values outside the strict JSON identity domain.",
      { canonical_root: root },
    );
  }
  if (actualDigest !== candidate.proposal_digest) {
    return failed(
      "IDENTITY_MISMATCH",
      operation,
      "The management proposal changed; obtain a new proposal before apply.",
      { expected_digest: candidate.proposal_digest, actual_digest: actualDigest },
    );
  }
  if (!preconditionsValid(request.expected) || !policyPreconditionsEqual(request.expected, candidate.expected)) {
    return failed(
      "IDENTITY_MISMATCH",
      operation,
      "Apply requires unchanged identity preconditions from the proposal.",
      { provider_id: candidate.provider.id },
    );
  }
  if (
    (candidate.operation === "create" || candidate.operation === "migrate")
    && candidate.expected.state !== "absent"
  ) {
    return failed(
      "IDENTITY_MISMATCH",
      operation,
      "Create and migrate proposals must retain an exclusive absent-policy precondition.",
      { canonical_root: root, provider_id: candidate.provider.id },
    );
  }
  if (candidate.operation === "refresh" && candidate.expected.state !== "present") {
    return failed(
      "IDENTITY_MISMATCH",
      operation,
      "Refresh proposals must retain a present-policy precondition.",
      { canonical_root: root, provider_id: candidate.provider.id },
    );
  }
  return successResult(candidate);
}

function prepareApply(
  root: CanonicalRoot,
  manager: TrustedManagementContext,
  request: ProviderApplyRequest,
  registry: ProviderRegistry,
  pinned: PinnedFsRoot,
  parentIdentity: PathIdentity,
): DiagnosticResult<ApplyState> {
  const operation = "management.apply" as const;
  const authority = managerAuthority(manager);
  if (!authority) {
    return failed(
      "ACTIVATION_FAILED",
      operation,
      "Provide a factory-issued trusted descriptor-relative filesystem authority before preparing an apply.",
      { canonical_root: root, reason: manager.filesystem_authority === undefined ? "missing" : "foreign" },
    );
  }
  const candidateResult = validateApplyRequest(root, request);
  if (!candidateResult.ok) return failureResult(candidateResult.diagnostics);
  const candidate = candidateResult.value;
  const context = readContext(root, manager, "management.apply", pinned);
  const current = context.policy.snapshot;
  let legacy: LegacyCandidate | null = null;
  if (candidate.operation === "migrate") {
    const legacyResult = readLegacy(root, authority, pinned);
    if (!legacyResult.ok) return failureResult(augmentDiagnostics(legacyResult.diagnostics, contextEvidence(root, context)));
    legacy = legacyResult.value;
    if (!current && !missingPolicy(context.policy) && legacy.path !== policyPath(root)) {
      return failureResult(context.policy.diagnostics);
    }
    if (current) {
      return failed(
        "MIGRATION_REQUIRED",
        operation,
        "Migration never replaces an existing v2 policy; preserve the current policy and start a fresh explicit migration.",
        { canonical_root: root, config_byte_sha256: current.byte_sha256 },
      );
    }
    if (
      candidate.legacy_input === undefined
      || candidate.legacy_input.path !== legacy.path
      || candidate.legacy_input.byte_sha256 !== legacy.byte_sha256
      || !sameTargetFingerprint(candidate.legacy_input.fingerprint, legacy.fingerprint)
    ) {
      return failed(
        "IDENTITY_MISMATCH",
        operation,
        "The explicit legacy input changed after the dry-run proposal; obtain a new migration proposal.",
        {
          canonical_root: root,
          path: legacy.path,
          expected_digest: candidate.legacy_input?.byte_sha256 ?? null,
          actual_digest: legacy.byte_sha256,
        },
      );
    }
  } else if (!current && !missingPolicy(context.policy)) {
    return failureResult(context.policy.diagnostics);
  }
  if (candidate.operation === "migrate" && !legacy) {
    return failed(
      "MIGRATION_REQUIRED",
      operation,
      "A validated v1 migration source is required before apply.",
      { canonical_root: root },
    );
  }
  if (candidate.expected.state === "absent") {
    if (current) {
      return failed(
        "IDENTITY_MISMATCH",
        operation,
        "A policy appeared after the absent-policy proposal; obtain a new proposal.",
        { canonical_root: root, actual_digest: current.byte_sha256 },
      );
    }
    if (
      candidate.expected.canonical_root !== root
      || candidate.expected.worktree_id !== manager.worktree_id
      || candidate.expected.session_id !== manager.session.session_id
      || candidate.expected.policy_path !== policyPath(root)
      || parentIdentity !== candidate.expected.parent_path_identity
    ) {
      return failed(
        "IDENTITY_MISMATCH",
        operation,
        "The policy parent, canonical root, worktree, or session changed after proposal creation; obtain a new proposal.",
        {
          canonical_root: root,
          policy_path: policyPath(root),
          expected_parent_identity: candidate.expected.parent_path_identity,
          actual_parent_identity: parentIdentity,
        },
      );
    }
  } else {
    const currentTarget = targetRead(authority, pinned.ompDirectory, "team.config.json", TRANSACTION_MAX_BYTES, operation, root);
    if (!currentTarget.ok) return currentTarget;
    if (!current || !policyMatchesExpected(current, candidate.expected, currentTarget.value.fingerprint)) {
      return failed(
        "IDENTITY_MISMATCH",
        operation,
        "The policy bytes, provider identity, semantic hash, path, or project identity changed after proposal creation; obtain a new proposal.",
        {
          canonical_root: root,
          expected_digest: candidate.expected.semantic_hash,
          actual_digest: current?.semantic_sha256 ?? null,
        },
      );
    }
    if (
      candidate.expected.project_identity.root_instance_id !== manager.worktree_id
      || !fieldsEqual(candidate.expected.project_identity.session, manager.session)
    ) {
      return failed(
        "IDENTITY_MISMATCH",
        operation,
        "The trusted worktree or session differs from the present-policy proposal; obtain a new proposal.",
        {
          canonical_root: root,
          expected_digest: candidate.expected.project_identity.root_instance_id,
          actual_digest: manager.worktree_id,
        },
      );
    }
  }
  if (!current && !missingPolicy(context.policy) && candidate.operation !== "migrate") {
    return failureResult(context.policy.diagnostics);
  }
  const rootId = rootInstance(root, context.binding.snapshot, manager);
  if (!rootId.ok) return failureResult(rootId.diagnostics);
  if (rootId.value !== manager.worktree_id) {
    return failed(
      "IDENTITY_MISMATCH",
      operation,
      "The trusted worktree identity changed before the transaction write; obtain a new proposal.",
      { canonical_root: root, expected_digest: manager.worktree_id, actual_digest: rootId.value },
    );
  }
  if (candidate.expected.state === "absent") {
    const bindingEntry = authority.inspect(pinned.ompDirectory, "team.config.binding.json");
    if (!bindingEntry.ok) return authorityFailure(bindingEntry, operation, "Inspect the root-local binding through the trusted descriptor-relative authority.", {
      canonical_root: root,
      binding_path: bindingPath(root),
    });
    if (context.binding.snapshot || bindingEntry.value !== null) {
      return failed(
        "IDENTITY_MISMATCH",
        operation,
        "A root-local binding appeared after the absent-policy proposal; automatic rebind is forbidden.",
        {
          canonical_root: root,
          binding_path: bindingPath(root),
          actual_digest: context.binding.snapshot?.byte_sha256 ?? null,
        },
      );
    }
  } else if (!context.binding.snapshot) {
    return failureResult(context.binding.diagnostics.length > 0
      ? context.binding.diagnostics
      : [diag(
        "BINDING_REQUIRED",
        operation,
        "The root-local binding is required and must match the present-policy proposal preconditions.",
        { canonical_root: root, binding_path: bindingPath(root) },
      )]);
  } else if (!bindingMatchesExpected(context.binding.snapshot, candidate.expected, manager.worktree_id)) {
    return failed(
      "IDENTITY_MISMATCH",
      operation,
      "The root binding changed after proposal creation; obtain a new root-bound proposal.",
      {
        canonical_root: root,
        expected_digest: candidate.expected.project_identity.root_instance_id,
        actual_digest: context.binding.snapshot.document.project_worktree_instance,
      },
    );
  }
  if (current && current.document.provider.id !== candidate.provider.id) {
    return failed(
      "TRANSITION_REQUIRED",
      operation,
      "A different provider cannot merge into the claimed root; restart with an explicit fresh lifecycle.",
      {
        canonical_root: root,
        provider_id: candidate.provider.id,
        expected_digest: current.document.provider.descriptor_fingerprint,
        actual_digest: candidate.provider.descriptor_fingerprint,
      },
    );
  }
  if (!current && context.binding.snapshot && context.binding.snapshot.document.last_validated.provider_id !== candidate.provider.id) {
    return failed(
      "TRANSITION_REQUIRED",
      operation,
      "A different provider cannot rebind the claimed root; restart with an explicit fresh lifecycle.",
      {
        canonical_root: root,
        provider_id: candidate.provider.id,
        expected_digest: context.binding.snapshot.document.last_validated.descriptor_fingerprint,
        actual_digest: candidate.provider.descriptor_fingerprint,
      },
    );
  }
  const provider = providerFor(candidate.provider.id, registry);
  if (!provider.ok) return failureResult(augmentDiagnostics(provider.diagnostics, contextEvidence(root, context)));
  if (
    provider.value.descriptor_fingerprint !== candidate.provider.descriptor_fingerprint
    || provider.value.catalog.content_digest !== candidate.provider.catalog_content_digest
  ) {
    return failed(
      "IDENTITY_MISMATCH",
      operation,
      "The immutable provider descriptor or catalog changed after proposal creation; obtain a new proposal.",
      {
        provider_id: candidate.provider.id,
        expected_digest: candidate.provider.descriptor_fingerprint,
        actual_digest: provider.value.descriptor_fingerprint,
      },
    );
  }
  if (
    candidate.next_policy.schema_version !== 2
    || !providerRefValid(candidate.next_policy.provider)
    || candidate.next_policy.provider.id !== candidate.provider.id
    || candidate.next_policy.provider.descriptor_fingerprint !== candidate.provider.descriptor_fingerprint
    || candidate.next_policy.provider.catalog_content_digest !== candidate.provider.catalog_content_digest
  ) {
    return failed(
      "IDENTITY_MISMATCH",
      operation,
      "The proposal policy must name the exact immutable provider descriptor and catalog.",
      { provider_id: candidate.provider.id },
    );
  }
  const capability = capabilities(provider.value, candidate.next_policy.policy.required_capabilities, operation);
  if (!capability.ok) return failureResult(capability.diagnostics);
  const merged = validatePolicyIdentity(provider.value, candidate.next_policy, operation);
  if (!merged.ok) return failureResult(merged.diagnostics);
  const diagnostics = dedupeDiagnostics([
    ...context.policy.diagnostics.filter((entry) => entry.code !== "CONFIG_MISSING"),
    ...context.binding.diagnostics.filter((entry) => entry.code !== "BINDING_REQUIRED"),
    ...capability.diagnostics,
  ]);
  return successResult(Object.freeze({
    candidate,
    current,
    binding: context.binding.snapshot,
    root_instance_id: rootId.value,
    manager,
    provider: provider.value,
    merged,
    diagnostics,
    legacy,
  }));
}

function applyProposal(
  root: CanonicalRoot,
  manager: TrustedManagementContext,
  request: ProviderApplyRequest,
  registry: ProviderRegistry,
  lock: TransactionLock,
): ProviderManagementResult {
  if (request.dry_run !== undefined && request.dry_run !== false) {
    return failed(
      "CONFIG_MALFORMED",
      "management.apply",
      "Apply does not support --dry-run; obtain a proposal through a proposal-producing management operation.",
      { canonical_root: root },
    );
  }
  const prepared = prepareApply(root, manager, request, registry, lock.pinned, lock.parent_identity);
  if (!prepared.ok) return failureResult(prepared.diagnostics);
  return applyTransaction(root, prepared.value, lock);
}

export async function manageProvider(
  context: TrustedManagementContext,
  request: ProviderManagementRequest,
  registry: ProviderRegistry,
): Promise<ProviderManagementResult> {
  const operation = opFor(record(request) ? request.operation : undefined);
  if (!context || typeof context !== "object" || !request || typeof request !== "object") {
    return failed(
      "CONFIG_MALFORMED",
      operation,
      "Provide one trusted management context and one typed provider management request.",
    );
  }
  const forbiddenContextOverrides = [
    "root",
    "canonical_root",
    "worktree_id",
    "session",
    "session_id",
    "policy_path",
    "parent_path_identity",
    "policy_file_identity",
    "expected_exclusive_create",
  ] as const;
  if (forbiddenContextOverrides.some((key) => Object.prototype.hasOwnProperty.call(request, key))) {
    return failed(
      "CONFIG_MALFORMED",
      operation,
      "Management requests carry intent only; root, session, path and identity context are manager-owned.",
    );
  }
  if (
    Object.prototype.hasOwnProperty.call(request, "force")
    || Object.prototype.hasOwnProperty.call(request, "overwrite")
    || Object.prototype.hasOwnProperty.call(request, "rebind")
  ) {
    return failed(
      "CONFIG_MALFORMED",
      operation,
      "Destructive --force, --overwrite and --rebind controls are forbidden in workflow-v2 management.",
    );
  }
  const root = rootFor(context);
  if (!root.ok) return root;
  const authority = managerAuthority(context);
  if (!authority) {
    return failed(
      "ACTIVATION_FAILED",
      operation,
      "Provide a factory-issued trusted descriptor-relative filesystem authority before provider management.",
      { canonical_root: root.value, reason: context.filesystem_authority === undefined ? "missing" : "foreign" },
    );
  }
  if (request.operation === "list") return listFor(root.value, context, request, registry);
  if (request.operation === "status") return statusFor(root.value, context, request, registry);
  if (request.operation === "select") return selectFor(root.value, context, request, registry);
  if (request.operation === "refresh") return refreshFor(root.value, context, request, registry);
  if (request.operation === "migrate") return migrateFor(root.value, context, request, registry);
  if (request.operation === "create" && request.dry_run === true) {
    return createFor(root.value, context, request, registry);
  }
  if (request.operation === "apply") {
    const validated = validateApplyRequest(root.value, request);
    if (!validated.ok) return failureResult(validated.diagnostics);
  } else if (request.operation !== "create") {
    return failed(
      "CONFIG_MALFORMED",
      operation,
      "Use one of the canonical v2 provider management operations.",
      { canonical_root: root.value },
    );
  }
  const lock = acquireTransactionLock(root.value, authority);
  if (!lock.ok) return failureResult(lock.diagnostics);
  try {
    const journal = readTransactionJournal(root.value, authority, lock.value.pinned);
    if (!journal.ok) return failureResult(journal.diagnostics);
    if (journal.value !== null) {
      return failed(
        "TRANSACTION_INCOMPLETE",
        operation,
        "An incomplete transaction requires an explicit trusted recovery boundary; repository journal bytes cannot authorize recovery.",
        {
          canonical_root: root.value,
          journal_path: transactionJournalPath(root.value),
          transaction_id: journal.value.transaction_id,
          phase: journal.value.phase,
        },
      );
    }
    if (request.operation === "create") {
      return createFor(root.value, context, request, registry, lock.value);
    }
    return applyProposal(root.value, context, request, registry, lock.value);
  } finally {
    lock.value.release();
  }
}

function rootFor(context: TrustedManagementContext): DiagnosticResult<CanonicalRoot> {
  const raw = context.root?.canonical_root;
  const root = typeof raw === "string" ? createCanonicalRoot(raw) : undefined;
  if (
    !root
    || !isCanonicalRoot(root)
    || !isWorkflowV2Digest(context.worktree_id)
    || !record(context.session)
    || typeof context.session.session_id !== "string"
    || !safeLegacyKey(context.session.session_id)
    || typeof context.session.lifecycle_id !== "string"
    || !safeLegacyKey(context.session.lifecycle_id)
  ) {
    return failed(
      "ROOT_UNAVAILABLE",
      "root.resolve",
      "Resolve one manager-owned physical project root, worktree identity and session before provider management.",
      { canonical_root: typeof raw === "string" ? raw : null },
    );
  }
  return successResult(root);
}

function tokenize(args: string): readonly string[] {
  if (typeof args !== "string") throw new TypeError("provider management arguments must be a string");
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaped = false;
  let started = false;
  let pendingProposalValue = false;
  let proposalMode = false;
  let proposalValueStarted = false;
  let proposalQuote: "'" | '"' | null = null;
  let proposalQuoteEscaped = false;
  let proposalDepth = 0;
  let proposalInString = false;
  let proposalStringEscaped = false;
  for (const character of args.trim()) {
    const whitespace = /\s/u.test(character);
    if (
      quote === null
      && !escaped
      && !proposalMode
      && !whitespace
      && ((pendingProposalValue && !started) || current === "--proposal=")
    ) {
      proposalMode = true;
      pendingProposalValue = false;
      proposalValueStarted = false;
      proposalQuote = null;
      proposalQuoteEscaped = false;
      proposalDepth = 0;
      proposalInString = false;
      proposalStringEscaped = false;
    }

    if (proposalMode) {
      if (!proposalValueStarted) {
        proposalValueStarted = true;
        started = true;
        if (character === "'" || character === '"') {
          proposalQuote = character;
          continue;
        }
      }
      if (proposalQuote !== null) {
        if (proposalQuote === '"') {
          if (proposalQuoteEscaped) {
            current += character;
            proposalQuoteEscaped = false;
            continue;
          }
          if (character === "\\") {
            proposalQuoteEscaped = true;
            continue;
          }
        }
        if (character === proposalQuote) {
          proposalQuote = null;
          continue;
        }
        current += character;
        started = true;
        continue;
      }
      if (proposalInString) {
        current += character;
        if (proposalStringEscaped) proposalStringEscaped = false;
        else if (character === "\\") proposalStringEscaped = true;
        else if (character === '"') proposalInString = false;
        started = true;
        continue;
      }
      if (character === '"') {
        current += character;
        proposalInString = true;
        started = true;
        continue;
      }
      if (character === "{" || character === "[") {
        current += character;
        proposalDepth += 1;
        started = true;
        continue;
      }
      if (character === "}" || character === "]") {
        current += character;
        if (proposalDepth > 0) proposalDepth -= 1;
        started = true;
        continue;
      }
      if (whitespace && proposalDepth === 0) {
        tokens.push(current);
        current = "";
        started = false;
        proposalMode = false;
        proposalValueStarted = false;
        proposalQuote = null;
        proposalQuoteEscaped = false;
        proposalDepth = 0;
        proposalInString = false;
        proposalStringEscaped = false;
        continue;
      }
      current += character;
      started = true;
      continue;
    }

    if (escaped) {
      current += character;
      escaped = false;
      started = true;
    } else if (character === "\\" && quote !== "'") {
      escaped = true;
      started = true;
    } else if (quote !== null) {
      if (character === quote) quote = null;
      else current += character;
      started = true;
    } else if (character === "'" || character === '"') {
      quote = character;
      started = true;
    } else if (whitespace) {
      if (started) {
        tokens.push(current);
        pendingProposalValue = current === "--proposal";
        current = "";
        started = false;
      }
    } else {
      current += character;
      started = true;
    }
  }
  if (escaped || quote !== null || proposalQuote !== null || proposalQuoteEscaped) {
    throw new TypeError("unterminated provider management argument");
  }
  if (started) tokens.push(current);
  return Object.freeze(tokens);
}

function optionName(token: string): string {
  const separator = token.indexOf("=");
  return separator < 0 ? token : token.slice(0, separator);
}

function optionValue(tokens: readonly string[], name: string): string | undefined {
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === undefined) continue;
    if (token === name) {
      const value = tokens[index + 1];
      if (value === undefined || value.startsWith("--")) throw new TypeError(`${name} requires a value`);
      return value;
    }
    if (token.startsWith(`${name}=`)) {
      const value = token.slice(name.length + 1);
      if (value.length === 0) throw new TypeError(`${name} requires a value`);
      return value;
    }
  }
  return undefined;
}

function hasOption(tokens: readonly string[], name: string): boolean {
  return tokens.includes(name);
}

function validateOptionSyntax(tokens: readonly string[], valueOptions: readonly string[]): void {
  const values = new Set(valueOptions);
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === undefined) throw new TypeError("unexpected provider management argument");
    if (!token.startsWith("--")) throw new TypeError(`unexpected provider management argument: ${token}`);
    const name = optionName(token);
    if (token.includes("=")) {
      if (!values.has(name)) throw new TypeError(`${name} does not accept a value`);
      if (token.slice(token.indexOf("=") + 1).length === 0) throw new TypeError(`${name} requires a value`);
      continue;
    }
    if (values.has(name)) {
      const value = tokens[index + 1];
      if (value === undefined || value.startsWith("--")) throw new TypeError(`${name} requires a value`);
      index += 1;
    }
  }
}

function ensure(tokens: readonly string[], allowed: readonly string[]): void {
  const allowedSet = new Set(allowed);
  const seen = new Set<string>();
  for (const token of tokens) {
    if (!token.startsWith("--")) continue;
    const name = optionName(token);
    if (name === "--force" || name === "--overwrite" || name === "--rebind") {
      throw new TypeError("destructive provider management flags are forbidden");
    }
    if (!allowedSet.has(name)) throw new TypeError(`unknown provider management flag: ${name}`);
    if (seen.has(name)) throw new TypeError(`duplicate provider management flag: ${name}`);
    seen.add(name);
  }
}

function parseProvider(tokens: readonly string[]): ProviderId {
  const value = optionValue(tokens, "--provider");
  const provider = value === undefined ? undefined : createProviderId(value);
  if (!provider) throw new TypeError("--provider requires an exact lowercase package-qualified provider id");
  return provider;
}

export function parseProviderManagementArgs(
  args: string,
  command: "workflow-provider" | "init-team",
): ProviderManagementRequest {
  const tokens = tokenize(args);
  const operation = tokens[0];
  const options = tokens.slice(1);
  if (!operation) throw new TypeError("provider management operation is required");
  if (command === "workflow-provider" && !["list", "status", "select"].includes(operation)) {
    throw new TypeError("workflow-provider accepts list, status or select");
  }
  if (command === "init-team" && !["create", "refresh", "migrate", "apply"].includes(operation)) {
    throw new TypeError("init-team accepts create, refresh, migrate or apply");
  }
  const dryRun = hasOption(options, "--dry-run");
  const confirm = hasOption(options, "--confirm-root");
  if (operation === "list") {
    ensure(options, ["--dry-run"]);
    validateOptionSyntax(options, ["--provider", "--proposal", "--proposal-digest"]);
    return { operation: "list", ...(dryRun ? { dry_run: true } : {}) };
  }
  if (operation === "status") {
    ensure(options, ["--dry-run"]);
    validateOptionSyntax(options, ["--provider", "--proposal", "--proposal-digest"]);
    return { operation: "status", ...(dryRun ? { dry_run: true } : {}) };
  }
  if (operation === "select") {
    ensure(options, ["--provider", "--confirm-root", "--dry-run"]);
    validateOptionSyntax(options, ["--provider", "--proposal", "--proposal-digest"]);
    return {
      operation: "select",
      provider_id: parseProvider(options),
      ...(confirm ? { confirm_root: true } : {}),
      ...(dryRun ? { dry_run: true } : {}),
    };
  }
  if (operation === "create") {
    ensure(options, ["--provider", "--confirm-root", "--dry-run"]);
    validateOptionSyntax(options, ["--provider", "--proposal", "--proposal-digest"]);
    if (!confirm) throw new TypeError("create requires --confirm-root");
    return {
      operation: "create",
      provider_id: parseProvider(options),
      confirm_root: true,
      ...(dryRun ? { dry_run: true } : {}),
    };
  }
  if (operation === "refresh") {
    ensure(options, ["--provider", "--dry-run"]);
    validateOptionSyntax(options, ["--provider", "--proposal", "--proposal-digest"]);
    return {
      operation: "refresh",
      ...(optionValue(options, "--provider") === undefined ? {} : { provider_id: parseProvider(options) }),
      ...(dryRun ? { dry_run: true } : {}),
    };
  }
  if (operation === "migrate") {
    ensure(options, ["--provider", "--confirm-root", "--dry-run"]);
    validateOptionSyntax(options, ["--provider", "--proposal", "--proposal-digest"]);
    if (!dryRun) throw new TypeError("migrate requires --dry-run");
    return {
      operation: "migrate",
      provider_id: parseProvider(options),
      ...(confirm ? { confirm_root: true } : {}),
      dry_run: true,
    };
  }
  if (dryRun) throw new TypeError("apply does not support --dry-run");
  ensure(options, ["--proposal", "--proposal-digest", "--confirm-root"]);
  validateOptionSyntax(options, ["--provider", "--proposal", "--proposal-digest"]);
  if (!confirm) throw new TypeError("apply requires --confirm-root");
  const proposal = optionValue(options, "--proposal");
  const digest = optionValue(options, "--proposal-digest");
  if (proposal === undefined || digest === undefined || !isWorkflowV2Digest(digest)) {
    throw new TypeError("apply requires --proposal and --proposal-digest");
  }
  let decoded: unknown;
  try {
    decoded = parseStrictJsonValue(proposal);
  } catch {
    throw new TypeError("--proposal must contain valid JSON");
  }
  if (!proposalShapeValid(decoded)) {
    throw new TypeError("--proposal must contain one complete management proposal");
  }
  const request: ProviderApplyRequest = {
    operation: "apply",
    proposal: decoded,
    proposal_digest: digest,
    confirm_root: true,
    expected: decoded.expected,
  };
  return request;
}
