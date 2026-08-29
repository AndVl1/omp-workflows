/**
 * Provider-neutral workflow-v2 management contracts.
 *
 * <!-- omp-cto-slice run=01a03ee4-7dd6-7580-8ad7-16d26dc886ba slice=workflow-v2-core -->
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildProjectWorktreeInstanceId,
  createCanonicalRoot,
  createProviderCatalog,
  computeDescriptorFingerprint,
  getProviderRegistry,
  manageProvider,
  parseProviderManagementArgs,
  publishProvider,
  readBindingSnapshot,
  readPolicySnapshot,
  readRootEvidence,
} from "../src/workflow-v2/index.js";
import {
  createDescriptorRelativeFsAuthority,
  createTestDescriptorRelativeFsAuthority,
} from "../src/workflow-v2/fs-authority.js";
import type {
  DescriptorRelativeNativeBackend,
  TrustedFsAuthority,
} from "../src/workflow-v2/fs-authority.js";
import { canonicalPolicyJson } from "../src/workflow-v2/policy.js";
import { transactionJournalPath } from "../src/workflow-v2/transaction.js";
import type {
  ManagementContext,
  ManagementProposal,
  PolicyDocument,
  ProviderDescriptor,
  ProviderId,
  ProviderManagementRequest,
  ProviderRegistration,
  ProviderRuntime,
  Profile,

  WorkflowV2Digest,
} from "../src/workflow-v2/types.js";

const profile: Profile = {
  name: "standard",
  title: "Standard",
  description: "Management test profile",
  match: { type: ["FEATURE"] },
  stages: [{ id: "implementation", title: "Implementation", type: "none" }],
};


let providerSequence = 0;

function digest(hex: string): WorkflowV2Digest {
  return `sha256:${hex.repeat(64 / hex.length)}` as WorkflowV2Digest;
}

function providerId(label: string): ProviderId {
  providerSequence += 1;
  return `@management/${label}-${providerSequence}` as ProviderId;
}
function runtime(_id: ProviderId): ProviderRuntime {
  return {
    async dispatch(input) {
      const base = {
        project_identity: input.project_identity,
        runtime_key: input.runtime_key,
        status: "succeeded" as const,
        evidence: "ok",
      };
      return input.identity_level === "run"
        ? { ...base, identity_level: "run" as const, run_identity: input.run_identity }
        : { ...base, identity_level: "project" as const };
    },
    shutdown() {},
  };
}

function publish(label: string, capabilities: readonly string[] = ["workflow_execution", "profile_catalog"]): ProviderId {
  const id = providerId(label);
  const catalog = createProviderCatalog([profile]);
  const descriptor: ProviderDescriptor = {
    id,
    protocol_version: 2,
    capabilities,
    catalog_content_digest: catalog.content_digest,
    agent_sources: [{ provider_id: id, source_fingerprint: digest("a"), registered_names: ["analyst", "task"] }],
    executable_provenance: { build_fingerprint: digest("b"), runtime_fingerprint: digest("c") },
    defaults: {},
  };
  const registration: ProviderRegistration = {
    descriptor,
    descriptor_fingerprint: computeDescriptorFingerprint(descriptor),
    catalog,
    createRuntime: () => runtime(id),
  };
  const result = publishProvider(getProviderRegistry(), registration);
  assert.equal(result.ok, true);
  return id;
}

function project(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  mkdirSync(join(root, ".git"));
  return root;
}

function managementContext(root: string, filesystemAuthority: TrustedFsAuthority): ManagementContext {
  const evidence = readRootEvidence(root, filesystemAuthority);
  assert.equal(evidence.ok, true);
  if (!evidence.ok) throw new Error("test root evidence unavailable");
  return Object.freeze({
    root: evidence.value,
    worktree_id: buildProjectWorktreeInstanceId(evidence.value),
    session: Object.freeze({ session_id: "test-session", lifecycle_id: "test-lifecycle" }),
    filesystem_authority: filesystemAuthority,
  });
}

function cleanup(root: string): void {
  rmSync(root, { recursive: true, force: true });
}

async function dryCreate(root: string, id: ProviderId, filesystemAuthority: TrustedFsAuthority): Promise<ManagementProposal> {
  const result = await manageProvider(
    managementContext(root, filesystemAuthority),
    {
      operation: "create",
      provider_id: id,
      confirm_root: true,
      dry_run: true,
    },
    getProviderRegistry(),
  );
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("unreachable");
  assert.equal(result.value.applied, false);
  assert.ok(result.value.proposal);
  return result.value.proposal;
}

async function apply(root: string, proposal: ManagementProposal, filesystemAuthority: TrustedFsAuthority, dryRun = false) {
  const request = {
    operation: "apply" as const,
    proposal,
    proposal_digest: proposal.proposal_digest,
    confirm_root: true as const,
    expected: proposal.expected,
    ...(dryRun ? { dry_run: true as const } : {}),
  } as ProviderManagementRequest;
  return manageProvider(managementContext(root, filesystemAuthority), request, getProviderRegistry());
}
async function manage(root: string, request: ProviderManagementRequest, filesystemAuthority: TrustedFsAuthority) {
  return manageProvider(managementContext(root, filesystemAuthority), request, getProviderRegistry());
}

function authorityWithParentIdentityRace(): TrustedFsAuthority {
  const base = createTestDescriptorRelativeFsAuthority();
  let changedCreateOpen = false;
  const native: DescriptorRelativeNativeBackend = {
    platform: base.platform,
    supportsAtomicCas: base.supportsAtomicCas,
    openRoot: (root, options) => {
      const opened = base.openRoot(root, options);
      if (!opened.ok) return opened;
      if (options?.createOmp !== true || changedCreateOpen) return opened;
      changedCreateOpen = true;
      return {
        ok: true,
        value: Object.freeze({
          ...opened.value,
          ompInode: `${opened.value.ompInode}:changed`,
        }),
      };
    },
    openRootDirectory: base.openRootDirectory,
    readBounded: base.readBounded,
    inspect: base.inspect,
    openDirectory: base.openDirectory,
    createTemporary: base.createTemporary,
    removeTemporary: base.removeTemporary,
    fsyncDirectory: base.fsyncDirectory,
    atomicReplaceIfCurrent: base.atomicReplaceIfCurrent,
    atomicRemoveIfCurrent: base.atomicRemoveIfCurrent,
  };
  return createDescriptorRelativeFsAuthority({ native });
}

test("management list/status remain read-only with absent and malformed policy", async () => {
  const id = publish("listing");
  const root = project("workflow-v2-management-list-");
  const filesystemAuthority = createTestDescriptorRelativeFsAuthority();
  try {
    const absent = await manage(root, { operation: "list" }, filesystemAuthority);
    assert.equal(absent.ok, true);
    if (!absent.ok) return;
    assert.deepEqual(absent.value.provider_ids, [id]);
    assert.equal(absent.value.policy_provider_id, null);
    assert.ok(absent.value.diagnostics.some((entry) => entry.code === "CONFIG_MISSING"));
    assert.equal(existsSync(join(root, ".omp", "team.config.json")), false);

    mkdirSync(join(root, ".omp"), { recursive: true });
    writeFileSync(join(root, ".omp", "team.config.json"), "{broken\n");
    const legacy = join(root, ".claude");
    mkdirSync(legacy);
    writeFileSync(join(legacy, "team.config.json"), JSON.stringify({ roles: { analyst: "analyst" } }));
    const status = await manage(root, { operation: "status" }, filesystemAuthority);
    assert.equal(status.ok, true);
    if (!status.ok) return;
    assert.ok(status.value.diagnostics.some((entry) => entry.code === "CONFIG_MALFORMED"));
    assert.equal(status.value.policy_provider_id, null);
    assert.equal(readFileSync(join(root, ".omp", "team.config.json"), "utf8"), "{broken\n");
  } finally {
    cleanup(root);
  }
});

test("management create is explicit, absent-only, and binds atomically", async () => {
  const id = publish("create");
  const root = project("workflow-v2-management-create-");
  const filesystemAuthority = createTestDescriptorRelativeFsAuthority();
  try {
    const proposal = await dryCreate(root, id, filesystemAuthority);
    assert.equal(existsSync(join(root, ".omp", "team.config.json")), false);
    assert.equal(existsSync(join(root, ".omp", "team.config.binding.json")), false);
    assert.equal(existsSync(join(root, ".omp")), false);

    const applied = await apply(root, proposal, filesystemAuthority);
    assert.equal(applied.ok, true);
    if (!applied.ok) return;
    assert.equal(applied.value.applied, true);
    assert.equal(existsSync(join(root, ".workflow-v2.transaction.lock")), false);
    assert.equal(existsSync(join(root, ".omp", "team.config.json")), true);
    assert.equal(existsSync(join(root, ".omp", "team.config.binding.json")), true);

    const canonical = createCanonicalRoot(root);
    assert.ok(canonical);
    if (!canonical) return;
    const journalPath = transactionJournalPath(canonical);
    assert.equal(existsSync(journalPath), false);
    writeFileSync(journalPath, `${canonicalPolicyJson({
      version: 1,
      canonical_root: canonical,
      policy_path: join(canonical, ".omp", "team.config.json"),
      binding_path: join(canonical, ".omp", "team.config.binding.json"),
      old_policy_base64: null,
      old_binding_base64: null,
    })}\n`);
    const blockedPolicy = readPolicySnapshot(canonical, filesystemAuthority);
    assert.equal(blockedPolicy.ok, false);
    if (!blockedPolicy.ok) assert.equal(blockedPolicy.diagnostics[0]?.code, "TRANSACTION_INCOMPLETE");
    const blockedBinding = readBindingSnapshot(canonical, filesystemAuthority);
    assert.equal(blockedBinding.ok, false);
    if (!blockedBinding.ok) assert.equal(blockedBinding.diagnostics[0]?.code, "TRANSACTION_INCOMPLETE");
    rmSync(journalPath, { force: true });

    const second = await manage(root, { operation: "create", provider_id: id, confirm_root: true, dry_run: true }, filesystemAuthority);
    assert.equal(second.ok, false);
    if (!second.ok) assert.equal(second.diagnostics[0]?.code, "TRANSITION_REQUIRED");
  } finally {
    cleanup(root);
  }
});

test("proposal-only management operations leave an absent root untouched", async () => {
  const id = publish("proposal-only");
  const refreshRoot = project("workflow-v2-management-proposal-refresh-");
  const selectRoot = project("workflow-v2-management-proposal-select-");
  const migrateRoot = project("workflow-v2-management-proposal-migrate-");
  const createRoot = project("workflow-v2-management-proposal-create-");

  const assertProposalOnly = (root: string): void => {
    assert.equal(existsSync(join(root, ".omp")), false);
    assert.equal(existsSync(join(root, ".workflow-v2.transaction.lock")), false);
    const canonical = createCanonicalRoot(root);
    assert.ok(canonical);
    if (!canonical) return;
    assert.equal(existsSync(transactionJournalPath(canonical)), false);
  };

  try {
    const refresh = await manage(
      refreshRoot,
      { operation: "refresh", provider_id: id, dry_run: true },
      createTestDescriptorRelativeFsAuthority(),
    );
    assert.equal(refresh.ok, false);
    if (!refresh.ok) {
      assert.ok(refresh.diagnostics.some((entry) => entry.code === "CONFIG_MISSING"));
    }
    assertProposalOnly(refreshRoot);

    const selection = await manage(
      selectRoot,
      { operation: "select", provider_id: id, dry_run: true },
      createTestDescriptorRelativeFsAuthority(),
    );
    assert.equal(selection.ok, true);
    if (selection.ok) {
      assert.equal(selection.value.applied, false);
      assert.ok(selection.value.proposal);
    }
    assertProposalOnly(selectRoot);

    const legacyPath = join(migrateRoot, ".claude", "team.config.json");
    mkdirSync(join(migrateRoot, ".claude"));
    writeFileSync(legacyPath, JSON.stringify({ roles: { analyst: "analyst" } }));
    const migration = await manage(
      migrateRoot,
      { operation: "migrate", provider_id: id, dry_run: true },
      createTestDescriptorRelativeFsAuthority(),
    );
    assert.equal(migration.ok, true);
    if (migration.ok) {
      assert.equal(migration.value.applied, false);
      assert.ok(migration.value.proposal);
    }
    assertProposalOnly(migrateRoot);

    const creation = await manage(
      createRoot,
      { operation: "create", provider_id: id, confirm_root: true, dry_run: true },
      createTestDescriptorRelativeFsAuthority(),
    );
    assert.equal(creation.ok, true);
    if (creation.ok) {
      assert.equal(creation.value.applied, false);
      assert.ok(creation.value.proposal);
    }
    assertProposalOnly(createRoot);
  } finally {
    cleanup(refreshRoot);
    cleanup(selectRoot);
    cleanup(migrateRoot);
    cleanup(createRoot);
  }
});

test("direct create applies from an absent root through the transaction boundary", async () => {
  const id = publish("direct-create");
  const root = project("workflow-v2-management-direct-create-");
  const filesystemAuthority = createTestDescriptorRelativeFsAuthority();
  try {
    assert.equal(existsSync(join(root, ".omp")), false);
    const created = await manage(root, { operation: "create", provider_id: id, confirm_root: true }, filesystemAuthority);
    assert.equal(created.ok, true);
    if (!created.ok) return;
    assert.equal(created.value.applied, true);
    assert.equal(existsSync(join(root, ".omp", "team.config.json")), true);
    assert.equal(existsSync(join(root, ".omp", "team.config.binding.json")), true);
    assert.equal(existsSync(join(root, ".workflow-v2.transaction.lock")), false);
    const canonical = createCanonicalRoot(root);
    assert.ok(canonical);
    if (!canonical) return;
    assert.equal(existsSync(transactionJournalPath(canonical)), false);
  } finally {
    cleanup(root);
  }
});

test("direct create fails closed when the trusted .omp parent identity changes", async () => {
  const id = publish("direct-create-parent-race");
  const root = project("workflow-v2-management-direct-create-race-");
  mkdirSync(join(root, ".omp"));
  const filesystemAuthority = authorityWithParentIdentityRace();
  try {
    const result = await manage(root, { operation: "create", provider_id: id, confirm_root: true }, filesystemAuthority);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.diagnostics[0]?.code, "IDENTITY_MISMATCH");
      assert.equal(result.diagnostics[0]?.operation, "management.apply");
    }
    assert.equal(existsSync(join(root, ".omp", "team.config.json")), false);
    assert.equal(existsSync(join(root, ".omp", "team.config.binding.json")), false);
    assert.equal(existsSync(join(root, ".workflow-v2.transaction.lock")), false);
    const canonical = createCanonicalRoot(root);
    assert.ok(canonical);
    if (!canonical) return;
    assert.equal(existsSync(transactionJournalPath(canonical)), false);
  } finally {
    cleanup(root);
  }
});

test("refresh and select produce proposals without switching or writing", async () => {
  const first = publish("refresh");
  const second = publish("switch");
  const root = project("workflow-v2-management-refresh-");
  const filesystemAuthority = createTestDescriptorRelativeFsAuthority();
  try {
    const createProposal = await dryCreate(root, first, filesystemAuthority);
    const created = await apply(root, createProposal, filesystemAuthority);
    assert.equal(created.ok, true);
    const policyPath = join(root, ".omp", "team.config.json");
    const before = readFileSync(policyPath, "utf8");

    const refresh = await manage(root, { operation: "refresh", provider_id: first }, filesystemAuthority);
    if (!refresh.ok) return;
    assert.equal(refresh.value.applied, false);
    assert.ok(refresh.value.proposal);
    assert.equal(readFileSync(policyPath, "utf8"), before);

    const selection = await manage(root, { operation: "select", provider_id: second, dry_run: true }, filesystemAuthority);
    if (!selection.ok) return;
    assert.ok(selection.value.proposal);
    const switched = await apply(root, selection.value.proposal, filesystemAuthority);
    assert.equal(switched.ok, false);
    if (!switched.ok) assert.equal(switched.diagnostics[0]?.code, "TRANSITION_REQUIRED");
    assert.equal(readFileSync(policyPath, "utf8"), before);
  } finally {
    cleanup(root);
  }
});

test("migration retains v1 values, preserves the source, and requires dry-run", async () => {
  const id = publish("migration");
  const root = project("workflow-v2-management-migrate-");
  const filesystemAuthority = createTestDescriptorRelativeFsAuthority();
  const legacyPath = join(root, ".claude", "team.config.json");
  try {
    mkdirSync(join(root, ".claude"));
    const legacy = {
      roles: { analyst: "analyst" },
      scope_map: [{ glob: ["**/*.ts"], scope: "frontend", dev_agent: "task" }],
      flags: { "**/*.ts": true },
      runtime_classes: { frontend: "node" },
      ui_classes: { frontend: false },
      design_system: "minimal",
    };
    const legacyBytes = `${JSON.stringify(legacy)}\n`;
    writeFileSync(legacyPath, legacyBytes);
    const blocked = await manage(root, { operation: "migrate", provider_id: id, dry_run: false } as unknown as ProviderManagementRequest, filesystemAuthority);
    if (!blocked.ok) assert.equal(blocked.diagnostics[0]?.code, "MIGRATION_REQUIRED");

    const proposalResult = await manage(root, { operation: "migrate", provider_id: id, dry_run: true }, filesystemAuthority);
    if (!proposalResult.ok) return;
    const proposal = proposalResult.value.proposal;
    assert.ok(proposal);
    assert.equal(proposal.next_policy.policy.roles.analyst?.registered_name, "analyst");
    const scope = proposal.next_policy.policy.scope_map[0];
    assert.ok(scope && scope.op === "add");
    if (scope && scope.op === "add") assert.equal(scope.rule.dev_agent.registered_name, "task");
    assert.equal(readFileSync(legacyPath, "utf8"), legacyBytes);

    const applied = await apply(root, proposal, filesystemAuthority);
    assert.equal(applied.ok, true);
    assert.equal(readFileSync(legacyPath, "utf8"), legacyBytes);
    assert.equal(existsSync(join(root, ".omp", "team.config.json")), true);
    assert.equal(existsSync(join(root, ".omp", "team.config.binding.json")), true);
  } finally {
    cleanup(root);
  }
});

test("apply rejects dry-run requests and stale proposal identities without writes", async () => {
  const id = publish("stale");
  const root = project("workflow-v2-management-stale-");
  const filesystemAuthority = createTestDescriptorRelativeFsAuthority();
  try {
    const proposal = await dryCreate(root, id, filesystemAuthority);
    const dryApplied = await apply(root, proposal, filesystemAuthority, true);
    assert.equal(dryApplied.ok, false);
    if (!dryApplied.ok) assert.equal(dryApplied.diagnostics[0]?.code, "CONFIG_MALFORMED");
    assert.equal(existsSync(join(root, ".omp", "team.config.json")), false);

    mkdirSync(join(root, ".omp"), { recursive: true });
    const changed: PolicyDocument = {
      ...proposal.next_policy,
      policy: { ...proposal.next_policy.policy, design_system: "changed" },
    };
    writeFileSync(join(root, ".omp", "team.config.json"), `${canonicalPolicyJson(changed)}\n`);
    const stale = await apply(root, proposal, filesystemAuthority);
    assert.equal(stale.ok, false);
    if (!stale.ok) assert.ok(["TRANSITION_REQUIRED", "IDENTITY_MISMATCH"].includes(stale.diagnostics[0]?.code ?? ""));
    assert.equal(JSON.parse(readFileSync(join(root, ".omp", "team.config.json"), "utf8")).policy.design_system, "changed");
  } finally {
    cleanup(root);
  }
});

test("management argument parsing rejects destructive flags and preserves explicit preconditions", () => {
  const id = "@management/parser";
  const parsed = parseProviderManagementArgs(`create --provider=${id} --confirm-root --dry-run`, "init-team");
  assert.equal(parsed.operation, "create");
  assert.equal("root" in parsed, false);
  assert.equal(parsed.provider_id, id);
  assert.throws(() => parseProviderManagementArgs("create --provider=@management/parser --confirm-root --force", "init-team"), /forbidden/);
  assert.throws(() => parseProviderManagementArgs("refresh --overwrite", "init-team"), /forbidden/);
  assert.throws(() => parseProviderManagementArgs("migrate --provider=@management/parser", "init-team"), /dry-run/);
  assert.throws(() => parseProviderManagementArgs("create --root=/tmp/project --provider=@management/parser --confirm-root", "init-team"), /unknown/);

  const expected = {
    state: "absent" as const,
    canonical_root: "/tmp/project",
    worktree_id: digest("d"),
    session_id: "session",
    policy_path: "/tmp/project/.omp/team.config.json",
    parent_path_identity: digest("e"),
    expected_exclusive_create: true as const,
  };
  const proposal = {
    operation: "create",
    proposal_digest: digest("1"),
    provider: { id, protocol_version: 2, descriptor_fingerprint: digest("e"), catalog_content_digest: digest("f") },
    next_policy: {
      schema_version: 2,
      provider: {
        id,
        protocol_version: 2,
        descriptor_fingerprint: digest("e"),
        catalog_content_digest: digest("f"),
      },
      policy: {
        roles: {},
        scope_map: [],
        roster_overrides: [],
        flags: {},
        runtime_classes: {},
        ui_classes: {},
        design_system: null,
        commands: {
          "do-work": { fragments: [] },
          team: { alias_of: "do-work" },
          cto: { fragments: [] },
        },
        workflow: { selection: "matrix" },
        prompt_context: {},
        required_capabilities: [],
      },
    },
    field_operations: [],
    expected,
  };
  const applyRequest = parseProviderManagementArgs(
    `apply --proposal=${JSON.stringify(proposal)} --proposal-digest=${proposal.proposal_digest} --confirm-root`,
    "init-team",
  );
  assert.equal(applyRequest.operation, "apply");
  assert.equal(Object.getPrototypeOf(applyRequest.expected), null);
  assert.deepStrictEqual({ ...applyRequest.expected }, expected);

  const serializedProposal = JSON.stringify(proposal);
  const assertMalformedProposal = (proposalJson: string): void => {
    assert.throws(
      () => parseProviderManagementArgs(
        `apply --proposal=${proposalJson} --proposal-digest=${proposal.proposal_digest} --confirm-root`,
        "init-team",
      ),
      (error: unknown) => error instanceof TypeError && error.message === "--proposal must contain valid JSON",
    );
  };

  const duplicateKeyProposal = serializedProposal.replace(
    '"operation":"create"',
    '"operation":"create","operation":"create"',
  );
  assertMalformedProposal(duplicateKeyProposal);

  const oversizedProposal = `${serializedProposal.slice(0, -1)}${" ".repeat(262_144)}}`;
  assertMalformedProposal(oversizedProposal);

  const deeplyNestedValue = `${"[".repeat(17)}0${"]".repeat(17)}`;
  const deeplyNestedProposal = `${serializedProposal.slice(0, -1)},"nested":${deeplyNestedValue}}`;
  assertMalformedProposal(deeplyNestedProposal);
});
