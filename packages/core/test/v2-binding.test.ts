/* <!-- omp-cto-slice run=01a03ee4-7dd6-7580-8ad7-16d26dc886ba slice=workflow-v2-core --> */
import assert from "node:assert/strict";
import test from "node:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BINDING_RELATIVE_PATH,
  buildBindingDocument,
  bindingFilePath,
  readBindingSnapshot,
  readRootEvidence,
  writeBindingAfterConfirmation,
} from "../src/workflow-v2/binding.js";
import { canonicalPolicyJson } from "../src/workflow-v2/policy.js";
import { setTransactionReadHookForTests, transactionJournalPath, type TransactionJournal } from "../src/workflow-v2/transaction.js";
import {
  buildProjectIdentity,
  buildProjectWorktreeInstanceId,
  buildWorkflowRunIdentity,
  createCanonicalRoot,
  projectRuntimeKeyFor,
  validateProjectIdentity,
  validateWorkflowRunIdentity,
} from "../src/workflow-v2/identity.js";
import { ctoStateDir } from "../src/cto/state.js";
import {
  createDescriptorRelativeFsAuthority,
  createTestDescriptorRelativeFsAuthority,
} from "../src/workflow-v2/fs-authority.js";
import type { DescriptorRelativeNativeBackend, TrustedFsAuthority } from "../src/workflow-v2/fs-authority.js";
import type {
  BindingSnapshot,
  BindingValidatedIdentity,
  CanonicalRoot,
  PathIdentity,
  PolicyPrecondition,
  ProjectIdentity,
  ProjectIdentityInput,
  ProviderId,
  WorkflowV2Digest,
} from "../src/workflow-v2/types.js";


const providerId = "@example/workflow-provider" as ProviderId;
const descriptorFingerprint = `sha256:${"b".repeat(64)}` as WorkflowV2Digest;
const buildFingerprint = `sha256:${"c".repeat(64)}` as WorkflowV2Digest;
const runtimeFingerprint = `sha256:${"d".repeat(64)}` as WorkflowV2Digest;
const catalogDigest = `sha256:${"e".repeat(64)}` as WorkflowV2Digest;
const configByteDigest = `sha256:${"f".repeat(64)}` as WorkflowV2Digest;
const configSemanticDigest = `sha256:${"a".repeat(64)}` as WorkflowV2Digest;
const profileFingerprint = `sha256:${"1".repeat(64)}` as WorkflowV2Digest;
const alternateProfileFingerprint = `sha256:${"2".repeat(64)}` as WorkflowV2Digest;
function rootFor(prefix: string, withOmp = true): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  if (withOmp) mkdirSync(join(root, ".omp"), { recursive: true });
  mkdirSync(join(root, ".git"), { recursive: true });
  return root;
}

function canonicalRoot(root: string): CanonicalRoot {
  const value = createCanonicalRoot(root);
  assert.ok(value, "test roots are canonical absolute roots");
  return value;
}
function authorityWithoutRootOnly(full: TrustedFsAuthority): TrustedFsAuthority {
  const native: DescriptorRelativeNativeBackend = {
    platform: full.platform,
    supportsAtomicCas: full.supportsAtomicCas,
    openRoot: full.openRoot,
    readBounded: full.readBounded,
    inspect: full.inspect,
    openDirectory: full.openDirectory,
    createTemporary: full.createTemporary,
    removeTemporary: full.removeTemporary,
    fsyncDirectory: full.fsyncDirectory,
    atomicReplaceIfCurrent: full.atomicReplaceIfCurrent,
    atomicRemoveIfCurrent: full.atomicRemoveIfCurrent,
  };
  return createDescriptorRelativeFsAuthority({ native });
}

function validTransactionJournal(root: CanonicalRoot): TransactionJournal {
  return {
    version: 2,
    transaction_id: "00000000-0000-0000-0000-000000000001",
    canonical_root: root,
    policy_path: join(root, ".omp", "team.config.json"),
    binding_path: join(root, ".omp", "team.config.binding.json"),
    phase: "prepared",
    old_policy: { state: "absent", image: { kind: "none" } },
    old_binding: { state: "absent", image: { kind: "none" } },
    new_policy: { state: "absent" },
    new_binding: { state: "absent" },
  };
}


function validatedIdentity(overrides: Partial<BindingValidatedIdentity> = {}): BindingValidatedIdentity {
  return Object.freeze({
    provider_id: providerId,
    descriptor_fingerprint: descriptorFingerprint,
    executable_provenance: Object.freeze({
      build_fingerprint: buildFingerprint,
      runtime_fingerprint: runtimeFingerprint,
    }),
    catalog_content_digest: catalogDigest,
    config_byte_sha256: configByteDigest,
    config_semantic_sha256: configSemanticDigest,
    session: Object.freeze({ session_id: "test-session", lifecycle_id: "test-lifecycle" }),
    ...overrides,
  });
}

function documentFor(root: CanonicalRoot, filesystemAuthority: TrustedFsAuthority, overrides: Partial<BindingValidatedIdentity> = {}) {
  const result = buildBindingDocument(root, validatedIdentity(overrides), filesystemAuthority);
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("test binding document should be buildable");
  return result.value;
}

function projectIdentityFor(snapshot: BindingSnapshot): ProjectIdentity {
  const validated = snapshot.document.last_validated;
  const result = buildProjectIdentity({
    root_instance_id: snapshot.document.project_worktree_instance,
    provider_id: validated.provider_id,
    descriptor_fingerprint: validated.descriptor_fingerprint,
    executable_provenance: validated.executable_provenance,
    catalog_content_digest: validated.catalog_content_digest,
    config_byte_sha256: validated.config_byte_sha256,
    config_semantic_sha256: validated.config_semantic_sha256,
    session: validated.session,
  });
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("test project identity should be buildable");
  return result.value;
}

function absentPrecondition(root: CanonicalRoot, document: BindingSnapshot["document"]): PolicyPrecondition {
  return Object.freeze({
    state: "absent",
    canonical_root: root,
    worktree_id: document.project_worktree_instance,
    session_id: document.last_validated.session.session_id,
    policy_path: join(root, ".omp", "team.config.json"),
    parent_path_identity: "parent:identity" as PathIdentity,
    expected_exclusive_create: true,
  });
}

function presentPrecondition(snapshot: BindingSnapshot): PolicyPrecondition {
  const project_identity = projectIdentityFor(snapshot);
  return Object.freeze({
    state: "present",
    project_identity,
    policy_path: join(snapshot.root, ".omp", "team.config.json"),
    policy_file_identity: "policy:file:identity" as PathIdentity,
    raw_hash: project_identity.config_byte_sha256,
    semantic_hash: project_identity.config_semantic_sha256,
  });
}

function projectInput(overrides: Partial<ProjectIdentityInput> = {}): ProjectIdentityInput {
  return {
    root_instance_id: `sha256:${"0".repeat(64)}` as WorkflowV2Digest,
    provider_id: providerId,
    descriptor_fingerprint: descriptorFingerprint,
    executable_provenance: { build_fingerprint: buildFingerprint, runtime_fingerprint: runtimeFingerprint },
    catalog_content_digest: catalogDigest,
    config_byte_sha256: configByteDigest,
    config_semantic_sha256: configSemanticDigest,
    session: { session_id: "identity-session", lifecycle_id: "identity-lifecycle" },
    ...overrides,
  };
}

function assertFailure(result: { readonly ok: boolean; readonly diagnostics: readonly { readonly code: string }[] }, code: string): void {
  assert.equal(result.ok, false);
  if (!result.ok) assert.ok(result.diagnostics.some((diagnostic) => diagnostic.code === code), `expected diagnostic ${code}`);
}

test("builds profile-free project identity and required run identity", () => {
  const projectResult = buildProjectIdentity(projectInput());
  assert.equal(projectResult.ok, true);
  if (!projectResult.ok) return;
  const project = projectResult.value;
  assert.equal(Object.isFrozen(project), true);
  assert.equal(Object.isFrozen(project.executable_provenance), true);
  assert.equal(Object.isFrozen(project.session), true);
  assert.equal("profile_identity" in project, false);
  assert.equal("run_id" in project, false);

  const firstRun = buildWorkflowRunIdentity({
    project_identity: project,
    run_id: "run-one",
    profile_identity: { id: "lightweight", fingerprint: profileFingerprint },
  });
  const secondRun = buildWorkflowRunIdentity({
    project_identity: project,
    run_id: "run-two",
    profile_identity: { id: "standard", fingerprint: alternateProfileFingerprint },
  });
  assert.equal(firstRun.ok, true);
  assert.equal(secondRun.ok, true);
  if (!firstRun.ok || !secondRun.ok) return;
  assert.equal(projectRuntimeKeyFor(project), projectRuntimeKeyFor(firstRun.value));
  assert.equal(projectRuntimeKeyFor(firstRun.value), projectRuntimeKeyFor(secondRun.value));
  assert.equal(firstRun.value.profile_identity.id, "lightweight");
  assert.equal(secondRun.value.profile_identity.id, "standard");
  assert.equal(Object.isFrozen(firstRun.value.profile_identity), true);
});

test("rejects malformed or cross-level identities", () => {
  const projectResult = buildProjectIdentity(projectInput());
  assert.equal(projectResult.ok, true);
  if (!projectResult.ok) return;
  const project = projectResult.value;

  assertFailure(validateProjectIdentity({ ...project, run_id: "unexpected-run" }), "IDENTITY_MISMATCH");
  assertFailure(validateProjectIdentity({ ...project, profile_identity: { id: "lightweight", fingerprint: profileFingerprint } }), "IDENTITY_MISMATCH");
  assertFailure(buildProjectIdentity({ ...projectInput(), executable_provenance: { build_fingerprint: buildFingerprint } as never }), "IDENTITY_MISMATCH");

  const runResult = buildWorkflowRunIdentity({
    project_identity: project,
    run_id: "run-one",
    profile_identity: { id: "lightweight", fingerprint: profileFingerprint },
  });
  assert.equal(runResult.ok, true);
  if (!runResult.ok) return;
  assertFailure(validateWorkflowRunIdentity({ ...runResult.value, run_id: "" }), "IDENTITY_MISMATCH");
  assertFailure(validateWorkflowRunIdentity({ ...runResult.value, profile_identity: null }), "IDENTITY_MISMATCH");
  assertFailure(validateWorkflowRunIdentity({ ...runResult.value, provider_id: "@Other/provider" }), "IDENTITY_MISMATCH");
});

test("run identity rejects unsafe IDs and enforces the exact 128-character path-safe bound", () => {
  const projectResult = buildProjectIdentity(projectInput());
  assert.equal(projectResult.ok, true);
  if (!projectResult.ok) return;

  const identityInput = {
    project_identity: projectResult.value,
    profile_identity: { id: "lightweight", fingerprint: profileFingerprint },
  };
  const boundaryRunId = "r".repeat(128);
  const oversizedRunId = "r".repeat(129);

  const boundary = buildWorkflowRunIdentity({ ...identityInput, run_id: boundaryRunId });
  assert.equal(boundary.ok, true, "128 ASCII characters are valid");
  if (!boundary.ok) return;
  assert.equal(boundary.value.run_id, boundaryRunId, "accepted IDs are retained verbatim");
  assertFailure(buildWorkflowRunIdentity({ ...identityInput, run_id: oversizedRunId }), "IDENTITY_MISMATCH");
  assertFailure(validateWorkflowRunIdentity({ ...boundary.value, run_id: oversizedRunId }), "IDENTITY_MISMATCH");
  assertFailure(buildWorkflowRunIdentity({ ...identityInput, run_id: "run/id" }), "IDENTITY_MISMATCH");
  assertFailure(buildWorkflowRunIdentity({ ...identityInput, run_id: "run id" }), "IDENTITY_MISMATCH");
  assertFailure(buildWorkflowRunIdentity({ ...identityInput, run_id: "run-µ" }), "IDENTITY_MISMATCH");

  const root = rootFor("v2-run-id-bound-");
  try {
    assert.equal(ctoStateDir(boundaryRunId, root), join(root, ".work-state", "cto", boundaryRunId));
    assert.throws(() => ctoStateDir(oversizedRunId, root), /unsafe CTO run id/);
    assert.throws(() => ctoStateDir("run/id", root), /unsafe CTO run id/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("binds stable root and git device-inode evidence to one lifecycle nonce", () => {
  const root = rootFor("v2-binding-evidence-", false);
  try {
    const canonical = canonicalRoot(root);
    const filesystemAuthority = createTestDescriptorRelativeFsAuthority();
    const first = readRootEvidence(canonical, filesystemAuthority);
    const second = readRootEvidence(canonical, filesystemAuthority);
    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    if (!first.ok || !second.ok) return;
    assert.equal(first.value.canonical_root, canonical);
    assert.equal(first.value.root_device, second.value.root_device);
    assert.equal(first.value.root_inode, second.value.root_inode);
    assert.equal(first.value.git_device, second.value.git_device);
    assert.equal(first.value.git_inode, second.value.git_inode);
    assert.equal(first.value.root_instance_nonce, second.value.root_instance_nonce);
    assert.equal(buildProjectWorktreeInstanceId(first.value), buildProjectWorktreeInstanceId(second.value));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("uses required openRoot for existing .omp even without the optional root-only seam", () => {
  const root = rootFor("v2-binding-open-root-only-");
  try {
    const canonical = canonicalRoot(root);
    const full = createTestDescriptorRelativeFsAuthority();
    const authority = authorityWithoutRootOnly(full);
    const evidence = readRootEvidence(canonical, authority);
    assert.equal(evidence.ok, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fails closed for an .omp-missing root when root-only pin is unavailable", () => {
  const root = rootFor("v2-binding-open-root-missing-", false);
  try {
    const canonical = canonicalRoot(root);
    const full = createTestDescriptorRelativeFsAuthority();
    const authority = authorityWithoutRootOnly(full);
    assertFailure(readRootEvidence(canonical, authority), "ROOT_UNAVAILABLE");
    assert.equal(existsSync(join(root, ".omp")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("writes and rereads a canonical sidecar only after explicit root confirmation", () => {
  const root = rootFor("v2-binding-write-");
  try {
    const canonical = canonicalRoot(root);
    const filesystemAuthority = createTestDescriptorRelativeFsAuthority();
    const document = documentFor(canonical, filesystemAuthority);
    const path = bindingFilePath(canonical);
    const first = writeBindingAfterConfirmation({
      root: canonical,
      document,
      confirm_root: true,
      expected: absentPrecondition(canonical, document),
    }, filesystemAuthority);
    assert.equal(first.ok, true);
    assert.equal(existsSync(path), true);
    assert.equal(path, join(root, BINDING_RELATIVE_PATH));
    if (!first.ok) return;

    const reread = readBindingSnapshot(canonical, filesystemAuthority);
    assert.equal(reread.ok, true);
    if (!reread.ok) return;
    assert.deepEqual(reread.value.document, document);
    assert.equal(reread.value.byte_sha256, first.value.byte_sha256);
    assert.equal(readFileSync(path, "utf8").endsWith("\n"), true);
    assert.equal("profile_identity" in reread.value.document.last_validated, false);

    const noConfirmation = writeBindingAfterConfirmation({ root: canonical, document, confirm_root: false as true }, filesystemAuthority);
    assertFailure(noConfirmation, "BINDING_REQUIRED");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("blocks binding reads while a workflow-v2 transaction marker is present", () => {
  const root = rootFor("v2-binding-transaction-");
  const outside = mkdtempSync(join(tmpdir(), "v2-binding-transaction-outside-"));
  try {
    const canonical = canonicalRoot(root);
    const filesystemAuthority = createTestDescriptorRelativeFsAuthority();
    const document = documentFor(canonical, filesystemAuthority);
    const path = bindingFilePath(canonical);
    const created = writeBindingAfterConfirmation({
      root: canonical,
      document,
      confirm_root: true,
      expected: absentPrecondition(canonical, document),
    }, filesystemAuthority);
    assert.equal(created.ok, true);
    if (!created.ok) return;

    const marker = transactionJournalPath(canonical);
    const legacy = {
      version: 1,
      canonical_root: canonical,
      policy_path: join(root, ".omp", "team.config.json"),
      binding_path: path,
      old_policy_base64: null,
      old_binding_base64: null,
    };
    const assertBlocked = (status: string) => {
      const result = readBindingSnapshot(canonical, filesystemAuthority);
      assertFailure(result, "TRANSACTION_INCOMPLETE");
      if (result.ok) return;
      const diagnostic = result.diagnostics.find(({ code }) => code === "TRANSACTION_INCOMPLETE");
      assert.ok(diagnostic);
      if (!diagnostic) return;
      assert.equal(diagnostic.evidence.path, marker);
      assert.equal(diagnostic.evidence.status, status);
    };

    writeFileSync(marker, `${canonicalPolicyJson(validTransactionJournal(canonical))}\n`);
    assertBlocked("incomplete");

    writeFileSync(marker, `${JSON.stringify(legacy)}\n`);
    assertBlocked("malformed");

    writeFileSync(marker, '{"version":1}\n');
    assertBlocked("malformed");

    const outsideMarker = join(outside, "transaction.json");
    writeFileSync(outsideMarker, `${JSON.stringify(legacy)}\n`);
    rmSync(marker, { force: true });
    symlinkSync(outsideMarker, marker);
    assertBlocked("unsafe");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("blocks a binding read when a valid transaction marker appears after the TOCTOU reread", () => {
  const root = rootFor("v2-binding-transaction-race-");
  try {
    const canonical = canonicalRoot(root);
    const filesystemAuthority = createTestDescriptorRelativeFsAuthority();
    const document = documentFor(canonical, filesystemAuthority);
    const created = writeBindingAfterConfirmation({
      root: canonical,
      document,
      confirm_root: true,
      expected: absentPrecondition(canonical, document),
    }, filesystemAuthority);
    assert.equal(created.ok, true);
    if (!created.ok) return;

    const markerPath = transactionJournalPath(canonical);
    setTransactionReadHookForTests((hookRoot) => {
      assert.equal(hookRoot, canonical);
      writeFileSync(markerPath, `${canonicalPolicyJson(validTransactionJournal(canonical))}\n`);
    });

    const raced = readBindingSnapshot(canonical, filesystemAuthority);
    assertFailure(raced, "TRANSACTION_INCOMPLETE");
    assert.equal("value" in raced, false);
    if (!raced.ok) {
      const diagnostic = raced.diagnostics.find(({ code }) => code === "TRANSACTION_INCOMPLETE");
      assert.ok(diagnostic);
      if (!diagnostic) return;
      assert.equal(diagnostic.evidence.path, markerPath);
      assert.equal(diagnostic.evidence.status, "incomplete");
    }
  } finally {
    setTransactionReadHookForTests(undefined);
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects malformed duplicate sidecars and symlinked targets without following them", () => {
  const root = rootFor("v2-binding-safety-");
  const outside = mkdtempSync(join(tmpdir(), "v2-binding-outside-"));
  try {
    const canonical = canonicalRoot(root);
    const filesystemAuthority = createTestDescriptorRelativeFsAuthority();
    const document = documentFor(canonical, filesystemAuthority);
    const path = bindingFilePath(canonical);
    const created = writeBindingAfterConfirmation({
      root: canonical,
      document,
      confirm_root: true,
      expected: absentPrecondition(canonical, document),
    }, filesystemAuthority);
    assert.equal(created.ok, true);

    writeFileSync(path, '{"binding_version":1,"binding_version":1}');
    assertFailure(readBindingSnapshot(canonical, filesystemAuthority), "CONFIG_MALFORMED");

    rmSync(path, { force: true });
    symlinkSync(join(outside, "escaped.json"), path);
    assertFailure(readBindingSnapshot(canonical, filesystemAuthority), "UNSAFE_PATH");
    assert.equal(existsSync(join(outside, "escaped.json")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("requires explicit rebind for a sidecar discovered after a fresh lifecycle", () => {
  const sourceRoot = rootFor("v2-binding-source-");
  const freshRoot = rootFor("v2-binding-fresh-");
  const filesystemAuthority = createTestDescriptorRelativeFsAuthority();
  try {
    const source = canonicalRoot(sourceRoot);
    const sourceDocument = documentFor(source, filesystemAuthority);
    const sourceWrite = writeBindingAfterConfirmation({
      root: source,
      document: sourceDocument,
      confirm_root: true,
      expected: absentPrecondition(source, sourceDocument),
    }, filesystemAuthority);
    assert.equal(sourceWrite.ok, true);
    if (!sourceWrite.ok) return;

    // The sidecar is syntactically valid but its process-local nonce cannot be
    // authenticated by the fresh root lifecycle.
    const fresh = canonicalRoot(freshRoot);
    writeFileSync(bindingFilePath(fresh), readFileSync(bindingFilePath(source)));
    const result = readBindingSnapshot(fresh, filesystemAuthority);
    assertFailure(result, "BINDING_REQUIRED");
  } finally {
    rmSync(sourceRoot, { recursive: true, force: true });
    rmSync(freshRoot, { recursive: true, force: true });
  }
});

test("uses exact project preconditions and never replaces an existing sidecar blindly", () => {
  const root = rootFor("v2-binding-toctou-");
  try {
    const canonical = canonicalRoot(root);
    const filesystemAuthority = createTestDescriptorRelativeFsAuthority();
    const original = documentFor(canonical, filesystemAuthority);
    const first = writeBindingAfterConfirmation({
      root: canonical,
      document: original,
      confirm_root: true,
      expected: absentPrecondition(canonical, original),
    }, filesystemAuthority);
    assert.equal(first.ok, true);
    if (!first.ok) return;
    const before = readBindingSnapshot(canonical, filesystemAuthority);
    assert.equal(before.ok, true);
    if (!before.ok) return;

    const replacement = documentFor(canonical, filesystemAuthority, { config_byte_sha256: `sha256:${"9".repeat(64)}` as WorkflowV2Digest });
    const noExpected = writeBindingAfterConfirmation({ root: canonical, document: replacement, confirm_root: true }, filesystemAuthority);
    assertFailure(noExpected, "IDENTITY_MISMATCH");
    const unchanged = readBindingSnapshot(canonical, filesystemAuthority);
    assert.equal(unchanged.ok, true);
    if (!unchanged.ok) return;
    assert.deepEqual(unchanged.value.document, before.value.document);

    const staleExpected = presentPrecondition(before.value);
    assert.notEqual(staleExpected.raw_hash, replacement.last_validated.config_byte_sha256);
    // A present expected precondition authorizes the document being published;
    // `current` independently authenticates the sidecar observed before CAS.
    const staleProposal = writeBindingAfterConfirmation({
      root: canonical,
      document: replacement,
      confirm_root: true,
      expected: staleExpected,
      current: before.value,
    }, filesystemAuthority);
    assertFailure(staleProposal, "IDENTITY_MISMATCH");
    if (!staleProposal.ok) {
      const staleDiagnostic = staleProposal.diagnostics.find(({ code }) => code === "IDENTITY_MISMATCH");
      assert.ok(staleDiagnostic);
      if (!staleDiagnostic) return;
      assert.equal(staleDiagnostic.evidence.field, "identity");
    }
    const unchangedAfterStale = readBindingSnapshot(canonical, filesystemAuthority);
    assert.equal(unchangedAfterStale.ok, true);
    if (!unchangedAfterStale.ok) return;
    assert.deepEqual(unchangedAfterStale.value.document, before.value.document);

    const replacementWitness = Object.freeze({
      root: before.value.root,
      path: before.value.path,
      document: replacement,
      byte_sha256: before.value.byte_sha256,
      evidence: before.value.evidence,
    });
    const freshExpected = presentPrecondition(replacementWitness);
    const replaced = writeBindingAfterConfirmation({
      root: canonical,
      document: replacement,
      confirm_root: true,
      expected: freshExpected,
      current: before.value,
    }, filesystemAuthority);
    assert.equal(replaced.ok, true);
    if (!replaced.ok) return;
    assert.notEqual(replaced.value.byte_sha256, before.value.byte_sha256);
    const wrongExpected = { ...presentPrecondition(replaced.value), raw_hash: configByteDigest } as PolicyPrecondition;
    assertFailure(writeBindingAfterConfirmation({
      root: canonical,
      document: original,
      confirm_root: true,
      expected: wrongExpected,
    }, filesystemAuthority), "IDENTITY_MISMATCH");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
