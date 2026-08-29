/* <!-- omp-cto-slice run=01a03ee4-7dd6-7580-8ad7-16d26dc886ba slice=workflow-v2-core --> */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCanonicalRoot } from "../src/workflow-v2/identity.js";
import { createTestDescriptorRelativeFsAuthority } from "../src/workflow-v2/fs-authority.js";
import { setTransactionReadHookForTests, transactionJournalPath, type TransactionJournal } from "../src/workflow-v2/transaction.js";
import {
  canonicalPolicyJson,
  computePolicyByteHash,
  computePolicySemanticHash,
  mergePolicy,
  parsePolicyDocument,
  readPolicySnapshot,
  writePolicyDocument,
} from "../src/workflow-v2/policy.js";
import type {
  CanonicalRoot,
  AgentRef,
  CommandPolicy,
  DescriptorDefaults,
  PolicyDocument,
  PolicyPrecondition,
  PathIdentity,
  PolicySnapshot,
  PolicyProviderRef,
  ProviderDescriptor,
  ProviderId,
  RosterOverride,
  ScopeRule,
  WorkflowPolicy,
  WorkflowV2Digest,
} from "../src/workflow-v2/types.js";

const providerId = "@example/workflow-provider" as ProviderId;
const sourceFingerprint = `sha256:${"a".repeat(64)}` as WorkflowV2Digest;
const descriptorFingerprint = `sha256:${"b".repeat(64)}` as WorkflowV2Digest;
const catalogDigest = `sha256:${"c".repeat(64)}` as WorkflowV2Digest;
const rootDigest = `sha256:${"d".repeat(64)}` as WorkflowV2Digest;

function agent(registeredName: string, source = sourceFingerprint): AgentRef {
  return Object.freeze({ registered_name: registeredName, provider_id: providerId, source_fingerprint: source });
}

function commandPolicy(fragmentIds: readonly string[] = []): CommandPolicy {
  const fragments = Object.freeze(fragmentIds.map((id) => Object.freeze({
    id,
    text: `${id} fragment`,
    owner: Object.freeze({ kind: "project_policy" as const, source: ".omp/team.config.json" as const }),
  })));
  return Object.freeze({
    "do-work": Object.freeze({ fragments }),
    team: Object.freeze({ alias_of: "do-work" as const }),
    cto: Object.freeze({ fragments: Object.freeze([]) }),
  });
}

function scopeRule(scope: string, devAgent = agent(`${scope}-agent`)): ScopeRule {
  return Object.freeze({ patterns: Object.freeze([`**/${scope}/**`]), scope, dev_agent: devAgent });
}

function policyDocument(
  policyOverrides: Partial<WorkflowPolicy> = {},
  providerOverrides: Partial<PolicyProviderRef> = {},
): PolicyDocument {
  const policy: WorkflowPolicy = Object.freeze({
    roles: Object.freeze({}),
    scope_map: Object.freeze([]),
    roster_overrides: Object.freeze([]),
    flags: Object.freeze({}),
    runtime_classes: Object.freeze({}),
    ui_classes: Object.freeze({}),
    design_system: null,
    commands: commandPolicy(),
    workflow: Object.freeze({ selection: "matrix" }),
    prompt_context: Object.freeze({}),
    required_capabilities: Object.freeze([]),
    ...policyOverrides,
  });
  return Object.freeze({
    schema_version: 2,
    provider: Object.freeze({
      id: providerId,
      protocol_version: 2,
      descriptor_fingerprint: descriptorFingerprint,
      catalog_content_digest: catalogDigest,
      ...providerOverrides,
    }),
    policy,
  });
}

function descriptor(defaults: DescriptorDefaults = {}): ProviderDescriptor {
  return Object.freeze({
    id: providerId,
    protocol_version: 2,
    capabilities: Object.freeze(["workflow_execution"]),
    catalog_content_digest: catalogDigest,
    agent_sources: Object.freeze([Object.freeze({
      provider_id: providerId,
      source_fingerprint: sourceFingerprint,
      registered_names: Object.freeze(["analyst", "backend-agent", "frontend-agent"]),
    })]),
    executable_provenance: Object.freeze({
      build_fingerprint: `sha256:${"e".repeat(64)}` as WorkflowV2Digest,
      runtime_fingerprint: `sha256:${"f".repeat(64)}` as WorkflowV2Digest,
    }),
    defaults: Object.freeze(defaults),
  });
}

function rootFor(prefix: string, withOmp = true): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  if (withOmp) mkdirSync(join(root, ".omp"), { recursive: true });
  return root;
}

function canonicalRoot(root: string): CanonicalRoot {
  const value = createCanonicalRoot(root);
  assert.ok(value, "test roots are canonical absolute roots");
  return value;
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

function assertFailure(result: { readonly ok: boolean; readonly diagnostics: readonly { readonly code: string }[] }, code: string): void {
  assert.equal(result.ok, false);
  if (!result.ok) assert.ok(result.diagnostics.some((diagnostic) => diagnostic.code === code), `expected diagnostic ${code}`);
}

function expectedFor(snapshot: PolicySnapshot): PolicyPrecondition {
  const stat = lstatSync(join(snapshot.root, ".omp", "team.config.json"));
  const policyFileIdentity = `${String(stat.dev)}:${String(stat.ino)}:${stat.size}:${stat.mtimeMs}` as PathIdentity;
  return Object.freeze({
    state: "present" as const,
    project_identity: Object.freeze({
      root_instance_id: rootDigest,
      provider_id: snapshot.document.provider.id,
      descriptor_fingerprint: snapshot.document.provider.descriptor_fingerprint,
      executable_provenance: Object.freeze({
        build_fingerprint: `sha256:${"e".repeat(64)}` as WorkflowV2Digest,
        runtime_fingerprint: `sha256:${"f".repeat(64)}` as WorkflowV2Digest,
      }),
      catalog_content_digest: snapshot.document.provider.catalog_content_digest,
      config_byte_sha256: snapshot.byte_sha256,
      config_semantic_sha256: snapshot.semantic_sha256,
      session: Object.freeze({ session_id: "test-session", lifecycle_id: "test-lifecycle" }),
    }),
    policy_path: join(snapshot.root, ".omp", "team.config.json"),
    policy_file_identity: policyFileIdentity,
    raw_hash: snapshot.byte_sha256,
    semantic_hash: snapshot.semantic_sha256,
  });
}

test("parses a closed strict v2 policy and freezes the snapshot document", () => {
  const result = parsePolicyDocument(JSON.stringify(policyDocument()));
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.schema_version, 2);
  assert.equal(result.value.provider.id, providerId);
  assert.ok(Object.isFrozen(result.value));
  assert.ok(Object.isFrozen(result.value.policy));
  assert.ok(Object.isFrozen(result.value.policy.commands.team));
});

test("rejects unsupported, duplicate, BOM, invalid UTF-8, controls, and unknown schema data", () => {
  const valid = policyDocument();
  const unsupported = parsePolicyDocument(JSON.stringify({ ...valid, schema_version: 3 }));
  assertFailure(unsupported, "UNSUPPORTED_SCHEMA");

  const unknown = parsePolicyDocument(JSON.stringify({ ...valid, unknown: true }));
  assertFailure(unknown, "CONFIG_MALFORMED");

  const duplicate = parsePolicyDocument('{"schema_version":2,"schema_version":2}');
  assertFailure(duplicate, "CONFIG_MALFORMED");

  const bom = parsePolicyDocument(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("{}")])) ;
  assertFailure(bom, "CONFIG_MALFORMED");

  const invalidUtf8 = parsePolicyDocument(Buffer.from([0xc3, 0x28]));
  assertFailure(invalidUtf8, "CONFIG_MALFORMED");

  const unescapedControl = parsePolicyDocument('{"schema_version":2,"text":"line\nfeed"}');
  assertFailure(unescapedControl, "CONFIG_MALFORMED");

  const unknownNested = parsePolicyDocument(JSON.stringify({
    ...valid,
    policy: { ...valid.policy, commands: { ...valid.policy.commands, team: { alias_of: "do-work", extra: true } } },
  }));
  assertFailure(unknownNested, "CONFIG_MALFORMED");
});

test("reads only .omp policy and never falls through to a legacy .claude document", () => {
  const root = rootFor("v2-policy-authority-");
  const filesystemAuthority = createTestDescriptorRelativeFsAuthority();
  try {
    mkdirSync(join(root, ".claude"), { recursive: true });
    writeFileSync(join(root, ".claude", "team.config.json"), JSON.stringify({ roles: { analyst: "legacy" } }));
    const missing = readPolicySnapshot(canonicalRoot(root), filesystemAuthority);
    assertFailure(missing, "CONFIG_MISSING");

    writeFileSync(join(root, ".omp", "team.config.json"), "{broken");
    const malformed = readPolicySnapshot(canonicalRoot(root), filesystemAuthority);
    assertFailure(malformed, "CONFIG_MALFORMED");
    assert.doesNotMatch(JSON.stringify(malformed), /legacy/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("blocks policy reads while a valid v2, legacy, or malformed transaction journal is present", () => {
  const root = rootFor("v2-policy-transaction-");
  try {
    const canonical = canonicalRoot(root);
    const filesystemAuthority = createTestDescriptorRelativeFsAuthority();
    const markerPath = transactionJournalPath(canonical);
    const legacy = {
      version: 1,
      canonical_root: canonical,
      policy_path: join(root, ".omp", "team.config.json"),
      binding_path: join(root, ".omp", "team.config.binding.json"),
      old_policy_base64: null,
      old_binding_base64: null,
    };
    const cases = [
      { content: `${canonicalPolicyJson(validTransactionJournal(canonical))}\n`, status: "incomplete" },
      { content: `${JSON.stringify(legacy)}\n`, status: "malformed" },
      { content: "{broken", status: "malformed" },
    ] as const;

    for (const entry of cases) {
      writeFileSync(markerPath, entry.content);
      const blocked = readPolicySnapshot(canonical, filesystemAuthority);
      assertFailure(blocked, "TRANSACTION_INCOMPLETE");
      assert.equal("value" in blocked, false);
      if (!blocked.ok) {
        const diagnostic = blocked.diagnostics.find((candidate) => candidate.code === "TRANSACTION_INCOMPLETE");
        assert.ok(diagnostic);
        if (!diagnostic) continue;
        assert.equal(diagnostic.operation, "policy.read");
        assert.equal(diagnostic.evidence.path, markerPath);
        assert.equal(diagnostic.evidence.status, entry.status);
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("blocks a policy read when a valid v2 transaction marker appears after the TOCTOU reread", () => {
  const root = rootFor("v2-policy-transaction-race-");
  try {
    const canonical = canonicalRoot(root);
    const filesystemAuthority = createTestDescriptorRelativeFsAuthority();
    const policyPath = join(root, ".omp", "team.config.json");
    writeFileSync(policyPath, `${canonicalPolicyJson(policyDocument())}\n`);
    const markerPath = transactionJournalPath(canonical);
    setTransactionReadHookForTests((hookRoot) => {
      assert.equal(hookRoot, canonical);
      writeFileSync(markerPath, `${canonicalPolicyJson(validTransactionJournal(canonical))}\n`);
    });

    const raced = readPolicySnapshot(canonical, filesystemAuthority);
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

test("hashes exact bytes separately from deterministic JCS semantic content", () => {
  const document = policyDocument({ prompt_context: Object.freeze({ answer: Object.freeze({ id: "answer", type: "text", value: "yes" }) }) });
  const firstBytes = Buffer.from(`${JSON.stringify(document)}\n`, "utf8");
  const secondBytes = Buffer.from(`  ${JSON.stringify(document, null, 2)}  `, "utf8");
  const first = parsePolicyDocument(firstBytes);
  const second = parsePolicyDocument(secondBytes);
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  if (!first.ok || !second.ok) return;
  assert.notEqual(computePolicyByteHash(firstBytes), computePolicyByteHash(secondBytes));
  assert.equal(computePolicySemanticHash(first.value), computePolicySemanticHash(second.value));
  assert.equal(canonicalPolicyJson({ b: 1e-7, a: -0 }), '{"a":0,"b":1e-7}');
});

test("merges descriptor defaults with tombstones, ordered patches, and append-only fragments", () => {
  const defaults: DescriptorDefaults = {
    roles: Object.freeze({ analyst: agent("default-analyst"), remove_me: agent("remove-me") }),
    scope_map: Object.freeze([scopeRule("backend")]),
    roster_overrides: Object.freeze([{ add: Object.freeze(["default-reviewer"]) } as RosterOverride]),
    flags: Object.freeze({ debug: true, remove_flag: true }),
    runtime_classes: Object.freeze({ backend: "jvm", remove_runtime: "old" }),
    ui_classes: Object.freeze({ backend: "compose" }),
    design_system: "default-design",
    commands: commandPolicy(["default"]),
    required_capabilities: Object.freeze(["workflow_execution"]),
  };
  const nextScope = scopeRule("api", agent("api-agent"));
  const policy = policyDocument({
    roles: Object.freeze({ analyst: agent("policy-analyst"), remove_me: null }),
    scope_map: Object.freeze([
      { op: "add", id: "api", rule: nextScope, before: "backend" },
      { op: "replace", id: "backend", rule: scopeRule("backend-v2", agent("backend-v2-agent")) },
    ]),
    roster_overrides: Object.freeze([
      { op: "remove", id: "index-0" },
      { op: "add", id: "review", value: Object.freeze({ add: Object.freeze(["qa"]) }) },
    ]),
    flags: Object.freeze({ debug: false, remove_flag: null }),
    runtime_classes: Object.freeze({ backend: "native", remove_runtime: null }),
    ui_classes: Object.freeze({ backend: null }),
    commands: commandPolicy(["policy"]),
    required_capabilities: Object.freeze(["cto"]),
  });
  const merged = mergePolicy(descriptor(defaults), policy);
  assert.equal(merged.ok, true);
  if (!merged.ok) return;
  assert.equal(merged.value.roles.analyst.registered_name, "policy-analyst");
  assert.equal("remove_me" in merged.value.roles, false);
  assert.deepEqual(merged.value.scope_map.map((entry) => entry.scope), ["api", "backend-v2"]);
  assert.deepEqual(merged.value.roster_overrides, [{ add: ["qa"] }]);
  assert.deepEqual(merged.value.flags, { debug: false });
  assert.deepEqual(merged.value.runtime_classes, { backend: "native" });
  assert.deepEqual(merged.value.ui_classes, {});
  assert.equal(merged.value.commands.team.alias_of, "do-work");
  assert.deepEqual(merged.value.commands["do-work"].fragments.map((fragment) => fragment.id), ["default", "policy"]);
  assert.deepEqual(merged.value.required_capabilities, ["workflow_execution", "cto"]);
});

test("writes exact canonical policy bytes only through management and rejects stale replacement", () => {
  const root = rootFor("v2-policy-writer-", false);
  try {
    const canonical = canonicalRoot(root);
    const filesystemAuthority = createTestDescriptorRelativeFsAuthority();
    const document = policyDocument();
    const written = writePolicyDocument({ root: canonical, document, confirm_root: true }, filesystemAuthority);
    assert.equal(written.ok, true);
    assert.equal(existsSync(join(root, ".omp", "team.config.json")), true);
    assert.equal(existsSync(join(root, ".omp", "team.config.binding.json")), false);
    assert.equal(readFileSync(join(root, ".omp", "team.config.json"), "utf8"), `${canonicalPolicyJson(document)}\n`);

    const before = readPolicySnapshot(canonical, filesystemAuthority);
    assert.equal(before.ok, true);
    if (!before.ok) return;
    const replacement = policyDocument({ design_system: "new-design" });
    const withoutExpected = writePolicyDocument({ root: canonical, document: replacement, confirm_root: true }, filesystemAuthority);
    assertFailure(withoutExpected, "IDENTITY_MISMATCH");
    assert.equal(readFileSync(join(root, ".omp", "team.config.json"), "utf8"), `${canonicalPolicyJson(document)}\n`);

    const stale = writePolicyDocument({
      root: canonical,
      document: replacement,
      confirm_root: true,
      expected: expectedFor(before.value),
      current: before.value,
    }, filesystemAuthority);
    assert.equal(stale.ok, true);

    const staleProposal = writePolicyDocument({
      root: canonical,
      document,
      confirm_root: true,
      expected: expectedFor(before.value),
      current: before.value,
    }, filesystemAuthority);
    assertFailure(staleProposal, "IDENTITY_MISMATCH");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("fails closed when the trusted descriptor-relative authority is absent", () => {
  const root = rootFor("v2-policy-no-authority-");
  try {
    const canonical = canonicalRoot(root);
    assertFailure(readPolicySnapshot(canonical, undefined), "ACTIVATION_FAILED");
    assertFailure(writePolicyDocument({ root: canonical, document: policyDocument(), confirm_root: true }, undefined), "ACTIVATION_FAILED");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
